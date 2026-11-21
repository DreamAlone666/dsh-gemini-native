import { AsyncLocalStorage } from 'node:async_hooks'
import { collectGoogleSearchEvidence, observeGoogleSearchResponse, observeSseResponse } from './google-search-sse.js'
import {
  applyGoogleSearchTools, attachNativeReplay, isObject, makeNativeReplayData, normalizeEndpoint,
  patchGenerateContentBody, responseFrame, routeIdentity, selectedCandidate,
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

function buildOutboundTelemetry(state, host, finalBody, historyStats = null) {
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
    host: host ?? null,
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
                yield { ...chunk, replayState: attachNativeReplay(chunk.replayState, nativeData) }
                continue
              }
            }
          }
          yield chunk
        }
      } finally {
        if (!done && typeof iterator.return === 'function') {
          await scope.run(state, () => iterator.return())
        }
        onFinish?.(state)
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

export function geminiTransport(ctx, config, routeConfigOf, reportFor, isXHighEnabled, recordTransport) {
  const scope = new AsyncLocalStorage()
  let active = true
  let transport
  let warned = false

  function warnOnce(message) {
    if (warned) return
    warned = true
    ctx.logger.warn(`Gemini enhancement: ${message}`)
  }

  function reportMainTransport(state, snapshot) {
    if (active && state?.purpose === undefined) {
      recordTransport?.(state.sessionId, snapshot)
    }
  }

  function reportStreamFinish(state) {
    if (!active || state?.purpose !== undefined || !state.capture || !state.outboundTelemetry) return
    const capture = state.capture
    const recordStatus = capture.overflow
      ? 'overflow'
      : capture.invalid
        ? 'invalid'
        : (capture.frames.length > 0 ? 'saved' : 'none')
    recordTransport?.(state.sessionId, {
      ...state.outboundTelemetry,
      recordedBytes: capture.savedBytes,
      recordedFrames: capture.frames.length,
      recordStatus,
    })
  }

  function installTransport() {
    if (transport !== undefined || !active) return
    const previous = globalThis.fetch
    if (typeof previous !== 'function') return
    function fetchWithGeminiEnhancement(input, init) {
      const state = active ? scope.getStore() : undefined
      const expected = state?.url
      if (expected !== undefined && typeof input === 'string' && init?.method === 'POST') {
        const url = URL.parse(input)
        if (url?.origin === expected.origin && url.pathname === expected.pathname
          && url.searchParams.get('alt') === 'sse') {
          const parsed = parseBody(init.body)
          if (parsed !== undefined) {
            if (state.readOnly) {
              if (state.nativeHistory) {
                let route
                try {
                  const baseURL = normalizeEndpoint(state.baseURL)
                  route = { baseURL, provider: state.provider, googleSearch: state.googleSearch }
                  route.identity = routeIdentity(route)
                } catch { /* Non-standard endpoint stays untouched. */ }
                if (route) {
                  const patched = patchGenerateContentBody(parsed, state.request, route)
                  if (patched?.changed) {
                    const forwarded = replaceBody(init, JSON.stringify(patched.body))
                    return previous.call(this, input, forwarded)
                  }
                }
              } else if (state.googleSearch) {
                const toolsPatched = applyGoogleSearchTools(parsed, true)
                if (toolsPatched.changed) {
                  const forwarded = replaceBody(init, JSON.stringify(toolsPatched.body))
                  return previous.call(this, input, forwarded)
                }
              }
            } else if (state.nativeHistory) {
              let route
              try {
                const baseURL = normalizeEndpoint(state.baseURL)
                route = { baseURL, provider: state.provider, googleSearch: state.googleSearch }
                route.identity = routeIdentity(route)
              } catch { /* Non-standard endpoint stays untouched. */ }
              if (route) {
                const patched = patchGenerateContentBody(parsed, state.request, route)
                if (patched) {
                  const thinkingPatched = applyXHighThinking(patched.body, state.xhigh)
                  const changed = patched.changed || thinkingPatched.changed
                  const forwarded = changed ? replaceBody(init, JSON.stringify(thinkingPatched.body)) : init
                  const capture = { route, prefix: patched.prefix, frames: [], savedBytes: 0, overflow: false, invalid: false }
                  state.capture = capture
                  const outbound = buildOutboundTelemetry(state, url.host, thinkingPatched.body, patched)
                  state.outboundTelemetry = outbound
                  reportMainTransport(state, outbound)
                  const report = reportFor?.(state.sessionId, true)
                  const observeSearch = report ? collectGoogleSearchEvidence(report) : undefined
                  const result = previous.call(this, input, forwarded)
                  return Promise.resolve(result).then(response => observeSseResponse(response, json => {
                    if (!isObject(json)) return
                    const frame = responseFrame(json)
                    if (!frame?.length) return
                    const candidate = selectedCandidate(frame)
                    if (candidate != null) observeSearch?.({ candidates: [candidate] })
                    if (capture.overflow) return
                    capture.savedBytes += Buffer.byteLength(JSON.stringify(frame))
                    if (capture.savedBytes > replayLimit || capture.frames.length >= candidateLimit) {
                      capture.overflow = true
                      capture.frames.length = 0
                    } else {
                      capture.frames.push(frame)
                    }
                  }, { frameLimit: nativeFrameLimit, invalid: () => { capture.invalid = true } }))
                }
              }
            } else if (state.googleSearch || state.xhigh) {
              const toolsPatched = applyGoogleSearchTools(parsed, state.googleSearch)
              const thinkingPatched = applyXHighThinking(toolsPatched.body, state.xhigh)
              const outbound = buildOutboundTelemetry(state, url.host, thinkingPatched.body, null)
              reportMainTransport(state, outbound)
              if (toolsPatched.changed || thinkingPatched.changed) {
                const forwarded = replaceBody(init, JSON.stringify(thinkingPatched.body))
                const report = toolsPatched.changed ? reportFor?.(state.sessionId, false) : undefined
                const result = previous.call(this, input, forwarded)
                return report ? Promise.resolve(result).then(response => {
                  try { return observeGoogleSearchResponse(response, report) } catch { return response }
                }) : result
              }
            }
          }
        }
      }
      return previous.apply(this, arguments)
    }
    try { globalThis.fetch = fetchWithGeminiEnhancement } catch {
      warnOnce('this Host does not allow wrapping fetch; Gemini transport enhancements remain inactive.')
      return
    }
    transport = { previous, wrapper: fetchWithGeminiEnhancement }
  }

  ctx.on('llm/stream', (request, next) => {
    let state
    if (active && request.purpose === undefined && request.sessionId !== undefined) {
      const routeCfg = routeConfigOf(config.routes.get(), request.provider)
      const xhigh = isXHighEnabled?.(request.sessionId) === true && supportsXHighModel(request.model)
      if (routeCfg.nativeHistory || routeCfg.googleSearch || xhigh) {
        // Use the mounted LLM module's identity predicate, not a second import
        // whose marker WeakSet might belong to a different module generation.
        const isAgentLoopRequest = loopRequestPredicate(ctx)
        if (!isAgentLoopRequest) {
          warnOnce('cannot identify Agent Loop requests on this DSH version; Gemini transport enhancements remain inactive.')
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
    } else if (active && request.purpose === 'compaction' && request.sessionId !== undefined) {
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
      else if (state.purpose === undefined) {
        const host = (() => { try { return new URL(request.baseURL).host } catch { return null } })()
        reportMainTransport(state, {
          provider: state.provider,
          model: state.model,
          status: 'url-mismatch',
          host,
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
