import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  attachNativeReplay, hasNativeReplay, historyFingerprint, isGemini4FamilyModel, makeNativeReplayData, makeReplayState,
  nativeReplayOf, patchGenerateContentBody, readNativeReplay, routeIdentity,
} from '../src/generate-content.js'
import { nativeSearchProjection } from '../src/native-search-projection.js'

const route = { identity: 'example-route', googleSearch: true }
const model = 'gemini-test'
const localId = 'local-read-1'
const blocks = [
  { type: 'text', text: 'Normalized prose '.repeat(64) },
  { type: 'reasoning', text: '🧪 Reasoning '.repeat(32) },
  { type: 'tool-call', id: localId, name: 'read_mock', arguments: JSON.stringify({ payload: 'Argument data '.repeat(64), mode: false }) },
  { type: 'text', text: 'Normalized prose '.repeat(64) },
]
const parts = [
  { futureType: { nested: null }, text: blocks[0].text, thoughtSignature: 'first-signature' },
  { thought: true, thoughtSignature: 'reasoning-signature', text: blocks[1].text },
  { toolCall: { id: 'native-search', toolType: 'GOOGLE_SEARCH_WEB', args: { query: 'query one' } }, thoughtSignature: 'native-tool' },
  { futurePart: [1, '😀'], thought: true, text: '' },
  { functionCall: { wireMetadata: ['future'], name: blocks[2].name, id: 'wire-read-9', args: JSON.parse(blocks[2].arguments) }, thoughtSignature: 'function-call' },
  { empty: null, text: blocks[3].text },
  { toolResponse: { id: 'native-search', toolType: 'GOOGLE_SEARCH_WEB', response: { results: [{ url: 'https://example.org/source' }] } } },
]
const selected = (parts, extra = {}) => ({ index: 0, content: { role: 'model', extraField: { count: 4 }, parts }, ...extra })
const alternate = { index: 1, content: { role: 'model', parts: [{ text: 'other candidate' }, { toolCall: { id: 'wrong', toolType: 'GOOGLE_SEARCH_WEB', args: { query: 'not for display' } } }] } }
const frames = [
  [alternate, selected(parts.slice(0, 4))],
  [],
  [null, alternate],
  [selected(parts.slice(4), { finishReason: 'STOP', groundingMetadata: { webSearchQueries: ['query two'] } }), alternate],
]
const prefix = historyFingerprint([{ role: 'user', parts: [{ text: 'Check this' }] }])
const clone = value => JSON.parse(JSON.stringify(value))
const build = (outcome = 'complete', normalized = blocks) => makeReplayState(route, model, frames, [localId], outcome, prefix, normalized)
const v1 = { response: { kind: 'dsh-gemini-generate-content', version: 1, route: route.identity, model, frames,
  callIds: [localId], outcome: 'complete', prefix } }

function message(envelope, content = blocks) {
  return { role: 'assistant', content, source: { kind: 'model', provider: 'gemini', model, replayState: envelope } }
}

function terminal(envelope, normalized = blocks) {
  return [
    ...normalized.map((block, index) => ({ type: 'chunk', time: index + 1, chunk: { type: 'block-end', index, block } })),
    { type: 'chunk', time: normalized.length + 1, chunk: { type: 'finish', reason: { kind: 'stop' }, replayState: envelope } },
  ]
}

function confirmation(envelope, content = blocks, stream = terminal(envelope)) {
  return { type: 'assistant/message', data: { turn: 1, message: message(envelope, content), stream } }
}

function wireBody(content = blocks, toolParts = []) {
  const modelParts = content.flatMap(block => {
    if (block.type === 'text') return [{ text: block.text }]
    if (block.type === 'reasoning') return [{ thought: true, text: block.text }]
    if (block.type === 'tool-call') return [{ functionCall: { id: block.id, name: block.name, args: JSON.parse(block.arguments) } }]
    return []
  })
  return {
    contents: [
      { role: 'user', parts: [{ text: 'Check this' }] },
      { role: 'model', parts: modelParts },
      ...content.some(block => block.type === 'tool-call') ? [{
        role: 'user',
        parts: [{ functionResponse: { id: localId, name: 'read_mock', response: { output: 'Done' }, ...toolParts.length ? { parts: toolParts } : {} } }],
      }] : [{ role: 'user', parts: [{ text: 'Follow up' }] }],
    ],
  }
}

function patched(envelope, content = blocks, targetRoute = route, toolParts = []) {
  const req = {
    provider: 'gemini', model, sessionId: 'offline',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Check this' }] },
      message(envelope, content),
      ...content.some(block => block.type === 'tool-call')
        ? [{ role: 'tool', toolCallId: localId, content: [{ type: 'text', text: 'Done' }] }]
        : [{ role: 'user', content: [{ type: 'text', text: 'Follow up' }] }],
    ],
  }
  return patchGenerateContentBody(wireBody(content, toolParts), req, targetRoute)
}

const summary = { status: 'completed', queries: ['query one', 'query two'], sources: [{ url: 'https://example.org/source', title: 'example.org' }] }

