# dsh-env-probe

English | [中文](README.zh.md)

Zero-dependency DeepSeek Harness (dsh) plugin: probes the local machine environment (OS / shells / runtimes / tools / disks / proxy) once, caches the report on disk, and injects it as an ordered system-prompt section into every session.

> **Local fork (v1.2.x)** of [nodata404/dsh-env-probe](https://github.com/nodata404/dsh-env-probe) v1.0.1. Changes are listed under "Changes since 1.0.1".

## What gets injected

```
ENV-PROBE: LOCAL MACHINE ENVIRONMENT SNAPSHOT (probed at 2026-11-13T20:11:34.319Z, 6 min ago)
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

The header carries the probe time plus its relative age, so "this may be stale" is visible at a glance. There is **no** "cache expired" marker: a cache past its TTL only triggers a silent background re-probe, and the timestamp in the header always tells the truth.

## Three entry points

| Entry point | Audience | Behaviour |
|---|---|---|
| `/env-refresh` | humans (slash command; needs a command adapter) | re-probes, rewrites the cache, returns **only the diff**; blocks on an in-flight probe |
| `env_refresh` tool | the model | same, returning structured `{ ok, probedAt, summary, added[], removed[], changed[] }` |
| `env_probe` tool | the model / PTC | **spawns no probe**: returns the current snapshot as structured data (`entries[].path`, …); waits for a background probe that is already running |

The two tools answer with structured values so a PTC (`run_code`) agent can read a path and call it directly:

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
    { "name": "7z",  "kind": "tool",    "available": true, "path": "C:\\Users\\...\\.local\\bin\\7z.cmd", "version": "7-Zip 25.01 ..." }
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
| `cacheTtlHours` | `1` | cache lifetime; an expired cache only triggers a silent background re-probe |
| `order` | `30` | system-prompt section order |
| `language` | `'en'` | injected text language: `'en'` / `'zh'` |
| `cacheDir` | `'~/.dsh-env-probe'` | cache directory (`env-profile.json` + `env-profile.md`) |
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
    cacheTtlHours: 1
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
4. **`env_refresh` tool**: blocking refresh, diff-only, structured output, rewrites the cache the injected section reads.
5. **`env_probe` tool**: the cached snapshot as structured data (`entries[].path/version/available`), no probe spawned — for the very common "give me an executable path" need.
6. **Probe commands are configurable**: `versionArgs` / `execAliases` / `shells` instead of hard-coded tables.
7. **Header and intro rewritten**: no more "trust it over assumptions"; it states that this is a snapshot that may be out of date, and names the tool that refreshes it.
8. **Windows extension-less shims fixed**: `where pnpm` matches npm's POSIX launcher first, which `execFile` cannot execute, so no version was reported; a sibling `.exe/.cmd/.bat` is now preferred.
9. **The diff distinguishes kinds of change**: a version bump renders as `~ name: old -> new`, a relocated executable as `~ name (path): old -> new`.
10. **TTL defaults to 1 hour** and the "cache expired" notice is gone: an expired cache is re-probed silently in the background, and the timestamp plus relative age already say how old the snapshot is.

## Plugin contract

Follows the official dsh plugin standard (`docs/user/develop/basic`): ESM `apply(ctx, config)`; `inject: ['systemPrompt']`; `commands` and `tools` are acquired through `ctx.inject`, so a composition without them keeps the injection half working; `Config["~standard"].validate` implements the standard schema interface with no dependency; the section is registered via `ctx.systemPrompt.section()` with a `text` provider evaluated at every assembly. Tools are plain registry-ready objects (`ctx.tools.register` validates `output.render` / `output.schema` itself), so the plugin still has zero dependencies.
