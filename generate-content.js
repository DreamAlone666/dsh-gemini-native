import { createHash } from 'node:crypto'

export const generateContentApi = 'google-generative-ai'
const replayKind = 'dsh-gemini-generate-content'
const replayVersion = 2
const nativeKeys = ['toolCall', 'toolResponse', 'executableCode', 'codeExecutionResult']
const textRef = 1
const nameRef = 2
const argsRef = 4

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

function replayDigest(wire) {
  return createHash('sha256').update(wire).digest('base64url')
}

function compactReplayFrames(frames, blocks, callIds) {
  // The adapter coalesces contiguous same-kind text/reasoning parts into one
  // normalized block (closed on type change, function call, or stream end).
  // Match text runs by emission order (whole block or slice), functions by local ID.
  // Non-matches, alternate candidates, and non-Gemini fields stay raw.
  const textPositions = []
  const callPositions = new Map()
  for (const [position, block] of blocks.entries()) {
    if (block?.type === 'text' || block?.type === 'reasoning') textPositions.push(position)
    if (block?.type === 'tool-call' && typeof block.id === 'string') {
      callPositions.set(block.id, callPositions.has(block.id) ? undefined : position)
    }
  }
  let nextText = 0
  let nextCall = 0
  let openText = null
  const refs = []
  const compact = frames.map((frame, f) => {
    const candidate = selectedCandidate(frame)
    if (!Array.isArray(candidate?.content?.parts)) return frame
    const c = frame.indexOf(candidate)
    const parts = candidate.content.parts.map((part, p) => {
      if (!isObject(part)) return part
      let value = part
      if (typeof part.text === 'string' && part.text.length) {
        const type = part.thought === true ? 'reasoning' : 'text'
        if (openText?.type !== type) {
          const b = textPositions[nextText++]
          openText = { type, b, block: b === undefined ? undefined : blocks[b], offset: 0 }
        }
        const start = openText.offset
        const end = start + part.text.length
        openText.offset = end
        if (openText.block?.type === type && typeof openText.block.text === 'string'
          && openText.block.text.startsWith(part.text, start)) {
          refs.push(start === 0 && end === openText.block.text.length
            ? [f, c, p, openText.b, textRef]
            : [f, c, p, openText.b, textRef, start, end])
          value = { ...value, text: null }
        }
      }
      if (part.functionCall !== undefined) {
        openText = null
        const b = callPositions.get(callIds[nextCall++])
        const call = part.functionCall
        if (b !== undefined && isObject(call)) {
          const block = blocks[b]
          let mask = 0
          const extra = { ...call }
          if (Object.hasOwn(call, 'name') && typeof call.name === 'string' && call.name === block.name) {
            extra.name = null
            mask |= nameRef
          }
          if (Object.hasOwn(call, 'args') && isObject(call.args) && JSON.stringify(call.args) === block.arguments) {
            extra.args = null
            mask |= argsRef
          }
          if (mask) {
            refs.push([f, c, p, b, mask])
            value = { ...value, functionCall: extra }
          }
        }
      }
      return value
    })
    return frame.map((entry, i) => i === c ? { ...entry, content: { ...entry.content, parts } } : entry)
  })
  return { frames: compact, refs }
}

/**
 * V2 stores frames minus fields identical to durable normalized blocks.
 * References [frame, candidate, part, block, mask] (or [..., start, end] for
 * streamed text/reasoning slices) restore null placeholders;
 * a digest rejects mismatched block lists and preserves wire JSON key order.
 * Failed/truncated attempts intentionally keep raw frames: their message may
 * omit calls, or there may be no assistant message at all.
 */
export function makeReplayState(route, model, frames, callIds, outcome, prefix, normalizedBlocks) {
  const response = { kind: replayKind, version: replayVersion, route: route.identity, model, prefix,
    frames, callIds, outcome, refs: [] }
  if (outcome === 'complete' && normalizedBlocks?.length) {
    const compact = compactReplayFrames(frames, normalizedBlocks, callIds)
    if (compact.refs.length) {
      const wire = JSON.stringify(frames)
      const candidate = { ...response, ...compact, digest: replayDigest(wire) }
      // Prefer raw for small responses where the structural references and
      // digest would themselves cost more than the duplicated normalized text.
      if (Buffer.byteLength(JSON.stringify(candidate)) < Buffer.byteLength(JSON.stringify(response))) {
        return { response: candidate }
      }
    }
  }
  return { response }
}

