import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import * as plugin from '../index.js'
import { localizationNotice } from '../notice.js'

const installed = process.env.DSH_INSTALL_DIR
const URL = 'http://localhost/api/dsh-gemini-native/status?sessionId=session-a'
const geminiProvider = 'gemini-relay'
const otherProvider = 'other-provider'
const model = 'gemini-4-argon'
const chineseIdentity = '你是由 DeepSeek Harness 驱动的 AI 智能体。'
const send = text => ({ role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text }] })

test('installed DSH: notice confirms the actual localized request per provider, not selection or inherited text', { skip: !installed, timeout: 5000 }, async t => {
  const require = createRequire(join(installed, 'package.json'))
  const load = spec => import(pathToFileURL(require.resolve(spec)).href)
  const { Context } = await load('@deepseek-ai/cordis')
  const { SystemPrompt, renderPrompt } = await load('@deepseek-ai/dsh-system-prompt')
  const ctx = new Context()
  const routes = new Map()
  ctx.provide('connection', { fetch: { register(def) { routes.set(def.path, def); return () => routes.delete(def.path) } } })
  const sys = await ctx.plugin(SystemPrompt, { personaPrefix: 'You are a coding agent powered by the {{model}} model.' })
  t.after(() => sys.dispose())
  ctx.systemPrompt.variable('model', context => context.modelSelection?.model)
  const fiber = await ctx.plugin(plugin, { showStatusNotice: false })
  t.after(() => fiber.dispose())
  const path = '/api/dsh-gemini-native/status'
  const route = () => routes.get(path)
  assert.equal(route().path, path)
  assert.equal(route().fetch(new Request(URL)).status, 204)
  await fiber.update({
    routes: { [geminiProvider]: { localizePrompt: true, nativeHistory: false, googleSearch: false } },
    showStatusNotice: true,
  })

  const abort = new AbortController()
  t.after(() => abort.abort())
  const response = route().fetch(new Request(URL, { signal: abort.signal }))
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  const reader = response.body.getReader()
  const read = async () => {
    const frame = await reader.read()
    return frame.done ? undefined : JSON.parse(new TextDecoder().decode(frame.value).slice('data: '.length)).localizedProvider
  }
  assert.equal(await read(), null)
  const streamStub = { async *[Symbol.asyncIterator]() {} }
  const fakeRuntime = {}
  function request({ sessionId = 'session-a', signal, provider = geminiProvider, selectedModel = model, messages }) {
    assert.strictEqual(ctx.waterfall(fakeRuntime, 'llm/stream', Object.freeze({
      sessionId, signal, provider, model: selectedModel, messages,
    }), () => streamStub), streamStub)
  }
  function assemble(signal, provider = geminiProvider, selectedModel = model) {
    return ctx.systemPrompt.assemble({ signal, agent: { id: 'session-a' }, modelSelection: { provider, model: selectedModel } })
  }
  const signal = new AbortController().signal
  const localized = renderPrompt(await assemble(signal, geminiProvider))
  assert.match(localized, /你是由 gemini-4-argon 模型/u)

  // Before a request, and for foreign signals, sessions, or providers, no positive evidence.
  const snapshot = async () => {
    const probe = route().fetch(new Request(URL)).body.getReader()
    try { return (await readSseJson(probe)).localizedProvider }
    finally { await probe.cancel() }
  }
  assert.equal(await snapshot(), null)
  request({ signal: AbortSignal.timeout(100), messages: [send(localized)] })
  request({ sessionId: 'session-b', signal, messages: [send(localized)] })
  request({ signal, provider: otherProvider, messages: [send(localized)] })
  assert.equal(await snapshot(), null)
  request({ signal, provider: geminiProvider, messages: [send(localized)] })
  assert.equal(await read(), geminiProvider)

  // A complete custom prompt can coincidentally contain a known translation;
  // the complete assembled translation did not go into this request.
  const complete = ctx.systemPrompt.section({ name: 'custom', order: 0, text: chineseIdentity, complete: true })
  const custom = renderPrompt(await assemble(signal, geminiProvider))
  assert.equal(custom, chineseIdentity)
  request({ signal, provider: geminiProvider, messages: [send(localized), send(custom)] })
  assert.equal(await read(), null)
  complete()

  request({ signal, provider: geminiProvider, messages: [send(renderPrompt(await assemble(signal, geminiProvider)))] })
  assert.equal(await read(), geminiProvider)
  const switched = renderPrompt(await assemble(signal, otherProvider))
  request({ signal, provider: otherProvider, messages: [send(localized), send(switched)] })
  assert.equal(await read(), null)
  abort.abort()
  assert.equal(await read(), undefined)
})

