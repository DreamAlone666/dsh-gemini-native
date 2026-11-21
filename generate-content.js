import { createHash } from 'node:crypto'

export const generateContentApi = 'google-generative-ai'
const replayKind = 'dsh-gemini-generate-content'
const replayVersion = 2
const nativeField = 'dshGeminiNative'
const nativeKeys = ['toolCall', 'toolResponse', 'executableCode', 'codeExecutionResult']
const textRef = 1
const nameRef = 2
const argsRef = 4
const dshWebSearch = 'web_search'

export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hasFunctions = tool => Array.isArray(tool?.functionDeclarations) && tool.functionDeclarations.length > 0

export function normalizeEndpoint(value) {
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('GenerateContent baseURL must be an HTTP(S) API root without credentials, query or fragment')
  }
  return url.href.replace(/\/+$/u, '')
}

export function routeIdentity(route) {
  return createHash('sha256').update(JSON.stringify([
    generateContentApi, route.baseURL, route.provider ?? '', Boolean(route.googleSearch),
  ])).digest('hex')
}

export function historyFingerprint(contents, systemParts = []) {
  return createHash('sha256').update(JSON.stringify([systemParts, contents])).digest('hex')
}

function replayDigest(wire) {
  return createHash('sha256').update(wire).digest('base64url')
}

function compactReplayFrames(frames, blocks, callIds) {
  // pi-ai coalesces contiguous same-kind text/reasoning parts into one
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
export function makeNativeReplayData(route, model, frames, callIds, outcome, prefix, normalizedBlocks) {
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
        return candidate
      }
    }
  }
  return response
}

export function makeReplayState(route, model, frames, callIds, outcome, prefix, normalizedBlocks) {
  return { response: makeNativeReplayData(route, model, frames, callIds, outcome, prefix, normalizedBlocks) }
}

/**
 * Embed native replay data inside pi-ai's own replayState.response so pi-ai
 * retains full same-model replay fidelity (signatures, thinking blocks, tool IDs)
 * even if native mode is later disabled, while failed attempts without a pi-ai
 * replayState fall back to a standalone envelope for search-card projection.
 */
export function attachNativeReplay(piReplayState, nativeData) {
  if (isObject(piReplayState) && isObject(piReplayState.response)) {
    return { ...piReplayState, response: { ...piReplayState.response, [nativeField]: nativeData } }
  }
  return { response: nativeData }
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

function extractNativeData(envelope) {
  const response = envelope?.response
  if (!isObject(response)) return
  if (response.kind === replayKind) return response
  if (isObject(response[nativeField]) && response[nativeField].kind === replayKind) return response[nativeField]
}

export function readNativeReplay(envelope, normalizedBlocks) {
  const data = extractNativeData(envelope)
  if (!data || !Array.isArray(data.frames) || !Array.isArray(data.callIds)) return
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
    && extractNativeData(last.chunk.replayState) !== undefined) return last.chunk.replayState
}

