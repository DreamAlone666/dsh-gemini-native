import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'

function createReactStub({ trackSubscriptions = false } = {}) {
  const unsubscribes = []
  let activeInstance = null

  function beginRender(instance) {
    activeInstance = instance
    if (instance) {
      instance.hookIndex = 0
    }
  }

  function endRender() {
    activeInstance = null
  }

  return {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat() }
    },
    useState(initial) {
      if (!activeInstance) {
        return [typeof initial === 'function' ? initial() : initial, () => {}]
      }
      const idx = activeInstance.hookIndex++
      if (!(idx in activeInstance.states)) {
        activeInstance.states[idx] = typeof initial === 'function' ? initial() : initial
      }
      const inst = activeInstance
      const setter = next => {
        inst.states[idx] = typeof next === 'function' ? next(inst.states[idx]) : next
      }
      return [activeInstance.states[idx], setter]
    },
    useRef(initial) {
      if (!activeInstance) return { current: initial }
      const idx = activeInstance.hookIndex++
      if (!(idx in activeInstance.refs)) {
        activeInstance.refs[idx] = { current: initial }
      }
      return activeInstance.refs[idx]
    },
    useEffect() {},
    useCallback(fn) {
      return fn
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      if (trackSubscriptions) {
        const idx = activeInstance ? activeInstance.hookIndex++ : -1
        if (activeInstance) {
          const prev = activeInstance.subs[idx]
          if (!prev) {
            const inst = activeInstance
            const unsub = subscribe(() => { inst.notified += 1 })
            inst.subs[idx] = { unsub }
            unsubscribes.push(unsub)
          }
        } else {
          const unsub = subscribe(() => {})
          unsubscribes.push(unsub)
        }
      }
      return getSnapshot()
    },
    __beginRender: beginRender,
    __endRender: endRender,
    __unsubscribes: unsubscribes,
  }
}

function findAll(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  if (Array.isArray(node.children)) findAll(node.children, predicate, out)
  return out
}

function renderTree(node) {
  if (!node || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(renderTree)
  if (typeof node.type === 'function') return renderTree(node.type(node.props))
  return { ...node, children: (node.children ?? []).map(renderTree) }
}

async function loadClient({
  configValue = { routes: {}, showStatusNotice: false },
  modelsValue = { providers: {} },
  modelsStatus = 'ready',
  directoryCurrent = { provider: 'google', model: 'gemini-4' },
  subagentSessions = new Set(),
  fetchImpl = null,
  trackSubscriptions = false,
} = {}) {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const React = createReactStub({ trackSubscriptions })
  let registeredModule
  const eventSources = []
  const fetchCalls = []
  const effectCleanups = []

  class MockEventSource {
    constructor(url) {
      this.url = url
      this.closed = false
      this.onmessage = null
      this.onerror = null
      eventSources.push(this)
    }
    emit(data) {
      this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) })
    }
    close() {
      this.closed = true
    }
  }

  async function mockFetch(url, options) {
    fetchCalls.push({ url, options })
    if (fetchImpl) return fetchImpl(url, options)
    const parsed = JSON.parse(options?.body ?? '{}')
    return {
      ok: true,
      status: 200,
      async json() { return { enabled: parsed.enabled === true } },
    }
  }

  const sandbox = {
    window: {
      location: { origin: 'http://localhost' },
      __ModuleLoader__: {
        load(mod) { registeredModule = mod },
      },
    },
    document: { baseURI: 'http://localhost/' },
    URL,
    Map,
    Set,
    Object,
    Array,
    JSON,
    Number,
    Promise,
    Error,
    EventSource: MockEventSource,
    fetch: mockFetch,
  }
  vm.runInNewContext(source, sandbox)
  assert.equal(registeredModule.id, 'dsh-gemini-enhancement')
  const plugin = registeredModule.factory(name => {
    assert.equal(name, 'react')
    return React
  })

  const mutations = []
  const slots = new Map()
  let locales = {}
  let currentModelsStatus = modelsStatus
  let currentDirectory = directoryCurrent
  const makeForm = (ns, getValue, getStatus = () => 'ready') => ({
    subscribe: () => () => {},
    getSnapshot: () => ({ status: getStatus(), writable: true, revision: 7, value: getValue() }),
    async mutate(ops, revision) {
      mutations.push({ ns, ops, revision })
      return true
    },
  })
  const ctx = {
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') effectCleanups.push(cleanup)
    },
    locale: { register(ns, dicts) { locales = { ns, dicts }; return () => {} } },
    configForms: {
      get(ns) {
        if (ns === 'dsh-gemini-enhancement') return makeForm(ns, () => configValue)
        if (ns === 'llm-pi-ai') return makeForm(ns, () => modelsValue, () => currentModelsStatus)
        throw new Error(`unexpected form ${ns}`)
      },
    },
    slots: {
      inject(_name, fn) { fn(); return () => {} },
      register(meta, render) {
        slots.set(`${meta.name}:${meta.key ?? meta.id}`, { meta, render })
        return () => {}
      },
    },
    inject(_deps, fn) {
      const sessions = {
        subagentAddress(sessionId) {
          return subagentSessions.has(sessionId) ? { mode: 'continuable' } : undefined
        },
      }
      fn({
        modelDirectories: {
          directoryFor() {
            return { store: { subscribe: () => () => {}, getSnapshot: () => ({ current: currentDirectory }) } }
          },
        },
        sessions,
        get(key) { return key === 'sessions' ? sessions : undefined },
        slots: ctx.slots,
      })
    },
  }
  plugin.apply(ctx)
  const t = key => locales.dicts.zh[key] ?? key
  return {
    React,
    slots,
    mutations,
    eventSources,
    fetchCalls,
    t,
    setConfig(v) { configValue = v },
    setModels(v) { modelsValue = v },
    setModelsStatus(s) { currentModelsStatus = s },
    setDirectoryCurrent(v) { currentDirectory = v },
    disposeEffects() {
      for (const cleanup of effectCleanups) cleanup()
    },
  }
}

