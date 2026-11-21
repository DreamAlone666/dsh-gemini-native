import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeReplayState } from '../generate-content.js'
import { googleSearchActivity, searchActivityPath } from '../google-search-activity.js'

const session = { id: 'session-a' }
const snapshotEmpty = { liveTurn: null, cards: [] }
const encode = new TextEncoder()
const decoder = new TextDecoder()
const query = '当日天气'
const tool = { id: 'google-1', toolType: 'GOOGLE_SEARCH_WEB' }
const callPart = { toolCall: { ...tool, args: { queries: [query] } } }
const resultPart = { toolResponse: { ...tool, response: { results: [{ uri: 'https://example.org', title: 'Example' }] } } }

function frame(part) {
  return `data: ${JSON.stringify({ candidates: [{ content: { parts: [part] } }] })}\n\n`
}

function fixture(t, committed = new Map()) {
  const events = new Map()
  const agent = { ...session, session: { eventAt: seq => committed.get(seq) } }
  let dispose
  let route
  const observe = googleSearchActivity({
    get: key => key === 'sessionProjections' ? {} : undefined,
    on: (name, handler) => events.set(name, handler),
    effect: setup => { dispose = setup() },
    connection: { fetch: { register(def) { route = def } } },
  })
  t.after(() => dispose())
  assert.equal(route.path, searchActivityPath)
  assert.equal(route.fetch(new Request(`http://localhost${searchActivityPath}`)).status, 400)

  function watch(sessionId = session.id) {
    const request = new Request(`http://localhost${searchActivityPath}?sessionId=${sessionId}`)
    const reader = route.fetch(request).body.getReader()
    return {
      async read() {
        const result = await reader.read()
        if (!result.done) return JSON.parse(decoder.decode(result.value).slice(6))
      },
      dispose: () => reader.cancel(),
    }
  }
  async function latest(sessionId) {
    const stream = watch(sessionId)
    try { return await stream.read() } finally { await stream.dispose() }
  }
  function start(turn, step, attemptId) {
    events.get('agent/assistant-stream')({ agent, frame: { type: 'start', turn, step, attemptId } })
  }
  function end(attemptId, seq) {
    const outcome = seq === undefined ? { kind: 'abandoned' } : { kind: 'committed', eventType: 'assistant/attempt', seq }
    events.get('agent/assistant-stream')({ agent, frame: { type: 'end', attemptId, outcome } })
  }
  function closeTurn(turn) { events.get('session/event')(session, { type: 'turn/end', data: { turn } }) }
  return { observe, watch, latest, start, end, closeTurn, dispose }
}

function mockResponse() {
  let controller
  const response = new Response(new ReadableStream({ start(out) { controller = out } }), {
    headers: { 'Content-Type': 'text/event-stream' },
  })
  return { response, send: text => controller.enqueue(encode.encode(text)), close: () => controller.close() }
}

test('publishes one same-turn card as search progresses and never leaks it across sessions', { timeout: 3000 }, async t => {
  const f = fixture(t)
  const feed = f.watch()
  assert.deepEqual(await feed.read(), snapshotEmpty)
  assert.equal(f.observe(session.id), undefined)
  f.start(4, 2, 'request-1')
  const mock = mockResponse()
  const stream = f.observe(session.id)(mock.response).body.getReader()
  assert.deepEqual(await f.latest(), snapshotEmpty, 'request started, Gemini has not searched')
  mock.send(frame(callPart))
  await stream.read()
  assert.deepEqual(await feed.read(), { liveTurn: 4, cards: [{
    id: '4:2:request-1', turn: 4, step: 2, status: 'running', queries: [query], sources: [],
  }] })
  assert.deepEqual(await f.latest('another-session'), snapshotEmpty)
  mock.send(frame(resultPart))
  mock.close()
  await stream.read()
  assert.equal((await stream.read()).done, true)
  const completed = await feed.read()
  assert.deepEqual(completed.cards, [{
    id: '4:2:request-1', turn: 4, step: 2, status: 'completed', queries: [query],
    sources: [{ url: 'https://example.org/', title: 'Example' }],
  }])
  f.end('request-1')
  f.closeTurn(4)
  assert.deepEqual(await feed.read(), { ...completed, liveTurn: null })
  assert.deepEqual(await f.latest(), { ...completed, liveTurn: null }, 'reopening while Host is alive can restore the cards')
  f.dispose()
  assert.equal(await feed.read(), undefined)
})

test('no-search requests add no cards; incomplete attempts and late responses cannot look successful', { timeout: 3000 }, async t => {
  const f = fixture(t)
  f.start(1, 1, 'no-search')
  const sse = body => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
  const blank = frame({ text: 'normal response' })
  assert.equal(await f.observe(session.id)(sse(blank)).text(), blank)
  f.end('no-search')
  f.closeTurn(1)
  assert.deepEqual(await f.latest(), snapshotEmpty)
  f.start(2, 1, 'interrupted')
  const later = f.observe(session.id)
  const mock = mockResponse()
  const stream = later(mock.response).body.getReader()
  mock.send(frame(callPart))
  await stream.read()
  assert.equal((await f.latest()).cards[0].status, 'running')
  f.end('interrupted')
  f.closeTurn(2)
  const afterClose = await f.latest()
  assert.equal(afterClose.cards[0].status, 'incomplete')
  assert.equal(afterClose.liveTurn, null)
  f.start(3, 1, 'next')
  mock.send(frame(resultPart))
  mock.close()
  await stream.read()
  assert.equal((await stream.read()).done, true)
  const stale = sse(frame(resultPart))
  assert.strictEqual(later(stale), stale)
  assert.deepEqual(await f.latest(), afterClose)
})

test('only drops a temporary card when the matching committed attempt has a durable card', async t => {
  const committed = new Map()
  const f = fixture(t, committed)
  const sse = () => new Response(frame(resultPart), { headers: { 'Content-Type': 'text/event-stream' } })
  const reply = { type: 'finish', reason: { kind: 'stop' } }

  f.start(1, 1, 'not-recorded')
  await f.observe(session.id)(sse()).text()
  committed.set(8, { type: 'assistant/attempt', data: { stream: [{ type: 'chunk', chunk: reply }] } })
  f.end('not-recorded', 8)
  f.closeTurn(1)
  assert.equal((await f.latest()).cards[0].id, '1:1:not-recorded')

  f.start(1, 2, 'recorded')
  await f.observe(session.id)(sse()).text()
  const frames = [[{ index: 0, content: { parts: [resultPart] } }]]
  const replayState = makeReplayState({ identity: 'fixture' }, 'gemini', frames, [], 'failed', 'prefix')
  committed.set(9, { type: 'assistant/attempt', data: { stream: [{ type: 'chunk', chunk: { ...reply, replayState } }] } })
  f.end('recorded', 9)
  f.closeTurn(1)
  assert.deepEqual((await f.latest()).cards.map(card => card.id), ['1:1:not-recorded'])
})
