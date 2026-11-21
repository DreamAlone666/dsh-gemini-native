# Gemini Native

把 Gemini 原生 API 的历史回放、Google 搜索和 XHigh 接入 DeepSeek Harness（DSH）。复用内置 `pi-ai` Adapter，不更改模型路由，也不额外发起模型请求。

## 安装与默认值

1. 在源码目录用 Node.js `>=24.9.0` 运行 `pnpm install --frozen-lockfile`。
2. 在 DSH Web 的 **插件 → 添加插件** 填写该目录的绝对路径，安装并启用 **Gemini Native**。
3. 在 **设置 → 模型** 的 Gemini API 供应商卡片中设置各项能力。适用于内置 `google` 和使用 `google-generative-ai` 的供应商；不适用于 OpenAI 兼容或 Vertex 路由。

| 能力 | 默认值 | 在哪配置 |
| --- | --- | --- |
| 原生历史回放 | **开** | 对应 Gemini 供应商卡片，可单独关闭 |
| 输入框下方状态提示 | **开** | 插件详情页的「在输入框下方显示 Gemini Native 状态」 |
| Google 原生搜索 | **关** | 对应供应商卡片，开启不改变原生回放开关 |
| 系统提示词汉化 | **关** | 对应供应商卡片 |
| XHigh 推理覆盖 | **关** | Gemini 4 Neon / Hydrogen 的会话模型菜单 |

**原生历史回放会在 DSH 会话日志中保留额外的响应数据。** 如不希望记录，请在发出请求前关闭对应供应商的原生回放。关闭不会删除之前的记录。

## 功能和边界

- **原生历史回放**：对通过路由、模型和前缀指纹校验的历史轮次，复用 Gemini 原生 `parts` 和工具响应 ID。录制的是 pi-ai 实际选用的候选；原始 SSE 字节仍透传给 pi-ai。单帧解析上限为 1 MiB，单次录制上限为 2 MiB；超限不中断模型响应。插件扩展数据与 pi-ai 自带的签名分开，不会替换原签名。
- **Google 原生搜索**：在 Gemini API 路由替换 DSH `web_search`，保留其余本地工具。不能兼容的 `toolConfig` 不强行覆盖；同 ID 改用非 Gemini API 时会解除本插件的工具限制。搜索词和来源出现在轮尾卡片；原生回放可从日志重建，未录制时仅在当前 Host 进程中有限保留。开启搜索后，同路由同模型的后台压缩请求也可能携带该搜索工具以复用历史前缀，不录制压缩响应、不生成卡片、不使用 XHigh。混用搜索和本地工具时，关闭回放可能导致续轮失败。
- **状态提示**：输入框下方的四角星显示本路由生效项，点开可看回放、搜索、汉化和推理诊断。状态提示与回放开关独立；隐藏提示不会关闭任何能力。插件详情页也可清理已移除或已改协议的供应商配置。
- **XHigh**：从会话模型菜单开启，输入框工具栏显示可一键关闭的状态芯片。它不改动 DSH 内置推理档位。状态独立于 Session 日志持久化；通过 DSH 会话 fork 时复制原会话当前状态，之后各自保存和修改。主动换模型/档位、关闭或归档会清除对应会话的覆盖。
- **系统提示词汉化**：在选定的 Gemini API 路由上仅替换已知的 DSH 内置段落，要求段落名和英文原文完整匹配；不会替换自定义提示词或已有会话记录。

## 数据、分享和卸载

- 模型请求仍发往你配置的 Gemini API 或中转。启用 Google Search 后，Gemini 可依据会话上下文生成发送给 Google 搜索的查询。插件不另发分析或诊断网络请求。
- 原生回放扩展保留选中候选的原生部分，其中可能包含思维签名、服务端工具参数/结果和搜索元数据。**授权共享和日志导出可能包含这些额外字段**。分享前确认接收者可以看到相关数据，不要把原始日志当成脱敏导出。
- 插件启用时，会为已含有原生数据的会话跳过 DSH 官方 `dsh_session_log` 上传。该保护**不跨卸载**；如需停用插件，先在 **设置 → 通用 → 在使用官方模型 API 时上传 Session Log** 关闭上传，再用官方模型继续旧会话。这不会删除日志，也不影响其他分享或导出功能。

## 从 0.3.x 升级到 0.4.0

这是一次破坏式改名：`dsh-gemini-enhancement` → `dsh-gemini-native`。

1. 记下旧插件的供应商选项。如果旧会话存过原生数据，按上一节在卸载旧包前先关闭官方会话日志上传。
2. 在 DSH 中移除旧 bundle，再安装新版目录。目录名可以不改；不要同时启用两个版本。
3. 新旧配置不自动合并。需要保留 opt-in 搜索/汉化或关闭回放的供应商，在 **设置 → 模型** 重新设置；手写 profile 的用户可将配置移到新 ID，字段结构不变。XHigh 的存储单元已改名，旧开关需重新开启一次。

现有会话日志无须迁移：原生载荷和搜索卡片投影保留了原名称与格式，旧搜索卡片仍可读取。继续原生回放仍要求同供应商、模型和兼容的前缀；若旧会话曾启用 Google 原生搜索，要继续回放它的原生搜索历史，请在新版为该供应商恢复搜索设置。HTTP 路由、诊断投影、样式前缀和 XHigh 存储不提供旧名别名。

## 开发与验证

```sh
pnpm install --frozen-lockfile
pnpm test
DSH_INSTALL_DIR=/path/to/node_modules/@deepseek-ai/dsh pnpm test:integration
npm pack --dry-run --offline --ignore-scripts
```

`pnpm test` 未指定 `DSH_INSTALL_DIR` 时只跑单元测试。`test:integration` 要求指定它，运行真实 Cordis、Settings、Agent Loop、pi-ai 和持久化测试；模型网络使用 mock。当前验证版本为 DSH `0.2.2-rc.2`。项目是独立插件，保留 `private: true`，可公开源代码但不会误发 npm。

本项目采用 [MIT](LICENSE)。内置英文提示词片段取自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的系统提示词、Web 预设和工具插件，沿用上游 DeepSeek 的 MIT 声明。
