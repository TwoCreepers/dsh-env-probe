// dsh-env-probe (v1.0.1)
// Zero-dependency DeepSeek Harness (dsh) plugin: probe the local machine
// environment once, cache the report on disk, and inject it into every
// session's system prompt so the agent does not have to guess what this
// computer offers (OS, shells, runtimes, tools, disks, proxy).
//
// v1.0.1 adds two optional slash commands (registered only when the
// `commands` service is composed, e.g. the Web UI; headless profiles keep
// working without them):
//   /env-refresh — force a re-probe now, rewrite the cache, and reply with
//                  a summary plus a diff against the previous report
//   /env-suggest — refresh first, then steer the agent to produce
//                  environment optimization suggestions based on the
//                  freshly injected profile (same pattern as /plan)
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
//   - ctx.systemPrompt.section({ name, order, text }) contributes an ordered
//     system-prompt section; `text` may be a provider evaluated at every
//     assembly, which is how the injected report stays fresh.
//   - Order ranges: -100 harness identity, 0 deployment persona,
//     100-199 tool guidance. This plugin defaults to 30 (environment layer).
//
// Config (via cordis.patch.yml):
//   - insert:
//       - id: env-probe
//         name: 'file:///absolute/path/to/dsh-env-probe/index.js'
//         config:
//           cacheTtlHours: 168        # re-probe when the cache is older
//           order: 30                 # systemPrompt section order
//           language: 'en'            # section text language: 'en' | 'zh'
//           cacheDir: '~/.dsh-env-probe'
//           runtimes: ['git','node','python']   # override the default list
//           tools: ['curl','ffmpeg']            # override the default list
//           perProbeTimeoutMs: 5000
//           totalTimeoutMs: 30000
//           concurrency: 4
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { arch, cpus, homedir, platform, release, totalmem, type as osType, version as osVersion } from 'node:os';
import { join, resolve } from 'node:path';

export const name = 'dsh-env-probe';
export const inject = ['systemPrompt'];

const IS_WIN = platform() === 'win32';

const DEFAULT_RUNTIMES = ['git', 'node', 'npm', 'python', 'python3', 'pip', 'docker', 'java', 'go', 'rustc'];
const DEFAULT_TOOLS = ['curl', 'wget', 'ffmpeg', '7z', 'pandoc', 'tar', 'unzip', 'make', 'gcc', 'pwsh'];

// Version-flag overrides; everything else is probed with `--version`.
const VERSION_ARGS = { java: ['-version'], go: ['version'], '7z': ['-h'], tar: ['--version'], unzip: ['-v'] };
// Alias resolution: tool name -> candidate executable names.
const EXEC_ALIASES = {
    '7z': ['7z', '7za', '7zr'],
    python: IS_WIN ? ['python', 'py'] : ['python'],
    npm: IS_WIN ? ['npm.cmd', 'npm'] : ['npm'],
};

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/;

