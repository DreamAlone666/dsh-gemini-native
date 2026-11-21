import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  attachNativeReplay,
  historyFingerprint,
  makeNativeReplayData,
  makeReplayState,
} from '../src/generate-content.js'
import {
  diagnosticsProjection,
  diagnosticsProjectionKey,
  isLocalizedSystemText,
} from '../src/diagnostics-projection.js'

const routeA = { identity: 'route-a-sha256', googleSearch: true }
const routeB = { identity: 'route-b-sha256', googleSearch: false }
const modelA = 'gemini-2.5-pro'
const modelB = 'gemini-2.5-flash'
const prefix = historyFingerprint([{ role: 'user', parts: [{ text: 'hello' }] }])
const clone = value => JSON.parse(JSON.stringify(value))

function makeSearchFrames(queries = ['query one'], sources = [{ uri: 'https://example.org/a', title: 'Example A' }]) {
  const parts = [
    { toolCall: { id: 'gs-1', toolType: 'GOOGLE_SEARCH_WEB', args: { queries } } },
    { toolResponse: { id: 'gs-1', toolType: 'GOOGLE_SEARCH_WEB', response: { results: sources } } },
    { text: 'Answer text '.repeat(40) },
  ]
  const selected = { index: 0, content: { role: 'model', parts }, finishReason: 'STOP' }
  const alternate = {
    index: 1,
    content: {
      role: 'model',
      parts: [{ toolCall: { id: 'alt', toolType: 'GOOGLE_SEARCH_WEB', args: { query: 'ignored alternate' } } }],
    },
  }
  return [[alternate, selected]]
}

function makeNativeMessageEvent({
  seq = 1,
  route = routeA,
  model = modelA,
  outcome = 'complete',
  frames,
  blocks,
  callIds = [],
  embedPiAi = false,
  omitSourceReplay = false,
}) {
  const nativeData = makeNativeReplayData(route, model, frames, callIds, outcome, prefix, blocks)
  const envelope = embedPiAi
    ? attachNativeReplay(
        { response: { kind: 'pi-ai', version: 2, api: 'google-generative-ai', provider: 'gemini', model, stopReason: 'stop' }, blocks: [] },
        nativeData,
      )
    : { response: nativeData }
  const stream = [
    ...blocks.map((block, index) => ({ type: 'chunk', time: index + 1, chunk: { type: 'block-end', index, block } })),
    { type: 'chunk', time: blocks.length + 1, chunk: { type: 'finish', reason: { kind: 'stop' }, replayState: clone(envelope) } },
  ]
  const message = {
    role: 'assistant',
    content: blocks,
    source: omitSourceReplay
      ? { kind: 'model', provider: 'gemini', model }
      : { kind: 'model', provider: 'gemini', model, replayState: clone(envelope) },
  }
  return {
    type: 'assistant/message',
    seq,
    surfaceOp: 'append',
    data: { turn: 1, message, stream },
  }
}

test('metadata, reference stability on ignored events, and WeakMap view caching', () => {
  assert.equal(diagnosticsProjectionKey, 'geminiNativeDiagnostics')
  assert.equal(diagnosticsProjection.key, diagnosticsProjectionKey)
  assert.equal(diagnosticsProjection.stateVersion, 1)
  assert.equal(diagnosticsProjection.wire.summary, false)

  const initial = diagnosticsProjection.init()
  const { apply, wire } = diagnosticsProjection

  for (const ignored of [
    null,
    undefined,
    { type: 'user/message', seq: 1, surfaceOp: 'append', data: { message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } } },
    { type: 'tool/result', seq: 2, surfaceOp: 'append', data: { message: { role: 'tool', content: [{ type: 'text', text: 'ok' }] } } },
    { type: 'turn/end', seq: 3, data: { turn: 1 } },
    { type: 'compaction/start', seq: 4, data: {} },
    { type: 'assistant/attempt', seq: 5, data: { turn: 1, stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } }] } },
  ]) {
    assert.strictEqual(apply(initial, ignored), initial)
  }

  const view1 = wire.view(initial)
  const view2 = wire.view(initial)
  assert.strictEqual(view1, view2)
  assert.equal('systems' in view1, false)
  assert.equal('lastNativeRoute' in view1, false)
  assert.equal('lastNativeModel' in view1, false)

  const next = apply(initial, {
    type: 'system/message',
    seq: 1,
    surfaceOp: 'append',
    data: { message: { role: 'system', content: [{ type: 'text', text: 'English prompt' }] } },
  })
  assert.notStrictEqual(next, initial)
  const view3 = wire.view(next)
  assert.notStrictEqual(view3, view1)
  assert.strictEqual(wire.view(next), view3)
})

