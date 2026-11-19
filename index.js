import Schema from '@deepseek-ai/schemastery'
import { toolPrompts } from './tool-prompts.js'
import { localizationNotice } from './notice.js'
import { googleSearch } from './google-search.js'
import { googleSearchActivity } from './google-search-activity.js'
import { createGenerateContentAdapter } from './generate-content-adapter.js'
import { generateContentApi, hasNativeReplay, modelIdPattern } from './generate-content.js'
import { nativeSearchProjection } from './native-search-projection.js'
import { modelPageNative } from './model-page-native.js'

export const inject = ['systemPrompt']

const defaultModelIds = ['gemini-4', 'gemini-4-*', 'gemini-4.*']
const nativeModel = Schema.object({
  id: Schema.string().required().pattern(modelIdPattern),
  name: Schema.string().min(1),
  contextWindow: Schema.natural().min(1),
  maxTokens: Schema.natural().min(1),
  thinkingLevels: Schema.array(Schema.union(['minimal', 'low', 'medium', 'high'])).default([]),
})
const nativeRoute = Schema.object({
  api: Schema.const(generateContentApi).required(),
  displayName: Schema.string().min(1),
  baseURL: Schema.string().required(),
  apiKeyEnv: Schema.string().required().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/u),
  search: Schema.union(['off', 'search-only', 'mixed']).default('off'),
  streamIdleTimeoutMs: Schema.natural().min(1).max(2_147_483_647).default(300_000),
  models: Schema.array(nativeModel).min(1).required(),
})

export const Config = Schema.object({
  generateContentRoutes: Schema.dict(nativeRoute).default({})
    .description('Opt-in GenerateContent routes with ordered native parts replay. Use provider IDs not already registered by DSH.'),
  modelPageRoutes: Schema.dict(Schema.union(['standard', 'off', 'search-only', 'mixed'])).default({})
    .description('Experimental native mode for existing custom Gemini API routes. Does not store credentials or routes.').volatile(),
  // The DSH Settings service only exposes volatile fields to Web forms.
  modelIds: Schema.array(Schema.string().required().pattern(/^[^\s*]+\*?$/u))
    .default(defaultModelIds)
    .description('Model IDs to localize and, if enabled on a Gemini route, ground with Google Search. Use an exact ID or a trailing *.')
    .volatile(),
  enableGoogleSearch: Schema.boolean().default(false)
    .description('Enable experimental native Google Search in matching Gemini conversation requests.').volatile(),
  showLocalizationNotice: Schema.boolean().default(false)
    .description('Show a composer notice only for confirmed system prompt localization.').volatile(),
})

const codingPersona = 'You are a coding agent powered by the {{model}} model.'
const codingPersonaZh = '你是由 {{model}} 模型驱动的编程智能体。'
const creatorPersona = 'You help the user customize DeepSeek Harness itself.'
const creatorPersonaZh = '你帮助用户定制 DeepSeek Harness 本身。'

// Match both section name and complete source text: preset/third-party overrides
// and changed upstream instructions must not be replaced by a stale translation.
const translations = new Map(Object.entries({
  'harness:identity': [[
    'You are an AI agent powered by DeepSeek Harness.',
    '你是由 DeepSeek Harness 驱动的 AI 智能体。',
  ]],
  'deployment:persona-prefix': [
    [codingPersona, codingPersonaZh],
    [`${codingPersona} ${creatorPersona}`, `${codingPersonaZh}${creatorPersonaZh}`],
  ],
  'context:file-reference': [[
    'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. A trailing slash marks a directory: list it when its contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading. @"..." quotes a path containing spaces.',
    '以 @ 开头的标记是用户明确引用的路径。相对路径以工作区根目录为基准；绝对路径指向宿主机上的文件或目录。以斜杠结尾表示目录：需要了解内容时，列出目录中的条目。其余路径均表示文件：需要内容时用 read 工具读取，未读取前不要声称已查看。含空格的路径用 @"..." 引用。',
  ]],
  ...toolPrompts,
}).map(([name, variants]) => [name, new Map(variants)]))

function matchesModelId(modelId, rules) {
  return typeof modelId === 'string' && modelId.length !== 0 && rules.some(rule => rule.endsWith('*')
    ? modelId.startsWith(rule.slice(0, -1))
    : modelId === rule)
}

function localizeSections(presentation) {
  let changed = false
  const sections = presentation.sections.map(section => {
    const text = translations.get(section.name)?.get(section.text)
    if (text === undefined) return section
    changed = true
    return { ...section, text }
  })
  return changed ? { ...presentation, sections } : presentation
}

function mountedLlm(ctx) {
  for (const id of ['include:llm', 'llm']) {
    try {
      const module = ctx.loader?.resolve(id)?.moduleNamespace
      if (typeof module?.isAgentLoopRequest === 'function') return module
    } catch { /* The active Loader may use the other entry ID. */ }
  }
}

export function apply(ctx, config) {
  let observerFor
  let notice
  const providers = Object.keys(config.generateContentRoutes ?? {})
  const reportFor = sessionId => observerFor?.reportFor(sessionId, true)
  if (providers.length) ctx.inject?.(['llm', 'credentials'], child => {
    const adapter = createGenerateContentAdapter(config.generateContentRoutes, {
      resolveCredential: async reference => (await child.credentials.resolve(reference))?.value,
      attribution: mountedLlm(child)?.attributionHeaders?.(),
      reportFor,
    })
    child.llm.registerAdapter(providers, adapter)
  })
  ctx.inject?.(['llm', 'loader', 'settings', 'credentials'], child => modelPageNative(child, config, mountedLlm, reportFor))
  ctx.inject?.(['sessionProjections'], child => {
    child.effect(async () => {
      const handle = await child.sessionProjections.register(nativeSearchProjection)
      return () => handle.dispose()
    })
  })
  ctx.inject?.(['sessionLogDeepSeek', 'sessions'], child => {
    const checked = new WeakMap()
    child.sessionLogDeepSeek.registerExclusion(({ sessionId }) => {
      const session = child.sessions.get(sessionId)
      if (!session) return false
      const previous = checked.get(session)
      if (previous?.native) return true
      const native = session.snapshotEvents(previous?.cursor ?? 0).some(hasNativeReplay)
      checked.set(session, { cursor: session.seq, native })
      return native
    })
  })
  ctx.inject?.(['llm', 'loader'], child => googleSearch(child, config, matchesModelId, id => observerFor?.(id), providers))
  ctx.inject?.(['connection'], (child) => {
    notice = localizationNotice(child, config, matchesModelId)
    observerFor = googleSearchActivity(child)
    child.effect(() => () => { notice = undefined; observerFor = undefined })
  })
  ctx.on('system-prompt/assemble', async (_presentation, context, next) => {
    // Read the same captured selection the agent loop uses for this step. Do not
    // infer a model from the provider, display name, agent defaults or variables.
    const model = context?.modelSelection?.model
    const matches = matchesModelId(model, config.modelIds.get())
    const presentation = await next()
    const localized = matches ? localizeSections(presentation) : presentation
    notice?.remember(context, model, localized === presentation ? undefined : localized)
    return localized
  })
}
