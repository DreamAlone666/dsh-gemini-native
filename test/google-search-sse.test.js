import assert from 'node:assert/strict'
import { test } from 'node:test'
import { observeGoogleSearchResponse } from '../google-search-sse.js'

const headers = { 'content-type': 'Text/Event-Stream; charset=utf-8', 'x-offline': 'preserved' }
const event = candidate => `data: ${JSON.stringify({ candidates: [candidate] })}\n\n`
const parts = (...parts) => ({ content: { parts } })
const grounding = groundingMetadata => ({ groundingMetadata })
const web = (uri, title) => ({ web: { uri, title } })
const call = (id, args, toolType = 'GOOGLE_SEARCH_WEB') => ({ toolCall: { id, toolType, args } })
const result = (id, response, toolType = 'GOOGLE_SEARCH_WEB') => ({ toolResponse: { id, toolType, response } })

function fixture(chunks, report) {
  const input = new Response(new ReadableStream({
    pull(controller) {
      if (!chunks.length) return controller.close()
      controller.enqueue(chunks.shift())
    },
  }, { highWaterMark: 0 }), { status: 202, statusText: 'Offline SSE', headers })
  return { input, output: observeGoogleSearchResponse(input, report) }
}

async function reportsFor(text) {
  const reports = []
  const { output } = fixture([Buffer.from(text)], update => reports.push(update))
  assert.equal(await output.text(), text)
  return reports
}

test('returns untouched non-Responses and ineligible Responses', async () => {
  const report = () => assert.fail('unexpected evidence')
  for (const input of [null, { ok: true, headers }, Response.error(), new Response('', { status: 400, headers }),
    new Response(null, { headers }), new Response('data: 1\n\n'),
    new Response('data: 1\n\n', { headers: { 'content-type': 'text/event-stream-other' } })]) {
    assert.equal(observeGoogleSearchResponse(input, report), input)
    assert.equal(input?.body?.locked ?? false, false)
  }
  const input = new Response('', { headers })
  const reader = input.body.getReader()
  assert.equal(observeGoogleSearchResponse(input, report), input)
  await reader.read()
  reader.releaseLock()
  assert.equal(observeGoogleSearchResponse(input, report), input)
})

test('preserves Response metadata and bytes with split UTF-8, split CRLF and multiline data', async () => {
  const wire = '\ufeff: comment\r\nid: 100\r\ndata: {"candidates":[\r\n' +
    'data: {"groundingMetadata":{"webSearchQueries":["北京 ☕"]}}\r\ndata: ]}\r\n\r\n' +
    event(grounding({ groundingChunks: [web('https://example.test/post', '北京')] })) +
    'event: message\r\ndata: [DONE]\r\n\r\n'
  const original = Buffer.from(wire)
  const reports = []
  const { input, output } = fixture(Array.from(original, byte => Uint8Array.of(byte)), update => reports.push(update))
  assert.notEqual(output, input)
  assert.equal(output.status, input.status)
  assert.equal(output.statusText, input.statusText)
  assert.deepEqual([...output.headers], [...input.headers])
  assert.deepEqual(reports, [])
  assert.deepEqual(Buffer.from(await output.arrayBuffer()), original)
  assert.equal(input.body.locked, false)
  assert.deepEqual(reports, [
    { status: 'completed', queries: ['北京 ☕'], sources: [] },
    { status: 'completed', queries: ['北京 ☕'], sources: [{ url: 'https://example.test/post', title: '北京' }] },
  ])
})