function nativeEnvelopeOf(event) {
  if (event.type === 'assistant/message') {
    const envelope = event.data.message.source?.replayState
    if (extractNativeData(envelope) !== undefined) return envelope
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

function nativeHistory(message, route, request, prefix, allowCirculation) {
  if ((request.purpose !== undefined && request.purpose !== 'compaction')
    || message.source?.provider !== request.provider || message.source?.model !== request.model) return
  const envelope = message.source.replayState
  const metadata = extractNativeData(envelope)
  if (!metadata || metadata.model !== request.model || metadata.route !== route.identity || metadata.outcome !== 'complete'
    || metadata.prefix !== prefix) return
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
  if (!rawParts.length || (!allowCirculation && rawParts.some(part => nativeKeys.some(key => Object.hasOwn(part, key))))) return
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

function withoutDshWebSearch(tools) {
  return tools.flatMap(tool => {
    if (!hasFunctions(tool)) return [tool]
    const { functionDeclarations, ...otherFields } = tool
    const kept = functionDeclarations.filter(declaration => declaration?.name !== dshWebSearch)
    if (kept.length === functionDeclarations.length) return [tool]
    if (kept.length > 0) return [{ ...tool, functionDeclarations: kept }]
    return Object.keys(otherFields).length > 0 ? [otherFields] : []
  })
}

/**
 * Apply native Google Search tool augmentation to a pi-ai-generated Gemini request body.
 * Always replaces DSH `web_search` with `{ googleSearch: {} }` while preserving
 * all other local functions (mixed mode).
 */
export function applyGoogleSearchTools(body, enableSearch, requiresCirculation = false) {
  const wantsSearch = enableSearch === true
  if (!wantsSearch && !requiresCirculation) return { body, changed: false }
  const originalTools = body.tools ?? []
  const hasSearch = originalTools.some(tool => !isObject(tool)
    || Object.hasOwn(tool, 'googleSearch') || Object.hasOwn(tool, 'google_search')
    || Object.hasOwn(tool, 'googleSearchRetrieval'))
  const next = { ...body }
  let changed = false

  if (wantsSearch && !hasSearch) {
    const tools = withoutDshWebSearch(originalTools)
    const remainingFunctions = tools.some(hasFunctions)
    if (originalTools.some(hasFunctions)) {
      // Google requires this opt-in when mixing built-ins with functions.
      // Its examples omit the mode; AUTO is not supported. Never override a
      // mode or an explicit false chosen by a different integration.
      const config = body.toolConfig
      const calling = config?.functionCallingConfig
      const incompatibleConfig = config !== undefined && (!isObject(config) || config.includeServerSideToolInvocations === false)
      const incompatibleCalling = calling !== undefined && (!isObject(calling)
        || (calling.mode !== undefined && calling.mode !== 'VALIDATED'))
      if (!incompatibleConfig && !incompatibleCalling) {
        let canInject = true
        if (remainingFunctions) {
          const nextConfig = { ...config, includeServerSideToolInvocations: true }
          const allowed = calling?.allowedFunctionNames
          if (Array.isArray(allowed) && allowed.includes(dshWebSearch)) {
            const kept = allowed.filter(name => name !== dshWebSearch)
            // Don't widen an explicit allowlist to all local tools.
            if (kept.length === 0) canInject = false
            else nextConfig.functionCallingConfig = { ...calling, allowedFunctionNames: kept }
          }
          if (canInject) next.toolConfig = nextConfig
        } else if (calling !== undefined) {
          // An otherwise search-only request no longer needs a function policy.
          const { functionCallingConfig: _dropped, ...rest } = config
          if (Object.keys(rest).length > 0) next.toolConfig = rest
          else delete next.toolConfig
        }
        if (canInject) {
          next.tools = [...tools, { googleSearch: {} }]
          changed = true
        }
      }
    } else {
      next.tools = [...tools, { googleSearch: {} }]
      changed = true
    }
  }

  if (requiresCirculation && next.toolConfig?.includeServerSideToolInvocations !== true) {
    if (next.toolConfig === undefined || (isObject(next.toolConfig) && next.toolConfig.includeServerSideToolInvocations !== false)) {
      next.toolConfig = { ...next.toolConfig, includeServerSideToolInvocations: true }
      changed = true
    }
  }
  return { body: changed ? next : body, changed }
}

function findNativeAssistant(assistants, startIndex, request, route, prefix, wireParts, allowCirculation) {
  const wireCalls = wireParts.filter(part => isObject(part?.functionCall))
  for (let i = startIndex; i < assistants.length; i++) {
    const native = nativeHistory(assistants[i], route, request, prefix, allowCirculation)
    if (!native) continue
    if (wireCalls.length !== native.local.length
      || wireCalls.some((part, j) => part.functionCall.name !== native.local[j].name)) continue
    return { index: i, native }
  }
}

/**
 * Incrementally patch a pi-ai-generated Gemini GenerateContent request body:
 * 1. Substitute validated native model parts (preserving signatures, server-side
 *    tool calls/responses, opaque fields) and align following functionResponse IDs.
 * 2. Compute the canonical prefix fingerprint of the patched contents for the
 *    upcoming response's replayState.
 * 3. Apply native Google Search augmentation when `route.googleSearch` is enabled.
 */
export function patchGenerateContentBody(body, request, route) {
  if (!isObject(body) || !Array.isArray(body.contents)
    || (body.tools !== undefined && !Array.isArray(body.tools))) return undefined
  const systemParts = Array.isArray(body.systemInstruction?.parts)
    ? body.systemInstruction.parts
    : typeof body.systemInstruction === 'string' ? [{ text: body.systemInstruction }] : []
  const assistants = Array.isArray(request.messages)
    ? request.messages.filter(message => message.role === 'assistant') : []
  const allowCirculation = route.googleSearch === true
    && !(isObject(body.toolConfig) && body.toolConfig.includeServerSideToolInvocations === false)

  let assistantCursor = 0
  const patchedContents = []
  let pendingCalls = null
  let requiresCirculation = false
  let contentsChanged = false
  let totalModelTurns = 0
  let replayedModelTurns = 0

  for (const entry of body.contents) {
    if (entry?.role === 'model' && Array.isArray(entry.parts)) {
      totalModelTurns++
      pendingCalls = null
      const prefix = historyFingerprint(patchedContents, systemParts)
      const match = findNativeAssistant(assistants, assistantCursor, request, route, prefix, entry.parts, allowCirculation)
      if (match) {
        replayedModelTurns++
        assistantCursor = match.index + 1
        const { parts, calls, local } = match.native
        requiresCirculation ||= parts.some(part => nativeKeys.some(key => Object.hasOwn(part, key)))
        if (local.length) {
          const byLocalId = new Map()
          const ordered = []
          for (let j = 0; j < local.length; j++) {
            const wireId = typeof calls[j].functionCall.id === 'string' && calls[j].functionCall.id
              ? calls[j].functionCall.id : undefined
            const info = { localId: local[j].id, name: calls[j].functionCall.name, wireId }
            byLocalId.set(local[j].id, info)
            ordered.push(info)
          }
          pendingCalls = { byLocalId, ordered }
        }
        patchedContents.push({ ...entry, parts })
        contentsChanged = true
        continue
      }
      patchedContents.push(entry)
      continue
    }
    if (entry?.role === 'user' && Array.isArray(entry.parts) && pendingCalls) {
      let orderIndex = 0
      let entryChanged = false
      const parts = entry.parts.map(part => {
        if (!isObject(part?.functionResponse)) return part
        const response = part.functionResponse
        const matched = (typeof response.id === 'string' ? pendingCalls.byLocalId.get(response.id) : undefined)
          ?? (pendingCalls.ordered[orderIndex]?.name === response.name ? pendingCalls.ordered[orderIndex] : undefined)
        orderIndex++
        if (!matched) return part
        if (matched.wireId !== undefined) {
          if (response.id === matched.wireId) return part
          entryChanged = true
          return { ...part, functionResponse: { ...response, id: matched.wireId } }
        }
        if (!Object.hasOwn(response, 'id')) return part
        const { id: _dropped, ...rest } = response
        entryChanged = true
        return { ...part, functionResponse: rest }
      })
      pendingCalls = null
      if (entryChanged) {
        patchedContents.push({ ...entry, parts })
        contentsChanged = true
        continue
      }
    } else {
      pendingCalls = null
    }
    patchedContents.push(entry)
  }

  const nextPrefix = historyFingerprint(patchedContents, systemParts)
  const contentBody = contentsChanged ? { ...body, contents: patchedContents } : body
  const tools = applyGoogleSearchTools(contentBody, route.googleSearch === true, requiresCirculation)
  return {
    body: tools.body,
    changed: contentsChanged || tools.changed,
    prefix: nextPrefix,
    totalModelTurns,
    replayedModelTurns,
  }
}
