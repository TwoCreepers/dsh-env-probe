// dsh-env-probe (v1.2.x, local fork)
// Zero-dependency DeepSeek Harness (dsh) plugin: probe the local machine
// environment once, cache the report on disk, and inject it into every
// session's system prompt so the agent does not have to guess what this
// computer offers (OS, shells, runtimes, tools, disks, proxy).
//
// Local-fork changes (on top of upstream v1.0.1):
//   - /env-refresh now returns ONLY the diff against the previous probe, never
//     the whole report, and blocks while a background probe is in flight
//     instead of answering from an older cache.
//   - /env-suggest is gone (it steered the agent and burned tokens silently).
//   - new `env_refresh` tool for the model: same blocking refresh, same
//     diff-only answer, and it rewrites the cache the injected section reads.
//   - new `env_probe` tool: the cached snapshot as structured data (one entry
//     per runtime/tool with path and version), no probe spawned, so a PTC /
//     `run_code` agent can read a path and call it directly.
//   - the version-probe commands, executable aliases and shell list are now
//     configuration (`versionArgs` / `execAliases` / `shells`) instead of
//     hard-coded tables.
//   - the injected title/intro no longer argue that the report must be
//     trusted; they state that it is a snapshot and may already be out of
//     date, and they name the tool that refreshes it.
//   - extensionless POSIX-style shims found on PATH (npm/pnpm) are resolved
//     to their runnable .cmd sibling so the version probe actually runs.
//   - the diff tells a version bump (`~ name: old -> new`) apart from an
//     executable that moved on PATH (`~ name (path): old -> new`).
//   - v1.2.0: the expired-cache notice is gone; the header always states the
//     probe time instead.
//   - v1.3.0: `cacheTtlHours` defaults back to 24; `injectSection: false`
//     makes this a tool-only plugin that never touches the system prompt;
//     the injected header carries only the absolute probe time (no relative
//     age), so a warm cache keeps the prompt byte-identical across turns and
//     the provider-side prompt cache keeps hitting; env_probe refreshes by
//     itself once the cache is older than the TTL.
//   - v1.4.0: `/env-refresh` no longer ends in the UI plane. `dsh-commands`
//     intentionally never sends a command or its result to the model, so the
//     handler now hands its outcome to the receiving agent as a producer
//     supplied context message (`source.kind = 'env-probe'`,
//     `form: 'notice'`): the Chat renders it as the collapsed "Context
//     injection · env-probe" row and the model reads it in the next step.
//     `notifyModel` picks `inject` (add it to the next accepted step without
//     waking the agent), `steer` (wake the agent and answer) or `off` (UI
//     only, the v1.3.0 behavior). A probe failure is reported the same way.
//   - v1.4.1: tool-only by default. `injectSection` defaults to false,
//     `notifyModel` to `inject`, and the cache lives under
//     `~/.dsh/cache/dsh-env-probe` with the rest of the harness caches.
//     Nothing touches the system prompt unless the profile opts in.
//
// Generic by design: no machine-specific endpoints, no local-service checks,
// every probe item is configurable. Read-only commands only.
//
// Plugin contract (official standard, docs/user/develop/basic):
//   - ESM module exporting `apply(ctx, config)`; config is the SECOND
//     argument, already validated/merged by the `Config["~standard"].validate`
//     schema below (same interface zod/Schemastery wrap; implemented
//     directly here to stay dependency-free).
//   - `inject` declares required services: this plugin needs `systemPrompt`.
//     `commands` and `tools` are consumed through `ctx.inject` so a
//     composition without them keeps the prompt-injection half working.
//   - ctx.systemPrompt.section({ name, order, text }) contributes an ordered
//     system-prompt section; `text` may be a provider evaluated at every
//     assembly, which is how the injected report stays fresh.
//   - Order ranges: -100 harness identity, 0 deployment persona,
//     100-199 tool guidance. This plugin defaults to 30 (environment layer).
//
// Config (via cordis.patch.yml):
//   - id: env-probe
//     config:
//       cacheTtlHours: 168        # re-probe when the cache is older
//       injectSection: false      # true = also inject a system-prompt section
//       notifyModel: 'inject'     # /env-refresh context: 'inject' | 'steer' | 'off'
//       order: 30                 # systemPrompt section order
//       language: 'en'            # section text language: 'en' | 'zh'
//       cacheDir: '~/.dsh/cache/dsh-env-probe'
//       runtimes: ['git','node','python']   # override the default list
//       tools: ['curl','ffmpeg']            # override the default list
//       shells: ['pwsh','cmd']              # override the probed shell list
//       versionArgs:                        # merged over the built-in table
//         '7z': ['-h']                      # [] runs the executable bare
//         terraform: ['version']
//       execAliases:                        # merged over the built-in table
//         pnpm: ['pnpm.cmd', 'pnpm']
//       perProbeTimeoutMs: 5000
//       totalTimeoutMs: 30000
//       concurrency: 4
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { arch, cpus, homedir, platform, release, totalmem, type as osType, version as osVersion } from 'node:os';
import { join, resolve } from 'node:path';

export const name = 'dsh-env-probe';
// Nothing is required up front: the prompt section, the command and both tools
// are each attached through ctx.inject, so a composition missing any one of
// those services still gets the rest (and `injectSection: false` turns the
// plugin into a tool-only plugin that never touches the system prompt).
export const inject = [];

const IS_WIN = platform() === 'win32';

