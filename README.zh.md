# dsh-env-probe（本机环境探针）

[English](README.md) | 中文

零依赖 DeepSeek Harness 插件：探测一次本机环境（操作系统 / Shell / 运行时 / 常用工具 / 磁盘 / 代理），缓存到磁盘，既可注入系统提示词，也把同一份事实以工具形式交给模型。

> **本仓库是本地分支（v1.4.x）**，基于 [nodata404/dsh-env-probe](https://github.com/nodata404/dsh-env-probe) v1.0.1，改动见下方「相对 1.0.1 的改动」。

## 两种模式

| `injectSection` | 行为 | 提示词开销 |
|---|---|---|
| `true`（默认） | 快照作为系统提示词的一段注入 | 一段固定内容，整个 TTL 内不变 |
| `false` | **纯工具模式**：完全不注入 | 零 |

注入内容在两次探测之间是**冻结**的：标题只写绝对探测时间，不写"16 分钟前"这种相对年龄。相对年龄每分钟都在变，会让系统提示词每轮都被改写，把上游的 prompt cache 每轮打穿——那比这段文字本身贵得多。

## 注入效果（`injectSection: true`）

```
ENV-PROBE: 本机环境快照 (探测于 2026-11-13T21:43:45.862Z)
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

也没有"缓存已过期"标记：过期只会静默后台重探，时间戳本身就说明了新旧。

## 三个入口（两种模式都有）

| 入口 | 面向谁 | 行为 |
|---|---|---|
| `/env-refresh` | 人（斜杠命令，需要命令适配器） | 立即重探、重写缓存，**只回差异**，并把结果注入模型上下文（见下）；已有探测在跑时**阻塞等待** |
| `env_refresh` 工具 | 模型 | 同上，返回结构化 `{ ok, probedAt, summary, added[], removed[], changed[] }` |
| `env_probe` 工具 | 模型 / PTC | 快照的结构化版本（`entries[].path` 等）：缓存在 `cacheTtlHours` 内直接返回，过期或缺失才探测一次；已有探测在跑则等它而不是抢跑 |

## `/env-refresh` 的结果如何进入模型上下文

`dsh-commands` 按设计只在 UI 层执行斜杠命令：命令本身和它的结果都**不会**变成模型消息，所以只返回文本的话，模型对这次刷新一无所知。`/env-refresh` 因此把结果作为「生产者声明的上下文消息」交给接收它的 agent：`source.kind = 'env-probe'`、`form: 'notice'`，带一行不超过 120 字符的摘要。Chat 把它渲染成与 `time-context` 同款的「上下文注入 · env-probe」折叠行，模型在下一个步骤里读到完整差异。

`notifyModel` 决定唤醒策略：

| `notifyModel` | 行为 |
|---|---|
| `'steer'`（默认） | 提交通知并唤醒 agent，模型立即回应这次刷新 |
| `'inject'` | 只提交通知、不唤醒；落到下一次被接纳的步骤里 |
| `'off'` | 只在 UI 显示结果（1.4 之前的行为） |

探测失败时同样注入一条失败通知，避免模型继续相信旧快照。

## 两个工具的用法

两个工具都是结构化输出，PTC（`run_code`）里可直接读路径调工具：

```js
const env = await tools.env_probe({});
const python = env.entries.find((e) => e.name === 'python' && e.available);
// python.path === 'C:\\Users\\...\\python.exe'
```

`env_probe` 的形状：

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

`env_refresh` 的差异返回（同时带一行人类可读 `summary`）：

```
环境快照已刷新 (探测于 2026-11-14T03:40:12.000Z)
+ uv: uv 0.12.23 (C:\...\uv.exe)
~ git: 2.51.0.windows.1 -> 2.52.0.windows.3
- wget
```

结构化部分是 `added: [{name, kind, available, path, version}]`、`removed: [name]`、`changed: [{name, kind: 'version'|'path', from, to}]`。无变化时 `summary` 只有一行"较上次探测无变化"，三个数组为空；探测失败返回 `ok: false` + `error`。

## 配置项

| 键 | 默认值 | 含义 |
|---|---|---|
| `cacheTtlHours` | `24` | 缓存有效期（小时），过期后静默后台重探 |
| `injectSection` | `true` | 是否注册系统提示词段；`false` = 纯工具模式，零提示词开销 |
| `notifyModel` | `'steer'` | `/env-refresh` 结果如何进模型上下文：`'steer'` 注入并唤醒、`'inject'` 只注入不唤醒、`'off'` 仅 UI |
| `order` | `30` | 系统提示词段顺序 |
| `language` | `'en'` | 注入文本语言：`'en'` / `'zh'` |
| `cacheDir` | `'~/.dsh-env-probe'` | 缓存目录（`env-profile.json` + `env-profile.md`） |
| `runtimes` | git, node, npm, python, python3, pip, docker, java, go, rustc | 探测的运行时清单（整体替换默认值） |
| `tools` | curl, wget, ffmpeg, 7z, pandoc, tar, unzip, make, gcc, pwsh | 探测的工具清单（整体替换默认值） |
| `shells` | Windows: pwsh, powershell, cmd, bash；POSIX: bash, zsh, sh, fish, pwsh | 探测的 shell 清单 |
| `versionArgs` | 见下 | 探测版本用的参数表，按名字覆盖或新增；不写则用 `--version` |
| `execAliases` | 见下 | 可执行文件别名表（`名字 -> 候选文件名`），按名字覆盖或新增 |
| `perProbeTimeoutMs` | `5000` | 单项探测超时 |
| `totalTimeoutMs` | `30000` | 整体探测预算 |
| `concurrency` | `4` | 探测并发数 |
| `marker` | `'ENV-PROBE'` | 注入段标记文本 |

`versionArgs` / `execAliases` 内置默认值（配置只覆盖同名项）：

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
    injectSection: true        # false = 只留工具，不注入提示词
    notifyModel: steer         # /env-refresh 结果：steer 唤醒 / inject 只注入 / off 仅 UI
    runtimes: [git, node, npm, pnpm, uv, dotnet, python, pip, java, go, rustc, docker]
    tools: [7z, just, sqlite3, curl, wget, ffmpeg, tar, unzip, make, gcc, pwsh]
    versionArgs:
      '7z': ['-h']          # [] 表示不带参数直接运行
      terraform: ['version']
```

## 相对 1.0.1 的改动

1. **修复 `/env-refresh` 注册失败**：`dsh 0.2.2-rc.1` 的 `dsh-commands` 要求 `input.hint` 非空，旧版传 `''` 导致每次加载都抛 `TypeError: ... input hint must not be empty`。
2. **删除 `/env-suggest`**：它会强制 `agent.steer()` 提交消息并消耗模型 token，行为对用户不透明。
3. **`/env-refresh` 只返回差异**，后台已有探测时**阻塞等待**，不再拿旧缓存当新结果（旧实现探测失败时还会把上一次的报告当成功返回）。
4. **`env_refresh` 工具**：阻塞刷新、只回差异、结构化输出、重写缓存。
5. **`env_probe` 工具**：快照的结构化版本（`entries[].path/version/available`），按 TTL 兜底刷新，用于"要一个可执行文件路径"这种高频需求。
6. **探测命令可配置**：`versionArgs` / `execAliases` / `shells`，不再写死在 JS 里。
7. **标题与前言重写**：去掉"请信任它而不是猜测"，改为陈述"这是快照、可能已过时、与实况不符时以真实命令为准"，并指名 `env_refresh`。
8. **修复 Windows 无扩展名垫片**：`where pnpm` 先命中 npm 写的 POSIX 启动器（无扩展名），`execFile` 无法执行，版本号采集不到；现在优先选同目录的 `.exe/.cmd/.bat`。
9. **差异区分变化类型**：版本变化 `~ 名字: 旧 -> 新`，可执行文件换位置 `~ 名字 (path): 旧 -> 新`。
10. **TTL 默认 24 小时**，删掉"缓存已过期"提示，并新增 `injectSection` 可整体关闭注入。
11. **注入标题不再带相对年龄**：只写绝对探测时间，因此快照不重写时系统提示词逐字节不变（对 prompt cache 友好）。
12. **`/env-refresh` 结果进入模型上下文**：命令不再只在 UI 收尾；handler 把差异作为 `form: 'notice'` 的上下文消息交给 agent，Chat 显示为「上下文注入 · env-probe」，模型能看到刷新结果。新增 `notifyModel`（`steer` / `inject` / `off`）控制唤醒策略，默认 `steer`。

## 插件契约

遵循 dsh 官方插件标准（`docs/user/develop/basic`）：ESM 导出 `apply(ctx, config)`；不再声明硬性 `inject`，提示词段、命令、工具各自通过 `ctx.inject` 挂载，缺哪个服务都只少那一块；`Config["~standard"].validate` 零依赖实现标准 Schema 接口；通过 `ctx.systemPrompt.section()` 注册有序段，`text` 为每次组装时求值的 provider。工具用普通 registry-ready 对象注册（`ctx.tools.register` 自行校验 `output.render` / `output.schema`），因此仍无任何依赖。
