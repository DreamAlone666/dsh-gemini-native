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
      instance.pendingEffects = []
    }
  }

  function endRender() {
    activeInstance = null
  }

  function depsChanged(prev, next) {
    if (!prev || !next) return true
    if (prev.length !== next.length) return true
    for (let i = 0; i < prev.length; i++) {
      if (!Object.is(prev[i], next[i])) return true
    }
    return false
  }

  function flushEffects(instance) {
    if (!instance?.pendingEffects?.length) return
    const pending = instance.pendingEffects.splice(0)
    for (const item of pending) {
      const prev = instance.effects[item.idx]
      if (!prev || depsChanged(prev.deps, item.deps)) {
        if (typeof prev?.cleanup === 'function') prev.cleanup()
        const cleanup = item.fn()
        instance.effects[item.idx] = { deps: item.deps, cleanup }
      }
    }
  }

  function unmount(instance) {
    if (!instance) return
    for (const key of Object.keys(instance.effects ?? {})) {
      const cleanup = instance.effects[key]?.cleanup
      if (typeof cleanup === 'function') cleanup()
    }
    for (const key of Object.keys(instance.subs ?? {})) {
      instance.subs[key]?.unsub?.()
    }
  }

  function scheduleEffect(fn, deps) {
    if (!activeInstance) return
    const idx = activeInstance.hookIndex++
    activeInstance.pendingEffects.push({ idx, fn, deps })
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
    useId() {
      if (!activeInstance) return ':r0:'
      const idx = activeInstance.hookIndex++
      if (!(idx in activeInstance.ids)) {
        activeInstance.ids[idx] = `:r${idx}:`
      }
      return activeInstance.ids[idx]
    },
    useEffect(fn, deps) {
      scheduleEffect(fn, deps)
    },
    useLayoutEffect(fn, deps) {
      scheduleEffect(fn, deps)
    },
    useCallback(fn) {
      return fn
    },
    useMemo(fn) {
      return fn()
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
    __flushEffects: flushEffects,
    __unmount: unmount,
    __unsubscribes: unsubscribes,
  }
}

function createInstance() {
  return { hookIndex: 0, states: {}, refs: {}, subs: {}, ids: {}, effects: {}, pendingEffects: [], notified: 0 }
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

function collectText(node, out = []) {
  if (node == null || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, out)
    return out
  }
  if (typeof node === 'object' && Array.isArray(node.children)) {
    collectText(node.children, out)
  }
  return out
}

function renderTree(node) {
  if (!node || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(renderTree)
  if (typeof node.type === 'function') return renderTree(node.type(node.props))
  return { ...node, children: (node.children ?? []).map(renderTree) }
}

function createMockDocument() {
  const listeners = new Map()
  const makeNode = tagName => {
    const attrs = new Map()
    const node = {
      tagName,
      children: [],
      parentNode: null,
      textContent: '',
      dataset: {},
      setAttribute(name, value) { attrs.set(name, String(value)) },
      getAttribute(name) { return attrs.get(name) ?? null },
      appendChild(child) {
        child.parentNode = node
        node.children.push(child)
        return child
      },
      removeChild(child) {
        const idx = node.children.indexOf(child)
        if (idx >= 0) {
          node.children.splice(idx, 1)
          child.parentNode = null
        }
        return child
      },
      remove() {
        node.parentNode?.removeChild(node)
      },
      querySelector(selector) {
        const match = /^style\[data-plugin="([^"]+)"\]$/u.exec(selector)
        if (!match) return null
        return node.children.find(c => c.tagName === 'style' && (c.getAttribute('data-plugin') === match[1] || c.dataset?.plugin === match[1])) ?? null
      },
      contains(target) {
        return target === node
      },
    }
    return node
  }

  const head = makeNode('head')
  const body = makeNode('body')

  return {
    baseURI: 'http://localhost/',
    head,
    body,
    listeners,
    createElement(tag) {
      return makeNode(tag)
    },
    addEventListener(type, fn, capture = false) {
      const key = `${type}:${Boolean(capture)}`
      if (!listeners.has(key)) listeners.set(key, [])
      listeners.get(key).push({ type, fn, capture: Boolean(capture) })
    },
    removeEventListener(type, fn, capture = false) {
      const key = `${type}:${Boolean(capture)}`
      const list = listeners.get(key)
      if (!list) return
      listeners.set(key, list.filter(entry => entry.fn !== fn))
    },
    dispatch(type, event, { captureOnly = false } = {}) {
      for (const [key, list] of listeners) {
        if (!key.startsWith(`${type}:`)) continue
        const isCapture = key.endsWith(':true')
        if (captureOnly && !isCapture) continue
        for (const entry of [...list]) entry.fn(event)
      }
    },
  }
}

