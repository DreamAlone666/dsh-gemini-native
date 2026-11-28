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

// Google documents replaying prior model turns and signatures unchanged on
// generateContent model switches. Allow only the documented general models,
// not arbitrary aliases with suffixes or specialized output modalities.
// https://aistudio.google.com/docs/choosing-a-model.md?generate-content=true#pair-models
// https://aistudio.google.com/docs/whats-new-gemini-4-hydrogen.md#migrate-from-gemini-4-argon
const gemini4FamilyModels = new Set(['gemini-4-argon', 'gemini-4-carbon', 'gemini-4-neon', 'gemini-4-hydrogen'])

export function isGemini4FamilyModel(model) {
  return typeof model === 'string' && gemini4FamilyModels.has(model.toLowerCase().replace(/^models\//u, ''))
}

export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hasFunctions = tool => Array.isArray(tool?.functionDeclarations) && tool.functionDeclarations.length > 0

export function normalizeEndpoint(value) {
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('GenerateContent baseURL must be an HTTP(S) API root without credentials, query or fragment')
  }
  return url.href.replace(/\/+$/u, '')
}

// Keep the v1/v2 route value for diagnosticsProjection.lastNativeRoute; it is
// descriptive metadata, not a replay domain or attestation of the upstream.
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

// FAQ #3: streaming may deliver thoughtSignature on a text: "" part.
// https://aistudio.google.com/docs/thought-signatures.md?generate-content=true#faqs
// pi-ai opens a text/thinking run even for an empty part if its kind changes
// or there is no open run (e.g. just after a function call).
// https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/google-generative-ai.ts
function textPartType(part) {
  if (typeof part.text === 'string') return part.thought === true ? 'reasoning' : 'text'
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
      const type = textPartType(part)
      if (type !== undefined) {
        if (openText?.type !== type) {
          const b = textPositions[nextText++]
          openText = { type, b, block: b === undefined ? undefined : blocks[b], offset: 0 }
        }
        const start = openText.offset
        const end = start + part.text.length
        openText.offset = end
        // Empty parts advance the run above but cost less to leave literal.
        if (end > start && openText.block?.type === type && typeof openText.block.text === 'string'
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

export function nativeReplayBytes(event) {
  const data = extractNativeData(nativeEnvelopeOf(event))
  return data === undefined ? 0 : Buffer.byteLength(JSON.stringify(data))
}

// Candidate zero may not be the first entry of a later streamed frame.
export function selectedCandidate(candidates) {
  if (!Array.isArray(candidates)) return
  return candidates.find(candidate => candidate?.index === 0)
    ?? (candidates[0]?.index === undefined ? candidates[0] : undefined)
}

// Record only the first candidate, matching pi-ai. Normalize its index so
// the same v1/v2 reader can decode it and older multi-candidate records.
export function responseFrame(payload) {
  const candidate = Array.isArray(payload?.candidates) ? payload.candidates[0] : undefined
  if (!isObject(candidate)) return
  return [{
    ...candidate.index === undefined ? {} : { index: 0 },
    ...candidate.content === undefined ? {} : { content: candidate.content },
    ...candidate.groundingMetadata === undefined ? {} : { groundingMetadata: candidate.groundingMetadata },
    ...candidate.finishReason === undefined ? {} : { finishReason: candidate.finishReason },
  }]
}

function groupedTextBlocks(rawParts, { merge = true, ignoreEmpty = false } = {}) {
  const blocks = []
  let open = null
  for (const part of rawParts) {
    const type = textPartType(part)
    if (type !== undefined && (!ignoreEmpty || part.text.length > 0)) {
      if (merge && open?.type === type) open.text += part.text
      else {
        open = { type, text: part.text }
        blocks.push(open)
      }
      if (typeof part.thoughtSignature === 'string' && part.thoughtSignature) {
        (open.signatures ??= new Set()).add(part.thoughtSignature)
      }
    }
    if (part.functionCall !== undefined) {
      blocks.push({ type: 'tool-call' })
      open = null
    }
  }
  return blocks
}

function sameBlockOrder(left, right) {
  return left.length === right.length && left.every((block, i) => block.type === right[i].type
    && (block.type === 'tool-call' || block.text === right[i].text))
}

function hasServerTools(parts) {
  return parts.some(part => nativeKeys.some(key => Object.hasOwn(part, key)))
}

function originalCallId(call) {
  if (typeof call.id === 'string' && call.id !== '') return call.id
}

function nativeHistory(message, allowCirculation) {
  const state = readNativeReplay(message.source.replayState, message.content)
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
  if (!rawParts.length) return
  const requiresCirculation = hasServerTools(rawParts)
  if (requiresCirculation && !allowCirculation) return
  // Preserve Part boundaries and signatures on the wire; grouping is solely a
  // check against DSH's durable blocks. Gemini 3/4 require the first function
  // signature of each active step, and recommend replaying text signatures.
  // https://aistudio.google.com/docs/thought-signatures.md?generate-content=true#function-calling
  // https://aistudio.google.com/docs/thinking.md?generate-content=true#signatures
  const stored = message.content.filter(block => ['text', 'reasoning', 'tool-call'].includes(block.type))
  let displayed = groupedTextBlocks(rawParts)
  // Older transcripts omitted empty blocks and/or stored parts unmerged.
  if (!sameBlockOrder(displayed, stored)) displayed = groupedTextBlocks(rawParts, { ignoreEmpty: true })
  if (!sameBlockOrder(displayed, stored)) displayed = groupedTextBlocks(rawParts, { ignoreEmpty: true, merge: false })
  if (!sameBlockOrder(displayed, stored)) return
  const local = stored.filter(block => block.type === 'tool-call')
  const calls = rawParts.filter(part => part.functionCall !== undefined)
  if (local.length !== state.callIds.length || calls.length !== local.length) return
  const ids = []
  const seenIds = new Set()
  for (let i = 0; i < local.length; i++) {
    const original = calls[i].functionCall
    if (!isObject(original) || original.name !== local[i].name || local[i].id !== state.callIds[i]
      || JSON.stringify(original.args ?? {}) !== local[i].arguments) return
    const id = originalCallId(original)
    // pi-ai replaces duplicate IDs; do not undo this disambiguation.
    // https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/google-generative-ai.ts
    if (id !== undefined) {
      if (seenIds.has(id)) return
      seenIds.add(id)
    }
    ids.push(id)
  }
  return { parts: rawParts, calls, local, ids, displayed, requiresCirculation }
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

// DSH's LlmRuntime.forAdapter excludes replay from other adapters, but sharing
// a configured provider or gateway does not establish a shared backend. Keep
// cross-model replay opt-in: gateways report incompatible signatures on
// cross-transport failover.
// https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm/src/index.ts
// https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/google-shared.ts
// https://github.com/vercel/ai/issues/14196
// https://pydantic.dev/docs/ai/models/google/#switching-between-the-gemini-api-and-google-cloud
// https://github.com/yetone/magpie/issues/3572
// https://github.com/router-for-me/CLIProxyAPI/pull/7016 (Vertex bare-Tink)
// https://github.com/router-for-me/CLIProxyAPI/issues/7484 (gateway translation)
// https://github.com/heyhuynhgiabuu/proxypal/issues/146
function indexNativeAssistants({ provider, model, messages, purpose }, route) {
  if ((purpose !== undefined && purpose !== 'compaction') || !Array.isArray(messages)
    || typeof provider !== 'string' || !provider || typeof model !== 'string' || !model) return
  const canConsiderFamily = purpose === undefined && isGemini4FamilyModel(model)
  const assistants = []
  const byPrefix = new Map()
  let hasNativeCandidate = false
  for (const message of messages) {
    if (message?.role !== 'assistant' || !Array.isArray(message.content) || !message.content.every(isObject)) continue
    const { provider: sourceProvider, model: sourceModel, replayState } = message.source ?? {}
    const metadata = extractNativeData(replayState)
    const sameModel = sourceProvider === provider && sourceModel === model
    const otherFamilyModel = canConsiderFamily && sourceProvider === provider && sourceModel !== model
      && isGemini4FamilyModel(sourceModel)
    const familyCompatible = otherFamilyModel && route.gemini4FamilyReplay === true
    // The record must belong to its source message, not to the target model.
    const complete = metadata?.model === sourceModel && metadata?.outcome === 'complete'
    const replayable = (sameModel || familyCompatible) && complete
    const crossModelCandidate = otherFamilyModel && complete
    if (typeof metadata?.prefix === 'string') {
      const bucket = byPrefix.get(metadata.prefix)
      if (bucket) bucket.push(assistants.length)
      else byPrefix.set(metadata.prefix, [assistants.length])
    }
    // Ineligible steps still occupy positions. Filtering them out here could
    // attach a native record to a cross-provider or unrecorded lookalike.
    assistants.push({ message, replayable, sameModel, crossModelCandidate })
    hasNativeCandidate ||= replayable || crossModelCandidate
  }
  if (!hasNativeCandidate) return
  for (const assistant of assistants) Object.assign(assistant, sourceAssistantShape(assistant.message.content))
  return { assistants, byPrefix }
}

// Shape comparison mirrors pi-ai's convertMessages for visible text/thinking
// and ordered calls. Signed blanks may or may not survive normalization, and
// legacy/foreign messages may lack thinking on the wire. These omissions are
// allowed for alignment only; nativeHistory still checks the durable content.
// https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/google-shared.ts
// https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/transform-messages.ts
function shapeText(text) {
  if (typeof text !== 'string') return
  // Match pi-ai's sanitizeSurrogates (remove, not replace, lone surrogates).
  const normalized = text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu, '')
  if (normalized.trim()) return normalized
}

function shapeArguments(json) {
  try {
    const parsed = JSON.parse(json)
    if (isObject(parsed)) return parsed
  } catch { /* DSH's pi-ai replay parser also falls back to {}. */ }
  return {}
}

function sourceAssistantShape(content) {
  const tokens = []
  const callIds = []
  const textKinds = new Set()
  for (const block of content) {
    if (block.type === 'tool-call') {
      tokens.push(['tool-call', block.name, shapeArguments(block.arguments)])
      callIds.push(block.id)
    } else if (block.type === 'text' || block.type === 'reasoning') {
      textKinds.add(block.type)
      const text = shapeText(block.text)
      if (text !== undefined) tokens.push([block.type, text])
    }
  }
  const shape = JSON.stringify(tokens)
  const withoutReasoning = tokens.some(([type]) => type === 'reasoning')
    ? JSON.stringify(tokens.filter(([type]) => type !== 'reasoning')) : shape
  return { shape, withoutReasoning, callIds, textKinds }
}

function wireAssistantShape(parts) {
  if (!parts.length) return
  const tokens = []
  const wireCalls = []
  const textKinds = new Set()
  for (const part of parts) {
    if (!isObject(part)) return
    const type = textPartType(part)
    const call = part.functionCall
    if (type === undefined && call === undefined) return
    if (type !== undefined) {
      textKinds.add(type)
      const text = shapeText(part.text)
      if (text !== undefined) tokens.push([type, text])
    }
    if (call !== undefined) {
      if (!isObject(call) || typeof call.name !== 'string' || (call.args != null && !isObject(call.args))
        || (call.id !== undefined && typeof call.id !== 'string')) return
      tokens.push(['tool-call', call.name, call.args ?? {}])
      wireCalls.push(call)
    }
  }
  return { shape: JSON.stringify(tokens), wireCalls, textKinds }
}

function matchesAssistant(assistant, wire) {
  // An emitted signed blank still proves the source had that kind of block.
  // pi-ai strips cross-model thinking even if native replay is compatible.
  // https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/transform-messages.ts
  const hasThinking = wire.textKinds.has('reasoning')
  if (hasThinking && !assistant.sameModel) return false
  if (assistant.shape !== wire.shape && (hasThinking || assistant.withoutReasoning !== wire.shape)) return false
  for (const kind of wire.textKinds) if (!assistant.textKinds.has(kind)) return false
  return wire.wireCalls.every((call, i) => {
    const id = assistant.callIds[i]
    // Legacy models omit IDs; pi-ai may normalize IDs across routes.
    return call.id === undefined || call.id === id
      || (typeof id === 'string' && call.id === id.replace(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 64))
  })
}

function alignAssistants(contents, request, route) {
  const index = indexNativeAssistants(request, route)
  if (!index) return
  const { assistants } = index
  const byPosition = new Map()
  let cursor = assistants.length - 1
  for (let i = contents.length - 1; i >= 0; i--) {
    const entry = contents[i]
    if (entry?.role !== 'model') continue
    if (!Array.isArray(entry.parts)) return
    const wire = wireAssistantShape(entry.parts)
    if (!wire) return
    while (cursor >= 0 && !matchesAssistant(assistants[cursor], wire)) cursor--
    // pi-ai emits zero or one model entry per assistant, in order. If the
    // body is not a subsequence of the projected history, don't guess.
    if (cursor < 0) return
    byPosition.set(i, { wire, latest: cursor-- })
  }
  return { ...index, byPosition }
}

function matchByPrefix(alignment, prefix, wire, first, latest) {
  let matched
  for (const i of alignment.byPrefix.get(prefix) ?? []) {
    if (i < first || i > latest || !matchesAssistant(alignment.assistants[i], wire)) continue
    if (matched !== undefined) return
    matched = i
  }
  return matched
}

function preservesWireSignatures(wireParts, native) {
  // pi-ai may carry only one signature from a coalesced stream run. Match
  // each outbound part to the corresponding durable run, not to any equal
  // signature elsewhere in the message. A function call ends the text run.
  // https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/google-generative-ai.ts
  if (!wireParts.some(part => part.thoughtSignature)) return true
  const blocks = native.displayed
  let cursor = 0
  let call = 0
  for (const part of wireParts) {
    const signature = part.thoughtSignature
    const type = textPartType(part)
    const text = type === undefined ? undefined : shapeText(part.text)
    if (type !== undefined && (text !== undefined || signature)) {
      while (blocks[cursor] && blocks[cursor].type !== 'tool-call') {
        const block = blocks[cursor]
        if (block.type === type && shapeText(block.text) === text && (!signature || block.signatures?.has(signature))) break
        cursor++
      }
      if (blocks[cursor]?.type !== type) return false
      cursor++
    }
    if (part.functionCall !== undefined) {
      while (blocks[cursor] && blocks[cursor].type !== 'tool-call') cursor++
      if (blocks[cursor]?.type !== 'tool-call' || (signature && signature !== native.calls[call]?.thoughtSignature)) return false
      cursor++
      call++
    }
  }
  return true
}

function alignFunctionResponses(entry, native, wireCalls) {
  // No rebinding is needed if IDs are unchanged. This also covers Gemini 2.5
  // results split across an image Content and multiple functionResponse entries.
  // https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/google-shared.ts
  if (wireCalls.every((call, i) => call.id === native.ids[i])) return { entry }
  if (entry?.role !== 'user' || !Array.isArray(entry.parts)) return
  const byId = new Map()
  const idlessByName = new Map()
  for (const [i, call] of wireCalls.entries()) {
    const id = call.id ?? native.local[i].id
    if (byId.has(id)) return
    byId.set(id, i)
    if (call.id === undefined) {
      const sameName = idlessByName.get(call.name)
      if (sameName) sameName.push(i)
      else idlessByName.set(call.name, [i])
    }
  }
  const seen = new Set()
  const lastIdlessByName = new Map()
  let changed = false
  const parts = []
  for (const part of entry.parts) {
    const response = part?.functionResponse
    if (response === undefined) {
      parts.push(part)
      continue
    }
    if (!isObject(response)) return
    let i
    if (response.id === undefined) {
      const available = idlessByName.get(response.name)?.filter(index => !seen.has(index))
      if (!available?.length) return
      // pi-ai can append synthetic results, so order alone cannot pair two
      // same-name calls if reattaching a provider ID would change the binding.
      // https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/transform-messages.ts
      if (available.length > 1 && available.some(index => native.ids[index] !== undefined)) return
      i = available[0]
    } else {
      i = byId.get(response.id)
      if (i === undefined || seen.has(i) || wireCalls[i].name !== response.name) return
    }
    seen.add(i)
    // Google pairs calls with results by ID when one was supplied; don't
    // guess a different pairing or leave half of this tool exchange patched.
    // https://aistudio.google.com/docs/tool-combination.md?generate-content=true#critical-fields
    const id = native.ids[i]
    if (id === undefined) {
      // Removing IDs makes same-name results positional again. Preserve the
      // normalized exchange rather than reinterpreting an out-of-order pair.
      // https://aistudio.google.com/docs/thought-signatures.md?generate-content=true#faqs
      const previous = lastIdlessByName.get(response.name)
      if (previous !== undefined && i < previous) return
      lastIdlessByName.set(response.name, i)
    }
    if (id === response.id) parts.push(part)
    else {
      changed = true
      const { id: _localId, ...rest } = response
      parts.push({ ...part, functionResponse: id === undefined ? rest : { ...response, id } })
    }
  }
  if (seen.size === wireCalls.length) return { entry: changed ? { ...entry, parts } : entry }
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
  const alignment = alignAssistants(body.contents, request, route)
  // Keep the legacy [systemParts, contents] fingerprint for tie-breaking and
  // stable compaction requests, not as a replay gate. DSH's signature prefix
  // binding is Anthropic-only:
  // https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-pi-ai/src/prefix-binding.ts
  // Cross-model replay preserves history, not Gemini's implicit cache. Stable
  // prefixes can help on the same model, but actual reuse is reported as
  // usageMetadata.cachedContentTokenCount.
  // https://aistudio.google.com/docs/caching.md?generate-content=true#implicit-caching
  const prefixHash = alignment?.byPrefix.size > 0
    ? createHash('sha256').update(`[${JSON.stringify(systemParts)},[`) : null
  // Circulate server-side parts only when allowed on this request. Ordinary
  // turns don't require Search, and Google doesn't support circulation with AUTO.
  // https://aistudio.google.com/docs/tool-combination.md?generate-content=true#limitations
  const allowCirculation = route.googleSearch === true
    && (body.toolConfig === undefined || (isObject(body.toolConfig) && body.toolConfig.includeServerSideToolInvocations !== false))
    && body.toolConfig?.functionCallingConfig?.mode !== 'AUTO'

  let assistantCursor = 0
  const patchedContents = [...body.contents]
  let requiresCirculation = false
  let totalModelTurns = 0
  let sameModelReplayedTurns = 0
  let crossModelReplayedTurns = 0
  const crossModelCandidates = new Set()

  for (const [i, entry] of body.contents.entries()) {
    if (entry?.role === 'model') {
      totalModelTurns++
      const slot = alignment?.byPosition.get(i)
      if (slot) {
        const { wire, latest } = slot
        // Earliest/latest feasible matches bound all monotonic alignments. If
        // they differ, use a unique exact prefix match or leave the slot alone.
        // An unresolved slot still consumes at least its earliest possibility;
        // don't choose a later lookalike and exclude legitimate subsequent hits.
        while (assistantCursor < latest && !matchesAssistant(alignment.assistants[assistantCursor], wire)) assistantCursor++
        const first = assistantCursor
        const matched = first === latest ? first : prefixHash
          ? matchByPrefix(alignment, prefixHash.copy().update(']]').digest('hex'), wire, first, latest) : undefined
        assistantCursor = first + 1
        const assistant = alignment.assistants[matched]
        // Count only aligned, validated candidates, even when the option is
        // off. In particular, never advertise a thought-only step pi-ai omitted.
        const native = assistant?.replayable || assistant?.crossModelCandidate
          ? nativeHistory(assistant.message, allowCirculation) : undefined
        if (native && preservesWireSignatures(entry.parts, native)) {
          const next = body.contents[i + 1]
          const response = alignFunctionResponses(next, native, wire.wireCalls)
          if (response) {
            if (assistant.crossModelCandidate) crossModelCandidates.add(matched)
            if (assistant.replayable) {
              assistantCursor = matched + 1
              if (assistant.sameModel) sameModelReplayedTurns++
              else crossModelReplayedTurns++
              requiresCirculation ||= native.requiresCirculation
              patchedContents[i] = { ...entry, parts: native.parts }
              if (response.entry !== next) patchedContents[i + 1] = response.entry
            }
          }
        }
      }
    }
    if (prefixHash) {
      if (i > 0) prefixHash.update(',')
      prefixHash.update(JSON.stringify(patchedContents[i]) ?? 'null')
    }
  }

  const nextPrefix = prefixHash?.update(']]').digest('hex') ?? historyFingerprint(patchedContents, systemParts)
  const replayedModelTurns = sameModelReplayedTurns + crossModelReplayedTurns
  const contentsChanged = replayedModelTurns > 0
  const contentBody = contentsChanged ? { ...body, contents: patchedContents } : body
  const tools = applyGoogleSearchTools(contentBody, route.googleSearch === true, requiresCirculation)
  return {
    body: tools.body,
    changed: contentsChanged || tools.changed,
    prefix: nextPrefix,
    totalModelTurns,
    replayedModelTurns,
    sameModelReplayedTurns,
    crossModelReplayedTurns,
    crossModelCandidateTurns: crossModelCandidates.size,
  }
}
