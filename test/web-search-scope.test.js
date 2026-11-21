import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import * as plugin from '../src/index.js'
import { webSearchScope } from '../src/web-search-scope.js'

const installed = process.env.DSH_INSTALL_DIR
const bundleId = 'dsh-gemini-native'

function makeHarness(initialRoutes = {}) {
  let routes = initialRoutes
  const profiles = Object.fromEntries(Object.keys(routes).map(id => [id, { api: 'google-generative-ai' }]))
  const ctxHandlers = new Map()
  const childHandlers = new Map()
  const piAiHandlers = new Map()
  const cleanups = []
  const agents = []
  let hasGlobalWebSearch = true
  let restrictThrows = false

  function emitOn(map, event, ...args) {
    for (const fn of [...(map.get(event) ?? [])]) {
      fn(...args)
    }
  }

  function register(map, event, fn) {
    const list = map.get(event) ?? []
    list.push(fn)
    map.set(event, list)
    return () => {
      const idx = list.indexOf(fn)
      if (idx >= 0) list.splice(idx, 1)
    }
  }

  function makeAgent(id, provider) {
    let currentProvider = provider
    let restrictedCount = 0
    const agent = {
      id,
      session: { id: `session-${id}` },
      options: { provider },
      model: {
        current: () => ({ provider: currentProvider }),
        setProvider: next => { currentProvider = next },
      },
      ctx: {
        tools: {
          restrict(filter) {
            if (restrictThrows) throw new Error('cannot restrict own-layer tool')
            assert.deepEqual(filter, { deny: ['web_search'] })
            restrictedCount += 1
            emitOn(childHandlers, 'tools/change')
            return () => {
              restrictedCount = Math.max(0, restrictedCount - 1)
              emitOn(childHandlers, 'tools/change')
            }
          },
        },
      },
      isRestricted: () => restrictedCount > 0,
      restrictedCount: () => restrictedCount,
    }
    return agent
  }

  const ctx = {
    on(event, fn) {
      return register(ctxHandlers, event, fn)
    },
  }

  const llm = {
    listProviders: () => Object.keys(profiles).map(id => ({ id })),
    listConfigurableProviders: () => Object.keys(profiles).map(provider => ({
      provider, settingsNs: 'llm-pi-ai', declared: provider !== 'google',
    })),
  }
  const loader = { *entries() {
    yield {
      options: { id: 'llm-pi-ai' },
      moduleNamespace: { name: 'llm-pi-ai' },
      fiber: {
        uid: 1,
        effectiveConfig: { providers: { get: () => profiles } },
        ctx: { on: (event, fn) => register(piAiHandlers, event, fn) },
      },
    }
  } }
  const child = {
    llm,
    loader,
    get: name => ({ llm, loader })[name],
    agents: {
      list: () => [...agents],
      get: id => agents.find(a => a.id === id || a.session.id === id),
    },
    tools: {
      get: (name, agent) => {
        if (name !== 'web_search') return { name }
        if (!hasGlobalWebSearch) return undefined
        return agent?.isRestricted() ? undefined : { name: 'web_search' }
      },
    },
    on(event, fn) {
      return register(childHandlers, event, fn)
    },
    effect(start) {
      const dispose = start()
      if (typeof dispose === 'function') cleanups.push(dispose)
    },
  }

  return {
    ctx,
    child,
    makeAgent,
    addAgent: agent => agents.push(agent),
    removeAgent: agent => {
      const idx = agents.indexOf(agent)
      if (idx >= 0) agents.splice(idx, 1)
    },
    emit: (event, ...args) => emitOn(childHandlers, event, ...args),
    emitCtx: (event, ...args) => emitOn(ctxHandlers, event, ...args),
    emitPiAiUpdate: () => emitOn(piAiHandlers, 'loader/volatile-update'),
    setRoutes: next => { routes = next },
    setProviderProfile: (id, profile) => { profiles[id] = profile },
    setHasGlobalWebSearch: value => { hasGlobalWebSearch = value },
    setRestrictThrows: value => { restrictThrows = value },
    dispose: () => {
      for (const fn of cleanups.splice(0)) fn()
    },
    runPreExecute: (exec) => {
      const list = childHandlers.get('tools/pre-execute') ?? []
      let index = 0
      const next = () => {
        const fn = list[index++]
        if (!fn) return Promise.resolve({ kind: 'allow' })
        return fn(exec, next)
      }
      return next()
    },
    config: { routes: { get: () => routes } },
  }
}

