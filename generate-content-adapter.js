import { randomUUID } from 'node:crypto'
import { createSseDecoder, collectGoogleSearchEvidence } from './google-search-sse.js'
import {
  generateContentApi, generationEndpoint, historyFingerprint, isModelId, isObject, makePayload, makeReplayState, normalizeEndpoint,
  responseFrame, routeIdentity, selectedCandidate,
} from './generate-content.js'

const frameLimit = 1024 * 1024
const replayLimit = 2 * 1024 * 1024
const candidateLimit = 4_096
const routePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const levels = ['minimal', 'low', 'medium', 'high']

function failure(code, message, extra) {
  return { type: 'finish', reason: { kind: code === 'ABORTED' ? 'aborted' : 'error', failure: { code, message, ...extra } } }
}

function checkRoutes(providers) {
  return new Map(Object.entries(providers).map(([provider, input]) => {
    if (!routePattern.test(provider) || input.api !== generateContentApi) throw new Error(`Invalid GenerateContent route: ${provider}`)
    const route = {
      baseURL: normalizeEndpoint(input.baseURL), credential: input.apiKeyEnv,
      name: input.displayName ?? provider, search: input.search ?? 'off', timeoutMs: input.streamIdleTimeoutMs ?? 300_000,
      models: new Map(),
    }
    if (!['off', 'search-only', 'mixed'].includes(route.search)) throw new Error(`Invalid search capability for route ${provider}`)
    for (const model of input.models) {
      const efforts = model.thinkingLevels ?? []
      if (!isModelId(model.id) || route.models.has(model.id) || efforts.some(level => !levels.includes(level))) {
        throw new Error(`Invalid or duplicate model on GenerateContent route ${provider}`)
      }
      route.models.set(model.id, {
        provider, id: model.id, name: model.name ?? model.id, inputModalities: ['text'],
        ...model.contextWindow === undefined ? {} : { context: { contextWindow: model.contextWindow } },
        ...model.maxTokens === undefined ? {} : { defaultMaxTokens: model.maxTokens },
        ...efforts.length ? { reasoning: { efforts: [...new Set(efforts)].map(id => ({ id, name: id })) } } : {},
      })
    }
    if (!route.models.size) throw new Error(`GenerateContent route ${provider} needs at least one model`)
    route.identity = routeIdentity(route)
    return [provider, route]
  }))
}

function statusCode(status) {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 408 || status === 504) return 'TIMEOUT'
  if (status >= 500) return 'SERVER'
  return 'INVALID_REQUEST'
}

function asUsage(value) {
  const number = count => Number.isSafeInteger(count) && count >= 0 ? count : 0
  const cache = number(value.cachedContentTokenCount)
  const thoughts = number(value.thoughtsTokenCount)
  return {
    inputTokens: Math.max(0, number(value.promptTokenCount) - cache),
    outputTokens: number(value.candidatesTokenCount) + thoughts,
    ...value.totalTokenCount === undefined ? {} : { totalTokens: number(value.totalTokenCount) },
    ...cache ? { cacheReadTokens: cache } : {},
    ...thoughts ? { reasoningTokens: thoughts } : {},
  }
}

function fullBlock(index, block, delta) {
  return [{ type: 'block-start', index, blockType: block.type }, { index, ...delta }, { type: 'block-end', index, block }]
}

class StreamFailure extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details }
}

