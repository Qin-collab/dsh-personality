/**
 * dsh-personality — browser half.
 *
 * One page inside the Settings panel (`settings.section`), next to the shipped
 * sections: quick persona presets, the editable persona fields, and the
 * conversation-history memory (summarize now / inspect / clear).
 *
 * Everything the page reads or writes goes through the plugin's own Host
 * endpoints under /dsh-personality/api, so the same operations are available
 * to the agent as `personality_*` tools.
 *
 * Deliberately a plain class component with a total render(): a slot entry
 * that throws is replaced by a blank crash face and retired for the session,
 * so this page catches its own render failures and prints them instead.
 */

window.__ModuleLoader__.load({
  id: 'dsh-personality',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const API = '/dsh-personality/api'

    const DICT = {
      zh: {
        section: 'DSH 人格',
        title: 'DSH 人格',
        desc: '人格会写进每一轮的系统提示，历史会话会被总结成 JSON 作为长期记忆一起注入。',
        presetTitle: '快速人格',
        presetDesc: '点一下直接套用，可以再往下微调。',
        editTitle: '人格设定',
        nameLabel: '名字',
        namePlaceholder: '例如：DSH',
        identityLabel: '身份',
        identityPlaceholder: '它是谁、为谁服务',
        styleLabel: '表达风格',
        stylePlaceholder: '语气、长度、排版习惯…',
        rulesLabel: '行为准则（每行一条）',
        rulesPlaceholder: '先给结论，再给理由\n不确定就说不确定',
        save: '保存人格',
        reload: '重新读取文件',
        saved: '人格已保存，下一轮对话生效。',
        reloaded: '已从数据目录重新读取。',
        memoryTitle: '长期记忆',
        memoryDesc: '读取历史会话 → 让模型总结成 JSON → 存进 memory.json，之后每轮对话都会带上。',
        summarize: '总结历史会话',
        summarizing: '正在总结历史会话…',
        clear: '清空记忆',
        clearConfirm: '确定清空所有会话总结与记忆条目？人格不受影响。',
        cleared: '记忆已清空。',
        summarized: (n, s, f) => '已归档 ' + n + ' 个会话（跳过 ' + s + '，失败 ' + f + '）。',
        summarizeNone: '没有需要归档的新会话（去聊几句再试，或勾选强制重算）。',
        force: '强制重新总结',
        noSessions: '还没有会话总结。',
        sessionsCount: (n) => '会话总结 ' + n,
        memoriesCount: (m) => '记忆条目 ' + m,
        dataDir: '数据目录',
        loading: '加载中…',
        loadFailed: '读取插件状态失败',
        applied: (name) => '已套用「' + name + '」预设。',
        hint: '设置会立即写入 JSON 文件，无需重启。',
        crash: '组件渲染异常，请把下面这段贴给助手：',
        retry: '重试',
      },
      en: {
        section: 'DSH Personality',
        title: 'DSH Personality',
        desc: 'The persona is added to every turn’s system prompt; past sessions are summarized into JSON and injected as long-term memory.',
        presetTitle: 'Quick persona',
        presetDesc: 'Apply one with a click, then fine-tune below.',
        editTitle: 'Persona',
        nameLabel: 'Name',
        namePlaceholder: 'e.g. DSH',
        identityLabel: 'Identity',
        identityPlaceholder: 'Who it is and who it serves',
        styleLabel: 'Expression style',
        stylePlaceholder: 'Tone, length, formatting habits…',
        rulesLabel: 'Behavior rules (one per line)',
        rulesPlaceholder: 'Conclusion first, then reasoning\nSay “I don’t know” instead of guessing',
        save: 'Save persona',
        reload: 'Reload from disk',
        saved: 'Persona saved — effective on the next turn.',
        reloaded: 'Reloaded from the data directory.',
        memoryTitle: 'Long-term memory',
        memoryDesc: 'Reads stored sessions, asks the model for a JSON summary, writes memory.json, and injects it on every turn.',
        summarize: 'Summarize history',
        summarizing: 'Summarizing stored sessions…',
        clear: 'Clear memory',
        clearConfirm: 'Clear every session summary and memory entry? The persona is untouched.',
        cleared: 'Memory cleared.',
        summarized: (n, s, f) => 'Archived ' + n + ' session(s), skipped ' + s + ', failed ' + f + '.',
        summarizeNone: 'No new sessions to archive — chat a bit first, or force a re-summary.',
        force: 'Force re-summary',
        noSessions: 'No session summaries yet.',
        sessionsCount: (n) => n + ' session summaries',
        memoriesCount: (m) => m + ' memory entries',
        dataDir: 'Data directory',
        loading: 'Loading…',
        loadFailed: 'Failed to read plugin state',
        applied: (name) => 'Applied the “' + name + '” preset.',
        hint: 'Settings are written straight to the JSON files; no restart needed.',
        crash: 'This page failed to render — please paste the block below to the assistant:',
        retry: 'Retry',
      },
    }

    /** Read the locale without ever letting a service shape change throw. */
    function detectLang(ctx) {
      try {
        const locale = ctx ? ctx.locale : undefined
        if (locale && typeof locale.getLocale === 'function') {
          const snapshot = locale.getLocale()
          const id = String(
            (snapshot && (snapshot.id || snapshot.active || snapshot.locale || snapshot.code)) || '',
          )
          if (id !== '') return id.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
        }
      } catch {
        /* fall through to the browser language */
      }
      try {
        const nav = typeof navigator !== 'undefined' ? navigator : undefined
        if (nav && String(nav.language || '').toLowerCase().indexOf('zh') === 0) return 'zh'
      } catch {
        /* ignore */
      }
      return 'en'
    }

    function labelFor(lang) {
      return (DICT[lang] || DICT.en).section
    }

    async function readJson(response) {
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || (payload && payload.ok === false)) {
        throw new Error((payload && payload.error) || 'HTTP ' + response.status)
      }
      return payload
    }

    const CSS = [
      '.dshp{display:flex;flex-direction:column;gap:18px;padding:2px 2px 28px;color:var(--dsw-alias-label-primary);font-size:13px}',
      '.dshp-h1{margin:0 0 4px;font-size:16px;font-weight:600;line-height:1.3}',
      '.dshp-desc{margin:0;font-size:12.5px;line-height:1.7;color:var(--dsw-alias-label-secondary)}',
      '.dshp-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px;display:flex;flex-direction:column;gap:12px}',
      '.dshp-card-head{display:flex;flex-direction:column;gap:3px}',
      '.dshp-card-title{font-size:13px;font-weight:600}',
      '.dshp-card-sub{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6}',
      '.dshp-presets{display:grid;grid-template-columns:repeat(auto-fill,minmax(158px,1fr));gap:8px}',
      '.dshp-preset{text-align:left;cursor:pointer;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);padding:8px 10px;color:inherit;font:inherit;transition:border-color .12s ease}',
      '.dshp-preset:hover{border-color:var(--dsw-alias-border-l2)}',
      '.dshp-preset:disabled{opacity:.55;cursor:default}',
      '.dshp-preset-name{font-weight:600;font-size:12.5px}',
      '.dshp-preset-hint{margin-top:2px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.dshp-field{display:flex;flex-direction:column;gap:5px}',
      '.dshp-label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dshp-input,.dshp-textarea{width:100%;box-sizing:border-box;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;padding:8px 10px}',
      '.dshp-textarea{resize:vertical;min-height:62px;line-height:1.65}',
      '.dshp-input:focus,.dshp-textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.dshp-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
      '.dshp-btn{cursor:pointer;font:inherit;font-size:12.5px;padding:7px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);transition:border-color .12s ease}',
      '.dshp-btn:hover{border-color:var(--dsw-alias-border-l2)}',
      '.dshp-btn:disabled{opacity:.55;cursor:default}',
      '.dshp-btn-primary{border-color:transparent;background:var(--dsw-alias-brand-primary);color:#fff}',
      '.dshp-btn-danger{color:var(--dsw-alias-state-error-primary)}',
      '.dshp-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);word-break:break-all;line-height:1.6}',
      '.dshp-list{display:flex;flex-direction:column;gap:8px;max-height:320px;overflow:auto}',
      '.dshp-item{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);padding:8px 10px}',
      '.dshp-item-title{display:flex;justify-content:space-between;gap:10px;font-size:12.5px;font-weight:600}',
      '.dshp-item-body{margin-top:4px;font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}',
      '.dshp-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}',
      '.dshp-chip{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}',
      '.dshp-msg{font-size:12px;line-height:1.6}',
      '.dshp-err{color:var(--dsw-alias-state-error-primary)}',
      '.dshp-ok{color:var(--dsw-alias-state-success-primary)}',
      '.dshp-empty{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dshp-counts{display:flex;gap:14px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dshp-pre{font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px;max-height:180px;overflow:auto;margin:6px 0 0}',
    ].join('\n')

    function formatTime(seconds) {
      if (!Number.isFinite(seconds) || seconds <= 0) return ''
      try {
        return new Date(seconds).toLocaleString()
      } catch {
        return ''
      }
    }

    function createSection(ctx) {
      const initialLang = detectLang(ctx)

      class PersonalitySection extends React.Component {
        constructor(props) {
          super(props)
          this.state = {
            lang: initialLang,
            data: null,
            draft: { name: '', identity: '', style: '', rules: '' },
            busy: '',
            error: '',
            notice: '',
            force: false,
          }
          this.alive = false
          this.load = this.load.bind(this)
          this.save = this.save.bind(this)
          this.reload = this.reload.bind(this)
          this.summarize = this.summarize.bind(this)
          this.clearMemory = this.clearMemory.bind(this)
        }

        componentDidMount() {
          this.alive = true
          this.load()
        }

        componentWillUnmount() {
          this.alive = false
        }

        /** Apply a host state payload to the form. */
        applyState(state) {
          if (!state) return
          const persona = state.personality || {}
          this.setState({
            data: state,
            draft: {
              name: persona.name || '',
              identity: persona.identity || '',
              style: persona.style || '',
              rules: Array.isArray(persona.rules) ? persona.rules.join('\n') : '',
            },
          })
        }

        /** One request with busy/error bookkeeping; never leaves a stuck spinner. */
        async run(tag, operation) {
          if (!this.alive) return
          this.setState({ busy: tag, error: '', notice: '' })
          try {
            await operation()
          } catch (error) {
            if (this.alive) {
              const message = error && error.message ? error.message : String(error)
              this.setState({ error: message })
            }
          } finally {
            if (this.alive) this.setState({ busy: '' })
          }
        }

        async request(path, body) {
          const response = await fetch(API + path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body || {}),
          })
          return readJson(response)
        }

        load() {
          return this.run('load', async () => {
            const response = await fetch(API + '/state', { headers: { accept: 'application/json' } })
            const state = await readJson(response)
            if (this.alive) this.applyState(state)
          })
        }

        save() {
          const draft = this.state.draft
          return this.run('save', async () => {
            const rules = String(draft.rules || '')
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line !== '')
            const result = await this.request('/personality', {
              name: draft.name,
              identity: draft.identity,
              style: draft.style,
              rules,
            })
            if (!this.alive) return
            this.applyState(result.state)
            this.setState({ notice: this.t().saved })
          })
        }

        reload() {
          return this.run('reload', async () => {
            const result = await this.request('/reload', {})
            if (!this.alive) return
            this.applyState(result.state)
            this.setState({ notice: this.t().reloaded })
          })
        }

        applyPreset(preset) {
          return this.run('preset', async () => {
            const result = await this.request('/preset', { preset: preset.id })
            if (!this.alive) return
            this.applyState(result.state)
            this.setState({ notice: this.t().applied(preset.label) })
          })
        }

        summarize() {
          const t = this.t()
          return this.run('summarize', async () => {
            const result = await this.request('/summarize', { limit: 8, force: this.state.force })
            if (!this.alive) return
            this.applyState(result.state)
            const ok = Number(result.summarized) || 0
            const skipped = Number(result.skipped) || 0
            const failed = Number(result.failed) || 0
            const notice = ok === 0 && skipped === 0 && failed === 0 ? t.summarizeNone : t.summarized(ok, skipped, failed)
            const failures = Array.isArray(result.errors) && result.errors.length > 0
              ? result.errors.map((item) => String(item && item.sessionId) + ': ' + String(item && item.message)).join('\n')
              : ''
            this.setState({ notice, error: failures })
          })
        }

        clearMemory() {
          const t = this.t()
          let confirmed = true
          try {
            if (typeof window !== 'undefined' && typeof window.confirm === 'function') confirmed = window.confirm(t.clearConfirm)
          } catch {
            confirmed = true
          }
          if (!confirmed) return undefined
          return this.run('clear', async () => {
            const result = await this.request('/memory/clear', {})
            if (!this.alive) return
            this.applyState(result.state)
            this.setState({ notice: t.cleared })
          })
        }

        t() {
          return DICT[this.state.lang] || DICT.en
        }

        render() {
          let t
          try {
            t = this.t()
            return this.renderBody(t)
          } catch (error) {
            const fallbackT = DICT.en
            const message = error && error.message ? error.message : String(error)
            const stack = error && error.stack ? String(error.stack).split('\n').slice(0, 8).join('\n') : ''
            const text = fallbackT.crash + '\n' + message + (stack === '' ? '' : '\n' + stack)
            return h('div', { className: 'dshp' }, [
              h('style', { key: 'css' }, CSS),
              h('div', { className: 'dshp-msg dshp-err', key: 'msg' }, fallbackT.crash),
              h('pre', { className: 'dshp-pre', key: 'pre' }, text),
              h('div', { className: 'dshp-row', key: 'row' }, [
                h('button', {
                  key: 'retry',
                  type: 'button',
                  className: 'dshp-btn',
                  onClick: () => this.load(),
                }, fallbackT.retry),
              ]),
            ])
          }
        }

        renderBody(t) {
          const { data, draft, busy, error, notice, force } = this.state
          const busyAny = busy !== ''
          const persona = data && data.personality ? data.personality : null
          const presets = data && Array.isArray(data.presets) ? data.presets : []
          const stats = data && data.stats ? data.stats : null
          const sessions = data && Array.isArray(data.sessions) ? data.sessions : []

          const field = (label, key, input) => h('label', { className: 'dshp-field', key: key }, [
            h('span', { className: 'dshp-label', key: 'l' }, label),
            React.cloneElement(input, { key: 'i' }),
          ])

          const presetNodes = presets.map((preset) => h('button', {
            key: 'preset-' + preset.id,
            type: 'button',
            className: 'dshp-preset',
            disabled: busyAny,
            onClick: () => { this.applyPreset(preset) },
          }, [
            h('div', { className: 'dshp-preset-name', key: 'n' }, String(preset.label || preset.id)),
            h('div', { className: 'dshp-preset-hint', key: 'h' }, String(preset.hint || '')),
          ]))

          const sessionNodes = sessions.length === 0
            ? [h('div', { className: 'dshp-empty', key: 'empty' }, t.noSessions)]
            : sessions.map((item) => h('div', { className: 'dshp-item', key: 'session-' + item.sessionId }, [
              h('div', { className: 'dshp-item-title', key: 't' }, [
                h('span', { key: 'title' }, String(item.title || item.sessionId || '')),
                h('span', {
                  key: 'time',
                  style: { fontWeight: 400, color: 'var(--dsw-alias-label-secondary)', fontSize: '11.5px' },
                }, formatTime(item.summarizedAt)),
              ]),
              item.summary ? h('div', { className: 'dshp-item-body', key: 'b' }, String(item.summary)) : null,
              Array.isArray(item.keyPoints) && item.keyPoints.length > 0
                ? h('div', { className: 'dshp-chips', key: 'c' }, item.keyPoints.map((point, index) => h('span', {
                  className: 'dshp-chip',
                  key: 'p' + index,
                }, String(point))))
                : null,
            ]))

          return h('div', { className: 'dshp' }, [
            h('style', { key: 'css' }, CSS),
            h('div', { key: 'head' }, [
              h('h1', { className: 'dshp-h1', key: 't' }, t.title),
              h('p', { className: 'dshp-desc', key: 'd' }, t.desc),
            ]),
            error ? h('div', { className: 'dshp-msg dshp-err', key: 'err', style: { whiteSpace: 'pre-wrap' } }, error) : null,
            notice ? h('div', { className: 'dshp-msg dshp-ok', key: 'ok' }, notice) : null,
            h('div', { className: 'dshp-card', key: 'presets' }, [
              h('div', { className: 'dshp-card-head', key: 'h' }, [
                h('div', { className: 'dshp-card-title', key: 't' }, t.presetTitle),
                h('div', { className: 'dshp-card-sub', key: 's' }, t.presetDesc),
              ]),
              h('div', { className: 'dshp-presets', key: 'g' }, presetNodes),
            ]),
            h('div', { className: 'dshp-card', key: 'edit' }, [
              h('div', { className: 'dshp-card-title', key: 't' }, t.editTitle),
              field(t.nameLabel, 'name', h('input', {
                className: 'dshp-input',
                type: 'text',
                value: draft.name,
                placeholder: t.namePlaceholder,
                maxLength: 40,
                onChange: (event) => this.setState({
                  draft: { ...this.state.draft, name: event.target.value },
                }),
              })),
              field(t.identityLabel, 'identity', h('textarea', {
                className: 'dshp-textarea',
                value: draft.identity,
                placeholder: t.identityPlaceholder,
                rows: 2,
                onChange: (event) => this.setState({
                  draft: { ...this.state.draft, identity: event.target.value },
                }),
              })),
              field(t.styleLabel, 'style', h('textarea', {
                className: 'dshp-textarea',
                value: draft.style,
                placeholder: t.stylePlaceholder,
                rows: 3,
                onChange: (event) => this.setState({
                  draft: { ...this.state.draft, style: event.target.value },
                }),
              })),
              field(t.rulesLabel, 'rules', h('textarea', {
                className: 'dshp-textarea',
                value: draft.rules,
                placeholder: t.rulesPlaceholder,
                rows: 5,
                onChange: (event) => this.setState({
                  draft: { ...this.state.draft, rules: event.target.value },
                }),
              })),
              h('div', { className: 'dshp-row', key: 'actions' }, [
                h('button', {
                  key: 'save',
                  type: 'button',
                  className: 'dshp-btn dshp-btn-primary',
                  disabled: busyAny,
                  onClick: () => { this.save() },
                }, t.save),
                h('button', {
                  key: 'reload',
                  type: 'button',
                  className: 'dshp-btn',
                  disabled: busyAny,
                  onClick: () => { this.reload() },
                }, t.reload),
                h('span', { key: 'hint', className: 'dshp-meta' }, t.hint),
              ]),
            ]),
            h('div', { className: 'dshp-card', key: 'memory' }, [
              h('div', { className: 'dshp-card-head', key: 'h' }, [
                h('div', { className: 'dshp-card-title', key: 't' }, t.memoryTitle),
                h('div', { className: 'dshp-card-sub', key: 's' }, t.memoryDesc),
              ]),
              h('div', { className: 'dshp-counts', key: 'counts' }, [
                h('span', { key: 's' }, t.sessionsCount(stats ? stats.sessionSummaries : 0)),
                h('span', { key: 'm' }, t.memoriesCount(stats ? stats.memories : 0)),
              ]),
              h('div', { className: 'dshp-row', key: 'actions' }, [
                h('button', {
                  key: 'summarize',
                  type: 'button',
                  className: 'dshp-btn dshp-btn-primary',
                  disabled: busyAny,
                  onClick: () => { this.summarize() },
                }, busy === 'summarize' ? t.summarizing : t.summarize),
                h('label', {
                  key: 'force',
                  className: 'dshp-meta',
                  style: { display: 'flex', alignItems: 'center', gap: '6px' },
                }, [
                  h('input', {
                    key: 'cb',
                    type: 'checkbox',
                    checked: force,
                    onChange: (event) => this.setState({ force: event.target.checked }),
                  }),
                  h('span', { key: 'l' }, t.force),
                ]),
                h('button', {
                  key: 'clear',
                  type: 'button',
                  className: 'dshp-btn dshp-btn-danger',
                  disabled: busyAny,
                  onClick: () => { this.clearMemory() },
                }, t.clear),
              ]),
              h('div', { className: 'dshp-list', key: 'list' }, sessionNodes),
              stats
                ? h('div', { className: 'dshp-meta', key: 'dir' }, t.dataDir + '：' + String(stats.dataDir || ''))
                : null,
            ]),
            data === null && busy === 'load'
              ? h('div', { className: 'dshp-empty', key: 'loading' }, t.loading)
              : null,
            data === null && busy === '' && error !== ''
              ? h('div', { className: 'dshp-row', key: 'retry' }, [
                h('button', {
                  key: 'btn',
                  type: 'button',
                  className: 'dshp-btn',
                  onClick: () => { this.load() },
                }, t.retry),
              ])
              : null,
          ])
        }
      }

      return PersonalitySection
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Best-effort: publish the strings through the client locale service so
        // other surfaces can name this section in the user's language.
        try {
          const locale = ctx ? ctx.locale : undefined
          if (locale && typeof locale.register === 'function') {
            locale.register('dsh-personality', 'zh', DICT.zh)
            locale.register('dsh-personality', 'en', DICT.en)
          }
        } catch {
          /* the local dictionary remains the source of truth */
        }

        const Section = createSection(ctx)
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-personality',
          order: 60,
          label: () => labelFor(detectLang(ctx)),
        }, Section))

        // Second surface: the same page on this bundle's own page in the
        // Plugins section, keyed by the package name. One of the two is always
        // reachable, so the settings stay editable even if a host build stops
        // rendering third-party settings sections.
        try {
          ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
            name: 'plugins.bundle.config',
            key: 'dsh-personality',
            order: 10,
          }, Section))
        } catch (error) {
          /* the settings section above is the primary surface */
        }
      },
    }
  },
})
