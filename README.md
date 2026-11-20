# DSH Gemini Enhancement

在 DeepSeek Harness 中，根据每一步实际选中的 **模型 ID**，将已知内置系统提示词替换为简体中文。汉化不区分供应商，也不依赖模型展示名称、全局默认模型或上游 `modelVersion`。在支持的 Gemini 原生 API 路由上，还可以用同一套模型规则开启实验性的 Google 搜索。

## 安装与配置

1. 本地源码目录先运行 `pnpm install`，安装配置 schema 依赖。
2. 打开 DSH Web 侧栏的 **插件 → 添加插件**，填写此目录的绝对路径，安装并启用。
3. 在 **插件 → 已安装插件 → Gemini 增强** 中，确认组合包和插件行均已启用。点击带向右箭头的插件行名称打开配置页，在 **模型 ID 规则** 中每行填写一条，再点击 **保存**。保存应用到后续步骤，进行中的请求不变。

默认规则：

```text
gemini-4
gemini-4-*
gemini-4.*
```

- 精确 ID 区分大小写；只允许一个末尾 `*` 表示前缀匹配，不支持其他通配符语法。比如 `gemini-4-argon` 只匹配该 ID，而 `gemini-4-*` 也匹配 `gemini-4-hydrogen-preview` 等后续型号。
- 填写 DSH 的模型 ID 字段，不要另拼供应商 ID。如果模型 ID 本身就带命名空间或是自定义别名，可将完整 ID 作为一条规则，例如 `models/gemini-4-argon` 或 `my-argon`。命名空间不会被自动移除。
- 保存空列表时不汉化，也不对旧 pi-ai 路径挂载搜索；原生历史按供应商单独配置，不依赖模型 ID 规则。

## 可选：pi-ai 路由的 Google 原生搜索（实验）

在同一个插件配置页勾选 **pi-ai 路由的 Google 原生搜索（实验）** 并保存。默认关闭，与汉化状态提示独立。它复用上面的模型 ID 规则，仅对 DSH Agent Loop 通过 pi-ai 发出的 Gemini Developer API `streamGenerateContent` 对话请求生效。下一次请求采纳新配置，已发出的请求不变。无需另配供应商、修改 Base URL 或注册本地搜索工具。

