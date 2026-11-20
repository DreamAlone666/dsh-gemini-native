import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import * as plugin from '../index.js'
import { hasNativeReplay } from '../generate-content.js'

const installed = process.env.DSH_INSTALL_DIR
const routeId = 'offline-gemini-relay'
const model = 'gemini-4-hydrogen'
const baseURL = 'https://model-page.test/v1beta'
const reference = 'OFFLINE_GEMINI_RELAY_API_KEY'
const enhancer = 'dsh-gemini-enhancement'
const tools = ['read_mock', 'web_search'].map(name => ({ name, description: name, parameters: { type: 'object' } }))

test('real Models settings mutate the same provider to and from Gemini, reusing pi-ai for files, custom headers, and streaming',
  { skip: !installed, timeout: 7000 }, async t => {
    const require = createRequire(join(installed, 'package.json'))
    const load = spec => import(pathToFileURL(require.resolve(spec)).href)
    const { Context } = await load('@deepseek-ai/cordis')
    const { Loader } = await load('@deepseek-ai/cordis-plugin-loader')
    const { SettingsForms } = await load('@deepseek-ai/dsh-settings')
    const { SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
    const llm = await load('@deepseek-ai/dsh-llm')
    const pi = await load('@deepseek-ai/dsh-llm-pi-ai')
    const root = await mkdtemp(join(tmpdir(), 'dsh-model-page-'))
    const configURL = pathToFileURL(join(root, 'cordis.json')).href
    const llmURL = pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href
    await writeFile(new URL(configURL), JSON.stringify([]))
    const ctx = new Context()
    const loader = ctx.plugin(class extends Loader { commit() {} }, { baseUrl: configURL })
    const system = ctx.plugin(SystemPrompt)
    const originalFetch = globalThis.fetch
    let settings
    t.after(async () => {
      globalThis.fetch = originalFetch
      await loader.dispose()
      await settings?.dispose()
      await system.dispose()
      await rm(root, { recursive: true, force: true })
    })
    await loader
    await system
    ctx.loader.builtins.pi = pi
    ctx.loader.builtins.enhancer = plugin
    ctx.provide('profileContext', { home: root })
    const entryIds = ['llm-pi-ai', enhancer]
    const entries = () => entryIds.flatMap(id => { try { return [ctx.loader.resolve(id)] } catch { return [] } })
    ctx.provide('configEditor', {
      entries,
      configuration: () => entries().map(entry => ({ entry, inherited: {}, override: entry.options.config })),
      async edit(entry, change) { await ctx.loader.update(entry.id, { config: change(structuredClone(entry.options.config), {}) }) },
    })
    const refs = []
    ctx.provide('credentials', {
      async resolve(ref) { refs.push(ref); return { value: 'offline-models-key' } },
      async readRecord() {},
    })
    settings = ctx.plugin(SettingsForms)
    await settings
    await ctx.loader.create({ id: 'llm', name: llmURL })
    await ctx.loader.create({ id: 'llm-pi-ai', name: 'cordis:pi', config: { providers: {
      [routeId]: { api: 'openai-completions', baseURL, apiKeyEnv: reference, headers: { 'x-relay-tag': 'pi-ai-owned' }, models: [{ id: model }] },
      'second-gemini-relay': { api: 'google-generative-ai', baseURL, apiKeyEnv: reference, models: [{ id: model }] },
    } } })
    await ctx.loader.create({ id: enhancer, name: 'cordis:enhancer', config: {} })
    await ctx.loader.await()
    const route = () => ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === 'llm-pi-ai')
    const modelCatalog = () => ctx.llm.listModels(routeId).then(models => models.map(entry => entry.id))
    const mutate = async (ns, path, value) => {
      const form = ctx.settings.describe().find(row => row.ns === ns)
      await ctx.settings.mutate(ns, [{ op: 'set', path, value }], form.revision)
    }
    const setApi = value => mutate('llm-pi-ai', ['providers', routeId, 'api'], value)
    const setMode = value => mutate(enhancer, ['modelPageRoutes', routeId], value)
    assert.equal(route().value.providers[routeId].api, 'openai-completions')
    assert.deepEqual(await modelCatalog(), [model])

    const requests = []
    let gatewayStatus = 200
    globalThis.fetch = async (input, init) => {
      const path = new URL(input).pathname
      const headers = new Headers(init.headers)
      requests.push({ path, headers, body: JSON.parse(init.body) })
      if (gatewayStatus !== 200 || path.endsWith('/chat/completions')) {
        return Response.json({ error: { message: 'offline status' } }, { status: gatewayStatus === 200 ? 400 : gatewayStatus })
      }
      const payload = { candidates: [{ content: { role: 'model', parts: [{ text: 'Offline Gemini', unknown: 'extra part data' }] }, finishReason: 'STOP' }] }
      return new Response(`data: ${JSON.stringify(payload)}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    }
    const prepare = async (options = {}, { loop = true, provider = routeId } = {}) => {
      const prepared = await ctx.llm.prepareCall({ provider, model })
      const request = { ...prepared.config, tools, sessionId: 'models-offline', messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }], ...options }
      if (loop) llm.markAgentLoopRequest(request)
      return prepared.stream(Object.freeze(request))
    }
    const finish = async stream => {
      let last
      for await (const chunk of stream) last = chunk
      return last
    }
    const isNative = chunk => hasNativeReplay({ type: 'assistant/attempt', data: { stream: [{ type: 'chunk', chunk }] } })
    assert.ok(!isNative(await finish(await prepare())))
    assert.match(requests.at(-1).path, /chat\/completions$/u)

    await setApi('google-generative-ai')
    const originalRoute = route().value.providers[routeId]
    assert.ok(!isNative(await finish(await prepare())), 'plain Gemini API does not opt in to the plugin')
    await setMode('mixed')
    assert.deepEqual(route().value.providers[routeId], originalRoute)
    const beforePreparing = requests.length
    const captured = await prepare()
    assert.equal(requests.length, beforePreparing, 'preparing the stream has no I/O')
    await setApi('openai-completions')
    const native = await finish(captured)
    assert.ok(isNative(native))
    assert.equal(native.replayState.response.kind, 'pi-ai', 'keeps pi-ai replayState intact alongside native data')
    assert.match(requests.at(-1).path, /gemini-4-hydrogen:streamGenerateContent$/u)
    assert.equal(requests.at(-1).headers.get('x-goog-api-key'), 'offline-models-key')
    assert.equal(requests.at(-1).headers.get('x-relay-tag'), 'pi-ai-owned', 'custom headers stay handled by pi-ai')
    assert.deepEqual(requests.at(-1).body.tools.map(tool => tool.functionDeclarations?.map(fn => fn.name) ?? 'Google Search'), [['read_mock'], 'Google Search'])
    assert.ok(!isNative(await finish(await prepare({}, { provider: 'second-gemini-relay' }))))
    assert.ok(!requests.at(-1).body.tools.some(tool => tool.googleSearch))
    assert.ok(!isNative(await finish(await prepare())))
    assert.match(requests.at(-1).path, /chat\/completions$/u)

    await setApi('google-generative-ai')
    const saved = route().value.providers[routeId]
    assert.equal(saved.baseURL, baseURL)
    assert.equal(saved.apiKeyEnv, reference)
    assert.deepEqual(saved.models.map(entry => entry.id), [model])
    assert.deepEqual(await modelCatalog(), [model])
    assert.ok(!isNative(await finish(await prepare({ purpose: 'session-title' }, { loop: false }))))

    // File attachments and orphaned tool histories now work natively via pi-ai instead of falling back!
    const withFile = await finish(await prepare({ messages: [{ role: 'user', content: [
      { type: 'text', text: 'see attached notes' },
      { type: 'file', attachment: { attachmentId: 'offline-notes', name: 'notes.txt', bytes: 20 } },
    ] }] }))
    assert.ok(isNative(withFile))
    assert.match(JSON.stringify(requests.at(-1).body), /notes\.txt/u)

    const orphan = await finish(await prepare({ messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] },
      { role: 'tool', toolCallId: 'without-an-owner', content: [{ type: 'text', text: 'orphan result' }] },
    ] }))
    assert.ok(isNative(orphan))

    await setMode('search-only')
    assert.ok(isNative(await finish(await prepare())))
    assert.ok(!requests.at(-1).body.tools.some(tool => tool.googleSearch), 'search-only does not mix with read_mock')
    assert.ok(requests.at(-1).body.tools[0].functionDeclarations.some(tool => tool.name === 'web_search'))
    assert.ok(isNative(await finish(await prepare({ tools: tools.filter(tool => tool.name === 'web_search') }))))
    assert.deepEqual(requests.at(-1).body.tools, [{ googleSearch: {} }])

    await setMode('off')
    assert.ok(isNative(await finish(await prepare())))
    assert.ok(!requests.at(-1).body.tools.some(tool => tool.googleSearch))
    assert.ok(requests.at(-1).body.tools[0].functionDeclarations.some(tool => tool.name === 'web_search'))

    await setMode('standard')
    assert.ok(!isNative(await finish(await prepare())), 'plugin page can restore the normal Gemini protocol')
    assert.deepEqual(route().value.providers[routeId], originalRoute)

    await setMode('off')
    gatewayStatus = 400
    const count = requests.length
    assert.equal((await finish(await prepare())).reason.kind, 'error')
    assert.equal(requests.length, count + 1)
    assert.ok(refs.every(ref => ref === reference))
  })
