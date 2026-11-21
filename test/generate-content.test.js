import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import * as plugin from '../index.js'
import { diagnosticsProjection } from '../diagnostics-projection.js'
import { geminiTransport } from '../gemini-transport.js'
import {
  attachNativeReplay, hasNativeReplay, historyFingerprint, makeNativeReplayData, nativeReplayOf,
  normalizeEndpoint, patchGenerateContentBody, routeIdentity,
} from '../generate-content.js'
import { searchActivityPath } from '../google-search-activity.js'
import { nativeSearchProjection } from '../native-search-projection.js'
import { xhighPath } from '../xhigh.js'

const installed = process.env.DSH_INSTALL_DIR
const model = 'gemini-4-hydrogen'
const query = 'DSH test query'
const validSig = label => Buffer.from(label).toString('base64')
const parts = [
  { text: '先查一下 ', thought: true, thoughtSignature: validSig('sig-r1') },
  { text: '最新状态。', thought: true, thoughtSignature: validSig('sig-r2') },
  { text: 'I will check. '.repeat(20), thoughtSignature: validSig('signature-1'), futureField: { preserved: true } },
  { text: 'More details. '.repeat(20), thoughtSignature: validSig('signature-1b') },
  { toolCall: { id: 'google-1', toolType: 'GOOGLE_SEARCH_WEB', args: { queries: [query] } }, thoughtSignature: validSig('signature-2') },
  { toolResponse: { id: 'google-1', toolType: 'GOOGLE_SEARCH_WEB', response: { sources: [{ uri: 'https://example.org/article', title: 'Example' }] } }, thoughtSignature: validSig('signature-3') },
  { opaquePart: ['unknown kind is still ordered'] },
  { functionCall: { id: 'read-1', name: 'read_mock', args: { path: 'a.txt' } }, thoughtSignature: validSig('signature-4') },
]
const frame = (frameParts, finishReason) => ({
  candidates: [{ index: 0, content: { role: 'model', parts: frameParts }, ...(finishReason ? { finishReason } : {}) }],
})
const streamFrames = [
  frame([parts[0]]),
  frame([parts[1]]),
  frame([parts[2]]),
  frame([parts[3], parts[4]]),
  frame(parts.slice(5), 'STOP'),
]
const answerFrames = [
  frame([{ text: '目前 **DeepSeek Harness (`@deepseek-ai/' }]),
  frame([{ text: 'dsh`)** 的最新版本是 **0.2.2-rc.5**' }]),
  frame([{ text: '。' }], 'STOP'),
]
const searchSummary = [{ status: 'completed', queries: [query], sources: [{ url: 'https://example.org/article', title: 'Example' }] }]

function sse(frames) {
  const bytes = Buffer.from(frames.map(entry => `data: ${JSON.stringify(entry)}\r\n\r\n`).join(''))
  const body = new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 71) controller.enqueue(bytes.subarray(i, i + 71))
    controller.close()
  } })
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })
}