test('isLocalizedSystemText detects empty, English, and Simplified Chinese system prompt markers', () => {
  assert.equal(isLocalizedSystemText(null), null)
  assert.equal(isLocalizedSystemText(undefined), null)
  assert.equal(isLocalizedSystemText(123), null)
  assert.equal(isLocalizedSystemText(''), null)
  assert.equal(isLocalizedSystemText('   \n\t  '), null)

  assert.equal(isLocalizedSystemText('You are an AI agent powered by DeepSeek Harness.'), false)
  assert.equal(isLocalizedSystemText('Custom system prompt without localized markers.'), false)

  for (const sample of [
    '你是由 DeepSeek Harness 驱动的 AI 智能体。',
    '你是由 gemini-4-argon 模型驱动的编程智能体。',
    '你帮助用户定制 DeepSeek Harness 本身。',
    '以 @ 开头的标记是用户明确引用的路径。相对路径以工作区根目录为基准。',
    '检查每次 bash 调用结果中的 [exit code: N] 标记；如有失败，先查明原因，再继续。',
    '使用 read 工具查看文本文件，不要使用 cat、sed、head 或 tail 等 Shell 命令。',
    '编辑文件前先读取它，除非刚刚在本会话中创建或编辑过该文件。',
    '使用 glob 工具按路径模式查找文件，不要使用 Shell 的 find。',
    '使用 grep 工具搜索文件内容，不要使用 Shell 的 grep 或 rg。',
  ]) {
    assert.equal(isLocalizedSystemText(sample), true, `expected true for: ${sample}`)
  }
})

test('system/message recognition, compat append, and surfaceOp replace/compaction behavior', () => {
  const { apply, wire } = diagnosticsProjection
  let state = diagnosticsProjection.init()

  // Missing surfaceOp compat append without seq falls back to systems.length (0).
  state = apply(state, {
    type: 'system/message',
    data: { message: { role: 'system', content: [{ type: 'text', text: 'You are an AI agent.' }] } },
  })
  assert.deepEqual(state.systems, [{ seq: 0, localized: false }])
  assert.equal(state.promptLocalizedInLog, false)

  // Append localized system message at seq 5.
  state = apply(state, {
    type: 'system/message',
    seq: 5,
    surfaceOp: 'append',
    data: { message: { role: 'system', content: [{ type: 'text', text: '你是由 DeepSeek Harness 驱动的 AI 智能体。' }] } },
  })
  assert.deepEqual(state.systems, [
    { seq: 0, localized: false },
    { seq: 5, localized: true },
  ])
  assert.equal(state.promptLocalizedInLog, true)

  // Append empty system message at seq 8: keeps promptLocalizedInLog = true via findLast non-null.
  state = apply(state, {
    type: 'system/message',
    seq: 8,
    surfaceOp: 'append',
    data: { message: { role: 'system', content: [{ type: 'text', text: '   ' }] } },
  })
  assert.deepEqual(state.systems, [
    { seq: 0, localized: false },
    { seq: 5, localized: true },
    { seq: 8, localized: null },
  ])
  assert.equal(state.promptLocalizedInLog, true)

  // Replace touching no entries in systems returns the exact same state reference.
  const untouched = apply(state, {
    type: 'user/message',
    seq: 9,
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 4 },
    data: { message: { role: 'user', content: [{ type: 'text', text: 'compacted' }] } },
  })
  assert.strictEqual(untouched, state)

  // Replace seq 0 in-place with a localized system/message at seq 10 (keeps order before seq 5).
  state = apply(state, {
    type: 'system/message',
    seq: 10,
    surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 },
    data: { message: { role: 'system', content: [{ type: 'text', text: '使用 read 工具查看文本文件' }] } },
  })
  assert.deepEqual(state.systems, [
    { seq: 10, localized: true },
    { seq: 5, localized: true },
    { seq: 8, localized: null },
  ])
  assert.equal(state.promptLocalizedInLog, true)

  // Replace range covering seq 5..8 with a non-system compaction message removes them, leaving seq 10.
  state = apply(state, {
    type: 'user/message',
    seq: 11,
    surfaceOp: { op: 'replace', startSeq: 5, endSeq: 8 },
    data: { message: { role: 'user', content: [{ type: 'text', text: 'summary' }] } },
  })
  assert.deepEqual(state.systems, [{ seq: 10, localized: true }])
  assert.equal(state.promptLocalizedInLog, true)

  // Replace non-existent range with a system/message appends at the end.
  state = apply(state, {
    type: 'system/message',
    seq: 12,
    surfaceOp: { op: 'replace', startSeq: 20, endSeq: 25 },
    data: { message: { role: 'system', content: [{ type: 'text', text: 'English override' }] } },
  })
  assert.deepEqual(state.systems, [
    { seq: 10, localized: true },
    { seq: 12, localized: false },
  ])
  assert.equal(state.promptLocalizedInLog, false)
  assert.equal(wire.view(state).promptLocalizedInLog, false)

  // Compaction covering all remaining system messages clears systems and sets promptLocalizedInLog to null.
  state = apply(state, {
    type: 'user/message',
    seq: 13,
    surfaceOp: { op: 'replace', startSeq: 10, endSeq: 12 },
    data: { message: { role: 'user', content: [{ type: 'text', text: 'full summary' }] } },
  })
  assert.deepEqual(state.systems, [])
  assert.equal(state.promptLocalizedInLog, null)
})

