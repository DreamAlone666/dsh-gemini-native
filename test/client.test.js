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
  directoryGroups = [],
  subagentSessions = new Set(),
  fetchImpl = null,
  trackSubscriptions = false,
  withDom = true,
  withReactDom = true,
  supportsAnchor = true,
  viewportWidth = 1200,
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
      innerWidth: viewportWidth,
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
  let configSnapshot = { status: 'ready', writable: true, revision: 7, value: configValue }
  let configMutation
  const makeForm = (ns, getSnapshot) => ({
    subscribe: () => () => {},
    getSnapshot,
    async mutate(ops, revision) {
      mutations.push({ ns, ops, revision })
      return ns === 'dsh-gemini-native' && configMutation ? configMutation(ops, revision) : true
    },
  })
  const configForm = makeForm('dsh-gemini-native', () => configSnapshot)
  const ctx = {
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') effectCleanups.push(cleanup)
    },
    locale: { register(ns, dicts) { locales = { ns, dicts }; return () => {} } },
    configForms: {
      get(ns) {
        if (ns === 'dsh-gemini-native') return configForm
        if (ns === 'llm-pi-ai') return makeForm(ns, () => ({ status: currentModelsStatus, writable: true, revision: 7, value: modelsValue }))
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
            return { store: { subscribe: () => () => {}, getSnapshot: () => ({ current: currentDirectory, groups: directoryGroups }) } }
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
    configForm,
    setConfig(v, state = {}) { configSnapshot = { ...configSnapshot, ...state, value: v } },
    setConfigMutation(fn) { configMutation = fn },
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
  assert.equal(googleCheckboxes.length, 4)

  const plain = value => JSON.parse(JSON.stringify(value))

  // Native history is on without a saved route; the other features are opt-in.
  const geminiTree = renderTree(card.render({ provider: { provider: 'my-gemini' }, configured: true, t: env.t }))
  const checkboxes = findAll(geminiTree, node => node.type === 'input' && node.props.type === 'checkbox')
  assert.deepEqual(checkboxes.map(node => node.props.checked), [false, true, false, false])
  assert.equal(findAll(geminiTree.children[1], node => node.type === 'input').length, 3, 'keep the three primary checkboxes together')
  assert.equal(findAll(geminiTree.children[2], node => node.type === 'input')[0], checkboxes[3], 'family replay is a separate row')
  assert.match(collectText(geminiTree.children[2]).join(' '), /Gemini 4 家族跨模型互通.*实验性/u)
  const [familyHelp] = findAll(geminiTree, node => node.props?.id === checkboxes[3].props['aria-describedby'])
  assert.match(collectText(familyHelp).join(' '), /需开启原生历史回放.*Carbon、Argon、Neon、Hydrogen.*不一定连接同一上游.*HTTP 400.*不保证命中隐式缓存/u)
  const english = renderTree(card.render({ provider: { provider: 'my-gemini' }, configured: true, t: env.tEn }))
  assert.match(collectText(english.children[2]).join(' '), /Gemini 4 cross-model replay.*Experimental.*Requires Native history replay.*HTTP 400.*Implicit cache hits are not guaranteed/u)
  assert.match(collectText(geminiTree).join(' '), /默认开启.*会话日志.*不会清除/u)
  checkboxes[2].props.onChange({ target: { checked: true } })
  assert.deepEqual(plain(env.mutations.at(-1)), {
    ns: 'dsh-gemini-native',
    revision: 7,
    ops: [{ op: 'set', path: ['routes', 'my-gemini'], value: { localizePrompt: false, nativeHistory: true, googleSearch: true, gemini4FamilyReplay: false } }],
  })

  // Turning off the default writes an explicit false. Opting into Search must not undo it.
  const defaultTree = renderTree(card.render({ provider: { provider: 'my-gemini' }, configured: true, t: env.t }))
  findAll(defaultTree, node => node.type === 'input')[1].props.onChange({ target: { checked: false } })
  const disabledReplay = { localizePrompt: false, nativeHistory: false, googleSearch: false, gemini4FamilyReplay: false }
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

test('family replay uses the same provider CAS read as the primary options and remembers opt-in when its parent is off', async () => {
  const env = await loadClient()
  const card = env.slots.get('settings.models.provider-card:llm-pi-ai')
  const instance = createInstance()
  const renderCard = () => {
    env.React.__beginRender(instance)
    try { return renderTree(card.render({ provider: { provider: 'google' }, configured: true, t: env.t })) }
    finally { env.React.__endRender(); env.React.__flushEffects(instance) }
  }
  const checkbox = (tree, index) => findAll(tree, node => node.type === 'input' && node.props.type === 'checkbox')[index]
  const toggle = (node, checked) => node.props.onChange({ target: { checked } })
  const write = () => JSON.parse(JSON.stringify(env.mutations.at(-1)))
  const path = ['routes', 'google']
  const familyOnly = { localizePrompt: false, nativeHistory: true, googleSearch: false, gemini4FamilyReplay: true }

  assert.equal(await toggle(checkbox(renderCard(), 3), true), true)
  assert.deepEqual(write(), { ns: 'dsh-gemini-native', revision: 7, ops: [{ op: 'set', path, value: familyOnly }] })

  env.setConfig({ routes: { google: familyOnly } }, { revision: 8 })
  assert.equal(await toggle(checkbox(renderCard(), 1), false), true)
  assert.deepEqual(write().ops, [{ op: 'set', path, value: { ...familyOnly, nativeHistory: false } }])
  env.setConfig({ routes: { google: { ...familyOnly, nativeHistory: false } } }, { revision: 9 })
  const paused = renderCard()
  assert.equal(checkbox(paused, 3).props.checked, true)
  assert.equal(checkbox(paused, 3).props.disabled, true)
  assert.equal(await toggle(checkbox(paused, 1), true), true)
  assert.deepEqual(write().ops, [{ op: 'set', path, value: familyOnly }])

  env.setConfig({ routes: { google: familyOnly } }, { revision: 10 })
  assert.equal(await toggle(checkbox(renderCard(), 3), false), true)
  assert.deepEqual(write().ops, [{ op: 'unset', path }])

  // A newer snapshot arrived before this rendered handler was activated.
  env.setConfig({ routes: {} }, { revision: 11 })
  const oldControl = checkbox(renderCard(), 3)
  env.setConfig({ routes: { google: { localizePrompt: true, googleSearch: true } } }, { revision: 12 })
  env.setConfigMutation(() => false)
  assert.equal(await toggle(oldControl, true), false)
  assert.deepEqual(write(), { ns: 'dsh-gemini-native', revision: 12, ops: [{
    op: 'set', path, value: { ...familyOnly, localizePrompt: true, googleSearch: true },
  }] })
  const conflicted = renderCard()
  assert.equal(checkbox(conflicted, 3).props.checked, false)
  assert.match(collectText(findAll(conflicted, node => node.props?.role === 'alert')).join(' '), /设置已在别处更改/u)

  // A lower composition layer can opt in; unsetting must not re-enable it.
  env.setConfig({ routes: { google: familyOnly } }, { revision: 13, base: { routes: { google: familyOnly } } })
  env.setConfigMutation(() => true)
  assert.equal(await toggle(checkbox(renderCard(), 3), false), true)
  assert.deepEqual(write().ops, [{ op: 'set', path, value: { ...familyOnly, gemini4FamilyReplay: false } }])
  env.React.__unmount(instance)
  env.disposeEffects()
})

test('plugin details summarize family replay only for active Gemini provider overrides with native history enabled', async () => {
  const gemini = { api: 'google-generative-ai', baseURL: 'https://relay.test/v1beta', models: [{ id: 'gemini-4-hydrogen' }] }
  const env = await loadClient({
    modelsValue: { providers: { live: gemini, paused: gemini, stale: { api: 'openai-completions' }, disabled: gemini } },
    configValue: { routes: {
      live: { gemini4FamilyReplay: true },
      paused: { gemini4FamilyReplay: true, nativeHistory: false },
      stale: { gemini4FamilyReplay: true },
      disabled: { gemini4FamilyReplay: false },
    } },
  })
  const details = env.slots.get('plugins.row.config:dsh-gemini-native#dsh-gemini-native')
  const renderDetails = (t = env.t) => renderTree(details.render({
    view: 'page', form: { state: env.configForm.getSnapshot(), mutate: env.configForm.mutate }, t,
  }))
  const entries = tree => findAll(tree, node => node.type === 'li')
    .map(node => [node.props.key, collectText(node).join(' ')])
  const summary = 'Gemini 4 互通 · 实验性'
  const list = entries(renderDetails())
  assert.deepEqual(list.filter(([, text]) => text.includes(summary)).map(([id]) => id), ['live'])
  assert.match(list.find(([id]) => id === 'stale')[1], /当前非 Gemini API 供应商/u)
  assert.match(list.find(([id]) => id === 'paused')[1], /原生回放已关闭/u)
  assert.match(entries(renderDetails(env.tEn)).find(([id]) => id === 'live')[1], /Gemini 4 cross-model replay · Experimental/u)
  env.setModelsStatus('loading')
  assert.ok(entries(renderDetails()).every(([, text]) => !text.includes(summary)))
  env.disposeEffects()
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
          models: [
            { id: 'gemini-4-neon', name: 'Configured Neon' },
            { id: 'gemini-4-argon', name: 'Configured Argon' },
          ],
        },
      },
    },
    directoryGroups: [
      { id: 'other', name: 'Other Provider', models: [{ id: 'gemini-4-neon', name: 'Other Neon' }] },
      { id: 'my-gemini', name: 'Gemini Relay', models: [{ id: 'gemini-4-neon', name: 'Gemini 4 Neon' }] },
    ],
  })

  const noticeSlot = env.slots.get('conversation.composer.dock:dsh-gemini-native-notice')
  const instance = createInstance()
  let activeProvider = 'my-gemini'
  let activeModel = 'gemini-4-neon'
  let diagProjection = {
    assistantSteps: 5,
    consecutiveNative: 2,
    nativeSteps: 4,
    nativeBytes: 12288,
    hasNativePayload: true,
    promptLocalizedInLog: true,
    searchCards: 2,
    searchQueries: 4,
    searchSources: 6,
  }

  const renderNotice = (t = env.t) => {
    env.React.__beginRender(instance)
    try {
      const tree = renderTree(noticeSlot.render({
        ...noticeSlot.meta.inject('sess-diag'),
        sessionId: 'sess-diag',
        useProjection: (key, select) => {
          if (key === 'modelSelection') return select({ next: { provider: activeProvider, model: activeModel } })
          if (key === 'geminiNativeDiagnostics') return diagProjection
          return undefined
        },
        t,
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

  // The panel needs only the status SSE; XHigh state belongs to its controls.
  assert.equal(env.eventSources.length, 1)
  const [statusStream] = env.eventSources
  assert.equal(statusStream.url, 'http://localhost/api/dsh-gemini-native/status?sessionId=sess-diag')

  // Emit structured telemetry for a Neon branch with inherited Hydrogen history.
  const mixedStatus = {
    localizedProvider: 'my-gemini',
    prompt: { provider: 'my-gemini', matched: 8, total: 9, missedBuiltins: ['tools:custom'] },
    transport: {
      provider: 'my-gemini',
      model: 'gemini-4-neon',
      status: 'ok',
      totalHistoryTurns: 26,
      replayedHistoryTurns: 6,
      currentModelHistoryTurns: 6,
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
  }
  statusStream.emit(mixedStatus)

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
  const [route] = findAll(dialog, n => n.props?.className === 'dsh-gn-diag-route')
  assert.equal(collectText(route).join(''), 'Gemini Relay / Gemini 4 Neon')
  assert.equal(route.props.title, 'Gemini Relay / Gemini 4 Neon\nmy-gemini/gemini-4-neon')
  assert.doesNotMatch(dialogText, /路由 ID|my-gemini\/gemini-4-neon/u)
  assert.ok(dialogText.includes('已替换 8 / 9 段'))
  assert.ok(dialogText.includes('tools:custom'))
  assert.match(dialogText, /同模型回放 6 \/ 6 步 · 累计 12KB/u)
  assert.match(dialogText, /其他模型或供应商的 20 步按兼容格式发送/u)
  assert.doesNotMatch(dialogText, /未命中|部分回退/u)
  assert.ok(dialogText.includes('已自动排除上传'))
  assert.ok(dialogText.includes('混用 2 个本地工具 · 本会话 2 次'))
  assert.doesNotMatch(dialogText, /Thinking|XHIGH/u)

  const savedDiag = diagProjection
  diagProjection = undefined
  const dialogTextOf = tree => collectText(findAll(tree, n => n.props?.role === 'dialog')[0]).join(' ')
  assert.match(dialogTextOf(renderNotice()), /最近一次录制 2\.0KB/u)
  const mixedEnglish = dialogTextOf(renderNotice(env.tEn))
  assert.match(mixedEnglish, /Same-model replay: 6 \/ 6 steps · last recording 2\.0KB/u)
  assert.match(mixedEnglish, /Steps from other models or providers sent in standard format: 20/u)
  assert.doesNotMatch(mixedEnglish, /Unmatched same-model steps|partial fallback/u)
  diagProjection = savedDiag

  const emitHistory = (total, replayed, current, split) => statusStream.emit({ ...mixedStatus, transport: {
    ...mixedStatus.transport, totalHistoryTurns: total, replayedHistoryTurns: replayed, currentModelHistoryTurns: current, ...split,
  } })
  const familySplit = { sameModelReplayedTurns: 2, crossModelReplayedTurns: 3 }
  emitHistory(5, 5, 2, familySplit)
  const allReplayed = dialogTextOf(renderNotice())
  assert.match(allReplayed, /原生回放 5 \/ 5 步 · 累计 12KB.*同模型命中 2 步 · 跨模型命中 3 步/u)
  assert.doesNotMatch(allReplayed, /兼容格式|同模型回放/u)

  emitHistory(9, 5, 3, familySplit)
  const classified = dialogTextOf(renderNotice())
  assert.match(classified, /原生回放 5 \/ 9 步 · 累计 12KB.*同模型命中 2 步 · 跨模型命中 3 步/u)
  assert.match(classified, /其他模型或供应商的 3 步按兼容格式发送.*同模型有 1 步未命中/u)
  assert.match(dialogTextOf(renderNotice(env.tEn)), /Native replay: 5 \/ 9 steps.*Same-model hits: 2 · Cross-model hits: 3/u)
  assert.doesNotMatch(classified, /原因未分类/u)

  for (const unclassifiedCurrent of [null, 1, 7]) {
    emitHistory(9, 5, unclassifiedCurrent, familySplit)
    const unknown = dialogTextOf(renderNotice())
    assert.match(unknown, /同模型命中 2 步 · 跨模型命中 3 步.*4 步按兼容格式发送（原因未分类）/u)
    assert.doesNotMatch(unknown, /未命中|其他模型或供应商/u)
  }
  for (const invalidSplit of [{ ...familySplit, crossModelReplayedTurns: 2 }, { sameModelReplayedTurns: 5 }]) {
    emitHistory(9, 5, 6, invalidSplit)
    const invalid = dialogTextOf(renderNotice())
    assert.match(invalid, /原生回放 5 \/ 9 步.*4 步按兼容格式发送（原因未分类）/u)
    assert.doesNotMatch(invalid, /同模型回放|跨模型命中/u)
  }

  // No cross-model hits keeps the same-model presentation (old and new Host).
  emitHistory(26, 6, 6, { sameModelReplayedTurns: 6, crossModelReplayedTurns: 0 })
  assert.match(dialogTextOf(renderNotice()), /同模型回放 6 \/ 6 步.*其他模型或供应商的 20 步/u)
  emitHistory(26, 5, 6)
  assert.match(dialogTextOf(renderNotice()), /同模型回放 5 \/ 6 步.*其他模型或供应商的 20 步.*同模型有 1 步未命中，按兼容格式发送/u)
  assert.match(dialogTextOf(renderNotice(env.tEn)), /Unmatched same-model steps sent in standard format: 1/u)

  emitHistory(20, 0, 0)
  const otherOnly = dialogTextOf(renderNotice())
  assert.match(otherOnly, /暂无当前供应商和模型的历史.*其他模型或供应商的 20 步/u)
  assert.doesNotMatch(otherOnly, /0 \/ 0|未命中/u)

  emitHistory(6, 6, 6)
  assert.doesNotMatch(dialogTextOf(renderNotice()), /兼容格式/u)

  emitHistory(4, 3, undefined)
  assert.match(dialogTextOf(renderNotice()), /原生回放 3 \/ 4 步.*1 步按兼容格式发送（原因未分类）/u)
  assert.match(dialogTextOf(renderNotice(env.tEn)), /Steps sent in standard format \(reason not classified\): 1/u)
  emitHistory(4, 3, 2)
  assert.match(dialogTextOf(renderNotice()), /原因未分类/u)

  emitHistory(0, 0, 0)
  assert.match(dialogTextOf(renderNotice()), /暂无历史可回放/u)

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
  const switchedModelText = dialogTextOf(tree)
  assert.match(switchedModelText, /Gemini Relay \/ Configured Argon/u)
  assert.doesNotMatch(switchedModelText, /Gemini 4 Neon|toolConfig/u)

  // Switching provider to 'google' must NOT inherit 'my-gemini' telemetry or warning dot.
  activeProvider = 'google'
  activeModel = 'gemini-4-argon'
  tree = renderNotice()
  pill = findAll(tree, n => n.type === 'button')[0]
  assert.equal(findAll(pill, n => n.props?.className === 'dsh-gn-dock-warn-dot').length, 0)
  assert.equal(collectText(pill).join(''), '原生历史')
  pill.props.onClick()
  tree = renderNotice()
  const [fallbackRoute] = findAll(tree, n => n.props?.className === 'dsh-gn-diag-route')
  assert.equal(collectText(fallbackRoute).join(''), 'google / gemini-4-argon')
  assert.equal(fallbackRoute.props.title, 'google/gemini-4-argon')
  assert.match(dialogTextOf(tree), /日志已记录 4 \/ 5 步 · 12KB.*暂无当前模型的回放统计/u)
  assert.doesNotMatch(dialogTextOf(tree), /同模型回放|路由 ID/u)

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
})

test('NativeStatusNotice offers family replay for validated exact-model candidates and handles cross-model HTTP 400 in place', async () => {
  const provider = 'relay'
  const env = await loadClient({
    trackSubscriptions: true,
    modelsValue: { providers: { [provider]: { api: 'google-generative-ai', baseURL: 'https://relay.test/v1beta', models: [{ id: 'gemini-4-neon' }] } } },
    configValue: { routes: {}, showStatusNotice: true },
  })
  const notice = env.slots.get('conversation.composer.dock:dsh-gemini-native-notice')
  const instance = createInstance()
  const panelEl = { focus({ preventScroll }) {
    assert.equal(preventScroll, true)
    env.mockDocument.activeElement = panelEl
  } }
  let model = 'gemini-4-neon'
  const renderNotice = (t = env.t, view = instance, sessionId = 'family-session') => {
    env.React.__beginRender(view)
    try {
      const tree = renderTree(notice.render({
        ...notice.meta.inject(sessionId), sessionId, t,
        useProjection: (key, select) => key === 'modelSelection' ? select({ next: { provider, model } }) : undefined,
      }))
      const [dialog] = findAll(tree, node => node.props?.role === 'dialog')
      if (dialog) dialog.props.ref.current = panelEl
      return tree
    } finally { env.React.__endRender(); env.React.__flushEffects(view) }
  }
  const action = (tree, key, t = env.t) => findAll(tree, node => node.type === 'button' && collectText(node).join('') === t(key))[0]
  const text = tree => collectText(tree).join(' ')
  const dot = tree => findAll(tree, node => node.props?.className === 'dsh-gn-dock-warn-dot').length
  const configure = (entry, state) => env.setConfig({ routes: { [provider]: entry }, showStatusNotice: true }, state)
  const write = () => JSON.parse(JSON.stringify(env.mutations.at(-1)))

  const pill = findAll(renderNotice(), node => node.props?.className === 'dsh-gn-dock-pill')[0]
  assert.equal(collectText(pill).join(''), '原生历史')
  pill.props.onClick()
  assert.equal(action(renderNotice(), 'diagFamilyEnable'), undefined, 'no telemetry yet')
  const [stream] = env.eventSources
  assert.equal(new URL(stream.url).searchParams.get('sessionId'), 'family-session')
  const emit = fields => stream.emit({ transport: { provider, model, status: 'ok', totalHistoryTurns: 8, replayedHistoryTurns: 0, ...fields } })
  const candidates = { crossModelCandidateTurns: 3 }

  for (const candidate of [undefined, null, 0, -1, 1.5, '3']) {
    emit({ crossModelCandidateTurns: candidate })
    assert.equal(action(renderNotice(), 'diagFamilyEnable'), undefined)
  }
  for (const eligible of ['gemini-4-carbon', 'gemini-4-argon', 'gemini-4-hydrogen', 'MODELS/GEMINI-4-NEON']) {
    model = eligible
    emit(candidates)
    assert.ok(action(renderNotice(), 'diagFamilyEnable'), eligible)
  }
  for (const ineligible of ['gemini-4', 'gemini-3-flash', 'gemini-4-neon-preview', 'gemini-4-carbon-image', 'gemini-4-argon.v1', 'gemini-4-hydrogen@latest']) {
    model = ineligible
    emit(candidates)
    assert.equal(action(renderNotice(), 'diagFamilyEnable'), undefined, ineligible)
  }
  model = 'gemini-4-neon'
  for (const scope of [{ provider: 'google' }, { model: 'gemini-4-hydrogen' }]) {
    emit({ ...candidates, ...scope })
    assert.equal(action(renderNotice(), 'diagFamilyEnable'), undefined)
  }
  emit(candidates)
  configure({ nativeHistory: false, googleSearch: true })
  assert.equal(action(renderNotice(), 'diagFamilyEnable'), undefined, 'parent off')
  configure({ nativeHistory: false, gemini4FamilyReplay: true })
  assert.equal(renderNotice(), null, 'the saved child alone does not activate the capsule')
  configure({}, { writable: false })
  assert.equal(action(renderNotice(), 'diagFamilyEnable'), undefined, 'read-only config')
  configure({}, { writable: true })
  const discover = renderNotice()
  const discoverAction = action(discover, 'diagFamilyEnable')
  assert.match(text(discover), /有 3 步来自其他 Gemini 4 模型.*所有会话生效，从下一次请求开始/u)
  const [riskId] = discoverAction.props['aria-describedby'].split(' ')
  assert.match(text(findAll(discover, node => node.props?.id === riskId)), /同一兼容上游.*混用上游可能报 HTTP 400/u)
  const englishDiscovery = renderNotice(env.tEn)
  assert.ok(action(englishDiscovery, 'diagFamilyEnable', env.tEn))
  assert.match(text(englishDiscovery), /same compatible upstream.*Mixed routing may return HTTP 400/u)
  assert.equal(await discoverAction.props.onClick(), true)
  const enabled = { localizePrompt: false, nativeHistory: true, googleSearch: false, gemini4FamilyReplay: true }
  const path = ['routes', provider]
  assert.deepEqual(write().ops, [{ op: 'set', path, value: enabled }])
  configure(enabled, { revision: 8 })
  assert.equal(action(renderNotice(), 'diagFamilyEnable'), undefined, 'already enabled')
  assert.equal(dot(renderNotice()), 0)

  const failed = { ...candidates, replayedHistoryTurns: 3, sameModelReplayedTurns: 0, crossModelReplayedTurns: 3 }
  for (const failure of [401, 403, 400]) {
    emit({ ...failed, upstreamStatus: failure, crossModelHttp400: false })
    assert.equal(dot(renderNotice()), 0, 'the generic upstream status is not evidence of a cross-model 400')
    assert.equal(action(renderNotice(), 'diagFamilyDisable'), undefined)
  }
  emit({ ...failed, crossModelHttp400: true, model: 'gemini-4-hydrogen' })
  assert.equal(dot(renderNotice()), 0, 'a prior model cannot light this model’s warning')
  emit({ ...failed, crossModelHttp400: true, error: 'do not show raw upstream error or signatures' })
  const warning = renderNotice()
  assert.equal(dot(warning), 1)
  const otherSession = createInstance()
  assert.equal(dot(renderNotice(env.t, otherSession, 'different-session')), 0)
  env.React.__unmount(otherSession)
  assert.ok(findAll(warning, node => node.props?.role === 'alert').some(node => text(node)
    === '本次请求携带了跨模型原生历史，上游返回 HTTP 400；签名可能不兼容，可关闭后重试。'))
  const englishWarning = renderNotice(env.tEn)
  assert.ok(findAll(englishWarning, node => node.props?.role === 'alert').some(node => text(node)
    === 'This request included cross-model native history and the upstream returned HTTP 400; thought signatures may be incompatible. Turn off cross-model replay and retry.'))
  assert.doesNotMatch(text(warning), /do not show raw/u)
  assert.ok(action(findAll(warning, node => node.props?.className === 'dsh-gn-diag-warn')[0], 'diagFamilyDisable'))
  assert.equal(action(warning, 'diagFamilyEnable'), undefined)
  configure(enabled, { writable: false })
  assert.equal(action(renderNotice(), 'diagFamilyDisable'), undefined)
  assert.equal(dot(renderNotice()), 1)
  configure(enabled, { writable: true })

  const close = action(renderNotice(), 'diagFamilyDisable')
  // Even the panel action must use the latest sibling options and revision.
  configure({ ...enabled, localizePrompt: true }, { revision: 9 })
  env.setConfigMutation(() => false)
  assert.equal(await close.props.onClick(), false)
  assert.deepEqual(write(), { ns: 'dsh-gemini-native', revision: 9, ops: [{
    op: 'set', path, value: { ...enabled, localizePrompt: true, gemini4FamilyReplay: false },
  }] })
  assert.match(text(renderNotice()), /设置已在别处更改/u)
  env.setConfigMutation(() => { throw new Error('private transport failure') })
  assert.equal(await action(renderNotice(), 'diagFamilyDisable').props.onClick(), false)
  assert.match(text(renderNotice()), /未能保存 Gemini Native 设置/u)
  assert.doesNotMatch(text(renderNotice()), /private transport failure/u)

  configure(enabled, { revision: 10 })
  let resolveWrite
  env.setConfigMutation(() => new Promise(resolve => { resolveWrite = resolve }))
  const saveAction = action(renderNotice(), 'diagFamilyDisable')
  env.mockDocument.activeElement = saveAction
  const pending = saveAction.props.onClick()
  assert.equal(env.mockDocument.activeElement, panelEl)
  const saving = renderNotice()
  assert.equal(action(saving, 'diagFamilyDisable').props.disabled, true)
  assert.equal(action(saving, 'diagFamilyDisable').props['aria-busy'], true)
  assert.match(text(saving), /保存中/u)
  assert.deepEqual(write().ops, [{ op: 'unset', path }])
  configure({}, { revision: 11 })
  resolveWrite(true)
  assert.equal(await pending, true)
  const manuallyRetry = renderNotice()
  assert.match(text(manuallyRetry), /签名可能不兼容。.*已为此供应商关闭跨模型互通，可以手动重试/u)
  assert.doesNotMatch(text(manuallyRetry), /可关闭后重试/u)
  assert.doesNotMatch(text(renderNotice(env.tEn)), /Turn off cross-model replay and retry/u)
  assert.equal(env.mockDocument.activeElement, panelEl)
  assert.equal(dot(manuallyRetry), 1, 'this is still the request that saw the 400')
  assert.equal(action(manuallyRetry, 'diagFamilyEnable'), undefined, 'do not nudge re-enable for the same error')
  assert.equal(action(manuallyRetry, 'diagFamilyDisable'), undefined)
  assert.equal(env.fetchCalls.length, 0, 'the diagnostic never resends a request')

  emit({ ...candidates, crossModelHttp400: false })
  const next = renderNotice()
  assert.equal(dot(next), 0)
  assert.equal(findAll(next, node => node.props?.role === 'alert').length, 0)
  assert.doesNotMatch(text(next), /本次请求携带了跨模型原生历史|手动重试/u)
  assert.ok(action(next, 'diagFamilyEnable'), 'only a later request may offer opt-in again')
  env.React.__unmount(instance)
  env.disposeEffects()
})

test('NativeStatusNotice focuses the portaled dialog, restores focus on Escape, and dismisses without stealing outside focus', async () => {
  const env = await loadClient({
    configValue: { routes: {} },
    supportsAnchor: false,
    viewportWidth: 470,
  })
  const noticeSlot = env.slots.get('conversation.composer.dock:dsh-gemini-native-notice')
  const instance = createInstance()
  const rootEl = {
    contains: target => target === triggerEl || target === 'inside-root',
    getBoundingClientRect: () => ({ left: 48, top: 640, right: 200, bottom: 664 }),
  }
  const triggerEl = { focus({ preventScroll }) {
    assert.equal(preventScroll, true)
    env.mockDocument.activeElement = triggerEl
  } }
  const panelEl = {
    contains: target => target === panelEl || target === 'inside-panel',
    focus({ preventScroll }) {
      assert.equal(preventScroll, true)
      env.mockDocument.activeElement = panelEl
    },
  }
  const outsideEl = {}

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
      const [trigger] = findAll(tree, n => n.props?.className === 'dsh-gn-dock-pill')
      trigger.props.ref.current = triggerEl
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
  assert.equal(dialog.props.style.left, '38px', 'leave space for a 420px panel and the right gutter')
  assert.equal(dialog.props.style.bottom, '168px')
  assert.equal(dialog.props.style.top, 'auto')
  assert.equal(dialog.props.tabIndex, -1)
  assert.equal(env.mockDocument.activeElement, panelEl)

  // Inside pointerdown / click keeps dialog open.
  env.mockDocument.dispatch('pointerdown', { target: 'inside-panel' })
  env.mockDocument.dispatch('click', { target: 'inside-root' }, { captureOnly: true })
  tree = renderNotice()
  assert.equal(findAll(tree, n => n.type === 'button')[0].props['aria-expanded'], true)

  // Capture-phase outside click (e.g. clicking sibling DSH pill) closes without grabbing focus.
  env.mockDocument.activeElement = outsideEl
  env.mockDocument.dispatch('click', { target: 'sibling-pill' }, { captureOnly: true })
  tree = renderNotice()
  assert.equal(findAll(tree, n => n.type === 'button')[0].props['aria-expanded'], false)
  assert.equal(env.mockDocument.activeElement, outsideEl)

  // Reopen, then outside pointerdown closes without a forced return.
  findAll(tree, n => n.type === 'button')[0].props.onClick()
  tree = renderNotice()
  assert.equal(findAll(tree, n => n.type === 'button')[0].props['aria-expanded'], true)
  env.mockDocument.activeElement = outsideEl
  env.mockDocument.dispatch('pointerdown', { target: 'outside-area' })
  tree = renderNotice()
  assert.equal(findAll(tree, n => n.type === 'button')[0].props['aria-expanded'], false)
  assert.equal(env.mockDocument.activeElement, outsideEl)

  // Escape closes and restores focus from inside. An outside keyboard focus stays outside.
  for (const focused of [panelEl, outsideEl]) {
    findAll(tree, n => n.type === 'button')[0].props.onClick()
    tree = renderNotice()
    assert.equal(findAll(tree, n => n.type === 'button')[0].props['aria-expanded'], true)
    env.mockDocument.activeElement = focused
    env.mockDocument.dispatch('keydown', { key: 'Escape' })
    tree = renderNotice()
    assert.equal(findAll(tree, n => n.type === 'button')[0].props['aria-expanded'], false)
    assert.equal(env.mockDocument.activeElement, focused === panelEl ? triggerEl : outsideEl)
  }

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

  const renderCard = (cards = durableCards) => {
    env.React.__beginRender(cardInst)
    try {
      return renderTree(turnSlot.render({
        sessionId: 'sess-live',
        turn: { turn: 3 },
        useProjection: (_key, select) => select({ 3: cards }),
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
  const [idle] = findAll(rowBtn, n => n.props?.className === 'dsh-gn-search-icon-idle')
  const [mark] = findAll(idle, n => n.type === 'svg')
  assert.equal(mark.props.viewBox, '0 0 20 20')
  assert.equal(mark.props.stroke, 'currentColor')
  assert.equal(mark.props['aria-hidden'], 'true')
  assert.equal(findAll(mark, n => n.type === 'path').length, 2)
  assert.equal(findAll(rowBtn, n => n.props?.className === 'dsh-gn-search-chevron-hover').length, 1)

  // Click row to expand body with query tags and <ol> sources.
  rowBtn.props.onClick()
  cardTree = renderCard()
  rowBtn = findAll(cardTree, n => n.type === 'button' && n.props.className === 'dsh-gn-search-row')[0]
  assert.equal(rowBtn.props['aria-expanded'], true)
  const [expandedIcon] = findAll(rowBtn, n => n.type === 'svg')
  assert.equal(expandedIcon.props.viewBox, '0 0 16 16')
  assert.equal(findAll(rowBtn, n => n.props?.className === 'dsh-gn-search-icon-idle').length, 0)
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

  const summaryOnly = renderCard([{ status: 'completed', queries: [], sources: [] }])
  assert.equal(findAll(summaryOnly, n => n.type === 'button').length, 0)
  const [summaryMark] = findAll(summaryOnly, n => n.type === 'svg')
  assert.deepEqual(summaryMark, mark)

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