test('compact replay omits duplicate values, embeds cleanly in pi-ai envelope, and preserves multimodal tool results', () => {
  const nativeData = makeNativeReplayData(route, model, frames, [localId], 'complete', prefix, blocks)
  const piEnvelope = {
    response: { kind: 'pi-ai', version: 2, api: 'google-generative-ai', provider: 'gemini', model, stopReason: 'toolUse' },
    blocks: [{ type: 'text', textSignature: 'first-signature' }],
  }
  const embedded = attachNativeReplay(piEnvelope, nativeData)
  assert.equal(embedded.response.kind, 'pi-ai')
  assert.equal(embedded.response.dshGeminiNative.version, 2)
  assert.ok(embedded.response.dshGeminiNative.refs.length > 0, 'expect references in the substantial mixed response')
  for (const block of blocks) {
    assert.ok(!JSON.stringify(embedded).includes(block.text ?? 'Argument data '), `duplicate ${block.type}`)
  }
  assert.ok(Buffer.byteLength(JSON.stringify(embedded)) < Buffer.byteLength(JSON.stringify(v1)) / 2)
  const cold = clone(embedded)
  const durableBlocks = clone(blocks)
  const decoded = readNativeReplay(cold, durableBlocks)
  assert.equal(JSON.stringify(decoded.frames), JSON.stringify(frames))
  assert.deepEqual(decoded.frames[0][0], alternate)
  assert.equal(frames[0][1].content.parts[0].text, blocks[0].text, 'encoding never mutates the original parts')
  const toolImage = [{ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }]
  const out = patched(cold, durableBlocks, route, toolImage)
  assert.equal(out.changed, true)
  assert.equal(JSON.stringify(out.body.contents[1].parts), JSON.stringify(parts))
  assert.equal(out.body.contents[2].parts[0].functionResponse.id, 'wire-read-9')
  assert.deepEqual(out.body.contents[2].parts[0].functionResponse.parts, toolImage)
  assert.equal(out.body.toolConfig.includeServerSideToolInvocations, true)
  assert.deepEqual(patched(cold).body.contents, patched(v1).body.contents)
})

test('missing, changed and malformed references fail closed without losing upload exclusion', () => {
  const envelope = build()
  assert.equal(readNativeReplay(envelope), undefined)
  const changed = clone(blocks)
  changed[0].text = 'different'
  assert.equal(readNativeReplay(envelope, changed), undefined)
  assert.deepEqual(patched(envelope, changed).body.contents[1].parts[0], { text: 'different' })
  const malformed = clone(envelope)
  malformed.response.refs[0][0] = 420
  assert.equal(readNativeReplay(malformed, blocks), undefined)
  assert.equal(hasNativeReplay(confirmation(malformed)), true)
  const duplicate = clone(envelope)
  duplicate.response.refs.push(duplicate.response.refs[0])
  assert.equal(readNativeReplay(duplicate, blocks), undefined)
  const reordered = clone(blocks)
  reordered[2].arguments = JSON.stringify({ mode: false, payload: 'Argument data '.repeat(64) })
  assert.equal(readNativeReplay(envelope, reordered), undefined, 'a reordered JSON argument changes the original wire representation')
  const unknownVersion = clone(envelope)
  unknownVersion.response.version += 1
  assert.equal(readNativeReplay(unknownVersion, blocks), undefined)
  assert.equal(hasNativeReplay(confirmation(unknownVersion)), true)
  assert.strictEqual(readNativeReplay(v1), v1.response)
  assert.equal(hasNativeReplay(confirmation(v1)), true)
})

test('the writer leaves unmatched text, failed or truncated responses, and tiny responses raw', () => {
  const mismatched = clone(blocks)
  mismatched[0].text = 'not equal'
  const stillCompact = build('complete', mismatched)
  assert.ok(stillCompact.response.refs.length > 0)
  assert.equal(stillCompact.response.frames[0][1].content.parts[0].text, blocks[0].text)
  assert.equal(JSON.stringify(readNativeReplay(stillCompact, mismatched).frames), JSON.stringify(frames))
  for (const outcome of ['failed', 'truncated']) {
    const envelope = build(outcome)
    assert.deepEqual(envelope.response.refs, [])
    assert.equal(JSON.stringify(readNativeReplay(clone(envelope)).frames), JSON.stringify(frames))
    assert.ok(hasNativeReplay({ type: 'assistant/attempt', data: { turn: 1, stream: terminal(envelope, []) } }))
  }
  const tiny = [[selected([{ text: 'OK' }])]]
  const envelope = makeReplayState(route, model, tiny, [], 'complete', prefix, [{ type: 'text', text: 'OK' }])
  assert.deepEqual(envelope.response.refs, [])
  assert.deepEqual(readNativeReplay(clone(envelope)).frames, tiny)
})

test('same-part text and function references keep absent and empty function fields distinct', () => {
  const longName = 'normalized_name_'.repeat(12)
  const text = 'ref-stays-in-original-field-order '.repeat(40)
  const inputParts = [
    { functionCall: { future: 1, id: 'no-args', name: longName }, text, extra: null },
    { functionCall: { args: {}, name: longName, id: 'empty-args' } },
  ]
  const inputBlocks = [
    { type: 'text', text },
    { type: 'tool-call', name: longName, id: 'local-absent', arguments: '{}' },
    { type: 'tool-call', name: longName, id: 'local-empty', arguments: '{}' },
  ]
  const inputFrames = [[selected(inputParts)]]
  const envelope = makeReplayState(route, model, inputFrames, ['local-absent', 'local-empty'], 'complete', prefix, inputBlocks)
  assert.ok(envelope.response.refs.length, 'large text should make compaction worthwhile')
  const decoded = readNativeReplay(clone(envelope), clone(inputBlocks))
  assert.equal(JSON.stringify(decoded.frames), JSON.stringify(inputFrames))
  assert.ok(!Object.hasOwn(decoded.frames[0][0].content.parts[0].functionCall, 'args'))
  assert.ok(Object.hasOwn(decoded.frames[0][0].content.parts[1].functionCall, 'args'))
})