async function loadClient({
  configValue = { routes: {}, showStatusNotice: false },
  modelsValue = { providers: {} },
  modelsStatus = 'ready',
  directoryCurrent = { provider: 'google', model: 'gemini-4' },
  subagentSessions = new Set(),
  fetchImpl = null,
  trackSubscriptions = false,
  withDom = true,
  withReactDom = true,
  supportsAnchor = true,
} = {}) {
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const React = createReactStub({ trackSubscriptions })
  const PORTAL_TYPE = Symbol('Portal')
  const ReactDOM = withReactDom
    ? { createPortal: (node, target) => ({ type: PORTAL_TYPE, props: { target }, children: [node] }) }
    : null
  let registeredModule
  const eventSources = []
  const fetchCalls = []
  const effectCleanups = []
  const mockDocument = withDom ? createMockDocument() : { baseURI: 'http://localhost/' }
  const windowListeners = new Map()

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
      innerWidth: 1200,
      innerHeight: 800,
      addEventListener(type, fn) {
        if (!windowListeners.has(type)) windowListeners.set(type, new Set())
        windowListeners.get(type).add(fn)
      },
      removeEventListener(type, fn) {
        windowListeners.get(type)?.delete(fn)
      },
      __ModuleLoader__: {
        load(mod) { registeredModule = mod },
      },
    },
    document: mockDocument,
    CSS: supportsAnchor === null ? undefined : { supports: prop => supportsAnchor && prop === 'anchor-name' },
    URL,
    Map,
    Set,
    Object,
    Array,
    JSON,
    Number,
    String,
    Boolean,
    Math,
    Promise,
    Error,
    EventSource: MockEventSource,
    fetch: mockFetch,
  }
  vm.runInNewContext(source, sandbox)
  assert.equal(registeredModule.id, 'dsh-gemini-native')
  const plugin = registeredModule.factory(name => {
    if (name === 'react') return React
    if (name === 'react-dom') {
      if (!ReactDOM) throw new Error('react-dom unavailable')
      return ReactDOM
    }
    throw new Error(`unexpected require: ${name}`)
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
        if (ns === 'dsh-gemini-native') return makeForm(ns, () => configValue)
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
  const tEn = key => locales.dicts.en[key] ?? key
  return {
    React,
    PORTAL_TYPE,
    mockDocument,
    slots,
    mutations,
    eventSources,
    fetchCalls,
    t,
    tEn,
    setConfig(v) { configValue = v },
    setModels(v) { modelsValue = v },
    setModelsStatus(s) { currentModelsStatus = s },
    setDirectoryCurrent(v) { currentDirectory = v },
    disposeEffects() {
      for (const cleanup of effectCleanups) cleanup()
    },
  }
}

test('injects scoped .dsh-gn-* styles into document.head and cleans up on disposeEffects, while tolerating DOM-less environments', async () => {
  const env = await loadClient({ withDom: true })
  const styleNodes = env.mockDocument.head.children.filter(node => node.tagName === 'style')
  assert.equal(styleNodes.length, 1)
  assert.equal(styleNodes[0].getAttribute('data-plugin'), 'dsh-gemini-native')
  const css = styleNodes[0].textContent
  assert.ok(css.includes('.dsh-gn-dock-pill'))
  assert.ok(css.includes('.dsh-gn-diag-panel'))
  assert.ok(css.includes('.dsh-gn-xhigh-wrap'))
  assert.ok(css.includes('.dsh-gn-xhigh'))
  assert.ok(css.includes('.dsh-gn-xhigh-glyph'))
  assert.ok(css.includes('.dsh-gn-xhigh-error'))
  assert.ok(css.includes('.dsh-gn-model-opt-row'))
  assert.ok(css.includes('.dsh-gn-model-opt-switch'))
  assert.ok(css.includes('corner-shape: round'))
  assert.ok(css.includes('.dsh-gn-search-row'))
  assert.ok(css.includes('--dsw-alias-label-tertiary'))
  assert.ok(css.includes('--dsw-alias-state-business-tertiary'))
  assert.ok(css.includes('font-weight: 500'))
  assert.ok(css.includes('border: none'))

  env.disposeEffects()
  assert.equal(env.mockDocument.head.children.length, 0)

  // DOM-less test environment does not throw during apply or dispose.
  const domless = await loadClient({ withDom: false, withReactDom: false })
  domless.disposeEffects()
})

test('provider card defaults to native history, discloses log retention, and keeps Search and translation opt-in', async () => {
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

  // Native history (second checkbox) is on without a saved route. Both opt-ins are off.
  const geminiTree = renderTree(card.render({ provider: { provider: 'my-gemini' }, configured: true, t: env.t }))
  const checkboxes = findAll(geminiTree, node => node.type === 'input' && node.props.type === 'checkbox')
  assert.deepEqual(checkboxes.map(node => node.props.checked), [false, true, false])
  assert.match(collectText(geminiTree).join(' '), /默认开启.*会话日志.*不会清除/u)
  checkboxes[2].props.onChange({ target: { checked: true } })
  assert.deepEqual(plain(env.mutations.at(-1)), {
    ns: 'dsh-gemini-native',
    revision: 7,
    ops: [{ op: 'set', path: ['routes', 'my-gemini'], value: { localizePrompt: false, nativeHistory: true, googleSearch: true } }],
  })

  // Turning off the default writes an explicit false. Opting into Search must not undo it.
  const defaultTree = renderTree(card.render({ provider: { provider: 'my-gemini' }, configured: true, t: env.t }))
  findAll(defaultTree, node => node.type === 'input')[1].props.onChange({ target: { checked: false } })
  const disabledReplay = { localizePrompt: false, nativeHistory: false, googleSearch: false }
  assert.deepEqual(plain(env.mutations.at(-1)).ops, [{ op: 'set', path: ['routes', 'my-gemini'], value: disabledReplay }])
  env.setConfig({ routes: { 'my-gemini': disabledReplay } })
  const optedOutTree = renderTree(card.render({ provider: { provider: 'my-gemini' }, configured: true, t: env.t }))
  findAll(optedOutTree, node => node.type === 'input')[2].props.onChange({ target: { checked: true } })
  assert.deepEqual(plain(env.mutations.at(-1)).ops[0].value, { ...disabledReplay, googleSearch: true })

  // A route with all default values needs no override.
  env.setConfig({ routes: { 'my-gemini': { localizePrompt: true } } })
  const enabledTree = renderTree(card.render({ provider: { provider: 'my-gemini' }, configured: true, t: env.t }))
  const enabledCheckboxes = findAll(enabledTree, node => node.type === 'input' && node.props.type === 'checkbox')
  enabledCheckboxes[0].props.onChange({ target: { checked: false } })
  assert.deepEqual(plain(env.mutations.at(-1)), {
    ns: 'dsh-gemini-native',
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
    ns: 'dsh-gemini-native',
    revision: 7,
    ops: [{ op: 'unset', path: ['routes', 'my-openai'] }],
  })
})

test('NativeStatusNotice pill uses StatsPills classes, opens portaled diagnostics card with status SSE and projection, and surfaces warnings scoped by provider', async () => {
  const env = await loadClient({
    trackSubscriptions: true,
    configValue: {
      routes: {
        'my-gemini': { localizePrompt: true, nativeHistory: true, googleSearch: true },
        google: { localizePrompt: false, nativeHistory: true, googleSearch: false },
      },
      showStatusNotice: true,
    },
    modelsValue: {
      providers: {
        'my-gemini': {
          displayName: 'My Gemini Relay',
          api: 'google-generative-ai',
          baseURL: 'https://relay.test/v1beta',
          models: [{ id: 'gemini-4-neon' }],
        },
      },
    },
  })

  const noticeSlot = env.slots.get('conversation.composer.dock:dsh-gemini-native-notice')
  const instance = createInstance()
  let activeProvider = 'my-gemini'
  let activeModel = 'gemini-4-neon'
  let diagProjection = {
    assistantSteps: 5,
    consecutiveNative: 4,
    nativeSteps: 4,
    nativeBytes: 12288,
    hasNativePayload: true,
    promptLocalizedInLog: true,
    searchCards: 2,
    searchQueries: 4,
    searchSources: 6,
  }

  const renderNotice = () => {
    env.React.__beginRender(instance)
    try {
      const tree = renderTree(noticeSlot.render({
        sessionId: 'sess-diag',
        useProjection: (key, select) => {
          if (key === 'modelSelection') return select({ next: { provider: activeProvider, model: activeModel } })
          if (key === 'geminiNativeDiagnostics') return diagProjection
          return undefined
        },
        t: env.t,
      }))
      return tree
    } finally {
      env.React.__endRender()
      env.React.__flushEffects(instance)
    }
  }

  let tree = renderNotice()
  const btn = findAll(tree, n => n.type === 'button')[0]
  assert.ok(btn)
  assert.equal(btn.props.className, 'dsh-gn-dock-pill')
  assert.equal(btn.props['aria-haspopup'], 'dialog')
  assert.equal(btn.props['aria-expanded'], false)
  assert.equal(btn.props.style, undefined)

  // GeminiMark uses fine strokeWidth=1.6; labels use .dsh-gn-dock-sep instead of hardcoded secondary inline text.
  const svg = findAll(btn, n => n.type === 'svg')[0]
  assert.equal(svg.props.strokeWidth, 1.6)
  const seps = findAll(btn, n => n.props?.className === 'dsh-gn-dock-sep')
  assert.equal(seps.length, 2)
  assert.equal(collectText(btn).join(''), '提示词汉化已开启·原生历史·Google 搜索')

  // Subscribed to the status SSE endpoint (and xhigh SSE for Neon/Hydrogen model).
  assert.equal(env.eventSources.length, 2)
  const statusStream = env.eventSources.find(es => es.url.includes('/status'))
  const xhighStream = env.eventSources.find(es => es.url.includes('/xhigh'))
  assert.equal(statusStream?.url, 'http://localhost/api/dsh-gemini-native/status?sessionId=sess-diag')
  assert.equal(xhighStream?.url, 'http://localhost/api/dsh-gemini-native/xhigh?sessionId=sess-diag')

  // Emit structured telemetry with warning-free state first.
  statusStream.emit({
    localizedProvider: 'my-gemini',
    prompt: { provider: 'my-gemini', matched: 8, total: 9, missedBuiltins: ['tools:custom'] },
    transport: {
      provider: 'my-gemini',
      model: 'gemini-4-neon',
      status: 'ok',
      totalHistoryTurns: 4,
      replayedHistoryTurns: 3,
      searchConfigured: true,
      searchInjected: true,
      searchMode: 'mixed',
      localToolCount: 2,
      xhighRequested: true,
      xhighApplied: true,
      thinkingLevel: 'XHIGH',
      recordedBytes: 2048,
      recordedFrames: 5,
      recordStatus: 'saved',
    },
  })

  tree = renderNotice()
  let pill = findAll(tree, n => n.type === 'button')[0]
  assert.equal(collectText(pill).join(''), '提示词已汉化·原生历史·Google 搜索')
  assert.equal(findAll(pill, n => n.props?.className === 'dsh-gn-dock-warn-dot').length, 0)

  // Click opens portaled diagnostic dialog on document.body.
  pill.props.onClick()
  tree = renderNotice()
  pill = findAll(tree, n => n.type === 'button')[0]
  assert.equal(pill.props['aria-expanded'], true)
  const portal = findAll(tree, n => n.type === env.PORTAL_TYPE)[0]
  assert.ok(portal, 'dialog must be portaled')
  assert.equal(portal.props.target, env.mockDocument.body)

  const dialog = findAll(portal, n => n.props?.role === 'dialog')[0]
  assert.ok(dialog)
  assert.equal(dialog.props.className, 'dsh-gn-diag-panel')
  const dialogText = collectText(dialog).join(' ')
  assert.ok(dialogText.includes('My Gemini Relay / gemini-4-neon'))
  assert.ok(dialogText.includes('已替换 8 / 9 段'))
  assert.ok(dialogText.includes('tools:custom'))
  assert.ok(dialogText.includes('命中 3/4 轮 (部分回退) · 累计 12KB'))
  assert.ok(dialogText.includes('已自动排除上传'))
  assert.ok(dialogText.includes('混用 2 个本地工具 · 本会话 2 次'))
  assert.ok(dialogText.includes('XHIGH（会话覆盖）'))

  // Emit warning status (url-mismatch) -> shows 5px warning dot on pill + warning banner in dialog.
  statusStream.emit({
    localizedProvider: 'my-gemini',
    prompt: null,
    transport: {
      provider: 'my-gemini',
      model: 'gemini-4-neon',
      status: 'url-mismatch',
      totalHistoryTurns: 0,
      replayedHistoryTurns: 0,
      searchConfigured: true,
      searchInjected: false,
      searchMode: 'skipped',
      localToolCount: 1,
      xhighRequested: false,
      xhighApplied: false,
      thinkingLevel: null,
      recordedBytes: 0,
      recordedFrames: 0,
      recordStatus: 'overflow',
    },
  })
  tree = renderNotice()
  pill = findAll(tree, n => n.type === 'button')[0]
  assert.equal(findAll(pill, n => n.props?.className === 'dsh-gn-dock-warn-dot').length, 1)
  const warnText = collectText(findAll(tree, n => n.props?.role === 'dialog')[0]).join(' ')
  assert.ok(warnText.includes('未能匹配 /v1beta 请求路径'))
  assert.ok(warnText.includes('2 MiB'))
  assert.ok(warnText.includes('toolConfig'))

  // A model change on the same provider must not show the previous model's warnings.
  activeModel = 'gemini-4-argon'
  tree = renderNotice()
  pill = findAll(tree, n => n.type === 'button')[0]
  assert.equal(findAll(pill, n => n.props?.className === 'dsh-gn-dock-warn-dot').length, 0)
  const switchedModelText = collectText(findAll(tree, n => n.props?.role === 'dialog')[0]).join(' ')
  assert.match(switchedModelText, /gemini-4-argon/u)
  assert.doesNotMatch(switchedModelText, /gemini-4-neon|toolConfig/u)

  // Switching provider to 'google' must NOT inherit 'my-gemini' telemetry or warning dot.
  activeProvider = 'google'
  activeModel = 'gemini-4-argon'
  tree = renderNotice()
  pill = findAll(tree, n => n.type === 'button')[0]
  assert.equal(findAll(pill, n => n.props?.className === 'dsh-gn-dock-warn-dot').length, 0)
  assert.equal(collectText(pill).join(''), '原生历史')

  // A new snapshot updates the structured prompt status.
  activeProvider = 'my-gemini'
  statusStream.emit({ localizedProvider: 'my-gemini', prompt: null, transport: null })
  tree = renderNotice()
  assert.ok(collectText(findAll(tree, n => n.type === 'button')[0]).join('').includes('提示词已汉化'))

  // Empty stats + no live telemetry shows gentle hint when open.
  diagProjection = undefined
  statusStream.emit({ localizedProvider: null, prompt: null, transport: null })
  tree = renderNotice()
  findAll(tree, n => n.type === 'button')[0].props.onClick()
  tree = renderNotice()
  const emptyDialogText = collectText(findAll(tree, n => n.props?.role === 'dialog')[0]).join(' ')
  assert.ok(emptyDialogText.includes('发出首条消息后显示实时覆盖详情'))

  env.React.__unmount(instance)
  env.disposeEffects()
  assert.equal(statusStream.closed, true)
  assert.equal(xhighStream.closed, true)
})

test('NativeStatusNotice dialog closes on Escape, outside pointerdown, and capture click, and gracefully skips portal without ReactDOM', async () => {
  const env = await loadClient({
    configValue: { routes: {} },
    supportsAnchor: false,
  })
  const noticeSlot = env.slots.get('conversation.composer.dock:dsh-gemini-native-notice')
  const instance = createInstance()
  const rootEl = {
    contains: target => target === 'inside-root',
    getBoundingClientRect: () => ({ left: 48, top: 640, right: 200, bottom: 664 }),
  }
  const panelEl = {
    contains: target => target === 'inside-panel',
  }

  const renderNotice = () => {
    env.React.__beginRender(instance)
    try {
      const tree = renderTree(noticeSlot.render({
        sessionId: 'sess-dismiss',
        useProjection: (key, select) => key === 'modelSelection' ? select({ next: { provider: 'google', model: 'gemini-4' } }) : undefined,
        t: env.t,
      }))
      // Bind mock DOM elements to the refs allocated by useDiagDialog.
      const anchor = tree
      if (anchor?.props?.ref) anchor.props.ref.current = rootEl
      const portal = findAll(tree, n => n.type === env.PORTAL_TYPE)[0]
      const dialog = portal ? findAll(portal, n => n.props?.role === 'dialog')[0] : null
      if (dialog?.props?.ref) dialog.props.ref.current = panelEl
      return tree
    } finally {
      env.React.__endRender()
      env.React.__flushEffects(instance)
    }
  }

  // Open dialog and verify fallback positioning without CSS.supports('anchor-name').
  let tree = renderNotice()
  findAll(tree, n => n.type === 'button')[0].props.onClick()
  tree = renderNotice()
  // Second render after layout effect picks up fallbackPos.
  tree = renderNotice()
  const dialog = findAll(tree, n => n.props?.role === 'dialog')[0]
  assert.equal(dialog.props.style.left, '48px')
  assert.equal(dialog.props.style.bottom, '168px')
  assert.equal(dialog.props.style.top, 'auto')

  // Inside pointerdown / click keeps dialog open.
  env.mockDocument.dispatch('pointerdown', { target: 'inside-panel' })
  env.mockDocument.dispatch('click', { target: 'inside-root' }, { captureOnly: true })
  tree = renderNotice()
  assert.equal(findAll(tree, n => n.type === 'button')[0].props['aria-expanded'], true)

  // Capture-phase outside click (e.g. clicking sibling DSH pill) closes dialog immediately.
  env.mockDocument.dispatch('click', { target: 'sibling-pill' }, { captureOnly: true })
  tree = renderNotice()
  assert.equal(findAll(tree, n => n.type === 'button')[0].props['aria-expanded'], false)

  // Reopen, then outside pointerdown closes.
  findAll(tree, n => n.type === 'button')[0].props.onClick()
  tree = renderNotice()
  assert.equal(findAll(tree, n => n.type === 'button')[0].props['aria-expanded'], true)
  env.mockDocument.dispatch('pointerdown', { target: 'outside-area' })
  tree = renderNotice()
  assert.equal(findAll(tree, n => n.type === 'button')[0].props['aria-expanded'], false)

  // Reopen, then Escape closes.
  findAll(tree, n => n.type === 'button')[0].props.onClick()
  tree = renderNotice()
  assert.equal(findAll(tree, n => n.type === 'button')[0].props['aria-expanded'], true)
  env.mockDocument.dispatch('keydown', { key: 'Escape' })
  tree = renderNotice()
  assert.equal(findAll(tree, n => n.type === 'button')[0].props['aria-expanded'], false)

  // Without ReactDOM/document.body, toggling open does not crash and omits portal.
  const noPortalEnv = await loadClient({
    configValue: { routes: {} },
    withDom: false,
    withReactDom: false,
  })
  const noPortalSlot = noPortalEnv.slots.get('conversation.composer.dock:dsh-gemini-native-notice')
  const noPortalInst = createInstance()
  noPortalEnv.React.__beginRender(noPortalInst)
  let noPortalTree = renderTree(noPortalSlot.render({
    sessionId: 'sess-noportal',
    useProjection: (key, select) => key === 'modelSelection' ? select({ next: { provider: 'google' } }) : undefined,
    t: noPortalEnv.t,
  }))
  noPortalEnv.React.__endRender()
  findAll(noPortalTree, n => n.type === 'button')[0].props.onClick()
  noPortalEnv.React.__beginRender(noPortalInst)
  noPortalTree = renderTree(noPortalSlot.render({
    sessionId: 'sess-noportal',
    useProjection: (key, select) => key === 'modelSelection' ? select({ next: { provider: 'google' } }) : undefined,
    t: noPortalEnv.t,
  }))
  noPortalEnv.React.__endRender()
  assert.equal(findAll(noPortalTree, n => n.props?.role === 'dialog').length, 0)
})

test('LiveSearchActivity uses compact dock pill classes and GoogleSearchCard renders DisclosureRow + WebBlock while suppressing redirect host', async () => {
  const env = await loadClient({ trackSubscriptions: true })
  const liveSlot = env.slots.get('conversation.composer.dock:dsh-gemini-native-search-live')
  const liveInst = createInstance()
  const renderLive = () => {
    env.React.__beginRender(liveInst)
    try {
      return renderTree(liveSlot.render({ sessionId: 'sess-live', t: env.t }))
    } finally {
      env.React.__endRender()
    }
  }
  assert.equal(renderLive(), null)
  env.eventSources[0].emit({
    liveTurn: 1,
    cards: [{ turn: 1, status: 'running', queries: ['q'], sources: [] }],
  })
  const liveTree = renderLive()
  assert.equal(liveTree.props.className, 'dsh-gn-dock-anchor')
  const livePill = findAll(liveTree, n => n.props?.role === 'status')[0]
  assert.equal(livePill.props.className, 'dsh-gn-dock-pill')
  assert.equal(collectText(livePill).join(''), 'Google 搜索中…')

  const turnSlot = env.slots.get('conversation.chat.turnTail:dsh-gemini-native-search-cards')
  const cardInst = createInstance()
  const durableCards = [{
    status: 'completed',
    queries: ['gemini 4 search', 'dsh ui'],
    sources: [
      {
        url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc',
        title: 'github.com',
      },
      {
        url: 'https://docs.python.org/3/',
        title: 'Python Docs',
      },
    ],
  }]

  const renderCard = () => {
    env.React.__beginRender(cardInst)
    try {
      return renderTree(turnSlot.render({
        sessionId: 'sess-live',
        turn: { turn: 3 },
        useProjection: (_key, select) => select({ 3: durableCards }),
        t: env.t,
      }))
    } finally {
      env.React.__endRender()
    }
  }

  // Collapsed by default as DisclosureRow; no <details> hard border, no body mounted yet.
  let cardTree = renderCard()
  assert.equal(cardTree.props.className, 'dsh-gn-search-root')
  assert.equal(findAll(cardTree, n => n.type === 'details').length, 0)
  let rowBtn = findAll(cardTree, n => n.type === 'button' && n.props.className === 'dsh-gn-search-row')[0]
  assert.ok(rowBtn)
  assert.equal(rowBtn.props['aria-expanded'], false)
  assert.equal(findAll(cardTree, n => n.props?.className === 'dsh-gn-search-body').length, 0)
  assert.ok(collectText(rowBtn).join('').includes('Google 搜索'))
  assert.ok(collectText(rowBtn).join('').includes('搜索词 2 · 来源 2'))

  // Click row to expand body with query tags and <ol> sources.
  rowBtn.props.onClick()
  cardTree = renderCard()
  rowBtn = findAll(cardTree, n => n.type === 'button' && n.props.className === 'dsh-gn-search-row')[0]
  assert.equal(rowBtn.props['aria-expanded'], true)
  const body = findAll(cardTree, n => n.props?.className === 'dsh-gn-search-body')[0]
  assert.ok(body)
  assert.equal(body.props['data-web'], 'search')

  const queryTags = findAll(body, n => n.props?.className === 'dsh-gn-search-query-tag')
  assert.deepEqual(queryTags.map(tag => tag.children[0]), ['gemini 4 search', 'dsh ui'])

  const ol = findAll(body, n => n.type === 'ol' && n.props.className === 'dsh-gn-search-sources')[0]
  assert.ok(ol)
  const listItems = findAll(ol, n => n.type === 'li')
  assert.equal(listItems.length, 2)

  // Redirect host vertexaisearch.cloud.google.com must NEVER be rendered in visible text!
  const allVisibleText = collectText(cardTree).join(' ')
  assert.ok(allVisibleText.includes('github.com'))
  assert.equal(allVisibleText.includes('vertexaisearch.cloud.google.com'), false)
  // Non-redirect source with distinct title shows its host subtly.
  assert.ok(allVisibleText.includes('docs.python.org'))

  env.disposeEffects()
})

test('conversation.input.model.options and conversation.input.right xhigh visibility across Gemini routes, models, efforts, and fallback store', async () => {
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

  const optionSlot = env.slots.get('conversation.input.model.options:dsh-gemini-native-xhigh')
  assert.ok(optionSlot, 'xhigh option should be registered under conversation.input.model.options')
  assert.equal(optionSlot.meta.order, -10)
  assert.equal(optionSlot.meta.locale, 'dshGeminiNative')

  const chipSlot = env.slots.get('conversation.input.right:dsh-gemini-native-xhigh')
  assert.ok(chipSlot, 'xhigh active chip should be registered under conversation.input.right')
  assert.equal(chipSlot.meta.order, 100)
  assert.equal(chipSlot.meta.locale, 'dshGeminiNative')

  const renderSlotFor = (slot, { sessionId = 'sess-1', selection, includeStore = true, sessionSnap, sessionsState, locked = false }) => {
    const injected = includeStore ? slot.meta.inject(sessionId) : {}
    return renderTree(slot.render({
      sessionId,
      locked,
      useProjection: (_key, select) => select(selection ? { next: selection } : undefined),
      useSession: select => select(sessionSnap),
      useSessions: select => select(sessionsState),
      t: env.t,
      ...injected,
    }))
  }

  // Model menu option renders switch for Gemini API + Neon/Hydrogen regardless of native effort,
  // while the toolbar active chip stays hidden (null) when XHigh is off.
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
    const optionTree = renderSlotFor(optionSlot, { selection })
    assert.ok(optionTree !== null, `expected model option to render for ${JSON.stringify(selection)}`)
    assert.equal(optionTree.props.className, 'dsh-gn-model-opt-row')
    const sw = findAll(optionTree, node => node.type === 'button' && node.props.role === 'switch')[0]
    assert.ok(sw, 'model option must render a role="switch" button')
    assert.equal(sw.props['aria-checked'], false)
    assert.equal(sw.props.className, 'dsh-gn-model-opt-switch')
    assert.equal(collectText(optionTree).join(''), 'XHigh 推理覆盖')

    assert.equal(renderSlotFor(chipSlot, { selection }), null, 'toolbar chip must stay hidden when XHigh is off')
  }

  // Falls back to modelStore.current when modelSelection projection is empty (new chat default).
  const fallbackOption = renderSlotFor(optionSlot, { selection: undefined })
  assert.ok(fallbackOption !== null && findAll(fallbackOption, n => n.props?.role === 'switch').length === 1)
  assert.equal(renderSlotFor(chipSlot, { selection: undefined }), null)

  // Hidden for non-Neon/Hydrogen models, non-Gemini routes, and missing sessionId.
  for (const selection of [
    { provider: 'google', model: 'gemini-4-argon', reasoningEffort: 'high' },
    { provider: 'google', model: 'gemini-4-carbon', reasoningEffort: 'high' },
    { provider: 'google', model: 'gemini-4-neonx', reasoningEffort: 'high' },
    { provider: 'my-gemini', model: 'gemini-4-argon' },
    { provider: 'my-openai', model: 'gemini-4-neon', reasoningEffort: 'high' },
    { provider: 'my-openai', model: 'gemini-4-hydrogen' },
  ]) {
    assert.equal(renderSlotFor(optionSlot, { selection }), null, `expected null for ${JSON.stringify(selection)}`)
    assert.equal(renderSlotFor(chipSlot, { selection }), null)
  }
  assert.equal(renderSlotFor(optionSlot, { sessionId: '', selection: { provider: 'google', model: 'gemini-4-neon' } }), null)
  assert.equal(renderSlotFor(chipSlot, { sessionId: '', selection: { provider: 'google', model: 'gemini-4-neon' } }), null)

  // Hidden wherever the model selector itself is hidden (addressed/snapshot/listed subagent sessions).
  const neon = { provider: 'google', model: 'gemini-4-neon', reasoningEffort: 'high' }
  assert.equal(renderSlotFor(optionSlot, { sessionId: 'sub-addressed', selection: neon }), null)
  assert.equal(renderSlotFor(optionSlot, { selection: neon, sessionSnap: { subagent: { address: { mode: 'continuable' } } } }), null)
  assert.equal(renderSlotFor(optionSlot, { selection: neon, sessionsState: { byId: { 'sess-1': { origin: 'subagent' } } } }), null)
  assert.equal(renderSlotFor(chipSlot, { sessionId: 'sub-addressed', selection: neon }), null)
  assert.equal(renderSlotFor(chipSlot, { selection: neon, sessionSnap: { subagent: { address: { mode: 'continuable' } } } }), null)
  assert.equal(renderSlotFor(chipSlot, { selection: neon, sessionsState: { byId: { 'sess-1': { origin: 'subagent' } } } }), null)

  // Disabled when the session is removed or when ModelSelect passes locked=true.
  const removedOpt = renderSlotFor(optionSlot, { selection: neon, sessionSnap: { subagent: null, removed: true } })
  assert.equal(findAll(removedOpt, n => n.props?.role === 'switch')[0].props.disabled, true)
  const lockedOpt = renderSlotFor(optionSlot, { selection: neon, locked: true })
  assert.equal(findAll(lockedOpt, n => n.props?.role === 'switch')[0].props.disabled, true)

  // When models form is not ready, allow built-in google only and reject non-google routes.
  env.setModelsStatus('loading')
  assert.ok(renderSlotFor(optionSlot, { selection: { provider: 'google', model: 'gemini-4-neon' } }) !== null)
  assert.equal(renderSlotFor(optionSlot, { selection: { provider: 'my-openai', model: 'gemini-4-neon' } }), null)
  assert.equal(renderSlotFor(optionSlot, { selection: { provider: 'my-gemini', model: 'gemini-4-neon' } }), null)
})

