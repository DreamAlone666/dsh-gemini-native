import { AsyncLocalStorage } from 'node:async_hooks'

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hasFunctions = tool => Array.isArray(tool.functionDeclarations) && tool.functionDeclarations.length > 0
const dshWebSearch = 'web_search'

function withoutDshWebSearch(tools) {
  return tools.flatMap(tool => {
    if (!hasFunctions(tool)) return [tool]
    const { functionDeclarations, ...otherFields } = tool
    const kept = functionDeclarations.filter(declaration => declaration?.name !== dshWebSearch)
    if (kept.length === functionDeclarations.length) return [tool]
    if (kept.length > 0) return [{ ...tool, functionDeclarations: kept }]
    return Object.keys(otherFields).length > 0 ? [otherFields] : []
  })
}

function generationUrl(baseURL, model) {
  // Mirror the Google Developer API's resource naming for ordinary model IDs.
  // Do not guess at Vertex routes, escaped IDs, or queries containing a model.
  if (!/^[\w.-]+(?:\/[\w.-]+)*$/u.test(model) || model.includes('..')) return
  const path = /^(?:models|tunedModels)\//u.test(model) ? model : `models/${model}`
  try {
    const base = new URL(baseURL)
    if (base.protocol !== 'https:' && base.protocol !== 'http:') return
    return new URL(`${base.pathname.replace(/\/+$/u, '')}/${path}:streamGenerateContent`, base.origin)
  } catch { /* An unfamiliar endpoint must not enable interception. */ }
}

function augmentedBody(raw) {
  if (typeof raw !== 'string') return
  let body
  try { body = JSON.parse(raw) } catch { return }
  if (!isObject(body) || !Array.isArray(body.contents)
    || (body.tools !== undefined && !Array.isArray(body.tools))) return
  const originalTools = body.tools ?? []
  if (originalTools.some(tool => !isObject(tool)
    || Object.hasOwn(tool, 'googleSearch') || Object.hasOwn(tool, 'google_search')
    || Object.hasOwn(tool, 'googleSearchRetrieval'))) return

  // Replace the competing local search only when we can add native search in
  // the same request. Keep all other definitions and the session history.
  const tools = withoutDshWebSearch(originalTools)
  if (originalTools.some(hasFunctions)) {
    // Google requires this preview opt-in when mixing built-ins with functions.
    // Its examples omit the mode; AUTO is not supported. Never override a mode
    // or an explicit false chosen by a different integration.
    const config = body.toolConfig
    if (config !== undefined && (!isObject(config) || config.includeServerSideToolInvocations === false)) return
    const calling = config?.functionCallingConfig
    if (calling !== undefined && (!isObject(calling)
      || (calling.mode !== undefined && calling.mode !== 'VALIDATED'))) return

    if (tools.some(hasFunctions)) {
      body.toolConfig = { ...config, includeServerSideToolInvocations: true }
      const allowed = calling?.allowedFunctionNames
      if (Array.isArray(allowed) && allowed.includes(dshWebSearch)) {
        const kept = allowed.filter(name => name !== dshWebSearch)
        // Don't widen an explicit allowlist to all local tools.
        if (kept.length === 0) return
        body.toolConfig.functionCallingConfig = { ...calling, allowedFunctionNames: kept }
      }
    } else if (calling !== undefined) {
      // An otherwise search-only request no longer needs a function policy.
      const { functionCallingConfig, ...rest } = config
      if (Object.keys(rest).length > 0) body.toolConfig = rest
      else delete body.toolConfig
    }
  }
  body.tools = [...tools, { googleSearch: {} }]
  return JSON.stringify(body)
}

function scopedStream(scope, state, next) {
  const stream = scope.run(state, next)
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

function loopRequestPredicate(ctx) {
  // Profiles mount the base LLM service inside the bootstrap Include. A
  // standalone composition can instead mount it directly on the root loader.
  for (const id of ['include:llm', 'llm']) {
    let predicate
    try { predicate = ctx.loader.resolve(id).moduleNamespace?.isAgentLoopRequest } catch { continue }
    if (typeof predicate === 'function') return predicate
  }
}

export function googleSearch(ctx, config, matchesModelId) {
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
    function fetchWithSearch(input, init) {
      const expected = active ? scope.getStore()?.url : undefined
      if (expected !== undefined && typeof input === 'string' && init?.method === 'POST') {
        const url = URL.parse(input)
        if (url?.origin === expected.origin && url.pathname === expected.pathname
          && url.searchParams.get('alt') === 'sse') {
          const body = augmentedBody(init.body)
          if (body !== undefined) {
            // Keep relay/proxy behavior, auth, attribution and cancellation. A
            // caller-supplied length is the only header invalidated by the edit.
            const headers = new Headers(init.headers)
            if (headers.has('content-length')) {
              headers.delete('content-length')
              return previous.call(this, input, { ...init, headers, body })
            }
            return previous.call(this, input, { ...init, body })
          }
        }
      }
      return previous.apply(this, arguments)
    }
    try { globalThis.fetch = fetchWithSearch } catch {
      warnOnce('this Host does not allow wrapping fetch; search remains inactive.')
      return
    }
    transport = { previous, wrapper: fetchWithSearch }
  }

  ctx.on('llm/stream', (request, next) => {
    let state
    if (active && config.enableGoogleSearch.get() && request.purpose === undefined
      && matchesModelId(request.model, config.modelIds.get())) {
      // Use the mounted LLM module's identity predicate, not a second import
      // whose marker WeakSet might belong to a different module generation.
      const isAgentLoopRequest = loopRequestPredicate(ctx)
      if (!isAgentLoopRequest) {
        warnOnce('cannot identify Agent Loop requests on this DSH version; search remains inactive.')
      } else if (isAgentLoopRequest(request)) {
        state = { provider: request.provider, model: request.model, sessionId: request.sessionId }
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