test('projection is ordered and can decode cold interrupted events from authoritative block ends', () => {
  const piEmbedded = attachNativeReplay(
    { response: { kind: 'pi-ai', version: 2, api: 'google-generative-ai', provider: 'gemini', model, stopReason: 'stop' }, blocks: [] },
    makeNativeReplayData(route, model, frames, [localId], 'complete', prefix, blocks),
  )
  const apply = nativeSearchProjection.apply
  assert.deepEqual(apply({}, confirmation(clone(piEmbedded))), { 1: [summary] })
  assert.deepEqual(apply({}, confirmation(clone(build()))), { 1: [summary] })
  assert.deepEqual(apply({}, confirmation(v1)), { 1: [summary] })
  const reduced = blocks.filter(block => block.type !== 'tool-call')
  const interrupted = { ...confirmation(clone(piEmbedded), reduced), data: { ...confirmation(clone(piEmbedded), reduced).data, interrupted: true } }
  assert.equal(JSON.stringify(nativeReplayOf(clone(interrupted)).frames), JSON.stringify(frames))
  assert.deepEqual(apply({}, clone(interrupted)), { 1: [summary] })
  const attempt = { type: 'assistant/attempt', data: { turn: 1, stream: terminal(clone(piEmbedded)) } }
  assert.deepEqual(apply({}, clone(attempt)), { 1: [summary] })
  const missing = { type: 'assistant/attempt', data: { turn: 1, stream: terminal(clone(piEmbedded), reduced) } }
  const before = {}
  assert.strictEqual(apply(before, missing), before)
  assert.equal(hasNativeReplay(missing), true)
})

test('slice refs compact multi-frame streamed text/reasoning, reject bad slices, and stay compatible with legacy unmerged messages', () => {
  const r1 = 'Thinking part one 🧪 '.repeat(12)
  const r2 = 'Thinking part two. '.repeat(12)
  const t1 = 'First markdown **chunk '.repeat(16)
  const t2 = 'second markdown chunk**. '.repeat(16)
  const t3 = 'Final tail.'
  const streamedFrames = [
    [selected([{ thought: true, text: r1, thoughtSignature: 'sig-r1' }])],
    [selected([{ thought: true, text: r2, thoughtSignature: 'sig-r2' }])],
    [selected([{ text: t1, thoughtSignature: 'sig-t1' }, { text: '', thoughtSignature: 'sig-empty' }])],
    [selected([{ text: t2, extra: 1 }])],
    [selected([{ text: t3 }], { finishReason: 'STOP' })],
  ]
  const mergedBlocks = [
    { type: 'reasoning', text: r1 + r2 },
    { type: 'text', text: t1 + t2 + t3 },
  ]
  const envelope = makeReplayState(route, model, streamedFrames, [], 'complete', prefix, mergedBlocks)
  assert.equal(envelope.response.version, 2)
  assert.equal(envelope.response.refs.length, 5)
  assert.ok(envelope.response.refs.every(ref => ref.length === 7))
  assert.ok(!JSON.stringify(envelope).includes(r1))
  assert.ok(!JSON.stringify(envelope).includes(t2))
  assert.equal(JSON.stringify(readNativeReplay(clone(envelope), clone(mergedBlocks)).frames), JSON.stringify(streamedFrames))
  assert.deepEqual(
    patched(clone(envelope), clone(mergedBlocks)).body.contents[1].parts,
    streamedFrames.flatMap(frame => frame[0].content.parts),
  )

  for (const mutate of [
    ref => { ref[5] = ref[6] },
    ref => { ref[6] = mergedBlocks[ref[3]].text.length + 1 },
    ref => { ref[5] = -1 },
    ref => { ref[4] = 2 },
    ref => { ref.push(0) },
  ]) {
    const bad = clone(envelope)
    mutate(bad.response.refs[0])
    assert.equal(readNativeReplay(bad, mergedBlocks), undefined)
  }

  const legacyBlocks = [
    { type: 'reasoning', text: r1 },
    { type: 'reasoning', text: r2 },
    { type: 'text', text: t1 },
    { type: 'text', text: t2 },
    { type: 'text', text: t3 },
  ]
  const legacyV1 = { response: { kind: 'dsh-gemini-generate-content', version: 1, route: route.identity, model,
    frames: streamedFrames, callIds: [], outcome: 'complete', prefix } }
  assert.deepEqual(
    patched(legacyV1, legacyBlocks).body.contents[1].parts,
    streamedFrames.flatMap(frame => frame[0].content.parts),
  )
})

test('signed-empty parts open v2 text runs without consuming or merging the adjacent slices', () => {
  const r1 = 'First thought chunk. '.repeat(32)
  const r2 = 'Second thought chunk. '.repeat(32)
  const r3 = 'A distinct thought run. '.repeat(32)
  const call = { type: 'tool-call', name: 'read_mock', id: localId, arguments: '{"path":"a.txt"}' }
  const raw = [
    { text: '', thoughtSignature: 'leading-empty' },
    { thought: true, text: r1 },
    { thought: true, text: '', thoughtSignature: 'same-run-empty' },
    { thought: true, text: r2 },
    { text: '', thoughtSignature: 'after-thought-empty' },
    { thought: true, text: r3 },
    { functionCall: { name: call.name, args: JSON.parse(call.arguments) }, thoughtSignature: 'call' },
    { text: '', thoughtSignature: 'after-function-call-empty' },
  ]
  const normalized = [
    { type: 'text', text: '' }, { type: 'reasoning', text: r1 + r2 },
    { type: 'text', text: '' }, { type: 'reasoning', text: r3 }, call, { type: 'text', text: '' },
  ]
  const rawFrames = raw.map(part => [selected([part])])
  const envelope = makeReplayState(route, model, rawFrames, [localId], 'complete', prefix, normalized)
  assert.equal(envelope.response.version, 2)
  assert.ok(envelope.response.digest)
  assert.deepEqual(envelope.response.refs.filter(ref => ref[4] === 1).map(ref => [ref[0], ref[3]]), [[1, 1], [3, 1], [5, 3]])
  assert.deepEqual(readNativeReplay(clone(envelope), clone(normalized)).frames, rawFrames)
  const out = patched(clone(envelope), clone(normalized))
  assert.equal(out.replayedModelTurns, 1)
  assert.deepEqual(out.body.contents[1].parts, raw)
  assert.ok(!Object.hasOwn(out.body.contents[2].parts[0].functionResponse, 'id'))

  const legacy = { response: { ...v1.response, frames: rawFrames } }
  const olderBlocks = [{ type: 'reasoning', text: r1 + r2 + r3 }, call]
  assert.deepEqual(patched(legacy, olderBlocks).body.contents[1].parts, raw, 'legacy grouped records may omit empty runs')
})

