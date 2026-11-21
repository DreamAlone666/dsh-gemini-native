import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import * as plugin from '../index.js'
import { geminiTransport } from '../gemini-transport.js'
import { applyXHighThinking, supportsXHighModel, xhighPath, xhighState, xhighStorageUnit } from '../xhigh.js'

const neon = 'gemini-4-neon'
const hydrogen = 'gemini-4-hydrogen'
const argon = 'gemini-4-argon'
const baseURL = 'https://gemini.test/relay/v1beta'
const generationFor = model => `${baseURL}/models/${model}:streamGenerateContent?alt=sse`
const declaration = { name: 'read_mock', description: 'Read a mock value', parameters: { type: 'object', properties: {} } }
const webSearch = { ...declaration, name: 'web_search' }

test('supportsXHighModel matches only Gemini 4 Neon and Hydrogen variants', () => {
  for (const model of [
    'gemini-4-neon',
    'gemini-4-hydrogen',
    'models/gemini-4-neon',
    'models/gemini-4-hydrogen',
    'gemini-4-neon-001',
    'gemini-4-hydrogen-preview',
    'gemini-4-neon.exp',
    'gemini-4-hydrogen@2026',
    'GEMINI-4-NEON',
    'models/Gemini-4-Hydrogen-Exp',
  ]) assert.equal(supportsXHighModel(model), true, model)

  for (const model of [
    'gemini-4-argon',
    'gemini-4-carbon',
    'models/gemini-4-argon',
    'models/gemini-4-carbon-001',
    'gemini-3-pro',
    'gemini-3-flash',
    'gemini-2.5-pro',
    'gemini-4-neon2',
    'gemini-4-hydrogenx',
    'tunedModels/gemini-4-neon',
    'other/gemini-4-neon',
    '',
    null,
    undefined,
    42,
    {},
  ]) assert.equal(supportsXHighModel(model), false, String(model))
})

test('applyXHighThinking merges generationConfig, strips thinkingBudget, is idempotent, and skips invalid configs', () => {
  const base = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }
  for (const flag of [false, undefined, null, 1, 'true']) {
    const out = applyXHighThinking(base, flag)
    assert.equal(out.changed, false)
    assert.strictEqual(out.body, base)
  }

  const created = applyXHighThinking(base, true)
  assert.equal(created.changed, true)
  assert.deepEqual(created.body, {
    ...base,
    generationConfig: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'XHIGH' } },
  })
  assert.equal(base.generationConfig, undefined, 'must not mutate input body')

  const existing = {
    ...base,
    generationConfig: {
      maxOutputTokens: 8192,
      temperature: 0.7,
      thinkingConfig: { includeThoughts: false, thinkingLevel: 'MEDIUM', thinkingBudget: 2048, customField: 'keep' },
    },
  }
  const merged = applyXHighThinking(existing, true)
  assert.equal(merged.changed, true)
  assert.deepEqual(merged.body.generationConfig, {
    maxOutputTokens: 8192,
    temperature: 0.7,
    thinkingConfig: { includeThoughts: true, thinkingLevel: 'XHIGH', customField: 'keep' },
  })
  assert.equal(Object.hasOwn(merged.body.generationConfig.thinkingConfig, 'thinkingBudget'), false)
  assert.equal(existing.generationConfig.thinkingConfig.thinkingBudget, 2048, 'must not mutate existing thinkingConfig')

  // Idempotent when already XHIGH with includeThoughts and no thinkingBudget.
  const again = applyXHighThinking(merged.body, true)
  assert.equal(again.changed, false)
  assert.strictEqual(again.body, merged.body)

  // Still strips thinkingBudget even if includeThoughts and thinkingLevel already match.
  const withBudget = {
    ...base,
    generationConfig: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'XHIGH', thinkingBudget: 1024 } },
  }
  const stripped = applyXHighThinking(withBudget, true)
  assert.equal(stripped.changed, true)
  assert.deepEqual(stripped.body.generationConfig.thinkingConfig, { includeThoughts: true, thinkingLevel: 'XHIGH' })
  assert.equal(Object.hasOwn(stripped.body.generationConfig.thinkingConfig, 'thinkingBudget'), false)

  // Safely skips non-object generationConfig.
  for (const invalid of [null, [], 'invalid', 123, true]) {
    const body = { ...base, generationConfig: invalid }
    const out = applyXHighThinking(body, true)
    assert.equal(out.changed, false)
    assert.strictEqual(out.body, body)
  }
})