test('installed DSH reuses pi-ai for streaming, persists native parts & pi-ai replayState, replays exact parts, and rebuilds projection',
  { skip: !installed, timeout: 12000 }, async t => {
    const require = createRequire(join(installed, 'package.json'))
    const load = spec => import(pathToFileURL(require.resolve(`@deepseek-ai/${spec}`)).href)
    const { Context } = await load('cordis')
    const { Loader } = await load('cordis-plugin-loader')
    const { createUserMessage } = await load('dsh-llm')
    const pi = await load('dsh-llm-pi-ai')
    const { AgentRegistry } = await load('dsh-agent')
    const { AgentLoop } = await load('dsh-agent-loop')
    const { ToolsService } = await load('dsh-tools')
    const { SystemPrompt } = await load('dsh-system-prompt')
    const { SessionStore } = await load('dsh-session')
    const { SessionProjectionRegistry } = await load('dsh-session-projection')
    const persistence = await load('dsh-session-persistence-jsonl')
    const executor = await load('dsh-tool-executor-native')

    const root = await mkdtemp(join(tmpdir(), 'dsh-native-pi-ai-'))
    const requests = []
    const originalFetch = globalThis.fetch
    let mode = 'normal'
    const transport = async (input, init) => {
      const url = new URL(input)
      const body = JSON.parse(init.body)
      requests.push({ url, body, headers: new Headers(init.headers) })
      if (mode === 'drop') return sse([streamFrames[3]])
      if (mode === 'max-tokens') return sse([frame([{ text: 'cut ' }]), frame([{ text: 'short' }], 'MAX_TOKENS')])
      return sse(body.contents.length === 1 ? streamFrames : answerFrames)
    }
    globalThis.fetch = transport
    const stacks = []
    t.after(async () => {
      globalThis.fetch = originalFetch
      for (const cleanup of stacks.reverse()) await cleanup()
      await rm(root, { recursive: true, force: true })
    })

    async function boot(pluginConfig) {
      const ctx = new Context()
      const fibers = []
      const configPath = join(root, `cordis-${stacks.length}.json`)
      await writeFile(configPath, JSON.stringify([]))
      const llmURL = pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href
      const loader = ctx.plugin(class extends Loader { commit() {} }, { baseUrl: pathToFileURL(configPath).href })
      await loader
      ctx.loader.builtins.pi = pi
      ctx.loader.builtins.enhancer = plugin
      const privacy = {}
      ctx.provide('sessionLogDeepSeek', { registerExclusion(predicate) { privacy.exclude = predicate } })
      ctx.provide('credentials', { async resolve(ref) { return { value: `mock-${ref}` } }, async readRecord() {} })
      for (const mod of [SessionStore, SessionProjectionRegistry]) {
        const fiber = ctx.plugin(mod); fibers.push(fiber); await fiber
      }
      const persist = ctx.plugin(persistence, { root, compression: 'none' }); fibers.push(persist); await persist
      await ctx.loader.create({ id: 'llm', name: llmURL })
      await ctx.loader.create({ id: 'llm-pi-ai', name: 'cordis:pi', config: { providers: {
        native: {
          api: 'google-generative-ai', baseURL: 'https://native.test/v1beta', apiKeyEnv: 'NATIVE_KEY',
          headers: { 'x-custom-relay': 'kept-by-pi-ai' },
          models: [{ id: model, reasoningEfforts: { off: null, high: 'high' } }],
        },
      } } })
      for (const mod of [AgentRegistry, ToolsService, SystemPrompt, executor, AgentLoop]) {
        const fiber = ctx.plugin(mod); fibers.push(fiber); await fiber
      }
      if (pluginConfig) {
        await ctx.loader.create({ id: 'enhancer', name: 'cordis:enhancer', config: pluginConfig })
      }
      await ctx.loader.await()
      stacks.push(async () => {
        await loader.dispose()
        for (const fiber of fibers.reverse()) await fiber.dispose()
      })
      return { ctx, privacy }
    }

    const { ctx, privacy } = await boot({ routes: { native: { localizePrompt: false, nativeHistory: true, googleSearch: true } } })
    let calls = 0
    ctx.tools.register({
      name: 'read_mock', description: 'read_mock', parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
      execute() { calls++; return 'done' },
    })
    ctx.tools.register({
      name: 'web_search', description: 'web_search', parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
      execute() { return 'local-search' },
    })

    const agent = await ctx.agentLoop.create('native-pi-ai-integration', { provider: 'native', model })
    assert.equal(privacy.exclude({ sessionId: agent.id }), false)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'test native history' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    assert.equal(calls, 1)
    assert.equal(requests.length, 2)
    assert.equal(requests[0].headers.get('x-custom-relay'), 'kept-by-pi-ai', 'pi-ai custom headers are preserved')
    assert.ok(requests[0].body.tools.some(tool => tool.googleSearch))
    assert.deepEqual(
      requests[0].body.tools.flatMap(tool => tool.functionDeclarations?.map(fn => fn.name) ?? []),
      ['read_mock'],
    )
    assert.equal(requests[0].body.toolConfig.includeServerSideToolInvocations, true)
    assert.deepEqual(requests[1].body.contents[1], { role: 'model', parts })
    assert.equal(requests[1].body.contents[2].parts[0].functionResponse.id, 'read-1')
    assert.equal(await ctx.sessions.flush(agent.session), true)
    assert.equal(privacy.exclude({ sessionId: agent.id, purpose: 'session-title' }), true)
    const view = ctx.sessionProjections.snapshot(agent.session).values[nativeSearchProjection.key]
    assert.deepEqual(view, { 1: searchSummary })
    const diag = ctx.sessionProjections.snapshot(agent.session).values[diagnosticsProjection.key]
    assert.equal(diag.assistantSteps, 2)
    assert.equal(diag.nativeSteps, 2)
    assert.equal(diag.consecutiveNative, 2)
    assert.equal(diag.hasNativePayload, true)
    assert.ok(diag.nativeBytes > 0)
    assert.equal(diag.lastNativeModel, model)
    assert.equal(diag.lastNativeOutcome, 'complete')
    assert.equal(diag.searchCards, 1)
    assert.equal(diag.searchQueries, 1)
    assert.equal(diag.searchSources, 1)
    assert.equal(diag.promptLocalizedInLog, false)

    // Verify failed transport attempt still preserves incomplete search evidence for projection.
    mode = 'drop'
    const dropAgent = await ctx.agentLoop.create('native-pi-ai-drop', { provider: 'native', model })
    dropAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'drop mid-stream' }], source: { kind: 'user' } }))
    await dropAgent.whenIdle()
    const dropAttempt = dropAgent.session.snapshotEvents().find(event => event.type === 'assistant/attempt')
    assert.ok(dropAttempt && hasNativeReplay(dropAttempt))
    assert.deepEqual(
      ctx.sessionProjections.snapshot(dropAgent.session).values[nativeSearchProjection.key],
      { 1: [{ status: 'incomplete', queries: [query], sources: [] }] },
    )

    // Verify MAX_TOKENS closes streamed text cleanly via pi-ai and keeps raw truncated native record.
    mode = 'max-tokens'
    const maxAgent = await ctx.agentLoop.create('native-pi-ai-max', { provider: 'native', model })
    maxAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'truncate' }], source: { kind: 'user' } }))
    await maxAgent.whenIdle()
    const maxMessage = maxAgent.session.snapshotEvents().find(event => event.type === 'assistant/message')
    assert.deepEqual(maxMessage.data.message.content, [{ type: 'text', text: 'cut short' }])
    assert.equal(nativeReplayOf(maxMessage).outcome, 'truncated')

    // Dispose first host, reopen cold from JSONL, and verify both pi-ai replayState + native replay + projection.
    await stacks.pop()()
    const { ctx: fresh, privacy: freshPrivacy } = await boot({})
    const stored = await fresh.sessionPersistence.open(agent.id, 'read')
    try {
      const record = await stored.read()
      const messages = record.events.filter(event => event.type === 'assistant/message')
      assert.equal(messages.length, 2)
      const first = messages[0]
      // Both pi-ai replayState and embedded native replay survive cold persistence.
      assert.equal(first.data.message.source.replayState.response.kind, 'pi-ai')
      assert.ok(first.data.message.source.replayState.response.dshGeminiNative.refs.length > 0)
      assert.deepEqual(first.data.message.content.map(block => block.type), ['reasoning', 'text', 'tool-call'])
      assert.equal(first.data.message.content[0].text, '先查一下 最新状态。')
      assert.equal(first.data.message.content[1].text, parts[2].text + parts[3].text)
      assert.deepEqual(nativeReplayOf(first).frames.flatMap(entry => entry[0].content.parts), parts)
      // Second turn streamed across 3 frames renders as ONE coalesced text block.
      assert.deepEqual(messages[1].data.message.content, [{
        type: 'text',
        text: '目前 **DeepSeek Harness (`@deepseek-ai/dsh`)** 的最新版本是 **0.2.2-rc.5**。',
      }])
      const session = fresh.sessions.prepare(agent.id, { meta: record.header, seed: record.events })
      assert.deepEqual(fresh.sessionProjections.snapshot(session).values[nativeSearchProjection.key], { 1: searchSummary })
      assert.deepEqual(fresh.sessionProjections.snapshot(session).values[diagnosticsProjection.key], diag)
      const dispose = fresh.sessions.enter(session)
      try {
        fresh.sessions.announce(session)
        assert.equal(freshPrivacy.exclude({ sessionId: agent.id }), true)
      } finally { dispose() }

      // Even with native mode disabled (standard pi-ai), continuing from saved messages
      // keeps valid pi-ai thoughtSignatures intact without degrading to foreign history.
      mode = 'normal'
      const prepared = await fresh.llm.prepareCall({ provider: 'native', model })
      const savedCall = first.data.message.content.find(block => block.type === 'tool-call')
      const beforeFollowup = requests.length
      for await (const _chunk of prepared.stream(Object.freeze({
        ...prepared.config,
        sessionId: agent.id,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'test native history' }] },
          first.data.message,
          { role: 'tool', toolCallId: savedCall.id, content: [{ type: 'text', text: 'done' }] },
          messages[1].data.message,
          { role: 'user', content: [{ type: 'text', text: 'follow up after disabling plugin' }] },
        ],
      }))) {}
      const followupParts = requests[beforeFollowup].body.contents[1].parts
      assert.ok(followupParts.some(part => part.thought === true && part.thoughtSignature === validSig('sig-r2')),
        'pi-ai reasoning signature survives even when native mode is turned off')
      assert.ok(followupParts.some(part => part.functionCall?.name === 'read_mock' && part.thoughtSignature === validSig('signature-4')),
        'pi-ai tool-call signature survives even when native mode is turned off')
    } finally { await stored.close() }
  })

