# DSH Gemini Enhancement

面向 DeepSeek Harness 的 **Gemini 原生 API（`/v1beta`）供应商增强插件**。

插件以 **Gemini 供应商（Provider）** 为唯一作用域，将 **系统提示词汉化**、**Gemini 原生历史回放** 与 **Google 原生搜索** 统一整合到 **设置 → 模型** 的对应供应商卡片内就地配置，无需手写模型通配符，也不改写路由或另发模型请求。

## 安装与配置

1. 本地源码目录先运行 `pnpm install`，安装配置 schema 依赖。
2. 打开 DSH Web 侧栏的 **插件 → 添加插件**，填写此目录的绝对路径，安装并启用。
3. 打开 **设置 → 模型**，添加或展开任意 **Gemini API** 供应商（支持自定义 `google-generative-ai` 中转及内置 `google` 路由），在卡片底部的 **Gemini 增强** 区域直接勾选需要的能力（即时保存，对下一次请求生效）：
   - **系统提示词汉化**：将已知的 DSH 内置英文系统提示词段落替换为简体中文（防止 Gemini 4 系列降智）。
   - **原生历史回放**：在内置 `pi-ai` Adapter 之上增量留存并回放 Gemini 原生 `parts`（包含思维签名、`toolCall`/`toolResponse` 和未知字段），对齐紧随其后的 `functionResponse.id`。
   - **Google 原生搜索**：保留其余本地工具的同时，将内置 `web_search` 替换为 Gemini 原生 `googleSearch` 并设置 `includeServerSideToolInvocations: true`。首次勾选时会自动联动开启 **原生历史回放**（避免混用本地工具后续轮失败），你仍可按需手动关闭。

## 工作机制与边界

### 1. 系统提示词汉化
DSH 在每一步组装系统提示词时，插件读取本步捕获的 `modelSelection.provider`。仅当该供应商启用了 **系统提示词汉化**，且段落同时匹配已知 **段落名与完整英文原文**（内置身份、Standard / Creator 编程智能体说明、`@` 文件引用与常见工具指导）时才替换。保留变量、段落顺序和工具约束；自定义系统提示词、第三方或预设改写段落、运行时上下文、工具 schema 和已有会话记录保持原样。

### 2. Gemini 原生历史回放与 Google 原生搜索
插件复用 DSH 内置 `pi-ai` Adapter（通过 `llm/stream` + `llm-pi-ai/request-headers` + 作用域 `fetch` 代理），图片、文件附件、多模态工具结果、自定义 headers、`thinkingBudgets`、OAuth／凭据解析、超时与错误分类均继续由内置 `pi-ai` 处理：
- **出站修补**：开启 **原生历史回放** 时，将通过路由、模型和前缀指纹校验的历史 `model` 轮次 `parts` 替换为保留的原生 `parts` 并对齐 `functionResponse.id`；开启 **Google 原生搜索** 时，移除请求中的 DSH `web_search` 并挂载 `{ googleSearch: {} }`（不覆盖显式不兼容的 `toolConfig` / `functionCallingConfig`）。
- **入站旁路录制**：原始 SSE 字节原样透传给内置 `pi-ai`；开启 **原生历史回放** 时旁路录制原始 `frames` 并压缩嵌入 `pi-ai` 自身的 `replayState`（即使日后关闭原生回放或卸载插件，原有的 `pi-ai` 签名仍完好可用）。单帧 SSE 上限 1 MiB、单次原生记录上限 2 MiB，超限时仅跳过本次原生录制而不中断对话。
- **搜索聊天卡片**：Gemini 返回原生搜索调用时，输入框下方实时显示「Google 搜索中…」；轮次结束后在轮尾展示可展开的搜索词与来源卡片。开启 **原生历史回放** 时，卡片由 `nativeSearchProjection` 从 Session 日志重建，重开会话仍可读；仅开启 **Google 原生搜索** 而关闭原生回放时，卡片仅在当前 Host 进程内临时保留。
- **官方日志上传排除**：插件启用时，若会话已存有原生历史数据，将通过 DSH 的排除钩子跳过 `dsh_session_log` 官方上传；若停用插件，请在 DSH 中关闭该上传后再用官方模型打开曾记录过原生数据的会话。

### 3. 输入框下方状态提示
打开 **插件 → 已安装插件 → Gemini 增强** 配置页，可查看当前已启用增强的供应商总览（并可清理已移除或改为非 Gemini 协议的孤立配置），以及开关 **在输入框下方显示 Gemini 增强状态**（默认关闭）。开启后，切到已启用增强的 Gemini 供应商时，输入框下方会以镂空四角星标识展示当前生效的增强项，并在收到请求确认后将「提示词汉化已匹配」更新为「提示词已汉化」。

## 开发与验证

使用 `pnpm test`。设置 `DSH_INSTALL_DIR` 指向 `@deepseek-ai/dsh` 安装目录时，还会使用真实 Cordis、Settings、SystemPrompt、pi-ai 与 Agent Loop 验证按供应商汉化、状态确认、Google 搜索载荷、原生 parts 回放、热更新、卸载以及冷重开后的搜索投影。测试使用模拟网络，不发上游请求。当前基准为 DSH `0.2.2-rc.2`。

内置英文文本取自 DeepSeek Harness 的系统提示词、Web 预设、文件引用与工具插件，采用上游 MIT 许可。