test('settings.models.provider-card renders in-place toggles only for eligible Gemini routes and links search -> nativeHistory', async () => {
  const env = await loadClient({
    configValue: { routes: {}, showStatusNotice: false },
    modelsValue: {
      providers: {
        'my-gemini': { api: 'google-generative-ai', baseURL: 'https://relay.test/v1beta', models: [{ id: 'gemini-4' }] },
        'my-openai': { api: 'openai-completions', baseURL: 'https://openai.test/v1', models: [{ id: 'gpt-5' }] },
      },
    },
  })
  const card = env.slots.get('settings.models.provider-card:llm-pi-ai')
  assert.ok(card, 'provider-card slot should be registered under llm-pi-ai')

  // Non-Gemini provider renders nothing.
  assert.equal(renderTree(card.render({ provider: { provider: 'my-openai' }, configured: true, t: env.t })), null)

  // Unconfigured draft Google catalog card renders nothing until configured.
  assert.equal(renderTree(card.render({ provider: { provider: 'google' }, configured: false, t: env.t })), null)

  // Built-in google without explicit override entry still renders once configured.
  const googleTree = renderTree(card.render({ provider: { provider: 'google' }, configured: true, t: env.t }))
  const googleCheckboxes = findAll(googleTree, node => node.type === 'input' && node.props.type === 'checkbox')
  assert.equal(googleCheckboxes.length, 3)

  const plain = value => JSON.parse(JSON.stringify(value))

  // Custom Gemini provider renders 3 flat checkboxes; enabling Google Search auto-enables nativeHistory.
  const geminiTree = renderTree(card.render({ provider: { provider: 'my-gemini' }, configured: true, t: env.t }))
  const checkboxes = findAll(geminiTree, node => node.type === 'input' && node.props.type === 'checkbox')
  assert.equal(checkboxes.length, 3)
  checkboxes[2].props.onChange({ target: { checked: true } })
  assert.deepEqual(plain(env.mutations.at(-1)), {
    ns: 'dsh-gemini-enhancement',
    revision: 7,
    ops: [{ op: 'set', path: ['routes', 'my-gemini'], value: { localizePrompt: false, nativeHistory: true, googleSearch: true } }],
  })

  // Unchecking the last enabled toggle unsets the provider entry cleanly.
  env.setConfig({ routes: { 'my-gemini': { localizePrompt: true, nativeHistory: false, googleSearch: false } }, showStatusNotice: false })
  const enabledTree = renderTree(card.render({ provider: { provider: 'my-gemini' }, configured: true, t: env.t }))
  const enabledCheckboxes = findAll(enabledTree, node => node.type === 'input' && node.props.type === 'checkbox')
  enabledCheckboxes[0].props.onChange({ target: { checked: false } })
  assert.deepEqual(plain(env.mutations.at(-1)), {
    ns: 'dsh-gemini-enhancement',
    revision: 7,
    ops: [{ op: 'unset', path: ['routes', 'my-gemini'] }],
  })

  // Provider switched away from Gemini API with leftover saved enhancements offers a Clear action.
  env.setConfig({ routes: { 'my-openai': { localizePrompt: true, nativeHistory: false, googleSearch: false } }, showStatusNotice: false })
  const staleTree = renderTree(card.render({ provider: { provider: 'my-openai' }, configured: true, t: env.t }))
  const clearButtons = findAll(staleTree, node => node.type === 'button')
  assert.equal(clearButtons.length, 1)
  clearButtons[0].props.onClick()
  assert.deepEqual(plain(env.mutations.at(-1)), {
    ns: 'dsh-gemini-enhancement',
    revision: 7,
    ops: [{ op: 'unset', path: ['routes', 'my-openai'] }],
  })
})