test('installed DSH: compaction aligns prefix byte-for-byte on same route without XHigh, recording, or search pollution, and skips cross-model compaction',
  { skip: !installed, timeout: 12000 }, async t => {
    const require = createRequire(join(installed, 'package.json'))
    const load = spec => import(pathToFileURL(require.resolve(`@deepseek-ai/${spec}`)).href)
    const { Context } = await load('cordis')
    const { Loader } = await load('cordis-plugin-loader')
    const { createUserMessage } = await load('dsh-llm')
    const pi = await load('dsh-llm-pi-ai')
    const { AgentRegistry } = await load('dsh-agent')
    const { AgentLoop } = await load('dsh-agent-loop')
    const { ToolsService } = await load('dsh-tools')
    const { SystemPrompt } = await load('dsh-system-prompt')
    const { SessionStore } = await load('dsh-session')
    const { SessionProjectionRegistry } = await load('dsh-session-projection')
    const persistence = await load('dsh-session-persistence-jsonl')
    const executor = await load('dsh-tool-executor-native')
    const { TokenMeter } = await load('dsh-token-meter')
    const { BasicCompactionEngine } = await load('dsh-compaction-basic')

    const root = await mkdtemp(join(tmpdir(), 'dsh-compaction-align-'))
    const requests = []
    const originalFetch = globalThis.fetch
    const compactionFrames = [{
      candidates: [{
        index: 0,
        content: { role: 'model', parts: [{ text: '## Primary Request and Intent\n- Checked status.' }] },
        groundingMetadata: { webSearchQueries: ['compaction-noise'] },
        finishReason: 'STOP',
      }],
    }]
    globalThis.fetch = async (input, init) => {
      const url = new URL(input)
      const body = JSON.parse(init.body)
      requests.push({ url, body, headers: new Headers(init.headers) })
      const lastText = body.contents.at(-1)?.parts?.map(part => part.text ?? '').join('') ?? ''
      if (lastText.includes('You are now acting as a compaction engine')) {
        return sse(compactionFrames)
      }
      return sse(body.contents.length === 1 ? streamFrames : answerFrames)
    }
    const stacks = []
    t.after(async () => {
      globalThis.fetch = originalFetch
      for (const cleanup of stacks.reverse()) await cleanup()
      await rm(root, { recursive: true, force: true })
    })

    async function boot(compactionConfig = { auto: false }) {
      const ctx = new Context()
      const fibers = []
      const routes = new Map()
      const configPath = join(root, `cordis-${stacks.length}.json`)
      await writeFile(configPath, JSON.stringify([]))
      const llmURL = pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href
      const loader = ctx.plugin(class extends Loader { commit() {} }, { baseUrl: pathToFileURL(configPath).href })
      await loader
      ctx.loader.builtins.pi = pi
      ctx.loader.builtins.enhancer = plugin
      ctx.provide('connection', {
        fetch: {
          register(def) {
            routes.set(def.path, def)
            return () => routes.delete(def.path)
          },
        },
      })
      ctx.provide('credentials', { async resolve(ref) { return { value: `mock-${ref}` } }, async readRecord() {} })
      for (const mod of [SessionStore, SessionProjectionRegistry]) {
        const fiber = ctx.plugin(mod); fibers.push(fiber); await fiber
      }
      const persist = ctx.plugin(persistence, { root, compression: 'none' }); fibers.push(persist); await persist
      const meter = ctx.plugin(TokenMeter, {}); fibers.push(meter); await meter
      await ctx.loader.create({ id: 'llm', name: llmURL })
      await ctx.loader.create({ id: 'llm-pi-ai', name: 'cordis:pi', config: { providers: {
        native: {
          api: 'google-generative-ai', baseURL: 'https://native.test/v1beta', apiKeyEnv: 'NATIVE_KEY',
          models: [
            { id: model, reasoningEfforts: { off: null, medium: 'medium', high: 'high' } },
            { id: 'gemini-3-flash' },
          ],
        },
      } } })
      for (const mod of [AgentRegistry, ToolsService, SystemPrompt, executor, AgentLoop]) {
        const fiber = ctx.plugin(mod); fibers.push(fiber); await fiber
      }
      const compaction = ctx.plugin(BasicCompactionEngine, compactionConfig); fibers.push(compaction); await compaction
      await ctx.loader.create({
        id: 'enhancer',
        name: 'cordis:enhancer',
        config: { routes: { native: { localizePrompt: false, nativeHistory: true, googleSearch: true } } },
      })
      await ctx.loader.await()
      ctx.tools.register({
        name: 'read_mock', description: 'read_mock', parameters: { type: 'object' },
        output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
        execute() { return 'done '.repeat(80) },
      })
      ctx.tools.register({
        name: 'web_search', description: 'web_search', parameters: { type: 'object' },
        output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
        execute() { return 'local-search' },
      })
      stacks.push(async () => {
        await loader.dispose()
        for (const fiber of fibers.reverse()) await fiber.dispose()
      })
      return { ctx, routes }
    }

    // 1. Same-provider, same-model compaction with nativeHistory + googleSearch + XHigh enabled.
    const same = await boot({ auto: false })
    const agent = await same.ctx.agentLoop.create('compaction-same-route', {
      provider: 'native', model, reasoningEffort: 'medium',
    })
    const enableXHigh = await same.routes.get(xhighPath).fetch(new Request(`http://localhost${xhighPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: agent.id, enabled: true }),
    }))
    assert.equal(enableXHigh.status, 200)

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Inspect native history and search state. '.repeat(20) }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    assert.equal(requests.length, 2)
    const mainStep2 = requests[1].body
    assert.equal(mainStep2.generationConfig?.thinkingConfig?.thinkingLevel, 'XHIGH', 'main turn must use XHIGH')
    assert.deepEqual(mainStep2.contents[1], { role: 'model', parts })
    assert.equal(mainStep2.contents[2].parts[0].functionResponse.id, 'read-1')
    const nativeCountBefore = agent.session.snapshotEvents().filter(hasNativeReplay).length
    const seqBeforeCompaction = agent.session.seq

    const compacted = await same.ctx.compaction.compactNow(agent, new AbortController().signal)
    assert.ok(compacted, 'compactNow should produce a durable checkpoint')
    assert.equal(requests.length, 3)
    const compactionReq = requests[2].body

    // Byte-for-byte prefix alignment with main conversation request.
    assert.equal(JSON.stringify(compactionReq.systemInstruction), JSON.stringify(mainStep2.systemInstruction))
    assert.equal(JSON.stringify(compactionReq.tools), JSON.stringify(mainStep2.tools))
    assert.equal(JSON.stringify(compactionReq.toolConfig), JSON.stringify(mainStep2.toolConfig))
    assert.equal(
      JSON.stringify(compactionReq.contents.slice(0, mainStep2.contents.length)),
      JSON.stringify(mainStep2.contents),
      'compaction historical contents must match main conversation prefix byte-for-byte',
    )
    assert.notEqual(
      compactionReq.generationConfig?.thinkingConfig?.thinkingLevel,
      'XHIGH',
      'compaction must never inject XHIGH',
    )

    // Verify no projection pollution, no activity leakage, and no native recording for compaction.
    assert.deepEqual(
      same.ctx.sessionProjections.snapshot(agent.session).values[nativeSearchProjection.key],
      { 1: searchSummary },
    )
    const sameDiag = same.ctx.sessionProjections.snapshot(agent.session).values[diagnosticsProjection.key]
    assert.equal(sameDiag.assistantSteps, 2)
    assert.equal(sameDiag.nativeSteps, 2)
    assert.equal(sameDiag.searchCards, 1)
    const eventsAfterCompaction = agent.session.snapshotEvents(seqBeforeCompaction)
    assert.equal(eventsAfterCompaction.some(hasNativeReplay), false)
    assert.equal(JSON.stringify(eventsAfterCompaction).includes('dshGeminiNative'), false)
    assert.equal(agent.session.snapshotEvents().filter(hasNativeReplay).length, nativeCountBefore)

    const activityRes = same.routes.get(searchActivityPath).fetch(
      new Request(`http://localhost${searchActivityPath}?sessionId=${agent.id}`),
    )
    const activityReader = activityRes.body.getReader()
    try {
      const activity = JSON.parse(new TextDecoder().decode((await activityReader.read()).value).slice(6))
      assert.deepEqual(activity, { liveTurn: null, cards: [] })
    } finally {
      await activityReader.cancel()
    }

    // 2. Cross-model compaction on the same provider (gemini-3-flash instead of gemini-4-hydrogen) must stay untouched.
    const cross = await boot({
      auto: false,
      summarizationProvider: 'native',
      summarizationModel: 'gemini-3-flash',
    })
    const crossAgent = await cross.ctx.agentLoop.create('compaction-cross-model', {
      provider: 'native', model,
    })
    crossAgent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Inspect cross-model compaction. '.repeat(20) }],
      source: { kind: 'user' },
    }))
    await crossAgent.whenIdle()
    const beforeCrossCompact = requests.length
    const crossCompacted = await cross.ctx.compaction.compactNow(crossAgent, new AbortController().signal)
    assert.ok(crossCompacted)
    assert.equal(requests.length, beforeCrossCompact + 1)
    const crossReq = requests[beforeCrossCompact]
    assert.match(crossReq.url.pathname, /\/models\/gemini-3-flash:streamGenerateContent$/u)
    assert.equal(crossReq.body.tools.some(tool => Object.hasOwn(tool, 'googleSearch')), false)
    assert.deepEqual(
      crossReq.body.tools.flatMap(tool => tool.functionDeclarations?.map(fn => fn.name) ?? []),
      ['read_mock'],
    )
    assert.equal(crossReq.body.toolConfig?.includeServerSideToolInvocations, undefined)
    assert.equal(crossReq.body.contents[1].parts.some(part => Object.hasOwn(part, 'toolCall')), false)
    assert.notEqual(crossReq.body.generationConfig?.thinkingConfig?.thinkingLevel, 'XHIGH')
  })

