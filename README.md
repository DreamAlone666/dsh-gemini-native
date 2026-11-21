# Gemini Native

面向 DeepSeek Harness（DSH）的 Gemini `/v1beta` 原生 API 插件。

它复用内置的 `pi-ai` 适配层，不替换模型路由，也不额外发起模型请求，把 DSH 通用适配层未覆盖的 Gemini 原生能力和避坑选项整合到 **设置 → 模型** 的对应供应商卡片里按需开关。

## 功能

- **原生历史回放**：`pi-ai` 为了兼容多模型会标准化历史消息，丢弃部分 Gemini 原生结构（思维签名、服务端工具记录与未知字段），影响多轮思考连续性，也会导致混用原生搜索后续轮报错。插件在保留 `pi-ai` 流式、附件和凭据能力的同时，按原样留存并回放这些 `parts` 并对齐 `functionResponse.id`。
- **Google 原生搜索**：免去额外配置外部搜索源，直接把对应 Gemini 路由的内置 `web_search` 替换为原生 `googleSearch`（保留其余本地工具），搜索时在输入框下方实时提示，轮尾展示可展开的搜索词与来源卡片。
- **XHigh 推理覆盖**：DSH 内置推理档位最高到 `high`，无法选到 Gemini 4 Neon / Hydrogen 的 `XHigh`。插件在模型菜单中补上会话级快捷开关，不改原生档位设置；开启后工具栏显示状态芯片，点一下即可退出。
- **系统提示词汉化**：应对社区反馈的 Gemini 4 在英文系统提示词下疑似触发降智路由的现象（最初见于 [deepseek-harness#13144](https://github.com/deepseek-ai/deepseek-harness/discussions/13144)，本地实测确有此行为，具体成因尚不明确），将已知的 DSH 内置英文段落替换为简体中文，不动自定义提示词与已有记录。
- **状态栏与实时诊断**：上述能力大多在底层静默生效，输入框下方会展示当前路由生效项，点开可查看回放命中、搜索统计、汉化段数及告警。

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
| 输入框下方状态提示 | 开 | 插件详情页 |
| Google 原生搜索 | 关 | 对应 Gemini 供应商卡片 |
| 系统提示词汉化 | 关 | 对应 Gemini 供应商卡片 |
| XHigh 推理覆盖 | 关 | Gemini 4 Neon / Hydrogen 会话模型菜单 |

## 边界与注意事项

- **会话日志与分享**：原生回放会把选中候选的原生字段写入会话日志；关闭不会删除旧记录，导出或分享会话前请留意。原生数据与 `pi-ai` 原生签名分开保存，停用插件后原签名仍正常可用。
- **卸载前的官方日志上传**：插件启用时会为含原生数据的会话自动跳过 DSH 官方 `dsh_session_log` 上传，但保护不跨卸载；卸载前若计划用官方模型继续旧会话，请先在 **设置 → 通用** 关闭「在使用官方模型 API 时上传 Session Log」。
- **回放与搜索约束**：混用 Google 原生搜索和本地工具时建议保持原生回放开启，否则续轮可能报错。仅对路由、模型和前缀指纹一致的历史轮次做回放（单帧 1 MiB、单次录制 2 MiB 上限，超限仅跳过录制不中断响应）。同路由同模型的后台压缩请求仅做只读前缀对齐以复用缓存，不录制、不生成卡片、不带入 `XHigh`。存在不兼容 `toolConfig` 时不强行注入搜索；未开启原生回放时，搜索卡片仅在当前 Host 进程内临时保留。
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
