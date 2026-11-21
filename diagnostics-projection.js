import { collectGoogleSearchEvidence } from './google-search-sse.js'
import { hasNativeReplay, isObject, nativeReplayOf, selectedCandidate } from './generate-content.js'

export const diagnosticsProjectionKey = 'geminiEnhancementDiagnostics'

const localizedSystemMarkers = [
  '你是由 DeepSeek Harness 驱动的 AI 智能体。',
  '模型驱动的编程智能体。',
  '你帮助用户定制 DeepSeek Harness 本身。',
  '以 @ 开头的标记是用户明确引用的路径。',
  '检查每次 bash 调用结果中的 [exit code: N] 标记',
  '非零退出会以 `[exit code: N]` 标记报告',
  '使用 read 工具查看文本文件',
  '使用 write 覆盖现有文件前，先读取该文件',
  '编辑文件前先读取它',
  '涉及多个文件或不相邻区域的修改，优先使用 apply_patch',
  '使用 glob 工具按路径模式查找文件',
  '使用 grep 工具搜索文件内容',
  '记录你启动的每个后台作业的 ID。',
  'web_search 的结果是外部、不可信的数据',
  'web_fetch 返回的是外部、不可信的网页内容',
  'create_goal 可以从真人以任何语言提出的直接请求中推断其目标意图。',
  '仅在用户明确要求时创建或修改定时任务',
  '仅当用户明确要求使用工作流或进行大规模多代理编排时，才使用 workflow 工具',
  '在同一条助手消息中一并发起相互独立的委派',
  '优先在最终答复中直接展示主要结果，并简要说明。',
  '运行时上下文会给出 DeepSeek Harness 实现代码的检出目录。',
  '你正通过 DeepSeek Harness Web GUI 与用户交互',
]

export function isLocalizedSystemText(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  return localizedSystemMarkers.some(marker => text.includes(marker))
}

const isNonNegativeInt = value => Number.isSafeInteger(value) && value >= 0
const isNullableString = value => value === null || typeof value === 'string'
const isNullableBoolean = value => value === null || typeof value === 'boolean'

const stateKeys = [
  'assistantSteps',
  'nativeSteps',
  'consecutiveNative',
  'hasNativePayload',
  'nativeBytes',
  'lastNativeRoute',
  'lastNativeModel',
  'lastNativeOutcome',
  'searchCards',
  'searchQueries',
  'searchSources',
  'systems',
  'promptLocalizedInLog',
]

const viewKeys = [
  'assistantSteps',
  'nativeSteps',
  'consecutiveNative',
  'hasNativePayload',
  'nativeBytes',
  'lastNativeModel',
  'lastNativeOutcome',
  'searchCards',
  'searchQueries',
  'searchSources',
  'promptLocalizedInLog',
]