test('patchGenerateContentBody counts totalModelTurns and replayedModelTurns accurately', () => {
  const baseURL = normalizeEndpoint('https://gemini.test/v1beta')
  const route = { baseURL, provider: 'native', googleSearch: false }
  route.identity = routeIdentity(route)
  const prefix0 = historyFingerprint([{ role: 'user', parts: [{ text: 'u1' }] }])
  const blocks1 = [{ type: 'text', text: 'Native turn 1' }]
  const parts1 = [{ text: 'Native turn 1', thoughtSignature: validSig('s1') }]
  const replay1 = makeNativeReplayData(route, model, [[{ index: 0, content: { role: 'model', parts: parts1 }, finishReason: 'STOP' }]], [], 'complete', prefix0, blocks1)

  const body = {
    contents: [
      { role: 'user', parts: [{ text: 'u1' }] },
      { role: 'model', parts: [{ text: 'Native turn 1' }] },
      { role: 'user', parts: [{ text: 'u2' }] },
      { role: 'model', parts: [{ text: 'Plain turn 2' }] },
    ],
  }
  const request = {
    provider: 'native',
    model,
    sessionId: 'count-test',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'u1' }] },
      { role: 'assistant', content: blocks1, source: { kind: 'model', provider: 'native', model, replayState: { response: replay1 } } },
      { role: 'user', content: [{ type: 'text', text: 'u2' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Plain turn 2' }], source: { kind: 'model', provider: 'native', model } },
    ],
  }

  const patched = patchGenerateContentBody(body, request, route)
  assert.equal(patched.totalModelTurns, 2)
  assert.equal(patched.replayedModelTurns, 1)
  assert.equal(patched.changed, true)

  const userOnly = patchGenerateContentBody({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }, { ...request, messages: [] }, route)
  assert.equal(userOnly.totalModelTurns, 0)
  assert.equal(userOnly.replayedModelTurns, 0)
})

