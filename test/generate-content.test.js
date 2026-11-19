import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import * as plugin from '../index.js'
import { createGenerateContentAdapter } from '../generate-content-adapter.js'
import { nativeReplayOf, readNativeReplay } from '../generate-content.js'
import { nativeSearchProjection } from '../native-search-projection.js'

const model = 'gemini-4-hydrogen'
const routes = Object.fromEntries(['native', 'limited'].map(provider => [provider, {
  api: 'google-generative-ai', baseURL: `https://${provider}.test/v1beta`,
  apiKeyEnv: `${provider.toUpperCase()}_KEY`, search: provider === 'native' ? 'mixed' : 'search-only',
  models: [{ id: model }],
}]))
const tools = ['read_mock', 'web_search', 'web_fetch'].map(name => ({ name, description: name, parameters: { type: 'object' } }))
const user = text => ({ role: 'user', content: [{ type: 'text', text }] })
const result = block => ({ role: 'tool', toolCallId: block.id, content: [{ type: 'text', text: 'done' }] })
const query = 'DSH test query'
const parts = [
  { text: 'I will check. '.repeat(40), thoughtSignature: 'signature-1', futureField: { preserved: true } },
  { toolCall: { id: 'google-1', toolType: 'GOOGLE_SEARCH_WEB', args: { queries: [query] } }, thoughtSignature: 'signature-2' },
  { toolResponse: { id: 'google-1', toolType: 'GOOGLE_SEARCH_WEB', response: { sources: [{ uri: 'https://example.org/article', title: 'Example' }] } }, thoughtSignature: 'signature-3' },
  { opaquePart: ['unknown kind is still ordered'] },
  { functionCall: { id: 'read-1', name: 'read_mock', args: { path: 'a.txt' } }, thoughtSignature: 'signature-4' },
]
const frame = (parts, finishReason) => ({ candidates: [{ index: 0, content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }] })
const answer = frame([{ text: 'Done.' }], 'STOP')
const streamFrames = [frame(parts.slice(0, 2)), frame(parts.slice(2), 'STOP')]
function sse(frames) {
  const bytes = Buffer.from(frames.map(entry => `data: ${JSON.stringify(entry)}\r\n\r\n`).join(''))
  const body = new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 71) controller.enqueue(bytes.subarray(i, i + 71))
    controller.close()
  } })
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })
}

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}
const declarations = payload => payload.tools?.flatMap(tool => tool.functionDeclarations ?? []).map(tool => tool.name)
const request = (provider, messages, extra = {}) => ({ provider, model, tools, sessionId: 'offline', messages, ...extra })
const searchSummary = [{ status: 'completed', queries: [query], sources: [{ url: 'https://example.org/article', title: 'Example' }] }]

function fixture() {
  const requests = []
  const transport = async (input, init) => {
    const url = new URL(input)
    const body = JSON.parse(init.body)
    requests.push({ url, body, headers: new Headers(init.headers), redirect: init.redirect })
    return sse(url.hostname === 'native.test' && body.contents.length === 1 ? streamFrames : [answer])
  }
  return { requests, transport }
}