const DEFAULT_RUNTIMES = ['git', 'node', 'npm', 'python', 'python3', 'pip', 'docker', 'java', 'go', 'rustc'];
const DEFAULT_TOOLS = ['curl', 'wget', 'ffmpeg', '7z', 'pandoc', 'tar', 'unzip', 'make', 'gcc', 'pwsh'];

// Version-flag table; everything else is probed with `--version`. Config
// `versionArgs` is merged over this, so a name here can be re-pointed without
// touching this file, and an unknown name gets `--version` unless configured.
const DEFAULT_VERSION_ARGS = {
    java: ['-version'],
    go: ['version'],
    '7z': ['-h'],
    tar: ['--version'],
    unzip: ['-v'],
};

// Alias resolution: tool name -> candidate executable names.
const DEFAULT_EXEC_ALIASES = {
    '7z': ['7z', '7za', '7zr'],
    python: IS_WIN ? ['python', 'py'] : ['python'],
    npm: IS_WIN ? ['npm.cmd', 'npm'] : ['npm'],
    pnpm: IS_WIN ? ['pnpm.cmd', 'pnpm'] : ['pnpm'],
};

const DEFAULT_SHELLS = IS_WIN
    ? ['pwsh', 'powershell', 'cmd', 'bash']
    : ['bash', 'zsh', 'sh', 'fish', 'pwsh'];

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/;

const DEFAULTS = {
    cacheTtlHours: 24,
    order: 30,
    language: 'en',
    cacheDir: '~/.dsh/cache/dsh-env-probe',
    // Register the system-prompt section at all. `false` (the default) keeps
    // this a tool-only plugin: nothing is injected, so every turn's prompt
    // stays byte-identical and the provider-side prompt cache keeps hitting.
    // Set it to true only when the snapshot should be part of the prompt.
    injectSection: false,
    // How `/env-refresh` hands its outcome to the model. The command plane
    // never reaches the model by itself, so this is the only path:
    //   'inject' - submit the result as context only; it lands in the next
    //              accepted step without waking an idle agent (the default)
    //   'steer'  - submit the result and wake the agent, so it answers
    //   'off'    - UI-only result, exactly the v1.3.0 behavior
    notifyModel: 'inject',
    runtimes: DEFAULT_RUNTIMES,
    tools: DEFAULT_TOOLS,
    shells: DEFAULT_SHELLS,
    versionArgs: DEFAULT_VERSION_ARGS,
    execAliases: DEFAULT_EXEC_ALIASES,
    perProbeTimeoutMs: 5000,
    totalTimeoutMs: 30000,
    concurrency: 4,
    marker: 'ENV-PROBE',
};

export const REFRESH_TOOL = 'env_refresh';
export const PROBE_TOOL = 'env_probe';

// Tool definitions are plain registry-ready objects: `ctx.tools.register`
// validates `output.render` and `output.schema` itself, so importing
// `@deepseek-ai/dsh-tools` (not resolvable from a profile plugin) is not
// required and this stays dependency-free. Both tools answer with structured
// data (not prose) so a PTC / `run_code` agent can read a path out of the
// result and call it directly.
const NO_PARAMS = Object.freeze({ type: 'object', additionalProperties: false, properties: {} });

/** One probed executable, used both in snapshots and in diffs. */
const ENTRY_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    properties: {
        name: { type: 'string' },
        kind: { type: 'string', enum: ['runtime', 'tool'] },
        available: { type: 'boolean' },
        path: { type: 'string' },
        version: { type: 'string' },
    },
    required: ['name', 'kind', 'available', 'path', 'version'],
});

/** One changed entry: which side moved and between what. */
const CHANGE_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    properties: {
        name: { type: 'string' },
        kind: { type: 'string', enum: ['version', 'path'] },
        from: { type: 'string' },
        to: { type: 'string' },
    },
    required: ['name', 'kind', 'from', 'to'],
});

const DIFF_PROPERTIES = Object.freeze({
    added: { type: 'array', items: ENTRY_SCHEMA },
    removed: { type: 'array', items: { type: 'string' } },
    changed: { type: 'array', items: CHANGE_SCHEMA },
});

const REFRESH_OUTPUT_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    properties: {
        ok: { type: 'boolean' },
        probedAt: { type: 'string' },
        summary: { type: 'string' },
        ...DIFF_PROPERTIES,
        error: { type: 'string' },
    },
    required: ['ok', 'probedAt', 'summary', 'added', 'removed', 'changed'],
});

const PROBE_OUTPUT_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    properties: {
        ok: { type: 'boolean' },
        probedAt: { type: 'string' },
        ageSeconds: { type: 'integer' },
        os: {
            type: 'object',
            additionalProperties: false,
            properties: {
                name: { type: 'string' },
                arch: { type: 'string' },
                cpus: { type: 'integer' },
                memoryGB: { type: 'number' },
            },
            required: ['name', 'arch', 'cpus', 'memoryGB'],
        },
        shell: {
            type: 'object',
            additionalProperties: false,
            properties: {
                current: { type: 'string' },
                available: { type: 'array', items: { type: 'string' } },
            },
            required: ['current', 'available'],
        },
        entries: { type: 'array', items: ENTRY_SCHEMA },
        disks: { type: 'array', items: { type: 'string' } },
        proxy: { type: 'array', items: { type: 'string' } },
        error: { type: 'string' },
    },
    required: ['ok', 'probedAt', 'ageSeconds', 'os', 'shell', 'entries', 'disks', 'proxy'],
});

