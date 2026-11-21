import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import * as plugin from '../index.js'
import { geminiTransport } from '../gemini-transport.js'
import { attachNativeReplay, historyFingerprint, makeNativeReplayData, normalizeEndpoint, routeIdentity } from '../generate-content.js'
import { searchActivityPath } from '../google-search-activity.js'

const model = 'gemini-4-hydrogen'
const baseURL = 'https://gemini.test/relay/v1beta'
const generation = `${baseURL}/models/${model}:streamGenerateContent?alt=sse`
const declaration = { name: 'read_mock', description: 'Read a mock value', parameters: { type: 'object', properties: {} } }
const webSearch = { ...declaration, name: 'web_search' }
const webFetch = { ...declaration, name: 'web_fetch' }
const baseBody = { contents: [{ role: 'user', parts: [{ text: 'offline' }] }], tools: [{ functionDeclarations: [declaration] }] }

function transportFixture(t) {
  const handlers = new Map()
  const original = globalThis.fetch
  const sentinel = Symbol('response')
  const calls = []
  const offlineFetch = (input, init) => { calls.push({ input, init }); return sentinel }
  globalThis.fetch = offlineFetch
  t.after(() => { globalThis.fetch = original })
  let cleanup
  let routes = { mock: { localizePrompt: false, nativeHistory: false, googleSearch: true } }
  let markerMissing = false
  const warnings = []
  geminiTransport({
    loader: { resolve: () => {
      if (markerMissing) throw new Error('no llm entry')
      return { moduleNamespace: { isAgentLoopRequest: request => request.agent === true } }
    } },
    logger: { warn: message => warnings.push(message) },
    on: (event, fn) => handlers.set(event, fn),
    effect: start => { cleanup = start() },
  }, { routes: { get: () => routes } }, plugin.routeConfigOf)

  function run({ provider = 'mock', loop = true, purpose, input = generation, rawBody = JSON.stringify(baseBody), intact = false } = {}) {
    const headers = new Headers({ 'x-goog-api-key': 'synthetic', 'content-length': '1' })
    const signal = new AbortController().signal
    const request = Object.freeze({ provider, model, sessionId: 'test', agent: loop, purpose })
    const init = { method: 'POST', headers, signal, body: rawBody }
    const stream = handlers.get('llm/stream')(request, async function* () {
      await Promise.resolve()
      assert.strictEqual(handlers.get('llm-pi-ai/request-headers')({ ...request, baseURL }, headers, () => headers), headers)
      assert.equal(globalThis.fetch(input, init), sentinel)
      yield 'stream unchanged'
    })
    return stream[Symbol.asyncIterator]().next().then(item => {
      assert.equal(item.value, 'stream unchanged')
      const call = calls.at(-1)
      assert.strictEqual(call.input, input)
      assert.strictEqual(call.init.signal, signal)
      if (intact) assert.strictEqual(call.init, init)
      return call.init
    })
  }
  return {
    run,
    offlineFetch,
    cleanup,
    warnings,
    setRoutes: value => { routes = value },
    loseMarker: () => { markerMissing = true },
  }
}

test('rewrites only scoped Gemini provider requests, preserving request and response ownership', async t => {
  const f = transportFixture(t)
  f.setRoutes({})
  await f.run({ intact: true })
  assert.equal(globalThis.fetch, f.offlineFetch)
  f.setRoutes({ mock: { localizePrompt: false, nativeHistory: false, googleSearch: true } })
  const init = await f.run()
  assert.deepEqual(JSON.parse(init.body), {
    ...baseBody, tools: [...baseBody.tools, { googleSearch: {} }], toolConfig: { includeServerSideToolInvocations: true },
  })
  assert.deepEqual(Object.fromEntries(init.headers), { 'x-goog-api-key': 'synthetic' })
  await f.run({ provider: 'other-provider', intact: true })
  for (const input of [
    `${baseURL}/chat/completions`, `${baseURL}/models/${model}:streamGenerateContent`,
    `${baseURL}/models/another:streamGenerateContent?alt=sse`, generation.replace('/relay/', '/other/'),
    generation.replace('gemini.test', 'other.test'), new Request(generation),
  ]) await f.run({ input, intact: true })
  await f.run({ loop: false, intact: true })
  await f.run({ purpose: 'session-title', intact: true })
  f.setRoutes({ mock: { localizePrompt: true, nativeHistory: false, googleSearch: false } })
  await f.run({ intact: true })
  f.cleanup()
  assert.equal(globalThis.fetch, f.offlineFetch)
})