/** One Host adapter instance, multiple explicit provider IDs, one wire protocol. */
export function createGenerateContentAdapter(providers, { resolveCredential, attribution = {},
  fetch: transport = (...args) => globalThis.fetch(...args), reportFor } = {}) {
  const routes = checkRoutes(providers)
  function find(provider, model) {
    const route = routes.get(provider)
    const info = route?.models.get(model)
    if (!info) throw new Error(`Unknown GenerateContent model ${provider}/${model}`)
    return { route, info }
  }

  async function* stream(request, prepared = find(request.provider, request.model)) {
    const { route } = prepared
    let payload
    try { payload = makePayload(request, route) }
    catch { yield failure('INVALID_REQUEST', 'GenerateContent cannot represent the current function call history'); return }
    let key
    try { key = await resolveCredential?.(route.credential) }
    catch { yield failure('INVALID_CREDENTIAL', 'Could not resolve the GenerateContent credential'); return }
    if (typeof key !== 'string' || !key.trim() || /[\r\n\x00]/u.test(key)) {
      yield failure('MISSING_CREDENTIAL', 'No usable credential for this GenerateContent route'); return
    }

    const idle = new AbortController()
    const signal = request.signal ? AbortSignal.any([request.signal, idle.signal]) : idle.signal
    async function wait(operation) {
      signal.throwIfAborted()
      const timer = setTimeout(() => idle.abort(), route.timeoutMs)
      timer.unref?.()
      try { return await operation() } finally { clearTimeout(timer) }
    }

    const prefix = historyFingerprint(payload.contents, payload.systemInstruction?.parts)
    const frames = []
    const callIds = []
    const batches = []
    let savedBytes = 0
    const rawCalls = new Set()
    let index = 0
    let finishReason
    let usage
    let reader
    let drained = false
    const report = request.purpose === undefined && request.sessionId ? reportFor?.(request.sessionId) : undefined
    const observe = report ? collectGoogleSearchEvidence(report) : undefined
    const decoder = createSseDecoder(value => { batches.push({ value }) }, {
      frameLimit,
      invalid: reason => { batches.push({ invalid: reason }) },
    })
    const invalidFrame = reason => new StreamFailure(reason === 'incomplete-frame' ? 'TRANSPORT' : 'MALFORMED_RESPONSE',
      `GenerateContent returned an unreadable SSE event (${reason})`)
    try {
      const response = await wait(() => transport(generationEndpoint(route.baseURL, request.model), {
        method: 'POST', redirect: 'error',
        headers: { ...attribution, 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(payload), signal,
      }))
      if (!response.ok) {
        if (response.body) await response.body.cancel().catch(() => {})
        throw new StreamFailure(statusCode(response.status), 'GenerateContent rejected the request', { status: response.status })
      }
      if (!response.body || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'text/event-stream') {
        if (response.body) await response.body.cancel().catch(() => {})
        throw new StreamFailure('MALFORMED_RESPONSE', 'GenerateContent did not return an SSE stream')
      }
      reader = response.body.getReader()
      for (;;) {
        const result = await wait(() => reader.read())
        if (result.done) { drained = true; decoder.end() }
        else decoder.push(result.value)
        for (const { value: json, invalid } of batches.splice(0)) {
          if (invalid) throw invalidFrame(invalid)
          if (!isObject(json)) throw new StreamFailure('MALFORMED_RESPONSE', 'GenerateContent returned an invalid response object')
          if (json.error) {
            const status = Number(json.error.code)
            throw new StreamFailure(statusCode(status), 'GenerateContent reported an API error',
              Number.isSafeInteger(status) && status >= 400 && status <= 599 ? { status } : undefined)
          }
          if (isObject(json.usageMetadata)) usage = asUsage(json.usageMetadata)
          const frame = responseFrame(json)
          if (!frame?.length) continue
          savedBytes += Buffer.byteLength(JSON.stringify(frame))
          if (savedBytes > replayLimit || frames.length >= candidateLimit) {
            throw new StreamFailure('REPLAY_LIMIT', 'GenerateContent response exceeds the native history limit')
          }
          frames.push(frame)
          const candidate = selectedCandidate(frame)
          if (candidate == null) continue
          observe?.({ candidates: [candidate] })
          const parts = candidate.content?.parts ?? []
          if (!Array.isArray(parts) || (candidate.content?.role !== undefined && candidate.content.role !== 'model')) {
            throw new StreamFailure('MALFORMED_RESPONSE', 'GenerateContent returned invalid candidate content')
          }
          if (finishReason !== undefined && parts.length) throw new StreamFailure('MALFORMED_RESPONSE', 'GenerateContent gave parts after its termination')
          for (const part of parts) {
            if (!isObject(part)) throw new StreamFailure('MALFORMED_RESPONSE', 'GenerateContent returned an invalid part')
            if (typeof part.text === 'string' && part.text.length) {
              const reasoning = part.thought === true
              const type = reasoning ? 'reasoning' : 'text'
              yield* fullBlock(index++, { type, text: part.text }, { type: reasoning ? 'reasoning-delta' : 'text-delta', text: part.text })
            }
            if (part.functionCall !== undefined) {
              const call = part.functionCall
              if (!isObject(call) || typeof call.name !== 'string' || !call.name || (call.args !== undefined && !isObject(call.args))
                || call.partialArgs !== undefined || call.willContinue === true
                || (call.id !== undefined && (typeof call.id !== 'string' || !call.id || rawCalls.has(call.id)))) {
                throw new StreamFailure('MALFORMED_RESPONSE', 'GenerateContent returned an invalid or duplicate function call')
              }
              if (call.id !== undefined) rawCalls.add(call.id)
              const id = randomUUID()
              callIds.push(id)
              const args = JSON.stringify(call.args ?? {})
              yield* fullBlock(index++, { type: 'tool-call', id, name: call.name, arguments: args },
                { type: 'tool-call-delta', id, name: call.name, argumentsDelta: args })
            }
          }
          if (candidate.finishReason && candidate.finishReason !== 'FINISH_REASON_UNSPECIFIED') {
            if (finishReason !== undefined && finishReason !== candidate.finishReason) {
              throw new StreamFailure('MALFORMED_RESPONSE', 'GenerateContent returned conflicting finish reasons')
            }
            finishReason = candidate.finishReason
          }
        }
        if (result.done) break
      }
      if (!finishReason) throw new StreamFailure('TRANSPORT', 'GenerateContent stream closed before a finish reason')
      if (usage) yield { type: 'usage', usage }
      if (finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
        throw new StreamFailure('MODEL_FINISH', 'GenerateContent stopped without a usable completion')
      }
      if (!frames.some(frame => {
        const candidate = selectedCandidate(frame)
        return candidate?.content?.parts?.length || candidate?.groundingMetadata !== undefined
      }) && finishReason === 'STOP') {
        throw new StreamFailure('EMPTY_RESPONSE', 'GenerateContent completed without response parts')
      }
      yield { type: 'finish', reason: { kind: finishReason === 'MAX_TOKENS' ? 'max-tokens' : callIds.length ? 'tool-calls' : 'stop' },
        replayState: makeReplayState(route, request.model, frames, callIds, finishReason === 'MAX_TOKENS' ? 'truncated' : 'complete', prefix) }
    } catch (error) {
      const chunk = request.signal?.aborted ? failure('ABORTED', 'GenerateContent request cancelled')
        : idle.signal.aborted ? failure('TIMEOUT', 'GenerateContent stream idle timeout')
        : error instanceof StreamFailure ? failure(error.code, error.message, error.details)
        : failure('TRANSPORT', 'GenerateContent transport failed')
      if (frames.length) chunk.replayState = makeReplayState(route, request.model, frames, callIds, 'failed', prefix)
      yield chunk
    } finally {
      if (reader) {
        if (!drained) await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    }
  }

  return {
    providerInfo: provider => ({ id: provider, name: routes.get(provider)?.name ?? provider }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    imageRequestTarget: (_provider, _model, image) => ({ width: image.width, height: image.height, maxBytes: image.bytes }),
    async listModels(provider) { return [...(routes.get(provider)?.models.values() ?? [])] },
    async resolveModel(provider, model) { return find(provider, model).info },
    async prepareCall(provider, model) {
      const prepared = find(provider, model)
      return { model: prepared.info, stream: request => stream(request, prepared) }
    },
    stream,
  }
}
