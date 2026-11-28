window.__ModuleLoader__.load({
  id: 'dsh-gemini-native',
  factory(require) {
    const React = require('react')
    let ReactDOM = null
    try { ReactDOM = require('react-dom') } catch { ReactDOM = null }
    const h = React.createElement
    const namespace = 'dshGeminiNative'
    const pluginId = 'dsh-gemini-native'

    const en = {
      brand: 'Gemini Native',
      localizePrompt: 'Localize system prompt',
      localizePromptTitle: 'Replace known built-in DSH English system prompts with Simplified Chinese on this provider.',
      nativeHistory: 'Native history replay',
      nativeHistoryTitle: 'Record and replay native parts, including thought signatures and server-side tool data.',
      nativeHistoryPrivacy: 'Native history is on by default and adds response data to the Session log. That data can be shared or exported. Turning off replay does not erase existing data. Disable official Session Log uploads before uninstalling.',
      gemini4FamilyReplay: 'Gemini 4 cross-model replay',
      gemini4FamilyHelp: 'Requires Native history replay. Tries to keep native history and thought signatures when switching between Carbon, Argon, Neon, and Hydrogen. One provider or gateway may use different upstreams and return HTTP 400. Implicit cache hits are not guaranteed.',
      experimental: 'Experimental',
      gemini4FamilySummary: 'Gemini 4 cross-model replay · Experimental',
      googleSearch: 'Google Search',
      googleSearchTitle: 'Replace built-in web_search with Google Search run by Gemini. Search queries can include information from this conversation.',
      searchWithoutHistoryWarn: 'Without native history replay, follow-up turns after mixing Google Search with local tools may fail.',
      nonGeminiRoute: 'This provider is no longer a Gemini API route. You can clear its saved options.',
      clear: 'Clear',
      clearing: 'Clearing…',
      saving: 'Saving…',
      readOnly: 'Read-only',
      saveFailed: 'Could not save Gemini Native settings. Please try again.',
      saveConflict: 'Settings changed elsewhere. Please retry.',
      pageIntro: 'Configure native history replay, Google Search, and system prompt localization on each Gemini API provider card in Settings → Models.',
      showStatusNotice: 'Show Gemini Native status below the composer',
      showStatusNoticeHelp: 'Shows the active options and confirms when a request uses the localized prompt. Hiding this notice does not turn off any feature.',
      activeRoutesHeading: 'Provider overrides',
      activeRoutesEmpty: 'No overrides. Native history is on for Gemini API providers by default. Open Settings → Models to change a provider’s options.',
      routeStaleTag: 'Not currently a Gemini API provider',
      nativeHistoryOff: 'Native history off',
      loading: 'Loading settings…',
      unavailable: 'Configuration is unavailable. Check that the bundle and its plugin row are enabled, then reopen this page.',
      statusLocalizationOn: 'Prompt localization on',
      statusLocalized: 'Prompt localized',
      statusNativeHistory: 'Native history',
      statusGoogleSearch: 'Google Search',
      source: 'Source: Gemini Native plugin',
      activityTitle: 'Google Search',
      activityLive: 'Searching Google…',
      activityCompleted: 'Search reported by Gemini',
      activityIncomplete: 'Search completion not confirmed',
      activityPartial: 'Some searches were not confirmed complete',
      activityQueries: 'Search queries',
      activitySourceCount: 'Sources',
      activitySources: 'Sources',
      activitySourceFallback: 'Web source',
      xhighLabel: 'XHigh',
      xhighOptionLabel: 'XHigh effort override',
      xhighOptionTitle: 'Override reasoning level to XHigh for this session (Neon / Hydrogen) without changing the native effort setting',
      xhighOnTitle: 'XHigh override is active for this session — click to turn off',
      xhighToggleFailed: 'Could not update XHigh effort override. Please try again.',
      diagWarningBadge: 'Warning',
      diagWarnUrlMismatch: 'Could not match /v1beta request path (check provider baseURL).',
      diagWarnRecordOverflow: 'Last response exceeded the 2 MiB native recording limit and was not recorded.',
      diagWarnRecordInvalid: 'Last response SSE frames were invalid; skipped native recording.',
      diagWarnSearchSkipped: 'Incompatible toolConfig present; native Google Search was not injected.',
      diagWarnCrossModel400: 'This request included cross-model native history and the upstream returned HTTP 400; thought signatures may be incompatible. Turn off cross-model replay and retry.',
      diagWarnCrossModel400Closed: 'This request included cross-model native history and the upstream returned HTTP 400; thought signatures may be incompatible.',
      diagFamilyCandidatesTpl: '{count} steps from other Gemini 4 models on this provider may be replayable.',
      diagFamilyEnable: 'Enable experimental Gemini 4 replay for this provider',
      diagFamilyRisk: 'Use only with the same compatible upstream. Mixed routing may return HTTP 400.',
      diagFamilyDisable: 'Turn off cross-model replay for this provider',
      diagFamilyScope: 'Applies to all sessions on this provider starting with the next request.',
      diagFamilyDisabled: 'Cross-model replay is off for this provider. You can retry manually.',
      diagPromptLabel: 'Prompt localization',
      diagPromptMatchedTpl: 'Replaced {matched} / {total}',
      diagPromptMissedTpl: 'Unmatched built-ins: {names}',
      diagPromptLogZh: 'Log prompt is Chinese',
      diagPromptLogEn: 'Log prompt is English',
      diagPromptPending: 'Awaiting request',
      diagHistoryLabel: 'Native history',
      diagHistoryReplayTpl: 'Native replay: {replayed} / {total} steps',
      diagHistoryCurrentReplayTpl: 'Same-model replay: {replayed} / {total} steps',
      diagHistorySameModelHitsTpl: 'Same-model hits: {count}',
      diagHistoryCrossModelHitsTpl: 'Cross-model hits: {count}',
      diagHistoryNoCurrent: 'No history from the current model and provider',
      diagHistoryOtherModelTpl: 'Steps from other models or providers sent in standard format: {count}',
      diagHistoryUnmatchedTpl: 'Unmatched same-model steps sent in standard format: {count}',
      diagHistoryUnclassifiedTpl: 'Steps sent in standard format (reason not classified): {count}',
      diagHistoryNoHistory: 'No history to replay yet',
      diagHistoryCumulativeTpl: 'total {size}',
      diagHistoryLastRecordingTpl: 'last recording {size}',
      diagHistoryDurableTpl: 'Native data recorded in log: {recorded} / {total} steps · {size}',
      diagHistoryNoStats: 'No replay stats for this model yet',
      diagHistoryNoneInSession: 'No native records in session',
      diagHistoryEmpty: 'No native data recorded yet',
      diagLogUploadLabel: 'Official log',
      diagLogExcluded: 'Auto-excluded from upload',
      diagLogAutoExclude: 'Auto-excluded if native data present',
      diagSearchLabel: 'Google Search',
      diagSearchMixedTpl: 'Mixed with {count} local tools',
      diagSearchOnly: 'Native search only',
      diagSearchSessionCountTpl: '{cards} in session',
      diagSearchDurableSummaryTpl: '{cards} runs · {queries} queries · {sources} sources',
      diagSearchSkippedValue: 'Skipped (toolConfig conflict)',
      diagSearchReady: 'Ready (awaiting call)',
      diagEmptyHint: 'Send a message to view live override details.',
    }

    const zh = {
      brand: 'Gemini Native',
      localizePrompt: '系统提示词汉化',
      localizePromptTitle: '在此供应商上将已知的 DSH 内置英文系统提示词替换为简体中文。',
      nativeHistory: '原生历史回放',
      nativeHistoryTitle: '录制并回放 Gemini 原生 parts，包括思维签名与服务端工具数据。',
      nativeHistoryPrivacy: '原生回放默认开启，会向会话日志写入额外的响应数据。分享或导出会话时可能包含这些数据。关闭开关不会清除已有记录；卸载前请先关闭 DSH 官方会话日志上传。',
      gemini4FamilyReplay: 'Gemini 4 家族跨模型互通',
      gemini4FamilyHelp: '需开启原生历史回放。在同一供应商内切换 Carbon、Argon、Neon、Hydrogen 时尝试保留历史与思维签名。同一供应商或网关不一定连接同一上游，可能报 HTTP 400；不保证命中隐式缓存。',
      experimental: '实验性',
      gemini4FamilySummary: 'Gemini 4 互通 · 实验性',
      googleSearch: 'Google 原生搜索',
      googleSearchTitle: '由 Gemini 在服务端执行 Google 搜索，替换内置 web_search。搜索词可能包含本会话中的信息。',
      searchWithoutHistoryWarn: '未开启原生历史回放时，混用 Google 原生搜索与本地工具的续轮可能失败。',
      nonGeminiRoute: '当前已非 Gemini API 供应商，可清除此前保存的原生配置。',
      clear: '清除',
      clearing: '清除中…',
      saving: '保存中…',
      readOnly: '只读',
      saveFailed: '未能保存 Gemini Native 设置，请重试。',
      saveConflict: '设置已在别处更改，请重试。',
      pageIntro: '各 Gemini API 供应商的「系统提示词汉化」「原生历史回放」与「Google 原生搜索」均已整合到「设置 → 模型」中对应供应商卡片内就地配置。',
      showStatusNotice: '在输入框下方显示 Gemini Native 状态',
      showStatusNoticeHelp: '在输入框下方显示当前生效项；请求确认使用汉化后更新为已汉化。关闭提示不会关闭任何功能。',
      activeRoutesHeading: '供应商自定义选项',
      activeRoutesEmpty: '没有自定义选项。Gemini API 供应商默认启用原生回放，可在「设置 → 模型」中修改。',
      routeStaleTag: '当前非 Gemini API 供应商',
      nativeHistoryOff: '原生回放已关闭',
      loading: '正在加载设置…',
      unavailable: '配置不可用。请确认组合包和插件行均已启用，然后重新打开此页。',
      statusLocalizationOn: '提示词汉化已开启',
      statusLocalized: '提示词已汉化',
      statusNativeHistory: '原生历史',
      statusGoogleSearch: 'Google 搜索',
      source: '来源：Gemini Native 插件',
      activityTitle: 'Google 搜索',
      activityLive: 'Google 搜索中…',
      activityCompleted: 'Gemini 已报告搜索',
      activityIncomplete: '未确认搜索完成',
      activityPartial: '部分搜索未确认完成',
      activityQueries: '搜索词',
      activitySourceCount: '来源',
      activitySources: '来源',
      activitySourceFallback: '网页来源',
      xhighLabel: 'XHigh',
      xhighOptionLabel: 'XHigh 推理覆盖',
      xhighOptionTitle: '在当前会话将推理等级覆盖为 XHigh（Neon / Hydrogen），不改变原生档位',
      xhighOnTitle: '当前会话已开启 XHigh 覆盖 — 点击关闭',
      xhighToggleFailed: '未能切换 XHigh 推理覆盖，请重试。',
      diagWarningBadge: '告警',
      diagWarnUrlMismatch: '未能匹配 /v1beta 请求路径（请检查供应商 baseURL）',
      diagWarnRecordOverflow: '最近响应超过 2 MiB 原生录制上限，未录制该响应',
      diagWarnRecordInvalid: '最近响应 SSE 帧异常，已跳过原生录制',
      diagWarnSearchSkipped: '存在不兼容的 toolConfig，Google 原生搜索未注入',
      diagWarnCrossModel400: '本次请求携带了跨模型原生历史，上游返回 HTTP 400；签名可能不兼容，可关闭后重试。',
      diagWarnCrossModel400Closed: '本次请求携带了跨模型原生历史，上游返回 HTTP 400；签名可能不兼容。',
      diagFamilyCandidatesTpl: '同一供应商下有 {count} 步来自其他 Gemini 4 模型，可尝试原生回放。',
      diagFamilyEnable: '为此供应商开启实验性互通',
      diagFamilyRisk: '仅适用于连接同一兼容上游的模型；混用上游可能报 HTTP 400。',
      diagFamilyDisable: '为此供应商关闭跨模型互通',
      diagFamilyScope: '对该供应商的所有会话生效，从下一次请求开始。',
      diagFamilyDisabled: '已为此供应商关闭跨模型互通，可以手动重试。',
      diagPromptLabel: '提示词汉化',
      diagPromptMatchedTpl: '已替换 {matched} / {total} 段',
      diagPromptMissedTpl: '未匹配内置段: {names}',
      diagPromptLogZh: '日志提示词为中文',
      diagPromptLogEn: '日志提示词为英文',
      diagPromptPending: '等待请求确认',
      diagHistoryLabel: '原生历史',
      diagHistoryReplayTpl: '原生回放 {replayed} / {total} 步',
      diagHistoryCurrentReplayTpl: '同模型回放 {replayed} / {total} 步',
      diagHistorySameModelHitsTpl: '同模型命中 {count} 步',
      diagHistoryCrossModelHitsTpl: '跨模型命中 {count} 步',
      diagHistoryNoCurrent: '暂无当前供应商和模型的历史',
      diagHistoryOtherModelTpl: '其他模型或供应商的 {count} 步按兼容格式发送',
      diagHistoryUnmatchedTpl: '同模型有 {count} 步未命中，按兼容格式发送',
      diagHistoryUnclassifiedTpl: '{count} 步按兼容格式发送（原因未分类）',
      diagHistoryNoHistory: '暂无历史可回放',
      diagHistoryCumulativeTpl: '累计 {size}',
      diagHistoryLastRecordingTpl: '最近一次录制 {size}',
      diagHistoryDurableTpl: '日志已记录 {recorded} / {total} 步 · {size}',
      diagHistoryNoStats: '暂无当前模型的回放统计',
      diagHistoryNoneInSession: '本会话尚无原生记录',
      diagHistoryEmpty: '尚无原生记录',
      diagLogUploadLabel: '官方日志',
      diagLogExcluded: '已自动排除上传',
      diagLogAutoExclude: '含原生数据时自动排除',
      diagSearchLabel: 'Google 搜索',
      diagSearchMixedTpl: '混用 {count} 个本地工具',
      diagSearchOnly: '纯原生搜索',
      diagSearchSessionCountTpl: '本会话 {cards} 次',
      diagSearchDurableSummaryTpl: '本会话 {cards} 次 · {queries} 词 · {sources} 来源',
      diagSearchSkippedValue: '已跳过注入（toolConfig 冲突）',
      diagSearchReady: '已就绪（等待调用）',
      diagEmptyHint: '发出首条消息后显示实时覆盖详情',
    }

    const pluginStyles = `
.dsh-gn-dock-anchor {
  display: inline-flex;
  min-width: 0;
  font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
}
.dsh-gn-dock-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  max-width: 100%;
  padding: 1px 8px;
  border: none;
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
  line-height: inherit;
  white-space: nowrap;
  outline: none;
}
.dsh-gn-dock-pill svg {
  width: 14px;
  height: 14px;
  flex: none;
}
button.dsh-gn-dock-pill {
  cursor: pointer;
}
button.dsh-gn-dock-pill[aria-expanded="true"] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
@media (hover: hover) {
  button.dsh-gn-dock-pill:hover {
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-secondary);
  }
}
button.dsh-gn-dock-pill:focus-visible {
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}
.dsh-gn-dock-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-gn-dock-sep {
  opacity: 0.55;
  margin: 0 5px;
}
.dsh-gn-dock-warn-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--dsw-alias-state-warn-primary);
  flex: none;
}

.dsh-gn-diag-panel {
  position: fixed;
  z-index: 1100;
  box-sizing: border-box;
  width: max-content;
  min-width: min(300px, calc(100vw - 24px));
  max-width: min(420px, calc(100vw - 24px));
  padding: 16px;
  border: 0;
  border-radius: var(--dsw-radius-lg, 16px);
  background: var(--dsw-specific-menu);
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  cursor: default;
  max-height: calc(100dvh - 12px - max(12px, var(--dsh-frame-overlay-top, 12px)));
  overflow-x: hidden;
  overflow-y: auto;
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
  position-area: none;
  top: max(12px, var(--dsh-frame-overlay-top, 12px));
  bottom: max(12px, calc(anchor(top) + 8px));
  left: max(12px, anchor(left));
  right: 12px;
  position-try-fallbacks: --dsh-gn-diag-window, --dsh-gn-diag-opposite, --dsh-gn-diag-wide-opposite, --dsh-gn-diag-tall, --dsh-gn-diag-viewport;
  align-self: end;
  justify-self: start;
  height: fit-content;
  min-height: 0;
  margin: 0;
}
@position-try --dsh-gn-diag-window {
  position-area: none;
  top: max(12px, var(--dsh-frame-overlay-top, 12px));
  bottom: max(12px, calc(anchor(top) + 8px));
  left: 12px;
  right: 12px;
  margin: 0;
  align-self: safe end;
  justify-self: safe end;
}
@position-try --dsh-gn-diag-opposite {
  top: max(12px, calc(anchor(bottom) + 8px));
  bottom: 12px;
  align-self: start;
}
@position-try --dsh-gn-diag-wide-opposite {
  top: max(12px, calc(anchor(bottom) + 8px));
  bottom: 12px;
  left: 12px;
  right: 12px;
  align-self: start;
  justify-self: safe end;
}
@position-try --dsh-gn-diag-tall {
  position-area: none;
  top: max(12px, var(--dsh-frame-overlay-top, 12px));
  bottom: 12px;
  left: max(12px, anchor(left));
  right: 12px;
  margin: 0;
  align-self: safe start;
  justify-self: start;
}
@position-try --dsh-gn-diag-viewport {
  position-area: none;
  inset: max(12px, var(--dsh-frame-overlay-top, 12px)) 12px 12px;
  margin: 0;
  align-self: safe start;
  justify-self: safe end;
}
.dsh-gn-diag-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 8px;
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
.dsh-gn-diag-title-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: none;
}
.dsh-gn-diag-title-label svg {
  width: 14px;
  height: 14px;
  flex: none;
}
.dsh-gn-diag-route {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary);
  font-weight: 400;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.dsh-gn-diag-rule {
  margin-bottom: 10px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.dsh-gn-diag-warns {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}
.dsh-gn-diag-warn {
  padding: 6px 8px;
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-state-warn-label);
  font-size: 11px;
  line-height: 16px;
  overflow-wrap: anywhere;
}
.dsh-gn-diag-details {
  display: grid;
  grid-template-columns: minmax(76px, auto) minmax(0, 1fr);
  gap: 6px 16px;
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-gn-diag-details dt,
.dsh-gn-diag-details dd {
  min-width: 0;
  margin: 0;
}
.dsh-gn-diag-details dd {
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
  text-align: right;
  overflow-wrap: anywhere;
}
.dsh-gn-diag-sub {
  margin-top: 2px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}
.dsh-gn-diag-action {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  margin-top: 6px;
}
.dsh-gn-diag-details .dsh-gn-diag-action {
  align-items: flex-end;
}
.dsh-gn-diag-hint {
  margin: 10px 0 0;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}

.dsh-gn-xhigh-wrap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.dsh-gn-xhigh {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 28px;
  min-width: 34px;
  padding: 0 8px;
  border: none;
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-state-business-tertiary);
  color: var(--dsw-alias-state-business-primary);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  white-space: nowrap;
  flex-shrink: 0;
  user-select: none;
  cursor: pointer;
  outline: none;
  transition: background-color 120ms ease, color 120ms ease, opacity 120ms ease;
}
.dsh-gn-xhigh-error {
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
}
@media (hover: hover) {
  .dsh-gn-xhigh:hover:not(:disabled) {
    background: color-mix(in srgb, var(--dsw-alias-state-business-tertiary), var(--dsw-alias-state-business-primary) 6%);
  }
}
.dsh-gn-xhigh:focus-visible {
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}
.dsh-gn-xhigh:disabled {
  opacity: 0.6;
  cursor: default;
}
.dsh-gn-xhigh-glyph {
  display: inline-flex;
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  color: currentColor;
}
.dsh-gn-xhigh-hover-glyph,
.dsh-gn-xhigh:focus-visible .dsh-gn-xhigh-rest-glyph {
  display: none;
}
@media (hover: hover) {
  .dsh-gn-xhigh:hover:not(:disabled) .dsh-gn-xhigh-rest-glyph {
    display: none;
  }
}
.dsh-gn-xhigh:focus-visible .dsh-gn-xhigh-hover-glyph {
  display: block;
}
@media (hover: hover) {
  .dsh-gn-xhigh:hover:not(:disabled) .dsh-gn-xhigh-hover-glyph {
    display: block;
  }
}

.dsh-gn-model-opt-row {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 34px;
  padding: 0 8px;
  border-radius: var(--dsw-radius-md, 8px);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
}
.dsh-gn-model-opt-label {
  display: inline-flex;
  align-items: center;
  min-width: 0;
}
.dsh-gn-model-opt-switch {
  box-sizing: border-box;
  position: static;
  flex: 0 0 auto;
  width: 36px;
  height: 20px;
  padding: 2px;
  border: 0;
  border-radius: 999px;
  corner-shape: round;
  background: var(--dsw-alias-border-l3);
  cursor: pointer;
  outline: none;
}
.dsh-gn-model-opt-switch::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: var(--dsw-radius-md, 8px);
}
.dsh-gn-model-opt-switch[aria-checked="true"] {
  background: var(--dsw-alias-brand-primary);
}
.dsh-gn-model-opt-switch:disabled {
  cursor: default;
  opacity: 0.5;
}
.dsh-gn-model-opt-switch:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.dsh-gn-model-opt-thumb {
  display: block;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  corner-shape: round;
  background: var(--dsw-alias-label-primary-foreground);
  transition: transform 120ms ease;
}
.dsh-gn-model-opt-switch[aria-checked="false"] .dsh-gn-model-opt-thumb {
  background: var(--dsw-alias-switch-thumb);
}
.dsh-gn-model-opt-switch[aria-checked="true"] .dsh-gn-model-opt-thumb {
  transform: translateX(16px);
}
.dsh-gn-model-opt-row:has(.dsh-gn-model-opt-switch:focus-visible) {
  background: var(--dsw-alias-interactive-bg-hover);
}
@media (hover: hover) {
  .dsh-gn-model-opt-row:has(.dsh-gn-model-opt-switch:not(:disabled)):hover {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}

.dsh-gn-search-root {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  margin: 4px 0;
}
.dsh-gn-search-row {
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  width: 100%;
  height: calc(24px + var(--dsh-content-font-delta, 0px));
  min-width: 0;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-xs, 4px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  text-align: left;
  outline: none;
  transition: color 100ms ease;
}
.dsh-gn-search-row[data-expandable="true"] {
  cursor: pointer;
}
@media (hover: hover) {
  .dsh-gn-search-row:hover {
    color: var(--dsw-alias-label-secondary);
  }
}
.dsh-gn-search-row:focus-visible {
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}
.dsh-gn-search-leading {
  position: relative;
  flex: none;
  width: calc(16px + var(--dsh-content-font-delta, 0px));
  height: calc(16px + var(--dsh-content-font-delta, 0px));
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-right: 6px;
  color: inherit;
}
.dsh-gn-search-leading svg {
  width: calc(14px + var(--dsh-content-font-delta, 0px));
  height: calc(14px + var(--dsh-content-font-delta, 0px));
}
.dsh-gn-search-icon-idle {
  display: inline-flex;
  opacity: 1;
  transition: opacity 100ms ease;
}
.dsh-gn-search-chevron-hover {
  position: absolute;
  inset: 0;
  margin: auto;
  opacity: 0;
  transition: opacity 100ms ease;
}
@media (hover: hover) {
  .dsh-gn-search-row[data-expandable="true"]:hover .dsh-gn-search-icon-idle {
    opacity: 0;
  }
  .dsh-gn-search-row[data-expandable="true"]:hover .dsh-gn-search-chevron-hover {
    opacity: 1;
  }
}
.dsh-gn-search-row[data-expandable="true"]:focus-visible .dsh-gn-search-icon-idle {
  opacity: 0;
}
.dsh-gn-search-row[data-expandable="true"]:focus-visible .dsh-gn-search-chevron-hover {
  opacity: 1;
}
.dsh-gn-search-title {
  flex: none;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  font-weight: 400;
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  color: inherit;
}
.dsh-gn-search-dot {
  flex: none;
  width: 2px;
  height: 2px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.65;
  margin: 0 6px;
}
.dsh-gn-search-summary {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  font-weight: 400;
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  color: inherit;
}
.dsh-gn-search-body {
  margin: 4px 0 4px 4px;
  padding: 12px 14px;
  border-radius: var(--dsw-radius-lg, 16px);
  background: var(--dsw-alias-markdown-code-block);
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
}
.dsh-gn-search-section + .dsh-gn-search-section {
  margin-top: 10px;
}
.dsh-gn-search-section-label {
  margin-bottom: 6px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-gn-search-queries {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.dsh-gn-search-query-tag {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: var(--dsw-radius-xs, 4px);
  background: var(--dsw-alias-markdown-tag);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.dsh-gn-search-sources {
  margin: 0;
  padding-left: 2.2em;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 320px;
  overflow-y: auto;
}
.dsh-gn-search-source-item {
  min-width: 0;
}
.dsh-gn-search-source-link {
  color: var(--dsw-alias-link);
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
  word-break: break-word;
  text-decoration: none;
}
.dsh-gn-search-source-link:hover,
.dsh-gn-search-source-link:focus-visible {
  text-decoration: underline dotted;
  text-underline-offset: 3px;
}
.dsh-gn-search-link-icon {
  width: 1.1em;
  height: 1.1em;
  vertical-align: -0.25em;
  margin-right: 5px;
}
.dsh-gn-search-source-host {
  margin-inline-start: 6px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
@media (prefers-reduced-motion: reduce) {
  .dsh-gn-search-row,
  .dsh-gn-search-icon-idle,
  .dsh-gn-search-chevron-hover,
  .dsh-gn-xhigh,
  .dsh-gn-model-opt-thumb {
    transition: none;
  }
}
`

    const secondary = { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 13, lineHeight: 1.5 }
    const caption = { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: '18px' }
    const warnCaption = { margin: 0, color: 'var(--dsw-alias-state-warn-label)', fontSize: 12, lineHeight: '18px' }
    const errorCaption = { margin: 0, color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, lineHeight: '18px' }
    const secondaryButton = {
      border: '0.5px solid var(--dsw-alias-border-l3)', borderRadius: 'var(--dsw-radius-md, 6px)',
      padding: '3px 10px', font: 'inherit', fontSize: 12, lineHeight: '18px', cursor: 'pointer',
      background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
    }
    const cardSection = {
      borderTop: '0.5px solid var(--dsw-alias-border-l3)',
      paddingTop: 10,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }
    const cardHeader = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
    }
    const cardTitle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      fontSize: 12,
      lineHeight: '18px',
      fontWeight: 500,
      color: 'var(--dsw-alias-label-secondary)',
    }
    const toggleRow = {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: '8px 16px',
    }
    const checkboxLabel = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 13,
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-primary)',
      cursor: 'pointer',
      userSelect: 'none',
    }
    const badgeStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      padding: '1px 7px',
      borderRadius: 'var(--dsw-radius-xs, 4px)',
      border: '0.5px solid var(--dsw-alias-border-l3)',
      fontSize: 11,
      lineHeight: '16px',
      color: 'var(--dsw-alias-label-secondary)',
    }

    function fmt(template, vars) {
      return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => String(vars?.[key] ?? ''))
    }

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes < 0) return '0B'
      if (bytes < 1024) return `${Math.round(bytes)}B`
      const kb = bytes / 1024
      if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)}KB`
      const mb = kb / 1024
      if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)}MB`
      const gb = mb / 1024
      return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)}GB`
    }

    function supportsXHighModel(model) {
      return typeof model === 'string' && /^(?:models\/)?gemini-4-(?:neon|hydrogen)(?:$|[-.@])/iu.test(model)
    }

    // Mirror the Host allowlist exactly, not XHigh's permissive suffix matching.
    // Google documents returning the previous model's turns and signatures unchanged:
    // https://aistudio.google.com/docs/choosing-a-model.md?generate-content=true#pair-models
    // https://aistudio.google.com/docs/whats-new-gemini-4-hydrogen.md#migrate-from-gemini-4-argon
    const gemini4FamilyModels = new Set(['gemini-4-argon', 'gemini-4-carbon', 'gemini-4-neon', 'gemini-4-hydrogen'])

    function supportsGemini4FamilyReplay(model) {
      return typeof model === 'string' && gemini4FamilyModels.has(model.toLowerCase().replace(/^models\//u, ''))
    }

    const emptyRouteEntry = { localizePrompt: false, nativeHistory: false, googleSearch: false, gemini4FamilyReplay: false }

    function routeEntryOf(routes, providerId) {
      const entry = typeof providerId === 'string' && providerId.length > 0 && routes && Object.hasOwn(routes, providerId)
        ? routes[providerId]
        : undefined
      return {
        localizePrompt: entry?.localizePrompt === true,
        nativeHistory: entry?.nativeHistory !== false,
        googleSearch: entry?.googleSearch === true,
        gemini4FamilyReplay: entry?.gemini4FamilyReplay === true,
      }
    }

    function hasAnyNativeFeature(entry) {
      return entry.localizePrompt || entry.nativeHistory || entry.googleSearch
    }

    function isGeminiProfile(providerId, profile) {
      if (typeof providerId !== 'string' || !providerId) return false
      if (profile === undefined) return providerId === 'google'
      if (!profile || typeof profile !== 'object') return false
      if (profile.api === 'google-generative-ai') {
        return typeof profile.baseURL === 'string' && /^https?:\/\//iu.test(profile.baseURL)
          && Array.isArray(profile.models) && profile.models.length > 0
      }
      return providerId === 'google' && profile.api === undefined
    }

    // Monochrome companion to the bundle icon: centered star + upper-right cross sparkle.
    function GeminiMark({ label, size = 14, strokeWidth = 1.6, className }) {
      const plusStroke = Number(Math.max(1.2, strokeWidth * 0.88).toFixed(2))
      return h('svg', {
        width: size, height: size, viewBox: '0 0 20 20', fill: 'none',
        stroke: 'currentColor', strokeWidth, strokeLinejoin: 'round',
        className,
        role: label ? 'img' : undefined,
        'aria-label': label,
        'aria-hidden': label ? undefined : 'true',
        focusable: 'false',
        style: { flexShrink: 0 },
      },
      label ? h('title', null, label) : null,
      h('path', {
        d: 'M9.2 2.8C10.24 6.32 12.82 8.9 16.34 9.94C12.82 10.98 10.24 13.56 9.2 17.08C8.16 13.56 5.58 10.98 2.06 9.94C5.58 8.9 8.16 6.32 9.2 2.8Z',
      }),
      h('path', {
        d: 'M16.1 2.2V5.6M14.4 3.9H17.8',
        strokeWidth: plusStroke,
        strokeLinecap: 'round',
        strokeOpacity: 0.82,
      }))
    }

    function CloseCircleFillIcon({ className }) {
      return h('svg', {
        width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
        className, 'aria-hidden': 'true', focusable: 'false',
      }, h('path', {
        fillRule: 'evenodd',
        clipRule: 'evenodd',
        d: 'M15 8A7 7 0 1 1 1 8A7 7 0 1 1 15 8ZM6.409 10.652L5.348 9.591L6.939 8L5.348 6.409L6.409 5.348L8 6.939L9.591 5.348L10.652 6.409L9.061 8L10.652 9.591L9.591 10.652L8 9.061Z',
        fill: 'currentColor',
      }))
    }

    function ChevronDownIcon({ className }) {
      return h('svg', {
        width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
        strokeWidth: 1, className, 'aria-hidden': 'true', focusable: 'false',
      }, h('path', { d: 'M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6', stroke: 'currentColor' }))
    }

    function ChevronUpIcon({ className }) {
      return h('svg', {
        width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
        strokeWidth: 1, className, 'aria-hidden': 'true', focusable: 'false',
      }, h('path', { d: 'M12 10L8.70711 6.70711C8.31658 6.31658 7.68342 6.31658 7.29289 6.70711L4 10', stroke: 'currentColor' }))
    }

    function ExternalLinkIcon() {
      return h('svg', {
        width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
        strokeWidth: 1.2, className: 'dsh-gn-search-link-icon', 'aria-hidden': 'true', focusable: 'false',
      },
      h('path', { d: 'M6.59961 9.40051C6.82779 9.6334 7.10015 9.81842 7.40074 9.94472C7.70132 10.071 8.02409 10.1361 8.35013 10.1361C8.67618 10.1361 8.99894 10.071 9.29953 9.94472C9.60011 9.81842 9.87247 9.6334 10.1007 9.40051L12.9015 6.59967C13.3658 6.13541 13.6266 5.50572 13.6266 4.84915C13.6266 4.19258 13.3658 3.56289 12.9015 3.09863C12.4372 2.63436 11.8075 2.37354 11.151 2.37354C10.4944 2.37354 9.86472 2.63436 9.40045 3.09863L9.05034 3.44873', stroke: 'currentColor' }),
      h('path', { d: 'M9.40051 6.59959C9.17233 6.3667 8.89997 6.18169 8.59939 6.05538C8.2988 5.92907 7.97603 5.86401 7.64999 5.86401C7.32395 5.86401 7.00118 5.92907 6.70059 6.05538C6.40001 6.18169 6.12765 6.3667 5.89946 6.59959L3.09863 9.40043C2.63436 9.8647 2.37354 10.4944 2.37354 11.151C2.37354 11.8075 2.63436 12.4372 3.09863 12.9015C3.56289 13.3657 4.19258 13.6266 4.84915 13.6266C5.50572 13.6266 6.13541 13.3657 6.59967 12.9015L6.94978 12.5514', stroke: 'currentColor' }))
    }

    function isWritableForm(snapshot) {
      return snapshot?.status === 'ready' && snapshot.writable === true && Number.isSafeInteger(snapshot.revision)
    }

    function useFormMutator(form, scope) {
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const active = React.useRef(true)
      const busyRef = React.useRef(false)
      React.useEffect(() => {
        active.current = true
        return () => { active.current = false }
      }, [])

      const run = React.useCallback(async (edit) => {
        if (busyRef.current) return false
        const current = form?.getSnapshot ? form.getSnapshot() : form?.state
        if (!isWritableForm(current)) return false
        busyRef.current = true
        setBusy(true)
        setError(null)
        try {
          // Build the operation from the same snapshot whose revision fences the write.
          const ops = typeof edit === 'function' ? edit(current) : edit
          const ok = ops !== null && await form.mutate(ops, current.revision)
          if (!active.current) return ok
          if (!ok) setError({ scope, key: 'saveConflict' })
          return ok
        } catch {
          if (active.current) setError({ scope, key: 'saveFailed' })
          return false
        } finally {
          busyRef.current = false
          if (active.current) setBusy(false)
        }
      }, [form, scope])

      return { busy, error: error && error.scope === scope ? error.key : null, run }
    }

    function isDefaultRoute(entry) {
      return entry.nativeHistory && !entry.localizePrompt && !entry.googleSearch && !entry.gemini4FamilyReplay
    }

    function updateProviderRoute(run, providerId, field, value) {
      return run(snapshot => {
        const current = routeEntryOf(snapshot.value?.routes, providerId)
        if (field === 'gemini4FamilyReplay' && value && !current.nativeHistory) return null
        const next = { ...current, [field]: value }
        const path = ['routes', providerId]
        // Unsetting re-inherits the composition, which may differ from bundle defaults.
        const base = routeEntryOf(snapshot.base?.routes, providerId)
        return [isDefaultRoute(next) && isDefaultRoute(base)
          ? { op: 'unset', path }
          : { op: 'set', path, value: next }]
      })
    }

    function ProviderCardNativeOptions({ provider, configured, t, configForm, subscribeConfig, getConfig, subscribeModels, getModels }) {
      const configSnap = React.useSyncExternalStore(subscribeConfig, getConfig)
      const modelsSnap = React.useSyncExternalStore(subscribeModels, getModels)
      const providerId = provider?.provider
      const { busy, error, run } = useFormMutator(configForm, providerId)
      const familyHelpId = React.useId()
      if (!providerId || configSnap.status !== 'ready') return null

      const routes = configSnap.value?.routes
      const current = routeEntryOf(routes, providerId)
      const hasSaved = routes != null && Object.hasOwn(routes, providerId)
      const profile = modelsSnap.status === 'ready' ? modelsSnap.value?.providers?.[providerId] : undefined
      const eligible = modelsSnap.status === 'ready'
        ? isGeminiProfile(providerId, profile)
        : (providerId === 'google' || hasSaved)

      if (!eligible && !hasSaved) return null
      if (!configured && !hasSaved) return null

      const writable = isWritableForm(configSnap)
      const disabled = !writable || busy
      const familyDisabled = disabled || !current.nativeHistory

      if (!eligible && hasSaved) {
        return h('div', { style: cardSection },
          h('div', { style: cardHeader },
            h('span', { style: cardTitle }, h(GeminiMark, { label: t('brand'), size: 13 }), t('brand')),
            h('button', {
              type: 'button',
              disabled,
              style: { ...secondaryButton, opacity: disabled ? 0.6 : 1, cursor: disabled ? 'default' : 'pointer' },
              onClick: () => run([{ op: 'unset', path: ['routes', providerId] }]),
            }, t(busy ? 'clearing' : 'clear')),
          ),
          h('p', { style: caption }, t('nonGeminiRoute')),
          error ? h('p', { role: 'alert', style: errorCaption }, t(error)) : null,
        )
      }

      const items = [
        ['localizePrompt', t('localizePrompt'), t('localizePromptTitle')],
        ['nativeHistory', t('nativeHistory'), t('nativeHistoryTitle')],
        ['googleSearch', t('googleSearch'), t('googleSearchTitle')],
      ]

      return h('div', { style: cardSection },
        h('div', { style: cardHeader },
          h('span', { style: cardTitle }, h(GeminiMark, { label: t('brand'), size: 13 }), t('brand')),
          busy
            ? h('span', { role: 'status', style: caption }, t('saving'))
            : !writable ? h('span', { style: caption }, t('readOnly')) : null,
        ),
        h('div', { style: toggleRow }, items.map(([field, label, title]) =>
          h('label', {
            key: field,
            title,
            style: { ...checkboxLabel, opacity: disabled ? 0.65 : 1, cursor: disabled ? 'default' : 'pointer' },
          },
          h('input', {
            type: 'checkbox',
            checked: current[field],
            disabled,
            onChange: event => updateProviderRoute(run, providerId, field, event.target.checked),
          }),
          h('span', null, label)))),
        h('div', { style: { marginInlineStart: 8, paddingInlineStart: 10, borderInlineStart: '1px solid var(--dsw-alias-border-l3)' } },
          h('label', {
            style: { ...checkboxLabel, flexWrap: 'wrap', opacity: familyDisabled ? 0.65 : 1, cursor: familyDisabled ? 'default' : 'pointer' },
          },
          h('input', {
            type: 'checkbox',
            checked: current.gemini4FamilyReplay,
            disabled: familyDisabled,
            'aria-describedby': familyHelpId,
            onChange: event => updateProviderRoute(run, providerId, 'gemini4FamilyReplay', event.target.checked),
          }),
          h('span', null, t('gemini4FamilyReplay')),
          h('span', { style: badgeStyle }, t('experimental'))),
          h('p', { id: familyHelpId, style: caption }, t('gemini4FamilyHelp'))),
        h('p', { style: caption }, t('nativeHistoryPrivacy')),
        current.googleSearch && !current.nativeHistory
          ? h('p', { role: 'status', style: warnCaption }, t('searchWithoutHistoryWarn'))
          : null,
        error ? h('p', { role: 'alert', style: errorCaption }, t(error)) : null,
      )
    }

    function PluginSettingsPage({ form, t, subscribeModels, getModels }) {
      const modelsSnap = React.useSyncExternalStore(subscribeModels, getModels)
      const { busy, error, run } = useFormMutator(form)
      const state = form?.state

      if (!state || state.status === 'loading') {
        return h('p', { role: 'status', style: secondary }, t('loading'))
      }
      if (state.status !== 'ready' || typeof state.revision !== 'number') {
        return h('p', { role: 'status', style: secondary }, t('unavailable'))
      }

      const writable = state.writable === true
      const disabled = !writable || busy
      const showStatusNotice = state.value?.showStatusNotice !== false
      const routes = state.value?.routes && typeof state.value.routes === 'object' ? state.value.routes : {}
      const overrides = Object.keys(routes).map(providerId => [providerId, routeEntryOf(routes, providerId)])
      const providers = modelsSnap.status === 'ready' ? (modelsSnap.value?.providers ?? {}) : null

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 680 } },
        h('div', {
          style: {
            border: '0.5px solid var(--dsw-alias-border-l3)',
            borderRadius: 'var(--dsw-radius-xl, 12px)',
            padding: '12px 14px',
            background: 'var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-base))',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          },
        },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontWeight: 500, fontSize: 14 } },
          h(GeminiMark, { label: t('brand'), size: 15 }),
          h('span', null, t('activeRoutesHeading'))),
        h('p', { style: secondary }, t('pageIntro')),
        overrides.length === 0
          ? h('p', { style: caption }, t('activeRoutesEmpty'))
          : h('ul', { style: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 } },
            overrides.map(([providerId, entry]) => {
              const profile = providers?.[providerId]
              const displayName = profile?.displayName && profile.displayName !== providerId
                ? `${profile.displayName} (${providerId})`
                : providerId
              const stale = providers !== null && !isGeminiProfile(providerId, profile)
              const tags = [
                entry.localizePrompt && t('localizePrompt'),
                t(entry.nativeHistory ? 'nativeHistory' : 'nativeHistoryOff'),
                entry.googleSearch && t('googleSearch'),
                providers !== null && !stale && entry.nativeHistory && entry.gemini4FamilyReplay && t('gemini4FamilySummary'),
              ].filter(Boolean)
              return h('li', {
                key: providerId,
                style: {
                  borderTop: '0.5px solid var(--dsw-alias-border-l3)',
                  paddingTop: 8,
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                },
              },
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
                h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 } },
                  h('span', { style: { fontSize: 13, fontWeight: 500, overflowWrap: 'anywhere' } }, displayName),
                  stale ? h('span', { style: { ...badgeStyle, color: 'var(--dsw-alias-state-warn-label)' } }, t('routeStaleTag')) : null),
                h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                  tags.map(tag => h('span', { key: tag, style: badgeStyle }, tag)))),
              stale ? h('button', {
                type: 'button',
                disabled,
                style: { ...secondaryButton, opacity: disabled ? 0.6 : 1, cursor: disabled ? 'default' : 'pointer' },
                onClick: () => run([{ op: 'unset', path: ['routes', providerId] }]),
              }, t(busy ? 'clearing' : 'clear')) : null)
            }))),

        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          h('label', { style: { ...checkboxLabel, opacity: disabled ? 0.65 : 1, cursor: disabled ? 'default' : 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: showStatusNotice,
              disabled,
              onChange: event => run([{ op: 'set', path: ['showStatusNotice'], value: event.target.checked }]),
            }),
            h('span', { style: { fontWeight: 500 } }, t('showStatusNotice'))),
          h('p', { style: secondary }, t('showStatusNoticeHelp')),
          busy ? h('p', { role: 'status', style: caption }, t('saving'))
            : !writable ? h('p', { role: 'status', style: caption }, t('readOnly')) : null,
          error ? h('p', { role: 'alert', style: errorCaption }, t(error)) : null),
      )
    }

    const emptyStatusTelemetry = { localizedProvider: null, prompt: null, transport: null }

    function statusTelemetryHooks(ctx) {
      const sessions = new Map()
      function publish(entry, value) {
        entry.value = value
        for (const changed of entry.listeners) changed()
      }
      function connect(sessionId, entry) {
        try {
          const url = new URL('./api/dsh-gemini-native/status', document.baseURI)
          if (url.origin !== window.location.origin) return
          url.searchParams.set('sessionId', sessionId)
          const source = new EventSource(url.href)
          entry.source = source
          source.onmessage = ({ data }) => {
            try {
              const parsed = JSON.parse(data)
              if (parsed && typeof parsed === 'object') {
                publish(entry, {
                  localizedProvider: typeof parsed.localizedProvider === 'string' ? parsed.localizedProvider : null,
                  prompt: parsed.prompt && typeof parsed.prompt === 'object' ? parsed.prompt : null,
                  transport: parsed.transport && typeof parsed.transport === 'object' ? parsed.transport : null,
                })
              }
            } catch {
              publish(entry, emptyStatusTelemetry)
            }
          }
          source.onerror = () => {
            if (entry.value !== emptyStatusTelemetry) publish(entry, emptyStatusTelemetry)
          }
        } catch { /* Match notice stays available without a live connection. */ }
      }
      function close(entry) {
        if (!entry.source) return
        entry.source.onmessage = entry.source.onerror = null
        entry.source.close()
        entry.source = null
      }
      ctx.effect(() => () => {
        for (const entry of sessions.values()) close(entry)
        sessions.clear()
      })
      return function useStatusTelemetry(sessionId) {
        const get = React.useCallback(() => (
          sessionId ? (sessions.get(sessionId)?.value ?? emptyStatusTelemetry) : emptyStatusTelemetry
        ), [sessionId])
        const subscribe = React.useCallback(listener => {
          if (!sessionId) return () => {}
          let entry = sessions.get(sessionId)
          if (!entry) {
            entry = { listeners: new Set(), value: emptyStatusTelemetry, source: null }
            sessions.set(sessionId, entry)
            connect(sessionId, entry)
          }
          entry.listeners.add(listener)
          return () => {
            entry.listeners.delete(listener)
            if (entry.listeners.size === 0) {
              close(entry)
              if (sessions.get(sessionId) === entry) sessions.delete(sessionId)
            }
          }
        }, [sessionId])
        return React.useSyncExternalStore(subscribe, get)
      }
    }

    let fallbackAnchorSeq = 0

    function focusWithoutScroll(ref) {
      ref.current?.focus?.({ preventScroll: true })
    }

    function useDiagDialog(resetKey, active) {
      const [open, setOpen] = React.useState(false)
      const [fallbackPos, setFallbackPos] = React.useState(null)
      const rootRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const triggerRef = React.useRef(null)
      const anchorSeqRef = React.useRef(null)
      const reactId = typeof React.useId === 'function' ? React.useId().replaceAll(':', '') : null
      if (!reactId && !anchorSeqRef.current) anchorSeqRef.current = `gn${++fallbackAnchorSeq}`
      const anchorName = `--dsh-gn-diag-${reactId ?? anchorSeqRef.current}`
      const supportsAnchor = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('anchor-name', '--a')

      React.useEffect(() => {
        setOpen(false)
      }, [resetKey])

      React.useEffect(() => {
        if (!active || !open || typeof document === 'undefined') return
        const isInside = target => {
          if (!target) return false
          if (typeof Node !== 'undefined' && !(target instanceof Node)) return false
          return rootRef.current?.contains?.(target) === true || panelRef.current?.contains?.(target) === true
        }
        const onKeyDown = e => {
          if (e?.key !== 'Escape') return
          if (isInside(document.activeElement)) focusWithoutScroll(triggerRef)
          setOpen(false)
        }
        const onPointerDown = e => {
          if (!isInside(e?.target)) setOpen(false)
        }
        const onClickCapture = e => {
          if (!isInside(e?.target)) setOpen(false)
        }
        document.addEventListener?.('keydown', onKeyDown)
        document.addEventListener?.('pointerdown', onPointerDown)
        document.addEventListener?.('click', onClickCapture, true)
        return () => {
          document.removeEventListener?.('keydown', onKeyDown)
          document.removeEventListener?.('pointerdown', onPointerDown)
          document.removeEventListener?.('click', onClickCapture, true)
        }
      }, [active, open])

      const useLayout = React.useLayoutEffect || React.useEffect
      // The portal is appended to body, outside the trigger's document tab order.
      useLayout(() => {
        if (active && open) focusWithoutScroll(panelRef)
      }, [active, open])
      useLayout(() => {
        if (!open || supportsAnchor || typeof window === 'undefined') {
          if (!open) setFallbackPos(null)
          return
        }
        const update = () => {
          const rect = rootRef.current?.getBoundingClientRect?.()
          if (!rect) return
          const vw = Number.isFinite(window.innerWidth) ? window.innerWidth : 1024
          const vh = Number.isFinite(window.innerHeight) ? window.innerHeight : 768
          // Match the panel's CSS max width and leave the right gutter intact.
          const left = Math.max(12, Math.min(rect.left, vw - 432))
          const bottom = Math.max(12, vh - rect.top + 8)
          setFallbackPos({ left, bottom })
        }
        update()
        window.addEventListener?.('resize', update)
        return () => window.removeEventListener?.('resize', update)
      }, [open, supportsAnchor])

      return { open, setOpen, rootRef, panelRef, triggerRef, anchorName, supportsAnchor, fallbackPos }
    }

    function collectWarnings(transport, t) {
      if (!transport) return []
      const warnings = []
      if (transport.status === 'url-mismatch') warnings.push(t('diagWarnUrlMismatch'))
      if (transport.recordStatus === 'overflow') warnings.push(t('diagWarnRecordOverflow'))
      if (transport.recordStatus === 'invalid') warnings.push(t('diagWarnRecordInvalid'))
      if (transport.searchMode === 'skipped') warnings.push(t('diagWarnSearchSkipped'))
      return warnings
    }

    function buildDiagnosticRows({ routeCfg, diag, activePrompt, activeTransport, t }) {
      const rows = []

      if (routeCfg.localizePrompt) {
        let value
        let sub = null
        if (activePrompt) {
          value = fmt(t('diagPromptMatchedTpl'), { matched: activePrompt.matched ?? 0, total: activePrompt.total ?? 0 })
          if (Array.isArray(activePrompt.missedBuiltins) && activePrompt.missedBuiltins.length > 0) {
            sub = fmt(t('diagPromptMissedTpl'), { names: activePrompt.missedBuiltins.join(', ') })
          }
        } else if (diag?.promptLocalizedInLog === true) {
          value = t('diagPromptLogZh')
        } else if (diag?.promptLocalizedInLog === false) {
          value = t('diagPromptLogEn')
        } else {
          value = t('diagPromptPending')
        }
        rows.push({ key: 'prompt', label: t('diagPromptLabel'), value, sub })
      }

      const recordedBytes = activeTransport?.recordStatus === 'saved' ? activeTransport.recordedBytes ?? 0 : 0
      if (routeCfg.nativeHistory || diag?.hasNativePayload) {
        let value
        let sub
        const total = activeTransport?.totalHistoryTurns
        const replayed = activeTransport?.replayedHistoryTurns
        const current = activeTransport?.currentModelHistoryTurns
        const hasReplayCounts = Number.isSafeInteger(total) && total >= 0
          && Number.isSafeInteger(replayed) && replayed >= 0 && replayed <= total
        if (hasReplayCounts && total === 0) {
          value = t('diagHistoryNoHistory')
        } else if (hasReplayCounts) {
          const same = activeTransport?.sameModelReplayedTurns
          const cross = activeTransport?.crossModelReplayedTurns
          const legacy = same === undefined && cross === undefined
          const hasSplit = Number.isSafeInteger(same) && same >= 0
            && Number.isSafeInteger(cross) && cross >= 0 && same === replayed - cross
          // Legacy Hosts only replayed same-model history. A partial or invalid
          // new snapshot cannot make that claim, even if it has a `current` count.
          const sameHits = legacy ? replayed : same
          const crossHits = legacy ? 0 : cross
          const classified = (legacy || hasSplit) && Number.isSafeInteger(current)
            && sameHits <= current && current <= total - crossHits
          const details = []
          if (hasSplit && cross > 0) {
            value = fmt(t('diagHistoryReplayTpl'), { replayed, total })
            details.push(fmt(t('diagHistorySameModelHitsTpl'), { count: same }), fmt(t('diagHistoryCrossModelHitsTpl'), { count: cross }))
          } else if (classified) {
            value = current === 0 ? t('diagHistoryNoCurrent')
              : fmt(t('diagHistoryCurrentReplayTpl'), { replayed, total: current })
          } else {
            value = fmt(t('diagHistoryReplayTpl'), { replayed, total })
          }
          if (classified) {
            const otherMisses = total - current - crossHits
            const sameMisses = current - sameHits
            if (otherMisses > 0) details.push(fmt(t('diagHistoryOtherModelTpl'), { count: otherMisses }))
            if (sameMisses > 0) details.push(fmt(t('diagHistoryUnmatchedTpl'), { count: sameMisses }))
          } else if (replayed < total) {
            details.push(fmt(t('diagHistoryUnclassifiedTpl'), { count: total - replayed }))
          }
          sub = details.join(' · ')
        } else if ((diag?.assistantSteps ?? 0) > 0) {
          if (diag.nativeSteps > 0) {
            value = fmt(t('diagHistoryDurableTpl'), {
              recorded: diag.nativeSteps,
              total: diag.assistantSteps,
              size: formatBytes(diag.nativeBytes ?? 0),
            })
            sub = routeCfg.nativeHistory ? t('diagHistoryNoStats') : undefined
          } else {
            value = recordedBytes > 0
              ? fmt(t('diagHistoryLastRecordingTpl'), { size: formatBytes(recordedBytes) })
              : t('diagHistoryNoneInSession')
          }
        } else if (recordedBytes > 0) {
          value = fmt(t('diagHistoryLastRecordingTpl'), { size: formatBytes(recordedBytes) })
        } else {
          value = t('diagHistoryEmpty')
        }
        if (hasReplayCounts) {
          const size = (diag?.nativeBytes ?? 0) > 0 ? fmt(t('diagHistoryCumulativeTpl'), { size: formatBytes(diag.nativeBytes) })
            : recordedBytes > 0 ? fmt(t('diagHistoryLastRecordingTpl'), { size: formatBytes(recordedBytes) }) : null
          if (size) value += ` · ${size}`
        }
        rows.push({ key: 'history', label: t('diagHistoryLabel'), value, sub })
        rows.push({
          key: 'logUpload',
          label: t('diagLogUploadLabel'),
          value: diag?.hasNativePayload ? t('diagLogExcluded') : t('diagLogAutoExclude'),
        })
      }

      if (routeCfg.googleSearch || (diag?.searchCards ?? 0) > 0) {
        let value
        if (activeTransport?.searchInjected) {
          const modeText = activeTransport.searchMode === 'mixed'
            ? fmt(t('diagSearchMixedTpl'), { count: activeTransport.localToolCount ?? 0 })
            : t('diagSearchOnly')
          value = (diag?.searchCards ?? 0) > 0
            ? `${modeText} · ${fmt(t('diagSearchSessionCountTpl'), { cards: diag.searchCards })}`
            : modeText
        } else if ((diag?.searchCards ?? 0) > 0) {
          value = fmt(t('diagSearchDurableSummaryTpl'), {
            cards: diag.searchCards,
            queries: diag.searchQueries ?? 0,
            sources: diag.searchSources ?? 0,
          })
        } else if (activeTransport?.searchMode === 'skipped') {
          value = t('diagSearchSkippedValue')
        } else {
          value = t('diagSearchReady')
        }
        rows.push({ key: 'search', label: t('diagSearchLabel'), value })
      }

      return rows
    }

    const noSearchCards = []
    const emptySearchActivity = { running: false, turns: new Map() }

    function selectActivity(value, previous) {
      const turns = new Map()
      let running = false
      for (const card of value.cards) {
        if (!Number.isSafeInteger(card?.turn) || !Array.isArray(card.queries) || !Array.isArray(card.sources)) continue
        if (card.turn === value.liveTurn) {
          running ||= card.status === 'running'
          continue
        }
        const group = turns.get(card.turn)
        if (group) group.push(card)
        else turns.set(card.turn, [card])
      }
      for (const [turn, group] of turns) {
        const prior = previous.turns.get(turn)
        if (prior && JSON.stringify(prior) === JSON.stringify(group)) turns.set(turn, prior)
      }
      return { running, turns }
    }

    function safeSourceURL(raw) {
      try {
        const url = new URL(raw)
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href
      } catch { /* Untrusted provider data. */ }
    }

    function isRedirectSearchHost(host) {
      if (typeof host !== 'string' || !host) return false
      const lower = host.toLowerCase()
      return lower === 'vertexaisearch.cloud.google.com' || lower.endsWith('.vertexaisearch.cloud.google.com')
    }

    function GoogleSearchCard({ cards, t }) {
      const [open, setOpen] = React.useState(false)
      const complete = cards.some(card => card.status === 'completed')
      const unconfirmed = cards.some(card => card.status !== 'completed')
      const status = t(unconfirmed ? (complete ? 'activityPartial' : 'activityIncomplete') : 'activityCompleted')
      const queries = [...new Set(cards.flatMap(card => card.queries))].slice(0, 12)
      const links = new Map()
      for (const { sources } of cards) for (const source of sources) {
        const href = safeSourceURL(source?.url)
        if (!href || links.has(href) || links.size >= 8) continue
        const host = new URL(href).hostname
        const redirectHost = isRedirectSearchHost(host)
        const rawTitle = typeof source?.title === 'string' ? source.title.trim() : ''
        const title = rawTitle || (redirectHost ? t('activitySourceFallback') : host)
        const showHost = !redirectHost && Boolean(rawTitle) && host !== rawTitle
        links.set(href, { href, host, title, showHost })
      }
      const sources = [...links.values()]
      const hasBody = queries.length > 0 || sources.length > 0
      const counts = [queries.length && `${t('activityQueries')} ${queries.length}`, sources.length && `${t('activitySourceCount')} ${sources.length}`].filter(Boolean)
      const summaryText = [unconfirmed || counts.length === 0 ? status : null, ...counts].filter(Boolean).join(' · ')

      const leading = open && hasBody
        ? h(ChevronUpIcon)
        : hasBody
          ? h(React.Fragment, null,
            h('span', { className: 'dsh-gn-search-icon-idle' }, h(GeminiMark)),
            h(ChevronDownIcon, { className: 'dsh-gn-search-chevron-hover' }))
          : h(GeminiMark)

      const rowContent = [
        h('span', { key: 'leading', className: 'dsh-gn-search-leading' }, leading),
        h('span', { key: 'title', className: 'dsh-gn-search-title' }, t('activityTitle')),
        h('span', { key: 'dot', className: 'dsh-gn-search-dot', 'aria-hidden': 'true' }),
        h('span', { key: 'summary', className: 'dsh-gn-search-summary' }, summaryText),
      ]

      const header = hasBody
        ? h('button', {
          type: 'button',
          className: 'dsh-gn-search-row',
          'data-expandable': 'true',
          'aria-expanded': open,
          onClick: () => setOpen(prev => !prev),
        }, ...rowContent)
        : h('div', { className: 'dsh-gn-search-row' }, ...rowContent)

      return h('div', { className: 'dsh-gn-search-root', 'data-open': open && hasBody ? 'true' : undefined },
        header,
        open && hasBody ? h('div', { className: 'dsh-gn-search-body', 'data-web': 'search' },
          queries.length > 0 && h('div', { className: 'dsh-gn-search-section' },
            h('div', { className: 'dsh-gn-search-section-label' }, t('activityQueries')),
            h('div', { className: 'dsh-gn-search-queries' },
              queries.map(query => h('span', { key: query, className: 'dsh-gn-search-query-tag' }, query)))),
          sources.length > 0 && h('div', { className: 'dsh-gn-search-section' },
            h('div', { className: 'dsh-gn-search-section-label' }, t('activitySources')),
            h('ol', { className: 'dsh-gn-search-sources' },
              sources.map((source, index) => h('li', { key: source.href, value: index + 1, className: 'dsh-gn-search-source-item' },
                h('a', {
                  href: source.href,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  className: 'dsh-gn-search-source-link',
                }, h(ExternalLinkIcon), source.title),
                source.showHost && h('span', { className: 'dsh-gn-search-source-host' }, source.host)))))) : null)
    }

    // The live composer and visible history rows share one stream per session.
    function searchActivityHooks(ctx) {
      const sessions = new Map()
      function publish(entry, value) {
        entry.value = value
        for (const changed of entry.listeners) changed()
      }
      function connect(sessionId, entry) {
        try {
          const url = new URL('./api/dsh-gemini-native/search-activity', document.baseURI)
          if (url.origin !== window.location.origin) return
          url.searchParams.set('sessionId', sessionId)
          const source = new EventSource(url.href)
          entry.source = source
          source.onmessage = ({ data }) => {
            try {
              const value = JSON.parse(data)
              if (!Array.isArray(value?.cards)) return
              publish(entry, selectActivity(value, entry.value))
            } catch { /* A bad presentation message must not affect chat. */ }
          }
          source.onerror = () => {
            if (entry.value.running) publish(entry, { ...entry.value, running: false })
          }
        } catch { /* Chat remains available without the presentation route. */ }
      }
      function close(entry) {
        if (!entry.source) return
        entry.source.onmessage = entry.source.onerror = null
        entry.source.close()
      }
      ctx.effect(() => () => {
        for (const entry of sessions.values()) close(entry)
        sessions.clear()
      })
      return function useSearchActivity(sessionId, turn) {
        const get = React.useCallback(() => {
          const value = sessions.get(sessionId)?.value ?? emptySearchActivity
          return turn === undefined ? value.running : value.turns.get(turn) ?? noSearchCards
        }, [sessionId, turn])
        const subscribe = React.useCallback(listener => {
          if (!sessionId) return () => {}
          let entry = sessions.get(sessionId)
          if (!entry) {
            entry = { listeners: new Set(), value: emptySearchActivity }
            sessions.set(sessionId, entry)
            connect(sessionId, entry)
          }
          entry.listeners.add(listener)
          return () => {
            entry.listeners.delete(listener)
            if (entry.listeners.size === 0) {
              close(entry)
              if (sessions.get(sessionId) === entry) sessions.delete(sessionId)
            }
          }
        }, [sessionId])
        return React.useSyncExternalStore(subscribe, get)
      }
    }

    // Session-level XHigh toggle state synced via SSE + POST without touching native modelSelection.
    function xhighHooks(ctx) {
      const sessions = new Map()
      function resolveURL() {
        const url = new URL('./api/dsh-gemini-native/xhigh', document.baseURI)
        if (url.origin !== window.location.origin) return null
        return url
      }
      function publish(entry, enabled) {
        const next = enabled === true
        if (entry.value === next) return
        entry.value = next
        for (const changed of entry.listeners) changed()
      }
      function connect(sessionId, entry) {
        try {
          const url = resolveURL()
          if (!url) return
          url.searchParams.set('sessionId', sessionId)
          const source = new EventSource(url.href)
          entry.source = source
          source.onmessage = ({ data }) => {
            try {
              const parsed = JSON.parse(data)
              if (typeof parsed?.enabled === 'boolean') publish(entry, parsed.enabled)
            } catch { /* A bad xhigh frame must not affect chat. */ }
          }
          source.onerror = () => { /* EventSource reconnects automatically and Host pushes current state. */ }
        } catch { /* Chat remains available without the xhigh route. */ }
      }
      function close(entry) {
        if (!entry.source) return
        entry.source.onmessage = entry.source.onerror = null
        entry.source.close()
        entry.source = null
      }
      ctx.effect(() => () => {
        for (const entry of sessions.values()) close(entry)
        sessions.clear()
      })
      function useXHigh(sessionId) {
        const get = React.useCallback(() => (
          sessionId ? (sessions.get(sessionId)?.value === true) : false
        ), [sessionId])
        const subscribe = React.useCallback(listener => {
          if (!sessionId) return () => {}
          let entry = sessions.get(sessionId)
          if (!entry) {
            entry = { listeners: new Set(), value: false, source: null }
            sessions.set(sessionId, entry)
            connect(sessionId, entry)
          }
          entry.listeners.add(listener)
          return () => {
            entry.listeners.delete(listener)
            if (entry.listeners.size === 0) {
              close(entry)
              if (sessions.get(sessionId) === entry) sessions.delete(sessionId)
            }
          }
        }, [sessionId])
        return React.useSyncExternalStore(subscribe, get)
      }
      async function setXHigh(sessionId, enabled) {
        if (!sessionId) return false
        try {
          const url = resolveURL()
          if (!url) return false
          const response = await fetch(url.href, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, enabled: enabled === true }),
          })
          if (!response?.ok) return false
          const payload = await response.json()
          if (typeof payload?.enabled !== 'boolean') return false
          const entry = sessions.get(sessionId)
          if (entry) publish(entry, payload.enabled)
          return true
        } catch {
          return false
        }
      }
      return { useXHigh, setXHigh }
    }

    const emptyModelStore = { subscribe: () => () => {}, getSnapshot: () => undefined }
    const emptyHook = () => undefined

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        const config = ctx.configForms.get(pluginId)
        const subscribe = config.subscribe.bind(config)
        const getSnapshot = config.getSnapshot.bind(config)
        const useSearchActivity = searchActivityHooks(ctx)
        const useStatusTelemetry = statusTelemetryHooks(ctx)
        const { useXHigh, setXHigh } = xhighHooks(ctx)
        const modelsForm = ctx.configForms.get('llm-pi-ai')
        const subscribeModels = modelsForm.subscribe.bind(modelsForm)
        const getModels = modelsForm.getSnapshot.bind(modelsForm)

        ctx.effect(() => {
          if (typeof document === 'undefined' || !document?.head || typeof document.createElement !== 'function') return
          const existing = document.head.querySelector?.(`style[data-plugin="${pluginId}"]`)
          if (existing?.remove) existing.remove()
          const styleEl = document.createElement('style')
          styleEl.setAttribute?.('data-plugin', pluginId)
          if (styleEl.dataset && !styleEl.getAttribute?.('data-plugin')) styleEl.dataset.plugin = pluginId
          styleEl.textContent = pluginStyles
          document.head.appendChild(styleEl)
          return () => {
            if (typeof styleEl.remove === 'function') styleEl.remove()
            else styleEl.parentNode?.removeChild?.(styleEl)
          }
        })

        function LiveSearchActivity({ sessionId, t }) {
          if (!useSearchActivity(sessionId)) return null
          return h('span', { className: 'dsh-gn-dock-anchor' },
            h('span', { role: 'status', className: 'dsh-gn-dock-pill' },
              h('span', { className: 'dsh-gn-dock-label' }, t('activityLive'))))
        }

        function TurnSearchCards({ sessionId, turn, t, useProjection }) {
          const turnNumber = typeof turn === 'number' ? turn : turn?.turn
          const durable = useProjection('geminiNativeSearchActivity', value => value?.[turnNumber] ?? noSearchCards)
          const temporary = useSearchActivity(sessionId, turnNumber)
          // The card deduplicates queries and links. Use the live cache as
          // well when a retry or oversized attempt produced no durable card.
          const cards = durable.length && temporary.length ? [...durable, ...temporary]
            : durable.length ? durable : temporary
          return cards.length ? h(GoogleSearchCard, { cards, t }) : null
        }

        function NativeStatusNotice({ sessionId, useProjection, modelStore = emptyModelStore, t }) {
          const snapshot = React.useSyncExternalStore(subscribe, getSnapshot)
          const modelsSnap = React.useSyncExternalStore(subscribeModels, getModels)
          const selected = useProjection('modelSelection', selection => selection?.next)
          const rawDiag = useProjection('geminiNativeDiagnostics')
          const modelState = React.useSyncExternalStore(modelStore.subscribe, modelStore.getSnapshot)
          // The projection has no saved choice in a new chat using the profile
          // default. Use the same directory as the picker for that fallback.
          const selectedObj = selected && typeof selected === 'object' ? selected : null
          const legacyProvider = typeof selected === 'string' ? selected : undefined
          const provider = selectedObj?.provider ?? legacyProvider ?? modelState?.current?.provider
          const model = selectedObj?.model ?? modelState?.current?.model
          const { busy, error, run } = useFormMutator(config, JSON.stringify([sessionId, provider, model]))

          const profile = modelsSnap.status === 'ready' ? modelsSnap.value?.providers?.[provider] : undefined
          const ready = snapshot.status === 'ready' && snapshot.value?.showStatusNotice !== false
            && Boolean(sessionId) && isGeminiProfile(provider, profile)
          const routeCfg = ready ? routeEntryOf(snapshot.value?.routes, provider) : emptyRouteEntry
          const active = ready && hasAnyNativeFeature(routeCfg)

          const telemetry = useStatusTelemetry(active ? sessionId : null)
          const {
            open, setOpen, rootRef, panelRef, triggerRef, anchorName, supportsAnchor, fallbackPos,
          } = useDiagDialog(`${sessionId ?? ''}:${provider ?? ''}`, active)

          if (!active) return null

          const diag = rawDiag && typeof rawDiag === 'object' && !Array.isArray(rawDiag) ? rawDiag : null
          const localized = telemetry.localizedProvider === provider
          const activePrompt = telemetry.prompt?.provider === provider ? telemetry.prompt : null
          const activeTransport = telemetry.transport?.provider === provider
            && (!model || telemetry.transport.model === model) ? telemetry.transport : null

          const segments = [
            routeCfg.localizePrompt && t(localized ? 'statusLocalized' : 'statusLocalizationOn'),
            routeCfg.nativeHistory && t('statusNativeHistory'),
            routeCfg.googleSearch && t('statusGoogleSearch'),
          ].filter(Boolean)
          const summaryText = segments.join(' · ')
          const labelChildren = []
          segments.forEach((seg, index) => {
            if (index > 0) labelChildren.push(h('span', { key: `sep-${index}`, className: 'dsh-gn-dock-sep', 'aria-hidden': 'true' }, '·'))
            labelChildren.push(seg)
          })

          // The Host reports correlation, not causation. Keep using the latest scoped
          // request snapshot: the next request clears this alert without client retries.
          const crossModelHttp400 = activeTransport?.crossModelHttp400 === true
          const warnings = collectWarnings(activeTransport, t)
          const hasWarning = crossModelHttp400 || warnings.length > 0

          const canPortal = open && typeof ReactDOM?.createPortal === 'function' && typeof document !== 'undefined' && Boolean(document.body)
          let dialogPortal = null
          if (canPortal) {
            const writable = isWritableForm(snapshot)
            const candidates = activeTransport?.crossModelCandidateTurns
            const offerFamilyReplay = !crossModelHttp400 && writable && routeCfg.nativeHistory
              && !routeCfg.gemini4FamilyReplay && supportsGemini4FamilyReplay(model)
              && Number.isSafeInteger(candidates) && candidates > 0
            const familyScopeId = `${anchorName}-family-scope`
            const familyRiskId = `${anchorName}-family-risk`
            const familyAction = enabled => h('div', { className: 'dsh-gn-diag-action' },
              h('button', {
                type: 'button',
                disabled: busy,
                'aria-busy': busy || undefined,
                'aria-describedby': enabled ? `${familyRiskId} ${familyScopeId}` : familyScopeId,
                style: { ...secondaryButton, opacity: busy ? 0.6 : 1, cursor: busy ? 'default' : 'pointer' },
                onClick: () => {
                  // Saving disables this button and an accepted write can remove it.
                  focusWithoutScroll(panelRef)
                  return updateProviderRoute(run, provider, 'gemini4FamilyReplay', enabled)
                },
              }, t(enabled ? 'diagFamilyEnable' : 'diagFamilyDisable')),
              enabled ? h('span', { id: familyRiskId, className: 'dsh-gn-diag-sub' }, t('diagFamilyRisk')) : null,
              h('span', { id: familyScopeId, className: 'dsh-gn-diag-sub' }, t('diagFamilyScope')),
              busy ? h('span', { role: 'status', style: caption }, t('saving')) : null,
              error ? h('span', { role: 'alert', style: errorCaption }, t(error)) : null)
            const modelId = activeTransport?.model || model
            const group = modelState?.groups?.find(entry => entry.id === provider)
            const catalogModel = group?.models.find(entry => entry.id === modelId)
            const configuredModel = profile?.models?.find(entry => entry.id === modelId)
            const providerLabel = group?.name || profile?.displayName || provider
            const modelLabel = catalogModel?.name || configuredModel?.name || modelId
            const routeLabel = modelLabel ? `${providerLabel} / ${modelLabel}` : providerLabel
            const routeId = modelId ? `${provider}/${modelId}` : provider
            const hasDisplayName = providerLabel !== provider || modelLabel !== modelId
            const routeTitle = hasDisplayName ? `${routeLabel}\n${routeId}` : routeId
            const rows = buildDiagnosticRows({ routeCfg, diag, activePrompt, activeTransport, t })
            const hasLiveTelemetry = Boolean(activePrompt || activeTransport)
            const hasDurableStats = Boolean(
              diag && (
                (diag.assistantSteps ?? 0) > 0
                || (diag.searchCards ?? 0) > 0
                || diag.hasNativePayload
                || (diag.promptLocalizedInLog !== undefined && diag.promptLocalizedInLog !== null)
              ),
            )
            const panelStyle = supportsAnchor
              ? { positionAnchor: anchorName }
              : fallbackPos
                ? { top: 'auto', right: 'auto', left: `${fallbackPos.left}px`, bottom: `${fallbackPos.bottom}px` }
                : { top: 'auto', right: 'auto', left: '12px', bottom: '56px' }

            dialogPortal = ReactDOM.createPortal(
              h('div', {
                ref: panelRef,
                className: 'dsh-gn-diag-panel',
                role: 'dialog',
                tabIndex: -1,
                'aria-label': t('brand'),
                style: panelStyle,
              },
              h('div', { className: 'dsh-gn-diag-title' },
                h('span', { className: 'dsh-gn-diag-title-label' },
                  h(GeminiMark, { size: 14, strokeWidth: 1.6 }),
                  h('span', null, t('brand'))),
                h('span', { className: 'dsh-gn-diag-route', title: routeTitle }, routeLabel)),
              h('div', { className: 'dsh-gn-diag-rule', 'aria-hidden': 'true' }),
              hasWarning ? h('div', { className: 'dsh-gn-diag-warns' },
                crossModelHttp400 ? h('div', { className: 'dsh-gn-diag-warn' },
                  h('div', { role: 'alert' }, t(routeCfg.gemini4FamilyReplay ? 'diagWarnCrossModel400' : 'diagWarnCrossModel400Closed')),
                  routeCfg.gemini4FamilyReplay ? (writable ? familyAction(false) : null)
                    : h('div', { role: 'status', className: 'dsh-gn-diag-sub' }, t('diagFamilyDisabled'))) : null,
                warnings.map((message, index) => h('div', { key: index, role: 'alert', className: 'dsh-gn-diag-warn' }, message))) : null,
              rows.length > 0 ? h('dl', { className: 'dsh-gn-diag-details' },
                rows.map(row => h(React.Fragment, { key: row.key },
                  h('dt', null, row.label),
                  h('dd', null,
                    h('span', null, row.value),
                    row.sub ? h('div', { className: 'dsh-gn-diag-sub' }, row.sub) : null,
                    row.key === 'history' && offerFamilyReplay ? h(React.Fragment, null,
                      h('div', { className: 'dsh-gn-diag-sub' }, fmt(t('diagFamilyCandidatesTpl'), { count: candidates })),
                      familyAction(true)) : null)))) : null,
              !hasLiveTelemetry && !hasDurableStats
                ? h('p', { className: 'dsh-gn-diag-hint' }, t('diagEmptyHint'))
                : null),
              document.body,
            )
          }

          return h('span', {
            ref: rootRef,
            className: 'dsh-gn-dock-anchor',
            style: supportsAnchor ? { anchorName } : undefined,
          },
          h('button', {
            ref: triggerRef,
            type: 'button',
            className: 'dsh-gn-dock-pill',
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            'aria-label': hasWarning ? `${summaryText} (${t('diagWarningBadge')})` : summaryText,
            onClick: () => setOpen(prev => !prev),
          },
          h(GeminiMark, { size: 14, strokeWidth: 1.6 }),
          h('span', { className: 'dsh-gn-dock-label' }, ...labelChildren),
          hasWarning ? h('span', { className: 'dsh-gn-dock-warn-dot', 'aria-hidden': 'true' }) : null),
          dialogPortal)
        }

        function useXHighEligibility({
          sessionId,
          useProjection,
          useSession = emptyHook,
          useSessions = emptyHook,
          modelStore = emptyModelStore,
          modelSelectionAvailable = true,
        }) {
          const isSubagent = useSession(snapshot => snapshot?.subagent != null) === true
          const removed = useSession(snapshot => snapshot?.removed === true) === true
          const isListedSubagent = useSessions(state => state?.byId?.[sessionId]?.origin === 'subagent') === true
          const selected = useProjection('modelSelection', selection => selection?.next)
          const modelState = React.useSyncExternalStore(modelStore.subscribe, modelStore.getSnapshot)
          const modelsSnap = React.useSyncExternalStore(subscribeModels, getModels)

          const selectedObj = selected && typeof selected === 'object' ? selected : null
          const legacyProvider = typeof selected === 'string' ? selected : undefined
          const provider = selectedObj?.provider ?? legacyProvider ?? modelState?.current?.provider
          const model = selectedObj?.model ?? modelState?.current?.model
          const profile = modelsSnap.status === 'ready' ? modelsSnap.value?.providers?.[provider] : undefined
          const isGeminiRoute = Boolean(provider) && (
            modelsSnap.status === 'ready'
              ? isGeminiProfile(provider, profile)
              : provider === 'google'
          )
          const eligible = Boolean(sessionId)
            && modelSelectionAvailable !== false
            && !isSubagent
            && !isListedSubagent
            && isGeminiRoute
            && supportsXHighModel(model)

          return { eligible, removed }
        }

        function useXHighController({ sessionId, eligible, removed, onFailure }) {
          const enabled = useXHigh(eligible ? sessionId : null)
          const [busy, setBusy] = React.useState(false)
          const busyRef = React.useRef(false)
          const activeRef = React.useRef(true)
          const reqSeqRef = React.useRef(0)

          React.useEffect(() => {
            activeRef.current = true
            return () => { activeRef.current = false }
          }, [])

          React.useEffect(() => {
            reqSeqRef.current += 1
            busyRef.current = false
            setBusy(false)
          }, [sessionId])

          const setEnabled = React.useCallback(async nextValue => {
            if (busyRef.current || removed || !sessionId) return false
            const reqSeq = ++reqSeqRef.current
            busyRef.current = true
            setBusy(true)
            try {
              const ok = await setXHigh(sessionId, nextValue)
              if (!ok && activeRef.current && reqSeqRef.current === reqSeq) onFailure?.()
              return ok
            } finally {
              if (reqSeqRef.current === reqSeq) {
                busyRef.current = false
                if (activeRef.current) setBusy(false)
              }
            }
          }, [sessionId, removed, onFailure])

          return { enabled, busy, setEnabled }
        }

        function XHighModelOption({
          sessionId,
          locked = false,
          reportFailure,
          useProjection,
          useSession = emptyHook,
          useSessions = emptyHook,
          modelStore = emptyModelStore,
          modelSelectionAvailable = true,
          t,
        }) {
          const { eligible, removed } = useXHighEligibility({
            sessionId, useProjection, useSession, useSessions, modelStore, modelSelectionAvailable,
          })
          const onFailure = React.useCallback(() => {
            reportFailure?.(t('xhighToggleFailed'))
          }, [reportFailure, t])
          const { enabled, busy, setEnabled } = useXHighController({ sessionId, eligible, removed, onFailure })

          if (!eligible) return null

          const label = t('xhighOptionLabel')
          const tooltip = t('xhighOptionTitle')
          const disabled = Boolean(locked) || busy || removed
          return h('div', { className: 'dsh-gn-model-opt-row', title: tooltip },
            h('span', { className: 'dsh-gn-model-opt-label' }, label),
            h('button', {
              type: 'button',
              role: 'switch',
              className: 'dsh-gn-model-opt-switch',
              'aria-checked': enabled,
              'aria-label': label,
              'aria-busy': busy || undefined,
              title: tooltip,
              disabled,
              onClick: () => setEnabled(!enabled),
            }, h('span', { className: 'dsh-gn-model-opt-thumb', 'aria-hidden': 'true' })))
        }

        function XHighActiveChip({
          sessionId,
          useProjection,
          useSession = emptyHook,
          useSessions = emptyHook,
          modelStore = emptyModelStore,
          modelSelectionAvailable = true,
          t,
        }) {
          const { eligible, removed } = useXHighEligibility({
            sessionId, useProjection, useSession, useSessions, modelStore, modelSelectionAvailable,
          })
          const [failed, setFailed] = React.useState(false)
          const onFailure = React.useCallback(() => setFailed(true), [])
          const { enabled, busy, setEnabled } = useXHighController({ sessionId, eligible, removed, onFailure })

          React.useEffect(() => {
            setFailed(false)
          }, [sessionId, enabled])

          if (!eligible || !enabled) return null

          const tooltip = t('xhighOnTitle')
          return h('span', { className: 'dsh-gn-xhigh-wrap' },
            h('button', {
              type: 'button',
              className: 'dsh-gn-xhigh',
              'aria-busy': busy || undefined,
              'aria-label': tooltip,
              title: tooltip,
              disabled: busy || removed,
              onMouseDown: event => event.preventDefault(),
              onClick: () => {
                setFailed(false)
                return setEnabled(false)
              },
            },
            h('span', { className: 'dsh-gn-xhigh-glyph', 'aria-hidden': 'true' },
              h(GeminiMark, { size: 14, strokeWidth: 1.6, className: 'dsh-gn-xhigh-rest-glyph' }),
              h(CloseCircleFillIcon, { className: 'dsh-gn-xhigh-hover-glyph' })),
            h('span', null, t('xhighLabel'))),
            failed ? h('span', { className: 'dsh-gn-xhigh-error', role: 'status' }, t('xhighToggleFailed')) : null)
        }

        ctx.effect(() => ctx.locale.register(namespace, { en, zh }))
        ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
          name: 'settings.models.provider-card', key: 'llm-pi-ai', locale: namespace,
        }, props => h(ProviderCardNativeOptions, {
          ...props,
          configForm: config,
          subscribeConfig: subscribe,
          getConfig: getSnapshot,
          subscribeModels,
          getModels,
        })))
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config', key: `${pluginId}#${pluginId}`, locale: namespace,
        }, ({ view, form, t }) => view === 'page' ? h(PluginSettingsPage, { form, t, subscribeModels, getModels }) : null))
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: `${pluginId}-search-live`, order: 3, locale: namespace,
        }, LiveSearchActivity))
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail', id: `${pluginId}-search-cards`, locale: namespace,
        }, TurnSearchCards))
        ctx.inject(['modelDirectories'], scope => {
          const models = scope.modelDirectories
          const sessions = scope.get?.('sessions') ?? scope.sessions
          const injectModelStore = sessionId => {
            if (!sessionId) return {}
            try { return { modelStore: models.directoryFor(sessionId).store } }
            catch { return {} }
          }
          const injectXHighContext = sessionId => ({
            ...injectModelStore(sessionId),
            modelSelectionAvailable: !sessionId || sessions?.subagentAddress?.(sessionId) === undefined,
          })
          scope.slots.inject('conversation.composer.dock', () => scope.slots.register({
            name: 'conversation.composer.dock', id: `${pluginId}-notice`, order: 2, locale: namespace,
            inject: injectModelStore,
          }, NativeStatusNotice))
          scope.slots.inject('conversation.input.model.options', () => scope.slots.register({
            name: 'conversation.input.model.options', id: `${pluginId}-xhigh`, order: -10, locale: namespace,
            inject: injectXHighContext,
          }, XHighModelOption))
          scope.slots.inject('conversation.input.right', () => scope.slots.register({
            name: 'conversation.input.right', id: `${pluginId}-xhigh`, order: 100, locale: namespace,
            inject: injectXHighContext,
          }, XHighActiveChip))
        })
      },
    }
  },
})