test('handles search-only payloads and respects existing tools and calling modes', async t => {
  const f = transportFixture(t)
  const raw = body => JSON.stringify({ ...baseBody, ...body })
  const searchOnly = await f.run({ rawBody: raw({ tools: undefined }) })
  assert.deepEqual(JSON.parse(searchOnly.body), { contents: baseBody.contents, tools: [{ googleSearch: {} }] })
  const validated = { functionCallingConfig: { mode: 'VALIDATED', allowedFunctionNames: ['read_mock'] } }
  const mixed = await f.run({ rawBody: raw({ toolConfig: validated }) })
  assert.deepEqual(JSON.parse(mixed.body).toolConfig, { ...validated, includeServerSideToolInvocations: true })
  for (const rawBody of [
    '{malformed', raw({ tools: [{ googleSearch: {} }] }), raw({ tools: [{ google_search: {} }] }),
    raw({ toolConfig: { includeServerSideToolInvocations: false } }), raw({ toolConfig: { functionCallingConfig: { mode: 'AUTO' } } }),
  ]) await f.run({ rawBody, intact: true })
  f.loseMarker()
  await f.run({ intact: true })
  await f.run({ intact: true })
  assert.equal(f.warnings.length, 1)
  f.cleanup()
})

test('replaces only web_search and preserves other declarations, grouping and routing policy', async t => {
  const f = transportFixture(t)
  const raw = (tools, toolConfig) => JSON.stringify({ ...baseBody, tools, toolConfig })
  const grouped = [{ functionDeclarations: [webSearch] }, { functionDeclarations: [webFetch, webSearch, declaration] }]
  const calling = allowedFunctionNames => ({ functionCallingConfig: { mode: 'VALIDATED', allowedFunctionNames } })
  const names = ['web_search', 'web_fetch']
  const mixed = await f.run({ rawBody: raw(grouped, calling(names)) })
  assert.deepEqual(JSON.parse(mixed.body).tools, [{ functionDeclarations: [webFetch, declaration] }, { googleSearch: {} }])
  assert.deepEqual(JSON.parse(mixed.body).toolConfig, { ...calling(['web_fetch']), includeServerSideToolInvocations: true })
  const searchOnly = await f.run({ rawBody: raw([grouped[0]], calling(['web_search'])) })
  assert.deepEqual(JSON.parse(searchOnly.body), { contents: baseBody.contents, tools: [{ googleSearch: {} }] })
  const anotherNativeTool = { urlContext: {} }
  const combinedEntry = await f.run({ rawBody: raw([{ ...grouped[0], ...anotherNativeTool }]) })
  assert.deepEqual(JSON.parse(combinedEntry.body).tools, [anotherNativeTool, { googleSearch: {} }])
  await f.run({ rawBody: raw(grouped, calling(['web_search'])), intact: true })
  await f.run({ rawBody: raw(grouped, { functionCallingConfig: { mode: 'AUTO' } }), intact: true })
  f.setRoutes({})
  await f.run({ rawBody: raw(grouped), intact: true })
  f.cleanup()
})

test('disposal leaves a later fetch wrapper installed and disables the inner wrapper', async t => {
  const f = transportFixture(t)
  await f.run()
  const inner = globalThis.fetch
  const later = (...args) => inner(...args)
  globalThis.fetch = later
  f.cleanup()
  assert.equal(globalThis.fetch, later)
  await f.run({ intact: true })
})

