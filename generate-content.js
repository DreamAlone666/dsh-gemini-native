import { createHash } from 'node:crypto'

export const generateContentApi = 'google-generative-ai'
const replayKind = 'dsh-gemini-generate-content'
const replayVersion = 1
const nativeKeys = ['toolCall', 'toolResponse', 'executableCode', 'codeExecutionResult']

export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export const modelIdPattern = /^(?:models\/|tunedModels\/)?[\w.-]+$/u
export const isModelId = model => typeof model === 'string' && modelIdPattern.test(model)
  && !model.split('/').some(segment => segment === '.' || segment === '..')

export function normalizeEndpoint(value) {
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('GenerateContent baseURL must be an HTTP(S) API root without credentials, query or fragment')
  }
  return url.href.replace(/\/+$/u, '')
}

export function generationEndpoint(baseURL, model) {
  if (!isModelId(model)) throw new Error('Invalid GenerateContent model ID')
  const resource = model.includes('/') ? model : `models/${model}`
  return `${baseURL}/${resource}:streamGenerateContent?alt=sse`
}

export function routeIdentity(route) {
  return createHash('sha256').update(JSON.stringify([generateContentApi, route.baseURL, route.credential, route.search])).digest('hex')
}

export function historyFingerprint(contents, systemParts = []) {
  return createHash('sha256').update(JSON.stringify([systemParts, contents])).digest('hex')
}

export function makeReplayState(route, model, frames, callIds, outcome, prefix) {
  return { response: {
    kind: replayKind, version: replayVersion, route: route.identity, model, prefix, frames, callIds, outcome,
  } }
}

export function readNativeReplay(envelope) {
  const data = envelope?.response
  if (data?.kind !== replayKind || data.version !== replayVersion || !Array.isArray(data.frames)
    || !Array.isArray(data.callIds)) return
  return data
}

function nativeEnvelopeOf(event) {
  if (event.type === 'assistant/message') {
    const envelope = event.data.message.source?.replayState
    if (envelope?.response?.kind === replayKind) return envelope
  } else if (event.type !== 'assistant/attempt') return
  const last = event.data.stream?.at(-1)
  if (last?.type === 'chunk' && last.chunk.type === 'finish'
    && last.chunk.replayState?.response?.kind === replayKind) return last.chunk.replayState
}

/** Read a commitment or a settled failed attempt, not a live chunk. */
export const nativeReplayOf = event => readNativeReplay(nativeEnvelopeOf(event))
export const hasNativeReplay = event => nativeEnvelopeOf(event) !== undefined

// Candidate zero may not be the first entry of a later streamed frame.
export function selectedCandidate(candidates) {
  if (!Array.isArray(candidates)) return
  return candidates.find(candidate => candidate?.index === 0)
    ?? (candidates[0]?.index === undefined ? candidates[0] : undefined)
}

// Store every candidate's content in order, but never mix alternate candidates
// into the selected output or its subsequent model history.
export function responseFrame(payload) {
  if (!Array.isArray(payload.candidates)) return
  return payload.candidates.map(candidate => candidate == null ? null : {
    ...candidate.index === undefined ? {} : { index: candidate.index },
    ...candidate.content === undefined ? {} : { content: candidate.content },
    ...candidate.groundingMetadata === undefined ? {} : { groundingMetadata: candidate.groundingMetadata },
    ...candidate.finishReason === undefined ? {} : { finishReason: candidate.finishReason },
  })
}

function nativeHistory(message, route, request, contents, systemParts) {
  if (request.purpose !== undefined || message.source?.provider !== request.provider || message.source?.model !== request.model) return
  const state = readNativeReplay(message.source.replayState)
  if (!state || state.model !== request.model || state.route !== route.identity || state.outcome !== 'complete'
    || state.prefix !== historyFingerprint(contents, systemParts)) return
  const rawParts = []
  for (const frame of state.frames) {
    if (!Array.isArray(frame)) return
    const content = selectedCandidate(frame)?.content
    if (content === undefined) continue
    if (!isObject(content) || (content.role !== undefined && content.role !== 'model') || !Array.isArray(content.parts)) return
    for (const part of content.parts) {
      if (!isObject(part)) return
      rawParts.push(part)
    }
  }
  if (!rawParts.length || (route.search !== 'mixed' && rawParts.some(part => nativeKeys.some(key => Object.hasOwn(part, key))))) return
  const displayed = rawParts.flatMap(part => typeof part.text === 'string' && part.text.length
    ? [{ type: part.thought === true ? 'reasoning' : 'text', text: part.text }] : [])
  const stored = message.content.filter(block => block.type === 'reasoning' || block.type === 'text')
  if (displayed.length !== stored.length || displayed.some((block, i) => block.type !== stored[i].type || block.text !== stored[i].text)) return
  const local = message.content.filter(block => block.type === 'tool-call')
  const calls = rawParts.filter(part => part.functionCall !== undefined)
  if (local.length !== state.callIds.length || calls.length !== local.length) return
  for (let i = 0; i < local.length; i++) {
    const original = calls[i].functionCall
    if (!isObject(original) || original.name !== local[i].name || local[i].id !== state.callIds[i]
      || JSON.stringify(original.args ?? {}) !== local[i].arguments) return
  }
  return { parts: rawParts, calls, local }
}