test('functionResponse ID is stripped when the original Gemini functionCall had no id', () => {
  const noIdCall = { functionCall: { name: 'read_mock', args: { path: 'a.txt' } }, thoughtSignature: 'sig-no-id' }
  const noIdFrames = [[selected([noIdCall], { finishReason: 'STOP' })]]
  const noIdBlocks = [{ type: 'tool-call', id: localId, name: 'read_mock', arguments: JSON.stringify({ path: 'a.txt' }) }]
  const env = makeReplayState(route, model, noIdFrames, [localId], 'complete', prefix, noIdBlocks)
  const out = patched(env, noIdBlocks)
  assert.equal(out.changed, true)
  assert.deepEqual(out.body.contents[1].parts, [noIdCall])
  assert.ok(!Object.hasOwn(out.body.contents[2].parts[0].functionResponse, 'id'))
})

test('incremental prefixes keep the legacy JSON bytes across v1/v2 and multimodal tool turns', () => {
  const image = { inlineData: { data: 'iVBORw0KGgo=', mimeType: 'image/png' } }
  const opening = { role: 'user', parts: [
    { text: '对照 "原样" 🧪\r\n' }, image,
    { fileData: { fileUri: 'https://example.org/reference.pdf', mimeType: 'application/pdf' } },
  ] }
  const [, wireCall, wireResult] = wireBody(blocks, [image]).contents
  const [resultPart] = wireResult.parts
  const alignedResult = { ...wireResult, parts: [{ functionResponse: { ...resultPart.functionResponse, id: 'wire-read-9' } }] }
  const text = '续轮内容 😀\n'.repeat(64)
  const followBlocks = [{ type: 'text', text }]
  const followParts = [{ opaque: { z: 1, a: null }, text, thoughtSignature: 'follow-sig' }]
  const follow = { role: 'model', parts: [{ text }] }
  const tail = { role: 'user', parts: [{ text: 'Tail with an unpaired surrogate: \ud800' }] }
  const contents = [opening, wireCall, wireResult, follow, tail]
  const expected = [opening, { ...wireCall, parts }, alignedResult, { ...follow, parts: followParts }, tail]

  for (const instruction of [
    { systemParts: [] },
    { systemInstruction: '系统 "指令" 🎵', systemParts: [{ text: '系统 "指令" 🎵' }] },
    { systemInstruction: { parts: [{ text: '首段\n' }, { text: '次段 🎵', tag: { b: false, a: 1 } }] } },
  ]) {
    const { systemInstruction, systemParts = systemInstruction.parts } = instruction
    const legacy = { response: { ...v1.response, prefix: historyFingerprint([opening], systemParts) } }
    const native = makeNativeReplayData(route, model, [[selected(followParts)]], [], 'complete',
      historyFingerprint(expected.slice(0, 3), systemParts), followBlocks)
    assert.ok(native.refs.length > 0, 'the second turn must decode compact v2 references')
    const embedded = attachNativeReplay({ response: { kind: 'pi-ai', version: 2 } }, native)
    const request = { provider: 'gemini', model, messages: [message(clone(legacy)), message(clone(embedded), followBlocks)] }
    const output = patchGenerateContentBody({ contents, systemInstruction }, request, route)
    assert.equal(output.totalModelTurns, 2)
    assert.equal(output.replayedModelTurns, 2, 'the second prefix must include the aligned tool response')
    assert.equal(JSON.stringify(output.body.contents), JSON.stringify(expected))
    assert.equal(output.prefix, historyFingerprint(expected, systemParts))
    assert.equal(patchGenerateContentBody({ contents: [], systemInstruction }, request, route).prefix, historyFingerprint([], systemParts))
  }
})

const userEntry = (...parts) => ({ role: 'user', parts: parts.map(part => typeof part === 'string' ? { text: part } : part) })
const textEntry = (text, thoughtSignature) => ({ role: 'model', parts: [{ text, ...thoughtSignature && { thoughtSignature } }] })
const geminiRequest = messages => ({ provider: 'gemini', model, messages })

function recordedText(entry, prefix, recordedRoute = route) {
  const content = [{ type: 'text', text: entry.parts[0].text }]
  return message(makeReplayState(recordedRoute, model, [[selected(entry.parts)]], [], 'complete', prefix, content), content)
}

function historicalRoute(baseURL, googleSearch) {
  const entry = { provider: 'gemini', baseURL, googleSearch }
  return { ...entry, identity: routeIdentity(entry) }
}