function noticeFixture({ showStatusNotice = true, routes = {} } = {}) {
  const handlers = new Map()
  const registered = new Map()
  const cleanups = []
  let show = showStatusNotice
  let currentRoutes = routes
  const ctx = {
    on(event, fn) {
      const list = handlers.get(event) ?? []
      list.push(fn)
      handlers.set(event, list)
    },
    connection: {
      fetch: {
        register(def) {
          registered.set(def.path, def)
          return () => registered.delete(def.path)
        },
      },
    },
    effect(fn) { cleanups.push(fn()) },
  }
  const config = {
    showStatusNotice: { get: () => show },
    routes: { get: () => currentRoutes },
  }
  const notice = localizationNotice(ctx, config, plugin.routeConfigOf)
  const route = () => registered.get('/api/dsh-gemini-native/status')
  const streamStub = { async *[Symbol.asyncIterator]() {} }
  function emitStream(options) {
    for (const fn of handlers.get('llm/stream') ?? []) {
      fn(options, () => streamStub)
    }
  }
  return {
    notice,
    route,
    emitStream,
    setShow(value) { show = value },
    setRoutes(value) { currentRoutes = value },
    dispose() { for (const fn of cleanups.splice(0).reverse()) fn?.() },
  }
}

async function readSseJson(reader) {
  const frame = await reader.read()
  return frame.done ? undefined : JSON.parse(new TextDecoder().decode(frame.value).slice('data: '.length))
}

test('status SSE sends only structured stats, omits upstream host, and enforces the 256 session cap', async t => {
  const f = noticeFixture({
    showStatusNotice: false,
    routes: { [geminiProvider]: { localizePrompt: true, nativeHistory: true, googleSearch: true } },
  })
  t.after(() => f.dispose())

  assert.equal(f.route().fetch(new Request(URL)).status, 204)
  assert.equal(f.route().fetch(new Request('http://localhost/api/dsh-gemini-native/status')).status, 400)

  f.setShow(true)
  const preAborted = new AbortController()
  preAborted.abort()
  assert.equal(f.route().fetch(new Request(URL, { signal: preAborted.signal })).status, 204)

  const detailAbort = new AbortController()
  t.after(() => detailAbort.abort())
  const detailReader = f.route().fetch(new Request(URL, { signal: detailAbort.signal })).body.getReader()
  assert.deepEqual(await readSseJson(detailReader), {
    localizedProvider: null,
    prompt: null,
    transport: null,
  })

  // Confirm localized prompt + stats.
  const signal = new AbortController().signal
  const localizedPresentation = {
    sections: [{ text: chineseIdentity, interpolate: false }],
    variables: {},
  }
  const stats = { matched: 4, total: 6, missedBuiltins: ['tool:read', 'tool:edit'] }
  f.notice.remember({ agent: { id: 'session-a' }, signal }, geminiProvider, localizedPresentation, stats)
  f.emitStream({
    sessionId: 'session-a',
    signal,
    provider: geminiProvider,
    model,
    messages: [send(chineseIdentity)],
  })

  assert.deepEqual(await readSseJson(detailReader), {
    localizedProvider: geminiProvider,
    prompt: { provider: geminiProvider, matched: 4, total: 6, missedBuiltins: ['tool:read', 'tool:edit'] },
    transport: null,
  })

  // recordTransport updates the status watcher, deduplicates identical snapshots, and emits when finalized.
  const outbound = {
    provider: geminiProvider,
    model,
    status: 'ok',
    totalHistoryTurns: 2,
    replayedHistoryTurns: 2,
    searchConfigured: true,
    searchInjected: true,
    searchMode: 'mixed',
    localToolCount: 3,
    xhighRequested: true,
    xhighApplied: true,
    thinkingLevel: 'XHIGH',
    recordedBytes: null,
    recordedFrames: null,
    recordStatus: null,
  }
  f.notice.recordTransport('session-a', { ...outbound, host: 'relay.test' })
  // Duplicate identical snapshot must not emit another event.
  f.notice.recordTransport('session-a', { ...outbound })
  const inbound = { ...outbound, recordedBytes: 1024, recordedFrames: 3, recordStatus: 'saved' }
  f.notice.recordTransport('session-a', inbound)

  assert.deepEqual(await readSseJson(detailReader), {
    localizedProvider: geminiProvider,
    prompt: { provider: geminiProvider, matched: 4, total: 6, missedBuiltins: ['tool:read', 'tool:edit'] },
    transport: outbound,
  })
  assert.deepEqual(await readSseJson(detailReader), {
    localizedProvider: geminiProvider,
    prompt: { provider: geminiProvider, matched: 4, total: 6, missedBuiltins: ['tool:read', 'tool:edit'] },
    transport: inbound,
  })

  // Switching to a non-localized provider clears localizedProvider & prompt while keeping transport.
  const switchSignal = new AbortController().signal
  f.notice.remember({ agent: { id: 'session-a' }, signal: switchSignal }, otherProvider, undefined, null)
  f.emitStream({
    sessionId: 'session-a',
    signal: switchSignal,
    provider: otherProvider,
    model: 'other-model',
    messages: [send('English prompt')],
  })
  assert.deepEqual(await readSseJson(detailReader), {
    localizedProvider: null,
    prompt: null,
    transport: inbound,
  })

  // Re-establish localized prompt on session-a, then push 256 other sessions to test LRU eviction.
  const signal2 = new AbortController().signal
  f.notice.remember({ agent: { id: 'session-a' }, signal: signal2 }, geminiProvider, localizedPresentation, stats)
  f.emitStream({
    sessionId: 'session-a',
    signal: signal2,
    provider: geminiProvider,
    model,
    messages: [send(chineseIdentity)],
  })
  assert.deepEqual(await readSseJson(detailReader), {
    localizedProvider: geminiProvider,
    prompt: { provider: geminiProvider, matched: 4, total: 6, missedBuiltins: ['tool:read', 'tool:edit'] },
    transport: inbound,
  })

  for (let i = 0; i < 256; i++) {
    f.notice.recordTransport(`lru-session-${i}`, { ...inbound, model: `m-${i}` })
  }
  assert.deepEqual(await readSseJson(detailReader), {
    localizedProvider: null,
    prompt: null,
    transport: null,
  })
})

