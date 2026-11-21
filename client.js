window.__ModuleLoader__.load({
  id: 'dsh-gemini-enhancement',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const namespace = 'dshGeminiEnhancement'
    const pluginId = 'dsh-gemini-enhancement'

    const en = {
      brand: 'Gemini Enhancement',
      localizePrompt: 'Localize system prompt',
      localizePromptTitle: 'Replace known built-in DSH English system prompts with Simplified Chinese on this provider.',
      nativeHistory: 'Native history replay',
      nativeHistoryTitle: 'Preserve and replay Gemini native parts (thought signatures, server-side tool parts, and opaque fields). Excludes sessions containing native data from official session log uploads.',
      googleSearch: 'Google Search',
      googleSearchTitle: 'Replace built-in web_search with native Google Search while keeping all other local tools.',
      searchWithoutHistoryWarn: 'Without native history replay, follow-up turns after mixing Google Search with local tools may fail.',
      nonGeminiRoute: 'This provider is no longer a Gemini API route. You can clear its saved Gemini enhancements.',
      clear: 'Clear',
      clearing: 'Clearing…',
      saving: 'Saving…',
      readOnly: 'Read-only',
      saveFailed: 'Could not save Gemini enhancement settings. Please try again.',
      saveConflict: 'Settings changed elsewhere. Please retry.',
      pageIntro: 'Configure per-provider enhancements (system prompt localization, native history replay, and Google Search) directly inside each Gemini API provider card under Settings → Models.',
      showStatusNotice: 'Show active Gemini enhancements below the composer',
      showStatusNoticeHelp: 'Displays active enhancements when an enhanced Gemini provider is selected, and confirms once a request uses the localized prompt. Turning this off does not disable any enhancement.',
      activeRoutesHeading: 'Configured Gemini routes',
      activeRoutesEmpty: 'No Gemini API providers have enhancements enabled yet. Open Settings → Models and toggle enhancements on any Gemini API provider card.',
      routeStaleTag: 'Not currently a Gemini API provider',
      loading: 'Loading settings…',
      unavailable: 'Configuration is unavailable. Check that the bundle and its plugin row are enabled, then reopen this page.',
      statusMatched: 'Prompt localization matched',
      statusLocalized: 'Prompt localized',
      statusNativeHistory: 'Native history',
      statusGoogleSearch: 'Google Search',
      source: 'Source: Gemini Enhancement plugin',
      activityTitle: 'Google Search (Gemini)',
      activityLive: 'Searching Google…',
      activityCompleted: 'Search reported by Gemini',
      activityIncomplete: 'Search completion not confirmed',
      activityPartial: 'Some searches were not confirmed complete',
      activityQueries: 'Search queries',
      activitySourceCount: 'Sources',
      activitySources: 'Sources returned by Google (links open in a new tab)',
      xhighLabel: 'XHigh',
      xhighOffTitle: 'Override reasoning level to XHigh for this session (Neon / Hydrogen) without changing the native effort setting',
      xhighOnTitle: 'XHigh is active for this session (overriding the selected effort); click to restore',
    }

    const zh = {
      brand: 'Gemini 增强',
      localizePrompt: '系统提示词汉化',
      localizePromptTitle: '在此供应商上将已知的 DSH 内置英文系统提示词替换为简体中文（防 Gemini 4 系列降智）。',
      nativeHistory: '原生历史回放',
      nativeHistoryTitle: '保留并回放 Gemini 原生 parts（思维签名、服务端工具记录与未知字段）；含原生数据的会话将跳过官方会话日志上传。',
      googleSearch: 'Google 原生搜索',
      googleSearchTitle: '保留其余本地工具的同时，用 Google 原生搜索替换内置 web_search。',
      searchWithoutHistoryWarn: '未开启原生历史回放时，混用 Google 原生搜索与本地工具的续轮可能失败。',
      nonGeminiRoute: '当前已非 Gemini API 供应商，可清除此前保存的 Gemini 增强配置。',
      clear: '清除',
      clearing: '清除中…',
      saving: '保存中…',
      readOnly: '只读',
      saveFailed: '未能保存 Gemini 增强设置，请重试。',
      saveConflict: '设置已在别处更改，请重试。',
      pageIntro: '各 Gemini API 供应商的「系统提示词汉化」「原生历史回放」与「Google 原生搜索」均已整合到「设置 → 模型」中对应供应商卡片内就地配置。',
      showStatusNotice: '在输入框下方显示 Gemini 增强状态',
      showStatusNoticeHelp: '切到已开启增强的 Gemini 供应商时，在输入框下方显示当前生效项；请求确认使用汉化后更新为已汉化。关闭此项不影响增强本身。',
      activeRoutesHeading: '已配置的 Gemini 供应商',
      activeRoutesEmpty: '尚未对任何 Gemini API 供应商启用增强。请前往「设置 → 模型」，在对应 Gemini 供应商卡片内勾选需要的增强项。',
      routeStaleTag: '当前非 Gemini API 供应商',
      loading: '正在加载设置…',
      unavailable: '配置不可用。请确认组合包和插件行均已启用，然后重新打开此页。',
      statusMatched: '提示词汉化已匹配',
      statusLocalized: '提示词已汉化',
      statusNativeHistory: '原生历史',
      statusGoogleSearch: 'Google 搜索',
      source: '来源：Gemini 增强插件',
      activityTitle: 'Google 搜索（Gemini）',
      activityLive: 'Google 搜索中…',
      activityCompleted: 'Gemini 已报告搜索',
      activityIncomplete: '未确认搜索完成',
      activityPartial: '部分搜索未确认完成',
      activityQueries: '搜索词',
      activitySourceCount: '来源',
      activitySources: 'Google 返回的来源（在新标签页打开）',
      xhighLabel: 'XHigh',
      xhighOffTitle: '在当前会话将推理等级覆盖为 XHigh（Neon / Hydrogen），不改变原生档位',
      xhighOnTitle: '当前会话已开启 XHigh（覆盖当前所选档位），点击恢复原档位',
    }

    const secondary = { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 13, lineHeight: 1.5 }
    const caption = { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: '18px' }
    const warnCaption = { margin: 0, color: 'var(--dsw-alias-state-warn-label)', fontSize: 12, lineHeight: '18px' }
    const errorCaption = { margin: 0, color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, lineHeight: '18px' }
    const secondaryButton = {
      border: '0.5px solid var(--dsw-alias-border-l3)', borderRadius: 'var(--dsw-radius-md, 6px)',
      padding: '3px 10px', font: 'inherit', fontSize: 12, lineHeight: '18px', cursor: 'pointer',
      background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
    }
    const cardSection = {
      borderTop: '0.5px solid var(--dsw-alias-border-l3)',
      paddingTop: 10,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }
    const cardHeader = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
    }
    const cardTitle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      fontSize: 12,
      lineHeight: '18px',
      fontWeight: 500,
      color: 'var(--dsw-alias-label-secondary)',
    }
    const toggleRow = {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: '8px 16px',
    }
    const checkboxLabel = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 13,
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-primary)',
      cursor: 'pointer',
      userSelect: 'none',
    }
    const badgeStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      padding: '1px 7px',
      borderRadius: 'var(--dsw-radius-xs, 4px)',
      border: '0.5px solid var(--dsw-alias-border-l3)',
      fontSize: 11,
      lineHeight: '16px',
      color: 'var(--dsw-alias-label-secondary)',
    }
    const xhighButtonBase = {
      boxSizing: 'border-box',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      height: 28,
      padding: '0 8px',
      borderRadius: 'var(--dsw-radius-sm, 8px)',
      font: 'inherit',
      fontSize: 12,
      lineHeight: '18px',
      whiteSpace: 'nowrap',
      flexShrink: 0,
      userSelect: 'none',
      transition: 'background-color 120ms ease, border-color 120ms ease, color 120ms ease, opacity 120ms ease',
    }

    function supportsXHighModel(model) {
      return typeof model === 'string' && /^(?:models\/)?gemini-4-(?:neon|hydrogen)(?:$|[-.@])/iu.test(model)
    }

    function routeEntryOf(routes, providerId) {
      const entry = typeof providerId === 'string' && providerId.length > 0 && routes && Object.hasOwn(routes, providerId)
        ? routes[providerId]
        : undefined
      return {
        localizePrompt: entry?.localizePrompt === true,
        nativeHistory: entry?.nativeHistory === true,
        googleSearch: entry?.googleSearch === true,
      }
    }

    function hasAnyEnhancement(entry) {
      return entry.localizePrompt || entry.nativeHistory || entry.googleSearch
    }

    function isGeminiProfile(providerId, profile) {
      if (typeof providerId !== 'string' || !providerId) return false
      if (profile === undefined) return providerId === 'google'
      if (!profile || typeof profile !== 'object') return false
      if (profile.api === 'google-generative-ai') {
        return typeof profile.baseURL === 'string' && /^https?:\/\//iu.test(profile.baseURL)
          && Array.isArray(profile.models) && profile.models.length > 0
      }
      return providerId === 'google' && profile.api === undefined
    }

    // Same outline as the bundle icon, cropped for inline marks.
    function GeminiMark({ label, size = 14 }) {
      return h('svg', {
        width: size, height: size, viewBox: '6 6 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 2.5, strokeLinejoin: 'round',
        role: label ? 'img' : undefined,
        'aria-label': label,
        'aria-hidden': label ? undefined : 'true',
        focusable: 'false',
        style: { flexShrink: 0 },
      }, label ? h('title', null, label) : null, h('path', {
        d: 'M18 8.5C19.4 13.4 22.6 16.6 27.5 18C22.6 19.4 19.4 22.6 18 27.5C16.6 22.6 13.4 19.4 8.5 18C13.4 16.6 16.6 13.4 18 8.5Z',
      }))
    }

    function useFormMutator(form) {
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const active = React.useRef(true)
      const busyRef = React.useRef(false)
      React.useEffect(() => {
        active.current = true
        return () => { active.current = false }
      }, [])

      const run = React.useCallback(async (ops) => {
        if (busyRef.current) return false
        const current = form.getSnapshot ? form.getSnapshot() : form.state
        if (!current || current.status !== 'ready' || current.writable !== true || typeof current.revision !== 'number') return false
        busyRef.current = true
        setBusy(true)
        setError(null)
        try {
          const ok = await form.mutate(ops, current.revision)
          if (!active.current) return ok
          if (!ok) setError('saveConflict')
          return ok
        } catch {
          if (active.current) setError('saveFailed')
          return false
        } finally {
          busyRef.current = false
          if (active.current) setBusy(false)
        }
      }, [form])

      return { busy, error, run }
    }

    function ProviderCardEnhancements({ provider, configured, t, configForm, subscribeConfig, getConfig, subscribeModels, getModels }) {
      const configSnap = React.useSyncExternalStore(subscribeConfig, getConfig)
      const modelsSnap = React.useSyncExternalStore(subscribeModels, getModels)
      const { busy, error, run } = useFormMutator(configForm)

      const providerId = provider?.provider
      if (!providerId || configSnap.status !== 'ready') return null

      const routes = configSnap.value?.routes
      const current = routeEntryOf(routes, providerId)
      const hasSaved = hasAnyEnhancement(current)
      const profile = modelsSnap.status === 'ready' ? modelsSnap.value?.providers?.[providerId] : undefined
      const eligible = modelsSnap.status === 'ready'
        ? isGeminiProfile(providerId, profile)
        : (providerId === 'google' || hasSaved)

      if (!eligible && !hasSaved) return null
      if (!configured && !hasSaved) return null

      const writable = configSnap.writable === true
      const disabled = !writable || busy

      function updateRoute(next) {
        const ops = hasAnyEnhancement(next)
          ? [{ op: 'set', path: ['routes', providerId], value: next }]
          : [{ op: 'unset', path: ['routes', providerId] }]
        run(ops)
      }

      if (!eligible && hasSaved) {
        return h('div', { style: cardSection },
          h('div', { style: cardHeader },
            h('span', { style: cardTitle }, h(GeminiMark, { label: t('brand'), size: 13 }), t('brand')),
            h('button', {
              type: 'button',
              disabled,
              style: { ...secondaryButton, opacity: disabled ? 0.6 : 1, cursor: disabled ? 'default' : 'pointer' },
              onClick: () => run([{ op: 'unset', path: ['routes', providerId] }]),
            }, t(busy ? 'clearing' : 'clear')),
          ),
          h('p', { style: caption }, t('nonGeminiRoute')),
          error ? h('p', { role: 'alert', style: errorCaption }, t(error)) : null,
        )
      }

      const items = [
        ['localizePrompt', t('localizePrompt'), t('localizePromptTitle')],
        ['nativeHistory', t('nativeHistory'), t('nativeHistoryTitle')],
        ['googleSearch', t('googleSearch'), t('googleSearchTitle')],
      ]

      return h('div', { style: cardSection },
        h('div', { style: cardHeader },
          h('span', { style: cardTitle }, h(GeminiMark, { label: t('brand'), size: 13 }), t('brand')),
          busy
            ? h('span', { role: 'status', style: caption }, t('saving'))
            : !writable ? h('span', { style: caption }, t('readOnly')) : null,
        ),
        h('div', { style: toggleRow }, items.map(([field, label, title]) =>
          h('label', {
            key: field,
            title,
            style: { ...checkboxLabel, opacity: disabled ? 0.65 : 1, cursor: disabled ? 'default' : 'pointer' },
          },
          h('input', {
            type: 'checkbox',
            checked: current[field],
            disabled,
            onChange: event => {
              const checked = event.target.checked
              const next = { ...current, [field]: checked }
              // Enabling Google Search alongside local tools relies on native history for reliable follow-up turns.
              if (field === 'googleSearch' && checked && !next.nativeHistory) next.nativeHistory = true
              updateRoute(next)
            },
          }),
          h('span', null, label)))),
        current.googleSearch && !current.nativeHistory
          ? h('p', { role: 'status', style: warnCaption }, t('searchWithoutHistoryWarn'))
          : null,
        error ? h('p', { role: 'alert', style: errorCaption }, t(error)) : null,
      )
    }

    function PluginSettingsPage({ form, t, subscribeModels, getModels }) {
      const modelsSnap = React.useSyncExternalStore(subscribeModels, getModels)
      const { busy, error, run } = useFormMutator(form)
      const state = form?.state

      if (!state || state.status === 'loading') {
        return h('p', { role: 'status', style: secondary }, t('loading'))
      }
      if (state.status !== 'ready' || typeof state.revision !== 'number') {
        return h('p', { role: 'status', style: secondary }, t('unavailable'))
      }

      const writable = state.writable === true
      const disabled = !writable || busy
      const showStatusNotice = state.value?.showStatusNotice === true
      const routes = state.value?.routes && typeof state.value.routes === 'object' ? state.value.routes : {}
      const activeEntries = Object.entries(routes)
        .map(([providerId, raw]) => [providerId, routeEntryOf({ [providerId]: raw }, providerId)])
        .filter(([, entry]) => hasAnyEnhancement(entry))
      const providers = modelsSnap.status === 'ready' ? (modelsSnap.value?.providers ?? {}) : null

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 680 } },
        h('div', {
          style: {
            border: '0.5px solid var(--dsw-alias-border-l3)',
            borderRadius: 'var(--dsw-radius-xl, 12px)',
            padding: '12px 14px',
            background: 'var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-base))',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          },
        },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontWeight: 500, fontSize: 14 } },
          h(GeminiMark, { label: t('brand'), size: 15 }),
          h('span', null, t('activeRoutesHeading'))),
        h('p', { style: secondary }, t('pageIntro')),
        activeEntries.length === 0
          ? h('p', { style: caption }, t('activeRoutesEmpty'))
          : h('ul', { style: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 } },
            activeEntries.map(([providerId, entry]) => {
              const profile = providers?.[providerId]
              const displayName = profile?.displayName && profile.displayName !== providerId
                ? `${profile.displayName} (${providerId})`
                : providerId
              const stale = providers !== null && !isGeminiProfile(providerId, profile)
              const tags = [
                entry.localizePrompt && t('localizePrompt'),
                entry.nativeHistory && t('nativeHistory'),
                entry.googleSearch && t('googleSearch'),
              ].filter(Boolean)
              return h('li', {
                key: providerId,
                style: {
                  borderTop: '0.5px solid var(--dsw-alias-border-l3)',
                  paddingTop: 8,
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                },
              },
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
                h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 } },
                  h('span', { style: { fontSize: 13, fontWeight: 500, overflowWrap: 'anywhere' } }, displayName),
                  stale ? h('span', { style: { ...badgeStyle, color: 'var(--dsw-alias-state-warn-label)' } }, t('routeStaleTag')) : null),
                h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                  tags.map(tag => h('span', { key: tag, style: badgeStyle }, tag)))),
              stale ? h('button', {
                type: 'button',
                disabled,
                style: { ...secondaryButton, opacity: disabled ? 0.6 : 1, cursor: disabled ? 'default' : 'pointer' },
                onClick: () => run([{ op: 'unset', path: ['routes', providerId] }]),
              }, t(busy ? 'clearing' : 'clear')) : null)
            }))),

        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          h('label', { style: { ...checkboxLabel, opacity: disabled ? 0.65 : 1, cursor: disabled ? 'default' : 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: showStatusNotice,
              disabled,
              onChange: event => run([{ op: 'set', path: ['showStatusNotice'], value: event.target.checked }]),
            }),
            h('span', { style: { fontWeight: 500 } }, t('showStatusNotice'))),
          h('p', { style: secondary }, t('showStatusNoticeHelp')),
          busy ? h('p', { role: 'status', style: caption }, t('saving'))
            : !writable ? h('p', { role: 'status', style: caption }, t('readOnly')) : null,
          error ? h('p', { role: 'alert', style: errorCaption }, t(error)) : null),
      )
    }

    function LocalizationConfirmation({ sessionId, provider, labels, t }) {
      const [localized, setLocalized] = React.useState(false)
      React.useEffect(() => {
        let stream
        try {
          const url = new URL('./api/dsh-gemini-enhancement/status', document.baseURI)
          if (url.origin !== window.location.origin) return
          url.searchParams.set('sessionId', sessionId)
          stream = new EventSource(url.href)
        } catch {
          return // The match notice stays available without a live connection.
        }
        stream.onmessage = ({ data }) => {
          try { setLocalized(JSON.parse(data) === provider) }
          catch { setLocalized(false) }
        }
        stream.onerror = () => setLocalized(false)
        return () => {
          stream.onmessage = stream.onerror = null
          stream.close()
        }
      }, [sessionId, provider])

      const summary = [t(localized ? 'statusLocalized' : 'statusMatched'), ...labels].join(' · ')
      return h('span', {
        role: 'status',
        style: { ...secondary, display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, textAlign: 'center' },
      }, h(GeminiMark, { label: t('source') }), h('span', null, summary))
    }

    const noSearchCards = []
    const emptySearchActivity = { running: false, turns: new Map() }

    function selectActivity(value, previous) {
      const turns = new Map()
      let running = false
      for (const card of value.cards) {
        if (!Number.isSafeInteger(card?.turn) || !Array.isArray(card.queries) || !Array.isArray(card.sources)) continue
        if (card.turn === value.liveTurn) {
          running ||= card.status === 'running'
          continue
        }
        const group = turns.get(card.turn)
        if (group) group.push(card)
        else turns.set(card.turn, [card])
      }
      for (const [turn, group] of turns) {
        const prior = previous.turns.get(turn)
        if (prior && JSON.stringify(prior) === JSON.stringify(group)) turns.set(turn, prior)
      }
      return { running, turns }
    }

    const activityCardStyle = {
      margin: '4px 0', padding: '6px 10px', borderRadius: 8,
      border: '1px solid var(--dsw-alias-label-tertiary)', color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-alias-bg-base)', fontSize: 13, lineHeight: 1.5, overflowWrap: 'anywhere',
    }

    function safeSourceURL(raw) {
      try {
        const url = new URL(raw)
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href
      } catch { /* Untrusted provider data. */ }
    }

    function GoogleSearchCard({ cards, t }) {
      const complete = cards.some(card => card.status === 'completed')
      const unconfirmed = cards.some(card => card.status !== 'completed')
      const status = t(unconfirmed ? (complete ? 'activityPartial' : 'activityIncomplete') : 'activityCompleted')
      const queries = [...new Set(cards.flatMap(card => card.queries))].slice(0, 12)
      const links = new Map()
      for (const { sources } of cards) for (const source of sources) {
        const href = safeSourceURL(source?.url)
        if (!href || links.has(href) || links.size >= 8) continue
        const host = new URL(href).hostname
        links.set(href, { href, host, title: source.title || host })
      }
      const sources = [...links.values()]
      const counts = [queries.length && `${t('activityQueries')} ${queries.length}`, sources.length && `${t('activitySourceCount')} ${sources.length}`].filter(Boolean)
      const subtitle = [status, ...counts].join(' · ')
      const summary = h(React.Fragment, null,
        h('span', { style: { fontWeight: 600 } }, t('activityTitle')),
        h('span', { style: { ...secondary, marginInlineStart: 8 } }, subtitle))
      if (!queries.length && !sources.length) return h('div', { style: activityCardStyle }, summary)
      const list = { marginBlock: '2px 6px', paddingInlineStart: 20 }
      return h('details', { style: activityCardStyle },
        h('summary', { style: { cursor: 'pointer' } }, summary),
        queries.length > 0 && h('div', null, h('span', { style: secondary }, t('activityQueries')),
          h('ul', { style: list }, queries.map(query => h('li', { key: query }, query)))),
        sources.length > 0 && h('div', null, h('span', { style: secondary }, t('activitySources')),
          h('ul', { style: list }, sources.map(source => h('li', { key: source.href },
            h('a', { href: source.href, target: '_blank', rel: 'noopener noreferrer', style: { color: 'inherit' } }, source.title),
            source.host !== source.title && h('span', { style: { ...secondary, marginInlineStart: 8 } }, source.host))))))
    }

    // The live composer and visible history rows share one stream per session.
    function searchActivityHooks(ctx) {
      const sessions = new Map()
      function publish(entry, value) {
        entry.value = value
        for (const changed of entry.listeners) changed()
      }
      function connect(sessionId, entry) {
        try {
          const url = new URL('./api/dsh-gemini-enhancement/search-activity', document.baseURI)
          if (url.origin !== window.location.origin) return
          url.searchParams.set('sessionId', sessionId)
          const source = new EventSource(url.href)
          entry.source = source
          source.onmessage = ({ data }) => {
            try {
              const value = JSON.parse(data)
              if (!Array.isArray(value?.cards)) return
              publish(entry, selectActivity(value, entry.value))
            } catch { /* A bad presentation message must not affect chat. */ }
          }
          source.onerror = () => {
            if (entry.value.running) publish(entry, { ...entry.value, running: false })
          }
        } catch { /* Chat remains available without the presentation route. */ }
      }
      function close(entry) {
        if (!entry.source) return
        entry.source.onmessage = entry.source.onerror = null
        entry.source.close()
      }
      ctx.effect(() => () => {
        for (const entry of sessions.values()) close(entry)
        sessions.clear()
      })
      return function useSearchActivity(sessionId, turn) {
        const get = React.useCallback(() => {
          const value = sessions.get(sessionId)?.value ?? emptySearchActivity
          return turn === undefined ? value.running : value.turns.get(turn) ?? noSearchCards
        }, [sessionId, turn])
        const subscribe = React.useCallback(listener => {
          if (!sessionId) return () => {}
          let entry = sessions.get(sessionId)
          if (!entry) {
            entry = { listeners: new Set(), value: emptySearchActivity }
            sessions.set(sessionId, entry)
            connect(sessionId, entry)
          }
          entry.listeners.add(listener)
          return () => {
            entry.listeners.delete(listener)
            if (entry.listeners.size === 0) {
              close(entry)
              if (sessions.get(sessionId) === entry) sessions.delete(sessionId)
            }
          }
        }, [sessionId])
        return React.useSyncExternalStore(subscribe, get)
      }
    }

    // Session-level XHigh toggle state synced via SSE + POST without touching native modelSelection.
    function xhighHooks(ctx) {
      const sessions = new Map()
      function resolveURL() {
        const url = new URL('./api/dsh-gemini-enhancement/xhigh', document.baseURI)
        if (url.origin !== window.location.origin) return null
        return url
      }
      function publish(entry, enabled) {
        const next = enabled === true
        if (entry.value === next) return
        entry.value = next
        for (const changed of entry.listeners) changed()
      }
      function connect(sessionId, entry) {
        try {
          const url = resolveURL()
          if (!url) return
          url.searchParams.set('sessionId', sessionId)
          const source = new EventSource(url.href)
          entry.source = source
          source.onmessage = ({ data }) => {
            try {
              const parsed = JSON.parse(data)
              if (typeof parsed?.enabled === 'boolean') publish(entry, parsed.enabled)
            } catch { /* A bad xhigh frame must not affect chat. */ }
          }
          source.onerror = () => { /* EventSource reconnects automatically and Host pushes current state. */ }
        } catch { /* Chat remains available without the xhigh route. */ }
      }
      function close(entry) {
        if (!entry.source) return
        entry.source.onmessage = entry.source.onerror = null
        entry.source.close()
        entry.source = null
      }
      ctx.effect(() => () => {
        for (const entry of sessions.values()) close(entry)
        sessions.clear()
      })
      function useXHigh(sessionId) {
        const get = React.useCallback(() => (
          sessionId ? (sessions.get(sessionId)?.value === true) : false
        ), [sessionId])
        const subscribe = React.useCallback(listener => {
          if (!sessionId) return () => {}
          let entry = sessions.get(sessionId)
          if (!entry) {
            entry = { listeners: new Set(), value: false, source: null }
            sessions.set(sessionId, entry)
            connect(sessionId, entry)
          }
          entry.listeners.add(listener)
          return () => {
            entry.listeners.delete(listener)
            if (entry.listeners.size === 0) {
              close(entry)
              if (sessions.get(sessionId) === entry) sessions.delete(sessionId)
            }
          }
        }, [sessionId])
        return React.useSyncExternalStore(subscribe, get)
      }
      async function setXHigh(sessionId, enabled) {
        if (!sessionId) return false
        try {
          const url = resolveURL()
          if (!url) return false
          const response = await fetch(url.href, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, enabled: enabled === true }),
          })
          if (!response?.ok) return false
          const payload = await response.json()
          if (typeof payload?.enabled !== 'boolean') return false
          const entry = sessions.get(sessionId)
          if (entry) publish(entry, payload.enabled)
          return true
        } catch {
          return false
        }
      }
      return { useXHigh, setXHigh }
    }

    const emptyModelStore = { subscribe: () => () => {}, getSnapshot: () => undefined }
    const emptyHook = () => undefined

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        const config = ctx.configForms.get(pluginId)
        const subscribe = config.subscribe.bind(config)
        const getSnapshot = config.getSnapshot.bind(config)
        const useSearchActivity = searchActivityHooks(ctx)
        const { useXHigh, setXHigh } = xhighHooks(ctx)
        const modelsForm = ctx.configForms.get('llm-pi-ai')
        const subscribeModels = modelsForm.subscribe.bind(modelsForm)
        const getModels = modelsForm.getSnapshot.bind(modelsForm)

        function LiveSearchActivity({ sessionId, t }) {
          if (!useSearchActivity(sessionId)) return null
          return h('span', { role: 'status', style: { ...secondary, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
            t('activityLive'))
        }

        function TurnSearchCards({ sessionId, turn, t, useProjection }) {
          const turnNumber = typeof turn === 'number' ? turn : turn?.turn
          const durable = useProjection('geminiNativeSearchActivity', value => value?.[turnNumber] ?? noSearchCards)
          const temporary = useSearchActivity(sessionId, turnNumber)
          const cards = durable.length ? durable : temporary
          return cards.length ? h(GoogleSearchCard, { cards, t }) : null
        }

        function EnhancementNotice({ sessionId, useProjection, modelStore = emptyModelStore, t }) {
          const snapshot = React.useSyncExternalStore(subscribe, getSnapshot)
          const selectedProvider = useProjection('modelSelection', selection => selection?.next?.provider)
          const modelState = React.useSyncExternalStore(modelStore.subscribe, modelStore.getSnapshot)
          // The projection has no saved choice in a new chat using the profile
          // default. Use the same directory as the picker for that fallback.
          const provider = selectedProvider ?? modelState?.current?.provider
          if (snapshot.status !== 'ready' || snapshot.value?.showStatusNotice !== true || !sessionId || !provider) return null
          const routeCfg = routeEntryOf(snapshot.value?.routes, provider)
          if (!hasAnyEnhancement(routeCfg)) return null
          const extraLabels = [
            routeCfg.nativeHistory && t('statusNativeHistory'),
            routeCfg.googleSearch && t('statusGoogleSearch'),
          ].filter(Boolean)
          if (routeCfg.localizePrompt) {
            return h(LocalizationConfirmation, {
              key: JSON.stringify([sessionId, provider]),
              sessionId,
              provider,
              labels: extraLabels,
              t,
            })
          }
          return h('span', {
            role: 'status',
            style: { ...secondary, display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, textAlign: 'center' },
          }, h(GeminiMark, { label: t('source') }), h('span', null, extraLabels.join(' · ')))
        }

        function XHighToggle({
          sessionId,
          useProjection,
          useSession = emptyHook,
          useSessions = emptyHook,
          modelStore = emptyModelStore,
          modelSelectionAvailable = true,
          t,
        }) {
          const isSubagent = useSession(snapshot => snapshot?.subagent != null) === true
          const removed = useSession(snapshot => snapshot?.removed === true) === true
          const isListedSubagent = useSessions(state => state?.byId?.[sessionId]?.origin === 'subagent') === true
          const selected = useProjection('modelSelection', selection => selection?.next)
          const modelState = React.useSyncExternalStore(modelStore.subscribe, modelStore.getSnapshot)
          const modelsSnap = React.useSyncExternalStore(subscribeModels, getModels)

          const provider = selected?.provider ?? modelState?.current?.provider
          const model = selected?.model ?? modelState?.current?.model
          const profile = modelsSnap.status === 'ready' ? modelsSnap.value?.providers?.[provider] : undefined
          const isGeminiRoute = Boolean(provider) && (
            modelsSnap.status === 'ready'
              ? isGeminiProfile(provider, profile)
              : provider === 'google'
          )
          const eligible = Boolean(sessionId)
            && modelSelectionAvailable !== false
            && !isSubagent
            && !isListedSubagent
            && isGeminiRoute
            && supportsXHighModel(model)

          const enabled = useXHigh(eligible ? sessionId : null)
          const [busy, setBusy] = React.useState(false)
          const [hovered, setHovered] = React.useState(false)
          const busyRef = React.useRef(false)
          const activeRef = React.useRef(true)
          const reqSeqRef = React.useRef(0)

          React.useEffect(() => {
            activeRef.current = true
            return () => { activeRef.current = false }
          }, [])

          React.useEffect(() => {
            reqSeqRef.current += 1
            busyRef.current = false
            setBusy(false)
          }, [sessionId])

          const disabled = busy || removed
          const onToggle = React.useCallback(async () => {
            if (busyRef.current || removed || !sessionId) return
            const reqSeq = ++reqSeqRef.current
            busyRef.current = true
            setBusy(true)
            try {
              await setXHigh(sessionId, !enabled)
            } finally {
              if (reqSeqRef.current === reqSeq) {
                busyRef.current = false
                if (activeRef.current) setBusy(false)
              }
            }
          }, [sessionId, enabled, removed])

          if (!eligible) return null

          const tooltip = t(enabled ? 'xhighOnTitle' : 'xhighOffTitle')
          return h('button', {
            type: 'button',
            'aria-pressed': enabled,
            'aria-busy': busy || undefined,
            'aria-label': tooltip,
            title: tooltip,
            disabled,
            onMouseDown: event => event.preventDefault(),
            onMouseEnter: () => setHovered(true),
            onMouseLeave: () => setHovered(false),
            onClick: onToggle,
            style: {
              ...xhighButtonBase,
              border: enabled
                ? '0.5px solid var(--dsw-alias-state-business-primary)'
                : '0.5px solid var(--dsw-alias-border-l3)',
              background: enabled
                ? (hovered && !disabled
                  ? 'color-mix(in srgb, var(--dsw-alias-state-business-tertiary), var(--dsw-alias-state-business-primary) 8%)'
                  : 'var(--dsw-alias-state-business-tertiary)')
                : (hovered && !disabled ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent'),
              color: enabled ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-label-secondary)',
              fontWeight: enabled ? 500 : 400,
              opacity: disabled ? 0.65 : 1,
              cursor: disabled ? 'default' : 'pointer',
            },
          }, h(GeminiMark, { size: 12 }), h('span', null, t('xhighLabel')))
        }

        ctx.effect(() => ctx.locale.register(namespace, { en, zh }))
        ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
          name: 'settings.models.provider-card', key: 'llm-pi-ai', locale: namespace,
        }, props => h(ProviderCardEnhancements, {
          ...props,
          configForm: config,
          subscribeConfig: subscribe,
          getConfig: getSnapshot,
          subscribeModels,
          getModels,
        })))
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config', key: `${pluginId}#${pluginId}`, locale: namespace,
        }, ({ view, form, t }) => view === 'page' ? h(PluginSettingsPage, { form, t, subscribeModels, getModels }) : null))
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: `${pluginId}-search-live`, order: 3, locale: namespace,
        }, LiveSearchActivity))
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail', id: `${pluginId}-search-cards`, locale: namespace,
        }, TurnSearchCards))
        ctx.inject(['modelDirectories'], scope => {
          const models = scope.modelDirectories
          const sessions = scope.get?.('sessions') ?? scope.sessions
          const injectModelStore = sessionId => {
            if (!sessionId) return {}
            try { return { modelStore: models.directoryFor(sessionId).store } }
            catch { return {} }
          }
          scope.slots.inject('conversation.composer.dock', () => scope.slots.register({
            name: 'conversation.composer.dock', id: `${pluginId}-notice`, order: 2, locale: namespace,
            inject: injectModelStore,
          }, EnhancementNotice))
          scope.slots.inject('conversation.input.right', () => scope.slots.register({
            name: 'conversation.input.right', id: `${pluginId}-xhigh`, order: 100, locale: namespace,
            inject: sessionId => ({
              ...injectModelStore(sessionId),
              modelSelectionAvailable: !sessionId || sessions?.subagentAddress?.(sessionId) === undefined,
            }),
          }, XHighToggle))
        })
      },
    }
  },
})
