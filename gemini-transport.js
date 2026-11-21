import { AsyncLocalStorage } from 'node:async_hooks'
import { collectGoogleSearchEvidence, observeGoogleSearchResponse, observeSseResponse } from './google-search-sse.js'
import {
  applyGoogleSearchTools, attachNativeReplay, isObject, makeNativeReplayData, normalizeEndpoint,
  patchGenerateContentBody, responseFrame, routeIdentity,
} from './generate-content.js'
import { applyXHighThinking, supportsXHighModel } from './xhigh.js'

const nativeFrameLimit = 1024 * 1024
const replayLimit = 2 * 1024 * 1024
const candidateLimit = 4_096

function generationUrl(baseURL, model) {
  // Mirror the Google Developer API's resource naming for ordinary model IDs.
  // Do not guess at Vertex routes, escaped IDs, or queries containing a model.
  if (typeof baseURL !== 'string' || typeof model !== 'string'
    || !/^[\w.-]+(?:\/[\w.-]+)*$/u.test(model) || model.includes('..')) return
  const path = /^(?:models|tunedModels)\//u.test(model) ? model : `models/${model}`
  try {
    const base = new URL(baseURL)
    if (base.protocol !== 'https:' && base.protocol !== 'http:') return
    return new URL(`${base.pathname.replace(/\/+$/u, '')}/${path}:streamGenerateContent`, base.origin)
  } catch { /* An unfamiliar endpoint must not enable interception. */ }
}

function parseBody(raw) {
  if (typeof raw !== 'string') return
  let body
  try { body = JSON.parse(raw) } catch { return }
  if (!isObject(body) || !Array.isArray(body.contents)
    || (body.tools !== undefined && !Array.isArray(body.tools))) return
  return body
}

function replaceBody(init, body) {
  // Keep relay/proxy behavior, auth, attribution and cancellation. A
  // caller-supplied length is the only header invalidated by the edit.
  const headers = new Headers(init.headers)
  if (headers.has('content-length')) {
    headers.delete('content-length')
    return { ...init, headers, body }
  }
  return { ...init, body }
}

function countLocalTools(tools) {
  if (!Array.isArray(tools)) return 0
  let count = 0
  for (const tool of tools) {
    if (Array.isArray(tool?.functionDeclarations)) count += tool.functionDeclarations.length
  }
  return count
}

function hasSearchTool(tools) {
  return Array.isArray(tools) && tools.some(tool => isObject(tool)
    && (Object.hasOwn(tool, 'googleSearch') || Object.hasOwn(tool, 'google_search') || Object.hasOwn(tool, 'googleSearchRetrieval')))
}

function buildOutboundTelemetry(state, finalBody, historyStats) {
  const localToolCount = countLocalTools(finalBody?.tools)
  const searchInjected = hasSearchTool(finalBody?.tools)
  const searchConfigured = state.googleSearch === true
  const searchMode = !searchConfigured
    ? 'off'
    : !searchInjected
      ? 'skipped'
      : localToolCount > 0 ? 'mixed' : 'search-only'
  const rawThinkingLevel = finalBody?.generationConfig?.thinkingConfig?.thinkingLevel
  const thinkingLevel = typeof rawThinkingLevel === 'string' && rawThinkingLevel.length > 0 ? rawThinkingLevel : null
  const xhighRequested = state.xhigh === true
  const xhighApplied = xhighRequested && thinkingLevel === 'XHIGH'
  return {
    provider: state.provider,
    model: state.model,
    status: 'ok',
    totalHistoryTurns: historyStats ? historyStats.totalModelTurns : null,
    replayedHistoryTurns: historyStats ? historyStats.replayedModelTurns : null,
    searchConfigured,
    searchInjected,
    searchMode,
    localToolCount,
    xhighRequested,
    xhighApplied,
    thinkingLevel,
    recordedBytes: null,
    recordedFrames: null,
    recordStatus: null,
  }
}