function stateFixture({ kv, sessionController } = {}) {
  const listeners = new Map()
  const cleanups = []
  let registeredRoute
  const ctx = {
    logger: { warn() {} },
    on(event, fn) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
    },
    inject(deps, fn) {
      if (deps.includes('connection')) {
        fn({
          connection: {
            fetch: {
              register(def) {
                registeredRoute = def
                return () => { if (registeredRoute === def) registeredRoute = undefined }
              },
            },
          },
          effect(start) { cleanups.push(start()) },
        })
      }
      if (sessionController && deps.includes('sessionController')) {
        fn({ sessionController, effect(start) { cleanups.push(start()) } })
      }
      if (kv && deps.includes('storage') && deps.includes('storage.backend.json')) {
        const backend = { kv }
        fn({
          storage: { backend: { get: name => name === 'json' ? backend : undefined } },
          get: name => name === 'storage.backend.json' ? backend : undefined,
          effect(start) { cleanups.push(start()) },
        })
      }
    },
    effect(start) { cleanups.push(start()) },
  }
  const state = xhighState(ctx)
  const emit = (event, ...args) => { for (const fn of listeners.get(event) ?? []) fn(...args) }
  const unload = async () => {
    for (const fn of cleanups.splice(0).reverse()) await fn?.()
  }
  return { state, route: () => registeredRoute, emit, unload }
}

function memoryKvBackend(initial = {}, { beforeLoad } = {}) {
  const records = new Map(Object.entries(initial))
  let openCount = 0
  return {
    records,
    get openCount() { return openCount },
    kv: {
      async open(descriptor) {
        assert.equal(descriptor.name, xhighStorageUnit)
        assert.equal(descriptor.version, 1)
        assert.deepEqual(descriptor.tables, ['sessions'])
        assert.equal(descriptor.layout, 'single')
        if (openCount > 0) throw new Error('unit already open')
        openCount++
        let closed = false
        return {
          async loadAll() {
            await beforeLoad
            return { tables: { sessions: Object.fromEntries(records) }, global: null }
          },
          async putRecord(table, key, value) {
            assert.equal(table, 'sessions')
            assert.equal(closed, false)
            records.set(key, value)
          },
          async deleteRecord(table, key) {
            assert.equal(table, 'sessions')
            assert.equal(closed, false)
            records.delete(key)
          },
          async close() {
            if (!closed) {
              closed = true
              openCount--
            }
          },
        }
      },
    },
  }
}

async function readEvent(reader) {
  const { done, value } = await reader.read()
  if (done) return undefined
  const text = new TextDecoder().decode(value)
  assert.match(text, /^data: .+\n\n$/u)
  return JSON.parse(text.slice('data: '.length))
}

