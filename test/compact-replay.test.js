import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  attachNativeReplay, hasNativeReplay, historyFingerprint, makeNativeReplayData, makeReplayState,
  nativeReplayOf, patchGenerateContentBody, readNativeReplay,
} from '../generate-content.js'
import { nativeSearchProjection } from '../native-search-projection.js'

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
  { futurePart: [1, '😀'], text: '' },
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
