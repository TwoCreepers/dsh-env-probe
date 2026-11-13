# dsh-env-probe

English | [中文](README.zh.md)

Zero-dependency DeepSeek Harness (dsh) plugin: probes the local machine environment (OS / shells / runtimes / tools / disks / proxy) once, caches the report on disk, exposes the same facts to the model as tools, and optionally injects it as an ordered system-prompt section.

> **Local fork (v1.4.x)** of [nodata404/dsh-env-probe](https://github.com/nodata404/dsh-env-probe) v1.0.1. Changes are listed under "Changes since 1.0.1".

## Two modes

| `injectSection` | What happens | Prompt cost |
|---|---|---|
| `false` (default) | **tool-only**: nothing is ever injected | zero |
| `true` | the snapshot is injected as a system-prompt section | a fixed block, stable for the whole TTL |

Tool-only is the default: the model reads what it needs through `env_probe` / `env_refresh`, the system prompt stays byte-identical, and a fact refresh cannot bust the provider's prompt cache. Turn `injectSection` on only when every turn genuinely needs the snapshot in the prompt.

Injected text is deliberately *frozen* between probes: the header carries only the absolute probe time, never a relative "16 min ago". A ticking suffix would rewrite the system prompt every minute, invalidating the provider's prompt cache on every turn — which costs far more than the section itself.

## What gets injected (`injectSection: true`)

```
ENV-PROBE: LOCAL MACHINE ENVIRONMENT SNAPSHOT (probed at 2026-11-13T21:43:45.862Z)
This snapshot describes the machine only as it was at the time above. Runtimes and tools installed, upgraded, removed or moved on PATH afterwards are not reflected here, so it may already be out of date.
When a listed path or version disagrees with what the machine actually does, trust the real command and call the `env_refresh` tool to probe again.
An entry marked unavailable only means the executable was not found on PATH when the probe ran.

## Operating System
- Microsoft Windows 11 Home China | x64 | CPU: 12 | RAM: 15.7 GB
## Runtimes
- git: git version 2.51.0.windows.1 (C:\Program Files\Git\cmd\git.exe)
- go: unavailable
...
```

There is no "cache expired" marker either: an expired cache only triggers a silent background re-probe, and the timestamp says how old the snapshot is.

## Three entry points (both modes)

| Entry point | Audience | Behaviour |
|---|---|---|
| `/env-refresh` | humans (slash command; needs a command adapter) | re-probes, rewrites the cache, returns **only the diff**, and injects the outcome into the model's context (see below); blocks on an in-flight probe |
| `env_refresh` tool | the model | same, returning structured `{ ok, probedAt, summary, added[], removed[], changed[] }` |
| `env_probe` tool | the model / PTC | the snapshot as structured data (`entries[].path`, …); serves a cache younger than `cacheTtlHours` as-is, otherwise probes once; waits for an in-flight probe instead of racing it |

## How `/env-refresh` reaches the model

`dsh-commands` runs a slash command in the UI plane by design: neither the command nor its result ever becomes a model message, so a text-only result leaves the model blind to the refresh. `/env-refresh` therefore hands its outcome to the receiving agent as a producer-supplied context message (`source.kind = 'env-probe'`, `form: 'notice'`, with a one-line summary bounded to 120 characters). The Chat renders it as the same collapsed "Context injection · env-probe" row `time-context` uses, and the model reads the full diff in its next step.

`notifyModel` picks the wake policy:

| `notifyModel` | Behaviour |
|---|---|
| `'inject'` (default) | submit the notice only; it lands in the next accepted step without waking an idle agent |
| `'steer'` | submit the notice and wake the agent, so it answers the refresh right away |
| `'off'` | UI-only result, the pre-1.4 behaviour |

A failed probe injects a failure notice instead, so the model stops trusting the old snapshot.

## Using the two tools

They answer with structured values so a PTC (`run_code`) agent can read a path and call it directly:

```js
const env = await tools.env_probe({});
const python = env.entries.find((e) => e.name === 'python' && e.available);
// python.path === 'C:\\Users\\...\\python.exe'
```

`env_probe` shape:

```jsonc
{
  "ok": true,
  "probedAt": "2026-11-13T20:17:45.405Z",
  "ageSeconds": 0,
  "os": { "name": "Microsoft Windows 11 Home China", "arch": "x64", "cpus": 12, "memoryGB": 15.7 },
  "shell": { "current": "C:\\WINDOWS\\system32\\cmd.exe", "available": ["pwsh", "powershell", "cmd"] },
  "entries": [
    { "name": "git", "kind": "runtime", "available": true, "path": "C:\\Program Files\\Git\\cmd\\git.exe", "version": "git version 2.51.0.windows.1" },
    { "name": "7z",  "kind": "tool",    "available": true, "path": "C:\\Program Files\\7-Zip\\7z.exe", "version": "7-Zip 25.01 ..." }
  ],
  "disks": ["C: 22.5/466 GB free"],
  "proxy": []
}
```

`env_refresh` diff answer (with a one-line human-readable `summary`):

```
Environment snapshot refreshed (probed at 2026-11-14T03:40:12.000Z)
+ uv: uv 0.12.23 (C:\...\uv.exe)
~ git: 2.51.0.windows.1 -> 2.52.0.windows.3
- wget
```

Structured part: `added: [{name, kind, available, path, version}]`, `removed: [name]`, `changed: [{name, kind: 'version'|'path', from, to}]`. With no changes, `summary` is the single line `no changes since the previous probe` and the three arrays are empty; a failed probe returns `ok: false` plus `error`.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `cacheTtlHours` | `24` | cache lifetime; an expired cache only triggers a silent background re-probe |
| `injectSection` | `false` | register the system-prompt section; default `false` = tool-only, zero prompt cost |
| `notifyModel` | `'inject'` | how `/env-refresh` reaches the model: `'inject'` inject only, `'steer'` inject and wake, `'off'` UI only |
| `order` | `30` | system-prompt section order |
| `language` | `'en'` | injected text language: `'en'` / `'zh'` |
| `cacheDir` | `'~/.dsh/cache/dsh-env-probe'` | cache directory (`env-profile.json` + `env-profile.md`) |
| `runtimes` | git, node, npm, python, python3, pip, docker, java, go, rustc | probed runtimes (replaces the default list) |
| `tools` | curl, wget, ffmpeg, 7z, pandoc, tar, unzip, make, gcc, pwsh | probed tools (replaces the default list) |
| `shells` | Windows: pwsh, powershell, cmd, bash; POSIX: bash, zsh, sh, fish, pwsh | probed shells |
| `versionArgs` | see below | argv used to read a version, **merged by name**; unlisted names use `--version` |
| `execAliases` | see below | `name -> candidate executables`, merged by name |
| `perProbeTimeoutMs` | `5000` | per-item timeout |
| `totalTimeoutMs` | `30000` | whole-probe budget |
| `concurrency` | `4` | probe concurrency |
| `marker` | `'ENV-PROBE'` | injected section marker |

Built-in `versionArgs` / `execAliases` (config only overrides the names it mentions):

```js
versionArgs = { java: ['-version'], go: ['version'], '7z': ['-h'], tar: ['--version'], unzip: ['-v'] }
execAliases = {
  '7z': ['7z', '7za', '7zr'],
  python: ['python', 'py'],      // Windows
  npm: ['npm.cmd', 'npm'],       // Windows
  pnpm: ['pnpm.cmd', 'pnpm'],    // Windows
}
```

Example (profile `cordis.patch.yml`):

```yaml
- id: env-probe
  name: dsh-env-probe
  config:
    language: en
    cacheTtlHours: 24
    injectSection: false       # default tool-only; true = also inject a prompt section
    notifyModel: inject        # /env-refresh result: inject only queues, steer wakes, off is UI-only
    runtimes: [git, node, npm, pnpm, uv, dotnet, python, pip, java, go, rustc, docker]
    tools: [7z, just, sqlite3, curl, wget, ffmpeg, tar, unzip, make, gcc, pwsh]
    versionArgs:
      terraform: ['version']
      '7z': ['-h']        # [] runs the executable bare
```

## Changes since 1.0.1

1. **`/env-refresh` registers again**: `dsh 0.2.2-rc.1`'s `dsh-commands` requires a non-empty `input.hint`; the old `hint: ''` made every load throw `TypeError: ... input hint must not be empty`.
2. **`/env-suggest` removed**: it force-submitted an `agent.steer()` message and silently spent model tokens.
3. **`/env-refresh` returns the diff only** and blocks on an in-flight probe instead of answering from the older cache (the old code even returned the previous report as a success when a probe failed).
4. **`env_refresh` tool**: blocking refresh, diff-only, structured output, rewrites the cache.
5. **`env_probe` tool**: the snapshot as structured data (`entries[].path/version/available`), TTL-bounded, for the very common "give me an executable path" need.
6. **Probe commands are configurable**: `versionArgs` / `execAliases` / `shells` instead of hard-coded tables.
7. **Header and intro rewritten**: no more "trust it over assumptions"; it states that this is a snapshot that may be out of date, and names the tool that refreshes it.
8. **Windows extension-less shims fixed**: `where pnpm` matches npm's POSIX launcher first, which `execFile` cannot execute, so no version was reported; a sibling `.exe/.cmd/.bat` is now preferred.
9. **The diff distinguishes kinds of change**: a version bump renders as `~ name: old -> new`, a relocated executable as `~ name (path): old -> new`.
10. **TTL defaults to 24 hours**, the "cache expired" notice is gone, and `injectSection` can turn injection off entirely.
11. **No relative age in the injected header**: only the absolute probe time, so the system prompt stays byte-identical until the snapshot is actually rewritten (prompt-cache friendly).
12. **`/env-refresh` now reaches the model**: the handler hands the diff to the agent as a `form: 'notice'` context message, so the Chat shows "Context injection · env-probe" and the model sees the result. `notifyModel` (`inject` / `steer` / `off`) picks the wake policy; the default is `inject`.
13. **Tool-only by default**: `injectSection` now defaults to `false`, `notifyModel` to `inject`, and the cache moved to `~/.dsh/cache/dsh-env-probe` alongside the other harness caches. The default configuration touches neither the system prompt nor the model's wake state.

## Plugin contract

Follows the official dsh plugin standard (`docs/user/develop/basic`): ESM `apply(ctx, config)`; no hard `inject` list — the section, the command and the tools are each attached through `ctx.inject`, so a composition missing any one of those services still gets the rest; `Config["~standard"].validate` implements the standard schema interface with no dependency; the section is registered via `ctx.systemPrompt.section()` with a `text` provider evaluated at every assembly. Tools are plain registry-ready objects (`ctx.tools.register` validates `output.render` / `output.schema` itself), so the plugin still has zero dependencies.