test('changed prompt, pruned tool result, offloaded image, and compacted tail do not invalidate retained steps', () => {
  const image = { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }
  const opening = userEntry('Check this', image)
  const [, wireCall, result] = wireBody(blocks).contents
  const aligned = { ...result.parts[0].functionResponse, id: 'wire-read-9' }
  const previousSystem = [{ text: 'Original system instructions' }]
  const later = textEntry('Later retained reply. '.repeat(32), 'later-signature')
  const normalizedLater = textEntry(later.parts[0].text)
  const latestPrompt = userEntry('Next question')
  const earlierRecord = message({ response: { ...v1.response, prefix: historyFingerprint([opening], previousSystem) } })
  const laterRecord = recordedText(later, historyFingerprint([opening, { ...wireCall, parts }, userEntry({ functionResponse: aligned })], previousSystem))
  assert.ok(laterRecord.source.replayState.response.refs.length > 0)

  for (const [label, systemParts, first, feedback] of [
    ['system prompt change', [{ text: 'New local or plan instructions' }], opening, result],
    ['tool result pruned', previousSystem, opening, userEntry({ functionResponse: { ...result.parts[0].functionResponse, response: { output: '[Pruned]' } } })],
    ['image offloaded', previousSystem, userEntry('Check this', '[Image offloaded]'), result],
  ]) {
    const contents = [first, wireCall, feedback, normalizedLater, latestPrompt]
    const req = geminiRequest([
      { role: 'user', content: first.parts.filter(part => part.text !== undefined).map(part => ({ type: 'text', text: part.text })) },
      earlierRecord,
      { role: 'tool', toolCallId: localId, content: [{ type: 'text', text: feedback.parts[0].functionResponse.response.output }] },
      laterRecord,
    ])
    const out = patchGenerateContentBody({ contents, systemInstruction: { parts: systemParts } }, req, route)
    assert.equal(out.replayedModelTurns, 2, label)
    assert.deepEqual(out.body.contents, [first, { ...wireCall, parts }, userEntry({ functionResponse: { ...feedback.parts[0].functionResponse, id: 'wire-read-9' } }), later, latestPrompt], label)
    assert.equal(out.prefix, historyFingerprint(out.body.contents, systemParts), label)
  }

  const summary = userEntry('Summary replacing earlier steps')
  const newSummaryRequest = userEntry('Summarize the retained history')
  const compacted = patchGenerateContentBody({ contents: [summary, normalizedLater, newSummaryRequest] },
    { ...geminiRequest([laterRecord]), purpose: 'compaction' }, route)
  assert.equal(compacted.replayedModelTurns, 1)
  assert.deepEqual(compacted.body.contents, [summary, later, newSummaryRequest])
})

test('legacy v1/v2 replay survives a mirror change and Search only gates native-tool steps', () => {
  const previousRoute = historicalRoute('https://old-mirror.test/v1beta', true)
  const nextRoute = historicalRoute('https://new-mirror.test/v1beta', true)
  const noSearch = historicalRoute(nextRoute.baseURL, false)
  assert.notEqual(previousRoute.identity, nextRoute.identity)
  assert.notEqual(nextRoute.identity, noSearch.identity)
  const [opening, wireCall, wireResult] = wireBody().contents
  const reply = textEntry('An ordinary signed response. '.repeat(32), 'reply-signature')
  const normalizedReply = textEntry(reply.parts[0].text)
  const legacy = message({ response: { ...v1.response, route: previousRoute.identity } })
  const modern = recordedText(reply, prefix, previousRoute)
  assert.ok(modern.source.replayState.response.refs.length > 0)
  const contents = [opening, wireCall, wireResult, normalizedReply]
  const request = geminiRequest([legacy, modern])

  const on = patchGenerateContentBody({ contents }, request, nextRoute)
  assert.equal(on.replayedModelTurns, 2)
  assert.deepEqual(on.body.contents[1].parts, parts)
  assert.deepEqual(on.body.contents[3], reply)

  for (const [targetRoute, toolConfig] of [[noSearch, undefined], [nextRoute, { includeServerSideToolInvocations: false }]]) {
    const out = patchGenerateContentBody({ contents, toolConfig }, request, targetRoute)
    assert.equal(out.replayedModelTurns, 1)
    assert.deepEqual(out.body.contents, [opening, wireCall, wireResult, reply])
    if (toolConfig) assert.equal(out.body.toolConfig.includeServerSideToolInvocations, false)
  }

  const calling = { functionCallingConfig: { mode: 'AUTO' } }
  const incompatible = patchGenerateContentBody({ contents, toolConfig: calling, tools: [{ functionDeclarations: [{ name: 'read_mock' }] }] }, request, nextRoute)
  assert.equal(incompatible.replayedModelTurns, 1)
  assert.deepEqual(incompatible.body.contents, [opening, wireCall, wireResult, reply])
  assert.deepEqual(incompatible.body.toolConfig, calling, 'do not force server-tool circulation alongside AUTO')

  for (const change of [{ provider: 'other' }, { model: 'other-model' }]) {
    const out = patchGenerateContentBody({ contents }, { ...request, ...change }, noSearch)
    assert.equal(out.replayedModelTurns, 0)
    assert.strictEqual(out.body.contents, contents)
  }
})

test('identical replies follow monotonic positions even with missing prefixes and omitted assistant entries', () => {
  const opening = userEntry('Rewritten prompt')
  const repeat = textEntry('Same reply')
  const first = textEntry('Same reply', 'first-signature')
  const second = textEntry('Same reply', 'second-signature')
  const omitted = { role: 'assistant', content: [{ type: 'reasoning', text: 'Thinking stripped by pi-ai' }], source: { provider: 'other', model } }
  const req = geminiRequest([recordedText(first, 'stale'), omitted, recordedText(second)])
  const followup = userEntry('Follow up')
  const out = patchGenerateContentBody({ contents: [opening, repeat, followup, repeat] }, req, route)
  assert.equal(out.replayedModelTurns, 2)
  assert.deepEqual(out.body.contents, [opening, first, followup, second])
})

test('ambiguous reply stays normalized without taking a later turn out of the cursor', () => {
  const opening = userEntry('Rewritten prompt')
  const repeat = textEntry('Same reply')
  const tail = textEntry('Unambiguous tail', 'tail-signature')
  const normalizedTail = textEntry(tail.parts[0].text)
  const lookalike = { role: 'assistant', content: [{ type: 'text', text: repeat.parts[0].text }], source: { provider: 'other', model } }
  const out = patchGenerateContentBody({ contents: [opening, repeat, normalizedTail] }, geminiRequest([
    recordedText(textEntry(repeat.parts[0].text, 'stale-signature'), 'stale'), lookalike, recordedText(tail, 'also-stale'),
  ]), route)
  assert.equal(out.replayedModelTurns, 1)
  assert.deepEqual(out.body.contents, [opening, repeat, tail])
})

