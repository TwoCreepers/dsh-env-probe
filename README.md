# dsh-env-probe

English | [中文](README.zh.md)

Zero-dependency DeepSeek Harness (dsh) plugin: probes the local machine environment (OS / shells / runtimes / tools / disks / proxy) once, caches the report on disk, and injects it as an ordered system-prompt section into every session.

> **v1.1.0 local fork** of [nodata404/dsh-env-probe](https://github.com/nodata404/dsh-env-probe) v1.0.1. Changes are listed under "Changes since 1.0.1".

## What gets injected

```
ENV-PROBE: LOCAL MACHINE ENVIRONMENT SNAPSHOT (probed at 2026-11-13T19:36:08.117Z, 3 h ago)
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

The header carries both the probe time and its relative age, so "this may be stale" is visible at a glance; when the cache has expired the header also says a background re-probe is running.

## Refreshing: `/env-refresh` and the `env_refresh` tool

Both do the same thing, and both **return only the diff** against the previous probe instead of repeating the whole report (the full snapshot is already in the system prompt):

| Entry point | Audience | Notes |
|---|---|---|
| `/env-refresh` | humans | slash command, registered only when a command adapter is composed (e.g. the Web UI); `recordInput: false`, no model tokens |
| `env_refresh` tool | the model | call it after installing/upgrading/removing a tool, or when a path or version in the injected snapshot no longer matches; takes no arguments |

Either one rewrites `env-profile.json` / `env-profile.md` and **blocks** on a probe that is already running (single-flight), so a stale cache is never passed off as a fresh result.

Example answer:

```
Environment snapshot refreshed (probed at 2026-11-14T03:40:12.000Z)
+ uv: uv 0.12.23 (C:\Users\...\.local\bin\uv.exe)
~ git: 2.51.0.windows.1 -> 2.52.0.windows.3
- wget
```

No changes yields a single line: `Environment snapshot refreshed (…): no changes since the previous probe`. A failed probe makes the command return an error and the tool return `{ ok: false, error }`.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `cacheTtlHours` | `168` | cache lifetime; an expired cache triggers a background re-probe at the next assembly |
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
    cacheTtlHours: 24
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
4. **New `env_refresh` tool** for the model: same diff-only, same blocking, same cache rewrite. `ctx.tools.register` validates `output.render` / `output.schema` itself, so this needs no `@deepseek-ai/dsh-tools` import and the plugin stays dependency-free.
5. **Probe commands are configurable**: `versionArgs` / `execAliases` / `shells` instead of hard-coded tables.
6. **Header and intro rewritten**: no more "trust it over assumptions"; it states that this is a snapshot that may be out of date, and names the tool that refreshes it.
7. **Windows extension-less shims fixed**: `where pnpm` matches npm's POSIX launcher first, which `execFile` cannot execute, so no version was reported; a sibling `.exe/.cmd/.bat` is now preferred.
8. **The diff distinguishes kinds of change**: a version bump renders as `~ name: old -> new`, a relocated executable as `~ name (path): old -> new` (previously a path-only change printed two identical version strings).

## Plugin contract

Follows the official dsh plugin standard (`docs/user/develop/basic`): ESM `apply(ctx, config)`; `inject: ['systemPrompt']`; `commands` and `tools` are acquired through `ctx.inject`, so a composition without them keeps the injection half working; `Config["~standard"].validate` implements the standard schema interface with no dependency; the section is registered via `ctx.systemPrompt.section()` with a `text` provider evaluated at every assembly.