test('xhighState handles GET SSE, POST validation, model/selection reset, session disposal persistence, archive cleanup, LRU eviction, and unload', async t => {
  const f = stateFixture()
  t.after(() => f.unload())
  const route = f.route()
  assert.equal(route.path, xhighPath)
  assert.deepEqual(route.methods, ['GET', 'POST'])
  assert.equal(route.requestBody, 'buffered')

  // GET validation & aborted signal.
  for (const query of ['', '?sessionId=', `?sessionId=${'x'.repeat(257)}`]) {
    const res = route.fetch(new Request(`http://localhost${xhighPath}${query}`))
    assert.equal(res.status, 400)
  }
  const preAborted = new AbortController()
  preAborted.abort()
  assert.equal(route.fetch(new Request(`http://localhost${xhighPath}?sessionId=s1`, { signal: preAborted.signal })).status, 204)

  // POST validation.
  const post = (body) => route.fetch(new Request(`http://localhost${xhighPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }))
  for (const bad of [
    '{not-json',
    'null',
    '[]',
    '42',
    {},
    { sessionId: '', enabled: true },
    { sessionId: 'a'.repeat(257), enabled: true },
    { sessionId: 123, enabled: true },
    { sessionId: 's1', enabled: 'true' },
    { sessionId: 's1', enabled: 1 },
    { sessionId: 's1' },
  ]) {
    const res = await post(bad)
    assert.equal(res.status, 400, JSON.stringify(bad))
  }

  // Subscribe via GET SSE on s1 and s2.
  const abort1 = new AbortController()
  const abort2 = new AbortController()
  t.after(() => { abort1.abort(); abort2.abort() })
  const res1 = route.fetch(new Request(`http://localhost${xhighPath}?sessionId=s1`, { signal: abort1.signal }))
  assert.equal(res1.status, 200)
  assert.equal(res1.headers.get('content-type'), 'text/event-stream')
  assert.equal(res1.headers.get('cache-control'), 'no-store')
  const reader1 = res1.body.getReader()
  assert.deepEqual(await readEvent(reader1), { enabled: false })

  const res2 = route.fetch(new Request(`http://localhost${xhighPath}?sessionId=s2`, { signal: abort2.signal }))
  const reader2 = res2.body.getReader()
  assert.deepEqual(await readEvent(reader2), { enabled: false })

  // Enable s1 via POST.
  const ok1 = await post({ sessionId: 's1', enabled: true })
  assert.equal(ok1.status, 200)
  assert.equal(ok1.headers.get('content-type'), 'application/json')
  assert.equal(ok1.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await ok1.json(), { enabled: true })
  assert.equal(f.state.isEnabled('s1'), true)
  assert.equal(f.state.isEnabled('s2'), false)
  assert.deepEqual(await readEvent(reader1), { enabled: true })

  // Unrelated session events do not affect s1.
  f.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { turn: 1 } })
  assert.equal(f.state.isEnabled('s1'), true)

  // model/selection automatically resets s1 and broadcasts false.
  f.emit('session/event', { id: 's1' }, { type: 'model/selection', data: { provider: 'gemini', model: neon, reasoningEffort: 'low' } })
  assert.equal(f.state.isEnabled('s1'), false)
  assert.deepEqual(await readEvent(reader1), { enabled: false })

  // Enable s2: cold session disposal keeps XHigh enabled; archiving clears it and notifies false.
  assert.equal((await post({ sessionId: 's2', enabled: true })).status, 200)
  assert.deepEqual(await readEvent(reader2), { enabled: true })
  f.emit('session/disposed', { id: 's2' })
  assert.equal(f.state.isEnabled('s2'), true)
  f.emit('workspace/session-archived', { sessionId: 's2' })
  assert.equal(f.state.isEnabled('s2'), false)
  assert.deepEqual(await readEvent(reader2), { enabled: false })

  // LRU eviction beyond 256 enabled sessions evicts oldest and notifies its subscriber.
  f.state.setEnabled('s1', true)
  assert.deepEqual(await readEvent(reader1), { enabled: true })
  for (let i = 0; i < 256; i++) f.state.setEnabled(`lru-${i}`, true)
  assert.equal(f.state.isEnabled('s1'), false)
  assert.deepEqual(await readEvent(reader1), { enabled: false })
  assert.equal(f.state.isEnabled('lru-255'), true)

  // Unload closes open SSE streams and clears all state.
  await f.unload()
  assert.equal(f.state.isEnabled('lru-255'), false)
  assert.equal(await readEvent(reader1), undefined)
  assert.equal(await readEvent(reader2), undefined)
})

