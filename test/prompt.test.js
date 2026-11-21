import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as plugin from '../index.js'
import { toolPrompts } from '../tool-prompts.js'

const identity = 'You are an AI agent powered by DeepSeek Harness.'
const persona = 'You are a coding agent powered by the {{model}} model.'
const fixture = Object.freeze({
  sections: Object.freeze([
    Object.freeze({ name: 'harness:identity', text: identity }),
    Object.freeze({ name: 'deployment:persona-prefix', text: persona, interpolate: true }),
    Object.freeze({ name: 'tool:bash', text: toolPrompts['tool:bash'][0][0] }),
    Object.freeze({ name: 'tool:read', text: 'Customized read policy' }),
    Object.freeze({ name: 'third-party', text: identity }),
  ]),
  contexts: Object.freeze([{ name: 'approval', text: 'Untranslated runtime context' }]),
  variables: Object.freeze({ model: 'diagnostic-only' }),
})

function intercept(raw) {
  let listener
  const config = plugin.Config(raw)
  plugin.apply({ on(event, fn) {
    assert.equal(event, 'system-prompt/assemble')
    listener = fn
  } }, config)
  return { listener, config }
}

function selection(provider, model = 'gemini-4-argon') {
  return { modelSelection: { provider, model } }
}

test('localizes only providers with localizePrompt enabled, regardless of model ID', async () => {
  const defaultOff = intercept({}).listener
  assert.strictEqual(await defaultOff(null, selection('google', 'gemini-4-argon'), () => fixture), fixture)

  const { listener } = intercept({
    routes: {
      google: { localizePrompt: true },
      'gemini-relay': { localizePrompt: true, nativeHistory: true },
      'history-only': { nativeHistory: true, googleSearch: true },
    },
  })
  for (const provider of ['google', 'gemini-relay']) {
    for (const model of ['gemini-4-argon', 'gemini-2.5-pro', 'custom-alias']) {
      let calls = 0
      const result = await listener(null, selection(provider, model), () => {
        calls += 1
        return Promise.resolve(fixture)
      })
      assert.equal(calls, 1)
      assert.equal(result.sections[0].text, '你是由 DeepSeek Harness 驱动的 AI 智能体。')
    }
  }
  for (const context of [
    selection('history-only', 'gemini-4-argon'),
    selection('openai', 'gemini-4-argon'),
    selection('', 'gemini-4-argon'),
    { agent: { options: { provider: 'google', model: 'gemini-4-argon' } } },
    {},
    undefined,
  ]) assert.strictEqual(await listener(null, context, () => fixture), fixture)
})

test('translates only exact built-in sections from the downstream presentation', async () => {
  const { listener } = intercept({ routes: { google: { localizePrompt: true } } })
  const result = await listener(null, selection('google', 'gemini-4-argon'), () => fixture)
  assert.deepEqual(result.sections.map(s => s.name), fixture.sections.map(s => s.name))
  assert.deepEqual(result.sections[1], {
    name: 'deployment:persona-prefix', text: '你是由 {{model}} 模型驱动的编程智能体。', interpolate: true,
  })
  assert.equal(result.sections[2].text, toolPrompts['tool:bash'][0][1])
  for (const i of [3, 4]) assert.strictEqual(result.sections[i], fixture.sections[i])
  assert.strictEqual(result.contexts, fixture.contexts)
  assert.strictEqual(result.variables, fixture.variables)
  assert.equal(fixture.sections[1].text, persona)
})

test('validates route config schema and keeps fields editable by DSH Settings', () => {
  assert.throws(() => plugin.Config({ routes: { google: { localizePrompt: 'yes' } } }))
  assert.throws(() => plugin.Config({ routes: { google: { nativeHistory: 1 } } }))
  assert.throws(() => plugin.Config({ routes: { google: { googleSearch: 'mixed' } } }))
  assert.equal(plugin.Config.dict.routes.meta.volatile, true)
  assert.equal(plugin.Config.dict.showStatusNotice.meta.volatile, true)
  const defaults = plugin.Config({})
  assert.deepEqual(defaults.routes.get(), {})
  assert.equal(defaults.showStatusNotice.get(), true)
  assert.deepEqual(plugin.routeConfigOf(defaults.routes.get(), 'google'), {
    localizePrompt: false,
    nativeHistory: true,
    googleSearch: false,
  })
  const configured = plugin.Config({ routes: { google: {}, disabled: { nativeHistory: false } } })
  assert.equal(configured.routes.get().google.nativeHistory, true)
  assert.equal(plugin.routeConfigOf(configured.routes.get(), 'disabled').nativeHistory, false)
})

const installed = process.env.DSH_INSTALL_DIR

