import { isObject } from './generate-content.js'

export const xhighPath = '/api/dsh-gemini-enhancement/xhigh'
export const xhighStorageUnit = 'dsh_gemini_enhancement_xhigh'
const xhighStorageTable = 'sessions'
const sessionLimit = 256
const xhighModelPattern = /^(?:models\/)?gemini-4-(?:neon|hydrogen)(?:$|[-.@])/iu

const xhighUnitDescriptor = Object.freeze({
  name: xhighStorageUnit,
  version: 1,
  tables: Object.freeze([xhighStorageTable]),
  hasGlobal: false,
  layout: 'single',
})

function validSessionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

export function supportsXHighModel(model) {
  return typeof model === 'string' && xhighModelPattern.test(model)
}

export function applyXHighThinking(body, enableXHigh) {
  if (enableXHigh !== true) return { body, changed: false }
  const existingConfig = body.generationConfig
  if (existingConfig !== undefined && !isObject(existingConfig)) return { body, changed: false }
  const existingThinking = isObject(existingConfig?.thinkingConfig) ? existingConfig.thinkingConfig : undefined
  if (existingThinking?.includeThoughts === true
    && existingThinking.thinkingLevel === 'XHIGH'
    && !Object.hasOwn(existingThinking, 'thinkingBudget')) {
    return { body, changed: false }
  }
  const { thinkingBudget: _dropped, ...restThinking } = existingThinking ?? {}
  const thinkingConfig = { ...restThinking, includeThoughts: true, thinkingLevel: 'XHIGH' }
  const generationConfig = { ...existingConfig, thinkingConfig }
  return { body: { ...body, generationConfig }, changed: true }
}