test('webSearchScope syncs live agents, lifecycle events, re-entrancy, volatile updates on ctx, and unload restoration', () => {
  const h = makeHarness({
    geminiSearch: { localizePrompt: false, nativeHistory: false, googleSearch: true },
    geminiPlain: { localizePrompt: false, nativeHistory: false, googleSearch: false },
  })
  const liveA = h.makeAgent('a', 'geminiSearch')
  const liveB = h.makeAgent('b', 'geminiPlain')
  h.addAgent(liveA)
  h.addAgent(liveB)

  webSearchScope(h.ctx, h.child, h.config, plugin.routeConfigOf)

  // Already-live agents synced on activation
  assert.equal(liveA.isRestricted(), true)
  assert.equal(liveA.restrictedCount(), 1)
  assert.equal(liveB.isRestricted(), false)

  // Newly created agent
  const createdC = h.makeAgent('c', 'geminiSearch')
  h.addAgent(createdC)
  h.emit('agent/created', { agent: createdC })
  assert.equal(createdC.isRestricted(), true)
  assert.equal(createdC.restrictedCount(), 1)

  // Model switch via session/event
  h.emit('session/event', liveB.session, { type: 'model/selection', data: { provider: 'geminiSearch' } })
  assert.equal(liveB.isRestricted(), true)
  h.emit('session/event', liveB.session, { type: 'model/selection', data: { provider: 'geminiPlain' } })
  assert.equal(liveB.isRestricted(), false)

  // tools/change re-entrancy safety (must not double-restrict)
  h.emit('tools/change')
  assert.equal(liveA.restrictedCount(), 1)
  assert.equal(createdC.restrictedCount(), 1)

  // Same provider stays selected; a volatile edit on the pi-ai fiber lifts the restriction.
  h.setProviderProfile('geminiSearch', { api: 'openai-completions' })
  h.emitPiAiUpdate()
  assert.equal(liveA.isRestricted(), false)
  assert.equal(createdC.isRestricted(), false)
  h.setProviderProfile('geminiSearch', { api: 'google-generative-ai' })
  h.emitPiAiUpdate()
  assert.equal(liveA.restrictedCount(), 1)
  assert.equal(createdC.restrictedCount(), 1)

  // Live volatile config update arrives on plugin ctx (not child fiber)
  h.setRoutes({
    geminiSearch: { localizePrompt: false, nativeHistory: false, googleSearch: false },
    geminiPlain: { localizePrompt: false, nativeHistory: false, googleSearch: true },
  })
  h.emitCtx('loader/volatile-update')
  assert.equal(liveA.isRestricted(), false)
  assert.equal(liveB.isRestricted(), true)
  assert.equal(createdC.isRestricted(), false)

  // Agent disposal cleans up
  h.removeAgent(liveB)
  h.emit('agent/disposed', { agent: liveB })
  assert.equal(liveB.isRestricted(), false)

  // Re-enable on geminiSearch and verify plugin unload restores all still-live agents
  h.setRoutes({
    geminiSearch: { localizePrompt: false, nativeHistory: false, googleSearch: true },
  })
  h.emitCtx('loader/volatile-update')
  assert.equal(liveA.isRestricted(), true)
  assert.equal(createdC.isRestricted(), true)

  h.dispose()
  assert.equal(liveA.isRestricted(), false)
  assert.equal(createdC.isRestricted(), false)
})

