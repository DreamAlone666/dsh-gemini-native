const statusPath = '/api/dsh-gemini-enhancement/status'
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

export function localizationNotice(ctx, config, matchesModelId) {
  const candidates = new WeakMap()
  const recent = new Map()
  const subscribers = new Set()
  const encoder = new TextEncoder()

  function publish(sessionId, model) {
    if ((recent.get(sessionId) ?? null) === model) return
    recent.delete(sessionId)
    if (model !== null) {
      recent.set(sessionId, model)
      if (recent.size > recentLimit) {
        const evicted = recent.keys().next().value
        recent.delete(evicted)
        for (const sub of subscribers) if (sub.sessionId === evicted) sub.update(null)
      }
    }
    for (const sub of subscribers) if (sub.sessionId === sessionId) sub.update(model)
  }

  ctx.on('llm/stream', (options, next) => {
    const stream = next()
    const candidate = candidates.get(options.signal)
    if (!candidate || options.signal.aborted || candidate.sessionId !== options.sessionId || candidate.model !== options.model) return stream
    const confirmed = config.showLocalizationNotice.get() && candidate.prompt !== undefined
      && matchesModelId(options.model, config.modelIds.get())
      && effectivePrompt(options.messages) === candidate.prompt
    publish(candidate.sessionId, confirmed ? candidate.model : null)
    return stream
  })

  function watch(request) {
    const sessionId = new URL(request.url).searchParams.get('sessionId')
    if (!sessionId || sessionId.length > 256) return new Response(null, { status: 400 })
    if (!config.showLocalizationNotice.get() || request.signal.aborted) return new Response(null, { status: 204 })
    let pending = recent.get(sessionId) ?? null
    if (!matchesModelId(pending, config.modelIds.get())) pending = null
    let sent
    let controller
    const cleanup = () => {
      subscribers.delete(sub)
      request.signal.removeEventListener('abort', close)
    }
    function close() {
      cleanup()
      controller.close()
    }
    function flush() {
      if (controller.desiredSize <= 0 || sent === pending) return
      sent = pending
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(sent)}\n\n`))
    }
    const sub = { sessionId, close, update(model) { pending = model; flush() } }
    return new Response(new ReadableStream({
      start(stream) {
        controller = stream
        subscribers.add(sub)
        request.signal.addEventListener('abort', close, { once: true })
        flush()
      },
      pull: flush,
      cancel: cleanup,
    }), { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } })
  }

  // The shared /api carrier authenticates requests and admits only owner peers
  // to exact Fetch routes. No prompt text or provider information crosses it.
  ctx.connection.fetch.register({ path: statusPath, methods: ['GET'], requestBody: 'buffered', fetch: watch })
  ctx.effect(() => () => {
    for (const sub of subscribers) sub.close()
    recent.clear()
  })

  return {
    remember(context, model, localized) {
      const sessionId = context?.agent?.id
      const signal = context?.signal
      if (!sessionId || !signal || typeof model !== 'string') return
      const prompt = localized && config.showLocalizationNotice.get() ? expectedPrompt(localized) : undefined
      candidates.set(signal, { sessionId, model, prompt })
    },
  }
}
