# dsh-env-probe

English | [中文](README.zh.md)

Zero-dependency DeepSeek Harness (dsh) plugin: probes the local machine environment (OS / shells / runtimes / tools / disks / proxy) once at startup, caches the report on disk, and injects it as an ordered section into every session's system prompt — so the agent starts every conversation already knowing what this computer offers instead of guessing commands.

## v1.0.1: slash commands

Registered only when a command adapter is composed (e.g. the Web UI); headless profiles skip them automatically — injection keeps working.

| Command | What it does |
|---|---|
| `/env-refresh` | Forces an immediate re-probe, rewrites the cached profile, replies with a summary plus a diff against the previous probe (`+added` / `-lost` / `~version changed`) |
| `/env-suggest` | Refreshes the profile first, then steers the current session so the agent produces optimization suggestions based on the **freshly injected profile**: purpose & recommended install method for missing runtimes/tools, upgrades for outdated versions, priority-sorted — propose first, never installs anything |

> `/env-suggest` uses the same `agent.steer()` pattern as the official `/plan` command: the command itself costs no model tokens; suggestions arrive as a normal assistant reply.

## Features

- **Generic by design**: no machine-specific endpoints, no local-service checks, every probe item configurable — ready for a public plugin registry
- **Cross-platform**: Windows / Linux / macOS
- **Read-only & safe**: only `where/which`, `--version`, `df`, `Get-CimInstance` style read-only commands; executable names validated against a strict whitelist regex
- **Disk cache + TTL**: default 7-day cache, zero-latency injection; expired cache triggers a silent background re-probe while stale values stay served (marked as such)
- **Graceful degradation**: a failed item is reported as "unavailable", never aborts the run; `.cmd/.bat` shims are executed via `cmd /c`; tunable total budget and concurrency; concurrent refreshes share one probe via single-flight
- **Bilingual**: injected text and command copy support `language: 'en' | 'zh'`

## Install

Add to your profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: env-probe
      name: 'file:///absolute/path/dsh-env-probe/index.js'
      config:
        language: en
        order: 30
        cacheTtlHours: 168
```

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `cacheTtlHours` | `168` | Cache lifetime; re-probes in background on next assembly after expiry |
| `order` | `30` | System-prompt section order (-100 identity / 0 persona / 100-199 tool guidance) |
| `language` | `'en'` | Injected text language: `'en'` / `'zh'` |
| `cacheDir` | `'~/.dsh-env-probe'` | Cache directory (`env-profile.json` + `env-profile.md`) |
| `runtimes` | git, node, npm, python, python3, pip, docker, java, go, rustc | Runtimes to probe |
| `tools` | curl, wget, ffmpeg, 7z, pandoc, tar, unzip, make, gcc, pwsh | Tools to probe |
| `perProbeTimeoutMs` | `5000` | Per-probe timeout |
| `totalTimeoutMs` | `30000` | Total probe budget |
| `concurrency` | `4` | Probe concurrency |
| `marker` | `'ENV-PROBE'` | Section marker text |

## Plugin contract

Follows the official dsh plugin standard (`docs/user/develop/basic`): ESM exporting `apply(ctx, config)`; `inject: ['systemPrompt']`; dependency-free `Config["~standard"].validate` implementing the standard schema interface; contributes an ordered section via `ctx.systemPrompt.section()` whose `text` provider is evaluated at every assembly, keeping the injection fresh as the cache refreshes.
