import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import * as plugin from '../src/index.js'
import { hasNativeReplay } from '../src/generate-content.js'

const installed = process.env.DSH_INSTALL_DIR
const routeId = 'offline-gemini-relay'
const model = 'gemini-4-hydrogen'
const baseURL = 'https://model-page.test/v1beta'
const reference = 'OFFLINE_GEMINI_RELAY_API_KEY'
const geminiNative = 'dsh-gemini-native'
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
    ctx.loader.builtins.geminiNative = plugin
    ctx.provide('profileContext', { home: root })
    const fetchRoutes = new Map()
    ctx.provide('connection', { fetch: { register(route) {
      fetchRoutes.set(route.path, route)
      return () => fetchRoutes.delete(route.path)
    } } })
    const entryIds = ['llm-pi-ai', geminiNative]
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
    await ctx.loader.create({ id: geminiNative, name: 'cordis:geminiNative', config: {} })
    await ctx.loader.await()
    const route = () => ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === 'llm-pi-ai')
    const modelCatalog = () => ctx.llm.listModels(routeId).then(models => models.map(entry => entry.id))
    const mutate = async (ns, ops) => {
      const form = ctx.settings.describe().find(row => row.ns === ns)
      await ctx.settings.mutate(ns, ops, form.revision)
    }
    const setApi = value => mutate('llm-pi-ai', [{ op: 'set', path: ['providers', routeId, 'api'], value }])
    const setRoute = value => mutate(geminiNative, value
      ? [{ op: 'set', path: ['routes', routeId], value }]
      : [{ op: 'unset', path: ['routes', routeId] }])
    assert.equal(route().value.providers[routeId].api, 'openai-completions')
    assert.deepEqual(await modelCatalog(), [model])

    const requests = []
    const gatewayError = 'offline status'
    const defaultParts = [{ text: 'Offline Gemini', unknown: 'extra part data' }]
    let gatewayStatus = 200
    let rejectBody
    let replyParts = defaultParts
    globalThis.fetch = async (input, init) => {
      const path = new URL(input).pathname
      const headers = new Headers(init.headers)
      const body = JSON.parse(init.body)
      requests.push({ path, headers, body })
      if (gatewayStatus !== 200 || path.endsWith('/chat/completions') || rejectBody?.(body)) {
        return Response.json({ error: { message: gatewayError } }, { status: gatewayStatus === 200 ? 400 : gatewayStatus })
      }
      const payload = { candidates: [{ content: { role: 'model', parts: replyParts }, finishReason: 'STOP' }] }
      return new Response(`data: ${JSON.stringify(payload)}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    }
    const prepare = async (options = {}, { loop = true, provider = routeId, targetModel = model } = {}) => {
      const prepared = await ctx.llm.prepareCall({ provider, model: targetModel })
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
    assert.ok(isNative(await finish(await prepare())), 'Gemini records native parts by default')
    assert.ok(!requests.at(-1).body.tools.some(tool => tool.googleSearch))
    await setRoute({ localizePrompt: true, nativeHistory: true, googleSearch: true })
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
    assert.ok(isNative(await finish(await prepare({}, { provider: 'second-gemini-relay' }))))
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

    // File attachments and orphaned tool histories work natively via pi-ai.
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

    // Native history on, Google Search off: keeps web_search intact and still records native parts.
    await setRoute({ localizePrompt: false, nativeHistory: true, googleSearch: false })
    assert.ok(isNative(await finish(await prepare())))
    assert.ok(!requests.at(-1).body.tools.some(tool => tool.googleSearch))
    assert.ok(requests.at(-1).body.tools[0].functionDeclarations.some(tool => tool.name === 'web_search'))

    // Google Search on without native history: replaces web_search with Google Search, skips native recording.
    await setRoute({ localizePrompt: false, nativeHistory: false, googleSearch: true })
    assert.ok(!isNative(await finish(await prepare())))
    assert.deepEqual(requests.at(-1).body.tools.map(tool => tool.functionDeclarations?.map(fn => fn.name) ?? 'Google Search'), [['read_mock'], 'Google Search'])
    assert.equal(requests.at(-1).body.toolConfig.includeServerSideToolInvocations, true)

    // Unsetting the override restores the default replay-on, search-off posture.
    await setRoute(undefined)
    assert.ok(isNative(await finish(await prepare())), 'clearing route restores default replay')
    assert.ok(!requests.at(-1).body.tools.some(tool => tool.googleSearch))
    assert.deepEqual(route().value.providers[routeId], originalRoute)

    await t.test('a provider opt-in replays Gemini 4 history across models and can be cleared after HTTP 400', async t => {
      const neon = 'gemini-4-neon'
      const neonResource = 'models/GEMINI-4-NEON'
      await mutate('llm-pi-ai', [{
        op: 'set', path: ['providers', routeId, 'models'], value: [model, neon, neonResource].map(id => ({ id })),
      }])
      const nativeForm = () => ctx.settings.describe().find(row => row.ns === geminiNative)
      assert.equal(nativeForm().value.routes[routeId], undefined, 'start with no provider override')

      const sessionId = 'models-offline-family'
      const statusPath = '/api/dsh-gemini-native/status'
      const checkStatus = async (replayed, warned, candidates) => {
        // Connect after consuming the LLM stream so this is the settled snapshot,
        // not a transient frame that could be overwritten by stream finalization.
        const response = await fetchRoutes.get(statusPath).fetch(new Request(`http://localhost${statusPath}?sessionId=${sessionId}`))
        assert.match(response.headers.get('content-type'), /^text\/event-stream/u)
        const reader = response.body.getReader()
        try {
          const frame = await reader.read()
          assert.equal(frame.done, false)
          const { transport } = JSON.parse(new TextDecoder().decode(frame.value).slice('data: '.length))
          const expected = {
            provider: routeId, model: neon, totalHistoryTurns: 1, currentModelHistoryTurns: 0,
            replayedHistoryTurns: replayed, sameModelReplayedTurns: 0,
            crossModelReplayedTurns: replayed, crossModelHttp400: warned,
            ...(candidates === undefined ? {} : { crossModelCandidateTurns: candidates }),
          }
          for (const [key, value] of Object.entries(expected)) assert.equal(transport?.[key], value, key)
        } finally {
          await reader.cancel()
        }
      }

      const signature = label => Buffer.from(label).toString('base64')
      const rawId = 'offline/call'
      const visibleText = 'I will read the notes.'
      const callSignature = signature('call')
      const functionCall = { id: rawId, name: 'read_mock', args: { path: 'notes.txt' } }
      const rawParts = [
        { thought: true, text: 'Plan the read.', thoughtSignature: signature('thinking') },
        { text: visibleText, thoughtSignature: signature('text') },
        { functionCall, thoughtSignature: callSignature },
      ]
      t.after(() => { replyParts = defaultParts; rejectBody = undefined })
      // The relay rejects the replayed signature even after the local setting changes.
      rejectBody = body => body.contents.some(entry => entry.role === 'model'
        && entry.parts.some(part => part.functionCall && part.thoughtSignature === callSignature))
      replyParts = rawParts
      const user = text => llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
      const opening = user('Read the notes.')
      const assembler = new llm.BlockAssembler()
      for await (const chunk of await prepare({ sessionId, messages: [opening] })) assembler.push(chunk)
      replyParts = defaultParts
      assert.equal(assembler.finish.kind, 'tool-calls')
      const hydrogen = assembler.message({ provider: routeId, model, replayState: assembler.replayState })
      assert.ok(hasNativeReplay({ type: 'assistant/message', data: { message: hydrogen } }), 'native history records by default')
      const call = hydrogen.content.find(block => block.type === 'tool-call')
      assert.equal(call?.id, rawId)
      const result = llm.createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'Found the notes.' }], isError: false })
      // Each Neon request sees the same history: no previously committed Neon turn.
      const messages = [opening, hydrogen, result, user('Now summarize the notes.')]
      const runNeon = async (targetModel = neon) => {
        const before = requests.length
        const terminal = await finish(await prepare({ sessionId, messages }, { targetModel }))
        assert.equal(requests.length, before + 1, 'each manual invocation makes one upstream request')
        const { path, body } = requests[before]
        const resource = targetModel.startsWith('models/') ? targetModel : `models/${targetModel}`
        assert.equal(path, `/v1beta/${resource}:streamGenerateContent`)
        return { terminal, contents: body.contents }
      }
      const compatibleId = 'offline_call'
      const assertCompatible = contents => {
        assert.deepEqual(contents[1], { role: 'model', parts: [
          { text: visibleText }, { functionCall: { ...functionCall, id: compatibleId } },
        ] }, 'pi-ai strips cross-model thinking and signatures')
        assert.equal(contents[2].parts[0].functionResponse.id, compatibleId)
      }

      const baseline = await runNeon()
      assert.equal(baseline.terminal.reason.kind, 'stop')
      assertCompatible(baseline.contents)
      await checkStatus(0, false, 1)

      await setRoute({ gemini4FamilyReplay: true })
      assert.equal(nativeForm().value.routes[routeId].gemini4FamilyReplay, true)
      assert.equal(nativeForm().value.routes[routeId].nativeHistory, true, 'the opt-in alone keeps native history on')
      const rejected = await runNeon()
      assert.equal(rejected.terminal.reason.kind, 'error')
      assert.ok(rejected.terminal.reason.failure.message.includes(gatewayError), 'the SDK still receives the original 400 body')
      assert.deepEqual(rejected.contents[1], { role: 'model', parts: rawParts })
      assert.equal(rejected.contents[2].parts[0].functionResponse.id, rawId)
      await checkStatus(1, true)

      const withResourcePrefix = await runNeon(neonResource)
      assert.equal(withResourcePrefix.terminal.reason.kind, 'error', 'the resource alias also sent the rejected native parts')
      assert.deepEqual(withResourcePrefix.contents[1], { role: 'model', parts: rawParts })
      assert.equal(withResourcePrefix.contents[2].parts[0].functionResponse.id, rawId)

      await setRoute(undefined)
      assert.equal(nativeForm().value.routes[routeId], undefined, 'clear the only override using the current form revision')
      const retried = await runNeon()
      assert.equal(retried.terminal.reason.kind, 'stop')
      assert.ok(isNative(retried.terminal), 'clearing the family opt-in does not disable recording')
      assertCompatible(retried.contents)
      await checkStatus(0, false, 1)
    })

    await setRoute({ localizePrompt: false, nativeHistory: true, googleSearch: false })
    gatewayStatus = 400
    const count = requests.length
    assert.equal((await finish(await prepare())).reason.kind, 'error')
    assert.equal(requests.length, count + 1)
    assert.ok(refs.every(ref => ref === reference))
  })