test('XHighModelOption switch and XHighActiveChip share SSE sync, render PlanChip-aligned active chip only when ON, handle failures/busy, and clean up EventSource', async () => {
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

  const optionSlot = env.slots.get('conversation.input.model.options:dsh-gemini-native-xhigh')
  const chipSlot = env.slots.get('conversation.input.right:dsh-gemini-native-xhigh')
  const optionInst = createInstance()
  const chipInst = createInstance()
  const modelSelectionChanges = []
  const reportedFailures = []
  const injectedOption = optionSlot.meta.inject('sess-xhigh')
  const injectedChip = chipSlot.meta.inject('sess-xhigh')

  const renderOption = () => {
    env.React.__beginRender(optionInst)
    try {
      return renderTree(optionSlot.render({
        sessionId: 'sess-xhigh',
        locked: false,
        reportFailure: msg => reportedFailures.push(msg),
        useProjection: (key, select) => {
          assert.equal(key, 'modelSelection')
          return select({ next: { provider: 'my-gemini', model: 'gemini-4-neon', reasoningEffort: 'low' } })
        },
        setModelSelection: () => { modelSelectionChanges.push('called') },
        t: env.t,
        ...injectedOption,
      }))
    } finally {
      env.React.__endRender()
    }
  }

  const renderChip = () => {
    env.React.__beginRender(chipInst)
    try {
      return renderTree(chipSlot.render({
        sessionId: 'sess-xhigh',
        useProjection: (key, select) => {
          assert.equal(key, 'modelSelection')
          return select({ next: { provider: 'my-gemini', model: 'gemini-4-neon', reasoningEffort: 'low' } })
        },
        t: env.t,
        ...injectedChip,
      }))
    } finally {
      env.React.__endRender()
    }
  }

  // Initial render: both subscribe to ONE shared SSE stream; chip returns null while off, option shows unchecked switch.
  let optRow = renderOption()
  let sw = findAll(optRow, n => n.type === 'button' && n.props.role === 'switch')[0]
  assert.equal(sw.props['aria-checked'], false)
  assert.equal(sw.props.title, '在当前会话将推理等级覆盖为 XHigh（Neon / Hydrogen），不改变原生档位')
  assert.equal(renderChip(), null)
  assert.equal(env.eventSources.length, 1)
  assert.equal(env.eventSources[0].url, 'http://localhost/api/dsh-gemini-native/xhigh?sessionId=sess-xhigh')

  // Clicking switch sends POST {sessionId, enabled: true}; both switch and toolbar chip update synchronously.
  await sw.props.onClick()
  assert.equal(env.fetchCalls.length, 1)
  assert.equal(env.fetchCalls[0].url, 'http://localhost/api/dsh-gemini-native/xhigh')
  assert.equal(env.fetchCalls[0].options.method, 'POST')
  assert.deepEqual(JSON.parse(JSON.stringify(env.fetchCalls[0].options.headers)), { 'Content-Type': 'application/json' })
  assert.deepEqual(JSON.parse(env.fetchCalls[0].options.body), { sessionId: 'sess-xhigh', enabled: true })
  assert.equal(env.mutations.length, 0)
  assert.equal(modelSelectionChanges.length, 0)

  optRow = renderOption()
  sw = findAll(optRow, n => n.type === 'button' && n.props.role === 'switch')[0]
  assert.equal(sw.props['aria-checked'], true)

  let chipWrap = renderChip()
  assert.ok(chipWrap !== null && chipWrap.props.className === 'dsh-gn-xhigh-wrap')
  assert.equal(findAll(chipWrap, n => n.props?.role === 'status').length, 0)
  let chip = findAll(chipWrap, n => n.type === 'button' && n.props.className === 'dsh-gn-xhigh')[0]
  assert.ok(chip)
  assert.equal(chip.props.style, undefined)
  assert.equal(chip.props.title, '当前会话已开启 XHigh 覆盖 — 点击关闭')
  assert.deepEqual(collectText(chip), ['XHigh'])
  const svgs = findAll(chip, n => n.type === 'svg')
  assert.equal(svgs.length, 2, 'active chip renders rest GeminiMark and hover CloseCircleFillIcon')
  assert.equal(svgs[0].props.className, 'dsh-gn-xhigh-rest-glyph')
  assert.equal(svgs[0].props.strokeWidth, 1.6)
  assert.equal(svgs[1].props.className, 'dsh-gn-xhigh-hover-glyph')

  // onMouseDown on chip prevents stealing composer input focus.
  let prevented = false
  chip.props.onMouseDown({ preventDefault() { prevented = true } })
  assert.equal(prevented, true)

  // Clicking active chip when POST fails renders inline status error beside chip while preserving ON state.
  failNext = true
  await chip.props.onClick()
  chipWrap = renderChip()
  const errEl = findAll(chipWrap, n => n.props?.className === 'dsh-gn-xhigh-error' && n.props?.role === 'status')[0]
  assert.ok(errEl, 'failed exit click must display inline status feedback')
  assert.equal(collectText(errEl).join(''), '未能切换 XHigh 推理覆盖，请重试。')
  chip = findAll(chipWrap, n => n.type === 'button' && n.props.className === 'dsh-gn-xhigh')[0]

  // Clicking active chip turns XHigh off -> unmounts chip back to null and unchecks switch.
  pendingResolve = () => {}
  const firstClick = chip.props.onClick()
  const secondClick = chip.props.onClick()
  assert.equal(env.fetchCalls.length, 3, 'second click while busy must be ignored')
  assert.deepEqual(JSON.parse(env.fetchCalls[2].options.body), { sessionId: 'sess-xhigh', enabled: false })
  pendingResolve()
  pendingResolve = null
  await Promise.all([firstClick, secondClick])

  assert.equal(renderChip(), null)
  optRow = renderOption()
  sw = findAll(optRow, n => n.type === 'button' && n.props.role === 'switch')[0]
  assert.equal(sw.props['aria-checked'], false)

  // SSE push {"enabled":true} / {"enabled":false} notifies both subscribers and updates UI.
  env.eventSources[0].emit({ enabled: true })
  assert.ok(optionInst.notified >= 1)
  assert.ok(chipInst.notified >= 1)
  assert.ok(renderChip() !== null)
  env.eventSources[0].emit({ enabled: false })
  assert.equal(renderChip(), null)

  // POST network failure from option reports failure via reportFailure without throwing or changing state.
  failNext = true
  optRow = renderOption()
  sw = findAll(optRow, n => n.type === 'button' && n.props.role === 'switch')[0]
  await sw.props.onClick()
  assert.deepEqual(reportedFailures, ['未能切换 XHigh 推理覆盖，请重试。'])
  optRow = renderOption()
  assert.equal(findAll(optRow, n => n.props?.role === 'switch')[0].props['aria-checked'], false)
  assert.equal(renderChip(), null)
  assert.equal(env.mutations.length, 0)
  assert.equal(modelSelectionChanges.length, 0)

  // Disposing plugin effects closes all EventSource streams cleanly.
  assert.equal(env.eventSources[0].closed, false)
  env.disposeEffects()
  assert.equal(env.eventSources[0].closed, true)
  assert.equal(env.eventSources[0].onmessage, null)
  assert.equal(env.eventSources[0].onerror, null)
})
