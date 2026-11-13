# dsh-env-probe（本机环境探针）

[English](README.md) | 中文

零依赖 DeepSeek Harness 插件：启动时探测一次本机环境（操作系统 / Shell / 运行时 / 常用工具 / 磁盘 / 代理），把结果缓存到磁盘，并作为有序段注入每个会话的系统提示词。

> **本仓库是 v1.1.0 本地分支**，基于 [nodata404/dsh-env-probe](https://github.com/nodata404/dsh-env-probe) v1.0.1，改动见下方「相对 1.0.1 的改动」。

## 注入效果（示例）

```
ENV-PROBE: 本机环境快照 (探测于 2026-11-13T19:36:08.117Z, 3 小时前)
这份快照只描述探测时刻的状态。探测之后安装、升级、删除或改动 PATH 的运行时与工具都不会反映在这里，所以它可能已经过时。
清单里的路径或版本与机器实际情况不符时，以真实命令的输出为准，并调用 `env_refresh` 工具重新探测。
标记为未探测到的项，只表示探测时 PATH 上找不到它。

## 操作系统
- Microsoft Windows 11 Home China | x64 | CPU: 12 | RAM: 15.7 GB
## 运行时
- git: git version 2.51.0.windows.1 (C:\Program Files\Git\cmd\git.exe)
- go: 未探测到
……
```

标题带探测时间和相对年龄（`3 小时前`），让"这份东西可能已经过时"一眼可见；缓存过期时标题后追加一句"正在后台重探"。

## 刷新：`/env-refresh` 与 `env_refresh` 工具

两者做同一件事，都**只返回与上次探测的差异**，不重述全量档案（全量快照本来就已经在系统提示词里了）：

| 入口 | 面向谁 | 说明 |
|---|---|---|
| `/env-refresh` | 人 | 斜杠命令，仅在组合了命令适配器（如 Web UI）时注册；`recordInput: false`，不消耗模型 token |
| `env_refresh` 工具 | 模型 | 安装/升级/卸载工具后，或注入的路径/版本与实际不符时调用；无参数 |

两者都会重写 `env-profile.json` / `env-profile.md`，并**阻塞等待**已在进行的后台探测（单飞共享同一个探测），绝不拿过期缓存冒充结果。

返回示例：

```
环境快照已刷新 (探测于 2026-11-14T03:40:12.000Z)
+ uv: uv 0.12.23 (C:\Users\...\.local\bin\uv.exe)
+ sqlite3: 3.50.4 ... (C:\Users\...\Programs\sqlite3\sqlite3.exe)
~ git: 2.51.0.windows.1 -> 2.52.0.windows.3
- wget
```

无变化时只有一行：`环境快照已刷新 (…): 较上次探测无变化`。探测失败时命令返回 error，工具返回 `{ ok: false, error }`。

## 配置项

| 键 | 默认值 | 含义 |
|---|---|---|
| `cacheTtlHours` | `168` | 缓存有效期（小时），过期后在下次组装时后台重探 |
| `order` | `30` | 系统提示词段顺序 |
| `language` | `'en'` | 注入文本语言：`'en'` / `'zh'` |
| `cacheDir` | `'~/.dsh-env-probe'` | 缓存目录（`env-profile.json` + `env-profile.md`） |
| `runtimes` | git, node, npm, python, python3, pip, docker, java, go, rustc | 探测的运行时清单（整体替换默认值） |
| `tools` | curl, wget, ffmpeg, 7z, pandoc, tar, unzip, make, gcc, pwsh | 探测的工具清单（整体替换默认值） |
| `shells` | Windows: pwsh, powershell, cmd, bash；POSIX: bash, zsh, sh, fish, pwsh | 探测的 shell 清单 |
| `versionArgs` | 见下 | 探测版本用的参数表，**按名字覆盖或新增**，不写则用 `--version` |
| `execAliases` | 见下 | 可执行文件别名表（`名字 -> 候选文件名`），按名字覆盖或新增 |
| `perProbeTimeoutMs` | `5000` | 单项探测超时 |
| `totalTimeoutMs` | `30000` | 整体探测预算 |
| `concurrency` | `4` | 探测并发数 |
| `marker` | `'ENV-PROBE'` | 注入段标记文本 |

`versionArgs` / `execAliases` 内置默认值（配置只覆盖同名项，不影响其余）：

```js
versionArgs  = { java: ['-version'], go: ['version'], '7z': ['-h'], tar: ['--version'], unzip: ['-v'] }
execAliases  = {
  '7z': ['7z', '7za', '7zr'],
  python: ['python', 'py'],      // Windows
  npm: ['npm.cmd', 'npm'],       // Windows
  pnpm: ['pnpm.cmd', 'pnpm'],    // Windows
}
```

配置示例（profile 的 `cordis.patch.yml`）：

```yaml
- id: env-probe
  name: dsh-env-probe
  config:
    language: zh
    cacheTtlHours: 24
    runtimes: [git, node, npm, pnpm, uv, dotnet, python, pip, java, go, rustc, docker]
    tools: [7z, just, sqlite3, curl, wget, ffmpeg, tar, unzip, make, gcc, pwsh]
    versionArgs:
      '7z': ['-h']          # [] 表示不带参数直接运行
      terraform: ['version']
```

## 相对 1.0.1 的改动

1. **修复 `/env-refresh` 注册失败**：`dsh 0.2.2-rc.1` 的 `dsh-commands` 要求 `input.hint` 非空，旧版传 `''` 导致命令每次加载都抛 `TypeError: ... input hint must not be empty`。
2. **删除 `/env-suggest`**：它会强制 `agent.steer()` 提交一条消息并消耗模型 token，行为对用户不透明。
3. **`/env-refresh` 只返回差异**，不再把全量档案再念一遍；后台已有探测时**阻塞等待**其结果，不再拿旧缓存当新结果返回（旧实现探测失败时会把上一次的报告当成功返回）。
4. **新增 `env_refresh` 工具**（给模型用）：同样只返回差异、同样阻塞、同样重写缓存；`ctx.tools.register` 只校验 `output.render` 与 `output.schema`，因此不需要依赖 `@deepseek-ai/dsh-tools`，仍然是零依赖。
5. **探测命令可配置**：`versionArgs` / `execAliases` / `shells`，不再写死在 JS 里。
6. **标题与前言重写**：去掉"请信任它而不是猜测"这类说服，改为陈述"这是快照、可能已过时、与实况不符时以真实命令为准"，并指名 `env_refresh`。
7. **修复 Windows 上的无扩展名垫片**：`where pnpm` 先命中 npm 写的 POSIX 启动器（无扩展名），`execFile` 无法执行，导致版本号采集不到；现在会优先选同目录的 `.exe/.cmd/.bat`。
8. **差异区分变化类型**：版本变化渲染成 `~ 名字: 旧 -> 新`，可执行文件换位置渲染成 `~ 名字 (path): 旧 -> 新`（此前纯路径变化会打印两个相同的版本串）。

## 插件契约

遵循 dsh 官方插件标准（`docs/user/develop/basic`）：ESM 导出 `apply(ctx, config)`；`inject: ['systemPrompt']`；`commands` 与 `tools` 通过 `ctx.inject` 按需获取（缺失时注入部分照常工作）；`Config["~standard"].validate` 零依赖实现标准 Schema 接口；通过 `ctx.systemPrompt.section()` 注册有序段，`text` 为每次组装时求值的 provider。