function toEntry(item, kind) {
    return {
        name: item.name,
        kind,
        available: item.available === true,
        path: item.path || '',
        version: item.version || '',
    };
}

export const Config = {
    '~standard': {
        version: 1,
        vendor: 'dsh-env-probe',
        validate(value) {
            const issues = [];
            const input = value === undefined || value === null ? {} : value;
            const checkNum = (key, positive) => {
                if (input[key] !== undefined && (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || (positive && input[key] <= 0))) {
                    issues.push({ message: `${key} must be a ${positive ? 'positive ' : ''}finite number`, path: [key] });
                }
            };
            checkNum('cacheTtlHours', true); checkNum('order'); checkNum('perProbeTimeoutMs', true);
            checkNum('totalTimeoutMs', true); checkNum('concurrency', true);
            if (input.language !== undefined && !['en', 'zh'].includes(input.language)) {
                issues.push({ message: "language must be 'en' or 'zh'", path: ['language'] });
            }
            if (input.cacheDir !== undefined && typeof input.cacheDir !== 'string') {
                issues.push({ message: 'cacheDir must be a string', path: ['cacheDir'] });
            }
            if (input.marker !== undefined && typeof input.marker !== 'string') {
                issues.push({ message: 'marker must be a string', path: ['marker'] });
            }
            if (input.injectSection !== undefined && typeof input.injectSection !== 'boolean') {
                issues.push({ message: 'injectSection must be a boolean', path: ['injectSection'] });
            }
            if (input.notifyModel !== undefined && !['steer', 'inject', 'off'].includes(input.notifyModel)) {
                issues.push({ message: "notifyModel must be 'steer', 'inject' or 'off'", path: ['notifyModel'] });
            }
            const nameList = (key, value) => Array.isArray(value) && value.every(v => typeof v === 'string' && NAME_RE.test(v));
            for (const key of ['runtimes', 'tools', 'shells']) {
                if (input[key] !== undefined && !nameList(key, input[key])) {
                    issues.push({ message: `${key} must be an array of safe executable names`, path: [key] });
                }
            }
            // Executable-name -> argv tables: `versionArgs` values are argv
            // fragments (any string is fine), `execAliases` values are names.
            if (input.versionArgs !== undefined) {
                const t = input.versionArgs;
                const bad = typeof t !== 'object' || t === null || Array.isArray(t)
                    || Object.entries(t).some(([k, v]) => !NAME_RE.test(k) || !Array.isArray(v) || v.some(a => typeof a !== 'string'));
                if (bad) issues.push({ message: 'versionArgs must map safe executable names to string arrays', path: ['versionArgs'] });
            }
            if (input.execAliases !== undefined) {
                const t = input.execAliases;
                const bad = typeof t !== 'object' || t === null || Array.isArray(t)
                    || Object.entries(t).some(([k, v]) => !NAME_RE.test(k) || !nameList('execAliases', v) || v.length === 0);
                if (bad) issues.push({ message: 'execAliases must map safe executable names to non-empty name arrays', path: ['execAliases'] });
            }
            if (issues.length) return { issues };
            return { value: { ...DEFAULTS, ...input } };
        },
    },
};

// ---------------------------------------------------------------------------
// Probe engine (also exported for standalone testing / reuse)
// ---------------------------------------------------------------------------

function expandHome(p) {
    if (p === '~') return homedir();
    if (p.startsWith('~/') || p.startsWith('~\\')) return resolve(homedir(), p.slice(2));
    return p;
}

function run(cmd, args, timeoutMs) {
    return new Promise((res) => {
        // Node >=18.20 throws EINVAL SYNCHRONOUSLY when spawning .cmd/.bat
        // without shell (CVE-2024-27980); convert that into a normal miss so
        // one bad shim can never sink the whole probe pool.
        let child;
        try {
            child = execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 256, encoding: 'utf8' }, (err, stdout, stderr) => {
                // Merge stderr: several tools (java, 7z) print versions there.
                const out = ((stdout || '') + (stderr || '')).trim();
                if (err && !out) return res({ ok: false, out: '' });
                res({ ok: !err, out });
            });
        } catch {
            return res({ ok: false, out: '' });
        }
        child.on('error', () => res({ ok: false, out: '' }));
    });
}

async function which(name, timeoutMs) {
    const r = await run(IS_WIN ? 'where' : 'which', [name], timeoutMs);
    if (!r.ok) return null;
    const first = r.out.split(/\r?\n/).map(s => s.trim()).find(Boolean);
    return first || null;
}

function firstLine(s) {
    return (s || '').split(/\r?\n/).map(x => x.trim()).find(Boolean) || '';
}

// npm/pnpm install a POSIX launcher (no extension) next to the Windows shim;
// `where pnpm` returns the launcher first and execFile cannot run it. Prefer a
// sibling that Windows can actually execute.
function pickRunnable(found) {
    if (!IS_WIN || /\.[a-z0-9]+$/i.test(found)) return found;
    for (const ext of ['.exe', '.cmd', '.bat']) {
        if (existsSync(found + ext)) return found + ext;
    }
    return found;
}

