import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'

function createReactStub() {
  return {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat() }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useRef(initial) {
      return { current: initial }
    },
    useEffect() {},
    useCallback(fn) {
      return fn
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot()
    },
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

async function loadClient({ configValue = { routes: {}, showStatusNotice: false }, modelsValue = { providers: {} } } = {}) {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const React = createReactStub()
  let registeredModule
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
    EventSource: class { close() {} },
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
  const makeForm = (ns, getValue) => ({
    subscribe: () => () => {},
    getSnapshot: () => ({ status: 'ready', writable: true, revision: 7, value: getValue() }),
    async mutate(ops, revision) {
      mutations.push({ ns, ops, revision })
      return true
    },
  })
  const ctx = {
    effect(fn) { fn() },
    locale: { register(ns, dicts) { locales = { ns, dicts }; return () => {} } },
    configForms: {
      get(ns) {
        if (ns === 'dsh-gemini-enhancement') return makeForm(ns, () => configValue)
        if (ns === 'llm-pi-ai') return makeForm(ns, () => modelsValue)
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
      fn({
        modelDirectories: {
          directoryFor() {
            return { store: { subscribe: () => () => {}, getSnapshot: () => ({ current: { provider: 'google', model: 'gemini-4' } }) } }
          },
        },
        slots: ctx.slots,
      })
    },
  }
  plugin.apply(ctx)
  const t = key => locales.dicts.zh[key] ?? key
  return { slots, mutations, t, setConfig(v) { configValue = v }, setModels(v) { modelsValue = v } }
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