插件在 Host 进程内包装 `fetch`。只有在向本次请求挂载 `googleSearch` 时，才从请求工具列表移除 DSH 的 `web_search`，避免两种搜索同时供模型选择。`web_fetch` 和其他本地工具保留；关闭开关、切换到不匹配的模型或走非 Gemini 原生协议时，不改原有工具。与其余本地函数混用时，按 [Google GenerateContent 文档](https://aistudio.google.com/docs/tool-combination.md?generate-content=true) 加上 `includeServerSideToolInvocations`，不覆盖显式不兼容的工具模式。插件不加临时请求头、不另发模型请求，也不改 SSE 或对话记录。Google 自行决定是否搜索，搜索可能收费。

**聊天卡片：**只在 Gemini 实际报告 Google 搜索时显示。Gemini 返回原生工具调用时，输入框下方显示「Google 搜索中…」；轮次结束后，在这一轮末尾汇总成一张卡片，有搜索词或来源时可展开。仅返回 grounding 的网关不会显示「搜索中」。来源是 Google 返回的链接，不是回答逐句引用。卡片只在当前 Host 进程内保留（最近 48 个有记录的会话，每会话最多 12 次模型尝试），不写入聊天记录、「轨迹」或导出。

**实验边界：**依赖当前 DSH、pi-ai 和 Google SDK 的发送链路；升级后应重跑集成测试。并非所有反代都会返回可观察的搜索证据或支持混合工具，当前 pi-ai 也不会完整回放 Google 原生工具 parts，调用本地工具后的续轮可能失败。不自动重试无搜索请求，也不切换供应商。若遇到不兼容，关闭搜索开关即可保留汉化。

## 可选：在插件页按供应商启用 Gemini 原生历史（实验）

1. 在 **设置 → 模型** 保留已有的自定义供应商，选择它实际支持的内置 **Gemini API** 并保存；Provider ID、URL、密钥和模型目录继续由 DSH 管理。若原地址是 OpenAI 路径，请确认它是否适用于 Gemini API（例如包括 `/v1beta`）。模型页不增加自定义协议或开关。
2. 到 **插件 → Gemini 增强 → 配置 → Gemini 原生历史（实验）**，为需要的供应商选模式并保存。**沿用原路径（不保留原生历史）**是不接管该供应商；**保留原生 parts**只启用原生留存，不开启 Google 搜索；另外两种模式按需开启搜索。只给明确支持混用的端点选混用。旧供应商卡片中保存过的偏好仍然有效，无需重新配置。
3. 用新文本会话验证。当前只接管明确启用了模式、并配置了地址和密钥引用的自定义 Gemini API 路由；图片、文件、已有签名的 pi-ai 历史、未支持的自定义 headers／推理配置及辅助请求走原路径。原生请求一旦发出，不会失败后用 pi-ai 重发。切回默认方式不会删除已保存的 parts 或卡片；会话中途切换后不保证此前的原生历史仍能无损续轮。

本方案不需要修改或重建 DSH。模型发现、配置、模型准备仍由 DSH／pi-ai 持有，插件通过现有流扩展点处理符合条件的请求。

### 备用：从 Host 配置注册独立原生路由

如果不走模型页，也可在插件的 Host 配置中加 `generateContentRoutes`。每个键是一个**尚未被 DSH 使用的 Provider ID**，同一实现可以服务多条直连或透传路由；不需要额外预设。下例仅展示配置形状，替换端点、凭据引用和实际模型 ID 后使用：

```yaml
generateContentRoutes:
  gemini-direct-native:
    api: google-generative-ai
    baseURL: https://generativelanguage.googleapis.com/v1beta
    apiKeyEnv: GEMINI_API_KEY
    search: mixed
    models:
      - id: gemini-4-hydrogen
  gemini-relay-native:
    api: google-generative-ai
    baseURL: https://relay.example/v1beta
    apiKeyEnv: RELAY_GEMINI_API_KEY
    search: off
    models:
      - id: gemini-4-hydrogen
```

配置变更请在新会话验证；原型不承诺会话中途更换协议或搜索策略后仍能无损回放。旧 pi-ai 路由的 Web 开关仍可独立使用，既有设置不会切换到原生 Adapter。

- `search` 默认 `off`；`search-only` 只在没有其他本地函数时挂载；`mixed` 仅用于确认支持工具混用和历史循环的端点。只有本次确实挂载 `googleSearch` 时，才从发送的声明移除 `web_search`。其他路由不受影响。不要为旧历史把不同端点复用成同一个路由。
- 原生路由直连 REST/SSE，不走旧版全局 `fetch` 包装。正文、推理文本和本地函数仍用 DSH 已有的内容块保存；有序原生增量引用其中能精确重建的字段，另存签名、原生工具结果、未知字段和必要的帧边界。小响应省不下空间时、失败或截断时保留原始 parts；旧记录仍可读。只有相同路由、模型、配置身份及可见历史前缀兼容时才回放；否则只使用 DSH 通用历史。Gemini 的服务端工具不会作为本地工具执行。
- 聊天仍用轮尾卡片；原生路由的摘要从 Session 日志重建，重开后可读，不插入内置「轨迹」。有权读取 DSH 原始会话事件的客户端也能读到原生数据；投影只提供摘要，不添加请求认证头或凭据。插件启用时，若会话已存有原生数据，将通过 DSH 的排除钩子跳过该会话的 `dsh_session_log` 官方 API 附带上传，普通对话消息不受影响。若停用插件，请在 DSH 中关闭这项上传，再用官方模型打开曾记录过原生数据的会话。
- 当前只验证了文本和普通本地函数调用；未实现 Vertex 认证、图片请求和流式函数参数。单个 SSE 事件最多 1 MiB、单次原生记录最多 2 MiB；超限明确失败，不把截断结果当成可回放历史。进程在 attempt 落盘前硬中断时没有可重建的记录。

## 可选：显示汉化提示

插件配置里的 **显示系统提示词汉化状态** 默认关闭，不影响汉化本身。勾选并保存后，切到匹配的模型，输入框下方立即显示「已匹配系统提示词汉化规则」，不用先发消息。收到 DSH 确认当前模型的请求用了本插件汉化的提示词后，同一处改为「系统提示词已汉化」。两种状态都用镂空四角星标识来源，悬停图标或使用屏幕阅读器可得知来源是 Gemini 增强插件。不匹配或关闭开关时不显示任何内容，也不向对话添加记录。确认状态只反映本次 Host 运行期间的请求，不判断上游模型是否正常路由。

## 汉化范围

DSH 在每一步组装系统提示词时，插件只翻译同时符合已知 **段落名和完整原文** 的段落：内置身份、Standard / Creator 的编程智能体说明、`@` 文件引用和常见工具指导。保留变量、段落顺序和工具约束。未知或已被改写的文本、完整自定义系统提示词、运行时上下文、项目指令、工具 schema 和已有会话记录保持原样。

本插件不更改 API 请求的模型 ID 或供应商，也不保证改变上游路由行为。已在 Web 中从本目录安装的插件，更新 Host 代码后请重启 DSH Host，再刷新页面；之后改设置无需重启。

## 开发与验证

使用 `pnpm test`。设置 `DSH_INSTALL_DIR` 指向 `@deepseek-ai/dsh` 安装目录时，还会使用真实 Cordis、Settings 和 pi-ai 验证旧路径的汉化、搜索载荷、并发隔离、热更新及卸载，并用真实 DSH Agent Loop 和临时 JSONL 日志验证新路由的工具执行、parts 回放以及冷重开后的搜索投影。测试用模拟网络，不发上游请求。当前基准为 DSH `0.2.2-rc.2`。升级后变更的提示词段落会保留原文，直到更新译文。

内置英文文本取自 DeepSeek Harness 的系统提示词、Web 预设、文件引用与工具插件，采用上游 MIT 许可。