async function probeExecutable(name, perTimeoutMs, versionArgs, execAliases) {
    const candidates = execAliases[name] || [name];
    let found = null, resolved = name;
    for (const c of candidates) {
        found = await which(c, perTimeoutMs);
        if (found) { resolved = c; break; }
    }
    if (!found) return { name, available: false };
    const execPath = pickRunnable(found);
    const args = versionArgs[name] ?? ['--version'];
    // .cmd/.bat shims need cmd.exe as interpreter on modern Node.
    const viaCmd = IS_WIN && /\.(cmd|bat)$/i.test(execPath);
    const v = viaCmd ? await run('cmd', ['/c', execPath, ...args], perTimeoutMs)
                     : await run(execPath, args, perTimeoutMs);
    const ver = firstLine(v.out).slice(0, 120);
    return { name, available: true, path: execPath, version: ver || undefined };
}

async function probeOs(perTimeoutMs) {
    const info = {
        platform: platform(), type: osType(), release: release(), arch: arch(),
        cpus: cpus().length, totalMemGB: Math.round(totalmem() / 1024 ** 3 * 10) / 10,
    };
    try {
        if (IS_WIN) {
            // `cmd /c ver` outputs in the OEM codepage (mojibake on non-UTF8
            // locales); ask PowerShell for a UTF-8 caption instead.
            const ps = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-CimInstance Win32_OperatingSystem).Caption';
            const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], perTimeoutMs * 2);
            info.pretty = firstLine(r.out) || `Windows (kernel ${osVersion()})`;
        } else if (platform() === 'darwin') {
            const n = await run('sw_vers', ['-productName'], perTimeoutMs);
            const v = await run('sw_vers', ['-productVersion'], perTimeoutMs);
            info.pretty = `${firstLine(n.out)} ${firstLine(v.out)}`.trim();
        } else if (existsSync('/etc/os-release')) {
            const txt = readFileSync('/etc/os-release', 'utf-8');
            const m = txt.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
            info.pretty = m ? m[1] : `${osType()} ${release()}`;
        } else {
            info.pretty = `${osType()} ${release()}`;
        }
    } catch { /* keep basic fields */ }
    return info;
}

async function probeShells(perTimeoutMs, shells) {
    const found = [];
    for (const s of shells) {
        const p = await which(s, perTimeoutMs);
        if (p) found.push(s);
    }
    const current = IS_WIN ? (process.env.COMSPEC || 'cmd') : (process.env.SHELL || 'unknown');
    return { current, available: found };
}

async function probeDisks(perTimeoutMs) {
    try {
        if (IS_WIN) {
            const ps = 'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { "{0} {1}/{2} GB free" -f $_.DeviceID, [math]::Round($_.FreeSpace/1GB,1), [math]::Round($_.Size/1GB,1) }';
            const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], perTimeoutMs * 2);
            if (r.ok && r.out.trim()) return r.out.trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 12);
            return [];
        }
        const args = platform() === 'darwin' ? ['-h'] : ['-h', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'overlay'];
        const r = await run('df', args, perTimeoutMs);
        if (!r.ok) return [];
        return r.out.trim().split(/\r?\n/).slice(1).map(s => s.trim()).filter(Boolean).slice(0, 10);
    } catch { return []; }
}

function maskProxy(raw) {
    if (!raw) return null;
    try {
        const u = new URL(raw);
        if (u.username || u.password) { u.username = '***'; u.password = '***'; }
        return u.toString();
    } catch { return '(set)'; }
}

function probeProxy() {
    const out = {};
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']) {
        const v = maskProxy(process.env[k]);
        if (v) out[k] = v;
    }
    return out;
}

async function pool(items, size, worker) {
    const results = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
        while (i < items.length) {
            const idx = i++;
            results[idx] = await worker(items[idx]);
        }
    }));
    return results;
}