function durableIndex(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function expandReplayFrames(data, normalizedBlocks) {
  if (!Array.isArray(normalizedBlocks) || typeof data.digest !== 'string' || data.outcome !== 'complete') return
  const frames = [...data.frames]
  const changed = new Map()
  for (const ref of data.refs) {
    if (!Array.isArray(ref) || (ref.length !== 5 && ref.length !== 7)) return
    const [f, c, p, b, mask, start, end] = ref
    if (![f, c, p, b].every(durableIndex) || ![textRef, nameRef, argsRef, nameRef | argsRef].includes(mask)) return
    if (ref.length === 7 && (mask !== textRef || !durableIndex(start) || !durableIndex(end) || start >= end)) return
    const block = normalizedBlocks[b]
    if (!block) return
    if (!changed.has(f)) {
      const candidate = selectedCandidate(data.frames[f])
      if (!Array.isArray(candidate?.content?.parts) || data.frames[f][c] !== candidate) return
      const parts = [...candidate.content.parts]
      frames[f] = [...data.frames[f]]
      frames[f][c] = { ...candidate, content: { ...candidate.content, parts } }
      changed.set(f, { c, parts })
    }
    const entry = changed.get(f)
    if (entry.c !== c) return
    const part = entry.parts[p]
    if (!isObject(part)) return
    if (mask === textRef) {
      if (!Object.hasOwn(part, 'text') || part.text !== null || typeof block.text !== 'string'
        || block.type !== (part.thought === true ? 'reasoning' : 'text')) return
      if (ref.length === 7) {
        if (end > block.text.length) return
        entry.parts[p] = { ...part, text: block.text.slice(start, end) }
      } else {
        entry.parts[p] = { ...part, text: block.text }
      }
    } else {
      if (block.type !== 'tool-call' || !isObject(part.functionCall)) return
      const call = { ...part.functionCall }
      if (mask & nameRef) {
        if (!Object.hasOwn(call, 'name') || call.name !== null || typeof block.name !== 'string') return
        call.name = block.name
      }
      if (mask & argsRef) {
        if (!Object.hasOwn(call, 'args') || call.args !== null || typeof block.arguments !== 'string') return
        let args
        try { args = JSON.parse(block.arguments) } catch { return }
        if (!isObject(args)) return
        call.args = args
      }
      entry.parts[p] = { ...part, functionCall: call }
    }
  }
  if (replayDigest(JSON.stringify(frames)) !== data.digest) return
  return frames
}

export function readNativeReplay(envelope, normalizedBlocks) {
  const data = envelope?.response
  if (data?.kind !== replayKind || !Array.isArray(data.frames) || !Array.isArray(data.callIds)) return
  if (data.version === 1) return data
  if (data.version !== replayVersion || !Array.isArray(data.refs)) return
  if (!data.refs.length && data.digest !== undefined) return
  const { refs, digest: _digest, ...metadata } = data
  const frames = refs.length ? expandReplayFrames(data, normalizedBlocks) : data.frames
  return frames === undefined ? undefined : { ...metadata, frames }
}

function nativeFinishEnvelope(event) {
  const last = event.data.stream?.at(-1)
  if (last?.type === 'chunk' && last.chunk.type === 'finish'
    && last.chunk.replayState?.response?.kind === replayKind) return last.chunk.replayState
}

function nativeEnvelopeOf(event) {
  if (event.type === 'assistant/message') {
    const envelope = event.data.message.source?.replayState
    if (envelope?.response?.kind === replayKind) return envelope
  } else if (event.type !== 'assistant/attempt') return
  return nativeFinishEnvelope(event)
}

/** Read a commitment or a settled failed attempt, not a live chunk. */
export function nativeReplayOf(event) {
  const envelope = nativeEnvelopeOf(event)
  if (!envelope) return
  const content = event.type === 'assistant/message' ? event.data.message.content : undefined
  const replay = readNativeReplay(envelope, content)
  if (replay) return replay
  // The loop duplicates the finish envelope in the compact stream. An
  // interrupted message may have pruned blocks; read the independent durable
  // block-end records in that case. Do not reconstruct from partial deltas.
  const terminal = nativeFinishEnvelope(event)
  if (!terminal) return
  const blocks = new Map()
  for (const record of event.data.stream) {
    if (record.type !== 'chunk' || record.chunk.type !== 'block-end' || blocks.has(record.chunk.index)) continue
    blocks.set(record.chunk.index, record.chunk.block)
  }
  return readNativeReplay(terminal, [...blocks.values()])
}

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

function groupedTextBlocks(rawParts) {
  const blocks = []
  let open = null
  for (const part of rawParts) {
    if (typeof part.text === 'string' && part.text.length) {
      const type = part.thought === true ? 'reasoning' : 'text'
      if (open?.type === type) open.text += part.text
      else {
        open = { type, text: part.text }
        blocks.push(open)
      }
    }
    if (part.functionCall !== undefined) open = null
  }
  return blocks
}

function sameTextBlocks(left, right) {
  return left.length === right.length && left.every((block, i) => block.type === right[i].type && block.text === right[i].text)
}

function nativeHistory(message, route, request, contents, systemParts) {
  if (request.purpose !== undefined || message.source?.provider !== request.provider || message.source?.model !== request.model) return
  const envelope = message.source.replayState
  const metadata = envelope?.response
  if (!metadata || metadata.model !== request.model || metadata.route !== route.identity || metadata.outcome !== 'complete'
    || metadata.prefix !== historyFingerprint(contents, systemParts)) return
  const state = readNativeReplay(envelope, message.content)
  if (!state) return
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
  const stored = message.content.filter(block => block.type === 'reasoning' || block.type === 'text')
  const displayed = groupedTextBlocks(rawParts)
  const legacyDisplayed = rawParts.flatMap(part => typeof part.text === 'string' && part.text.length
    ? [{ type: part.thought === true ? 'reasoning' : 'text', text: part.text }] : [])
  if (!sameTextBlocks(displayed, stored) && !sameTextBlocks(legacyDisplayed, stored)) return
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