test('two opt-in routes share the wire implementation; raw frames and parts survive a JSON round trip', async () => {
  const { requests, transport } = fixture()
  const adapter = createGenerateContentAdapter(routes, { fetch: transport, resolveCredential: async ref => `mock-${ref}` })
  const prepared = await adapter.prepareCall('native', model)
  const ask = user('what happened?')
  const chunks = await collect(prepared.stream(request('native', [ask])))
  const finish = chunks.at(-1)
  assert.equal(finish.reason.kind, 'tool-calls')
  assert.equal(requests[0].url.href, `https://native.test/v1beta/models/${model}:streamGenerateContent?alt=sse`)
  assert.equal(requests[0].headers.get('x-goog-api-key'), 'mock-NATIVE_KEY')
  assert.equal(requests[0].redirect, 'error')
  assert.deepEqual(declarations(requests[0].body), ['read_mock', 'web_fetch'])
  assert.ok(requests[0].body.tools.some(tool => tool.googleSearch))
  assert.equal(requests[0].body.toolConfig.includeServerSideToolInvocations, true)
  assert.ok(!JSON.stringify(finish.replayState).includes('mock-NATIVE_KEY'))
  const content = chunks.flatMap(chunk => chunk.type === 'block-end' ? [chunk.block] : [])
  assert.ok(finish.replayState.response.refs.length > 0)
  assert.ok(!JSON.stringify(finish.replayState).includes(parts[0].text))
  assert.deepEqual(readNativeReplay(finish.replayState, content).frames.map(frame => frame[0].content.parts), [parts.slice(0, 2), parts.slice(2)])
  const calls = content.filter(block => block.type === 'tool-call')
  assert.deepEqual(calls.map(call => call.name), ['read_mock'])
  const assistant = { role: 'assistant', content, source: { kind: 'model', provider: 'native', model,
    replayState: JSON.parse(JSON.stringify(finish.replayState)) } }
  const restored = createGenerateContentAdapter(routes, { fetch: transport, resolveCredential: async () => 'other-key' })
  const run = await collect(restored.stream(request('native', [ask, assistant, result(calls[0])])))
  assert.equal(run.at(-1).reason.kind, 'stop')
  assert.deepEqual(requests[1].body.contents[1], { role: 'model', parts })
  assert.equal(requests[1].body.contents[2].parts[0].functionResponse.id, 'read-1')
  await collect(restored.stream(request('limited', [ask, assistant, result(calls[0])])))
  assert.equal(requests[2].url.hostname, 'limited.test')
  assert.deepEqual(declarations(requests[2].body), ['read_mock', 'web_search', 'web_fetch'])
  assert.ok(!requests[2].body.toolConfig)
  assert.ok(!requests[2].body.contents[1].parts.some(part => part.toolCall || part.thoughtSignature))
  await collect(restored.stream(request('native', [user('prefix changed'), assistant, result(calls[0])])))
  assert.ok(!requests[3].body.contents[1].parts.some(part => part.toolCall || part.thoughtSignature))
  await collect(restored.stream(request('limited', [ask], { tools: tools.filter(tool => tool.name === 'web_search') })))
  assert.deepEqual(requests[4].body.tools, [{ googleSearch: {} }])
  await collect(restored.stream(request('native', [ask], { purpose: 'session-title' })))
  assert.deepEqual(declarations(requests[5].body), ['read_mock', 'web_search', 'web_fetch'])
})

test('transport errors retain received evidence but never produce a successful replay state', async () => {
  const adapter = createGenerateContentAdapter(routes, {
    resolveCredential: async () => 'secret-key', fetch: async () => sse([streamFrames[0]]),
  })
  const chunks = await collect(adapter.stream(request('native', [user('offline')])))
  assert.equal(chunks.at(-1).reason.failure.code, 'TRANSPORT')
  assert.equal(chunks.at(-1).replayState.response.outcome, 'failed')
  assert.deepEqual(chunks.at(-1).replayState.response.frames[0][0].content.parts, parts.slice(0, 2))
  const view = nativeSearchProjection.apply({}, { type: 'assistant/attempt', data: { turn: 1,
    stream: [{ type: 'chunk', time: 1, chunk: chunks.at(-1) }],
  } })
  assert.deepEqual(view, { 1: [{ status: 'incomplete', queries: [query], sources: [] }] })
})

test('keeps alternative candidates in the record but never dispatches their functions', async () => {
  const other = { index: 1, content: { role: 'model', parts: [{ functionCall: { name: 'ignore_me' } }] }, finishReason: 'STOP' }
  const adapter = createGenerateContentAdapter(routes, {
    resolveCredential: async () => 'synthetic',
    fetch: async () => sse([{ candidates: [other] }, { candidates: [other, streamFrames[1].candidates[0]] }]),
  })
  const chunks = await collect(adapter.stream(request('native', [user('offline')])))
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    .map(chunk => chunk.block.name), ['read_mock'])
  assert.deepEqual(chunks.at(-1).replayState.response.frames[0], [other])
})

const installed = process.env.DSH_INSTALL_DIR
const localTool = {
  ...tools[0],
  output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
}