test('a signed-empty-only wire reply cannot be confused with omitted foreign reasoning', () => {
  const wirePart = { text: '', thoughtSignature: 'empty-signature' }
  const captured = { role: 'model', parts: [{ ...wirePart, opaqueField: { preserved: true } }] }
  const omitted = { role: 'assistant', content: [{ type: 'reasoning', text: 'Not sent' }], source: { provider: 'other', model } }
  const contents = [userEntry('Rewritten prompt'), { role: 'model', parts: [wirePart] }]
  const out = patchGenerateContentBody({ contents }, geminiRequest([omitted, recordedText(captured, 'stale')]), route)
  assert.equal(out.replayedModelTurns, 1)
  assert.deepEqual(out.body.contents[1], captured)
})

test('only a unique structural match with an exact prefix breaks an alignment tie', () => {
  const opening = userEntry('Exact prefix')
  const exact = historyFingerprint([opening])
  const repeat = textEntry('Same reply')
  const first = textEntry('Same reply', 'first-signature')
  const second = textEntry('Same reply', 'second-signature')
  const contents = [opening, repeat]
  const preferred = patchGenerateContentBody({ contents }, geminiRequest([recordedText(first, 'stale'), recordedText(second, exact)]), route)
  assert.equal(preferred.replayedModelTurns, 1)
  assert.deepEqual(preferred.body.contents, [opening, second])

  const tied = patchGenerateContentBody({ contents }, geminiRequest([recordedText(first, exact), recordedText(second, exact)]), route)
  assert.equal(tied.replayedModelTurns, 0)
  assert.strictEqual(tied.body.contents, contents)

  const signedContents = [opening, first]
  const contradicted = patchGenerateContentBody({ contents: signedContents }, geminiRequest([
    recordedText(first, 'stale'), recordedText(second, exact),
  ]), route)
  assert.equal(contradicted.replayedModelTurns, 0)
  assert.strictEqual(contradicted.body.contents, signedContents, 'a prefix cannot override a contradictory wire signature')

  const intervening = userEntry('Follow up')
  const combined = [opening, repeat, intervening, repeat]
  const revisited = patchGenerateContentBody({ contents: combined }, geminiRequest([
    recordedText(first, 'stale-first'),
    recordedText(second, historyFingerprint(combined.slice(0, 3))),
    recordedText(textEntry('Same reply', 'last-signature'), 'stale-last'),
  ]), route)
  assert.equal(revisited.replayedModelTurns, 1)
  assert.deepEqual(revisited.body.contents, [opening, repeat, intervening, second])
})

test('existing text signatures must belong to the same run, including across an omitted empty thought', () => {
  const first = { text: 'First visible run', thoughtSignature: 'first-signature' }
  const second = { text: 'Second visible run', thoughtSignature: 'second-signature' }
  const raw = [first, { text: '', thought: true }, second]
  const normalized = [{ type: 'text', text: first.text }, { type: 'reasoning', text: '' }, { type: 'text', text: second.text }]
  const envelope = makeReplayState(route, model, [[selected(raw)]], [], 'complete', prefix, normalized)
  const req = geminiRequest([message(envelope, normalized)])
  const replay = patchGenerateContentBody({ contents: [userEntry('Check this'), { role: 'model', parts: [first, second] }] }, req, route)
  assert.equal(replay.replayedModelTurns, 1)
  assert.deepEqual(replay.body.contents[1].parts, raw)

  const swapped = [{ role: 'model', parts: [
    { ...first, thoughtSignature: second.thoughtSignature }, { ...second, thoughtSignature: first.thoughtSignature },
  ] }]
  const unchanged = patchGenerateContentBody({ contents: swapped }, req, route)
  assert.equal(unchanged.replayedModelTurns, 0)
  assert.strictEqual(unchanged.body.contents, swapped)
})

test('match call arguments and IDs and restore parallel results as one verified exchange', () => {
  const makeCall = (id, path) => ({ functionCall: { id, name: 'read_mock', args: { path } } })
  const a = makeCall('local-a', 'a.txt')
  const b = makeCall('local-b', 'b.txt')
  const nativeParts = [makeCall('native-a', 'a.txt'), makeCall('native-b', 'b.txt')]
  const localBlocks = [a, b].map(({ functionCall: { id, name, args } }) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) }))
  const fromNative = parts => geminiRequest([message(
    makeReplayState(route, model, [[selected(parts)]], ['local-a', 'local-b'], 'complete', prefix, localBlocks), localBlocks,
  )])
  const req = fromNative(nativeParts)
  const modelEntry = (...parts) => ({ role: 'model', parts })
  const result = (id, output) => ({ functionResponse: { id, name: 'read_mock', response: { output } } })
  const opening = userEntry('Check this')
  const order = userEntry(result('local-b', 'b'), result('local-a', 'a'))
  const out = patchGenerateContentBody({ contents: [opening, modelEntry(a, b), order] }, req, route)
  assert.equal(out.replayedModelTurns, 1)
  assert.deepEqual(out.body.contents, [opening, modelEntry(...nativeParts), userEntry(result('native-b', 'b'), result('native-a', 'a'))])

  for (const sequence of [
    [modelEntry(makeCall('local-a', 'changed.txt'), b), order],
    [modelEntry(makeCall('foreign-a', 'a.txt'), b), order],
    [modelEntry(b, a), order],
    [modelEntry(a, b), userEntry(result('foreign-b', 'b'), result('local-a', 'a'))],
  ]) {
    const contents = [opening, ...sequence]
    const unchanged = patchGenerateContentBody({ contents }, req, route)
    assert.equal(unchanged.replayedModelTurns, 0)
    assert.strictEqual(unchanged.body.contents, contents)
  }

  const signedCalls = modelEntry({ ...a, thoughtSignature: 'sig-a' }, { ...b, thoughtSignature: 'sig-b' })
  const swappedNative = [{ ...nativeParts[0], thoughtSignature: 'sig-b' }, { ...nativeParts[1], thoughtSignature: 'sig-a' }]
  const duplicateNativeIds = [makeCall('same-id', 'a.txt'), makeCall('same-id', 'b.txt')]
  for (const [modelTurn, capture] of [[signedCalls, swappedNative], [modelEntry(a, b), duplicateNativeIds]]) {
    const contents = [opening, modelTurn, order]
    const unchanged = patchGenerateContentBody({ contents }, fromNative(capture), route)
    assert.equal(unchanged.replayedModelTurns, 0)
    assert.strictEqual(unchanged.body.contents, contents)
  }
})

