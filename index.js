import Schema from '@deepseek-ai/schemastery'
import { toolPrompts } from './tool-prompts.js'
import { localizationNotice } from './notice.js'
import { googleSearch } from './google-search.js'
import { googleSearchActivity } from './google-search-activity.js'
import { hasNativeReplay } from './generate-content.js'
import { nativeSearchProjection } from './native-search-projection.js'

export const inject = ['systemPrompt']

const defaultModelIds = ['gemini-4', 'gemini-4-*', 'gemini-4.*']

export const Config = Schema.object({
  // The DSH Settings service only exposes volatile fields to Web forms.
  modelPageRoutes: Schema.dict(Schema.union(['standard', 'off', 'search-only', 'mixed'])).default({})
    .description('Experimental native parts replay and Google Search mode for Gemini API routes served by llm-pi-ai.').volatile(),
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

export function apply(ctx, config) {
  let observerFor
  let notice
  const reportFor = sessionId => observerFor?.reportFor(sessionId, true)
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
  ctx.inject?.(['llm', 'loader'], child => googleSearch(child, config, matchesModelId, id => observerFor?.(id), reportFor))
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