function scopedStream(scope, state, next, onFinish) {
  const stream = scope.run(state, next)
  if (!state?.nativeHistory || state.readOnly) {
    return {
      [Symbol.asyncIterator]() {
        // Starting the waterfall alone is not enough: adapter dispatch and SDK
        // I/O don't start until this lazy iterable is actually consumed.
        const iterator = scope.run(state, () => stream[Symbol.asyncIterator]())
        const bound = { next: (...args) => scope.run(state, () => iterator.next(...args)) }
        for (const method of ['return', 'throw']) {
          if (typeof iterator[method] === 'function') {
            bound[method] = (...args) => scope.run(state, () => iterator[method](...args))
          }
        }
        return bound
      },
    }
  }
  return {
    async *[Symbol.asyncIterator]() {
      const iterator = scope.run(state, () => stream[Symbol.asyncIterator]())
      const blocksByIndex = new Map()
      let done = false
      try {
        for (;;) {
          const item = await scope.run(state, () => iterator.next())
          if (item.done) { done = true; return }
          const chunk = item.value
          if (chunk?.type === 'block-end' && !blocksByIndex.has(chunk.index)) {
            blocksByIndex.set(chunk.index, chunk.block)
          }
          if (chunk?.type === 'finish') {
            const capture = state.capture
            if (capture && !capture.overflow && capture.frames.length > 0) {
              const kind = chunk.reason?.kind
              const outcome = kind === 'stop' || kind === 'tool-calls'
                ? 'complete' : kind === 'max-tokens' ? 'truncated' : 'failed'
              if (outcome !== 'complete' || !capture.invalid) {
                const normalizedBlocks = [...blocksByIndex.entries()]
                  .sort((left, right) => left[0] - right[0])
                  .map(([, block]) => block)
                const callIds = normalizedBlocks
                  .filter(block => block?.type === 'tool-call' && typeof block.id === 'string')
                  .map(block => block.id)
                const nativeData = makeNativeReplayData(
                  capture.route, state.model, capture.frames, callIds, outcome, capture.prefix,
                  outcome === 'complete' ? normalizedBlocks : undefined,
                )
                capture.attached = true
                yield { ...chunk, replayState: attachNativeReplay(chunk.replayState, nativeData) }
                continue
              }
            }
          }
          yield chunk
        }
      } finally {
        try {
          if (!done && typeof iterator.return === 'function') await scope.run(state, () => iterator.return())
        } finally {
          onFinish(state)
        }
      }
    },
  }
}

function isSameCompactionRoute(ctx, request) {
  const session = ctx.get?.('sessions')?.get?.(request.sessionId)
  const routed = session?.requestHeader?.()?.config
  return typeof routed?.provider === 'string' && routed.provider === request.provider
    && typeof routed?.model === 'string' && routed.model === request.model
}

function loopRequestPredicate(ctx) {
  // Profiles mount the base LLM service inside the bootstrap Include. A
  // standalone composition can instead mount it directly on the root loader.
  for (const id of ['include:llm', 'llm']) {
    let predicate
    try { predicate = ctx.loader.resolve(id).moduleNamespace?.isAgentLoopRequest } catch { continue }
    if (typeof predicate === 'function') return predicate
  }
}

