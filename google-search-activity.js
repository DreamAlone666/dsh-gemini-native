import { observeGoogleSearchResponse } from './google-search-sse.js'

export const searchActivityPath = '/api/dsh-gemini-enhancement/search-activity'
const sessionLimit = 48
const cardLimit = 12
const empty = { liveTurn: null, cards: [] }

/** Read-only presentation state for this Host run, not Session history. */
export function googleSearchActivity(ctx) {
  const attempts = new Map()
  const views = new Map()
  const watchers = new Map()
  const encoder = new TextEncoder()

  function notify(sessionId, view) {
    for (const watch of watchers.get(sessionId) ?? []) watch.update(view)
  }

  function publish(sessionId, view) {
    views.delete(sessionId)
    views.set(sessionId, view)
    if (views.size > sessionLimit) {
      const oldest = [...views].find(([id, candidate]) => id !== sessionId && candidate.liveTurn === null)?.[0]
        ?? views.keys().next().value
      views.delete(oldest)
      notify(oldest, empty)
    }
    notify(sessionId, view)
  }

  function endAttempt(sessionId, attemptId) {
    const attempt = attempts.get(sessionId)
    if (attempt === undefined || attempt.attemptId !== attemptId) return
    attempts.delete(sessionId)
    const view = views.get(sessionId)
    if (!view?.cards.some(card => card.id === attempt.id && (attempt.liveOnly || card.status === 'running'))) return
    const cards = attempt.liveOnly ? view.cards.filter(card => card.id !== attempt.id)
      : view.cards.map(card => card.id === attempt.id && card.status === 'running'
        ? { ...card, status: 'incomplete' } : card)
    publish(sessionId, { ...view, cards })
  }

  function endTurn(sessionId, turn) {
    const view = views.get(sessionId)
    if (view?.liveTurn === turn) publish(sessionId, { ...view, liveTurn: null })
  }

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const sessionId = agent.id
    if (frame.type === 'start') {
      const old = attempts.get(sessionId)
      if (old) endAttempt(sessionId, old.attemptId)
      const { attemptId, turn, step } = frame
      attempts.set(sessionId, { attemptId, turn, step, id: `${turn}:${step}:${attemptId}` })
    } else if (frame.type === 'end') endAttempt(sessionId, frame.attemptId)
  })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') endTurn(session.id, event.data.turn)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const attempt = attempts.get(agent.id)
    if (attempt) endAttempt(agent.id, attempt.attemptId)
    endTurn(agent.id, views.get(agent.id)?.liveTurn)
  })

  function watch(request) {
    const sessionId = new URL(request.url).searchParams.get('sessionId')
    if (!sessionId || sessionId.length > 256) return new Response(null, { status: 400 })
    if (request.signal.aborted) return new Response(null, { status: 204 })
    let pending = views.get(sessionId) ?? empty
    let sent
    let controller
    const subscribers = watchers.get(sessionId) ?? new Set()
    const dispose = () => {
      subscribers.delete(subscriber)
      if (subscribers.size === 0) watchers.delete(sessionId)
      request.signal.removeEventListener('abort', close)
    }
    const close = () => { dispose(); controller.close() }
    const flush = () => {
      if (controller.desiredSize <= 0 || sent === pending) return
      sent = pending
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(sent)}\n\n`))
    }
    const subscriber = { close, update(view) { pending = view; flush() } }
    return new Response(new ReadableStream({
      start(stream) {
        controller = stream
        watchers.set(sessionId, subscribers)
        subscribers.add(subscriber)
        request.signal.addEventListener('abort', close, { once: true })
        flush()
      },
      pull: flush,
      cancel: dispose,
    }), { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } })
  }

  // The matched Fetch carrier is authenticated and owner-only. It does not put
  // these updates on the Agent's model-facing surface or the Session log.
  ctx.connection.fetch.register({ path: searchActivityPath, methods: ['GET'], requestBody: 'buffered', fetch: watch })
  ctx.effect(() => () => {
    attempts.clear()
    views.clear()
    for (const group of watchers.values()) for (const sub of group) sub.close()
    watchers.clear()
  })

  function reportFor(sessionId, liveOnly = false) {
    const attempt = attempts.get(sessionId)
    if (!attempt) return undefined
    attempt.liveOnly = liveOnly
    return report => {
      if (attempts.get(sessionId) !== attempt) return
      const { id, turn, step } = attempt
      const view = views.get(sessionId) ?? empty
      const previous = view.cards.find(card => card.id === id)
      const card = {
        id, turn, step,
        status: report.status,
        // An SDK retry can produce another response for the same Agent attempt.
        queries: [...new Set([...(previous?.queries ?? []), ...report.queries])].slice(0, 12),
        sources: [...new Map([...(previous?.sources ?? []), ...report.sources].map(source => [source.url, source])).values()].slice(0, 8),
      }
      if (previous && JSON.stringify(previous) === JSON.stringify(card)) return
      const cards = previous ? view.cards.map(item => item === previous ? card : item) : [...view.cards, card].slice(-cardLimit)
      publish(sessionId, { liveTurn: turn, cards })
    }
  }

  function observerFor(sessionId) {
    const attempt = attempts.get(sessionId)
    const report = reportFor(sessionId)
    if (!report) return undefined
    return response => {
      if (attempts.get(sessionId) !== attempt) return response
      try { return observeGoogleSearchResponse(response, report) } catch { return response }
    }
  }
  return Object.assign(observerFor, { reportFor })
}
