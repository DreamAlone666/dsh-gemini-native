import { createGenerateContentAdapter } from './generate-content-adapter.js'
import { generateContentApi, isModelId, isObject } from './generate-content.js'

export const piSettingsNamespace = 'llm-pi-ai'
const refPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u
const nativeModes = new Set(['off', 'search-only', 'mixed'])
const wireLevels = new Set(['minimal', 'low', 'medium', 'high'])
const blocksByRole = {
  user: new Set(['text']), tool: new Set(['text']), system: new Set(['text']),
  assistant: new Set(['text', 'reasoning', 'tool-call']),
  developer: new Set(['text', 'tool-addition', 'tool-removal']),
}

function canTakeHistory(request) {
  const unmatched = new Set()
  for (const message of request.messages) {
    const types = blocksByRole[message.role]
    if (!(types instanceof Set) || !message.content.every(block => types.has(block.type))) return false
    if (message.role === 'tool') {
      if (!unmatched.delete(message.toolCallId)) return false
      continue
    }
    if (message.role === 'system' || message.role === 'developer') continue
    if (unmatched.size) return false
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type !== 'tool-call') continue
      if (unmatched.has(block.id)) return false
      unmatched.add(block.id)
    }
    // Don't choose the experimental path when it would strip live same-model
    // Pi signatures from signed history. Start it on a new conversation.
    const replay = message.source?.replayState
    if (message.source?.provider === request.provider && message.source.model === request.model
      && replay?.response?.kind === 'pi-ai' && replay.response.api === generateContentApi
      && replay.blocks?.some(block => block?.thoughtSignature || block?.textSignature || block?.thinkingSignature)) return false
  }
  // Pi handles interrupted tool groups. Don't promise to serialize those itself.
  return !unmatched.size
}

function isEmpty(value) {
  return value == null || (isObject(value) && Object.values(value).every(isEmpty))
}

/** Read the resolved values already owned by the Models form, not a parallel profile or key. */
function capture(ctx, request, search) {
  if (!nativeModes.has(search) || !isModelId(request.model) || !canTakeHistory(request)) return undefined
  const owned = ctx.llm.listConfigurableProviders().some(row => row.provider === request.provider && row.declared === true
    && row.error === undefined && row.settingsNs === piSettingsNamespace && row.settingsPath.length === 2
    && row.settingsPath[0] === 'providers' && row.settingsPath[1] === request.provider)
  if (!owned || !ctx.llm.listProviders().some(row => row.id === request.provider)) return undefined
  const section = ctx.settings.describe({ redactSecrets: true }).find(entry => entry.ns === piSettingsNamespace)
  const profiles = section?.value?.providers
  if (!isObject(profiles) || !Object.hasOwn(profiles, request.provider)) return undefined
  const profile = profiles[request.provider]
  if (!isObject(profile) || profile.api !== generateContentApi || typeof profile.baseURL !== 'string'
    || typeof profile.apiKeyEnv !== 'string' || !refPattern.test(profile.apiKeyEnv)
    || !isEmpty(profile.headers) || !isEmpty(profile.compat) || !isEmpty(profile.thinkingBudgets)
    || (profile.transport != null && profile.transport !== 'auto' && profile.transport !== 'sse')
    || profile.timeoutMs != null) return undefined
  const model = profile.models?.find?.(entry => entry?.id === request.model)
  if (!model || !isEmpty(model.compat)) return undefined
  let reasoningEffort
  if (request.reasoningEffort !== undefined) {
    const mapping = model.reasoningEfforts
    if (!(isObject(mapping) && Object.hasOwn(mapping, request.reasoningEffort))) return undefined
    const mapped = mapping[request.reasoningEffort]
    if (mapped === null && request.reasoningEffort === 'off') reasoningEffort = undefined
    else if (typeof mapped === 'string' && wireLevels.has(mapped.toLowerCase())) reasoningEffort = mapped.toLowerCase()
    else return undefined
  }
  return {
    route: { api: profile.api, baseURL: profile.baseURL, apiKeyEnv: profile.apiKeyEnv, search,
      streamIdleTimeoutMs: Number.isFinite(profile.streamIdleTimeoutMs) && profile.streamIdleTimeoutMs > 0
        ? profile.streamIdleTimeoutMs : undefined,
      models: [{ id: model.id }] },
    reasoningEffort,
  }
}

/** Leave registration and model preparation with Pi; opt in only at its conversation stream seam. */
export function modelPageNative(ctx, config, readLlmExports, reportFor) {
  ctx.on('llm/stream', (request, next) => {
    if (request.purpose !== undefined || !request.sessionId) return next()
    const modes = config.modelPageRoutes.get()
    if (!modes || !Object.hasOwn(modes, request.provider) || !nativeModes.has(modes[request.provider])) return next()
    const llm = readLlmExports(ctx)
    if (!llm?.isAgentLoopRequest?.(request)) return next()
    let selected
    let adapter
    try {
      selected = capture(ctx, request, modes[request.provider])
      if (selected) {
        adapter = createGenerateContentAdapter({ [request.provider]: selected.route }, {
          resolveCredential: async reference => (await ctx.credentials.resolve(reference))?.value,
          attribution: llm.attributionHeaders?.(),
          reportFor,
        })
      }
    } catch {
      // Schema drift or malformed metadata can't change how an existing route
      // is served. Only fall back before dispatch, never retry a sent request.
      return next()
    }
    if (!adapter) return next()
    const { reasoningEffort: _reasoningEffort, ...base } = request
    return adapter.stream({ ...base, ...selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort } })
  })
}
