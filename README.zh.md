# dsh-env-probe（本机环境探针）

[English](README.md) | 中文

零依赖 DeepSeek Harness 插件：启动时探测一次本机环境（操作系统 / Shell / 运行时 / 常用工具 / 磁盘 / 代理），把结果缓存到磁盘，并作为有序段注入每个会话的系统提示词。

> **本仓库是本地分支（v1.2.x）**，基于 [nodata404/dsh-env-probe](https://github.com/nodata404/dsh-env-probe) v1.0.1，改动见下方「相对 1.0.1 的改动」。

## 注入效果（示例）

```
ENV-PROBE: 本机环境快照 (探测于 2026-11-13T20:11:34.319Z, 6 分钟前)
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

标题带探测时间和相对年龄（`6 分钟前`），"可能过时"一眼可见。**没有**"缓存已过期"之类的标记：缓存超过 TTL 只会静默地在后台重探，标题里的时间永远是真相。

## 三个入口

| 入口 | 面向谁 | 行为 |
|---|---|---|
| `/env-refresh` | 人（斜杠命令，需要命令适配器） | 立即重探、重写缓存，**只回差异**；已有探测在跑时**阻塞等待** |
| `env_refresh` 工具 | 模型 | 同上，返回结构化 `{ ok, probedAt, summary, added[], removed[], changed[] }` |
| `env_probe` 工具 | 模型 / PTC | **不触发探测**，直接把当前快照以结构化数据返回（`entries[].path` 等）；若后台正在探测则等待其完成 |

后两个都是结构化输出，方便 PTC（`run_code`）里直接读路径调工具：

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
    { "name": "7z",  "kind": "tool",    "available": true, "path": "C:\\Users\\...\\.local\\bin\\7z.cmd", "version": "7-Zip 25.01 ..." }
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

结构化部分是 `added: [{name, kind, available, path, version}]`、`removed: [name]`、`changed: [{name, kind: 'version'|'path', from, to}]`。无变化时 `summary` 只有一行 `较上次探测无变化`，三个数组为空；探测失败返回 `ok: false` + `error`。

## 配置项

| 键 | 默认值 | 含义 |
|---|---|---|
| `cacheTtlHours` | `1` | 缓存有效期（小时），过期后下次组装时静默后台重探 |
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
    cacheTtlHours: 1
    runtimes: [git, node, npm, pnpm, uv, dotnet, python, pip, java, go, rustc, docker]
    tools: [7z, just, sqlite3, curl, wget, ffmpeg, tar, unzip, make, gcc, pwsh]
    versionArgs:
      '7z': ['-h']          # [] 表示不带参数直接运行
      terraform: ['version']
```

## 相对 1.0.1 的改动

1. **修复 `/env-refresh` 注册失败**：`dsh 0.2.2-rc.1` 的 `dsh-commands` 要求 `input.hint` 非空，旧版传 `''` 导致每次加载都抛 `TypeError: ... input hint must not be empty`。
2. **删除 `/env-suggest`**：它会强制 `agent.steer()` 提交消息并消耗模型 token，行为对用户不透明。
3. **`/env-refresh` 只返回差异**，不再复述全量档案；后台已有探测时**阻塞等待**，不再拿旧缓存当新结果（旧实现探测失败时还会把上一次的报告当成功返回）。
4. **`env_refresh` 工具**：同样的阻塞刷新、同样的差异返回，并重写注入用的缓存；输出是结构化的，PTC 可直接读。
5. **`env_probe` 工具**：直接返回缓存快照的结构化版本（`entries[].path/version/available`），**不触发探测**，用于"我要一个可执行文件路径"这种高频需求。
6. **探测命令可配置**：`versionArgs` / `execAliases` / `shells`，不再写死在 JS 里。
7. **标题与前言重写**：去掉"请信任它而不是猜测"，改为陈述"这是快照、可能已过时、与实况不符时以真实命令为准"，并指名 `env_refresh`。
8. **修复 Windows 无扩展名垫片**：`where pnpm` 先命中 npm 写的 POSIX 启动器（无扩展名），`execFile` 无法执行，版本号采集不到；现在优先选同目录的 `.exe/.cmd/.bat`。
9. **差异区分变化类型**：版本变化 `~ 名字: 旧 -> 新`，可执行文件换位置 `~ 名字 (path): 旧 -> 新`。
10. **TTL 默认 1 小时**，并**删掉"缓存已过期"提示**：过期就静默后台重探，标题里的时间戳 + 相对年龄已足够说明新旧。

## 插件契约

遵循 dsh 官方插件标准（`docs/user/develop/basic`）：ESM 导出 `apply(ctx, config)`；`inject: ['systemPrompt']`；`commands` 与 `tools` 通过 `ctx.inject` 按需获取（缺失时注入部分照常工作）；`Config["~standard"].validate` 零依赖实现标准 Schema 接口；通过 `ctx.systemPrompt.section()` 注册有序段，`text` 为每次组装时求值的 provider。工具用普通 registry-ready 对象注册（`ctx.tools.register` 自行校验 `output.render` / `output.schema`），因此仍无任何依赖。