test('assistant/message tracks native continuity, breaks, v2 pi-ai embedded payloads, bytes, and search metrics', () => {
  const { apply, wire } = diagnosticsProjection
  let state = diagnosticsProjection.init()

  const text1 = 'Answer text '.repeat(40)
  const blocks1 = [{ type: 'text', text: text1 }]
  const frames1 = makeSearchFrames(['q1', 'q2'], [{ uri: 'https://example.org/1', title: 'One' }])

  // Step 1: v2 compact embedded inside pi-ai envelope.
  const event1 = makeNativeMessageEvent({
    seq: 1,
    route: routeA,
    model: modelA,
    outcome: 'complete',
    frames: frames1,
    blocks: blocks1,
    embedPiAi: true,
  })
  const expectedBytes1 = Buffer.byteLength(JSON.stringify(event1.data.message.source.replayState.response.dshGeminiNative))
  state = apply(state, event1)
  assert.equal(state.assistantSteps, 1)
  assert.equal(state.nativeSteps, 1)
  assert.equal(state.consecutiveNative, 1)
  assert.equal(state.hasNativePayload, true)
  assert.equal(state.nativeBytes, expectedBytes1)
  assert.equal(state.lastNativeRoute, routeA.identity)
  assert.equal(state.lastNativeModel, modelA)
  assert.equal(state.searchCards, 1)
  assert.equal(state.searchQueries, 2)
  assert.equal(state.searchSources, 1)

  // Step 2: consecutive native step on same route & model (standalone envelope, no search).
  const blocks2 = [{ type: 'text', text: 'Second step' }]
  const frames2 = [[{ index: 0, content: { role: 'model', parts: [{ text: 'Second step' }] }, finishReason: 'STOP' }]]
  const event2 = makeNativeMessageEvent({
    seq: 2,
    route: routeA,
    model: modelA,
    outcome: 'complete',
    frames: frames2,
    blocks: blocks2,
  })
  const expectedBytes2 = Buffer.byteLength(JSON.stringify(event2.data.message.source.replayState.response))
  state = apply(state, event2)
  assert.equal(state.assistantSteps, 2)
  assert.equal(state.nativeSteps, 2)
  assert.equal(state.consecutiveNative, 2)
  assert.equal(state.nativeBytes, expectedBytes1 + expectedBytes2)

  // Step 3: switching model resets consecutiveNative to 1.
  const event3 = makeNativeMessageEvent({
    seq: 3,
    route: routeA,
    model: modelB,
    outcome: 'truncated',
    frames: frames2,
    blocks: blocks2,
  })
  const expectedBytes3 = Buffer.byteLength(JSON.stringify(event3.data.message.source.replayState.response))
  state = apply(state, event3)
  assert.equal(state.assistantSteps, 3)
  assert.equal(state.nativeSteps, 3)
  assert.equal(state.consecutiveNative, 1)
  assert.equal(state.lastNativeModel, modelB)

  // Step 4: switching route resets consecutiveNative to 1 even on same model.
  const event4 = makeNativeMessageEvent({
    seq: 4,
    route: routeB,
    model: modelB,
    outcome: 'complete',
    frames: frames2,
    blocks: blocks2,
  })
  const expectedBytes4 = Buffer.byteLength(JSON.stringify(event4.data.message.source.replayState.response))
  state = apply(state, event4)
  assert.equal(state.assistantSteps, 4)
  assert.equal(state.nativeSteps, 4)
  assert.equal(state.consecutiveNative, 1)
  assert.equal(state.lastNativeRoute, routeB.identity)

  // Step 5: plain non-native assistant/message resets consecutiveNative to 0 and keeps lastNativeModel.
  state = apply(state, {
    type: 'assistant/message',
    seq: 5,
    surfaceOp: 'append',
    data: {
      turn: 2,
      message: { role: 'assistant', content: [{ type: 'text', text: 'From another provider' }], source: { kind: 'model', provider: 'openai', model: 'gpt-5' } },
      stream: [],
    },
  })
  assert.equal(state.assistantSteps, 5)
  assert.equal(state.nativeSteps, 4)
  assert.equal(state.consecutiveNative, 0)
  assert.equal(state.lastNativeModel, modelB)
  assert.equal(state.hasNativePayload, true)

  // Step 6: corrupted native envelope (hasNativeReplay = true, nativeReplayOf = undefined) resets consecutiveNative.
  state = apply(state, makeNativeMessageEvent({
    seq: 6,
    route: routeB,
    model: modelB,
    frames: frames2,
    blocks: blocks2,
  }))
  assert.equal(state.consecutiveNative, 1)
  const corruptedEnvelope = makeReplayState(routeB, modelB, frames2, [], 'complete', prefix, blocks2)
  corruptedEnvelope.response.version = 999
  state = apply(state, {
    type: 'assistant/message',
    seq: 7,
    surfaceOp: 'append',
    data: {
      turn: 3,
      message: { role: 'assistant', content: blocks2, source: { kind: 'model', provider: 'gemini', model: modelB, replayState: corruptedEnvelope } },
      stream: [],
    },
  })
  assert.equal(state.assistantSteps, 7)
  assert.equal(state.nativeSteps, 5)
  assert.equal(state.consecutiveNative, 0)
  assert.equal(state.hasNativePayload, true)

  // Step 7: recovery via stream finish envelope when source.replayState is omitted.
  const framesSearch2 = makeSearchFrames(['q3'], [
    { uri: 'https://example.org/2', title: 'Two' },
    { uri: 'https://example.org/3', title: 'Three' },
  ])
  const event8 = makeNativeMessageEvent({
    seq: 8,
    route: routeB,
    model: modelB,
    outcome: 'complete',
    frames: framesSearch2,
    blocks: blocks1,
    embedPiAi: true,
    omitSourceReplay: true,
  })
  const bytesBefore8 = state.nativeBytes
  state = apply(state, event8)
  assert.equal(state.assistantSteps, 8)
  assert.equal(state.nativeSteps, 6)
  assert.equal(state.consecutiveNative, 1)
  assert.ok(state.nativeBytes > bytesBefore8)
  assert.equal(state.searchCards, 2)
  assert.equal(state.searchQueries, 3)
  assert.equal(state.searchSources, 3)

  // Step 8: continuing chain after recovery increments consecutiveNative to 2.
  state = apply(state, makeNativeMessageEvent({
    seq: 9,
    route: routeB,
    model: modelB,
    frames: frames2,
    blocks: blocks2,
  }))
  assert.equal(state.consecutiveNative, 2)
  assert.equal(expectedBytes1 + expectedBytes2 + expectedBytes3 + expectedBytes4 > 0, true)

  const view = wire.view(state)
  assert.deepEqual(view, {
    assistantSteps: 9,
    nativeSteps: 7,
    consecutiveNative: 2,
    hasNativePayload: true,
    nativeBytes: state.nativeBytes,
    searchCards: 2,
    searchQueries: 3,
    searchSources: 3,
    promptLocalizedInLog: null,
  })
})