export function xhighState(ctx) {
  const enabled = new Set()
  const watchers = new Map()
  const encoder = new TextEncoder()
  const touchedBeforeLoad = new Map()
  let storageLoading = false
  let unit = null
  let storageReady = Promise.resolve()
  let writeChain = Promise.resolve()

  function notify(sessionId, value) {
    for (const sub of watchers.get(sessionId) ?? []) sub.update(value)
  }

  function enqueuePersist(op) {
    writeChain = writeChain.then(async () => {
      if (!unit) return
      try {
        await op(unit)
      } catch (error) {
        ctx.logger?.warn?.(`Gemini enhancement: failed to persist XHigh state: ${error?.message ?? error}`)
      }
    })
    return writeChain
  }

  function persistChange(sessionId, value, evicted = []) {
    if (unit) {
      enqueuePersist(async target => {
        if (value) await target.putRecord(xhighStorageTable, sessionId, { enabled: true, updatedAt: Date.now() })
        else await target.deleteRecord(xhighStorageTable, sessionId)
        for (const oldId of evicted) await target.deleteRecord(xhighStorageTable, oldId)
      })
    } else if (storageLoading) {
      touchedBeforeLoad.set(sessionId, value)
      for (const oldId of evicted) touchedBeforeLoad.set(oldId, false)
    }
  }

  function isEnabled(sessionId) {
    return typeof sessionId === 'string' && enabled.has(sessionId)
  }

  function setEnabled(sessionId, value) {
    if (!validSessionId(sessionId)) return false
    const next = value === true
    const prev = enabled.has(sessionId)
    if (prev === next) {
      if (next) {
        enabled.delete(sessionId)
        enabled.add(sessionId)
      }
      return next
    }
    const evicted = []
    if (next) {
      enabled.add(sessionId)
      while (enabled.size > sessionLimit) {
        const oldest = enabled.values().next().value
        enabled.delete(oldest)
        evicted.push(oldest)
        notify(oldest, false)
      }
    } else {
      enabled.delete(sessionId)
    }
    persistChange(sessionId, next, evicted)
    notify(sessionId, next)
    return next
  }

  function closeWatchers() {
    for (const group of [...watchers.values()]) {
      for (const sub of [...group]) sub.close()
    }
    watchers.clear()
  }

  function watch(request) {
    const sessionId = new URL(request.url).searchParams.get('sessionId')
    if (!validSessionId(sessionId)) return new Response(null, { status: 400 })
    if (request.signal.aborted) return new Response(null, { status: 204 })
    let pending = enabled.has(sessionId)
    let sent
    let controller
    let closed = false
    const group = watchers.get(sessionId) ?? new Set()
    const cleanup = () => {
      group.delete(sub)
      if (group.size === 0) watchers.delete(sessionId)
      request.signal.removeEventListener('abort', close)
    }
    function close() {
      if (closed) return
      closed = true
      cleanup()
      try { controller.close() } catch { /* Stream may already be closed or canceled. */ }
    }
    function flush() {
      if (closed || controller.desiredSize <= 0 || sent === pending) return
      sent = pending
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ enabled: sent })}\n\n`))
    }
    const sub = { close, update(next) { pending = next; flush() } }
    return new Response(new ReadableStream({
      start(stream) {
        controller = stream
        watchers.set(sessionId, group)
        group.add(sub)
        request.signal.addEventListener('abort', close, { once: true })
        flush()
      },
      pull: flush,
      cancel() {
        closed = true
        cleanup()
      },
    }), { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } })
  }

  async function update(request) {
    let payload
    try { payload = await request.json() } catch { return new Response(null, { status: 400 }) }
    if (!isObject(payload) || !validSessionId(payload.sessionId) || typeof payload.enabled !== 'boolean') {
      return new Response(null, { status: 400 })
    }
    await storageReady
    const next = setEnabled(payload.sessionId, payload.enabled)
    await writeChain
    return new Response(JSON.stringify({ enabled: next }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    })
  }

  function handle(request) {
    if (request.method === 'GET') return watch(request)
    if (request.method === 'POST') return update(request)
    return new Response(null, { status: 405 })
  }

  ctx.on('session/event', (session, event) => {
    if (event?.type === 'model/selection' && session?.id && enabled.has(session.id)) {
      setEnabled(session.id, false)
    }
  })

  ctx.on('workspace/session-archived', request => {
    const sessionId = request?.sessionId
    if (validSessionId(sessionId) && enabled.has(sessionId)) {
      setEnabled(sessionId, false)
    }
  })

  ctx.inject?.(['storage', 'storage.backend.json'], child => {
    child.effect(() => {
      let closed = false
      let localUnit = null
      storageLoading = true
      const backend = child.storage?.backend?.get?.('json') ?? child.get?.('storage.backend.json')
      const openTask = (async () => {
        if (!backend?.kv?.open) return
        let opened
        try {
          opened = await backend.kv.open(xhighUnitDescriptor)
        } catch (error) {
          ctx.logger?.warn?.(`Gemini enhancement: failed to open XHigh storage: ${error?.message ?? error}`)
          return
        }
        if (closed) {
          await opened.close().catch(() => {})
          return
        }
        localUnit = opened
        let snapshot
        try {
          snapshot = await opened.loadAll()
        } catch (error) {
          ctx.logger?.warn?.(`Gemini enhancement: failed to load XHigh storage: ${error?.message ?? error}`)
          return
        }
        if (closed) return
        const stored = isObject(snapshot?.tables?.[xhighStorageTable]) ? snapshot.tables[xhighStorageTable] : {}
        const restored = Object.entries(stored)
          .filter(([id, rec]) => validSessionId(id) && rec?.enabled === true)
          .sort((left, right) => (Number(left[1]?.updatedAt) || 0) - (Number(right[1]?.updatedAt) || 0))
        unit = opened
        const inMemory = [...enabled]
        enabled.clear()
        const hydrated = []
        for (const [id] of restored) {
          if (touchedBeforeLoad.has(id)) continue
          enabled.add(id)
          hydrated.push(id)
        }
        for (const id of inMemory) {
          enabled.delete(id)
          enabled.add(id)
        }
        const evicted = []
        while (enabled.size > sessionLimit) {
          const oldest = enabled.values().next().value
          enabled.delete(oldest)
          evicted.push(oldest)
        }
        const evictedSet = new Set(evicted)
        for (const id of hydrated) {
          if (!evictedSet.has(id)) notify(id, true)
        }
        const flushOps = new Map(touchedBeforeLoad)
        touchedBeforeLoad.clear()
        for (const id of evicted) {
          if (!flushOps.has(id)) flushOps.set(id, false)
        }
        if (flushOps.size > 0) {
          enqueuePersist(async target => {
            for (const [id, value] of flushOps) {
              if (value) await target.putRecord(xhighStorageTable, id, { enabled: true, updatedAt: Date.now() })
              else await target.deleteRecord(xhighStorageTable, id)
            }
          })
        }
      })().finally(() => {
        storageLoading = false
        if (!unit) touchedBeforeLoad.clear()
      })
      storageReady = openTask
      return async () => {
        closed = true
        await openTask.catch(() => {})
        await writeChain
        if (unit === localUnit) unit = null
        if (localUnit) await localUnit.close().catch(() => {})
      }
    })
  })

  ctx.inject?.(['connection'], child => {
    const dispose = child.connection.fetch.register({
      path: xhighPath,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: handle,
    })
    child.effect?.(() => () => {
      dispose?.()
      closeWatchers()
    })
  })

  ctx.effect(() => () => {
    closeWatchers()
    enabled.clear()
    touchedBeforeLoad.clear()
  })

  return { isEnabled, setEnabled, ready: () => storageReady.then(() => writeChain) }
}