test('composer status notice reflects per-provider active enhancements and turnTail extracts turn.turn', async () => {
  const env = await loadClient({
    configValue: {
      routes: { google: { localizePrompt: false, nativeHistory: true, googleSearch: true } },
      showStatusNotice: true,
    },
  })
  const noticeSlot = env.slots.get('conversation.composer.dock:dsh-gemini-enhancement-notice')
  const rendered = renderTree(noticeSlot.render({
    sessionId: 'sess-1',
    useProjection: () => 'google',
    t: env.t,
  }))
  const texts = findAll(rendered, node => node.type === 'span' && typeof node.children?.[0] === 'string')
  assert.ok(texts.some(node => node.children[0] === '原生历史 · Google 搜索'))

  const turnSlot = env.slots.get('conversation.chat.turnTail:dsh-gemini-enhancement-search-cards')
  const durableCard = { status: 'completed', queries: ['q1'], sources: [] }
  const cardTree = renderTree(turnSlot.render({
    sessionId: 'sess-1',
    turn: { turn: 3 },
    useProjection: (_key, select) => select({ 3: [durableCard] }),
    t: env.t,
  }))
  assert.ok(cardTree !== null)
  const listItems = findAll(cardTree, node => node.type === 'li')
  assert.equal(listItems[0].children[0], 'q1')
})