test('geminiTransport reports url-mismatch, searchMode mixed/skipped, xhighApplied, saved/overflow, and ignores compaction', async t => {
  const handlers = new Map()
  const originalFetch = globalThis.fetch
  const recorded = []
  let routes = { native: { localizePrompt: false, nativeHistory: true, googleSearch: true } }
  let responseFactory = () => sse([frame([{ text: 'ok' }], 'STOP')])
  globalThis.fetch = async (input, init) => responseFactory(input, init)
  t.after(() => { globalThis.fetch = originalFetch })

  const sessionsService = { get: id => id === 'sess-1' ? { requestHeader: () => ({ config: { provider: 'native', model } }) } : undefined }
  let cleanup
  geminiTransport({
    get: name => name === 'sessions' ? sessionsService : undefined,
    loader: { resolve: () => ({ moduleNamespace: { isAgentLoopRequest: request => request.agent === true } }) },
    logger: { warn() {} },
    on: (event, fn) => handlers.set(event, fn),
    effect: start => { cleanup = start() },
  }, { routes: { get: () => routes } }, plugin.routeConfigOf, undefined, sessionId => sessionId === 'sess-1', (sessionId, snapshot) => {
    recorded.push({ sessionId, snapshot })
  })
  t.after(() => cleanup?.())

  const baseURL = 'https://gemini.test/v1beta'
  const declaration = { name: 'read_mock', description: 'Read', parameters: { type: 'object', properties: {} } }

  async function runCall({
    targetModel = model,
    targetBaseURL = baseURL,
    loop = true,
    purpose,
    body = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }], tools: [{ functionDeclarations: [declaration] }] },
  } = {}) {
    const request = Object.freeze({ provider: 'native', model: targetModel, sessionId: 'sess-1', agent: loop, purpose, messages: [] })
    const headers = new Headers({ 'content-length': '1' })
    const init = { method: 'POST', headers, signal: new AbortController().signal, body: JSON.stringify(body) }
    const input = `${targetBaseURL}/models/${targetModel}:streamGenerateContent?alt=sse`
    const stream = handlers.get('llm/stream')(request, async function* () {
      await Promise.resolve()
      handlers.get('llm-pi-ai/request-headers')({ ...request, baseURL: targetBaseURL }, headers, () => headers)
      const res = await globalThis.fetch(input, init)
      await res.text()
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    for await (const _chunk of stream) {}
  }

  // 1. url-mismatch when baseURL is non-HTTP(S).
  await runCall({ targetBaseURL: 'ftp://bad.host.test/v1beta' })
  assert.equal(recorded.length, 1)
  assert.deepEqual(recorded[0], {
    sessionId: 'sess-1',
    snapshot: {
      provider: 'native',
      model,
      status: 'url-mismatch',
      host: 'bad.host.test',
      totalHistoryTurns: null,
      replayedHistoryTurns: null,
      searchConfigured: true,
      searchInjected: false,
      searchMode: 'skipped',
      localToolCount: 0,
      xhighRequested: true,
      xhighApplied: false,
      thinkingLevel: null,
      recordedBytes: null,
      recordedFrames: null,
      recordStatus: null,
    },
  })

  // 2. nativeHistory + googleSearch (mixed) + xhighApplied -> outbound then saved inbound.
  recorded.length = 0
  await runCall()
  assert.equal(recorded.length, 2)
  assert.deepEqual(recorded[0].snapshot, {
    provider: 'native',
    model,
    status: 'ok',
    host: 'gemini.test',
    totalHistoryTurns: 0,
    replayedHistoryTurns: 0,
    searchConfigured: true,
    searchInjected: true,
    searchMode: 'mixed',
    localToolCount: 1,
    xhighRequested: true,
    xhighApplied: true,
    thinkingLevel: 'XHIGH',
    recordedBytes: null,
    recordedFrames: null,
    recordStatus: null,
  })
  assert.equal(recorded[1].snapshot.recordStatus, 'saved')
  assert.equal(recorded[1].snapshot.recordedFrames, 1)
  assert.ok(recorded[1].snapshot.recordedBytes > 0)

  // 3. nativeHistory overflow (> 2MB).
  recorded.length = 0
  const hugeText = 'x'.repeat(600 * 1024)
  responseFactory = () => sse([
    frame([{ text: hugeText }]),
    frame([{ text: hugeText }]),
    frame([{ text: hugeText }]),
    frame([{ text: hugeText }], 'STOP'),
  ])
  await runCall()
  assert.equal(recorded.length, 2)
  assert.equal(recorded[0].snapshot.recordStatus, null)
  assert.equal(recorded[1].snapshot.recordStatus, 'overflow')
  assert.equal(recorded[1].snapshot.recordedFrames, 0)
  assert.ok(recorded[1].snapshot.recordedBytes > 2 * 1024 * 1024)

  // 4. compaction must never overwrite main request telemetry.
  recorded.length = 0
  responseFactory = () => sse([frame([{ text: 'summary' }], 'STOP')])
  await runCall({ loop: false, purpose: 'compaction' })
  assert.equal(recorded.length, 0)

  // 5. googleSearch skipped (AUTO mode) without nativeHistory still emits telemetry.
  routes = { native: { localizePrompt: false, nativeHistory: false, googleSearch: true } }
  recorded.length = 0
  await runCall({
    body: {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      tools: [{ functionDeclarations: [declaration] }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    },
  })
  assert.equal(recorded.length, 1)
  assert.deepEqual(recorded[0].snapshot, {
    provider: 'native',
    model,
    status: 'ok',
    host: 'gemini.test',
    totalHistoryTurns: null,
    replayedHistoryTurns: null,
    searchConfigured: true,
    searchInjected: false,
    searchMode: 'skipped',
    localToolCount: 1,
    xhighRequested: true,
    xhighApplied: true,
    thinkingLevel: 'XHIGH',
    recordedBytes: null,
    recordedFrames: null,
    recordStatus: null,
  })
})