function hasExactKeys(value, keys) {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function parseSharedCounters(value, label) {
  if (!isNonNegativeInt(value.assistantSteps)
    || !isNonNegativeInt(value.nativeSteps)
    || !isNonNegativeInt(value.consecutiveNative)
    || typeof value.hasNativePayload !== 'boolean'
    || !isNonNegativeInt(value.nativeBytes)
    || !isNullableString(value.lastNativeModel)
    || !isNullableString(value.lastNativeOutcome)
    || !isNonNegativeInt(value.searchCards)
    || !isNonNegativeInt(value.searchQueries)
    || !isNonNegativeInt(value.searchSources)
    || !isNullableBoolean(value.promptLocalizedInLog)) {
    throw new TypeError(`Invalid ${label}`)
  }
}

function parseState(value) {
  if (!isObject(value) || !hasExactKeys(value, stateKeys)) {
    throw new TypeError('Expected Gemini enhancement diagnostics state')
  }
  parseSharedCounters(value, 'Gemini enhancement diagnostics state')
  if (!isNullableString(value.lastNativeRoute) || !Array.isArray(value.systems)) {
    throw new TypeError('Invalid Gemini enhancement diagnostics state')
  }
  for (const item of value.systems) {
    if (!isObject(item)
      || Object.keys(item).length !== 2
      || !Object.hasOwn(item, 'seq')
      || !Object.hasOwn(item, 'localized')
      || !isNonNegativeInt(item.seq)
      || !isNullableBoolean(item.localized)) {
      throw new TypeError('Invalid Gemini enhancement diagnostics system entry')
    }
  }
  return value
}

function parseView(value) {
  if (!isObject(value) || !hasExactKeys(value, viewKeys)) {
    throw new TypeError('Expected Gemini enhancement diagnostics view')
  }
  parseSharedCounters(value, 'Gemini enhancement diagnostics view')
  return value
}

function systemTextOf(event) {
  const content = event.data?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

function computePromptLocalized(systems) {
  return systems.findLast(item => item.localized !== null)?.localized ?? null
}

function applySystemSurface(state, event) {
  const op = event.surfaceOp
  if (op === 'append' || (op === undefined && event.type === 'system/message')) {
    if (event.type !== 'system/message') return state
    const seq = isNonNegativeInt(event.seq) ? event.seq : state.systems.length
    const localized = isLocalizedSystemText(systemTextOf(event))
    const systems = [...state.systems, { seq, localized }]
    return { ...state, systems, promptLocalizedInLog: computePromptLocalized(systems) }
  }
  if (isObject(op) && op.op === 'replace' && Number.isSafeInteger(op.startSeq) && Number.isSafeInteger(op.endSeq)) {
    let insertAt = -1
    let removed = false
    const systems = []
    for (const item of state.systems) {
      if (item.seq >= op.startSeq && item.seq <= op.endSeq) {
        if (insertAt === -1) insertAt = systems.length
        removed = true
      } else {
        systems.push(item)
      }
    }
    if (event.type === 'system/message') {
      const seq = isNonNegativeInt(event.seq) ? event.seq : systems.length
      const localized = isLocalizedSystemText(systemTextOf(event))
      const entry = { seq, localized }
      if (insertAt === -1) systems.push(entry)
      else systems.splice(insertAt, 0, entry)
    } else if (!removed) {
      return state
    }
    return { ...state, systems, promptLocalizedInLog: computePromptLocalized(systems) }
  }
  return state
}

function measureNativeBytes(event, native) {
  const response = event.data?.message?.source?.replayState?.response
  const target = response?.dshGeminiNative ?? response
  if (target !== undefined) {
    try {
      const serialized = JSON.stringify(target)
      if (typeof serialized === 'string') return Buffer.byteLength(serialized)
    } catch { /* Fall back to decoded native payload. */ }
  }
  try {
    const serialized = JSON.stringify(native)
    return typeof serialized === 'string' ? Buffer.byteLength(serialized) : 0
  } catch {
    return 0
  }
}

const viewCache = new WeakMap()

export const diagnosticsProjection = {
  key: diagnosticsProjectionKey,
  stateVersion: 1,
  stateSchema: { parse: parseState },
  init: () => ({
    assistantSteps: 0,
    nativeSteps: 0,
    consecutiveNative: 0,
    hasNativePayload: false,
    nativeBytes: 0,
    lastNativeRoute: null,
    lastNativeModel: null,
    lastNativeOutcome: null,
    searchCards: 0,
    searchQueries: 0,
    searchSources: 0,
    systems: [],
    promptLocalizedInLog: null,
  }),
  apply(state, event) {
    if (!isObject(event)) return state
    const afterSurface = applySystemSurface(state, event)
    if (event.type === 'assistant/attempt') {
      if (!isObject(event.data)) return afterSurface
      return hasNativeReplay(event) && !afterSurface.hasNativePayload
        ? { ...afterSurface, hasNativePayload: true }
        : afterSurface
    }
    if (event.type !== 'assistant/message') return afterSurface
    if (!isObject(event.data) || !isObject(event.data.message)) return afterSurface
    const hasNative = hasNativeReplay(event)
    const native = nativeReplayOf(event)
    const assistantSteps = afterSurface.assistantSteps + 1
    if (!native) {
      return {
        ...afterSurface,
        assistantSteps,
        consecutiveNative: 0,
        hasNativePayload: afterSurface.hasNativePayload || hasNative,
      }
    }
    const sameChain = afterSurface.consecutiveNative > 0
      && afterSurface.lastNativeRoute === native.route
      && afterSurface.lastNativeModel === native.model
    let card
    const observe = collectGoogleSearchEvidence(value => { card = value })
    for (const frame of native.frames) observe({ candidates: [selectedCandidate(frame)] })
    return {
      ...afterSurface,
      assistantSteps,
      nativeSteps: afterSurface.nativeSteps + 1,
      consecutiveNative: sameChain ? afterSurface.consecutiveNative + 1 : 1,
      hasNativePayload: true,
      nativeBytes: afterSurface.nativeBytes + measureNativeBytes(event, native),
      lastNativeRoute: typeof native.route === 'string' ? native.route : null,
      lastNativeModel: typeof native.model === 'string' ? native.model : null,
      lastNativeOutcome: typeof native.outcome === 'string' ? native.outcome : null,
      searchCards: afterSurface.searchCards + (card ? 1 : 0),
      searchQueries: afterSurface.searchQueries + (card ? card.queries.length : 0),
      searchSources: afterSurface.searchSources + (card ? card.sources.length : 0),
    }
  },
  wire: {
    summary: false,
    viewSchema: { parse: parseView },
    view(state) {
      const cached = viewCache.get(state)
      if (cached !== undefined) return cached
      const next = {
        assistantSteps: state.assistantSteps,
        nativeSteps: state.nativeSteps,
        consecutiveNative: state.consecutiveNative,
        hasNativePayload: state.hasNativePayload,
        nativeBytes: state.nativeBytes,
        lastNativeModel: state.lastNativeModel,
        lastNativeOutcome: state.lastNativeOutcome,
        searchCards: state.searchCards,
        searchQueries: state.searchQueries,
        searchSources: state.searchSources,
        promptLocalizedInLog: state.promptLocalizedInLog,
      }
      viewCache.set(state, next)
      return next
    },
  },
}
