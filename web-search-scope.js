const DSH_WEB_SEARCH = 'web_search'

function resolveAgentProvider(agent, providerOverride) {
  if (typeof providerOverride === 'string' && providerOverride.length > 0) return providerOverride
  return agent?.model?.current?.()?.provider ?? agent?.options?.provider
}

export function webSearchScope(ctx, child, config, routeConfigOf) {
  const restricted = new Map()
  let syncing = false
  let active = true

  function disposeRestriction(agent) {
    const dispose = restricted.get(agent)
    if (!dispose) return
    restricted.delete(agent)
    try {
      dispose()
    } catch {}
  }

  function syncAgent(agent, providerOverride) {
    if (!active || !agent) return
    const provider = resolveAgentProvider(agent, providerOverride)
    const shouldRestrict = routeConfigOf(config.routes.get(), provider).googleSearch === true
    if (shouldRestrict) {
      if (restricted.has(agent)) return
      if (!child.tools.get(DSH_WEB_SEARCH, agent)) return
      const restrict = agent.ctx?.tools?.restrict
      if (typeof restrict !== 'function') return
      try {
        const dispose = restrict.call(agent.ctx.tools, { deny: [DSH_WEB_SEARCH] })
        restricted.set(agent, dispose)
      } catch {}
      return
    }
    disposeRestriction(agent)
  }

  function syncAll() {
    if (!active || syncing) return
    syncing = true
    try {
      for (const agent of child.agents.list()) {
        syncAgent(agent)
      }
    } finally {
      syncing = false
    }
  }

  syncAll()

  child.on('agent/created', ({ agent }) => {
    if (syncing) return
    syncing = true
    try {
      syncAgent(agent)
    } finally {
      syncing = false
    }
  })

  child.on('agent/disposed', ({ agent }) => {
    if (syncing) {
      disposeRestriction(agent)
      return
    }
    syncing = true
    try {
      disposeRestriction(agent)
    } finally {
      syncing = false
    }
  })

  child.on('session/event', (session, event) => {
    if (event?.type !== 'model/selection') return
    const agent = session?.agent
      ?? child.agents.get?.(session?.id)
      ?? child.agents.list().find(a => a.session === session || a.id === session?.id)
    if (!agent || syncing) return
    syncing = true
    try {
      syncAgent(agent, event.data?.provider)
    } finally {
      syncing = false
    }
  })

  child.on('tools/change', () => {
    if (!syncing) syncAll()
  })

  // Loader emits `loader/volatile-update` filtered to the owning plugin fiber (`ctx.fiber`),
  // not the child fiber created by `ctx.inject`.
  const offVolatile = ctx.on('loader/volatile-update', () => {
    syncAll()
  })

  child.on('tools/pre-execute', (exec, next) => {
    if (active && exec?.name === DSH_WEB_SEARCH && exec.agent) {
      const provider = resolveAgentProvider(exec.agent)
      if (routeConfigOf(config.routes.get(), provider).googleSearch === true) {
        return Promise.resolve({
          kind: 'deny',
          reason: 'web_search is disabled when Google Search is enabled on this Gemini route.',
        })
      }
    }
    return next()
  })

  child.effect(() => () => {
    active = false
    offVolatile?.()
    syncing = true
    try {
      for (const dispose of restricted.values()) {
        try {
          dispose()
        } catch {}
      }
      restricted.clear()
    } finally {
      syncing = false
    }
  })
}
