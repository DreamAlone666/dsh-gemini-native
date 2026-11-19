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

function selection(model, provider = 'different-provider') {
  return { modelSelection: { model, provider } }
}

test('localizes Gemini 4 only, using the captured model regardless of provider', async () => {
  const { listener } = intercept({})
  for (const model of ['gemini-4', 'gemini-4-argon', 'gemini-4-hydrogen-preview', 'gemini-4.1-pro']) {
    for (const provider of ['google', 'gateway', undefined]) {
      let calls = 0
      const result = await listener(null, selection(model, provider), () => {
        calls += 1
        return Promise.resolve(fixture)
      })
      assert.equal(calls, 1)
      assert.equal(result.sections[0].text, '你是由 DeepSeek Harness 驱动的 AI 智能体。')
    }
  }
  for (const context of [
    selection('gemini-3.5-flash-lite', 'gemini-4-argon'), selection('gpt-6.2-sol', 'google'),
    selection('gemini-40-argon'), selection('Gemini-4-Argon'), selection('google/gemini-4-argon'),
    { agent: { options: { model: 'gemini-4-argon' } } }, {}, undefined,
  ]) assert.strictEqual(await listener(null, context, () => fixture), fixture)
})

test('translates only exact built-in sections from the downstream presentation', async () => {
  const { listener } = intercept({})
  const result = await listener(null, selection('gemini-4-argon'), () => fixture)
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

test('matches configured exact IDs, prefixes, and namespaced IDs without touching provider', async () => {
  const { listener } = intercept({ modelIds: ['alt-gemini', 'models/gemini-4-*'] })
  for (const model of ['alt-gemini', 'models/gemini-4-argon']) {
    assert.notStrictEqual(await listener(null, selection(model), () => fixture), fixture)
  }
  for (const model of ['alt-gemini-preview', 'gemini-4-argon', 'google/models/gemini-4-argon']) {
    assert.strictEqual(await listener(null, selection(model, 'alt-gemini'), () => fixture), fixture)
  }
  const none = intercept({ modelIds: [] }).listener
  assert.strictEqual(await none(null, selection('gemini-4-argon'), () => fixture), fixture)
})

test('rejects malformed model rules and keeps the array editable by DSH Settings', () => {
  for (const rule of ['', '*', 'gemini-*preview', 'gemini-**', 'a b', 'gemini-4\n', 42]) {
    assert.throws(() => plugin.Config({ modelIds: [rule] }), `rule should be rejected: ${JSON.stringify(rule)}`)
  }
  assert.equal(plugin.Config.dict.modelIds.meta.volatile, true)
  assert.equal(plugin.Config.dict.showLocalizationNotice.meta.volatile, true)
  assert.equal(plugin.Config.dict.enableGoogleSearch.meta.volatile, true)
  assert.equal(plugin.Config({}).enableGoogleSearch.get(), false)
  assert.equal(plugin.Config({}).showLocalizationNotice.get(), false)
  assert.deepEqual(plugin.Config({}).modelIds.get(), ['gemini-4', 'gemini-4-*', 'gemini-4.*'])
})

const installed = process.env.DSH_INSTALL_DIR

test('installed DSH: mount from bundle patch, render, update matches live, and unload', { skip: !installed }, async (t) => {
  const require = createRequire(join(installed, 'package.json'))
  const load = spec => import(pathToFileURL(require.resolve(spec)).href)
  const { Context } = await load('@deepseek-ai/cordis')
  const { SystemPrompt, renderPrompt } = await load('@deepseek-ai/dsh-system-prompt')
  const { SettingsForms } = await load('@deepseek-ai/dsh-settings')
  const { default: yaml } = await load('js-yaml')
  const [patch] = yaml.load(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'))
  const [row] = patch.insert
  assert.equal(row.id, 'dsh-gemini-enhancement')
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

  const gemini = await ctx.systemPrompt.assemble(selection('gemini-4-argon', 'openai-compatible'))
  assert.match(renderPrompt(gemini), /你是由 gemini-4-argon 模型驱动的编程智能体。/u)
  assert.equal(gemini.tools[0].description, 'Original tool')
  assert.equal(gemini.contexts[0].text, 'Original context')
  assert.match(renderPrompt(await ctx.systemPrompt.assemble(selection('gpt-6.2-sol', 'gemini-4'))), /^You are/u)

  const complete = ctx.systemPrompt.section({ name: 'custom', order: 0, text: 'Complete custom prompt', complete: true })
  assert.equal(renderPrompt(await ctx.systemPrompt.assemble(selection('gemini-4-argon'))), 'Complete custom prompt')
  complete()

  // Use the real Settings service and an in-memory ConfigEditor so this
  // integration exercises the Web write contract without editing a profile.
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
  assert.deepEqual(form.value, { modelPageRoutes: {}, modelIds: ['gemini-4', 'gemini-4-*', 'gemini-4.*'], showLocalizationNotice: false, enableGoogleSearch: false })
  const rules = [
    { op: 'set', path: ['modelIds'], value: ['my-gemini-alias'] },
    { op: 'set', path: ['showLocalizationNotice'], value: true },
    { op: 'set', path: ['enableGoogleSearch'], value: true },
  ]
  await ctx.settings.mutate(row.id, rules, form.revision)
  assert.deepEqual(ctx.settings.describe()[0].value, { modelPageRoutes: {}, modelIds: ['my-gemini-alias'], showLocalizationNotice: true, enableGoogleSearch: true })
  await assert.rejects(ctx.settings.mutate(row.id, rules, form.revision), /revision/i)
  assert.match(renderPrompt(await ctx.systemPrompt.assemble(selection('gemini-4-argon'))), /^You are/u)
  assert.match(renderPrompt(await ctx.systemPrompt.assemble(selection('my-gemini-alias'))), /你是由 my-gemini-alias 模型/u)
  await mounted.dispose()
  assert.match(renderPrompt(await ctx.systemPrompt.assemble(selection('my-gemini-alias'))), /^You are/u)
})