test('webSearchScope safely no-ops when web_search is absent or own-layer, and denies via tools/pre-execute', async () => {
  const h = makeHarness({
    geminiSearch: { localizePrompt: false, nativeHistory: false, googleSearch: true },
    geminiPlain: { localizePrompt: false, nativeHistory: false, googleSearch: false },
  })
  h.setHasGlobalWebSearch(false)
  const agent = h.makeAgent('a', 'geminiSearch')
  h.addAgent(agent)

  webSearchScope(h.ctx, h.child, h.config, plugin.routeConfigOf)
  assert.equal(agent.isRestricted(), false)

  // Own-layer web_search: tools.get returns it, restrict() throws, must not crash
  h.setHasGlobalWebSearch(true)
  h.setRestrictThrows(true)
  assert.doesNotThrow(() => h.emit('tools/change'))
  assert.equal(agent.isRestricted(), false)

  // Defense-in-depth tools/pre-execute denies web_search (exec.name) on googleSearch: true, allows web_fetch & non-search routes
  const denied = await h.runPreExecute({ name: 'web_search', agent })
  assert.equal(denied.kind, 'deny')

  const allowedFetch = await h.runPreExecute({ name: 'web_fetch', agent })
  assert.equal(allowedFetch.kind, 'allow')

  agent.model.setProvider('geminiPlain')
  const allowedPlain = await h.runPreExecute({ name: 'web_search', agent })
  assert.equal(allowedPlain.kind, 'allow')

  h.dispose()
})

