// dsh-env-probe (v1.1.x, local fork)
// Zero-dependency DeepSeek Harness (dsh) plugin: probe the local machine
// environment once, cache the report on disk, and inject it into every
// session's system prompt so the agent does not have to guess what this
// computer offers (OS, shells, runtimes, tools, disks, proxy).
//
// v1.1.0 (local fork) changes:
//   - /env-refresh now returns ONLY the diff against the previous probe, never
//     the whole report, and blocks while a background probe is in flight
//     instead of answering from a stale cache.
//   - /env-suggest is gone (it steered the agent and burned tokens silently).
//   - new `env_refresh` tool for the model: same blocking refresh, same
//     diff-only answer, and it rewrites the cache the injected section reads.
//   - the version-probe commands, executable aliases and shell list are now
//     configuration (`versionArgs` / `execAliases` / `shells`) instead of
//     hard-coded tables.
//   - the injected title/intro no longer argue that the report must be
//     trusted; they state that it is a snapshot and may already be out of
//     date, and they name the tool that refreshes it.
//   - extensionless POSIX-style shims found on PATH (npm/pnpm) are resolved
//     to their runnable .cmd sibling so the version probe actually runs.
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
//       order: 30                 # systemPrompt section order
//       language: 'en'            # section text language: 'en' | 'zh'
//       cacheDir: '~/.dsh-env-probe'
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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { arch, cpus, homedir, platform, release, totalmem, type as osType, version as osVersion } from 'node:os';
import { join, resolve } from 'node:path';

export const name = 'dsh-env-probe';
export const inject = ['systemPrompt'];

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
    cacheTtlHours: 168,
    order: 30,
    language: 'en',
    cacheDir: '~/.dsh-env-probe',
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

export const TOOL_NAME = 'env_refresh';

// The tool definition is a plain registry-ready object: `ctx.tools.register`
// validates `output.render` and `output.schema` itself, so importing
// `@deepseek-ai/dsh-tools` (not resolvable from a profile plugin) is not
// required and this stays dependency-free.
const TOOL_PARAMETERS = Object.freeze({
    type: 'object',
    additionalProperties: false,
    properties: {},
});

const TOOL_OUTPUT_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    properties: {
        ok: { type: 'boolean' },
        probedAt: { type: 'string' },
        summary: { type: 'string' },
        error: { type: 'string' },
    },
    required: ['ok', 'probedAt', 'summary'],
});

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
        ageNow: 'just now', ageMinutes: '{n} min ago', ageHours: '{n} h ago', ageDays: '{n} d ago',
        stale: '(cache expired: re-probing in the background, values below are from the older probe)',
        noReport: 'The environment probe has not finished yet or failed. Assume a generic environment and verify before relying on it.',
        cmdRefreshDesc: 're-probe the local environment, rewrite the cache, and return only what changed since the previous probe',
        cmdHint: 'no arguments; press Enter',
        cmdRefreshed: 'Environment snapshot refreshed',
        cmdProbeFailed: 'environment probe failed',
        noChanges: 'no changes since the previous probe',
        toolDesc: 'Re-probe this machine\'s environment now (OS, shells, runtimes, tools, disks, proxy), rewrite the cached snapshot that is injected into the system prompt, and return ONLY the diff against the previous probe. Blocks until the probe finishes when one is already running. Call it after installing, upgrading or removing a tool, or when a path or version from the injected ENV-PROBE snapshot no longer matches reality. Read-only: it never installs anything.',
        toolNoArgs: 'Takes no arguments.',
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
        ageNow: '刚刚', ageMinutes: '{n} 分钟前', ageHours: '{n} 小时前', ageDays: '{n} 天前',
        stale: '（缓存已过期，正在后台重探，以下为更早一次的探测结果）',
        noReport: '环境探测尚未完成或已失败。先按通用环境处理，并在依赖这些信息前核实。',
        cmdRefreshDesc: '重新探测本机环境、重写缓存，只返回与上次探测的差异',
        cmdHint: '无需参数，直接回车',
        cmdRefreshed: '环境快照已刷新',
        cmdProbeFailed: '环境探测失败',
        noChanges: '较上次探测无变化',
        toolDesc: '立即重新探测本机环境（系统、shell、运行时、工具、磁盘、代理），重写注入到系统提示词里的环境快照缓存，只返回与上次探测的差异。已有探测在进行时会阻塞等待其完成。安装、升级、卸载工具后，或注入的 ENV-PROBE 快照中的路径/版本与实际不符时调用。只读操作，不会安装任何东西。',
        toolNoArgs: '无参数。',
    },
};