test('ignores unknown parts, suggestions, invalid evidence and non-first candidates', async () => {
  const wire = event(parts(
    { text: 'I searched Google' },
    { functionCall: { name: 'google_search', args: { query: 'not native' } } },
    { toolCall: { name: 'GOOGLE_SEARCH_WEB' }, toolResponse: { toolType: 'URL_CONTEXT' } },
    call('image', { query: 'images' }, 'GOOGLE_SEARCH_IMAGE'),
  )) + event(grounding({
    groundingChunks: [web('javascript:alert(1)'), web('https://user:pass@secret.test/'), web('https://@secret.test/'),
      { maps: { uri: 'https://maps.test/' } }, { retrievedContext: { uri: 'https://private.test/' } }],
    webSearchQueries: ['', '\u0000\u202e', null, 3],
    searchEntryPoint: { renderedContent: '<a href="https://ignored.test">search</a>' },
  })) + event(grounding({})) + `data: ${JSON.stringify({
    candidates: [parts({ text: 'first' }), grounding({ webSearchQueries: ['second'] })],
    webSearchQueries: ['root'],
  })}\n\n`
  assert.deepEqual(await reportsFor(wire), [])
})

test('reports cumulative grounding fallback, sanitizing and clamping display data', async () => {
  const wire = event(grounding({ webSearchQueries: ['  🌏\r\n\u202e x\u0000   y ', '🌏 x y', 'z'.repeat(500),
    ...Array.from({ length: 15 }, (_, i) => `q${i}`)] })) + event(grounding({
    groundingChunks: [web('HTTPS://EXAMPLE.TEST:443/a'), web('https://example.test/a', '\u2067Readable\t title\u0000'),
      web('ftp://ignored.test/a'), web('https://example.test/\tbad'), web(`https://example.test/${'a'.repeat(2100)}`),
      ...Array.from({ length: 10 }, (_, i) => web(`http://example.test/${i}`, 't'.repeat(300)))],
  })) + event(grounding({ groundingChunks: [web('https://example.test/a', 'No duplicate')] }))
  const reports = await reportsFor(wire)
  assert.equal(reports.length, 2)
  assert.equal(reports[0].status, 'completed')
  assert.deepEqual(reports[0].queries, ['🌏 x y', 'z'.repeat(240), ...Array.from({ length: 10 }, (_, i) => `q${i}`)])
  assert.equal(reports[1].status, 'completed')
  assert.deepEqual(reports[1].queries, reports[0].queries)
  assert.equal(reports[1].sources.length, 8)
  assert.deepEqual(reports[1].sources[0], { url: 'https://example.test/a', title: 'Readable title' })
  assert.deepEqual(reports[1].sources[1], { url: 'http://example.test/0', title: 't'.repeat(200) })
  assert.deepEqual(await reportsFor(event(grounding({ groundingChunks: [web('https://isolated.test/')] }))), [
    { status: 'completed', queries: [], sources: [{ url: 'https://isolated.test/', title: 'isolated.test' }] },
  ])
})

test('explicit native call stays running until a correlated native result, including across grounding and EOF', async () => {
  const start = event(parts(call('abc', { queries: ['one'] }))) + event(grounding({
    webSearchQueries: ['one'], groundingChunks: [web('https://early.test/ref')],
  })) + event(parts(result('not-abc', {}), result('abc', {}, 'GOOGLE_SEARCH_IMAGE')))
  const running = [
    { status: 'running', queries: ['one'], sources: [] },
    { status: 'running', queries: ['one'], sources: [{ url: 'https://early.test/ref', title: 'early.test' }] },
  ]
  assert.deepEqual(await reportsFor(start + 'data: [DONE]\n\n'), running)
  const report = await reportsFor(start + event(parts(result('abc', {
    searchQueries: ['one', 'two'], results: [{ url: 'https://results.test/ref', title: 'Result' }],
  }, 'GOOGLE_SEARCH'))) + event(grounding({ groundingChunks: [web('https://later.test/ref', 'Later')] })))
  const completed = {
    status: 'completed', queries: ['one', 'two'],
    sources: [running[1].sources[0], { url: 'https://results.test/ref', title: 'Result' }],
  }
  assert.deepEqual(report, [...running, completed, {
    ...completed, sources: [...completed.sources, { url: 'https://later.test/ref', title: 'Later' }],
  }])
  assert.deepEqual(await reportsFor(event(parts(result(undefined, {})))), [{ status: 'completed', queries: [], sources: [] }])
})