// Full probe. Returns a structured report object; never throws.
export async function probeEnvironment(cfg) {
    const per = cfg.perProbeTimeoutMs, conc = cfg.concurrency;
    const versionArgs = { ...DEFAULT_VERSION_ARGS, ...(cfg.versionArgs ?? {}) };
    const execAliases = { ...DEFAULT_EXEC_ALIASES, ...(cfg.execAliases ?? {}) };
    const shells = cfg.shells ?? DEFAULT_SHELLS;
    const deadline = Date.now() + cfg.totalTimeoutMs;
    const withBudget = async (label, fn, fallback) => {
        if (Date.now() > deadline) return fallback;
        try { return await fn(); } catch { return fallback; }
    };
    const probe = (n) => probeExecutable(n, per, versionArgs, execAliases);
    const [osInfo, shellInfo, runtimes, tools, disks] = await Promise.all([
        withBudget('os', () => probeOs(per), {}),
        withBudget('shells', () => probeShells(per, shells), { current: 'unknown', available: [] }),
        withBudget('runtimes', () => pool(cfg.runtimes, conc, probe), []),
        withBudget('tools', () => pool(cfg.tools, conc, probe), []),
        withBudget('disks', () => probeDisks(per), []),
    ]);
    return {
        probedAt: new Date().toISOString(),
        os: osInfo,
        shells: shellInfo,
        runtimes,
        tools,
        disks,
        proxy: probeProxy(),
    };
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

const L = {
    en: {
        title: 'LOCAL MACHINE ENVIRONMENT SNAPSHOT',
        intro: 'This snapshot describes the machine only as it was at the time above. Runtimes and tools installed, upgraded, removed or moved on PATH afterwards are not reflected here, so it may already be out of date.',
        refreshHint: 'When a listed path or version disagrees with what the machine actually does, trust the real command and call the `env_refresh` tool to probe again.',
        refreshHintNoTool: 'When a listed path or version disagrees with what the machine actually does, trust the real command and re-probe before relying on this snapshot.',
        unavailableNote: 'An entry marked unavailable only means the executable was not found on PATH when the probe ran.',
        os: 'Operating System', shells: 'Shells', runtimes: 'Runtimes', tools: 'Tools',
        disks: 'Disks', proxy: 'Proxy Environment', none: 'none detected',
        current: 'current', probedAt: 'probed at', unavailable: 'unavailable',
        noReport: 'The environment probe has not finished yet or failed. Assume a generic environment and verify before relying on it.',
        cmdRefreshDesc: 're-probe the local environment, rewrite the cache, and return only what changed since the previous probe',
        cmdHint: 'no arguments; press Enter',
        cmdRefreshed: 'Environment snapshot refreshed',
        cmdProbeFailed: 'environment probe failed',
        cmdNotified: 'The result was also injected into this conversation as model context.',
        noChanges: 'no changes since the previous probe',
        noticeIntro: 'The user ran the /env-refresh command, which re-probed this machine\'s environment just now. This notice replaces any earlier ENV-PROBE snapshot in this conversation.',
        noticeChanges: 'Changes since the previous probe:',
        noticeHint: 'The cached snapshot has been rewritten. Call the `env_probe` tool when you need the full entry list with paths and versions.',
        noticeFailed: 'The user ran the /env-refresh command and the environment probe failed. Re-probe before relying on the previous snapshot.',
        toolDesc: 'Re-probe this machine\'s environment now (OS, shells, runtimes, tools, disks, proxy), rewrite the cached snapshot, and return ONLY the diff against the previous probe as structured data (added / removed / changed). Blocks until an already-running probe finishes. Call it after installing, upgrading or removing a tool, or when a path or version from the injected ENV-PROBE snapshot no longer matches reality. Read-only: it never installs anything.',
        toolNoArgs: 'Takes no arguments.',
        probeDesc: 'Read the current machine environment snapshot as structured data: OS, shell, disks, proxy, and one entry per configured runtime and tool with name, kind, available, path and version. Answer comes from the cached snapshot when it is still within cacheTtlHours; otherwise (or when no snapshot exists) it probes once. If a probe is already running it waits for that run instead of racing it. Use it to resolve an executable path (e.g. the python or node entry) before calling another tool, instead of guessing PATH or shelling out to `where`/`which`. Call env_refresh when you specifically need the diff.',
        probeUnavailable: 'no environment snapshot available yet',
    },
    zh: {
        title: '本机环境快照',
        intro: '这份快照只描述探测时刻的状态。探测之后安装、升级、删除或改动 PATH 的运行时与工具都不会反映在这里，所以它可能已经过时。',
        refreshHint: '清单里的路径或版本与机器实际情况不符时，以真实命令的输出为准，并调用 `env_refresh` 工具重新探测。',
        refreshHintNoTool: '清单里的路径或版本与机器实际情况不符时，以真实命令的输出为准，并在依赖它之前重新探测。',
        unavailableNote: '标记为未探测到的项，只表示探测时 PATH 上找不到它。',
        os: '操作系统', shells: 'Shell', runtimes: '运行时', tools: '工具',
        disks: '磁盘', proxy: '代理环境变量', none: '未检测到',
        current: '当前', probedAt: '探测于', unavailable: '未探测到',
        noReport: '环境探测尚未完成或已失败。先按通用环境处理，并在依赖这些信息前核实。',
        cmdRefreshDesc: '重新探测本机环境、重写缓存，只返回与上次探测的差异',
        cmdHint: '无需参数，直接回车',
        cmdRefreshed: '环境快照已刷新',
        cmdProbeFailed: '环境探测失败',
        cmdNotified: '结果已同时作为模型上下文注入本次对话。',
        noChanges: '较上次探测无变化',
        noticeIntro: '用户执行了 /env-refresh 命令，刚刚重新探测了本机环境。这条通知取代本次对话中此前的 ENV-PROBE 快照。',
        noticeChanges: '与上次探测的差异：',
        noticeHint: '缓存已重写。需要带路径与版本的完整条目清单时，调用 `env_probe` 工具。',
        noticeFailed: '用户执行了 /env-refresh 命令，但环境探测失败。依赖此前的快照之前先重新探测。',
        toolDesc: '立即重新探测本机环境（系统、shell、运行时、工具、磁盘、代理），重写环境快照缓存，只返回与上次探测的差异（结构化 added / removed / changed）。已有探测在进行时会阻塞等待其完成。安装、升级、卸载工具后，或注入的 ENV-PROBE 快照中的路径/版本与实际不符时调用。只读操作，不会安装任何东西。',
        toolNoArgs: '无参数。',
        probeDesc: '以结构化数据读取当前的本机环境快照：系统、shell、磁盘、代理，以及每个已配置运行时与工具的名称、kind、available、path、version。缓存在 cacheTtlHours 内就直接返回；过期或不存在时探测一次；若已有探测在跑则等那一次完成而不是抢跑。需要可执行文件路径时（例如 python、node 的条目）用它，不要靠猜 PATH 或另跑 where/which。只想知道差异时用 env_refresh。',
        probeUnavailable: '当前还没有可用的环境快照',
    },
};

function renderMarkdown(report, cfg, toolAvailable) {
    const t = L[cfg.language] || L.en;
    // No relative age here on purpose: a "16 min ago" suffix would change the
    // system prompt every minute and bust the provider-side prompt cache. The
    // absolute probe timestamp only changes when the snapshot is rewritten.
    const lines = [
        `${cfg.marker}: ${t.title} (${t.probedAt} ${report.probedAt})`,
        t.intro,
        toolAvailable ? t.refreshHint : t.refreshHintNoTool,
        t.unavailableNote,
        '',
    ];
    const o = report.os || {};
    lines.push(`## ${t.os}`);
    lines.push(`- ${o.pretty || `${o.type || '?'} ${o.release || ''}`} | ${o.arch || '?'} | CPU: ${o.cpus ?? '?'} | RAM: ${o.totalMemGB ?? '?'} GB`);
    const sh = report.shells || {};
    lines.push(`## ${t.shells}`);
    lines.push(`- ${t.current}: ${sh.current || 'unknown'} | ${t.shells}: ${(sh.available || []).join(', ') || t.none}`);
    for (const [key, label] of [['runtimes', t.runtimes], ['tools', t.tools]]) {
        lines.push(`## ${label}`);
        const arr = report[key] || [];
        if (!arr.length) { lines.push(`- ${t.none}`); continue; }
        for (const item of arr) {
            lines.push(item.available
                ? `- ${item.name}: ${item.version || 'ok'} (${item.path})`
                : `- ${item.name}: ${t.unavailable}`);
        }
    }
    lines.push(`## ${t.disks}`);
    if ((report.disks || []).length) for (const d of report.disks) lines.push(`- ${d}`);
    else lines.push(`- ${t.none}`);
    const px = Object.entries(report.proxy || {});
    if (px.length) { lines.push(`## ${t.proxy}`); for (const [k, v] of px) lines.push(`- ${k}=${v}`); }
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Diffing (the only thing the command and the tool hand back)
// ---------------------------------------------------------------------------

/**
 * Compare two cached reports on runtimes/tools availability & versions.
 * Returns an empty diff when there is no previous report to compare against.
 * A changed entry keeps the kind so the reply can say which side moved:
 * a version bump and a relocated executable are different facts.
 * @returns {{ added: object[], removed: string[], changed: { name: string, kind: 'version'|'path', from: string, to: string }[] }}
 */
function diffReports(oldReport, newReport) {
    const diff = { added: [], removed: [], changed: [] };
    if (!oldReport) return diff;
    for (const key of ['runtimes', 'tools']) {
        const kind = key === 'runtimes' ? 'runtime' : 'tool';
        const oldMap = new Map((oldReport[key] || []).map(i => [i.name, i]));
        for (const item of newReport[key] || []) {
            const prev = oldMap.get(item.name);
            if (!prev || !prev.available) {
                if (item.available) diff.added.push(toEntry(item, kind));
                continue;
            }
            if (!item.available) { diff.removed.push(item.name); continue; }
            if ((prev.version || '') !== (item.version || '')) {
                diff.changed.push({ name: item.name, kind: 'version', from: prev.version || '?', to: item.version || '(no version output)' });
            } else if ((prev.path || '') !== (item.path || '')) {
                diff.changed.push({ name: item.name, kind: 'path', from: prev.path || '?', to: item.path || '?' });
            }
        }
        const present = new Set((newReport[key] || []).map(i => i.name));
        for (const [nm, prev] of oldMap) if (!present.has(nm) && prev.available) diff.removed.push(nm);
    }
    return diff;
}

function isEmptyDiff(diff) {
    return !diff || (!diff.added.length && !diff.removed.length && !diff.changed.length);
}

/** One-line-per-change diff text. Never the full report. */
function renderDiff(diff) {
    const lines = [];
    for (const item of diff.added) {
        lines.push(`+ ${item.name}: ${item.version || 'ok'} (${item.path})`);
    }
    for (const name of diff.removed) lines.push(`- ${name}`);
    for (const c of diff.changed) {
        lines.push(c.kind === 'path'
            ? `~ ${c.name} (path): ${c.from} -> ${c.to}`
            : `~ ${c.name}: ${c.from} -> ${c.to}`);
    }
    return lines.join('\n');
}

function refreshReply(result, t) {
    if (!result.ok) return `${t.cmdProbeFailed}: ${result.error}`;
    const head = `${t.cmdRefreshed} (${t.probedAt} ${result.report.probedAt})`;
    if (isEmptyDiff(result.diff)) return `${head}: ${t.noChanges}`;
    return `${head}\n${renderDiff(result.diff)}`;
}

/** Bound for the collapsed one-line context account (`notice` form summary). */
const CONTEXT_SUMMARY_MAX_CHARS = 120;

/** Collapse whitespace and bound one context summary to the producer contract. */
function boundSummary(text) {
    const one = (text || '').replace(/\s+/g, ' ').trim();
    return one.length <= CONTEXT_SUMMARY_MAX_CHARS
        ? one
        : `${one.slice(0, CONTEXT_SUMMARY_MAX_CHARS - 1)}…`;
}

/**
 * The model-facing account of one `/env-refresh` run, as a producer supplied
 * context message: `<system-reminder>` text plus the one-line summary the Chat
 * shows while the row is collapsed. Built even when the probe failed, so the
 * model learns that the snapshot it holds is no longer trusted.
 * @returns {{ summary: string, text: string }}
 */
function buildRefreshNotice(result, t) {
    if (!result.ok) {
        return {
            summary: boundSummary(`${t.cmdProbeFailed}: ${result.error || ''}`),
            text: `<system-reminder>\n${t.noticeFailed}\n${result.error || ''}\n</system-reminder>`,
        };
    }
    const probedAt = result.report.probedAt;
    const diff = result.diff || { added: [], removed: [], changed: [] };
    const empty = isEmptyDiff(diff);
    const counts = `+${diff.added.length} -${diff.removed.length} ~${diff.changed.length}`;
    const summary = boundSummary(empty ? `${probedAt} · ${t.noChanges}` : `${probedAt} · ${counts}`);
    const body = empty
        ? `- ${t.noChanges}`
        : `${t.noticeChanges}\n${renderDiff(diff)}`;
    return {
        summary,
        text: `<system-reminder>\n${t.noticeIntro}\n${t.probedAt}: ${probedAt}\n${body}\n${t.noticeHint}\n</system-reminder>`,
    };
}

/**
 * Hand a command outcome to the receiving agent as a producer supplied
 * context message. `dsh-commands` never forwards a command or its result to
 * the model, so this is what puts `/env-refresh` into the conversation: the
 * Chat renders it as a "Context injection · env-probe" row and the model
 * reads it in the next step.
 * @returns whether the message was accepted by the agent.
 */
function sendCommandNotice(agent, result, cfg, t, warn) {
    if (cfg.notifyModel === 'off' || !agent) return false;
    const notice = buildRefreshNotice(result, t);
    // Shape mirrors @deepseek-ai/dsh-llm `createUserMessage` without the
    // dependency: an identified user message whose producer-declared source
    // carries the `notice` form and its bounded one-line account.
    const message = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: notice.text }],
        source: { kind: 'env-probe', form: 'notice', summary: notice.summary },
    };
    try {
        if (cfg.notifyModel === 'inject' && typeof agent.inject === 'function') agent.inject(message);
        else agent.steer(message);
        return true;
    } catch (e) {
        warn(`/env-refresh could not notify the model: ${(e && e.message) || e}`);
        return false;
    }
}