const DEFAULTS = {
    cacheTtlHours: 168,
    order: 30,
    language: 'en',
    cacheDir: '~/.dsh-env-probe',
    runtimes: DEFAULT_RUNTIMES,
    tools: DEFAULT_TOOLS,
    perProbeTimeoutMs: 5000,
    totalTimeoutMs: 30000,
    concurrency: 4,
    marker: 'ENV-PROBE',
};

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
            for (const key of ['runtimes', 'tools']) {
                if (input[key] !== undefined) {
                    if (!Array.isArray(input[key]) || input[key].some(v => typeof v !== 'string' || !NAME_RE.test(v))) {
                        issues.push({ message: `${key} must be an array of safe executable names`, path: [key] });
                    }
                }
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

async function probeExecutable(name, perTimeoutMs) {
    const candidates = EXEC_ALIASES[name] || [name];
    let pathFound = null, resolved = name;
    for (const c of candidates) {
        pathFound = await which(c, perTimeoutMs);
        if (pathFound) { resolved = c; break; }
    }
    if (!pathFound) return { name, available: false };
    const args = VERSION_ARGS[name] || ['--version'];
    // .cmd/.bat shims need cmd.exe as interpreter on modern Node.
    const viaCmd = IS_WIN && /\.(cmd|bat)$/i.test(resolved);
    const v = viaCmd ? await run('cmd', ['/c', resolved, ...args], perTimeoutMs)
                     : await run(resolved, args, perTimeoutMs);
    const ver = firstLine(v.out).slice(0, 120);
    return { name, available: true, path: pathFound, version: ver || undefined };
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

async function probeShells(perTimeoutMs) {
    const shells = IS_WIN ? ['pwsh', 'powershell', 'cmd', 'bash'] : ['bash', 'zsh', 'sh', 'fish', 'pwsh'];
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
    const deadline = Date.now() + cfg.totalTimeoutMs;
    const withBudget = async (label, fn, fallback) => {
        if (Date.now() > deadline) return fallback;
        try { return await fn(); } catch { return fallback; }
    };
    const [osInfo, shells, runtimes, tools, disks] = await Promise.all([
        withBudget('os', () => probeOs(per), {}),
        withBudget('shells', () => probeShells(per), { current: 'unknown', available: [] }),
        withBudget('runtimes', () => pool(cfg.runtimes, conc, n => probeExecutable(n, per)), []),
        withBudget('tools', () => pool(cfg.tools, conc, n => probeExecutable(n, per)), []),
        withBudget('disks', () => probeDisks(per), []),
    ]);
    return {
        probedAt: new Date().toISOString(),
        os: osInfo,
        shells,
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
        title: 'LOCAL MACHINE ENVIRONMENT PROFILE',
        intro: 'The following is an automatically probed profile of the machine this agent runs on. Trust it over assumptions: use the listed runtimes/tools and their paths directly, and do NOT attempt commands whose executables are listed as unavailable. Prefer probing alternatives before installing anything.',
        os: 'Operating System', shells: 'Shells', runtimes: 'Runtimes', tools: 'Tools',
        disks: 'Disks', proxy: 'Proxy Environment', none: 'none detected',
        current: 'current', probedAt: 'probed at', unavailable: 'unavailable',
        stale: '(re-probe in progress; values may be stale)',
        cmdRefreshDesc: 're-probe the local environment and update the injected profile',
        cmdSuggestDesc: 'refresh the profile, then ask the agent for environment optimization suggestions',
        cmdRefreshed: 'Environment profile refreshed',
        cmdProbeFailed: 'environment probe failed',
        changes: 'changes since last probe',
        noChanges: 'no changes since last probe',
        cmdSuggestQueued: 'Profile refreshed. Asking the agent for optimization suggestions based on the latest profile…',
        cmdSuggestNoAgent: '(No agent attached to this command; ask the agent directly for optimization suggestions.)',
        suggestPrompt: 'Based on the LOCAL MACHINE ENVIRONMENT PROFILE (ENV-PROBE) freshly injected into your system prompt, give optimization suggestions for this computer: 1) list missing but commonly useful runtimes/tools (the items marked unavailable), with their purpose and the recommended install method for this OS; 2) flag outdated versions worth upgrading; 3) output a priority-sorted table, conclusion first. Do NOT install anything — propose first and wait for my confirmation.',
    },
    zh: {
        title: '本机环境档案',
        intro: '以下是自动探测生成的本机环境档案。请信任它而不是猜测：直接使用列出的运行时/工具及其路径，不要尝试调用标记为不可用的程序。如需安装新软件，先向用户确认。',
        os: '操作系统', shells: 'Shell', runtimes: '运行时', tools: '工具',
        disks: '磁盘', proxy: '代理环境变量', none: '未检测到',
        current: '当前', probedAt: '探测时间', unavailable: '不可用',
        stale: '（正在重新探测，以下值可能过期）',
        cmdRefreshDesc: '重新探测本机环境并更新注入的环境档案',
        cmdSuggestDesc: '刷新环境档案后，让助手基于最新档案给出环境优化建议',
        cmdRefreshed: '环境档案已刷新',
        cmdProbeFailed: '环境探测失败',
        changes: '较上次探测的变化',
        noChanges: '较上次探测无变化',
        cmdSuggestQueued: '档案已刷新，正在让助手基于最新档案给出优化建议……',
        cmdSuggestNoAgent: '（该命令未绑定会话，请直接向助手索要优化建议。）',
        suggestPrompt: '请基于系统提示词中最新注入的本机环境档案（ENV-PROBE），给出这台电脑的环境优化建议：1) 指出缺失但对开发/日常使用常见且重要的运行时与工具（档案中标记为不可用的项），说明各自用途并给出适合当前系统的推荐安装方式；2) 指出版本过旧、值得升级的项；3) 按优先级排序输出表格，先结论后细节。不要执行任何安装操作，先给建议并等待我确认。',
    },
};

function renderMarkdown(report, cfg, stale) {
    const t = L[cfg.language] || L.en;
    const lines = [`${cfg.marker}: ${t.title} (${t.probedAt}: ${report.probedAt})${stale ? ' ' + t.stale : ''}`, t.intro, ''];
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
// Plugin entry
// ---------------------------------------------------------------------------

// Compare two cached reports on runtimes/tools availability & versions.
function diffReports(oldReport, newReport) {
    const changes = [];
    if (!oldReport) return null;
    for (const key of ['runtimes', 'tools']) {
        const oldMap = new Map((oldReport[key] || []).map(i => [i.name, i]));
        for (const item of newReport[key] || []) {
            const prev = oldMap.get(item.name);
            if (prev && !prev.available && item.available) changes.push(`+${item.name}`);
            else if (prev && prev.available && !item.available) changes.push(`-${item.name}`);
            else if (prev && prev.available && item.available && (prev.version || '') !== (item.version || '')) changes.push(`~${item.name}`);
        }
        const newMap = new Set((newReport[key] || []).map(i => i.name));
        for (const [nm, prev] of oldMap) {
            if (!newMap.has(nm) && prev.available) changes.push(`-${nm}`);
        }
    }
    return changes;
}

export function apply(ctx, config) {
    const cfg = { ...DEFAULTS, ...(config ?? {}) };
    const dir = resolve(expandHome(cfg.cacheDir));
    const jsonPath = join(dir, 'env-profile.json');

    // Live state served by the section provider (evaluated at each assembly).
    const state = { report: null, stale: false, inflight: null, lastError: null };

    function readCache() {
        try {
            const report = JSON.parse(readFileSync(jsonPath, 'utf-8'));
            const mtime = statSync(jsonPath).mtimeMs;
            const fresh = (Date.now() - mtime) < cfg.cacheTtlHours * 3600_000;
            return { report, fresh };
        } catch { return null; }
    }

    // Single-flight re-probe: concurrent callers (boot, TTL check, /env-refresh,
    // /env-suggest) share one in-flight run; resolves to the fresh report.
    function reprobe() {
        if (state.inflight) return state.inflight;
        state.inflight = (async () => {
            let oldReport = null;
            try { oldReport = JSON.parse(readFileSync(jsonPath, 'utf-8')); } catch { /* first run */ }
            let report;
            try {
                report = await probeEnvironment(cfg);
                mkdirSync(dir, { recursive: true });
                writeFileSync(jsonPath, JSON.stringify(report, null, 2));
                writeFileSync(join(dir, 'env-profile.md'), renderMarkdown(report, cfg, false));
                state.report = report;
                state.stale = false;
                state.lastError = null;
                report.changes = diffReports(oldReport, report);
            } catch (e) {
                state.lastError = e && e.message;
            }
            return state.report;
        })();
        const done = state.inflight.finally(() => { state.inflight = null; });
        state.inflight = done;
        return done;
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
                return `${cfg.marker}: environment probe in progress or failed${state.lastError ? ` (${state.lastError})` : ''}. Assume a generic ${IS_WIN ? 'Windows' : 'POSIX'} environment and verify before use.`;
            }
            return renderMarkdown(state.report, cfg, state.stale);
        },
    });

    // -----------------------------------------------------------------------
    // Optional slash commands (v1.0.1): registered only when the `commands`
    // service is composed (Web UI). Headless profiles simply skip this — the
    // section injection above keeps working unchanged.
    // -----------------------------------------------------------------------
    if (typeof ctx.inject === 'function') {
        ctx.inject(['commands'], (commandCtx) => {
            const t = L[cfg.language] || L.en;
            const summarize = (report) => {
                if (!report) return t.cmdProbeFailed + (state.lastError ? ` (${state.lastError})` : '');
                const rt = (report.runtimes || []).filter(i => i.available).length;
                const rtAll = (report.runtimes || []).length;
                const tl = (report.tools || []).filter(i => i.available).length;
                const tlAll = (report.tools || []).length;
                const lines = [
                    `${t.cmdRefreshed}: ${report.probedAt}`,
                    `${report.os?.pretty || report.os?.type || '?'} | ${report.os?.arch || '?'} | CPU: ${report.os?.cpus ?? '?'} | RAM: ${report.os?.totalMemGB ?? '?'} GB`,
                    `${t.runtimes}: ${rt}/${rtAll} | ${t.tools}: ${tl}/${tlAll}`,
                ];
                if (report.changes && report.changes.length) lines.push(`${t.changes}: ${report.changes.join(', ')}`);
                else if (report.changes) lines.push(t.noChanges);
                return lines.join('\n');
            };

            commandCtx.commands.register({
                name: 'env-refresh',
                description: t.cmdRefreshDesc,
                input: { hint: '' },
                recordInput: false,
                handler: async () => {
                    const report = await reprobe();
                    return report
                        ? { kind: 'success', text: summarize(report) }
                        : { kind: 'error', text: t.cmdProbeFailed + (state.lastError ? ` (${state.lastError})` : '') };
                },
            });

            commandCtx.commands.register({
                name: 'env-suggest',
                description: t.cmdSuggestDesc,
                input: { hint: '' },
                recordInput: false,
                handler: async ({ agent }) => {
                    const report = await reprobe();
                    if (!report) return { kind: 'error', text: t.cmdProbeFailed + (state.lastError ? ` (${state.lastError})` : '') };
                    if (agent && typeof agent.steer === 'function') {
                        try {
                            // Same pattern as the official /plan command: submit a
                            // user message; the reply streams as a normal assistant
                            // answer with the freshly re-assembled prompt.
                            agent.steer({
                                id: crypto.randomUUID(),
                                role: 'user',
                                content: [{ type: 'text', text: t.suggestPrompt }],
                                source: { kind: 'user' },
                            });
                            return { kind: 'success', text: t.cmdSuggestQueued };
                        } catch (e) {
                            return { kind: 'error', text: `steer failed: ${e && e.message}` };
                        }
                    }
                    return { kind: 'success', text: summarize(report) + '\n' + t.cmdSuggestNoAgent };
                },
            });
        });
    }
}
