const maxFrameBytes = 64 * 1024
const maxQueries = 12
const maxSources = 8
const maxPendingCalls = 32
const maxUrlLength = 2048

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/gu, ' ').replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '').replace(/ +/gu, ' ').trim()
  return Array.from(text).slice(0, maxLength).join('').trimEnd()
}

function cleanUrl(value) {
  if (typeof value !== 'string' || value.length > maxUrlLength || /[\p{Cc}\p{Cf}]/u.test(value)) return
  const raw = value.trim()
  const authority = /^https?:\/\/([^/?#\\]+)/iu.exec(raw)?.[1]
  if (!authority || authority.includes('@')) return
  try {
    const url = new URL(raw)
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
      && url.href.length <= maxUrlLength) return url
  } catch { /* Not a usable link. */ }
}

function isGoogleSearch(tool) {
  return tool?.toolType === 'GOOGLE_SEARCH_WEB' || tool?.toolType === 'GOOGLE_SEARCH'
}

function collectEvidence(report) {
  const queries = new Set()
  const sources = new Map()
  const pending = new Set()
  let anonymousPending = false
  let overflowPending = false
  let status
  let changed = false

  function toolId(tool) {
    return typeof tool.id === 'string' && tool.id.length > 0 && tool.id.length <= 128 ? tool.id : undefined
  }

  function trackCall(tool) {
    const id = toolId(tool)
    if (id === undefined) anonymousPending = true
    else if (pending.size < maxPendingCalls) pending.add(id)
    // Do not infer completion for calls we could not retain within the cap.
    else if (!pending.has(id)) overflowPending = true
    status = 'running'
  }

  function trackResult(tool) {
    const id = toolId(tool)
    if (id === undefined) {
      if (anonymousPending) anonymousPending = false
      else if (pending.size === 1) pending.clear()
    } else if (!pending.delete(id) && anonymousPending) {
      anonymousPending = false
    }
    status = pending.size || anonymousPending || overflowPending ? 'running' : 'completed'
  }

  function query(value) {
    const text = cleanText(value, 240)
    if (!text) return false
    if (queries.size < maxQueries && !queries.has(text)) {
      queries.add(text)
      changed = true
    }
    return true
  }

  function source(value) {
    const url = cleanUrl(value?.uri ?? value?.url)
    if (!url) return false
    const title = cleanText(value?.title, 200)
    if (sources.has(url.href)) {
      if (title && !sources.get(url.href).title) {
        sources.get(url.href).title = title
        changed = true
      }
    } else if (sources.size < maxSources) {
      sources.set(url.href, { title, fallbackTitle: url.hostname })
      changed = true
    }
    return true
  }

  function toolQueries(payload) {
    query(payload?.query)
    query(payload?.searchQuery)
    for (const list of [payload?.queries, payload?.searchQueries, payload?.webSearchQueries]) {
      if (Array.isArray(list)) for (const value of list) query(value)
    }
  }

  function toolSources(payload) {
    for (const list of [payload?.sources, payload?.results, payload?.searchResults]) {
      if (Array.isArray(list)) for (const value of list) source(value?.web ?? value)
    }
  }

  return function observe(payload) {
    const candidate = Array.isArray(payload?.candidates) ? payload.candidates[0] : undefined
    if (!candidate) return
    const before = status
    changed = false
    const parts = candidate.content?.parts
    if (Array.isArray(parts)) {
      for (const part of parts) {
        const { toolCall, toolResponse } = part ?? {}
        if (isGoogleSearch(toolCall)) {
          trackCall(toolCall)
          toolQueries(toolCall.args)
        }
        if (isGoogleSearch(toolResponse)) {
          trackResult(toolResponse)
          toolQueries(toolResponse.response)
          toolSources(toolResponse.response)
        }
      }
    }
    const { webSearchQueries, groundingChunks } = candidate.groundingMetadata ?? {}
    let grounding = false
    if (Array.isArray(webSearchQueries)) {
      for (const value of webSearchQueries) if (query(value)) grounding = true
    }
    if (Array.isArray(groundingChunks)) {
      for (const chunk of groundingChunks) if (source(chunk?.web)) grounding = true
    }
    // Grounding is fallback evidence of completed work, not a tool response
    // for a call already seen. Feed later grounding into the same snapshot.
    if (grounding && status === undefined) status = 'completed'
    if (status && (status !== before || changed)) {
      try {
        report({
          status,
          queries: [...queries],
          sources: Array.from(sources, ([url, { title, fallbackTitle }]) => ({ url, title: title || fallbackTitle })),
        })
      } catch { /* Reporting must not affect the provider stream. */ }
    }
  }
}

function sseObserver(observe) {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  const bom = [0xef, 0xbb, 0xbf]
  let bomMatched = 0
  let atStart = true
  let frame
  let used = 0
  let oversized = false
  let lineHasBytes = false
  let afterCR = false

  function append(byte) {
    if (used === maxFrameBytes) oversized = true
    if (!oversized) {
      frame ??= new Uint8Array(maxFrameBytes)
      frame[used++] = byte
    }
  }

  function endLine() {
    if (lineHasBytes) {
      append(0x0a)
      lineHasBytes = false
      return
    }
    if (!oversized && used) {
      try {
        const data = []
        for (const line of decoder.decode(frame.subarray(0, used)).split('\n')) {
          if (line === 'data') data.push('')
          else if (line.startsWith('data:')) data.push(line.slice(line[5] === ' ' ? 6 : 5))
        }
        const json = data.join('\n')
        if (json && json !== '[DONE]') observe(JSON.parse(json))
      } catch { /* A malformed event is not a provider stream error. */ }
    }
    used = 0
    oversized = false
  }

  return function inspect(chunk) {
    if (!(chunk instanceof Uint8Array)) return
    for (const byte of chunk) {
      if (atStart) {
        if (byte === bom[bomMatched]) {
          if (++bomMatched === bom.length) atStart = false
          continue
        }
        atStart = false
        if (bomMatched) {
          lineHasBytes = true
          for (let i = 0; i < bomMatched; i++) append(bom[i])
        }
      }
      if (afterCR) {
        afterCR = false
        if (byte === 0x0a) continue
      }
      if (byte === 0x0a || byte === 0x0d) {
        endLine()
        afterCR = byte === 0x0d
      } else {
        lineHasBytes = true
        append(byte)
      }
    }
  }
}

export function observeGoogleSearchResponse(response, report) {
  if (!(response instanceof Response) || !response.ok || !response.body || response.bodyUsed || response.body.locked
    || response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'text/event-stream') return response

  const inspect = sseObserver(collectEvidence(report))
  const reader = response.body.getReader()
  let cancelled = false
  // One upstream read per downstream demand; no separately buffered branch.
  const body = new ReadableStream({
    async pull(controller) {
      let item
      try {
        item = await reader.read()
      } catch (error) {
        if (!cancelled) {
          reader.releaseLock()
          controller.error(error)
        }
        return
      }
      if (cancelled) return
      if (item.done) {
        reader.releaseLock()
        controller.close()
        return
      }
      try { inspect(item.value) } catch { /* Observation is best-effort. */ }
      if (!cancelled) controller.enqueue(item.value)
    },
    async cancel(reason) {
      cancelled = true
      try { await reader.cancel(reason) } finally { reader.releaseLock() }
    },
  }, { highWaterMark: 0 })
  return new Response(body, { headers: response.headers, status: response.status, statusText: response.statusText })
}