/** Structured snapshot handed to `env_probe` (and to PTC code reading it). */
function snapshotValue(report) {
    const o = report.os || {};
    const sh = report.shells || {};
    const ageSeconds = Math.round((Date.now() - Date.parse(report.probedAt)) / 1000);
    return {
        ok: true,
        probedAt: report.probedAt,
        ageSeconds: Number.isFinite(ageSeconds) && ageSeconds > 0 ? ageSeconds : 0,
        os: {
            name: o.pretty || o.type || '',
            arch: o.arch || '',
            cpus: Number.isInteger(o.cpus) ? o.cpus : 0,
            memoryGB: Number.isFinite(o.totalMemGB) ? o.totalMemGB : 0,
        },
        shell: { current: sh.current || '', available: Array.isArray(sh.available) ? sh.available : [] },
        entries: [
            ...(report.runtimes || []).map(i => toEntry(i, 'runtime')),
            ...(report.tools || []).map(i => toEntry(i, 'tool')),
        ],
        disks: Array.isArray(report.disks) ? report.disks : [],
        proxy: Object.entries(report.proxy || {}).map(([k, v]) => `${k}=${v}`),
    };
}

function probeFailure(error) {
    return {
        ok: false,
        probedAt: '',
        ageSeconds: 0,
        os: { name: '', arch: '', cpus: 0, memoryGB: 0 },
        shell: { current: '', available: [] },
        entries: [],
        disks: [],
        proxy: [],
        error: error || '',
    };
}

