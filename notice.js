const statusPath = '/api/dsh-gemini-native/status'
const recentLimit = 256

// Only confirm assemblies that can be rendered unambiguously. DSH supports
// more elaborate template expressions; for those, omit the notice rather than
// guessing at the request's effective prompt. Never change the assembly here.
function expectedPrompt({ sections, variables }) {
  const texts = []
  for (const { text, interpolate } of sections) {
    if (interpolate === false) {
      if (text) texts.push(text)
      continue
    }
    let invalid = false
    // Test the template, not substituted values: DSH never scans values again.
    const variable = /\{\{([a-z][a-z0-9_]*)\}\}/gu
    if (text.replace(variable, '').includes('{{')) return undefined
    const rendered = text.replace(variable, (_, key) => {
      if (typeof variables[key] !== 'string') { invalid = true; return '' }
      return variables[key]
    })
    if (invalid) return undefined
    if (rendered) texts.push(rendered)
  }
  return texts.join('\n\n') || undefined
}

function effectivePrompt(messages) {
  // DSH may append system updates in-history. Only the latest nonempty system
  // message represents the prompt for this step; old Chinese nodes do not count.
  for (let i = messages.length - 1; i >= 0; i--) {
    const { role, source, content } = messages[i]
    if (role !== 'system' || source?.kind !== 'system-prompt') continue
    const text = content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    if (text) return text
  }
}

function normalizeStats(stats) {
  if (!stats || typeof stats !== 'object') return null
  if (!Number.isSafeInteger(stats.matched) || stats.matched < 0) return null
  if (!Number.isSafeInteger(stats.total) || stats.total < 0) return null
  const missedBuiltins = Array.isArray(stats.missedBuiltins)
    ? stats.missedBuiltins.filter(name => typeof name === 'string' && name.length > 0).slice(0, 6)
    : []
  return { matched: stats.matched, total: stats.total, missedBuiltins }
}

function normalizeTransport(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null
  return {
    provider: typeof snapshot.provider === 'string' ? snapshot.provider : '',
    model: typeof snapshot.model === 'string' ? snapshot.model : '',
    status: snapshot.status === 'url-mismatch' ? 'url-mismatch' : 'ok',
    totalHistoryTurns: Number.isSafeInteger(snapshot.totalHistoryTurns) && snapshot.totalHistoryTurns >= 0
      ? snapshot.totalHistoryTurns : null,
    replayedHistoryTurns: Number.isSafeInteger(snapshot.replayedHistoryTurns) && snapshot.replayedHistoryTurns >= 0
      ? snapshot.replayedHistoryTurns : null,
    searchConfigured: snapshot.searchConfigured === true,
    searchInjected: snapshot.searchInjected === true,
    searchMode: ['mixed', 'search-only', 'skipped', 'off'].includes(snapshot.searchMode) ? snapshot.searchMode : 'off',
    localToolCount: Number.isSafeInteger(snapshot.localToolCount) && snapshot.localToolCount >= 0
      ? snapshot.localToolCount : 0,
    xhighRequested: snapshot.xhighRequested === true,
    xhighApplied: snapshot.xhighApplied === true,
    thinkingLevel: typeof snapshot.thinkingLevel === 'string' && snapshot.thinkingLevel.length > 0
      ? snapshot.thinkingLevel : null,
    recordedBytes: Number.isSafeInteger(snapshot.recordedBytes) && snapshot.recordedBytes >= 0
      ? snapshot.recordedBytes : null,
    recordedFrames: Number.isSafeInteger(snapshot.recordedFrames) && snapshot.recordedFrames >= 0
      ? snapshot.recordedFrames : null,
    recordStatus: ['saved', 'overflow', 'invalid', 'none'].includes(snapshot.recordStatus)
      ? snapshot.recordStatus : null,
  }
}