export function geminiTransport(ctx, config, routeConfigOf, reportFor, isXHighEnabled, recordTransport, isGeminiRoute) {
  const scope = new AsyncLocalStorage()
  let active = true
  let transport
  let warned = false

  function warnOnce(message) {
    if (warned) return
    warned = true
    ctx.logger.warn(`Gemini Native: ${message}`)
  }

  function recordsTelemetry(state) {
    return active && state && !state.readOnly && recordTransport && (config.showStatusNotice?.get() ?? true)
  }

  function report(state, snapshot) {
    try { recordTransport(state.sessionId, snapshot) } catch { /* Diagnostics must not affect inference. */ }
  }

  function reportStreamFinish(state) {
    const { capture, outboundTelemetry } = state
    if (!capture || !outboundTelemetry || !recordsTelemetry(state)) return
    report(state, {
      ...outboundTelemetry,
      recordedBytes: capture.savedBytes,
      recordedFrames: capture.frames.length,
      recordStatus: capture.overflow ? 'overflow' : capture.attached ? 'saved' : capture.invalid ? 'invalid' : 'none',
    })
  }

  function planRequest(state, body) {
    let history
    let route
    if (state.nativeHistory) {
      let baseURL
      try { baseURL = normalizeEndpoint(state.baseURL) } catch { return }
      route = { baseURL, provider: state.provider, googleSearch: state.googleSearch }
      route.identity = routeIdentity(route)
      history = patchGenerateContentBody(body, state.request, route)
    }
    const patched = history ?? applyGoogleSearchTools(body, state.googleSearch)
    const thinking = applyXHighThinking(patched.body, state.xhigh)
    return { body: thinking.body, changed: patched.changed || thinking.changed, route, history }
  }

  function captureResponse(state, response, plan, reportSearch) {
    const capture = {
      route: plan.route, prefix: plan.history.prefix, frames: [], savedBytes: 0,
      overflow: false, invalid: false, attached: false,
    }
    state.capture = capture
    const observeSearch = reportSearch ? collectGoogleSearchEvidence(reportSearch) : undefined
    return Promise.resolve(response).then(res => observeSseResponse(res, payload => {
      observeSearch?.(payload)
      if (capture.overflow) return
      const frame = responseFrame(payload)
      if (!frame) return
      capture.savedBytes += Buffer.byteLength(JSON.stringify(frame))
      if (capture.savedBytes > replayLimit || capture.frames.length >= candidateLimit) {
        capture.overflow = true
        capture.frames.length = 0
      } else {
        capture.frames.push(frame)
      }
    }, { frameLimit: nativeFrameLimit, invalid: () => { capture.invalid = true } }))
  }

  function installTransport() {
    if (transport !== undefined || !active) return
    const previous = globalThis.fetch
    if (typeof previous !== 'function') return
    function fetchWithGeminiNative(input, init) {
      const state = active ? scope.getStore() : undefined
      const expected = state?.url
      if (!expected || typeof input !== 'string' || init?.method !== 'POST') return previous.apply(this, arguments)
      const url = URL.parse(input)
      if (url?.origin !== expected.origin || url.pathname !== expected.pathname
        || url.searchParams.get('alt') !== 'sse') return previous.apply(this, arguments)
      const parsed = parseBody(init.body)
      if (!parsed) return previous.apply(this, arguments)
      const plan = planRequest(state, parsed)
      if (!plan) return previous.apply(this, arguments)
      const forwarded = plan.changed ? replaceBody(init, JSON.stringify(plan.body)) : init
      if (recordsTelemetry(state)) {
        state.outboundTelemetry = buildOutboundTelemetry(state, plan.body, plan.history)
        report(state, state.outboundTelemetry)
      }
      const response = previous.call(this, input, forwarded)
      if (state.readOnly) return response
      const reportSearch = plan.history || (state.googleSearch && hasSearchTool(plan.body.tools))
        ? reportFor?.(state.sessionId) : undefined
      if (plan.history) return captureResponse(state, response, plan, reportSearch)
      return reportSearch ? Promise.resolve(response).then(res => {
        try { return observeGoogleSearchResponse(res, reportSearch) } catch { return res }
      }) : response
    }
    try { globalThis.fetch = fetchWithGeminiNative } catch {
      warnOnce('this Host does not allow wrapping fetch; Gemini native transport features remain inactive.')
      return
    }
    transport = { previous, wrapper: fetchWithGeminiNative }
  }

  ctx.on('llm/stream', (request, next) => {
    let state
    const eligible = active && request.sessionId !== undefined && isGeminiRoute?.(request.provider) !== false
    if (eligible && request.purpose === undefined) {
      const routeCfg = routeConfigOf(config.routes.get(), request.provider)
      const xhigh = isXHighEnabled?.(request.sessionId) === true && supportsXHighModel(request.model)
      if (routeCfg.nativeHistory || routeCfg.googleSearch || xhigh) {
        // Use the mounted LLM module's identity predicate, not a second import
        // whose marker WeakSet might belong to a different module generation.
        const isAgentLoopRequest = loopRequestPredicate(ctx)
        if (!isAgentLoopRequest) {
          warnOnce('cannot identify Agent Loop requests on this DSH version; Gemini native transport features remain inactive.')
        } else if (isAgentLoopRequest(request)) {
          state = {
            readOnly: false,
            purpose: undefined,
            nativeHistory: routeCfg.nativeHistory,
            googleSearch: routeCfg.googleSearch,
            xhigh,
            provider: request.provider,
            model: request.model,
            sessionId: request.sessionId,
            request,
            capture: null,
            outboundTelemetry: null,
          }
        }
      }
    } else if (eligible && request.purpose === 'compaction') {
      const routeCfg = routeConfigOf(config.routes.get(), request.provider)
      if ((routeCfg.nativeHistory || routeCfg.googleSearch) && isSameCompactionRoute(ctx, request)) {
        state = {
          readOnly: true,
          purpose: 'compaction',
          nativeHistory: routeCfg.nativeHistory,
          googleSearch: routeCfg.googleSearch,
          xhigh: false,
          provider: request.provider,
          model: request.model,
          sessionId: request.sessionId,
          request,
          capture: null,
          outboundTelemetry: null,
        }
      }
    }
    if (state === undefined && scope.getStore() === undefined) return next()
    return scopedStream(scope, state, next, reportStreamFinish)
  })

  ctx.on('llm-pi-ai/request-headers', (request, _headers, next) => {
    const state = scope.getStore()
    if (active && state && state.provider === request.provider && state.model === request.model
      && state.sessionId === request.sessionId && request.purpose === state.purpose) {
      state.url = generationUrl(request.baseURL, request.model)
      state.baseURL = request.baseURL
      if (state.url) installTransport()
      else if (recordsTelemetry(state)) {
        report(state, {
          provider: state.provider,
          model: state.model,
          status: 'url-mismatch',
          totalHistoryTurns: null,
          replayedHistoryTurns: null,
          searchConfigured: state.googleSearch,
          searchInjected: false,
          searchMode: state.googleSearch ? 'skipped' : 'off',
          localToolCount: 0,
          xhighRequested: state.xhigh,
          xhighApplied: false,
          thinkingLevel: null,
          recordedBytes: null,
          recordedFrames: null,
          recordStatus: null,
        })
      }
    }
    return next()
  })

  ctx.effect(() => () => {
    active = false
    // A wrapper installed above ours may still hold it. Never clobber that
    // wrapper; ours becomes a transparent pass-through in its chain.
    if (transport && globalThis.fetch === transport.wrapper) globalThis.fetch = transport.previous
  })
}
