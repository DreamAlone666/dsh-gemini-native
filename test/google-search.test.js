import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import * as plugin from '../index.js'
import { googleSearch } from '../google-search.js'

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
  let enabled = true
  let markerMissing = false
  const warnings = []
  googleSearch({
    loader: { resolve: () => {
      if (markerMissing) throw new Error('no llm entry')
      return { moduleNamespace: { isAgentLoopRequest: request => request.agent === true } }
    } },
    logger: { warn: message => warnings.push(message) },
    on: (event, fn) => handlers.set(event, fn),
    effect: start => { cleanup = start() },
  }, { enableGoogleSearch: { get: () => enabled }, modelIds: { get: () => [model] } }, (m, rules) => rules.includes(m))

  function run({ loop = true, purpose, input = generation, rawBody = JSON.stringify(baseBody), intact = false } = {}) {
    const headers = new Headers({ 'x-goog-api-key': 'synthetic', 'content-length': '1' })
    const signal = new AbortController().signal
    const request = Object.freeze({ provider: 'mock', model, sessionId: 'test', agent: loop, purpose })
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
  return { run, offlineFetch, cleanup, warnings, setEnabled: value => { enabled = value }, loseMarker: () => { markerMissing = true } }
}

test('rewrites only scoped Gemini requests, preserving request and response ownership', async t => {
  const f = transportFixture(t)
  f.setEnabled(false)
  await f.run({ intact: true })
  assert.equal(globalThis.fetch, f.offlineFetch)
  f.setEnabled(true)
  const init = await f.run()
  assert.deepEqual(JSON.parse(init.body), {
    ...baseBody, tools: [...baseBody.tools, { googleSearch: {} }], toolConfig: { includeServerSideToolInvocations: true },
  })
  assert.deepEqual(Object.fromEntries(init.headers), { 'x-goog-api-key': 'synthetic' })
  for (const input of [
    `${baseURL}/chat/completions`, `${baseURL}/models/${model}:streamGenerateContent`,
    `${baseURL}/models/another:streamGenerateContent?alt=sse`, generation.replace('/relay/', '/other/'),
    generation.replace('gemini.test', 'other.test'), new Request(generation),
  ]) await f.run({ input, intact: true })
  await f.run({ loop: false, intact: true })
  await f.run({ purpose: 'session-title', intact: true })
  f.setEnabled(false)
  await f.run({ intact: true })
  f.cleanup()
  assert.equal(globalThis.fetch, f.offlineFetch)
})

test('handles search-only requests and respects existing tools and calling modes', async t => {
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
  f.setEnabled(false)
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

const installed = process.env.DSH_INSTALL_DIR

test('installed DSH: Loader, actual model dispatch, SDK payload, live rules and unload', { skip: !installed }, async t => {
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
    const reply = { candidates: [{ content: { role: 'model', parts: [{ text: 'Mock answer, unchanged.' }] }, finishReason: 'STOP' }] }
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
  await update({ enableGoogleSearch: true })
  assert.strictEqual(ctx.loader.resolve('gemini-enhancement').fiber, fiber)
  await Promise.all([
    invoke('matched'), invoke('gateway', { provider: 'gateway' }), invoke('openai', { provider: 'compatible' }),
    invoke('other-model', { selected: 'gemini-3-flash' }), invoke('one-shot', { loop: false }), invoke('title', { loop: false, purpose: 'session-title' }),
  ])
  for (const label of ['matched', 'gateway']) {
    assert.equal(injected(label), true)
    const { body } = captures.get(label)
    assert.equal(body.toolConfig.includeServerSideToolInvocations, true)
    assert.deepEqual(declarations(label), ['read_mock', 'web_fetch'])
  }
  for (const label of ['other-model', 'one-shot', 'title', 'openai']) {
    assert.equal(injected(label), false, label)
    assert.deepEqual(declarations(label), localTools, label)
  }
  await update({ enableGoogleSearch: true, modelIds: [] })
  await invoke('not-matched-live')
  assert.equal(injected('not-matched-live'), false)
  assert.deepEqual(declarations('not-matched-live'), localTools)
  await update({ enableGoogleSearch: false })
  await invoke('toggle-off-live')
  assert.equal(injected('toggle-off-live'), false)
  assert.deepEqual(declarations('toggle-off-live'), localTools)
  assert.strictEqual(ctx.loader.resolve('gemini-enhancement').fiber, fiber)
  await ctx.loader.update('gemini-enhancement', { config: { enableGoogleSearch: true }, disabled: true })
  assert.equal(globalThis.fetch, offline)
  await invoke('disabled-row')
  assert.equal(injected('disabled-row'), false)
})
