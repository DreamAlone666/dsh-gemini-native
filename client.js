window.__ModuleLoader__.load({
  id: 'dsh-gemini-enhancement',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const namespace = 'dshGeminiEnhancement'
    const pluginId = 'dsh-gemini-enhancement'
    const en = {
      title: 'Model ID rules',
      showNotice: 'System prompt localization notice',
      noticeHelp: 'Show a match as soon as you select an eligible model. The notice confirms localization once a request uses it. Turning it off does not disable localization.',
      matched: 'System prompt localization matched',
      localized: 'System prompt localized',
      source: 'Source: Gemini 增强 plugin',
      help: 'Enter one case-sensitive model ID per line, without the provider ID. For example, gemini-4-argon matches one model; gemini-4-* matches a prefix. A * is allowed only at the end. An empty list matches no models.',
      invalid: 'Each line needs a model ID or a non-empty prefix followed by *. No whitespace is allowed inside a rule.',
      loading: 'Loading model ID rules…',
      unavailable: 'Configuration is unavailable. Check that the bundle and its plugin row are enabled, then reopen this page.',
      readOnly: 'This configuration is read-only.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Settings saved.',
      failed: 'Could not confirm the save. Your draft is still here.',
      conflict: 'These settings changed elsewhere. Copy any edits you want to keep before loading the latest settings.',
      reload: 'Discard draft and reload',
    }
    const zh = {
      title: '模型 ID 规则',
      showNotice: '显示系统提示词汉化状态',
      noticeHelp: '切到匹配模型时显示匹配提示，确认请求使用汉化后显示已汉化。关闭此选项不影响汉化。',
      matched: '已匹配系统提示词汉化规则',
      localized: '系统提示词已汉化',
      source: '来源：Gemini 增强插件',
      help: '每行填写一个区分大小写的模型 ID，不要另加供应商 ID。例如，gemini-4-argon 只匹配一个 ID；gemini-4-* 按前缀匹配。* 只能放在末尾。保存空列表不会匹配任何模型。',
      invalid: '每行填写一个模型 ID，或在非空前缀末尾加 *。规则内部不能有空白字符。',
      loading: '正在加载模型 ID 规则…',
      unavailable: '配置不可用。请确认组合包和插件行均已启用，然后重新打开此页。',
      readOnly: '此配置为只读。',
      save: '保存',
      saving: '正在保存…',
      saved: '设置已保存。',
      failed: '未能确认保存结果，草稿仍保留。',
      conflict: '设置已在别处更改。重新载入前，请先复制你想保留的编辑内容。',
      reload: '放弃草稿并重新载入',
    }

    const secondary = { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 13, lineHeight: 1.5 }
    const panel = { display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 680 }
    const button = {
      border: '1px solid var(--dsw-alias-border-selected)', borderRadius: 8,
      padding: '6px 14px', font: 'inherit', cursor: 'pointer',
      background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
    }
    const primaryButton = {
      ...button, background: 'var(--dsw-alias-button-primary-fill)',
      color: 'var(--dsw-alias-label-primary-foreground)',
    }

    function ModelIdForm({ form, t }) {
      const id = React.useId()
      const [draft, setDraft] = React.useState(null)
      const [feedback, setFeedback] = React.useState(null)
      const active = React.useRef(false)
      const saving = React.useRef(false)
      React.useEffect(() => {
        active.current = true
        return () => { active.current = false }
      }, [])

      const state = form?.state
      const accepted = state?.value?.modelIds
      const revision = state?.revision
      if (!Array.isArray(accepted) || typeof revision !== 'number') {
        return h('p', { role: 'status', style: secondary }, t(state?.status === 'loading' ? 'loading' : 'unavailable'))
      }
      const baselineText = accepted.join('\n')
      const text = draft?.text ?? baselineText
      const baselineNotice = state.value.showLocalizationNotice === true
      const showLocalizationNotice = draft?.showLocalizationNotice ?? baselineNotice
      const rules = [...new Set(text.split('\n').map(line => line.trim()).filter(Boolean))]
      const invalid = rules.some(rule => !/^[^\s*]+\*?$/u.test(rule))
      const rulesChanged = rules.length !== accepted.length || rules.some((rule, i) => rule !== accepted[i])
      const noticeChanged = showLocalizationNotice !== baselineNotice
      const changed = rulesChanged || noticeChanged
      const conflict = draft !== null && draft.revision !== revision && changed
      const busy = feedback?.kind === 'saving'
      const writable = state.status === 'ready' && state.writable === true
      const canSave = draft !== null && writable && changed && !invalid && !conflict && !busy

      function edit(nextText, nextNotice) {
        setDraft(nextText === baselineText && nextNotice === baselineNotice ? null : {
          text: nextText,
          showLocalizationNotice: nextNotice,
          revision: changed ? draft?.revision ?? revision : revision,
        })
        setFeedback(null)
      }

      async function save(event) {
        event.preventDefault()
        if (!canSave || saving.current) return
        saving.current = true
        setFeedback({ kind: 'saving' })
        try {
          const ops = []
          if (rulesChanged) ops.push({ op: 'set', path: ['modelIds'], value: rules })
          if (noticeChanged) ops.push({ op: 'set', path: ['showLocalizationNotice'], value: showLocalizationNotice })
          const ok = await form.mutate(ops, draft.revision)
          if (!active.current) return
          if (ok) {
            setDraft(null)
            setFeedback({ kind: 'saved' })
          } else setFeedback({ kind: 'failed' })
        } catch {
          if (active.current) setFeedback({ kind: 'failed' })
        } finally {
          saving.current = false
        }
      }

      const note = busy ? 'saving' : conflict ? 'conflict' : feedback?.kind ?? (!writable ? 'readOnly' : null)
      return h('form', { onSubmit: save, style: panel, 'aria-busy': busy },
        h('label', { htmlFor: id, style: { fontWeight: 600 } }, t('title')),
        h('p', { id: id + '-help', style: secondary }, t('help')),
        h('textarea', {
          id, value: text, rows: 5, spellCheck: false, autoCapitalize: 'off',
          readOnly: !writable || busy, 'aria-invalid': invalid,
          'aria-describedby': id + '-help' + (invalid ? ' ' + id + '-error' : ''),
          style: {
            boxSizing: 'border-box', width: '100%', padding: 10, resize: 'vertical',
            border: '1px solid var(--dsw-alias-label-tertiary)', borderRadius: 8,
            background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', font: 'inherit',
          },
          onChange: event => edit(event.target.value, showLocalizationNotice),
        }),
        invalid ? h('p', { id: id + '-error', role: 'alert', style: secondary }, t('invalid')) : null,
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('input', {
            type: 'checkbox', checked: showLocalizationNotice, disabled: !writable || busy,
            'aria-describedby': id + '-notice-help',
            onChange: event => edit(text, event.target.checked),
          }),
          t('showNotice'),
        ),
        h('p', { id: id + '-notice-help', style: secondary }, t('noticeHelp')),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
          h('button', { type: 'submit', disabled: !canSave, style: canSave ? primaryButton : { ...button, opacity: 0.6, cursor: 'default' } }, t('save')),
          conflict && !busy ? h('button', { type: 'button', style: button, onClick() { setDraft(null); setFeedback(null) } }, t('reload')) : null,
        ),
        h('p', { role: 'status', style: secondary }, note ? t(note) : null),
      )
    }

    function matchesModelId(model, rules) {
      return typeof model === 'string' && model.length !== 0 && Array.isArray(rules)
        && rules.some(rule => typeof rule === 'string' && (rule.endsWith('*')
          ? model.startsWith(rule.slice(0, -1)) : model === rule))
    }

    // Same outline as the bundle icon, cropped for the small composer seat.
    function GeminiMark({ label }) {
      return h('svg', {
        width: 14, height: 14, viewBox: '6 6 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 2.5, strokeLinejoin: 'round',
        role: 'img', 'aria-label': label, focusable: 'false', style: { flexShrink: 0 },
      }, h('title', null, label), h('path', {
        d: 'M18 8.5C19.4 13.4 22.6 16.6 27.5 18C22.6 19.4 19.4 22.6 18 27.5C16.6 22.6 13.4 19.4 8.5 18C13.4 16.6 16.6 13.4 18 8.5Z',
      }))
    }

    function LocalizationNoticeStream({ sessionId, model, t }) {
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
          try { setLocalized(JSON.parse(data) === model) }
          catch { setLocalized(false) }
        }
        stream.onerror = () => setLocalized(false)
        return () => {
          stream.onmessage = stream.onerror = null
          stream.close()
        }
      }, [sessionId, model])

      return h('span', {
        role: 'status',
        style: { ...secondary, display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, textAlign: 'center' },
      }, h(GeminiMark, { label: t('source') }), h('span', null, t(localized ? 'localized' : 'matched')))
    }

    const emptyModelStore = { subscribe: () => () => {}, getSnapshot: () => undefined }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        const config = ctx.configForms.get(pluginId)
        const subscribe = config.subscribe.bind(config)
        const getSnapshot = config.getSnapshot.bind(config)

        function LocalizationNotice({ sessionId, useProjection, modelStore = emptyModelStore, t }) {
          const snapshot = React.useSyncExternalStore(subscribe, getSnapshot)
          const selectedModel = useProjection('modelSelection', selection => selection?.next?.model)
          const modelState = React.useSyncExternalStore(modelStore.subscribe, modelStore.getSnapshot)
          // The projection has no saved choice in a new chat using the profile
          // default. Use the same directory as the picker for that fallback.
          const model = selectedModel ?? modelState?.current?.model
          if (snapshot.status !== 'ready' || snapshot.value?.showLocalizationNotice !== true
            || !sessionId || !matchesModelId(model, snapshot.value?.modelIds)) return null
          // A new session/model must not paint the previous stream's evidence.
          return h(LocalizationNoticeStream, { key: JSON.stringify([sessionId, model]), sessionId, model, t })
        }

        ctx.effect(() => ctx.locale.register(namespace, { en, zh }))
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config', key: `${pluginId}#${pluginId}`, locale: namespace,
        }, ({ view, form, t }) => view === 'page' ? h(ModelIdForm, { form, t }) : null))
        ctx.inject(['modelDirectories'], scope => {
          const models = scope.modelDirectories
          scope.slots.inject('conversation.composer.dock', () => scope.slots.register({
            name: 'conversation.composer.dock', id: `${pluginId}-notice`, order: 2, locale: namespace,
            inject: sessionId => {
              if (!sessionId) return {}
              try { return { modelStore: models.directoryFor(sessionId).store } }
              catch { return {} }
            },
          }, LocalizationNotice))
        })
      },
    }
  },
})