test('passes oversized, ill-formed UTF-8, malformed, and incomplete events through without reporting them', async () => {
  const oversized = event(grounding({ webSearchQueries: ['oversized'], extra: 'x'.repeat(100 * 1024) }))
  const invalidUtf8 = Buffer.concat([Buffer.from('data: {"candidates":[{"groundingMetadata":{"webSearchQueries":["'),
    Buffer.from([0xff]), Buffer.from('"]}}]}\n\n')])
  const valid = event(grounding({ webSearchQueries: ['recover'] }))
  const incomplete = event(parts(result('abc', {}))).slice(0, -1)
  const wire = Buffer.concat([Buffer.from(oversized + 'data: {bad json}\r\n\r\ndata: [DONE]\n\n'), invalidUtf8,
    Buffer.from(valid + incomplete)])
  const reports = []
  const { output } = fixture([wire.subarray(0, 70 * 1024), wire.subarray(70 * 1024)], update => reports.push(update))
  assert.deepEqual(Buffer.from(await output.arrayBuffer()), wire)
  assert.deepEqual(reports, [{ status: 'completed', queries: ['recover'], sources: [] }])
})

test('report exceptions and mutations do not affect provider bytes or subsequent snapshots', async () => {
  const wire = event(grounding({ groundingChunks: [web('https://example.test/', 'first')] })) +
    event(grounding({ webSearchQueries: ['next'] }))
  const reports = []
  const { output } = fixture([Buffer.from(wire)], update => {
    reports.push(structuredClone(update))
    update.queries.push('injected')
    update.sources[0].title = 'injected'
    throw new Error('offline reporter failure')
  })
  assert.equal(await output.text(), wire)
  assert.equal(reports.length, 2)
  assert.deepEqual(reports[1], { status: 'completed', queries: ['next'], sources: [{ url: 'https://example.test/', title: 'first' }] })
})

test('reads on downstream demand only and forwards cancellation intact', async () => {
  let pulls = 0
  let cancelled
  const chunk = Uint8Array.of(0)
  const input = new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(chunk) },
    cancel(reason) { cancelled = reason },
  }, { highWaterMark: 0 }), { headers })
  const output = observeGoogleSearchResponse(input, () => assert.fail('unexpected evidence'))
  const reader = output.body.getReader()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(pulls, 0)
  assert.equal((await reader.read()).value, chunk)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(pulls, 1)
  const reason = new Error('offline cancellation')
  await reader.cancel(reason)
  assert.equal(cancelled, reason)
  assert.equal(input.body.locked, false)
})

test('cancels a pending upstream read without emitting after cancellation', async () => {
  let pulled
  const started = new Promise(resolve => { pulled = resolve })
  let cancelled
  const input = new Response(new ReadableStream({
    pull() { pulled() },
    cancel(reason) { cancelled = reason },
  }, { highWaterMark: 0 }), { headers })
  const output = observeGoogleSearchResponse(input, () => assert.fail('unexpected evidence'))
  const reader = output.body.getReader()
  const waiting = reader.read()
  await started
  const reason = new Error('cancel pending read')
  await reader.cancel(reason)
  assert.deepEqual(await waiting, { done: true, value: undefined })
  assert.equal(cancelled, reason)
  assert.equal(input.body.locked, false)
})

test('propagates upstream errors unchanged and releases the reader lock', async () => {
  const failure = new Error('offline transport failed')
  const input = new Response(new ReadableStream({ pull(controller) { controller.error(failure) } }), { headers })
  const output = observeGoogleSearchResponse(input, () => assert.fail('unexpected evidence'))
  await assert.rejects(output.text(), error => error === failure)
  assert.equal(input.body.locked, false)
})