test('assistant/attempt sets hasNativePayload without advancing step counters', () => {
  const { apply } = diagnosticsProjection
  const initial = diagnosticsProjection.init()
  const envelope = makeReplayState(routeA, modelA, [[{ index: 0, content: { role: 'model', parts: [{ text: 'partial' }] } }]], [], 'failed', prefix, [])
  const attempt = {
    type: 'assistant/attempt',
    seq: 1,
    data: {
      turn: 1,
      stream: [{ type: 'chunk', time: 1, chunk: { type: 'finish', reason: { kind: 'error' }, replayState: envelope } }],
    },
  }

  const afterFirst = apply(initial, attempt)
  assert.notStrictEqual(afterFirst, initial)
  assert.equal(afterFirst.hasNativePayload, true)
  assert.equal(afterFirst.assistantSteps, 0)
  assert.equal(afterFirst.nativeSteps, 0)
  assert.equal(afterFirst.consecutiveNative, 0)
  assert.equal(afterFirst.nativeBytes, 0)

  // Second native attempt when hasNativePayload is already true returns the same state reference.
  assert.strictEqual(apply(afterFirst, attempt), afterFirst)

  // Non-native corrupted assistant/message also sets hasNativePayload via hasNativeReplay when previously false.
  const badEnvelope = clone(envelope)
  badEnvelope.response.version = 99
  const afterCorruptMsg = apply(initial, {
    type: 'assistant/message',
    seq: 2,
    surfaceOp: 'append',
    data: {
      turn: 1,
      message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'gemini', model: modelA, replayState: badEnvelope } },
      stream: [],
    },
  })
  assert.equal(afterCorruptMsg.assistantSteps, 1)
  assert.equal(afterCorruptMsg.nativeSteps, 0)
  assert.equal(afterCorruptMsg.hasNativePayload, true)
})

