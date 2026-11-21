import Schema from '@deepseek-ai/schemastery'
import { toolPrompts } from './tool-prompts.js'
import { localizationNotice } from './notice.js'
import { geminiTransport } from './gemini-transport.js'
import { googleSearchActivity } from './google-search-activity.js'
import { hasNativeReplay } from './generate-content.js'
import { nativeSearchProjection } from './native-search-projection.js'
import { webSearchScope } from './web-search-scope.js'
import { xhighState } from './xhigh.js'

export const inject = ['systemPrompt']

export const RouteConfig = Schema.object({
  localizePrompt: Schema.boolean().default(false)
    .description('Localize known DSH system prompts into Simplified Chinese on this Gemini provider.'),
  nativeHistory: Schema.boolean().default(false)
    .description('Preserve and replay Gemini native parts (signatures, server-side tool parts, opaque fields) on this route.'),
  googleSearch: Schema.boolean().default(false)
    .description('Replace DSH web_search with native Google Search alongside local functions on this Gemini route.'),
})

export const Config = Schema.object({
  // The DSH Settings service only exposes volatile fields to Web forms.
  routes: Schema.dict(RouteConfig).default({})
    .description('Per-provider Gemini enhancements configured on Gemini API routes.').volatile(),
  showStatusNotice: Schema.boolean().default(false)
    .description('Show a subtle composer notice for active Gemini enhancements.').volatile(),
})

export function routeConfigOf(routes, provider) {
  const entry = typeof provider === 'string' && provider.length > 0 && routes && Object.hasOwn(routes, provider)
    ? routes[provider]
    : undefined
  return {
    localizePrompt: entry?.localizePrompt === true,
    nativeHistory: entry?.nativeHistory === true,
    googleSearch: entry?.googleSearch === true,
  }
}

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
  const reportFor = (sessionId, liveOnly = false) => observerFor?.reportFor(sessionId, liveOnly)
  const xhigh = ctx.inject ? xhighState(ctx) : undefined
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
  ctx.inject?.(['llm', 'loader'], child => geminiTransport(child, config, routeConfigOf, reportFor, sessionId => xhigh.isEnabled(sessionId)))
  ctx.inject?.(['tools', 'agents'], child => webSearchScope(ctx, child, config, routeConfigOf))
  ctx.inject?.(['connection'], (child) => {
    notice = localizationNotice(child, config, routeConfigOf)
    observerFor = googleSearchActivity(child)
    child.effect(() => () => { notice = undefined; observerFor = undefined })
  })
  ctx.on('system-prompt/assemble', async (_presentation, context, next) => {
    // Scope prompt localization to the exact Gemini provider selected for this step.
    const provider = context?.modelSelection?.provider
    const enabled = routeConfigOf(config.routes.get(), provider).localizePrompt
    const presentation = await next()
    const localized = enabled ? localizeSections(presentation) : presentation
    notice?.remember(context, provider, localized === presentation ? undefined : localized)
    return localized
  })
}