test('installed DSH runs one local function, persists native parts, and rebuilds the projection after reopening', { skip: !installed, timeout: 12000 }, async t => {
  const require = createRequire(join(installed, 'package.json'))
  const load = spec => import(pathToFileURL(require.resolve(`@deepseek-ai/${spec}`)).href)
  const { Context } = await load('cordis')
  const { LlmRuntime, createUserMessage } = await load('dsh-llm')
  const { AgentRegistry } = await load('dsh-agent')
  const { AgentLoop } = await load('dsh-agent-loop')
  const { ToolsService } = await load('dsh-tools')
  const { SystemPrompt } = await load('dsh-system-prompt')
  const { SessionStore } = await load('dsh-session')
  const { SessionProjectionRegistry } = await load('dsh-session-projection')
  const persistence = await load('dsh-session-persistence-jsonl')
  const executor = await load('dsh-tool-executor-native')
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-parts-'))
  const { requests, transport } = fixture()
  const original = globalThis.fetch
  globalThis.fetch = transport
  const pluginStacks = []
  t.after(async () => {
    globalThis.fetch = original
    for (const fibers of pluginStacks.reverse()) for (const fiber of fibers.reverse()) await fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  async function boot(config) {
    const ctx = new Context()
    const fibers = []
    pluginStacks.push(fibers)
    async function mount(mod, config) { const fiber = ctx.plugin(mod, config); fibers.push(fiber); await fiber }
    const privacy = {}
    ctx.provide('sessionLogDeepSeek', { registerExclusion(predicate) { privacy.exclude = predicate } })
    ctx.provide('credentials', { async resolve(ref) { return { value: `mock-${ref}` } } })
    for (const mod of [SessionStore, SessionProjectionRegistry]) await mount(mod)
    await mount(persistence, { root, compression: 'none' })
    for (const mod of [LlmRuntime, AgentRegistry, ToolsService, SystemPrompt, executor, AgentLoop]) await mount(mod)
    if (config) await mount(plugin, config)
    return { ctx, privacy }
  }
  const { ctx, privacy } = await boot({ generateContentRoutes: routes })
  assert.deepEqual(ctx.llm.listProviders().map(route => route.id).sort(), ['limited', 'native'])
  let calls = 0
  ctx.tools.register({ ...localTool, parameters: tools[0].parameters, execute() { calls++; return 'done' } })
  const agent = await ctx.agentLoop.create('native-parts-integration', { provider: 'native', model })
  assert.equal(privacy.exclude({ sessionId: agent.id }), false)
  agent.followup(createUserMessage({ content: user('test native history').content, source: { kind: 'user' } }))
  await agent.whenIdle()
  assert.equal(calls, 1, JSON.stringify({ requests: requests.map(item => item.body),
    events: agent.session.snapshotEvents().map(event => event.type === 'turn/end' ? event.data : event.type) }))
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[1].body.contents.find(message => message.role === 'model').parts, parts)
  assert.equal(await ctx.sessions.flush(agent.session), true)
  assert.equal(privacy.exclude({ sessionId: agent.id, purpose: 'session-title' }), true)
  const view = ctx.sessionProjections.snapshot(agent.session).values[nativeSearchProjection.key]
  assert.deepEqual(view, { 1: searchSummary })
  const fibers = pluginStacks.pop()
  for (const fiber of fibers.reverse()) await fiber.dispose()

  const { ctx: fresh, privacy: freshPrivacy } = await boot({})
  const stored = await fresh.sessionPersistence.open(agent.id, 'read')
  try {
    const record = await stored.read()
    const event = record.events.find(event => event.type === 'assistant/message')
    assert.ok(event.data.message.source.replayState.response.refs.length > 0)
    assert.deepEqual(nativeReplayOf(event).frames.flatMap(frame => frame[0].content.parts), parts)
    const session = fresh.sessions.prepare(agent.id, { meta: record.header, seed: record.events })
    assert.deepEqual(fresh.sessionProjections.snapshot(session).values[nativeSearchProjection.key], { 1: searchSummary })
    const dispose = fresh.sessions.enter(session)
    try {
      fresh.sessions.announce(session)
      assert.equal(freshPrivacy.exclude({ sessionId: agent.id }), true)
    } finally { dispose() }
  } finally { await stored.close() }
})