function textParts(message) {
  return message.content.filter(block => block.type === 'text' && block.text).map(block => ({ text: block.text }))
}

function neutralCall(block) {
  let args
  try { args = JSON.parse(block.arguments) } catch { args = {} }
  return { functionCall: { id: block.id, name: block.name, args: isObject(args) ? args : {} } }
}

/** Serialize current model-visible DSH history; never resurrect compacted messages. */
export function makePayload(request, route) {
  const contents = []
  const systems = [
    ...request.system ? [{ text: request.system }] : [],
    ...request.messages.flatMap(message => ['system', 'developer'].includes(message.role) ? textParts(message) : []),
  ]
  let calls = new Map()
  let requiresCirculation = false
  for (const message of request.messages) {
    if (message.role === 'system' || message.role === 'developer') continue
    if (message.role === 'assistant') {
      const native = nativeHistory(message, route, request, contents, systems)
      calls = new Map()
      let parts
      if (native) {
        parts = native.parts
        requiresCirculation ||= parts.some(part => nativeKeys.some(key => Object.hasOwn(part, key)))
        for (let i = 0; i < native.local.length; i++) {
          const { id, name } = native.calls[i].functionCall
          calls.set(native.local[i].id, { name, ...typeof id === 'string' && id ? { id } : {} })
        }
      } else {
        parts = message.content.flatMap(block => {
          if (block.type === 'text') return block.text ? [{ text: block.text }] : []
          if (block.type !== 'tool-call') return []
          calls.set(block.id, { name: block.name, id: block.id })
          return [neutralCall(block)]
        })
      }
      if (parts.length) contents.push({ role: 'model', parts })
      continue
    }
    if (message.role === 'tool') {
      const call = calls.get(message.toolCallId)
      if (!call) throw new Error('GenerateContent tool result has no function call in the current history')
      const result = textParts(message).map(part => part.text).join('\n')
      const part = { functionResponse: { ...call, response: message.isError ? { error: result } : { output: result } } }
      if (contents.at(-1)?.role === 'user' && contents.at(-1).parts.every(value => value.functionResponse)) {
        contents.at(-1).parts.push(part)
      } else contents.push({ role: 'user', parts: [part] })
      continue
    }
    calls = new Map()
    const parts = textParts(message)
    if (parts.length) contents.push({ role: 'user', parts })
  }

  const declarations = (request.tools ?? []).map(tool => ({
    name: tool.name, description: tool.description, parametersJsonSchema: tool.parameters,
  }))
  const local = declarations.filter(tool => tool.name !== 'web_search')
  const conversation = request.purpose === undefined && request.sessionId !== undefined
  const includeSearch = conversation && (route.search === 'mixed' || (route.search === 'search-only' && !local.length))
  const circulation = (includeSearch && route.search === 'mixed') || requiresCirculation
  const exposed = includeSearch ? local : declarations
  const tools = [...exposed.length ? [{ functionDeclarations: exposed }] : [], ...includeSearch ? [{ googleSearch: {} }] : []]
  const generationConfig = {
    ...request.temperature === undefined ? {} : { temperature: request.temperature },
    ...request.maxTokens === undefined ? {} : { maxOutputTokens: request.maxTokens },
    ...request.stop === undefined ? {} : { stopSequences: request.stop },
    ...request.reasoningEffort === undefined ? {} : {
      thinkingConfig: { includeThoughts: true, thinkingLevel: request.reasoningEffort.toUpperCase() },
    },
  }
  return {
    contents,
    ...systems.length ? { systemInstruction: { parts: systems } } : {},
    ...tools.length ? { tools } : {},
    ...circulation ? { toolConfig: { includeServerSideToolInvocations: true } } : {},
    ...Object.keys(generationConfig).length ? { generationConfig } : {},
  }
}