export function localizationNotice(ctx, config, routeConfigOf) {
  const candidates = new WeakMap()
  const recent = new Map()
  const subscribers = new Set()
  const encoder = new TextEncoder()

  function detailSnapshot(entry) {
    if (!entry) return { localizedProvider: null, prompt: null, transport: null }
    const localizeActive = entry.localizedProvider !== null
      && routeConfigOf(config.routes.get(), entry.localizedProvider).localizePrompt
    return {
      localizedProvider: localizeActive ? entry.localizedProvider : null,
      prompt: localizeActive ? entry.prompt : null,
      transport: entry.transport,
    }
  }

  function updateSession(sessionId, patch) {
    const prev = recent.get(sessionId) ?? { localizedProvider: null, prompt: null, transport: null }
    const next = {
      localizedProvider: Object.hasOwn(patch, 'localizedProvider') ? patch.localizedProvider : prev.localizedProvider,
      prompt: Object.hasOwn(patch, 'prompt') ? patch.prompt : prev.prompt,
      transport: Object.hasOwn(patch, 'transport') ? patch.transport : prev.transport,
    }
    const prevDetail = JSON.stringify(detailSnapshot(prev))
    const nextDetail = JSON.stringify(detailSnapshot(next))
    const isEmpty = next.localizedProvider === null && next.prompt === null && next.transport === null
    if (isEmpty) {
      recent.delete(sessionId)
    } else {
      if (recent.has(sessionId) && prevDetail === nextDetail) return
      recent.delete(sessionId)
      recent.set(sessionId, next)
      if (recent.size > recentLimit) {
        const evicted = recent.keys().next().value
        recent.delete(evicted)
        publish(evicted, JSON.stringify(detailSnapshot(undefined)))
      }
    }
    if (prevDetail !== nextDetail) publish(sessionId, nextDetail)
  }

  function publish(sessionId, payload) {
    for (const sub of subscribers) {
      if (sub.sessionId === sessionId) sub.update(payload)
    }
  }

  ctx.on('llm/stream', (options, next) => {
    const stream = next()
    const candidate = candidates.get(options.signal)
    if (!candidate || options.signal.aborted || candidate.sessionId !== options.sessionId || candidate.provider !== options.provider) return stream
    const confirmed = config.showStatusNotice.get() && candidate.prompt !== undefined
      && routeConfigOf(config.routes.get(), options.provider).localizePrompt
      && effectivePrompt(options.messages) === candidate.prompt
    updateSession(candidate.sessionId, {
      localizedProvider: confirmed ? candidate.provider : null,
      prompt: confirmed && candidate.stats ? { provider: candidate.provider, ...candidate.stats } : null,
    })
    return stream
  })

  function watch(request) {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('sessionId')
    if (!sessionId || sessionId.length > 256) return new Response(null, { status: 400 })
    if (!config.showStatusNotice.get() || request.signal.aborted) return new Response(null, { status: 204 })
    let pending = JSON.stringify(detailSnapshot(recent.get(sessionId)))
    let sent
    let controller
    let closed = false
    const cleanup = () => {
      subscribers.delete(sub)
      request.signal.removeEventListener('abort', close)
    }
    function close() {
      if (closed) return
      closed = true
      cleanup()
      try { controller.close() } catch { /* Stream may already be closed. */ }
    }
    function flush() {
      if (closed || controller.desiredSize <= 0 || sent === pending) return
      sent = pending
      controller.enqueue(encoder.encode(`data: ${sent}\n\n`))
    }
    const sub = { sessionId, close, update(payload) { pending = payload; flush() } }
    return new Response(new ReadableStream({
      start(stream) {
        controller = stream
        subscribers.add(sub)
        request.signal.addEventListener('abort', close, { once: true })
        flush()
      },
      pull: flush,
      cancel() {
        closed = true
        cleanup()
      },
    }), { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } })
  }

  // The shared /api carrier authenticates requests and admits only owner peers
  // to exact Fetch routes. No prompt text or credentials cross it.
  ctx.connection.fetch.register({ path: statusPath, methods: ['GET'], requestBody: 'buffered', fetch: watch })
  ctx.effect(() => () => {
    for (const sub of [...subscribers]) sub.close()
    recent.clear()
  })

  return {
    remember(context, provider, localized, stats = null) {
      const sessionId = context?.agent?.id
      const signal = context?.signal
      if (!sessionId || !signal || typeof provider !== 'string' || provider.length === 0) return
      const prompt = localized && config.showStatusNotice.get() ? expectedPrompt(localized) : undefined
      candidates.set(signal, { sessionId, provider, prompt, stats: normalizeStats(stats) })
    },
    recordTransport(sessionId, snapshot) {
      if (!config.showStatusNotice.get()) return
      if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 256) return
      if (snapshot === null) {
        updateSession(sessionId, { transport: null })
        return
      }
      const transport = normalizeTransport(snapshot)
      if (!transport) return
      updateSession(sessionId, { transport })
    },
  }
}