test('ID-less parallel results can be split by an image but cannot be guessed for native ID rebinding', () => {
  const a = { functionCall: { name: 'read_mock', args: { path: 'a.txt' } } }
  const b = { functionCall: { name: 'read_mock', args: { path: 'b.txt' } } }
  const calls = [a, b]
  const ids = ['local-a', 'local-b']
  const localBlocks = calls.map(({ functionCall: { name, args } }, i) => ({ type: 'tool-call', id: ids[i], name, arguments: JSON.stringify(args) }))
  const record = nativeParts => geminiRequest([message(
    makeReplayState(route, model, [[selected(nativeParts)]], ids, 'complete', prefix, localBlocks), localBlocks,
  )])
  const modelTurn = { role: 'model', parts: calls }
  const result = response => ({ functionResponse: { name: 'read_mock', response } })
  // pi-ai can append a synthetic result for A after receiving B's result.
  const ambiguous = [modelTurn, userEntry(result({ output: 'Result B' }), result({ error: 'No result provided' }))]
  const nativeWithIds = calls.map((part, i) => ({ ...part, functionCall: { ...part.functionCall, id: `native-${i}` } }))
  const unchanged = patchGenerateContentBody({ contents: ambiguous }, record(nativeWithIds), route)
  assert.equal(unchanged.replayedModelTurns, 0)
  assert.strictEqual(unchanged.body.contents, ambiguous)

  const nativeWithoutIds = [{ ...a, thoughtSignature: 'signed-first-call' }, b]
  const sentWithIds = { role: 'model', parts: calls.map((part, i) => ({ ...part, functionCall: { ...part.functionCall, id: ids[i] } })) }
  const idResult = (i, response) => ({ functionResponse: { ...result(response).functionResponse, id: ids[i] } })
  const responseB = { output: 'Result B' }
  const missingA = { error: 'No result provided' }
  const reversed = [sentWithIds, userEntry(idResult(1, responseB), idResult(0, missingA))]
  const notStripped = patchGenerateContentBody({ contents: reversed }, record(nativeWithoutIds), route)
  assert.equal(notStripped.replayedModelTurns, 0)
  assert.strictEqual(notStripped.body.contents, reversed)

  const ordered = [sentWithIds, userEntry(idResult(0, missingA), idResult(1, responseB))]
  const stripped = patchGenerateContentBody({ contents: ordered }, record(nativeWithoutIds), route)
  assert.equal(stripped.replayedModelTurns, 1)
  assert.deepEqual(stripped.body.contents[1], userEntry(result(missingA), result(responseB)))

  const separated = [modelTurn, userEntry(result({ output: '(see attached image)' })),
    userEntry('Tool result image:', { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }),
    userEntry(result({ output: 'Result B' }))]
  const replay = patchGenerateContentBody({ contents: separated }, record(nativeWithoutIds), route)
  assert.equal(replay.replayedModelTurns, 1)
  assert.deepEqual(replay.body.contents, [{ ...modelTurn, parts: nativeWithoutIds }, ...separated.slice(1)])
})

test('patchGenerateContentBody aligns compaction requests with native history and rejects other auxiliary purposes', () => {
  const embedded = attachNativeReplay(
    { response: { kind: 'pi-ai', version: 2, api: 'google-generative-ai', provider: 'gemini', model, stopReason: 'toolUse' }, blocks: [] },
    makeNativeReplayData(route, model, frames, [localId], 'complete', prefix, blocks),
  )
  const tools = [{ functionDeclarations: [{ name: 'read_mock' }, { name: 'web_search' }] }]
  const base = wireBody(blocks)
  const mainBody = { ...base, tools }
  const compactionBody = {
    ...mainBody,
    contents: [...mainBody.contents, { role: 'user', parts: [{ text: 'Condense the conversation ABOVE.' }] }],
  }
  const baseMessages = [
    { role: 'user', content: [{ type: 'text', text: 'Check this' }] },
    message(clone(embedded), blocks),
    { role: 'tool', toolCallId: localId, content: [{ type: 'text', text: 'Done' }] },
  ]
  const mainReq = { provider: 'gemini', model, sessionId: 'offline', messages: baseMessages }
  const compactionReq = {
    ...mainReq,
    purpose: 'compaction',
    messages: [...baseMessages, { role: 'user', content: [{ type: 'text', text: 'Condense the conversation ABOVE.' }] }],
  }

  const mainOut = patchGenerateContentBody(mainBody, mainReq, route)
  const compactionOut = patchGenerateContentBody(compactionBody, compactionReq, route)
  assert.equal(compactionOut.changed, true)
  assert.equal(JSON.stringify(compactionOut.body.contents.slice(0, 3)), JSON.stringify(mainOut.body.contents))
  assert.equal(JSON.stringify(compactionOut.body.contents[1].parts), JSON.stringify(parts))
  assert.equal(compactionOut.body.contents[2].parts[0].functionResponse.id, 'wire-read-9')
  assert.deepEqual(compactionOut.body.tools, [{ functionDeclarations: [{ name: 'read_mock' }] }, { googleSearch: {} }])
  assert.equal(compactionOut.body.toolConfig.includeServerSideToolInvocations, true)

  // Other auxiliary purposes (such as session-title) must not replay history.
  const titleOut = patchGenerateContentBody(
    mainBody,
    { ...mainReq, purpose: 'session-title' },
    { identity: route.identity, googleSearch: false },
  )
  assert.equal(titleOut.changed, false)
  assert.deepEqual(titleOut.body.contents[1].parts, mainBody.contents[1].parts)
  assert.equal(titleOut.body.contents[2].parts[0].functionResponse.id, localId)
  assert.equal(titleOut.body.toolConfig, undefined)
})