test('installed DSH: status SSE computes prompt stats (matched, total, missedBuiltins capped at 6) without leaking prompt text', { skip: !installed, timeout: 5000 }, async t => {
  const require = createRequire(join(installed, 'package.json'))
  const load = spec => import(pathToFileURL(require.resolve(spec)).href)
  const { Context } = await load('@deepseek-ai/cordis')
  const { SystemPrompt, renderPrompt } = await load('@deepseek-ai/dsh-system-prompt')
  const ctx = new Context()
  const routes = new Map()
  ctx.provide('connection', { fetch: { register(def) { routes.set(def.path, def); return () => routes.delete(def.path) } } })
  const sys = await ctx.plugin(SystemPrompt, { personaPrefix: 'You are a coding agent powered by the {{model}} model.' })
  t.after(() => sys.dispose())
  ctx.systemPrompt.variable('model', context => context.modelSelection?.model)

  // Add 7 built-in-named sections with customized text (should cap missedBuiltins at 6),
  // 1 empty built-in section (must be ignored for both total and missedBuiltins),
  // and 1 third-party section (counted in total, not in missedBuiltins).
  const customBuiltins = ['tool:bash', 'tool:read', 'tool:write', 'tool:edit', 'tool:glob', 'tool:grep', 'tool:jobs']
  const disposers = [
    ...customBuiltins.map((name, i) => ctx.systemPrompt.section({ name, order: 10 + i, text: `Custom ${name}` })),
    ctx.systemPrompt.section({ name: 'tool:web_fetch', order: 20, text: '' }),
    ctx.systemPrompt.section({ name: 'third-party:note', order: 30, text: 'Third-party guidance' }),
  ]
  t.after(() => { for (const dispose of disposers) dispose() })

  const fiber = await ctx.plugin(plugin, {
    routes: { [geminiProvider]: { localizePrompt: true, nativeHistory: false, googleSearch: false } },
    showStatusNotice: true,
  })
  t.after(() => fiber.dispose())

  const abort = new AbortController()
  t.after(() => abort.abort())
  const detailRoute = routes.get('/api/dsh-gemini-native/status')
  const reader = detailRoute.fetch(new Request(URL, { signal: abort.signal })).body.getReader()
  assert.deepEqual(await readSseJson(reader), { localizedProvider: null, prompt: null, transport: null })

  const signal = new AbortController().signal
  const assembled = await ctx.systemPrompt.assemble({
    signal,
    agent: { id: 'session-a' },
    modelSelection: { provider: geminiProvider, model },
  })
  const rendered = renderPrompt(assembled)
  const streamStub = { async *[Symbol.asyncIterator]() {} }
  ctx.waterfall({}, 'llm/stream', Object.freeze({
    sessionId: 'session-a',
    signal,
    provider: geminiProvider,
    model,
    messages: [send(rendered)],
  }), () => streamStub)

  const frame = await readSseJson(reader)
  assert.equal(frame.localizedProvider, geminiProvider)
  assert.equal(frame.transport, null)
  assert.equal(frame.prompt.provider, geminiProvider)
  assert.equal(frame.prompt.matched, 2) // harness:identity + deployment:persona-prefix
  assert.equal(frame.prompt.total, 10) // 2 matched + 7 customBuiltins + 1 third-party (empty web_fetch excluded)
  assert.deepEqual(frame.prompt.missedBuiltins, customBuiltins.slice(0, 6))
  assert.equal(JSON.stringify(frame).includes('Third-party guidance'), false)
  assert.equal(JSON.stringify(frame).includes('你是由'), false)
})