test('installed DSH PTC: switching the same provider protocol and removing it restore web_search',
  { skip: !installed, timeout: 12000 }, async t => {
    const req = createRequire(join(installed, 'package.json'))
    const load = spec => import(pathToFileURL(req.resolve(`@deepseek-ai/${spec}`)).href)
    const { Context } = await load('cordis')
    const { Loader } = await load('cordis-plugin-loader')
    const { createUserMessage } = await load('dsh-llm')
    const pi = await load('dsh-llm-pi-ai')
    const { AgentRegistry, assembleContextFor } = await load('dsh-agent')
    const { AgentLoop } = await load('dsh-agent-loop')
    const { ToolsService } = await load('dsh-tools')
    const { SystemPrompt, renderPrompt } = await load('dsh-system-prompt')
    const { SessionStore } = await load('dsh-session')
    const { SessionProjectionRegistry } = await load('dsh-session-projection')
    const persistence = await load('dsh-session-persistence-jsonl')
    const { WebRuntime } = await load('dsh-web')
    const toolWeb = await load('dsh-tool-web')
    const ptcExecutor = await load('dsh-tool-executor-ptc')

    const tempDir = await mkdtemp(join(tmpdir(), 'dsh-gemini-native-ptc-'))
    const originalFetch = globalThis.fetch
    const fibers = []
    let loader
    const requests = []
    let dshSearchCalls = 0
    let stepIndex = 0

    function sseReply(parts) {
      const payload = `data: ${JSON.stringify({
        candidates: [{ index: 0, content: { role: 'model', parts }, finishReason: 'STOP' }],
      })}\r\n\r\n`
      return new Response(payload, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
    }

    globalThis.fetch = async (input, init) => {
      const body = JSON.parse(init.body)
      requests.push({ url: new URL(typeof input === 'string' ? input : input.url), body })
      stepIndex += 1
      if (stepIndex === 1) {
        // Turn 1 (gemini, googleSearch: true): try inspecting tools.web_search and calling tools.read_mock
        return sseReply([{
          functionCall: {
            id: 'ptc-1',
            name: 'run_code',
            args: {
              description: 'Check tools.web_search availability',
              code: [
                'const hasSearch = typeof tools.web_search === "function";',
                'const r = await tools.read_mock({ path: "a.txt" });',
                'return { hasSearch, r };',
              ].join('\n'),
            },
          },
        }])
      }
      if (stepIndex === 2) {
        return sseReply([{ text: 'done-turn-1' }])
      }
      if (stepIndex === 3) {
        // Turn 2 (plain, googleSearch: false): DSH tools.web_search should be available and callable
        return sseReply([{
          functionCall: {
            id: 'ptc-2',
            name: 'run_code',
            args: {
              description: 'Call DSH web_search on non-search route',
              code: 'return await tools.web_search({ queries: ["dsh"] });',
            },
          },
        }])
      }
      return sseReply([{ text: `done-step-${stepIndex}` }])
    }

    const ctx = new Context()
    t.after(async () => {
      globalThis.fetch = originalFetch
      await loader?.dispose()
      for (const fiber of fibers.reverse()) await fiber.dispose()
      await rm(tempDir, { recursive: true, force: true })
    })

    const configPath = join(tempDir, 'cordis.json')
    await writeFile(configPath, JSON.stringify([]))
    const llmURL = pathToFileURL(req.resolve('@deepseek-ai/dsh-llm')).href
    loader = ctx.plugin(class extends Loader { commit() {} }, { baseUrl: pathToFileURL(configPath).href })
    await loader
    ctx.loader.builtins.pi = pi
    ctx.loader.builtins[bundleId] = plugin

    ctx.provide('credentials', { async resolve(ref) { return { value: `mock-${ref}` } }, async readRecord() {} })
    ctx.provide('workingDirectory', {
      defaultDirectory: tempDir,
      get: () => tempDir,
      ensure: async () => tempDir,
      set: async (_agent, dir) => dir,
    })
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    ctx.provide('ptcRuntime', {
      language: 'typescript',
      programFormat: 'function-body',
      retainsState: false,
      executionInstructions: '',
      timeout: { defaultMs: 10_000, maxMs: 60_000 },
      resolve(spec) {
        return { ...spec, timeoutMs: 10_000 }
      },
      async run(spec) {
        const binding = spec.bindings?.[0]
        const toolsObj = Object.create(null)
        for (const [key, fn] of Object.entries(binding?.functions ?? {})) {
          Object.defineProperty(toolsObj, key, { enumerable: true, value: fn })
        }
        const errorName = binding?.errorClass?.name ?? 'ToolCallError'
        const memberName = binding?.errorClass?.memberNameProperty ?? 'toolName'
        const ToolCallError = class extends Error {
          constructor(toolName, message) {
            super(message)
            this.name = errorName
            this[memberName] = toolName
          }
        }
        try {
          const fn = new AsyncFunction(binding?.global ?? 'tools', errorName, spec.program)
          const value = await fn(toolsObj, ToolCallError)
          return { logs: [], ...(value === undefined ? {} : { value }) }
        } catch (error) {
          return { logs: [], error: { kind: 'runtime', message: error?.message ?? String(error) } }
        }
      },
      async release() {},
    })

    for (const mod of [SessionStore, SessionProjectionRegistry]) {
      const fiber = ctx.plugin(mod); fibers.push(fiber); await fiber
    }
    const persist = ctx.plugin(persistence, { root: tempDir, compression: 'none' }); fibers.push(persist); await persist
    await ctx.loader.create({ id: 'llm', name: llmURL })
    await ctx.loader.create({
      id: 'llm-pi-ai',
      name: 'cordis:pi',
      config: {
        providers: {
          gemini: {
            api: 'google-generative-ai',
            baseURL: 'https://gemini.test/v1beta',
            apiKeyEnv: 'GEMINI_KEY',
            models: [{ id: 'gemini-4-hydrogen' }],
          },
          plain: {
            api: 'google-generative-ai',
            baseURL: 'https://plain.test/v1beta',
            apiKeyEnv: 'PLAIN_KEY',
            models: [{ id: 'gemini-4-hydrogen' }],
          },
        },
      },
    })
    for (const mod of [AgentRegistry, ToolsService, SystemPrompt, WebRuntime, AgentLoop]) {
      const fiber = ctx.plugin(mod); fibers.push(fiber); await fiber
    }
    const webToolsFiber = ctx.plugin(toolWeb, { fetch: true }); fibers.push(webToolsFiber); await webToolsFiber
    ctx.web.registerSearchProvider({
      id: 'mock-search',
      available: () => true,
      ready: async () => true,
      async search({ query }) {
        dshSearchCalls += 1
        return { sources: [{ url: 'https://example.test/dsh', title: `Hit: ${query}` }], truncated: false }
      },
    })
    ctx.web.registerFetchProvider({
      id: 'mock-fetch',
      available: () => true,
      ready: async () => true,
      async fetch({ url }) {
        return { url, statusCode: 200, body: { kind: 'text', content: 'fetched' }, truncated: false }
      },
    })
    const ptcFiber = ctx.plugin(ptcExecutor, {}); fibers.push(ptcFiber); await ptcFiber

    ctx.tools.register({
      name: 'read_mock',
      description: 'Read mock file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
      execute: async ({ path }) => `file:${path}`,
    })

    await ctx.loader.create({
      id: bundleId,
      name: `cordis:${bundleId}`,
      config: {
        routes: {
          gemini: { localizePrompt: false, nativeHistory: false, googleSearch: true },
          plain: { localizePrompt: false, nativeHistory: false, googleSearch: false },
        },
      },
    })
    await ctx.loader.await()

    const agent = await ctx.agentLoop.create('ptc-scope-test', {
      provider: 'gemini',
      model: 'gemini-4-hydrogen',
    })

    // Turn 1: gemini (googleSearch: true) — web_search absent from tools:sdk, tool:web_search, and run_code
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Run PTC check' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    assert.equal(requests.length, 2)
    const req1 = requests[0].body
    const sys1 = req1.systemInstruction.parts.map(p => p.text).join('\n')
    assert.doesNotMatch(sys1, /\bweb_search\b/)
    assert.match(sys1, /\bread_mock\b/)
    assert.match(sys1, /\bweb_fetch\b/)
    assert.deepEqual(req1.tools.flatMap(tool => tool.functionDeclarations?.map(fn => fn.name) ?? []), ['run_code'])
    assert.equal(req1.tools.some(tool => Object.hasOwn(tool, 'googleSearch')), true)
    assert.equal(req1.toolConfig?.includeServerSideToolInvocations, true)

    const req2 = requests[1].body
    const fnResp1 = req2.contents.flatMap(c => c.parts ?? []).find(p => p.functionResponse?.name === 'run_code')
    assert.ok(fnResp1)
    assert.deepEqual(JSON.parse(fnResp1.functionResponse.response.output), { hasSearch: false, r: 'file:a.txt' })
    assert.equal(dshSearchCalls, 0)

    // Turn 2: switch to plain (googleSearch: false) — web_search returns to tools:sdk, tool:web_search, and run_code
    agent.model.select({ provider: 'plain', model: 'gemini-4-hydrogen' })
    assert.ok(ctx.tools.get('web_search', agent))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Use DSH search on plain' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    assert.equal(requests.length, 4)
    const req3 = requests[2].body
    const sys3 = req3.systemInstruction.parts.map(p => p.text).join('\n')
    assert.match(sys3, /\bweb_search\b/)
    assert.equal(req3.tools.some(tool => Object.hasOwn(tool, 'googleSearch')), false)
    const req4 = requests[3].body
    const fnResp2 = req4.contents.flatMap(c => c.parts ?? []).findLast(p => p.functionResponse?.name === 'run_code')
    assert.ok(fnResp2)
    assert.match(fnResp2.functionResponse.response.output, /Hit: dsh/)
    assert.equal(dshSearchCalls, 1)

    // Switch back to gemini (restricted again), then disable googleSearch live via real Loader volatile update
    agent.model.select({ provider: 'gemini', model: 'gemini-4-hydrogen' })
    assert.equal(ctx.tools.get('web_search', agent), undefined)

    await ctx.loader.update(bundleId, {
      config: {
        routes: {
          gemini: { localizePrompt: false, nativeHistory: false, googleSearch: false },
          plain: { localizePrompt: false, nativeHistory: false, googleSearch: false },
        },
      },
    })
    assert.ok(ctx.tools.get('web_search', agent))

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Check restored after volatile update' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    assert.equal(requests.length, 5)
    const req5 = requests[4].body
    const sys5 = req5.systemInstruction.parts.map(p => p.text).join('\n')
    assert.match(sys5, /\bweb_search\b/)
    assert.equal(req5.tools.some(tool => Object.hasOwn(tool, 'googleSearch')), false)

    // Keep the same agent and route id while the pi-ai profile changes API.
    await ctx.loader.update(bundleId, {
      config: { routes: { gemini: { localizePrompt: true, nativeHistory: false, googleSearch: true } } },
    })
    assert.equal(ctx.tools.get('web_search', agent), undefined)
    const signal = new AbortController().signal
    const selection = agent.model.current()
    const promptContext = { ...assembleContextFor(agent, signal), modelSelection: selection }
    assert.match(renderPrompt(await ctx.systemPrompt.assemble(promptContext)), /你是由 DeepSeek Harness/u)

    const { providers } = ctx.loader.resolve('llm-pi-ai').options.config
    await ctx.loader.update('llm-pi-ai', { config: { providers: {
      ...providers, gemini: { ...providers.gemini, api: 'openai-completions' },
    } } })
    assert.equal(agent.model.current().provider, selection.provider)
    assert.ok(ctx.tools.get('web_search', agent))
    const toolSet = await ctx.tools.resolve({ agent, modelSelection: selection, signal })
    try {
      const prompt = renderPrompt(await ctx.systemPrompt.assemble({ ...promptContext, toolSet }))
      assert.match(prompt, /You are an AI agent powered by DeepSeek Harness/u)
      assert.match(prompt, /\bweb_search\b/u)
      const restored = await ctx.tools.execute({ agent, signal, toolSet, calls: [{
        type: 'tool-call', id: 'call-ptc-protocol-change', name: 'run_code',
        arguments: JSON.stringify({
          description: 'Call local search on the same non-Gemini route',
          code: 'return await tools.web_search({ queries: ["same route"] });',
        }),
      }] })
      assert.equal(restored.results[0].result.isError, false)
      assert.equal(dshSearchCalls, 2)
      assert.equal(requests.length, 5, 'the protocol edit and PTC call have no model I/O')
    } finally {
      toolSet.dispose()
    }

    await ctx.loader.update('llm-pi-ai', { config: { providers } })
    assert.equal(ctx.tools.get('web_search', agent), undefined)
    await ctx.loader.update('llm-pi-ai', { config: { providers: { plain: providers.plain } } })
    assert.ok(ctx.tools.get('web_search', agent), 'withdrawing the route also removes the plugin restriction')
    await ctx.loader.update('llm-pi-ai', { config: { providers } })
    assert.equal(ctx.tools.get('web_search', agent), undefined)

    // Disabling the plugin restores web_search when the Gemini route still exists.
    await ctx.loader.update(bundleId, {
      config: {
        routes: {
          gemini: { localizePrompt: false, nativeHistory: false, googleSearch: true },
        },
      },
      disabled: true,
    })
    assert.ok(ctx.tools.get('web_search', agent))

    // Re-enable plugin and verify defense-in-depth tools/pre-execute blocks an agent.ctx-local web_search
    await ctx.loader.update(bundleId, {
      config: {
        routes: {
          gemini: { localizePrompt: false, nativeHistory: false, googleSearch: true },
        },
      },
      disabled: false,
    })
    const ownAgent = await ctx.agentLoop.create('ptc-own-layer-test', {
      provider: 'gemini',
      model: 'gemini-4-hydrogen',
    })
    let ownExecCalls = 0
    ownAgent.ctx.tools.register({
      name: 'web_search',
      description: 'Agent-local web_search override',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
      output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
      execute: async () => { ownExecCalls += 1; return 'should-not-run' },
    })
    const batchResult = await ctx.tools.execute({
      agent: ownAgent,
      signal: new AbortController().signal,
      calls: [{
        type: 'tool-call',
        id: 'call-ptc-own',
        name: 'run_code',
        arguments: JSON.stringify({
          description: 'Attempt agent-local tools.web_search',
          code: 'return await tools.web_search({ query: "blocked" });',
        }),
      }],
    })
    assert.equal(ownExecCalls, 0)
    assert.equal(batchResult.results[0].result.isError, true)
    assert.match(batchResult.results[0].result.error.message, /Google Search is enabled/)
  })
