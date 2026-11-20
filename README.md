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

1. 在 **设置 → 模型** 配置并保存使用内置 **Gemini API** 的供应商（支持自定义中转及内置 `google` 目录路由）；Provider ID、URL、密钥、自定义 headers、推理配置与模型目录继续完全由 DSH 与内置 `pi-ai` 管理。
2. 到 **插件 → Gemini 增强 → 配置 → Gemini 原生历史（实验）**，为需要的供应商选模式并保存：
   - **沿用原路径（不保留原生历史）**：不介入原生历史；
   - **保留原生 parts**：仅留存/回放 Gemini 原生 parts，不开启 Google 搜索；
   - **保留 parts；没有其他函数时使用 Google 搜索** / **混用 Google 搜索与本地函数**：按需在同链路挂载 Google 搜索。仅对明确支持混用的端点开启混用。
3. **复用内置 `pi-ai` Adapter**：插件不再维护独立 Adapter，而是通过 `llm/stream` + `llm-pi-ai/request-headers` + 作用域 `fetch` 代理在内置 `pi-ai` 链路上增量完成两件事：
   - **出站修补**：将通过路由、模型和前缀指纹校验的历史 `model` 轮次 `parts` 替换为保留的原生 `parts`（包含签名、`toolCall`/`toolResponse` 和未知字段），并对齐紧随其后的 `functionResponse.id`；按模式注入 `googleSearch` 与 `includeServerSideToolInvocations`。
   - **入站旁路录制**：原始 SSE 字节原样透传给内置 `pi-ai` 完成流式分块合并、usage 统计与错误分类，旁路解码器仅记录原始 `frames` 与搜索证据，并将压缩后的原生数据嵌入 `pi-ai` 自身的 `replayState`（即使日后关闭原生模式或卸载插件，原有的 `pi-ai` 签名仍完好可用）。
4. 图片、文件附件、多模态工具结果、自定义 headers、`thinkingBudgets`、OAuth／凭据解析、超时与错误分类均直接由内置 `pi-ai` 处理，无需回退或重复实现。
5. 聊天仍用轮尾卡片；原生模式的搜索摘要由 `nativeSearchProjection` 从 Session 日志重建，重开后可读。单帧 SSE 上限 1 MiB、单次原生记录上限 2 MiB，超限时仅跳过本次原生回放录制而不中断正常对话。插件启用时，若会话已存有原生数据，将通过 DSH 的排除钩子跳过 `dsh_session_log` 官方上传；若停用插件，请在 DSH 中关闭该上传后再用官方模型打开曾记录过原生数据的会话。

## 可选：显示汉化提示

插件配置里的 **显示系统提示词汉化状态** 默认关闭，不影响汉化本身。勾选并保存后，切到匹配的模型，输入框下方立即显示「已匹配系统提示词汉化规则」，不用先发消息。收到 DSH 确认当前模型的请求用了本插件汉化的提示词后，同一处改为「系统提示词已汉化」。两种状态都用镂空四角星标识来源，悬停图标或使用屏幕阅读器可得知来源是 Gemini 增强插件。不匹配或关闭开关时不显示任何内容，也不向对话添加记录。确认状态只反映本次 Host 运行期间的请求，不判断上游模型是否正常路由。

## 汉化范围

DSH 在每一步组装系统提示词时，插件只翻译同时符合已知 **段落名和完整原文** 的段落：内置身份、Standard / Creator 的编程智能体说明、`@` 文件引用和常见工具指导。保留变量、段落顺序和工具约束。未知或已被改写的文本、完整自定义系统提示词、运行时上下文、项目指令、工具 schema 和已有会话记录保持原样。

本插件不更改 API 请求的模型 ID 或供应商，也不保证改变上游路由行为。已在 Web 中从本目录安装的插件，更新 Host 代码后请重启 DSH Host，再刷新页面；之后改设置无需重启。

## 开发与验证

使用 `pnpm test`。设置 `DSH_INSTALL_DIR` 指向 `@deepseek-ai/dsh` 安装目录时，还会使用真实 Cordis、Settings 和 pi-ai 验证旧路径的汉化、搜索载荷、并发隔离、热更新及卸载，并用真实 DSH Agent Loop 和临时 JSONL 日志验证新路由的工具执行、parts 回放以及冷重开后的搜索投影。测试用模拟网络，不发上游请求。当前基准为 DSH `0.2.2-rc.2`。升级后变更的提示词段落会保留原文，直到更新译文。

内置英文文本取自 DeepSeek Harness 的系统提示词、Web 预设、文件引用与工具插件，采用上游 MIT 许可。