test('installed DSH: mount from bundle patch, render, update per-provider routes live, and unload', { skip: !installed }, async (t) => {
  const require = createRequire(join(installed, 'package.json'))
  const load = spec => import(pathToFileURL(require.resolve(spec)).href)
  const { Context } = await load('@deepseek-ai/cordis')
  const { SystemPrompt, renderPrompt } = await load('@deepseek-ai/dsh-system-prompt')
  const { SettingsForms } = await load('@deepseek-ai/dsh-settings')
  const { default: yaml } = await load('js-yaml')
  const [patch] = yaml.load(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'))
  const [row] = patch.insert
  assert.equal(row.id, 'dsh-gemini-native')
  assert.equal(row.name, 'dsh-gemini-native')
  const module = await import(row.name) // Resolve via the package's own exports.
  const ctx = new Context()
  const system = ctx.plugin(SystemPrompt, { personaPrefix: persona })
  t.after(() => system.dispose())
  await system
  ctx.systemPrompt.variable('model', context => context.modelSelection?.model)
  ctx.systemPrompt.tools(() => ({ schemas: [{ name: 'read', description: 'Original tool', parameters: {} }] }))
  ctx.systemPrompt.context({ name: 'approval', order: 100, text: 'Original context' })
  const mounted = ctx.plugin(module, row.config)
  t.after(() => mounted.dispose())
  await mounted

  // UI status is on by default, while prompt localization remains opt-in.
  assert.match(renderPrompt(await ctx.systemPrompt.assemble(selection('google', 'gemini-4-argon'))), /^You are/u)

  // Use the real Settings service and an in-memory ConfigEditor so this
  // integration exercises the Web write contract (set + unset) without editing a profile.
  ctx.provide('loader', { await: async () => {} })
  ctx.provide('profileContext', { home: fileURLToPath(new URL('./', import.meta.url)) })
  const entry = { id: row.id, options: { id: row.id, config: row.config }, fiber: mounted }
  ctx.provide('configEditor', {
    entries: () => [entry],
    configuration: () => [{ entry, inherited: {}, override: entry.options.config }],
    async edit(_, change) {
      const next = change(structuredClone(entry.options.config), {})
      await mounted.update(next)
      entry.options.config = next
    },
  })
  const settings = ctx.plugin(SettingsForms)
  t.after(() => settings.dispose())
  await settings
  const [form] = ctx.settings.describe()
  assert.equal(form.ns, row.id)
  assert.deepEqual(form.value, { routes: {}, showStatusNotice: true })

  const enableOps = [
    { op: 'set', path: ['routes', 'gemini-relay'], value: { localizePrompt: true, nativeHistory: true, googleSearch: false } },
    { op: 'set', path: ['showStatusNotice'], value: false },
  ]
  await ctx.settings.mutate(row.id, enableOps, form.revision)
  const afterEnable = ctx.settings.describe()[0]
  assert.deepEqual(afterEnable.value, {
    routes: { 'gemini-relay': { localizePrompt: true, nativeHistory: true, googleSearch: false } },
    showStatusNotice: false,
  })
  await assert.rejects(ctx.settings.mutate(row.id, enableOps, form.revision), /revision/i)

  const localized = await ctx.systemPrompt.assemble(selection('gemini-relay', 'gemini-4-argon'))
  assert.match(renderPrompt(localized), /你是由 gemini-4-argon 模型驱动的编程智能体。/u)
  assert.equal(localized.tools[0].description, 'Original tool')
  assert.equal(localized.contexts[0].text, 'Original context')
  assert.match(renderPrompt(await ctx.systemPrompt.assemble(selection('other-provider', 'gemini-4-argon'))), /^You are/u)

  const complete = ctx.systemPrompt.section({ name: 'custom', order: 0, text: 'Complete custom prompt', complete: true })
  assert.equal(renderPrompt(await ctx.systemPrompt.assemble(selection('gemini-relay', 'gemini-4-argon'))), 'Complete custom prompt')
  complete()

  // Clearing a route via unset restores default English prompt cleanly.
  await ctx.settings.mutate(row.id, [{ op: 'unset', path: ['routes', 'gemini-relay'] }], afterEnable.revision)
  assert.deepEqual(ctx.settings.describe()[0].value, { routes: {}, showStatusNotice: false })
  assert.match(renderPrompt(await ctx.systemPrompt.assemble(selection('gemini-relay', 'gemini-4-argon'))), /^You are/u)

  // Re-enable then unload plugin to verify disposal cleans up listeners.
  const latest = ctx.settings.describe()[0]
  await ctx.settings.mutate(row.id, [{ op: 'set', path: ['routes', 'gemini-relay'], value: { localizePrompt: true, nativeHistory: false, googleSearch: false } }], latest.revision)
  assert.match(renderPrompt(await ctx.systemPrompt.assemble(selection('gemini-relay', 'gemini-4-argon'))), /你是由 gemini-4-argon 模型/u)
  await mounted.dispose()
  assert.match(renderPrompt(await ctx.systemPrompt.assemble(selection('gemini-relay', 'gemini-4-argon'))), /^You are/u)
})
