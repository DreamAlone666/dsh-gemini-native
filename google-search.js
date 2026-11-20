import { AsyncLocalStorage } from 'node:async_hooks'
import { collectGoogleSearchEvidence, observeSseResponse } from './google-search-sse.js'
import {
  applyGoogleSearchTools, attachNativeReplay, isObject, makeNativeReplayData, normalizeEndpoint,
  patchGenerateContentBody, responseFrame, routeIdentity, selectedCandidate,
} from './generate-content.js'

const nativeModes = new Set(['off', 'search-only', 'mixed'])
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

function scopedStream(scope, state, next) {
  const stream = scope.run(state, next)
  if (!state?.native) {
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
      }
    },
  }
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

export function googleSearch(ctx, config, matchesModelId, observerFor, reportFor) {
  const scope = new AsyncLocalStorage()
  let active = true
  let transport
  let warned = false

  function warnOnce(message) {
    if (warned) return
    warned = true
    ctx.logger.warn(`Gemini Google Search: ${message}`)
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
            if (state.native) {
              let route
              try {
                const baseURL = normalizeEndpoint(state.baseURL)
                route = { baseURL, provider: state.provider, search: state.search }
                route.identity = routeIdentity(route)
              } catch { /* Non-standard endpoint stays untouched. */ }
              if (route) {
                const patched = patchGenerateContentBody(parsed, state.request, route)
                if (patched) {
                  const forwarded = patched.changed ? replaceBody(init, JSON.stringify(patched.body)) : init
                  const capture = { route, prefix: patched.prefix, frames: [], savedBytes: 0, overflow: false, invalid: false }
                  state.capture = capture
                  const report = reportFor?.(state.sessionId)
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
            } else {
              const patched = applyGoogleSearchTools(parsed, 'mixed')
              if (patched.changed) {
                const forwarded = replaceBody(init, JSON.stringify(patched.body))
                // The loop publishes attempt start before it first pulls this lazy
                // stream. Bind once, before calling the network transport.
                const observe = observerFor?.(state.sessionId)
                const result = previous.call(this, input, forwarded)
                return observe ? Promise.resolve(result).then(observe) : result
              }
            }
          }
        }
      }
      return previous.apply(this, arguments)
    }
    try { globalThis.fetch = fetchWithGeminiEnhancement } catch {
      warnOnce('this Host does not allow wrapping fetch; search remains inactive.')
      return
    }
    transport = { previous, wrapper: fetchWithGeminiEnhancement }
  }

  ctx.on('llm/stream', (request, next) => {
    let state
    if (active && request.purpose === undefined && request.sessionId !== undefined) {
      const modes = config.modelPageRoutes?.get?.()
      const nativeMode = modes && Object.hasOwn(modes, request.provider) ? modes[request.provider] : undefined
      const wantsNative = nativeModes.has(nativeMode)
      const wantsSearch = !wantsNative && config.enableGoogleSearch.get() && matchesModelId(request.model, config.modelIds.get())
      if (wantsNative || wantsSearch) {
        // Use the mounted LLM module's identity predicate, not a second import
        // whose marker WeakSet might belong to a different module generation.
        const isAgentLoopRequest = loopRequestPredicate(ctx)
        if (!isAgentLoopRequest) {
          warnOnce('cannot identify Agent Loop requests on this DSH version; search remains inactive.')
        } else if (isAgentLoopRequest(request)) {
          state = wantsNative
            ? { native: true, search: nativeMode, provider: request.provider, model: request.model, sessionId: request.sessionId, request, capture: null }
            : { native: false, search: 'mixed', provider: request.provider, model: request.model, sessionId: request.sessionId }
        }
      }
    }
    if (state === undefined && scope.getStore() === undefined) return next()
    return scopedStream(scope, state, next)
  })

  ctx.on('llm-pi-ai/request-headers', (request, _headers, next) => {
    const state = scope.getStore()
    if (active && state && state.provider === request.provider && state.model === request.model
      && state.sessionId === request.sessionId && request.purpose === undefined) {
      state.url = generationUrl(request.baseURL, request.model)
      state.baseURL = request.baseURL
      if (state.url) installTransport()
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