function probeText(value, t) {
    if (!value.ok) return `${t.probeUnavailable}${value.error ? `: ${value.error}` : ''}`;
    const available = value.entries.filter(e => e.available);
    const lines = [
        `${value.probedAt} | ${value.os.name} | ${value.os.arch} | CPU ${value.os.cpus} | RAM ${value.os.memoryGB} GB`,
        `${available.length}/${value.entries.length} available`,
    ];
    for (const e of value.entries) lines.push(e.available ? `${e.name}: ${e.path}` : `${e.name}: -`);
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
    const cfg = { ...DEFAULTS, ...(config ?? {}) };
    const t = L[cfg.language] || L.en;
    const dir = resolve(expandHome(cfg.cacheDir));
    const jsonPath = join(dir, 'env-profile.json');
    const mdPath = join(dir, 'env-profile.md');

    // Live state served by the section provider (evaluated at each assembly).
    const state = { report: null, inflight: null, lastError: null, toolAvailable: false };

    const warn = (message) => {
        try { ctx.logger?.warn?.(message); } catch { /* logging is best-effort */ }
    };

    function readCache() {
        try {
            const report = JSON.parse(readFileSync(jsonPath, 'utf-8'));
            const mtime = statSync(jsonPath).mtimeMs;
            const fresh = (Date.now() - mtime) < cfg.cacheTtlHours * 3600_000;
            return { report, fresh };
        } catch { return null; }
    }

    function readCachedReport() {
        try { return JSON.parse(readFileSync(jsonPath, 'utf-8')); } catch { return null; }
    }

    // Single-flight, blocking re-probe. Callers (boot, TTL check, /env-refresh,
    // the env_refresh tool) all join the same in-flight run and are resolved
    // only by a probe that actually completed - never by the older cache.
    function reprobe() {
        if (state.inflight) return state.inflight;
        const job = (async () => {
            const oldReport = readCachedReport();
            try {
                const report = await probeEnvironment(cfg);
                mkdirSync(dir, { recursive: true });
                writeFileSync(jsonPath, JSON.stringify(report, null, 2));
                writeFileSync(mdPath, renderMarkdown(report, cfg, state.toolAvailable));
                state.report = report;
                state.lastError = null;
                return { ok: true, report, diff: diffReports(oldReport, report) };
            } catch (e) {
                state.lastError = (e && e.message) || String(e);
                return { ok: false, error: state.lastError };
            } finally {
                state.inflight = null;
            }
        })();
        state.inflight = job;
        return job;
    }

    // Boot: warm the cache so both the section and env_probe have something to
    // serve. A cache past its TTL only triggers a silent background re-probe;
    // there is no "expired" state to render, the header always states when the
    // snapshot was taken. Nothing here depends on the section being enabled.
    const cached = readCache();
    if (cached) state.report = cached.report;
    if (!cached || !cached.fresh) reprobe(); // fire and forget

    if (cfg.injectSection) {
        ctx.inject(['systemPrompt'], (promptCtx) => {
            promptCtx.systemPrompt.section({
                name: 'env-probe',
                order: cfg.order,
                text: () => {
                    // TTL expiry check at assembly time: trigger background refresh.
                    if (!state.inflight) {
                        try {
                            const mtime = statSync(jsonPath).mtimeMs;
                            if (Date.now() - mtime > cfg.cacheTtlHours * 3600_000) reprobe();
                        } catch { /* no cache file yet: the boot probe is running */ }
                    }
                    if (!state.report) {
                        return `${cfg.marker}: ${t.noReport}${state.lastError ? ` (${state.lastError})` : ''}`;
                    }
                    return renderMarkdown(state.report, cfg, state.toolAvailable);
                },
            });
        });
    }

    // -----------------------------------------------------------------------
    // Optional /env-refresh command (registered only when the `commands`
    // service is composed, e.g. the Web UI).
    // -----------------------------------------------------------------------
    if (typeof ctx.inject === 'function') {
        ctx.inject(['commands'], (commandCtx) => {
            commandCtx.commands.register({
                name: 'env-refresh',
                description: t.cmdRefreshDesc,
                input: { hint: t.cmdHint },
                recordInput: false,
                handler: async ({ agent }) => {
                    const result = await reprobe();
                    // The command plane is UI-only by contract; forward the
                    // outcome to the model explicitly (see sendCommandNotice).
                    const notified = sendCommandNotice(agent, result, cfg, t, warn);
                    if (!result.ok) return { kind: 'error', text: `${t.cmdProbeFailed}: ${result.error}` };
                    const text = refreshReply(result, t);
                    return { kind: 'success', text: notified ? `${text}\n${t.cmdNotified}` : text };
                },
            });
        });
    }

    // -----------------------------------------------------------------------
    // Tools for the model. Both answer with structured data so a PTC /
    // `run_code` agent can read a path out of the result and call it directly.
    // Registered as plain registry-ready definitions because
    // `ctx.tools.register` validates the shape itself.
    // -----------------------------------------------------------------------
    if (typeof ctx.inject === 'function') {
        ctx.inject(['tools'], (toolCtx) => {
            const refreshTool = {
                name: REFRESH_TOOL,
                description: `${t.toolDesc}\n${t.toolNoArgs}`,
                parameters: NO_PARAMS,
                output: {
                    schema: REFRESH_OUTPUT_SCHEMA,
                    render: (_args, value) => [{ type: 'text', text: value.summary }],
                },
                timeoutMs: cfg.totalTimeoutMs + 5000,
                async execute() {
                    const result = await reprobe();
                    if (!result.ok) {
                        return {
                            ok: false, probedAt: '', summary: `${t.cmdProbeFailed}: ${result.error}`, error: result.error,
                            added: [], removed: [], changed: [],
                        };
                    }
                    return {
                        ok: true,
                        probedAt: result.report.probedAt,
                        summary: refreshReply(result, t),
                        added: result.diff.added,
                        removed: result.diff.removed,
                        changed: result.diff.changed,
                    };
                },
            };

            const probeTool = {
                name: PROBE_TOOL,
                description: `${t.probeDesc}\n${t.toolNoArgs}`,
                parameters: NO_PARAMS,
                output: {
                    schema: PROBE_OUTPUT_SCHEMA,
                    render: (_args, value) => [{ type: 'text', text: probeText(value, t) }],
                },
                timeoutMs: cfg.totalTimeoutMs + 5000,
                async execute() {
                    // Never answer from the cache while a fresh probe is landing:
                    // wait for the in-flight run instead of racing it.
                    if (state.inflight) {
                        const inFlight = await state.inflight;
                        if (inFlight.ok) return snapshotValue(inFlight.report);
                    }
                    // The answer is bounded by cacheTtlHours: a warm cache is
                    // served as-is, a cold or missing one is probed once. This
                    // keeps env_probe useful even when the injected section is
                    // disabled and nothing else refreshes the cache.
                    const warm = readCache();
                    if (warm && warm.fresh) {
                        state.report = warm.report;
                        return snapshotValue(warm.report);
                    }
                    const result = await reprobe();
                    if (!result.ok) return probeFailure(result.error);
                    return snapshotValue(result.report);
                },
            };

            let refreshRegistered = false;
            for (const tool of [refreshTool, probeTool]) {
                try {
                    toolCtx.tools.register(tool);
                    if (tool.name === REFRESH_TOOL) refreshRegistered = true;
                } catch (e) {
                    warn(`${tool.name} tool not registered: ${(e && e.message) || e}`);
                }
            }
            state.toolAvailable = refreshRegistered;
        });
    }
}
