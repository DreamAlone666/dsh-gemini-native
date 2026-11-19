import { collectGoogleSearchEvidence } from './google-search-sse.js'
import { nativeReplayOf, selectedCandidate } from './generate-content.js'

export const nativeSearchProjectionKey = 'geminiNativeSearchActivity'

function cardsSchema(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected Gemini turn summaries')
  for (const [turn, cards] of Object.entries(value)) {
    if (!/^[1-9][0-9]*$/u.test(turn) || !Array.isArray(cards) || !cards.every(card =>
      card && typeof card === 'object' && ['completed', 'incomplete'].includes(card.status)
      && Array.isArray(card.queries) && card.queries.every(query => typeof query === 'string')
      && Array.isArray(card.sources) && card.sources.every(source => typeof source?.url === 'string' && typeof source.title === 'string')
      && Object.keys(card).every(key => ['status', 'queries', 'sources'].includes(key))
      && card.sources.every(source => Object.keys(source).every(key => ['url', 'title'].includes(key))))) {
      throw new TypeError('Invalid Gemini turn summary')
    }
  }
  return value
}

const schema = { parse: cardsSchema }

export const nativeSearchProjection = {
  key: nativeSearchProjectionKey,
  stateVersion: 2,
  stateSchema: schema,
  init: () => ({}),
  apply(state, event) {
    const native = nativeReplayOf(event)
    if (!native) return state
    const { turn } = event.data
    if (!Number.isSafeInteger(turn) || turn < 1) return state
    let card
    const observe = collectGoogleSearchEvidence(value => { card = value })
    for (const frame of native.frames) observe({ candidates: [selectedCandidate(frame)] })
    if (!card) return state
    if (card.status === 'running') card.status = 'incomplete'
    // Bound each card and each turn, not the number of historical turns.
    return { ...state, [turn]: [...(state[turn] ?? []), card].slice(-12) }
  },
  wire: { summary: false, viewSchema: schema, view: state => state },
}