test('geminiTransport performs read-only prefix alignment for same-route compaction without recording, reporting, or XHigh', async t => {
  const handlers = new Map()
  const original = globalThis.fetch
  const sentinelResponse = Symbol('raw-compaction-response')
  const calls = []
  const reports = []
  let routes = { mock: { localizePrompt: false, nativeHistory: true, googleSearch: true } }
  let sessionsService = null
  const offlineFetch = (input, init) => { calls.push({ input, init }); return sentinelResponse }
  globalThis.fetch = offlineFetch
  t.after(() => { globalThis.fetch = original })

  let cleanup
  geminiTransport({
    get: name => name === 'sessions' ? sessionsService : undefined,
    loader: { resolve: () => ({ moduleNamespace: { isAgentLoopRequest: request => request.agent === true } }) },
    logger: { warn() {} },
    on: (event, fn) => handlers.set(event, fn),
    effect: start => { cleanup = start() },
  }, { routes: { get: () => routes } }, plugin.routeConfigOf, (sessionId, liveOnly) => {
    reports.push({ sessionId, liveOnly })
    return () => {}
  }, sessionId => sessionId === 'sess-1')
  t.after(() => cleanup?.())

  const normalizedURL = normalizeEndpoint(baseURL)
  const route = { baseURL: normalizedURL, provider: 'mock', googleSearch: true }
  route.identity = routeIdentity(route)
  const localId = 'local-read-1'
  const nativeParts = [
    { thought: true, text: 'checking', thoughtSignature: 'sig-1' },
    { toolCall: { id: 'g-1', toolType: 'GOOGLE_SEARCH_WEB', args: { queries: ['dsh'] } }, thoughtSignature: 'sig-2' },
    { toolResponse: { id: 'g-1', toolType: 'GOOGLE_SEARCH_WEB', response: { sources: [{ uri: 'https://example.org', title: 'Ex' }] } }, thoughtSignature: 'sig-3' },
    { functionCall: { id: 'wire-read-1', name: 'read_mock', args: { path: 'a.txt' } }, thoughtSignature: 'sig-4' },
  ]
  const nativeBlocks = [
    { type: 'reasoning', text: 'checking' },
    { type: 'tool-call', id: localId, name: 'read_mock', arguments: JSON.stringify({ path: 'a.txt' }) },
  ]
  const prefix = historyFingerprint([{ role: 'user', parts: [{ text: 'hello' }] }])
  const nativeData = makeNativeReplayData(
    route, model, [[{ index: 0, content: { role: 'model', parts: nativeParts }, finishReason: 'STOP' }]],
    [localId], 'complete', prefix, nativeBlocks,
  )
  const replayState = attachNativeReplay(
    { response: { kind: 'pi-ai', version: 2, api: 'google-generative-ai', provider: 'mock', model, stopReason: 'toolUse' }, blocks: [] },
    nativeData,
  )
  const historyMessages = [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'assistant', content: nativeBlocks, source: { kind: 'model', provider: 'mock', model, replayState } },
    { role: 'tool', toolCallId: localId, content: [{ type: 'text', text: 'done' }] },
  ]
  const wireHistory = [
    { role: 'user', parts: [{ text: 'hello' }] },
    { role: 'model', parts: [{ thought: true, text: 'checking' }, { functionCall: { id: localId, name: 'read_mock', args: { path: 'a.txt' } } }] },
    { role: 'user', parts: [{ functionResponse: { id: localId, name: 'read_mock', response: { output: 'done' } } }] },
  ]
  const compactionBody = {
    contents: [...wireHistory, { role: 'user', parts: [{ text: 'Condense the conversation ABOVE.' }] }],
    tools: [{ functionDeclarations: [declaration, webSearch] }],
  }

  async function invoke({
    provider = 'mock',
    targetModel = model,
    sessionId = 'sess-1',
    loop = false,
    purpose = 'compaction',
    messages = [...historyMessages, { role: 'user', content: [{ type: 'text', text: 'Condense the conversation ABOVE.' }] }],
    body = compactionBody,
    intact = false,
  } = {}) {
    const input = `${baseURL}/models/${targetModel}:streamGenerateContent?alt=sse`
    const headers = new Headers({ 'x-goog-api-key': 'synthetic', 'content-length': '1' })
    const signal = new AbortController().signal
    const request = Object.freeze({ provider, model: targetModel, sessionId, agent: loop, purpose, messages })
    const init = { method: 'POST', headers, signal, body: JSON.stringify(body) }
    let returnedResponse
    const stream = handlers.get('llm/stream')(request, async function* () {
      await Promise.resolve()
      handlers.get('llm-pi-ai/request-headers')({ ...request, baseURL }, headers, () => headers)
      returnedResponse = globalThis.fetch(input, init)
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'summary' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    const call = calls.at(-1)
    if (intact) assert.strictEqual(call.init, init)
    return { init: call.init, body: JSON.parse(call.init.body), chunks, returnedResponse }
  }

  const setSessionHeader = header => {
    sessionsService = { get: id => id === 'sess-1' ? { requestHeader: () => header } : undefined }
  }
  setSessionHeader({ config: { provider: 'mock', model } })

  // 1. nativeHistory + googleSearch enabled (even with XHigh enabled on session):
  // aligns contents, functionResponse.id, tools, toolConfig; read-only (no replayState, no reportFor, no SSE wrap, no XHIGH).
  const aligned = await invoke()
  assert.strictEqual(aligned.returnedResponse, sentinelResponse, 'compaction must not wrap response for SSE observation')
  assert.deepEqual(aligned.body.contents[1], { role: 'model', parts: nativeParts })
  assert.equal(aligned.body.contents[2].parts[0].functionResponse.id, 'wire-read-1')
  assert.deepEqual(aligned.body.tools, [{ functionDeclarations: [declaration] }, { googleSearch: {} }])
  assert.equal(aligned.body.toolConfig.includeServerSideToolInvocations, true)
  assert.equal(aligned.body.generationConfig, undefined, 'compaction must never inject XHIGH')
  assert.equal(aligned.chunks.at(-1).replayState, undefined, 'compaction must not attach native replayState')
  assert.equal(reports.length, 0, 'compaction must not call reportFor')

  // 2. googleSearch only (nativeHistory: false) with XHigh enabled: aligns tools/toolConfig only, read-only.
  routes = { mock: { localizePrompt: false, nativeHistory: false, googleSearch: true } }
  const searchOnly = await invoke()
  assert.strictEqual(searchOnly.returnedResponse, sentinelResponse, 'search-only compaction must not observe response')
  assert.deepEqual(searchOnly.body.tools, [{ functionDeclarations: [declaration] }, { googleSearch: {} }])
  assert.equal(searchOnly.body.toolConfig.includeServerSideToolInvocations, true)
  assert.deepEqual(searchOnly.body.contents[1], wireHistory[1])
  assert.equal(searchOnly.body.contents[2].parts[0].functionResponse.id, localId)
  assert.equal(searchOnly.body.generationConfig, undefined)
  assert.equal(reports.length, 0)

  // 3. Cross-model, cross-provider, missing requestHeader, missing session, or missing sessions service: stay completely intact.
  routes = {
    mock: { localizePrompt: false, nativeHistory: true, googleSearch: true },
    other: { localizePrompt: false, nativeHistory: true, googleSearch: true },
  }
  await invoke({ targetModel: 'gemini-3-flash', intact: true })
  await invoke({ provider: 'other', intact: true })
  await invoke({ sessionId: 'unknown-session', intact: true })
  setSessionHeader(undefined)
  await invoke({ intact: true })
  sessionsService = null
  await invoke({ intact: true })

  // 4. Other auxiliary purposes (like session-title) stay completely intact even when same provider/model.
  setSessionHeader({ config: { provider: 'mock', model } })
  await invoke({ purpose: 'session-title', intact: true })
  assert.equal(reports.length, 0)
})

const installed = process.env.DSH_INSTALL_DIR

test('installed DSH: Loader, per-provider transport scoping, SDK payload, activity and live updates', { skip: !installed, timeout: 5000 }, async t => {
  const require = createRequire(join(installed, 'package.json'))
  const load = spec => import(pathToFileURL(require.resolve(spec)).href)
  const { Context } = await load('@deepseek-ai/cordis')
  const { Loader } = await load('@deepseek-ai/cordis-plugin-loader')
  const { Include } = await load('@deepseek-ai/cordis-plugin-include')
  const llm = await load('@deepseek-ai/dsh-llm')
  const pi = await load('@deepseek-ai/dsh-llm-pi-ai')
  const { SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
  const fixture = await mkdtemp(join(tmpdir(), 'dsh-gemini-test-'))
  const configPath = join(fixture, 'cordis.json')
  const llmUrl = pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href
  await writeFile(configPath, JSON.stringify([{ id: 'llm', name: llmUrl }]))
  const ctx = new Context()
  const system = ctx.plugin(SystemPrompt)
  const configUrl = pathToFileURL(configPath).href
  const loader = ctx.plugin(class extends Loader { commit() {} }, { baseUrl: configUrl })
  t.after(async () => {
    await loader.dispose()
    await system.dispose()
    await rm(fixture, { recursive: true, force: true })
  })
  await system
  await loader
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.enhancement = plugin
  await ctx.loader.create({ id: 'include', name: 'cordis:include', config: { path: configUrl } })
  await ctx.loader.await()
  assert.strictEqual(ctx.loader.resolve('include:llm').moduleNamespace.isAgentLoopRequest, llm.isAgentLoopRequest)
  ctx.provide('credentials', {
    async resolve() { await new Promise(resolve => setImmediate(resolve)); return { value: 'synthetic' } },
    async readRecord() {},
  })
  const routes = new Map()
  ctx.provide('connection', { fetch: { register(route) { routes.set(route.path, route) } } })
  const adapter = ctx.plugin(pi, { providers: {
    gemini: { api: 'google-generative-ai', baseURL, apiKeyEnv: 'SYNTHETIC_KEY', models: [{ id: model }, { id: 'gemini-3-flash' }] },
    gateway: { api: 'google-generative-ai', baseURL: 'https://gateway.test/v1beta', apiKeyEnv: 'SYNTHETIC_KEY', models: [{ id: model }] },
    compatible: { api: 'openai-completions', baseURL: 'https://openai.test/v1', apiKeyEnv: 'SYNTHETIC_KEY', models: [{ id: model }] },
  } })
  t.after(() => adapter.dispose())
  await adapter

  const original = globalThis.fetch
  const captures = new Map()
  const offline = async (input, init) => {
    const url = new URL(input)
    const body = JSON.parse(init.body)
    assert.ok(['gemini.test', 'gateway.test', 'openai.test'].includes(url.hostname))
    if (url.hostname === 'openai.test') {
      captures.set('openai', { url, body })
      return new Response(JSON.stringify({ error: { message: 'Offline test stub' } }), { status: 400, headers: { 'content-type': 'application/json' } })
    }
    assert.equal(new Headers(init.headers).get('x-goog-api-key'), 'synthetic')
    captures.set(body.contents[0].parts[0].text, { url, body })
    const prompt = body.contents[0].parts[0].text
    const reply = { candidates: [{
      content: { role: 'model', parts: [{ text: 'Mock answer, unchanged.' }] }, finishReason: 'STOP',
      ...(prompt === 'reported-search' ? { groundingMetadata: { webSearchQueries: ['offline Google query'] } } : {}),
    }] }
    return new Response(`data: ${JSON.stringify(reply)}\r\n\r\n`, { headers: { 'content-type': 'text/event-stream' } })
  }
  globalThis.fetch = offline
  t.after(() => { globalThis.fetch = original })
  await ctx.loader.create({ id: 'gemini-enhancement', name: 'cordis:enhancement', config: {} })
  const fiber = ctx.loader.resolve('gemini-enhancement').fiber

  function invoke(label, { provider = 'gemini', selected = model, loop = true, purpose } = {}) {
    return (async () => {
      const prepared = await ctx.llm.prepareCall({ provider, model: selected })
      const req = { ...prepared.config, sessionId: 'offline', purpose, tools: [declaration, webSearch, webFetch], messages: [{ role: 'user', content: [{ type: 'text', text: label }] }] }
      if (loop) llm.markAgentLoopRequest(req)
      const chunks = []
      for await (const chunk of prepared.stream(Object.freeze(req))) chunks.push(chunk)
      if (provider !== 'compatible') {
        assert.equal(chunks.at(-1).reason.kind, 'stop')
        assert.ok(chunks.some(c => c.type === 'text-delta' && c.text === 'Mock answer, unchanged.'))
      }
    })()
  }
  const update = config => ctx.loader.update('gemini-enhancement', { config })
  const injected = label => captures.get(label).body.tools.some(tool => Object.hasOwn(tool, 'googleSearch'))
  const declarations = label => captures.get(label).body.tools.flatMap(tool =>
    tool.functionDeclarations?.map(item => item.name) ?? [tool.function?.name].filter(Boolean))
  const localTools = ['read_mock', 'web_search', 'web_fetch']

  await invoke('default-off')
  assert.equal(injected('default-off'), false)
  assert.deepEqual(declarations('default-off'), localTools)
  assert.equal(globalThis.fetch, offline)

  // Enable Google Search on `gemini` (all models on that provider), leave `gateway` unconfigured.
  await update({ routes: { gemini: { localizePrompt: false, nativeHistory: false, googleSearch: true } } })
  assert.strictEqual(ctx.loader.resolve('gemini-enhancement').fiber, fiber)
  await Promise.all([
    invoke('matched'),
    invoke('second-model', { selected: 'gemini-3-flash' }),
    invoke('gateway', { provider: 'gateway' }),
    invoke('openai', { provider: 'compatible' }),
    invoke('one-shot', { loop: false }),
    invoke('title', { loop: false, purpose: 'session-title' }),
  ])
  for (const label of ['matched', 'second-model']) {
    assert.equal(injected(label), true, label)
    const { body } = captures.get(label)
    assert.equal(body.toolConfig.includeServerSideToolInvocations, true)
    assert.deepEqual(declarations(label), ['read_mock', 'web_fetch'])
  }
  for (const label of ['gateway', 'one-shot', 'title', 'openai']) {
    assert.equal(injected(label), false, label)
    assert.deepEqual(declarations(label), localTools, label)
  }

  // Search-only without nativeHistory falls back to temporary activity cards.
  async function activities() {
    const result = routes.get(searchActivityPath).fetch(new Request(`http://localhost${searchActivityPath}?sessionId=offline`))
    const reader = result.body.getReader()
    try { return JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6)) }
    finally { await reader.cancel() }
  }
  const agent = { id: 'offline' }
  const attemptId = 'offline:1'
  ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId, turn: 5, step: 2 } })
  assert.deepEqual(await activities(), { liveTurn: null, cards: [] })
  await invoke('reported-search')
  ctx.emit('agent/assistant-stream', { agent, frame: { type: 'end', attemptId } })
  ctx.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { turn: 5 } })
  assert.deepEqual(await activities(), { liveTurn: null, cards: [{
    id: '5:2:offline:1', turn: 5, step: 2, status: 'completed', queries: ['offline Google query'], sources: [],
  }] })

  await update({ routes: {} })
  await invoke('toggle-off-live')
  assert.equal(injected('toggle-off-live'), false)
  assert.deepEqual(declarations('toggle-off-live'), localTools)
  assert.strictEqual(ctx.loader.resolve('gemini-enhancement').fiber, fiber)
  await ctx.loader.update('gemini-enhancement', {
    config: { routes: { gemini: { localizePrompt: false, nativeHistory: false, googleSearch: true } } },
    disabled: true,
  })
  assert.equal(globalThis.fetch, offline)
  await invoke('disabled-row')
  assert.equal(injected('disabled-row'), false)
})