test('conversation.input.right xhigh toggle visibility across Gemini routes, models, efforts, and fallback store', async () => {
  const env = await loadClient({
    modelsValue: {
      providers: {
        'my-gemini': {
          api: 'google-generative-ai',
          baseURL: 'https://relay.test/v1beta',
          models: [{ id: 'gemini-4-neon' }, { id: 'gemini-4-hydrogen' }, { id: 'gemini-4-argon' }],
        },
        'my-openai': {
          api: 'openai-completions',
          baseURL: 'https://openai.test/v1',
          models: [{ id: 'gemini-4-neon' }, { id: 'gpt-5' }],
        },
      },
    },
    directoryCurrent: { provider: 'google', model: 'gemini-4-neon' },
    subagentSessions: new Set(['sub-addressed']),
  })

  const xhighSlot = env.slots.get('conversation.input.right:dsh-gemini-enhancement-xhigh')
  assert.ok(xhighSlot, 'xhigh slot should be registered under conversation.input.right')
  assert.equal(xhighSlot.meta.order, 100)
  assert.equal(xhighSlot.meta.locale, 'dshGeminiEnhancement')

  const renderFor = ({ sessionId = 'sess-1', selection, includeStore = true, sessionSnap, sessionsState }) => {
    const injected = includeStore ? xhighSlot.meta.inject(sessionId) : {}
    return renderTree(xhighSlot.render({
      sessionId,
      useProjection: (_key, select) => select(selection ? { next: selection } : undefined),
      useSession: select => select(sessionSnap),
      useSessions: select => select(sessionsState),
      t: env.t,
      ...injected,
    }))
  }

  // Visible for Gemini API + Neon/Hydrogen regardless of native reasoning effort (low / medium / high / unset).
  for (const selection of [
    { provider: 'google', model: 'gemini-4-neon', reasoningEffort: 'low' },
    { provider: 'google', model: 'gemini-4-neon', reasoningEffort: 'medium' },
    { provider: 'google', model: 'gemini-4-neon', reasoningEffort: 'high' },
    { provider: 'google', model: 'gemini-4-neon' },
    { provider: 'google', model: 'models/gemini-4-neon-preview', reasoningEffort: 'low' },
    { provider: 'my-gemini', model: 'gemini-4-hydrogen', reasoningEffort: 'medium' },
    { provider: 'my-gemini', model: 'gemini-4-hydrogen@2026', reasoningEffort: 'high' },
    { provider: 'my-gemini', model: 'gemini-4-hydrogen' },
  ]) {
    const tree = renderFor({ selection })
    assert.ok(tree !== null, `expected toggle to render for ${JSON.stringify(selection)}`)
    assert.equal(tree.type, 'button')
    assert.equal(tree.props.type, 'button')
    assert.equal(tree.props['aria-pressed'], false)
    const labelSpan = findAll(tree, node => node.type === 'span' && node.children?.[0] === 'XHigh')
    assert.equal(labelSpan.length, 1)
  }

  // Falls back to modelStore.current when modelSelection projection is empty (new chat default).
  const fallbackTree = renderFor({ selection: undefined })
  assert.ok(fallbackTree !== null && fallbackTree.type === 'button')

  // Hidden for non-Neon/Hydrogen models, non-Gemini routes, and missing sessionId.
  for (const selection of [
    { provider: 'google', model: 'gemini-4-argon', reasoningEffort: 'high' },
    { provider: 'google', model: 'gemini-4-carbon', reasoningEffort: 'high' },
    { provider: 'google', model: 'gemini-4-neonx', reasoningEffort: 'high' },
    { provider: 'my-gemini', model: 'gemini-4-argon' },
    { provider: 'my-openai', model: 'gemini-4-neon', reasoningEffort: 'high' },
    { provider: 'my-openai', model: 'gemini-4-hydrogen' },
  ]) {
    assert.equal(renderFor({ selection }), null, `expected null for ${JSON.stringify(selection)}`)
  }
  assert.equal(renderFor({ sessionId: '', selection: { provider: 'google', model: 'gemini-4-neon' } }), null)

  // Hidden wherever the model selector itself is hidden (addressed/snapshot/listed subagent sessions).
  const neon = { provider: 'google', model: 'gemini-4-neon', reasoningEffort: 'high' }
  assert.equal(renderFor({ sessionId: 'sub-addressed', selection: neon }), null)
  assert.equal(renderFor({ selection: neon, sessionSnap: { subagent: { address: { mode: 'continuable' } } } }), null)
  assert.equal(renderFor({ selection: neon, sessionsState: { byId: { 'sess-1': { origin: 'subagent' } } } }), null)

  // Disabled when the session is removed (matching ModelSelect's locked state).
  const removedBtn = renderFor({ selection: neon, sessionSnap: { subagent: null, removed: true } })
  assert.ok(removedBtn !== null && removedBtn.type === 'button')
  assert.equal(removedBtn.props.disabled, true)

  // When models form is not ready, allow built-in google only and reject non-google routes.
  env.setModelsStatus('loading')
  assert.ok(renderFor({ selection: { provider: 'google', model: 'gemini-4-neon' } }) !== null)
  assert.equal(renderFor({ selection: { provider: 'my-openai', model: 'gemini-4-neon' } }), null)
  assert.equal(renderFor({ selection: { provider: 'my-gemini', model: 'gemini-4-neon' } }), null)
})