test('stateSchema and viewSchema validate valid shapes and reject invalid data', () => {
  const { stateSchema, wire } = diagnosticsProjection
  const validState = {
    ...diagnosticsProjection.init(),
    assistantSteps: 2,
    nativeSteps: 1,
    consecutiveNative: 1,
    hasNativePayload: true,
    nativeBytes: 512,
    lastNativeRoute: 'route-1',
    lastNativeModel: modelA,
    searchCards: 1,
    searchQueries: 2,
    searchSources: 3,
    systems: [{ seq: 1, localized: true }, { seq: 4, localized: null }],
    promptLocalizedInLog: true,
  }
  assert.strictEqual(stateSchema.parse(validState), validState)

  const validView = wire.view(validState)
  assert.strictEqual(wire.viewSchema.parse(validView), validView)

  for (const invalid of [null, undefined, [], 'str', 42]) {
    assert.throws(() => stateSchema.parse(invalid))
    assert.throws(() => wire.viewSchema.parse(invalid))
  }

  // Missing / extra keys rejected.
  const { systems: _dropped, ...missingSystems } = validState
  assert.throws(() => stateSchema.parse(missingSystems))
  assert.throws(() => stateSchema.parse({ ...validState, extra: 1 }))
  assert.throws(() => wire.viewSchema.parse(validState))
  assert.throws(() => wire.viewSchema.parse({ ...validView, lastNativeRoute: null }))
  assert.throws(() => wire.viewSchema.parse({ ...validView, systems: [] }))

  const { assistantSteps: _omit, ...missingViewField } = validView
  assert.throws(() => wire.viewSchema.parse(missingViewField))

  // Invalid field types rejected.
  for (const badPatch of [
    { assistantSteps: -1 },
    { assistantSteps: 1.5 },
    { assistantSteps: NaN },
    { nativeSteps: '1' },
    { consecutiveNative: null },
    { hasNativePayload: 1 },
    { nativeBytes: Infinity },
    { searchCards: -2 },
    { searchQueries: '0' },
    { searchSources: {} },
    { promptLocalizedInLog: 'true' },
  ]) {
    assert.throws(() => stateSchema.parse({ ...validState, ...badPatch }))
    assert.throws(() => wire.viewSchema.parse({ ...validView, ...badPatch }))
  }

  assert.throws(() => stateSchema.parse({ ...validState, lastNativeRoute: 99 }))
  assert.throws(() => stateSchema.parse({ ...validState, lastNativeModel: 123 }))
  assert.throws(() => stateSchema.parse({ ...validState, systems: 'bad' }))
  assert.throws(() => stateSchema.parse({ ...validState, systems: [null] }))
  assert.throws(() => stateSchema.parse({ ...validState, systems: [{ seq: -1, localized: true }] }))
  assert.throws(() => stateSchema.parse({ ...validState, systems: [{ seq: 1, localized: 'yes' }] }))
  assert.throws(() => stateSchema.parse({ ...validState, systems: [{ seq: 1, localized: true, extra: 1 }] }))
})
