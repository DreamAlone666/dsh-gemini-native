import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import * as plugin from '../index.js'

const installed = process.env.DSH_INSTALL_DIR
const URL = 'http://localhost/api/dsh-gemini-enhancement/status?sessionId=session-a'
const gemini = 'gemini-4-argon'
const chineseIdentity = '你是由 DeepSeek Harness 驱动的 AI 智能体。'
const send = text => ({ role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text }] })

test('installed DSH: notice confirms the actual localized request, not selection or inherited text', { skip: !installed, timeout: 5000 }, async t => {
  const require = createRequire(join(installed, 'package.json'))
  const load = spec => import(pathToFileURL(require.resolve(spec)).href)
  const { Context } = await load('@deepseek-ai/cordis')
  const { SystemPrompt, renderPrompt } = await load('@deepseek-ai/dsh-system-prompt')
  const ctx = new Context()
  let route
  ctx.provide('connection', { fetch: { register(def) { route = def; return () => { route = undefined } } } })
  const sys = await ctx.plugin(SystemPrompt, { personaPrefix: 'You are a coding agent powered by the {{model}} model.' })
  t.after(() => sys.dispose())
  ctx.systemPrompt.variable('model', context => context.modelSelection?.model)
  const fiber = await ctx.plugin(plugin, {})
  t.after(() => fiber.dispose())
  assert.equal(route.path, '/api/dsh-gemini-enhancement/status')
  assert.equal(route.fetch(new Request(URL)).status, 204)
  await fiber.update({ showLocalizationNotice: true })

  const abort = new AbortController()
  t.after(() => abort.abort())
  const response = route.fetch(new Request(URL, { signal: abort.signal }))
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  const reader = response.body.getReader()
  const read = async () => {
    const frame = await reader.read()
    return frame.done ? undefined : JSON.parse(new TextDecoder().decode(frame.value).slice('data: '.length))
  }
  assert.equal(await read(), null)
  const streamStub = { async *[Symbol.asyncIterator]() {} }
  const fakeRuntime = {}
  function request({ sessionId = 'session-a', signal, model, messages, provider = 'gateway' }) {
    assert.strictEqual(ctx.waterfall(fakeRuntime, 'llm/stream', Object.freeze({ sessionId, signal, model, messages, provider }), () => streamStub), streamStub)
  }
  function assemble(signal, model) {
    return ctx.systemPrompt.assemble({ signal, agent: { id: 'session-a' }, modelSelection: { model, provider: 'gateway' } })
  }
  const signal = new AbortController().signal
  const localized = renderPrompt(await assemble(signal, gemini))
  assert.match(localized, /你是由 gemini-4-argon 模型/u)

  // Before a request, and for foreign signals or sessions, no positive evidence.
  const snapshot = async () => {
    const probe = route.fetch(new Request(URL)).body.getReader()
    try { return JSON.parse(new TextDecoder().decode((await probe.read()).value).slice('data: '.length)) }
    finally { await probe.cancel() }
  }
  assert.equal(await snapshot(), null)
  request({ signal: AbortSignal.timeout(100), model: gemini, messages: [send(localized)] })
  request({ sessionId: 'session-b', signal, model: gemini, messages: [send(localized)] })
  assert.equal(await snapshot(), null)
  request({ signal, model: gemini, messages: [send(localized)], provider: 'another-gateway' })
  assert.equal(await read(), gemini)

  // A complete custom prompt can coincidentally contain a known translation;
  // the complete assembled translation did not go into this request.
  const complete = ctx.systemPrompt.section({ name: 'custom', order: 0, text: chineseIdentity, complete: true })
  const custom = renderPrompt(await assemble(signal, gemini))
  assert.equal(custom, chineseIdentity)
  request({ signal, model: gemini, messages: [send(localized), send(custom)] })
  assert.equal(await read(), null)
  complete()

  request({ signal, model: gemini, messages: [send(renderPrompt(await assemble(signal, gemini)))] })
  assert.equal(await read(), gemini)
  const switched = renderPrompt(await assemble(signal, 'gpt-6.2-sol'))
  request({ signal, model: 'gpt-6.2-sol', provider: gemini, messages: [send(localized), send(switched)] })
  assert.equal(await read(), null)
  abort.abort()
  assert.equal(await read(), undefined)
})