test('conversation.input.right xhigh toggle syncs via SSE, posts toggle without mutating modelSelection, guards busy, and cleans up EventSource', async () => {
  let pendingResolve = null
  let failNext = false
  const env = await loadClient({
    trackSubscriptions: true,
    modelsValue: {
      providers: {
        'my-gemini': {
          api: 'google-generative-ai',
          baseURL: 'https://relay.test/v1beta',
          models: [{ id: 'gemini-4-neon' }],
        },
      },
    },
    fetchImpl: async (_url, options) => {
      if (failNext) {
        failNext = false
        throw new Error('network error')
      }
      const body = JSON.parse(options.body)
      if (pendingResolve) {
        await new Promise(resolve => { pendingResolve = resolve })
      }
      return {
        ok: true,
        status: 200,
        async json() { return { enabled: body.enabled === true } },
      }
    },
  })

  const xhighSlot = env.slots.get('conversation.input.right:dsh-gemini-enhancement-xhigh')
  const instance = { hookIndex: 0, states: {}, refs: {}, subs: {}, notified: 0 }
  const modelSelectionChanges = []
  const injected = xhighSlot.meta.inject('sess-xhigh')

  const renderToggle = () => {
    env.React.__beginRender(instance)
    try {
      return renderTree(xhighSlot.render({
        sessionId: 'sess-xhigh',
        useProjection: (key, select) => {
          assert.equal(key, 'modelSelection')
          return select({ next: { provider: 'my-gemini', model: 'gemini-4-neon', reasoningEffort: 'low' } })
        },
        setModelSelection: () => { modelSelectionChanges.push('called') },
        t: env.t,
        ...injected,
      }))
    } finally {
      env.React.__endRender()
    }
  }

  // Initial render opens SSE stream for sess-xhigh and renders off state.
  let btn = renderToggle()
  assert.equal(btn.type, 'button')
  assert.equal(btn.props['aria-pressed'], false)
  assert.equal(btn.props.title, '在当前会话将推理等级覆盖为 XHigh（Neon / Hydrogen），不改变原生档位')
  assert.equal(env.eventSources.length, 1)
  assert.equal(env.eventSources[0].url, 'http://localhost/api/dsh-gemini-enhancement/xhigh?sessionId=sess-xhigh')

  // onMouseDown prevents stealing composer input focus.
  let prevented = false
  btn.props.onMouseDown({ preventDefault() { prevented = true } })
  assert.equal(prevented, true)

  // SSE push {"enabled":true} updates aria-pressed, title, and active styling.
  env.eventSources[0].emit({ enabled: true })
  assert.ok(instance.notified >= 1)
  btn = renderToggle()
  assert.equal(btn.props['aria-pressed'], true)
  assert.equal(btn.props.title, '当前会话已开启 XHigh（覆盖当前所选档位），点击恢复原档位')
  assert.equal(btn.props.style.background, 'var(--dsw-alias-state-business-tertiary)')
  assert.equal(btn.props.style.color, 'var(--dsw-alias-state-business-primary)')

  // SSE push {"enabled":false} (e.g., Host auto-disabled after switching model/effort) restores off state.
  env.eventSources[0].emit({ enabled: false })
  btn = renderToggle()
  assert.equal(btn.props['aria-pressed'], false)

  // Clicking when off sends POST ./api/dsh-gemini-enhancement/xhigh with {sessionId, enabled: true}.
  await btn.props.onClick()
  assert.equal(env.fetchCalls.length, 1)
  assert.equal(env.fetchCalls[0].url, 'http://localhost/api/dsh-gemini-enhancement/xhigh')
  assert.equal(env.fetchCalls[0].options.method, 'POST')
  assert.deepEqual(JSON.parse(JSON.stringify(env.fetchCalls[0].options.headers)), { 'Content-Type': 'application/json' })
  assert.deepEqual(JSON.parse(env.fetchCalls[0].options.body), { sessionId: 'sess-xhigh', enabled: true })
  assert.equal(env.mutations.length, 0)
  assert.equal(modelSelectionChanges.length, 0)

  btn = renderToggle()
  assert.equal(btn.props['aria-pressed'], true)

  // Busy guard prevents duplicate POST while a toggle request is in-flight.
  pendingResolve = () => {}
  const firstClick = btn.props.onClick()
  const secondClick = btn.props.onClick()
  assert.equal(env.fetchCalls.length, 2, 'second click while busy must be ignored')
  assert.deepEqual(JSON.parse(env.fetchCalls[1].options.body), { sessionId: 'sess-xhigh', enabled: false })
  pendingResolve()
  pendingResolve = null
  await Promise.all([firstClick, secondClick])

  btn = renderToggle()
  assert.equal(btn.props['aria-pressed'], false)

  // POST network failure silently preserves current state without throwing.
  failNext = true
  await btn.props.onClick()
  btn = renderToggle()
  assert.equal(btn.props['aria-pressed'], false)
  assert.equal(env.mutations.length, 0)
  assert.equal(modelSelectionChanges.length, 0)

  // Disposing plugin effects closes all EventSource streams cleanly.
  assert.equal(env.eventSources[0].closed, false)
  env.disposeEffects()
  assert.equal(env.eventSources[0].closed, true)
  assert.equal(env.eventSources[0].onmessage, null)
  assert.equal(env.eventSources[0].onerror, null)
})
