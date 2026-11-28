# Gemini Native

面向 DeepSeek Harness（DSH）的 Gemini `/v1beta` 原生 API 插件。

它复用内置的 `pi-ai` 适配层，不替换模型路由，也不额外发起模型请求，把 DSH 通用适配层未覆盖的 Gemini 原生能力和避坑选项整合到 **设置 → 模型** 的对应供应商卡片里按需开关。

## 功能

- **原生历史回放**：`pi-ai` 为了兼容多模型会改写历史消息，丢掉 Gemini 的思维签名、服务端工具记录等原生结构，容易断掉多轮思考连续性，混用原生搜索时后续轮次也可能报错。插件在保留 `pi-ai` 流式、附件和凭据能力的前提下，按消息原样留存并回放这些 `parts`、对齐 `functionResponse.id`；还可选开启实验性的 **Gemini 4 家族跨模型互通**，在同一供应商下切换 Hydrogen / Neon / Carbon / Argon 时接着用上文思考与工具轨迹。
- **Google 原生搜索**：免去额外配置外部搜索源，直接把对应 Gemini 路由的内置 `web_search` 替换为原生 `googleSearch`（保留其余本地工具），搜索时在输入框下方实时提示，轮尾展示可展开的搜索词与来源卡片。
- **XHigh 推理覆盖**：DSH 内置推理档位最高到 `high`，无法选到 Gemini 4 Neon / Hydrogen 的 `XHigh`。插件在模型菜单中补上会话级快捷开关，不改原生档位设置；开启后工具栏显示状态芯片，点一下即可退出。
- **系统提示词汉化**：应对社区反馈的 Gemini 4 在英文系统提示词下疑似触发降智路由的现象（最初见于 [deepseek-harness#13144](https://github.com/deepseek-ai/deepseek-harness/discussions/13144)，本地实测确有此行为，具体成因尚不明确），将已知的 DSH 内置英文段落替换为简体中文，不动自定义提示词与已有记录。
- **状态栏与实时诊断**：上述能力大多在底层静默生效，输入框下方会展示当前路由生效项，点开可查看同模型与跨模型回放命中、搜索统计、汉化段数及异常告警（跨模型回放遇到 HTTP 400 时也可直接就地关闭）。

## 安装与配置

需要 Node.js `>=24.9.0` 与 DSH `>=0.2.2-rc.2 <0.3.0`。

1. 打开 DSH Web 侧栏进入 **插件 → 添加插件**，直接填入仓库地址安装并启用 **Gemini Native**：

```text
https://github.com/DreamAlone666/dsh-gemini-native.git
```

   如需本地源码安装，可先克隆并安装依赖，再在「添加插件」中填入目录绝对路径：

```sh
git clone https://github.com/DreamAlone666/dsh-gemini-native.git
cd dsh-gemini-native
pnpm install
```

2. 进入 **设置 → 模型** 展开任意 Gemini API 供应商卡片（支持内置 `google` 和 `google-generative-ai` 中转，不支持 OpenAI 兼容或 Vertex 路由），勾选需要的能力即可生效。

| 能力 | 默认 | 配置位置 |
| --- | --- | --- |
| 原生历史回放 | 开 | 对应 Gemini 供应商卡片 |
| Gemini 4 家族跨模型互通（实验性） | 关 | 对应 Gemini 供应商卡片 → 原生历史回放下方 |
| 输入框下方状态提示 | 开 | 插件详情页 |
| Google 原生搜索 | 关 | 对应 Gemini 供应商卡片 |
| 系统提示词汉化 | 关 | 对应 Gemini 供应商卡片 |
| XHigh 推理覆盖 | 关 | Gemini 4 Neon / Hydrogen 会话模型菜单 |

## 边界与注意事项

- **会话日志与分享**：原生回放会把选中候选的原生字段写入会话日志；关闭不会删除旧记录，导出或分享会话前请留意。原生数据与 `pi-ai` 原生签名分开保存，停用插件后原签名仍正常可用。
- **卸载前的官方日志上传**：插件启用时会为含原生数据的会话自动跳过 DSH 官方 `dsh_session_log` 上传，但保护不跨卸载；卸载前若计划用官方模型继续旧会话，请先在 **设置 → 通用** 关闭「在使用官方模型 API 时上传 Session Log」。
- **回放边界**：默认只对同一供应商、同一模型的历史按消息回放。改了系统提示词、裁剪旧对话，或者在同供应商下换用兼容中转地址，都不会把已有记录一棍子打死；实在对不上的单条消息会自动退回兼容格式发送。注意：同一个供应商配置并不保证中转背后走的是同一套上游，换不兼容上游时请单独新建供应商。
- **Gemini 4 家族跨模型互通（实验性）**：默认关闭，需同时开启「原生历史回放」（关掉原生回放会暂停互通，但保留勾选）。开启后，在同一供应商的主对话中切换 `gemini-4-carbon`、`gemini-4-argon`、`gemini-4-neon`、`gemini-4-hydrogen` 时，会尝试[原样带回先前模型的历史与思维签名](https://aistudio.google.com/docs/choosing-a-model.md?generate-content=true#pair-models)（不含特化变体，也不改变后台压缩）。聚合中转可能把不同模型分到不兼容的上游；如果带跨模型历史发出去遇到 HTTP 400，输入框下方状态栏会亮黄点，点开浮层即可一键为该供应商关闭互通，再手动重试（插件不会静默重试，关闭后不影响同模型回放，从下一条请求起对该供应商所有会话生效）。
- **回放与搜索约束**：混用 Google 原生搜索和本地工具时建议保持原生回放开启，否则续轮可能报错。关闭搜索或显式禁用工具上下文回传时，跳过含服务端工具记录的步骤，不影响普通步骤。存在不兼容 `toolConfig` 时不强行注入搜索。单帧 1 MiB、单次录制 2 MiB，超限仅跳过录制；未开启原生回放时，搜索卡片仅在当前 Host 进程内临时保留。
- **后台压缩与缓存**：只对同供应商、同模型的压缩请求做只读对齐，不录制、不生成搜索卡片、不带入 `XHigh`，实验性跨模型互通也不会影响压缩。原生回放不等于命中[隐式缓存](https://aistudio.google.com/docs/caching.md?generate-content=true#implicit-caching)，换模型后更不保证复用缓存，实际命中一律以 Gemini 返回的 `usageMetadata.cachedContentTokenCount` 为准。
- **XHigh 与汉化边界**：`XHigh` 状态独立持久化，会话 fork 时复制当前状态后各自独立，主动换模型/档位、手动关闭或归档时清除；提示词汉化要求段落名与内置英文原文完整匹配才会替换。

## 开发与测试

```sh
pnpm install
pnpm test
```

离线集成测试会加载真实的 Cordis、Settings、Agent Loop 与 `pi-ai`（网络使用 mock，当前验证基准为 DSH `0.2.2-rc.2`）：

```sh
DSH_INSTALL_DIR=/path/to/node_modules/@deepseek-ai/dsh pnpm test:integration
```

## License

[MIT](LICENSE)。内置英文提示词原文取自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，其上游 MIT 版权声明保留于 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
