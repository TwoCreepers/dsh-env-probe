# dsh-env-probe（本机环境探针）

[English](README.md) | 中文

零依赖 DeepSeek Harness 插件：每次启动时探测一次本机环境（操作系统 / Shell / 运行时 / 常用工具 / 磁盘 / 代理），把报告缓存到磁盘，并作为有序段注入每个会话的系统提示词——让 Agent 在对话一开始就知道"这台电脑有什么"，不再瞎猜命令。

## v1.0.1 新增：斜杠命令

仅在组合了命令适配器时注册（如 Web UI）；headless 等无命令环境自动跳过，注入功能不受影响。

| 命令 | 作用 |
|---|---|
| `/env-refresh` | 立即重新探测本机环境并重写缓存档案，回复摘要 + 与上次探测的差异（`+新增` / `-丢失` / `~版本变化`） |
| `/env-suggest` | 先强制刷新档案，再向当前会话提交一条用户消息，让助手基于**最新注入的环境档案**给出优化建议：缺失运行时/工具的用途与推荐安装方式、过旧版本的升级建议，按优先级列表，先建议后动手（不执行安装） |

> `/env-suggest` 采用与官方 `/plan` 相同的 `agent.steer()` 模式：命令本身不消耗模型 token，建议以正常助手回复的形式出现在对话里。

## 解决的痛点

Agent 每次新会话对本机环境都是陌生的：不同电脑 OS、已装软件、可用工具、路径都不一样。本插件把"环境摸底"自动化，相当于每次对话前完成一次本机环境初始化。

## 特性

- **通用设计**：无任何机器专属端点、无本地服务探测，所有探测项均可配置，可直接发布到共享平台
- **跨平台**：Windows / Linux / macOS
- **只读安全**：仅执行 `where/which`、`--version`、`df`、`Get-CimInstance` 等只读命令，禁止任何写/安装操作；可执行文件名经正则白名单校验
- **磁盘缓存 + TTL**：默认缓存 7 天，会话注入零延迟；过期后后台静默重探测，先提供旧值并标注"可能过期"
- **健壮降级**：单项探测失败记为"不可用"不中断；`.cmd/.bat` shim 走 `cmd /c` 解释；总预算与并发可调；并发刷新走 single-flight 共享一次探测
- **中英双语**：注入文本与命令文案支持 `language: 'en' | 'zh'`

## 安装

在你的 profile 的 `cordis.patch.yml` 中加入：

```yaml
- insert:
    - id: env-probe
      name: 'file:///绝对路径/dsh-env-probe/index.js'
      config:
        language: zh          # 注入文本语言，默认 en
        order: 30             # 系统提示词段顺序（-100 身份 / 0 persona / 100-199 工具引导）
        cacheTtlHours: 168    # 缓存有效期，到期后台重探测
```

## 配置项

| 键 | 默认值 | 含义 |
|---|---|---|
| `cacheTtlHours` | `168` | 缓存有效期（小时），过期后在下次组装时后台重探测 |
| `order` | `30` | 系统提示词段顺序 |
| `language` | `'en'` | 注入文本语言：`'en'` / `'zh'` |
| `cacheDir` | `'~/.dsh-env-probe'` | 缓存目录（`env-profile.json` + `env-profile.md`） |
| `runtimes` | git, node, npm, python, python3, pip, docker, java, go, rustc | 探测的运行时清单 |
| `tools` | curl, wget, ffmpeg, 7z, pandoc, tar, unzip, make, gcc, pwsh | 探测的工具清单 |
| `perProbeTimeoutMs` | `5000` | 单项探测超时 |
| `totalTimeoutMs` | `30000` | 整体探测预算 |
| `concurrency` | `4` | 探测并发数 |
| `marker` | `'ENV-PROBE'` | 注入段标记文本 |

## 注入效果（示例）

```
ENV-PROBE: 本机环境档案 (探测时间: 2026-08-18T12:28:01Z)
以下是自动探测生成的本机环境档案。请信任它而不是猜测：直接使用列出的运行时/工具及其路径……
## 操作系统
- Microsoft Windows 10 专业版 | x64 | CPU: 24 | RAM: 63.8 GB
## 运行时
- git: git version 2.55.0.windows.3 (C:\...\git.exe)
- docker: 不可用
……
```

## 插件契约

遵循 dsh 官方插件标准（`docs/user/develop/basic`）：ESM 导出 `apply(ctx, config)`；`inject: ['systemPrompt']`；`Config["~standard"].validate` 零依赖实现标准 Schema 接口；通过 `ctx.systemPrompt.section()` 注册有序段，`text` 为每次组装时求值的 provider，保证注入内容随缓存刷新。
