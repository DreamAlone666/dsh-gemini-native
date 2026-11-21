import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import * as plugin from '../index.js'
import { hasNativeReplay, nativeReplayOf } from '../generate-content.js'
import { nativeSearchProjection } from '../native-search-projection.js'

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