test('xhighState persists across reloads via storage kv backend and removes entries on reset/archive/eviction', async t => {
  const backend = memoryKvBackend()

  // First mount: enable s1 and s2 via POST, confirm persisted records.
  const first = stateFixture({ kv: backend.kv })
  t.after(() => first.unload())
  const post1 = body => first.route().fetch(new Request(`http://localhost${xhighPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
  assert.equal((await post1({ sessionId: 's1', enabled: true })).status, 200)
  assert.equal((await post1({ sessionId: 's2', enabled: true })).status, 200)
  assert.equal(backend.records.get('s1')?.enabled, true)
  assert.equal(backend.records.get('s2')?.enabled, true)
  await first.unload()
  assert.equal(backend.openCount, 0)

  // Second mount (simulates restart / reload / cold session reopen): restores s1 and s2.
  const second = stateFixture({ kv: backend.kv })
  t.after(() => second.unload())
  await second.state.ready()
  assert.equal(second.state.isEnabled('s1'), true)
  assert.equal(second.state.isEnabled('s2'), true)

  // model/selection removes s1 from storage; workspace/session-archived removes s2.
  second.emit('session/event', { id: 's1' }, { type: 'model/selection', data: { provider: 'gemini', model: neon, reasoningEffort: 'low' } })
  second.emit('workspace/session-archived', { sessionId: 's2' })
  await second.state.ready()
  assert.equal(backend.records.has('s1'), false)
  assert.equal(backend.records.has('s2'), false)
  await second.unload()
  assert.equal(backend.openCount, 0)
})

test('a fork waits for XHigh hydration and respects a later child decision or plugin unload', async t => {
  const hydration = Promise.withResolvers()
  const backend = memoryKvBackend({ source: { enabled: true, updatedAt: 1 } }, { beforeLoad: hydration.promise })
  let called = 0
  const controller = {
    async fork(request, gate) {
      assert.equal(this, controller)
      assert.equal(request.sessionId, 'source')
      called++
      gate.entered.resolve()
      return gate.result.promise
    },
  }
  const original = controller.fork
  const fixture = stateFixture({ kv: backend.kv, sessionController: controller })
  t.after(async () => { hydration.resolve(); await fixture.unload() })
  const begin = () => {
    const entered = Promise.withResolvers()
    const result = Promise.withResolvers()
    return { entered, result, done: controller.fork({ sessionId: 'source' }, { entered, result }) }
  }

  const hydrated = begin()
  assert.equal(called, 0, 'do not sample state or enter fork before storage hydration')
  hydration.resolve()
  await hydrated.entered.promise
  const firstChild = { sessionId: 'first' }
  hydrated.result.resolve(firstChild)
  assert.strictEqual(await hydrated.done, firstChild)
  assert.equal(backend.records.get('first')?.enabled, true, 'the child is persisted before fork returns')

  const contended = begin()
  await contended.entered.promise
  fixture.state.setEnabled('changed', false)
  contended.result.resolve({ sessionId: 'changed' })
  await contended.done
  assert.equal(backend.records.has('changed'), false)
  assert.equal(fixture.state.isEnabled('source'), true)

  const rejected = begin()
  const error = new Error('fork transaction failed')
  rejected.result.reject(error)
  await assert.rejects(rejected.done, actual => actual === error)

  const unloaded = begin()
  await unloaded.entered.promise
  await fixture.unload()
  assert.strictEqual(controller.fork, original)
  unloaded.result.resolve({ sessionId: 'after-unload' })
  assert.deepEqual(await unloaded.done, { sessionId: 'after-unload' })
  assert.equal(backend.records.has('after-unload'), false)
})

function transportFixture(t, { initialRoutes = {}, xhighSessions = new Set() } = {}) {
  const handlers = new Map()
  const original = globalThis.fetch
  const calls = []
  const reports = []
  let routes = initialRoutes
  const sseBody = JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] })
  const offlineFetch = (input, init) => {
    calls.push({ input, init })
    return new Response(`data: ${sseBody}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
  }
  globalThis.fetch = offlineFetch
  t.after(() => { globalThis.fetch = original })
  let cleanup
  geminiTransport({
    loader: { resolve: () => ({ moduleNamespace: { isAgentLoopRequest: request => request.agent === true } }) },
    logger: { warn() {} },
    on: (event, fn) => handlers.set(event, fn),
    effect: start => { cleanup = start() },
  }, { routes: { get: () => routes } }, plugin.routeConfigOf, sessionId => {
    reports.push(sessionId)
    return () => {}
  }, sessionId => xhighSessions.has(sessionId))

  async function run({
    provider = 'mock',
    model = neon,
    sessionId = 'sess-1',
    loop = true,
    purpose,
    body = { contents: [{ role: 'user', parts: [{ text: 'hello' }] }], tools: [{ functionDeclarations: [declaration, webSearch] }] },
    intact = false,
  } = {}) {
    const input = generationFor(model)
    const headers = new Headers({ 'x-goog-api-key': 'synthetic', 'content-length': '1' })
    const signal = new AbortController().signal
    const request = Object.freeze({ provider, model, sessionId, agent: loop, purpose, messages: [] })
    const init = { method: 'POST', headers, signal, body: JSON.stringify(body) }
    const stream = handlers.get('llm/stream')(request, async function* () {
      await Promise.resolve()
      handlers.get('llm-pi-ai/request-headers')({ ...request, baseURL }, headers, () => headers)
      const response = await globalThis.fetch(input, init)
      await response.text()
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    const call = calls.at(-1)
    if (intact) assert.strictEqual(call.init, init)
    return { init: call.init, body: JSON.parse(call.init.body), chunks }
  }

  return {
    run,
    reports,
    cleanup: () => cleanup?.(),
    setRoutes: value => { routes = value },
    xhighSessions,
  }
}

test('geminiTransport applies XHigh alone, with googleSearch, and with nativeHistory, while skipping unsupported models and non-loop calls', async t => {
  const f = transportFixture(t, { initialRoutes: { mock: { nativeHistory: false } }, xhighSessions: new Set(['sess-1']) })
  t.after(f.cleanup)

  // 1. XHigh alone works on neon and hydrogen without triggering googleSearch or reportFor.
  const neonOnly = await f.run({
    model: neon,
    body: {
      contents: [{ role: 'user', parts: [{ text: 'think hard' }] }],
      tools: [{ functionDeclarations: [declaration, webSearch] }],
      generationConfig: { maxOutputTokens: 4096, thinkingConfig: { includeThoughts: true, thinkingLevel: 'MEDIUM', thinkingBudget: 512 } },
    },
  })
  assert.deepEqual(neonOnly.body.generationConfig, {
    maxOutputTokens: 4096,
    thinkingConfig: { includeThoughts: true, thinkingLevel: 'XHIGH' },
  })
  assert.equal(neonOnly.body.tools.some(tool => Object.hasOwn(tool, 'googleSearch')), false)
  assert.equal(neonOnly.init.headers.has('content-length'), false)
  assert.equal(f.reports.length, 0)

  const hydrogenOnly = await f.run({ model: hydrogen })
  assert.deepEqual(hydrogenOnly.body.generationConfig, {
    thinkingConfig: { includeThoughts: true, thinkingLevel: 'XHIGH' },
  })
  assert.equal(f.reports.length, 0)

  // 2. Unsupported models and non-main-loop requests stay intact.
  await f.run({ model: argon, intact: true })
  await f.run({ model: 'gemini-4-carbon', intact: true })
  await f.run({ model: neon, purpose: 'compaction', intact: true })
  await f.run({ model: neon, loop: false, intact: true })
  await f.run({ model: neon, sessionId: 'other-session', intact: true })

  // 3. XHigh + googleSearch (without nativeHistory).
  f.setRoutes({ mock: { localizePrompt: false, nativeHistory: false, googleSearch: true } })
  const withSearch = await f.run({ model: neon })
  assert.deepEqual(withSearch.body.generationConfig, {
    thinkingConfig: { includeThoughts: true, thinkingLevel: 'XHIGH' },
  })
  assert.equal(withSearch.body.tools.some(tool => Object.hasOwn(tool, 'googleSearch')), true)
  assert.deepEqual(f.reports, ['sess-1'])

  // When googleSearch cannot inject (mode AUTO), XHigh still applies and reportFor is not called.
  f.reports.length = 0
  const searchBlocked = await f.run({
    model: neon,
    body: {
      contents: [{ role: 'user', parts: [{ text: 'auto' }] }],
      tools: [{ functionDeclarations: [declaration] }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    },
  })
  assert.deepEqual(searchBlocked.body.generationConfig, {
    thinkingConfig: { includeThoughts: true, thinkingLevel: 'XHIGH' },
  })
  assert.equal(searchBlocked.body.tools.some(tool => Object.hasOwn(tool, 'googleSearch')), false)
  assert.equal(f.reports.length, 0)

  // 4. XHigh + nativeHistory (without googleSearch): attaches native replay & applies XHIGH.
  f.setRoutes({ mock: { localizePrompt: false, nativeHistory: true, googleSearch: false } })
  const withNative = await f.run({ model: neon })
  assert.deepEqual(withNative.body.generationConfig, {
    thinkingConfig: { includeThoughts: true, thinkingLevel: 'XHIGH' },
  })
  assert.equal(withNative.body.tools.some(tool => Object.hasOwn(tool, 'googleSearch')), false)
  assert.equal(withNative.chunks.at(-1).replayState?.response?.kind, 'dsh-gemini-generate-content')

  // 5. XHigh + nativeHistory + googleSearch.
  f.setRoutes({ mock: { localizePrompt: false, nativeHistory: true, googleSearch: true } })
  const withAll = await f.run({ model: hydrogen })
  assert.deepEqual(withAll.body.generationConfig, {
    thinkingConfig: { includeThoughts: true, thinkingLevel: 'XHIGH' },
  })
  assert.equal(withAll.body.tools.some(tool => Object.hasOwn(tool, 'googleSearch')), true)
  assert.equal(withAll.chunks.at(-1).replayState?.response?.kind, 'dsh-gemini-generate-content')
})

const installed = process.env.DSH_INSTALL_DIR

test('installed DSH: XHigh overrides pi-ai, resets on model selection, and inherits once through the Session fork Remote',
  { skip: !installed, timeout: 10000 }, async t => {
    const require = createRequire(join(installed, 'package.json'))
    const load = spec => import(pathToFileURL(require.resolve(spec)).href)
    const { Context } = await load('@deepseek-ai/cordis')
    const { createUserMessage } = await load('@deepseek-ai/dsh-llm')
    const { Loader } = await load('@deepseek-ai/cordis-plugin-loader')
    const { Include } = await load('@deepseek-ai/cordis-plugin-include')
    const { SessionStore } = await load('@deepseek-ai/dsh-session')
    const { SessionProjectionRegistry } = await load('@deepseek-ai/dsh-session-projection')
    const { AgentRegistry } = await load('@deepseek-ai/dsh-agent')
    const { ToolsService } = await load('@deepseek-ai/dsh-tools')
    const { SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
    const { AgentLoop } = await load('@deepseek-ai/dsh-agent-loop')
    const { Storage } = await load('@deepseek-ai/dsh-storage')
    const storageJson = await load('@deepseek-ai/dsh-storage-json')
    const persistenceJsonl = await load('@deepseek-ai/dsh-session-persistence-jsonl')
    const { default: SessionQueryEngine } = await load('@deepseek-ai/dsh-session-query')
    const { SessionController } = await load('@deepseek-ai/dsh-api-session-controller')
    const { TYPERT } = await load('@deepseek-ai/dsh-api-session-controller/typert')
    const { default: TypertRegistry } = await load('@deepseek-ai/dsh-typert-registry')
    const { default: TypertGateway } = await load('@deepseek-ai/dsh-api-gateway')
    const { default: RemoteAccess } = await load('@deepseek-ai/dsh-api-remote-access')
    const pi = await load('@deepseek-ai/dsh-llm-pi-ai')

    const fixture = await mkdtemp(join(tmpdir(), 'dsh-xhigh-test-'))
    const configPath = join(fixture, 'cordis.json')
    const storageRoot = join(fixture, 'storage')
    const llmUrl = pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href
    await writeFile(configPath, JSON.stringify([{ id: 'llm', name: llmUrl }]))

    const ctx = new Context()
    const storage = ctx.plugin(Storage)
    const jsonBackend = ctx.plugin(storageJson, { root: storageRoot })
    const sessions = ctx.plugin(SessionStore)
    const projections = ctx.plugin(SessionProjectionRegistry)
    const agents = ctx.plugin(AgentRegistry)
    const tools = ctx.plugin(ToolsService)
    const system = ctx.plugin(SystemPrompt)
    const persistence = ctx.plugin(persistenceJsonl, { root: join(fixture, 'sessions'), compression: 'none' })
    const query = ctx.plugin(SessionQueryEngine)
    const typert = ctx.plugin(TypertRegistry)
    const access = ctx.plugin(RemoteAccess)
    const configUrl = pathToFileURL(configPath).href
    const loader = ctx.plugin(class extends Loader { commit() {} }, { baseUrl: configUrl })
    const routes = new Map()
    ctx.provide('connection', {
      rpc: { intercept: () => () => {} },
      fetch: {
        register(def) {
          routes.set(def.path, def)
          return () => routes.delete(def.path)
        },
      },
    })
    ctx.provide('credentials', {
      async resolve() { return { value: 'synthetic-key' } },
      async readRecord() {},
    })
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'gemini', model: neon }) })
    ctx.provide('attachments', {
      imageLimits: {
        maxImageBytes: 1000, maxImagesPerMessage: 1, maxMessageImageBytes: 1000,
        maxImagePixels: 1000, maxImageDimension: 100, mediaTypes: ['image/png'],
      },
    })
    ctx.provide('fileUploads', { registerAgentResolver: () => () => {} })
    ctx.provide('fs', {})
    ctx.provide('workspaceRegistry', { archivedSessionIds: [], list: () => [] })

    const originalFetch = globalThis.fetch
    let controller
    let gateway
    let unregisterReflection
    let loop
    t.after(async () => {
      globalThis.fetch = originalFetch
      await loop?.dispose()
      await loader.dispose()
      await controller?.dispose()
      await unregisterReflection?.()
      await gateway?.dispose()
      await access.dispose()
      await typert.dispose()
      await query.dispose()
      await persistence.dispose()
      await system.dispose()
      await tools.dispose()
      await agents.dispose()
      await projections.dispose()
      await sessions.dispose()
      await jsonBackend.dispose()
      await storage.dispose()
      await rm(fixture, { recursive: true, force: true })
    })

    await Promise.all([storage, jsonBackend, sessions, projections, agents, tools, system, loader, persistence, query, typert, access])
    ctx.tools.setExecutor({
      describe: () => ({ schemas: [], knownNames: [] }),
      execute: async () => ({ results: [], additionalContexts: [], concluded: false }),
    })
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.geminiNative = plugin
    ctx.loader.builtins.pi = pi
    await ctx.loader.create({ id: 'include', name: 'cordis:include', config: { path: configUrl } })
    await ctx.loader.await()

    await ctx.loader.create({ id: 'llm-pi-ai', name: 'cordis:pi', config: {
      providers: {
        gemini: {
          api: 'google-generative-ai',
          baseURL,
          apiKeyEnv: 'SYNTHETIC_KEY',
          models: [{
            id: neon,
            reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' },
          }],
        },
      },
    } })
    await ctx.loader.await()

    loop = ctx.plugin(AgentLoop, {})
    gateway = ctx.plugin(TypertGateway, {})
    await Promise.all([loop, gateway])
    unregisterReflection = ctx.typert.register(TYPERT)
    controller = ctx.plugin(SessionController, {})
    await controller
    const peer = {
      ctx, id: 'owner', principal: { kind: 'owner' }, signal: new AbortController().signal,
    }
    const sessionCall = (method, request) => ctx.typertGateway.invoke({ namespace: 'session', method, args: { request }, peer })
    const plainFork = () => Object.getOwnPropertyDescriptor(ctx.sessionController, 'fork')
    assert.equal(plainFork(), undefined)
    const config = { routes: { gemini: { nativeHistory: false } } }

    const capturedBodies = []
    globalThis.fetch = async (input, init) => {
      assert.equal(new URL(input).hostname, 'gemini.test')
      capturedBodies.push(JSON.parse(init.body))
      const reply = { candidates: [{ content: { role: 'model', parts: [{ text: 'Done.' }] }, finishReason: 'STOP' }] }
      return new Response(`data: ${JSON.stringify(reply)}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    }

    // Keep this request an XHigh-only override in both plugin generations.
    await ctx.loader.create({ id: 'gemini-native', name: 'cordis:geminiNative', config })
    await ctx.loader.await()
    assert.equal(typeof plainFork()?.value, 'function')

    const readEnabled = async sessionId => {
      const response = routes.get(xhighPath).fetch(new Request(`http://localhost${xhighPath}?sessionId=${sessionId}`))
      const reader = response.body.getReader()
      try { return (await readEvent(reader)).enabled } finally { await reader.cancel() }
    }
    const forkFrom = sessionId => sessionCall('fork', { sessionId })
    const postState = (sessionId, enabled) => routes.get(xhighPath).fetch(new Request(`http://localhost${xhighPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, enabled }),
    }))
    const xhighRoute = routes.get(xhighPath)
    assert.ok(xhighRoute)
    const sessionId = 'xhigh-integration-session'
    const { agent } = await ctx.agents.create({ sessionId, meta: { cwd: fixture }, agentOptions: {
      provider: 'gemini',
      model: neon,
      reasoningEffort: 'medium',
    } })
    agent.model.select({ provider: 'gemini', model: neon, reasoningEffort: 'medium' })

    const abort = new AbortController()
    t.after(() => abort.abort())
    const sseRes = xhighRoute.fetch(new Request(`http://localhost${xhighPath}?sessionId=${sessionId}`, { signal: abort.signal }))
    const reader = sseRes.body.getReader()
    assert.deepEqual(await readEvent(reader), { enabled: false })

    // Turn 1: enable XHigh via HTTP POST, keeping native selection at medium.
    const postRes = await postState(sessionId, true)
    assert.equal(postRes.status, 200)
    assert.deepEqual(await postRes.json(), { enabled: true })
    assert.deepEqual(await readEvent(reader), { enabled: true })

    const errors = []
    ctx.on('agent/error', ({ error }) => errors.push(error))

    const sendTurn = async text => {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
      await agent.whenIdle()
      assert.deepEqual(errors, [])
    }

    await sendTurn('Turn 1 with xhigh')
    assert.equal(capturedBodies.length, 1)
    assert.equal(capturedBodies[0].generationConfig?.thinkingConfig?.thinkingLevel, 'XHIGH')
    assert.equal(capturedBodies[0].generationConfig?.thinkingConfig?.includeThoughts, true)
    assert.equal(Object.hasOwn(capturedBodies[0].generationConfig.thinkingConfig, 'thinkingBudget'), false)
    // Native modelSelection remains 'medium'.
    assert.deepEqual(agent.model.current(), { provider: 'gemini', model: neon, reasoningEffort: 'medium' })

    const { sessionId: childId } = await forkFrom(sessionId)
    const { sessionId: persistedChildId } = await forkFrom(sessionId)
    assert.notEqual(childId, sessionId)
    assert.notEqual(persistedChildId, childId)
    assert.deepEqual(ctx.agents.get(childId).model.current(), agent.model.current(), 'built-in effort is inherited too')
    assert.equal(await readEnabled(childId), true)
    assert.equal(await readEnabled(persistedChildId), true)
    ctx.agents.get(childId).model.select({ provider: 'gemini', model: neon, reasoningEffort: 'low' })
    assert.equal(await readEnabled(childId), false)
    assert.equal(await readEnabled(sessionId), true)

    const { sessionId: plainId } = await sessionCall('create', { cwd: fixture })
    assert.equal(await readEnabled(plainId), false)
    await ctx.agents.create({ sessionId: 'subagent-fixture', meta: { cwd: fixture, origin: 'subagent', parentSession: sessionId } })
    assert.equal(await readEnabled('subagent-fixture'), false)

    // Removing the plugin restores the original Remote and leaves storage intact.
    abort.abort()
    await ctx.loader.remove('gemini-native')
    await ctx.loader.await()
    assert.equal(plainFork(), undefined)
    const { sessionId: forkWhileDisabled } = await forkFrom(sessionId)
    await ctx.loader.create({ id: 'gemini-native', name: 'cordis:geminiNative', config })
    await ctx.loader.await()

    const reloadedRoute = routes.get(xhighPath)
    assert.ok(reloadedRoute, 'xhigh route must re-register after reload')
    const abort2 = new AbortController()
    t.after(() => abort2.abort())
    const sseRes2 = reloadedRoute.fetch(new Request(`http://localhost${xhighPath}?sessionId=${sessionId}`, { signal: abort2.signal }))
    const reader2 = sseRes2.body.getReader()
    // Initial frame may arrive before or after async storage hydration; wait until true is observed.
    let restoredEvent = await readEvent(reader2)
    if (restoredEvent?.enabled === false) restoredEvent = await readEvent(reader2)
    assert.deepEqual(restoredEvent, { enabled: true })
    assert.equal(await readEnabled(persistedChildId), true)
    assert.equal(await readEnabled(childId), false)
    assert.equal(await readEnabled(forkWhileDisabled), false)

    await sendTurn('Turn 2 after reload still xhigh')
    assert.equal(capturedBodies.length, 2)
    assert.equal(capturedBodies[1].generationConfig?.thinkingConfig?.thinkingLevel, 'XHIGH')

    // Switch native effort via agent.model.select -> automatically turns off XHigh.
    agent.model.select({ provider: 'gemini', model: neon, reasoningEffort: 'low' })
    assert.deepEqual(await readEvent(reader2), { enabled: false })
    assert.deepEqual(agent.model.current(), { provider: 'gemini', model: neon, reasoningEffort: 'low' })

    // Turn 3: XHigh is now off, so pi-ai sends LOW.
    await sendTurn('Turn 3 after select low')
    assert.equal(capturedBodies.length, 3)
    assert.equal(capturedBodies[2].generationConfig?.thinkingConfig?.thinkingLevel, 'LOW')

    assert.equal((await postState(sessionId, true)).status, 200)
    await loop.dispose()
    assert.equal(ctx.sessions.get(childId), undefined)
    loop = ctx.plugin(AgentLoop, {})
    await loop
    await ctx.agents.resume({ resumeSessionId: childId })
    await ctx.agents.resume({ resumeSessionId: persistedChildId })
    assert.equal(await readEnabled(childId), false, 'a cold reopen does not copy again')
    assert.equal(await readEnabled(persistedChildId), true)
    assert.equal(ctx.sessions.get(sessionId), undefined)
    const { sessionId: childOfColdSource } = await forkFrom(sessionId)
    assert.equal(await readEnabled(childOfColdSource), true, 'a cold source still has its persisted XHigh setting')
  })