test('only exact Gemini 4 family IDs participate, including case-insensitive models/ resources', () => {
  const models = ['gemini-4-argon', 'gemini-4-carbon', 'gemini-4-neon', 'gemini-4-hydrogen', 'MoDeLs/GEMINI-4-NEON']
  const rejected = [
    undefined, '', 'gemini-3.1-pro', 'gemini-2.5-pro', 'gemini-4-other', 'gemini-4-neon-preview',
    'gemini-4-argon@custom', 'gemini-4-hydrogen-tts', 'gemini-4-carbon-image',
    'gemini-4-neon\n', 'models/models/gemini-4-neon', 'tunedModels/gemini-4-hydrogen',
  ]
  const raw = textEntry('Earlier model reply', 'signed-reply')
  const body = { contents: [userEntry('Ask'), textEntry(raw.parts[0].text), userEntry('Continue')] }
  const opts = { ...route, googleSearch: false, gemini4FamilyReplay: true }
  function patch(sourceModel, targetModel, { sourceProvider = 'gemini', storedModel = sourceModel, enabled = true } = {}) {
    const source = message({ response: { ...v1.response, model: storedModel, frames: [[selected(raw.parts)]], callIds: [] } },
      [{ type: 'text', text: raw.parts[0].text }])
    Object.assign(source.source, { provider: sourceProvider, model: sourceModel })
    return patchGenerateContentBody(body, { ...geminiRequest([source]), model: targetModel }, { ...opts, gemini4FamilyReplay: enabled })
  }
  for (const sourceModel of models) {
    assert.equal(isGemini4FamilyModel(sourceModel), true)
    for (const targetModel of models) {
      if (targetModel === sourceModel) continue
      const out = patch(sourceModel, targetModel)
      assert.deepEqual(out.body.contents[1], raw, `${sourceModel} → ${targetModel}`)
      assert.equal(out.replayedModelTurns, 1)
      assert.equal(out.sameModelReplayedTurns, 0)
      assert.equal(out.crossModelReplayedTurns, 1)
      assert.equal(out.crossModelCandidateTurns, 1)
    }
  }
  const [source, target] = models
  for (const modelId of rejected) {
    assert.equal(isGemini4FamilyModel(modelId), false, String(modelId))
    assert.strictEqual(patch(modelId, target).body, body)
    assert.strictEqual(patch(source, modelId).body, body)
  }
  for (const overrides of [{ sourceProvider: 'other' }, { storedModel: target }]) {
    const out = patch(source, target, overrides)
    assert.strictEqual(out.body, body)
    assert.equal(out.crossModelCandidateTurns, 0)
  }
  const disabled = patch(source, target, { enabled: false })
  assert.strictEqual(disabled.body, body)
  assert.equal(disabled.replayedModelTurns, 0)
  assert.equal(disabled.crossModelCandidateTurns, 1, 'report a viable candidate even with no same-model replay')
})

test('family replay restores validated v2 parts and calls without weakening alignment or Search circulation', () => {
  const sourceModel = 'gemini-4-hydrogen'
  const targetModel = 'gemini-4-neon'
  const envelope = makeReplayState(route, sourceModel, frames, [localId], 'complete', prefix, blocks)
  assert.ok(envelope.response.refs.length > 0)
  const source = message(envelope, blocks)
  source.source.model = sourceModel
  const thoughtOnly = [{ type: 'reasoning', text: 'No visible content' }]
  const omitted = message(makeReplayState(route, sourceModel, [[selected([
    { thought: true, text: thoughtOnly[0].text, thoughtSignature: 'signed-thought' },
  ])]], [], 'complete', prefix, thoughtOnly), thoughtOnly)
  omitted.source.model = sourceModel
  const req = { ...geminiRequest([omitted, source]), model: targetModel }
  const [opening, wireCall, result] = wireBody().contents
  // pi-ai strips foreign thinking and emits no model Content for a pure thought.
  const normalizedCall = { ...wireCall, parts: wireCall.parts.filter(part => !part.thought) }
  const body = { contents: [opening, normalizedCall, result] }
  const opts = { ...route, gemini4FamilyReplay: true }
  const out = patchGenerateContentBody(body, req, opts)
  assert.equal(out.totalModelTurns, 1)
  assert.equal(out.crossModelReplayedTurns, 1)
  assert.equal(out.crossModelCandidateTurns, 1)
  assert.deepEqual(out.body.contents, [opening, { role: 'model', parts }, userEntry({
    functionResponse: { ...result.parts[0].functionResponse, id: 'wire-read-9' },
  })])
  assert.equal(out.body.toolConfig.includeServerSideToolInvocations, true)

  const withThinking = { contents: [opening, wireCall, result] }
  const noCirculation = { ...body, toolConfig: { includeServerSideToolInvocations: false } }
  const corrupt = clone(source)
  corrupt.source.replayState.response.digest = 'wrong digest'
  const incomplete = clone(source)
  incomplete.source.replayState.response.outcome = 'truncated'
  for (const [wire, request] of [
    [withThinking, req], [noCirculation, req],
    [body, { ...req, messages: [corrupt] }], [body, { ...req, messages: [incomplete] }],
    [body, { ...req, purpose: 'compaction' }],
  ]) {
    const skipped = patchGenerateContentBody(wire, request, opts)
    assert.strictEqual(skipped.body.contents, wire.contents)
    assert.equal(skipped.crossModelReplayedTurns, 0)
    assert.equal(skipped.crossModelCandidateTurns, 0)
  }
})