function ageText(iso, t) {
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms) || ms < 0) return '';
    const min = Math.round(ms / 60000);
    if (min < 2) return t.ageNow;
    if (min < 90) return t.ageMinutes.replace('{n}', String(min));
    const hours = Math.round(min / 60);
    if (hours < 48) return t.ageHours.replace('{n}', String(hours));
    return t.ageDays.replace('{n}', String(Math.round(hours / 24)));
}

function renderMarkdown(report, cfg, stale, toolAvailable) {
    const t = L[cfg.language] || L.en;
    const age = ageText(report.probedAt, t);
    const lines = [
        `${cfg.marker}: ${t.title} (${t.probedAt} ${report.probedAt}${age ? `, ${age}` : ''})${stale ? ' ' + t.stale : ''}`,
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
        const oldMap = new Map((oldReport[key] || []).map(i => [i.name, i]));
        for (const item of newReport[key] || []) {
            const prev = oldMap.get(item.name);
            if (!prev || !prev.available) {
                if (item.available) diff.added.push(item);
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
    const state = { report: null, stale: false, inflight: null, lastError: null, toolAvailable: false };

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
    // only by a probe that actually completed - never by the stale cache.
    function reprobe() {
        if (state.inflight) return state.inflight;
        const job = (async () => {
            const oldReport = readCachedReport();
            try {
                const report = await probeEnvironment(cfg);
                mkdirSync(dir, { recursive: true });
                writeFileSync(jsonPath, JSON.stringify(report, null, 2));
                writeFileSync(mdPath, renderMarkdown(report, cfg, false, state.toolAvailable));
                state.report = report;
                state.stale = false;
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

    // Boot: serve a fresh cache immediately; otherwise probe in background.
    const cached = readCache();
    if (cached && cached.fresh) {
        state.report = cached.report;
    } else {
        if (cached) { state.report = cached.report; state.stale = true; }
        reprobe(); // fire and forget; section provider picks it up on later assemblies
    }

    ctx.systemPrompt.section({
        name: 'env-probe',
        order: cfg.order,
        text: () => {
            // TTL expiry check at assembly time: trigger background refresh.
            if (!state.inflight) {
                try {
                    const mtime = statSync(jsonPath).mtimeMs;
                    if (Date.now() - mtime > cfg.cacheTtlHours * 3600_000) {
                        state.stale = true;
                        reprobe();
                    }
                } catch { /* no cache file yet: boot probe already running */ }
            }
            if (!state.report) {
                return `${cfg.marker}: ${t.noReport}${state.lastError ? ` (${state.lastError})` : ''}`;
            }
            return renderMarkdown(state.report, cfg, state.stale, state.toolAvailable);
        },
    });

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
                handler: async () => {
                    const result = await reprobe();
                    if (!result.ok) return { kind: 'error', text: `${t.cmdProbeFailed}: ${result.error}` };
                    return { kind: 'success', text: refreshReply(result, t) };
                },
            });
        });
    }

    // -----------------------------------------------------------------------
    // env_refresh tool for the model: same blocking refresh, diff-only answer.
    // Registered as a plain registry-ready definition because
    // `ctx.tools.register` validates the shape itself.
    // -----------------------------------------------------------------------
    if (typeof ctx.inject === 'function') {
        ctx.inject(['tools'], (toolCtx) => {
            const tool = {
                name: TOOL_NAME,
                description: `${t.toolDesc}\n${t.toolNoArgs}`,
                parameters: TOOL_PARAMETERS,
                output: {
                    schema: TOOL_OUTPUT_SCHEMA,
                    render: (_args, value) => [{ type: 'text', text: value.summary }],
                },
                timeoutMs: cfg.totalTimeoutMs + 5000,
                async execute() {
                    const result = await reprobe();
                    if (!result.ok) {
                        return { ok: false, probedAt: '', summary: `${t.cmdProbeFailed}: ${result.error}`, error: result.error };
                    }
                    return {
                        ok: true,
                        probedAt: result.report.probedAt,
                        summary: refreshReply(result, t),
                    };
                },
            };
            try {
                toolCtx.tools.register(tool);
                state.toolAvailable = true;
            } catch (e) {
                state.toolAvailable = false;
                warn(`env_refresh tool not registered: ${(e && e.message) || e}`);
            }
        });
    }
}
