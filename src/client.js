/** Official Antigravity ACP settings. React and the authenticated remote gateway are provided by DSH. */
window.__ModuleLoader__.load({
  id: 'dsh-bundle-antigravity-official-acp',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    /* @include client-i18n/en-ui.js */
    /* @include client-i18n/en-host.js */
    /* @include client-i18n/core.js */
    const PROVIDER = 'antigravity-acp'
    /** Settings namespace projected from Config's volatile fields in src/settings.ts. */
    const ENTRY_ID = 'llm-antigravity-acp'
    /** Live fields owned by this card; ordinary fields stay in the host config editor. */
    const FIELDS = [
      { key: 'reuseSessions', group: 'general', checkbox: true, defaultChecked: true, label: msg('复用 ACP 会话'), hint: msg('只发送新增消息；上下文不一致时自动重建。') },
      { key: 'resumeSessions', group: 'advanced', checkbox: true, label: msg('重启后恢复 ACP 会话'), hint: msg('需开启会话复用；恢复失败时自动重建。') },
      { key: 'keepProcessAfterCancel', group: 'advanced', checkbox: true, label: msg('取消后保留进程'), hint: msg('仅在官方进程确认停止后保留。') },
      { key: 'cancelGraceMs', group: 'advanced', numeric: true, defaultValue: 30000, min: 0, max: 60000, label: msg('取消确认宽限（毫秒）'), hint: msg('0 表示立即回收。') },
      { key: 'idleRecycleMs', group: 'advanced', numeric: true, defaultValue: 300000, min: 0, max: 3600000, label: msg('进程空闲回收（毫秒）'), hint: msg('默认 5 分钟；0 表示禁用。') },
    ]
    const OVERRIDES_KEY = 'modelOverrides'
    const OVERRIDES_LABEL = msg('模型列表设置')
    const EFFORT_OPTIONS = [
      { value: '', label: msg('跟随官方') },
      { value: 'low', label: msg('低') },
      { value: 'medium', label: msg('中') },
      { value: 'high', label: msg('高') },
    ]
    const EFFORT_IDS = new Set(EFFORT_OPTIONS.map((entry) => entry.value).filter(Boolean))
    const MODALITY_LABELS = { text: msg('文本'), image: msg('图片'), audio: msg('音频'), video: msg('视频'), file: msg('文件') }

    /** 只保留有意义的字段：启用是默认值，空串等于未设置。 */
    function canonicalOverride(row) {
      const source = row && typeof row === 'object' ? row : {}
      const result = {}
      if (source.enabled === false) result.enabled = false
      if (EFFORT_IDS.has(source.effort)) result.effort = source.effort
      const name = typeof source.name === 'string' ? source.name.trim() : ''
      if (name) result.name = name
      const target = typeof source.target === 'string' ? source.target.trim() : ''
      if (target) result.target = target
      return result
    }
    /** 稳定序列化：键序不影响脏值判断。 */
    function canonicalOverrides(value) {
      const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
      const result = Object.create(null)
      for (const key of Object.keys(source).sort()) {
        const row = canonicalOverride(source[key])
        if (Object.keys(row).length > 0) result[key] = row
      }
      return result
    }
    function sameOverrides(a, b) {
      return JSON.stringify(canonicalOverrides(a)) === JSON.stringify(canonicalOverrides(b))
    }
    function overrideFor(overrides, id) {
      const row = overrides && Object.hasOwn(overrides, id) ? overrides[id] : undefined
      return row && typeof row === 'object' ? row : {}
    }
    /** 目录条目 + 已配置但当前目录没有的 ID，都要能在此编辑。 */
    function modelRows(models, overrides) {
      const rows = models.map(({ id, name, inputModalities, contextWindow, maxOutputTokens }) => ({ id, name, inputModalities, contextWindow, maxOutputTokens, inCatalog: true }))
      const known = new Set(rows.map((row) => row.id))
      for (const id of Object.keys(canonicalOverrides(overrides))) {
        if (!known.has(id)) rows.push({ id, name: id, inCatalog: false })
      }
      return rows
    }

    function unwrap(result) {
      if (result && typeof result === 'object' && 'ok' in result) {
        if (result.ok) return result.value
        throw new Error(t(result.error?.message) || t('未知错误'))
      }
      return result
    }

    const RUNTIME_PHASES = {
      idle: msg('尚未启动'), binary: msg('准备运行文件'), spawn: msg('启动进程'),
      initialize: msg('等待握手'), authenticate: msg('等待登录'), ready: msg('连接就绪'), connection: msg('准备连接'),
      session: msg('建立会话'), model: msg('选择模型'), prompt: msg('等待模型首块'), streaming: msg('正在输出'),
      'waiting-tools': msg('等待 DSH 工具结果'), continuing: msg('等待工具后的回复'), recycling: msg('回收进程'),
      stopped: msg('已停止'), error: msg('连接异常'), disposed: msg('插件已卸载'),
    }
    const phaseName = (phase) => t(RUNTIME_PHASES[phase] ?? phase)
    function runtimeBusy(runtime) {
      if (runtime?.queue && (runtime.queue.active > 0 || runtime.queue.parked > 0 || runtime.queue.waiting > 0)) return true
      return runtime && !['idle', 'ready', 'stopped', 'error', 'disposed'].includes(runtime.phase)
    }
    function duration(ms) {
      if (!Number.isFinite(ms)) return '—'
      if (ms < 1000) return Math.round(ms) + ' ms'
      if (ms < 60000) return (ms / 1000).toFixed(2) + ' s'
      return t('{minutes} 分 {seconds} 秒', { minutes: Math.floor(ms / 60000), seconds: Math.floor(ms % 60000 / 1000) })
    }
    /** 连接中且进程仍在启动时，给出阶段、已用时间与冷启动提示（官方进程冷启动可达 1 分钟）。 */
    function startupHint(account) {
      const runtime = account?.runtime
      if (account?.state !== 'connecting' || !runtime || !['binary', 'spawn', 'initialize', 'authenticate', 'session'].includes(runtime.phase)) return undefined
      const slow = ['spawn', 'initialize'].includes(runtime.phase) ? t('；官方进程冷启动首次可能需要约 1 分钟，请耐心等待') : ''
      return t('{phase}… 已用 {time}{slow}', { phase: phaseName(runtime.phase), time: duration(runtime.phaseElapsedMs), slow })
    }
    function connectionStatus(account, registered) {
      const runtime = account?.runtime
      const ready = runtime?.phase === 'ready'
      const busy = runtimeBusy(runtime) || ['connecting', 'cancelling'].includes(account?.state)
      const error = account?.state === 'error' || runtime?.phase === 'error' || registered === false
      const label = t(registered === false ? 'Provider 未注册'
        : error ? '连接需要检查'
          : busy ? account?.state === 'cancelling' ? '正在取消连接' : '正在准备连接'
            : ready ? 'ACP 已连接'
              : account?.state === 'cancelled' || runtime?.phase === 'stopped' ? '连接已停止'
                : account?.state === 'connected' ? '账户已验证' : '尚未验证连接')
      const description = account?.runtime?.phase === 'stopped'
        ? t('ACP 连接已停止。')
        : account?.runtime?.phase === 'error'
          ? t(account.runtime.error ?? account?.message ?? 'ACP 连接异常，请重试。')
          : registered === false ? t('请确认插件已启用，Host 与 Client 均已加载。')
            : startupHint(account) ?? t(account?.message ?? '连接后可读取模型目录，不发送聊天消息。')
      return { label, description, ready, busy, error, color: error ? '#d97757' : ready ? '#25b879' : busy ? '#d99b28' : '#8b909a' }
    }
    function StatusDot({ color }) {
      return h('span', { 'aria-hidden': true, style: { width: '8px', height: '8px', flex: '0 0 auto', borderRadius: '50%', background: color, boxShadow: '0 0 0 4px rgba(128,128,128,.10)' } })
    }
    function StatusNotice({ status }) {
      if (!status) return null
      const error = status.kind === 'error'
      return h('p', { role: error ? 'alert' : 'status', style: { margin: 0, padding: '10px 12px', borderRadius: '10px', borderLeft: '3px solid ' + (error ? '#e5534b' : status.kind === 'busy' ? '#d99b28' : '#25b879'), fontSize: '12px', lineHeight: 1.6, overflowWrap: 'anywhere', color: 'inherit', background: error ? 'rgba(217,119,87,.10)' : status.kind === 'busy' ? 'rgba(217,155,40,.10)' : 'rgba(37,184,121,.10)' } }, t(status.text))
    }
    function RuntimeDetails({ runtime }) {
      if (!runtime) return null
      const row = (label, value) => h('div', { key: label, style: { display: 'flex', justifyContent: 'space-between', gap: '16px' } },
        h('span', { style: { opacity: .65 } }, label), h('span', { style: { textAlign: 'right', fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' } }, value))
      const round = runtime.round
      const queue = runtime.queue
      return h('div', { 'aria-label': t('ACP 生命周期与计时'), style: { display: 'grid', gap: '8px', fontSize: '12px', lineHeight: 1.5 } },
        row(t('当前状态'), phaseName(runtime.phase) + ' · ' + duration(runtime.phaseElapsedMs)),
        queue ? row(t('会话调度'), t('运行 {active} · 等待工具 {parked} · 排队 {waiting}', queue)) : null,
        queue ? row(t('并发连接'), queue.workers + ' / ' + queue.capacity) : null,
        runtime.processRunning ? row(t('进程已运行'), duration(runtime.uptimeMs)) : null,
        row(t('进程统计'), t('启动 {starts} · 复用 {reuses} · 回收 {recycles}', runtime)),
        runtime.startup ? row(t('最近启动总耗时'), duration(runtime.startup.elapsedMs)) : null,
        ...Object.entries(runtime.startup?.timings ?? {}).map(([name, ms]) => row(phaseName(name), duration(ms))),
        round ? row(t('当前 / 最近回合'), round.model + ' · ' + duration(round.elapsedMs)) : null,
        ...Object.entries(round?.timings ?? {}).map(([name, ms]) => row(phaseName(name), duration(ms))),
        round?.firstChunkMs !== undefined ? row(t('发送 prompt → 首块'), duration(round.firstChunkMs)) : null,
        round?.firstToolMs !== undefined ? row(t('发送 prompt → 首个工具'), duration(round.firstToolMs)) : null,
        round?.continuations ? row(t('工具续轮'), t('{count} 次 · 最近 {last}', { count: round.continuations, last: duration(round.lastContinuationMs) })) : null,
        runtime.error ? h('p', { role: 'alert', style: { margin: '4px 0 0', color: '#b42318', overflowWrap: 'anywhere' } }, t(runtime.error)) : null)
    }
    function SectionHeading({ title, action }) {
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' } },
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('h3', { style: { fontSize: '14px', lineHeight: 1.4, fontWeight: 650, margin: 0 } }, title)),
        action ?? null)
    }
    function TextField({ field, value, disabled, invalid, onChange }) {
      const inputId = 'agy-setting-' + (React.useId?.() ?? field.key) + '-' + field.key
      return h('div', { style: { display: 'grid', gap: '4px', minWidth: 0 } },
        h('label', { htmlFor: inputId, style: { fontSize: '12px', fontWeight: 550 } }, t(field.label)),
        h('input', {
          id: inputId, name: field.key, type: field.numeric ? 'number' : 'text',
          ...(field.numeric ? { min: field.min, max: field.max, step: 1 } : {}),
          disabled, value: value ?? '', placeholder: t(field.placeholder),
          'aria-invalid': invalid || undefined, 'aria-describedby': field.hint ? inputId + '-hint' : undefined,
          style: { ...ACTION, cursor: disabled ? 'not-allowed' : 'text', width: '100%', boxSizing: 'border-box', background: 'rgba(128,128,128,.035)', opacity: disabled ? .6 : 1 },
          onChange: (event) => onChange(field.numeric && event.target.value !== '' ? Number(event.target.value) : event.target.value),
        }),
        field.hint ? h('small', { id: inputId + '-hint', style: { fontSize: '10px', lineHeight: 1.45, opacity: .58 } }, t(field.hint)) : null)
    }
    function SwitchField({ field, checked, disabled, onChange }) {
      return h('label', { style: { display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: disabled ? 'default' : 'pointer', padding: '2px 0', opacity: disabled ? .6 : 1 } },
        h('input', { name: field.key, type: 'checkbox', checked: checked === true, disabled, onChange: (event) => onChange(event.target.checked), style: { width: '16px', height: '16px', flex: '0 0 auto', margin: '1px 0 0', accentColor: '#177c55', cursor: disabled ? 'not-allowed' : 'pointer' } }),
        h('span', { style: { display: 'grid', gap: '2px', minWidth: 0 } },
          h('span', { style: { fontSize: '12px', fontWeight: 550 } }, t(field.label)),
          field.hint ? h('small', { style: { fontSize: '10px', lineHeight: 1.45, opacity: .6 } }, t(field.hint)) : null))
    }
    function SettingsFields({ fields, draft, dirtyKeys, conflicts, disabled, editField }) {
      const numericGrid = fields.length > 1 && fields.every((field) => field.numeric)
      return h('div', { style: { display: 'grid', gap: '12px', gridTemplateColumns: numericGrid ? 'repeat(auto-fit, minmax(180px, 1fr))' : undefined } }, ...fields.map((field) => {
        const onChange = (value) => editField(field.key, value)
        return field.checkbox
          ? h(SwitchField, { key: field.key, field, checked: draft[field.key], disabled, onChange })
          : h(TextField, { key: field.key, field, value: draft[field.key], disabled, invalid: dirtyKeys.includes(field.key) && field.numeric && !Number.isSafeInteger(draft[field.key]), onChange })
      }))
    }
    function SettingsGroup({ title, fields, fieldProps, open = false }) {
      return h('details', { style: PANEL, 'aria-label': t('{title}设置', { title }), open: open || undefined },
        h('summary', { style: SUMMARY },
          h('span', { style: { fontSize: '12px', fontWeight: 650 } }, title),
          h('small', { style: { fontSize: '10px', opacity: .55 } }, t('{count} 项', { count: fields.length }))),
        h('div', { style: { marginTop: '14px', paddingTop: '12px', borderTop: '1px solid rgba(128,128,128,.12)' } },
          h(SettingsFields, { ...fieldProps, fields })))
    }

    /** 紧凑列表行；完整 ID、输入能力、改名和映射集中在单条详情里。 */
    function ModelOverrideRow({ row, override, disabled, onEdit }) {
      const enabled = override.enabled !== false
      const inputId = 'agy-model-' + row.id.replace(/[^\w.-]/g, '_')
      const labelStyle = { fontSize: '11px', opacity: .6 }
      const inputStyle = { ...ACTION, width: '100%', minWidth: 0, boxSizing: 'border-box', background: 'rgba(128,128,128,.035)', cursor: disabled ? 'not-allowed' : 'text' }
      const displayName = override.name?.trim() || row.name
      return h('div', { role: 'listitem', style: { padding: '9px 0', borderBottom: '1px solid rgba(128,128,128,.12)', opacity: enabled ? 1 : .58 } },
        h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'center', gap: '8px' } },
          h('label', { title: displayName, style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, cursor: disabled ? 'default' : 'pointer' } },
            h('input', { name: 'model-enabled-' + row.id, type: 'checkbox', checked: enabled, disabled,
              onChange: (event) => onEdit(row.id, { enabled: event.target.checked }),
              style: { width: '15px', height: '15px', flex: '0 0 auto', margin: 0, accentColor: '#177c55', cursor: disabled ? 'not-allowed' : 'pointer' } }),
            h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px', fontWeight: 600 } }, displayName)),
          h('label', { htmlFor: inputId + '-effort', style: { display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px' } },
            h('span', { style: { opacity: .65 } }, t('思考')),
            h('select', { id: inputId + '-effort', name: 'model-effort-' + row.id, disabled, value: EFFORT_IDS.has(override.effort) ? override.effort : '',
              'aria-label': t('{name} 默认思考档位', { name: displayName }),
              onChange: (event) => onEdit(row.id, { effort: event.target.value }),
              style: { ...inputStyle, width: 'auto', minHeight: '29px', padding: '3px 7px', cursor: disabled ? 'not-allowed' : 'pointer' } },
              ...EFFORT_OPTIONS.map((option) => h('option', { key: option.value, value: option.value }, t(option.label)))))),
        h('details', { style: { marginLeft: '23px', marginTop: '5px' } },
          h('summary', { style: { ...SUMMARY, justifyContent: 'flex-start', fontSize: '10px', opacity: .6 } }, t('模型设置')),
          h('div', { style: { display: 'grid', gap: '10px', marginTop: '10px', padding: '10px', borderRadius: '8px', background: 'rgba(128,128,128,.04)' } },
            h('div', { style: { display: 'grid', gap: '3px' } },
              h('span', { style: labelStyle }, t('模型 ID')),
            h('code', { style: { fontSize: '10px', overflowWrap: 'anywhere', opacity: .75 } }, row.id),
            row.inCatalog ? h('span', { style: labelStyle }, Number.isSafeInteger(row.contextWindow)
              ? t('上下文窗口 {tokens} tokens（上游容量）', { tokens: row.contextWindow.toLocaleString() })
              : t('上下文窗口：尚未观测')) : null,
            Number.isSafeInteger(row.maxOutputTokens) ? h('span', { style: labelStyle }, t('输出上限 {tokens} tokens', { tokens: row.maxOutputTokens.toLocaleString() })) : null),
            h('div', { style: { display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' } },
              h('div', { style: { display: 'grid', gap: '4px', minWidth: 0 } },
                h('label', { htmlFor: inputId + '-name', style: labelStyle }, t('显示名')),
                h('input', { id: inputId + '-name', name: 'model-name-' + row.id, type: 'text', disabled, value: override.name ?? '',
                  placeholder: row.name, onChange: (event) => onEdit(row.id, { name: event.target.value }), style: inputStyle })),
              h('div', { style: { display: 'grid', gap: '4px', minWidth: 0 } },
                h('label', { htmlFor: inputId + '-target', style: labelStyle }, t('官方模型 ID')),
                h('input', { id: inputId + '-target', name: 'model-target-' + row.id, type: 'text', disabled, value: override.target ?? '',
                  placeholder: t('留空自动路由'), onChange: (event) => onEdit(row.id, { target: event.target.value }), style: inputStyle }))),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 12px', fontSize: '10px', opacity: .6 } },
              h('span', null, t(row.inCatalog ? '当前目录' : '不在当前目录')),
              Array.isArray(row.inputModalities) && row.inputModalities.length
                ? h('span', null, row.inputModalities.map((modality) => t(MODALITY_LABELS[modality] ?? modality)).join(' · ')) : null))))
    }

    function ModelOverrideList({ rows, overrides, disabled, onEdit }) {
      const [query, setQuery] = React.useState('')
      const [filter, setFilter] = React.useState('all')
      if (rows.length === 0) {
        return h('p', { role: 'status', style: { margin: 0, fontSize: '12px', lineHeight: 1.5, opacity: .6 } }, t('暂无模型。请先连接当前账户，再刷新目录。'))
      }
      const hidden = rows.filter((row) => overrideFor(overrides, row.id).enabled === false).length
      const keyword = query.trim().toLowerCase()
      const visible = rows.filter((row) => {
        const override = overrideFor(overrides, row.id)
        if (filter === 'enabled' && override.enabled === false) return false
        if (filter === 'hidden' && override.enabled !== false) return false
        return !keyword || (row.name + ' ' + row.id + ' ' + (override.name ?? '')).toLowerCase().includes(keyword)
      })
      const setVisible = (enabled) => { for (const row of visible) onEdit(row.id, { enabled }) }
      return h('div', { style: { display: 'grid', gap: '8px' } },
        h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '8px' } },
          h('input', { type: 'search', value: query, onChange: (event) => setQuery(event.target.value), placeholder: t('搜索模型'), 'aria-label': t('搜索模型'),
            style: { ...ACTION, width: '100%', minWidth: 0, boxSizing: 'border-box', cursor: 'text' } }),
          h('select', { value: filter, onChange: (event) => setFilter(event.target.value), 'aria-label': t('筛选模型'), style: ACTION },
            h('option', { value: 'all' }, t('全部 {count}', { count: rows.length })),
            h('option', { value: 'enabled' }, t('已启用 {count}', { count: rows.length - hidden })),
            h('option', { value: 'hidden' }, t('已隐藏 {count}', { count: hidden })))),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '10px', opacity: .7 } },
          h('span', { style: { marginRight: 'auto' } }, t('显示 {shown} / {total}', { shown: visible.length, total: rows.length })),
          h('button', { type: 'button', disabled: disabled || visible.length === 0, onClick: () => setVisible(true), style: { ...ACTION, minHeight: '26px', padding: '2px 7px', fontSize: '10px' } }, t('全部启用')),
          h('button', { type: 'button', disabled: disabled || visible.length === 0, onClick: () => setVisible(false), style: { ...ACTION, minHeight: '26px', padding: '2px 7px', fontSize: '10px' } }, t('全部隐藏'))),
        hidden === rows.length
          ? h('p', { role: 'status', style: { margin: 0, fontSize: '11px', lineHeight: 1.5, color: '#946200' } }, t('全部隐藏后，Antigravity 将从模型选择器消失。'))
          : null,
        visible.length
          ? h('div', { role: 'list', style: { display: 'grid' } }, ...visible.map((row) => h(ModelOverrideRow, {
            key: row.id, row, override: overrideFor(overrides, row.id), disabled, onEdit,
          })))
          : h('p', { role: 'status', style: { margin: 0, fontSize: '12px', opacity: .6 } }, t('没有符合条件的模型。')))
    }

    function AntigravitySettingsCard(props) {
      const remote = props.remote
      const [account, setAccount] = React.useState(undefined)
      const [models, setModels] = React.useState([])
      const [modelBusy, setModelBusy] = React.useState(false)
      const [modelMessage, setModelMessage] = React.useState('')
      const alive = React.useRef(true)
      const modelVersion = React.useRef(0)
      const accountVersion = React.useRef(0)
      const polling = React.useRef(false)
      const manualModelPull = React.useRef(false)
      const pullModels = React.useCallback(async (force = false) => {
        if (!props.control || manualModelPull.current) return
        if (force) manualModelPull.current = true
        const version = ++modelVersion.current
        setModelBusy(true)
        if (force) setModelMessage(t('正在拉取模型目录…'))
        try {
          const value = unwrap(await props.control('models', force ? { force: true } : undefined))
          if (!alive.current || version !== modelVersion.current) return
          setModels(value.models ?? [])
          setModelMessage(value.status === 'error' ? t(value.message) : '')
        } catch (error) { if (alive.current && version === modelVersion.current) setModelMessage(error instanceof Error ? error.message : String(error)) }
        finally {
          if (force) manualModelPull.current = false
          if (alive.current && version === modelVersion.current) setModelBusy(false)
        }
      }, [props.control])
      const accountAction = React.useCallback(async (action = 'status') => {
        if (!props.control) return
        if (action === 'status' && polling.current) return
        polling.current = true
        const version = ++accountVersion.current
        try {
          const value = unwrap(await props.control('account', { action }))
          if (alive.current && version === accountVersion.current) setAccount(value)
        } catch (error) { if (alive.current && version === accountVersion.current) setAccount({ state: 'error', message: error instanceof Error ? error.message : String(error) }) }
        finally { polling.current = false }
      }, [props.control])
      React.useEffect(() => {
        alive.current = true
        void accountAction('status')
        void pullModels(false)
        return () => { alive.current = false; ++modelVersion.current; ++accountVersion.current }

      }, [accountAction, pullModels])
      const connecting = account?.state === 'connecting' || account?.state === 'cancelling'
      React.useEffect(() => {
        if (!connecting) return
        const timer = setInterval(() => { void accountAction('status') }, 1500)
        return () => clearInterval(timer)
      }, [connecting, accountAction])
      React.useEffect(() => {
        if (account?.state === 'connected') void pullModels(false)
      }, [account?.state, pullModels])
      const [view, setView] = React.useState(undefined)
      const [registered, setRegistered] = React.useState(undefined)
      const [draft, setDraft] = React.useState({})
      const [status, setStatus] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [writable, setWritable] = React.useState(false)
      const [saving, setSaving] = React.useState(false)
      const [dirtyKeys, setDirtyKeys] = React.useState([])
      const [conflicts, setConflicts] = React.useState([])
      const [settingsPage, setSettingsPage] = React.useState('connection')
      const settingsVersion = React.useRef(0)
      const savingRef = React.useRef(false)
      const refreshAfterSave = React.useRef(false)
      const baseline = React.useRef({})
      const dirty = React.useRef(new Set())
      const draftRef = React.useRef(draft)
      draftRef.current = draft
      const editField = React.useCallback((key, value) => {
        if (savingRef.current) return
        const next = { ...draftRef.current, [key]: value }
        draftRef.current = next
        if (value === baseline.current[key]) dirty.current.delete(key)
        else dirty.current.add(key)
        setDirtyKeys([...dirty.current])
        setConflicts((previous) => previous.filter((field) => field !== key))
        setDraft(next)
      }, [])

      /**
       * 单条模型设置：合并成整份 modelOverrides 再交给通用编辑路径，
       * 这样草稿、冲突与只提交改动项的行为和其它字段完全一致。
       */
      const editOverride = React.useCallback((id, patch) => {
        if (savingRef.current) return
        const current = overrideFor(draftRef.current[OVERRIDES_KEY], id)
        const merged = canonicalOverride({ ...current, ...patch })
        const overrides = canonicalOverrides(draftRef.current[OVERRIDES_KEY])
        if (Object.keys(merged).length === 0) delete overrides[id]
        else overrides[id] = merged
        const value = overrides
        const next = { ...draftRef.current, [OVERRIDES_KEY]: value }
        draftRef.current = next
        if (sameOverrides(value, baseline.current[OVERRIDES_KEY])) dirty.current.delete(OVERRIDES_KEY)
        else dirty.current.add(OVERRIDES_KEY)
        setDirtyKeys([...dirty.current])
        setConflicts((previous) => previous.filter((field) => field !== OVERRIDES_KEY))
        setDraft(next)
      }, [])

      const reload = React.useCallback(async (preserveStatus = false) => {
        const version = ++settingsVersion.current
        // 同步段整体兜底：remote.<ns> 是代理属性，缺 inject 时连「读属性」都会抛；
        // 这里降级为卡片内可读错误，绝不让异常穿出组件击穿 settings.section。
        try {
          if (!remote?.settings?.describe) {
            setStatus({ kind: 'error', text: t('宿主未提供 settings.describe，无法在此编辑配置') })
            setLoading(false)
            return
          }
          setLoading(true)
          const described = Promise.resolve(remote.settings.describe()).then(unwrap)
          const providers = Promise.resolve(remote.llm?.listProviders?.())
            .then((value) => unwrap(value))
            .catch(() => [])
            .then((rows) => (Array.isArray(rows) ? rows : []))
          const [settings, rows] = await Promise.all([described, providers])
          if (!alive.current || version !== settingsVersion.current) return
          const namespaces = Array.isArray(settings?.namespaces) ? settings.namespaces : []
          // Apply changes only to this component's namespace and revision.
          const found = namespaces.find((item) => item?.ns === ENTRY_ID)
          setView(found ?? null)
          const current = found?.value && typeof found.value === 'object' ? found.value : {}
          const server = Object.fromEntries(FIELDS.map((field) => [field.key, field.checkbox
            ? (field.defaultChecked ? current[field.key] !== false : current[field.key] === true)
            : current[field.key] ?? field.defaultValue ?? '']))
          // 整份 map 作为一个字段参与脏值比较；规范化后再比，避免键序或
          // 「显式写回默认值」被误判为未保存修改。
          server[OVERRIDES_KEY] = canonicalOverrides(current[OVERRIDES_KEY])
          const changed = []
          const next = { ...server }
          for (const key of dirty.current) {
            const same = key === OVERRIDES_KEY
              ? sameOverrides(draftRef.current[key], server[key])
              : draftRef.current[key] === server[key]
            if (same) dirty.current.delete(key)
            else {
              next[key] = draftRef.current[key]
              const beforeSame = key === OVERRIDES_KEY
                ? sameOverrides(baseline.current[key], server[key])
                : baseline.current[key] === server[key]
              if (!beforeSame) changed.push(key)
            }
          }
          baseline.current = server
          draftRef.current = next
          setDraft(next)
          setDirtyKeys([...dirty.current])
          setConflicts((previous) => [...new Set([...previous.filter((key) => dirty.current.has(key)), ...changed])])
          setWritable(settings?.writable === true)
          setRegistered(rows.some((row) => row?.id === PROVIDER))
          if (!found) setStatus({ kind: 'error', text: t('宿主尚未提供 Antigravity ACP 的可编辑设置。请确认 Host 与 Client 插件版本一致，并重新加载插件后刷新配置。') })
          else if (!preserveStatus) setStatus(null)
        } catch (cause) {
          if (alive.current && version === settingsVersion.current) setStatus({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) })
        } finally {
          if (alive.current && version === settingsVersion.current) setLoading(false)
        }
      }, [remote])

      const save = React.useCallback(async () => {
        if (!view || !writable || loading || savingRef.current || dirty.current.size === 0) return
        const invalid = FIELDS.find((field) => field.numeric && dirty.current.has(field.key)
          && (!Number.isSafeInteger(draftRef.current[field.key]) || draftRef.current[field.key] < (field.min ?? 0) || (field.max !== undefined && draftRef.current[field.key] > field.max)))
        if (invalid) {
          setStatus({ kind: 'error', text: invalid.max === undefined
            ? t('{label}必须是不小于 {min} 的整数。', { label: t(invalid.label), min: invalid.min ?? 0 })
            : t('{label}必须是 {min}–{max} 的整数。', { label: t(invalid.label), min: invalid.min, max: invalid.max }) })
          return
        }
        savingRef.current = true
        setSaving(true)
        setStatus({ kind: 'busy', text: t('保存中…') })
        // 只提交用户改动过的字段，空串也是有效改动；未编辑字段遵循最新服务端值。
        // modelOverrides 是整份 map 一个字段，按同样方式提交。
        const ops = [...FIELDS.map((field) => field.key), OVERRIDES_KEY]
          .filter((key) => dirty.current.has(key))
          .map((key) => ({ op: 'set', path: [key], value: draftRef.current[key] }))
        try {
          unwrap(await remote.settings.mutate(ENTRY_ID, ops, view.revision))
          if (!alive.current) return
          for (const operation of ops) {
            const key = operation.path[0]
            if (JSON.stringify(draftRef.current[key]) === JSON.stringify(operation.value)) dirty.current.delete(key)
          }
          setDirtyKeys([...dirty.current])
          setConflicts([])
          setStatus({ kind: 'ok', text: t('设置已保存。') })
          await reload(true)
        } catch (cause) {
          if (!alive.current) return
          setStatus({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) })
          // 修订号冲突时同步新基线，仍保留本地草稿，供用户检查后再次保存。
          await reload(true)
        } finally {
          savingRef.current = false
          if (alive.current) {
            setSaving(false)
            if (refreshAfterSave.current) { refreshAfterSave.current = false; void reload(true) }
          }
        }
      }, [loading, writable, remote, reload, view])

      React.useEffect(() => {
        reload()
        const off = remote?.$on?.('settings/document-updated', (ns) => {
          if (!ns || ns === ENTRY_ID) {
            if (savingRef.current) refreshAfterSave.current = true
            else void reload()
          }
        })
        return () => {
          ++settingsVersion.current
          if (typeof off === 'function') off()
        }
      }, [reload, remote])

      // 目录条目 + 已配置但目录里暂时没有的 ID：正在编辑的映射不能因为目录刷新而消失。
      const rows = modelRows(models, draft[OVERRIDES_KEY])
      const editingDisabled = loading || saving || !view || !writable
      const discardDraft = () => {
        if (savingRef.current) return
        dirty.current.clear()
        draftRef.current = { ...baseline.current }
        setDraft(draftRef.current)
        setDirtyKeys([])
        setConflicts([])
        setStatus({ kind: 'ok', text: t('已撤销未保存修改。') })
      }

      const connection = connectionStatus(account, registered)
      const fieldsFor = (group) => FIELDS.filter((field) => field.group === group)
      const fieldProps = { draft, dirtyKeys, conflicts, disabled: editingDisabled, editField }
      const pageStyle = (id) => ({ display: settingsPage === id ? 'flex' : 'none', flexDirection: 'column', gap: '14px' })
      const pageButton = (id, label) => h('button', {
        type: 'button', role: 'tab', 'aria-selected': settingsPage === id, 'aria-controls': 'agy-settings-page-' + id,
        onClick: () => setSettingsPage(id),
        style: { ...ACTION, minHeight: '32px', padding: '5px 12px', fontWeight: settingsPage === id ? 650 : 450, borderColor: settingsPage === id ? '#177c55' : 'rgba(128,128,128,.22)', background: settingsPage === id ? 'rgba(23,124,85,.12)' : 'transparent' },
      }, label)
      const busy = ['connecting', 'cancelling'].includes(account?.state) || runtimeBusy(account?.runtime)
      const readonly = !loading && view && !writable
      const saveVisible = dirtyKeys.length > 0 || loading || readonly || conflicts.length > 0 || Boolean(status)

      return h('div', { className: 'antigravity-settings-card', style: { padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '760px', boxSizing: 'border-box', lineHeight: 1.5 } },
        h('div', { role: 'region', 'aria-label': t('设置保存操作'), style: { position: 'sticky', top: 0, zIndex: 20, flexShrink: 0, margin: '-6px -6px 0', padding: '6px 0', display: saveVisible ? 'grid' : 'none', gap: '6px', background: 'var(--dsh-surface, Canvas)' } },
          h('div', { style: { display: 'grid', gap: '6px', padding: '10px 12px', borderRadius: '12px', border: '1px solid rgba(128,128,128,.16)', background: 'rgba(128,128,128,.025)' } },
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '7px', alignItems: 'center' } },
            h('button', { type: 'button', onClick: save, disabled: editingDisabled || dirtyKeys.length === 0, style: { ...PRIMARY, minHeight: '30px', padding: '4px 10px' } }, t(saving ? '保存中…' : '保存')),
            dirtyKeys.length ? h('button', { type: 'button', disabled: loading || saving, onClick: discardDraft, style: { ...ACTION, minHeight: '30px', padding: '4px 9px' } }, t('撤销')) : null,
            h('span', { role: 'status', 'aria-live': 'polite', style: { fontSize: '11px', opacity: .7 } }, dirtyKeys.length ? t('{count} 项未保存', { count: dirtyKeys.length }) : loading ? t('正在读取…') : readonly ? t('只读设置') : ''),
            h('button', { type: 'button', title: t('重新读取配置并保留草稿'), disabled: loading || saving, onClick: () => reload(), style: { ...ACTION, minHeight: '30px', padding: '4px 8px', borderColor: 'transparent', background: 'transparent', opacity: .7, marginLeft: 'auto' } }, t(loading ? '刷新中…' : '刷新'))),
          conflicts.length ? h('p', { role: 'alert', style: { margin: 0, fontSize: '12px', lineHeight: 1.5 } }, t('以下内容已在其他位置更新，已保留你的输入：') + conflicts.map((key) => t(key === OVERRIDES_KEY ? OVERRIDES_LABEL : FIELDS.find((field) => field.key === key)?.label ?? key)).join(t('、'))) : null,
          h(StatusNotice, { status }))),

        h('div', { role: 'tablist', 'aria-label': t('设置分页'), style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px' } },
          pageButton('connection', t('连接')),
          pageButton('models', t('模型')),
          pageButton('advanced', t('高级'))),
        h('div', { id: 'agy-settings-page-connection', role: 'tabpanel', style: pageStyle('connection') },
          h('section', { style: PANEL, 'aria-label': t('账户连接') },
              h(SectionHeading, { title: t('ACP 账户与连接') }),
              h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '10px', marginBottom: '12px' } },
                h(StatusDot, { color: connection.color }),
                h('div', { style: { minWidth: 0 } },
                  h('div', { style: { fontSize: '12px', fontWeight: 650, color: connection.color } }, connection.label),
                  h('p', { role: 'status', style: { fontSize: '11px', lineHeight: 1.5, opacity: .7, overflowWrap: 'anywhere', margin: '3px 0 0' } }, connection.description))),
              h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } },
                h('button', { type: 'button', style: PRIMARY, disabled: !props.control || busy, onClick: () => accountAction('login') }, t(account?.state === 'connecting' ? '正在连接…' : '连接 / 登录 ACP')),
                ['connecting', 'cancelling'].includes(account?.state) ? h('button', { type: 'button', style: ACTION, disabled: account?.state === 'cancelling', onClick: () => accountAction('cancel') }, t(account?.state === 'cancelling' ? '正在取消…' : '取消连接')) : null))),

        h('div', { id: 'agy-settings-page-models', role: 'tabpanel', style: pageStyle('models') },
          h('section', { style: PANEL, 'aria-label': t('模型列表') },
            h(SectionHeading, { title: t('模型'),
              action: h('button', { type: 'button', title: t('刷新模型目录'), 'aria-label': t('刷新模型目录'), 'aria-busy': modelBusy || undefined, style: { ...ACTION, flex: '0 0 auto', whiteSpace: 'nowrap' }, disabled: modelBusy || !props.control, onClick: () => pullModels(true) }, t(modelBusy ? '正在刷新…' : '刷新')) }),
            h(ModelOverrideList, { rows, overrides: draft[OVERRIDES_KEY], disabled: editingDisabled, onEdit: editOverride }),
            modelMessage ? h('p', { role: 'status', style: { fontSize: '11px', lineHeight: 1.5, opacity: .65, margin: 0, overflowWrap: 'anywhere' } }, t(modelMessage)) : null)),

        h('div', { id: 'agy-settings-page-advanced', role: 'tabpanel', style: pageStyle('advanced') },
          h('section', { style: PANEL, 'aria-label': t('常用设置') },
            h(SectionHeading, { title: t('会话偏好') }),
            h(SettingsFields, { ...fieldProps, fields: fieldsFor('general') })),
          h(SettingsGroup, { title: t('会话与进程'), fields: fieldsFor('advanced'), fieldProps }),
          h('details', { style: PANEL, 'aria-label': t('连接诊断') },
            h('summary', { style: SUMMARY },
              h('span', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                h(StatusDot, { color: connection.color }),
                h('span', { style: { fontSize: '13px', fontWeight: 650 } }, t('连接诊断'))),
              h('small', { style: { fontSize: '11px', opacity: .6 } }, t('状态、并发与耗时'))),
            h('div', { style: { marginTop: '16px', paddingTop: '14px', borderTop: '1px solid rgba(128,128,128,.14)' } },
              account?.runtime ? RuntimeDetails({ runtime: account.runtime }) : h('p', { style: { margin: 0, fontSize: '12px', opacity: .6 } }, t('连接后显示运行详情。'))))))
    }
    const PANEL = { padding: '14px', borderRadius: '12px', border: '1px solid rgba(128,128,128,.16)', background: 'rgba(128,128,128,.025)' }
    const SUMMARY = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', cursor: 'pointer', listStyle: 'none' }
    const ACTION = { padding: '7px 12px', minHeight: '34px', borderRadius: '8px', border: '1px solid rgba(128,128,128,.22)', background: 'rgba(128,128,128,.06)', color: 'inherit', font: 'inherit', fontSize: '12px', cursor: 'pointer' }
    const PRIMARY = { ...ACTION, background: '#177c55', border: '1px solid #177c55', color: '#fff', fontWeight: 600 }
    function withTimeout(promise, ms, message) {
      let timer
      return Promise.race([
        Promise.resolve(promise),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(message)), ms)
        }),
      ]).finally(() => clearTimeout(timer))
    }
    function makeControlReader(scope) {
      return async (method, request) => {
        if (!['account', 'models'].includes(method)) throw new Error(t('不支持的设置操作'))
        const deadline = Date.now() + 20_000
        for (;;) {
          const service = scope.get('remote.agyAcp')
          if (typeof service?.[method] === 'function') {
            const pending = service[method](request)
            // 目录发现可能包含冷启动；各阶段超时由 Host 管理，客户端不另设更短的总期限。
            return method === 'models' ? await pending : await withTimeout(pending, 60_000, t('设置操作超时，请重试'))
          }
          if (Date.now() >= deadline) throw new Error(t('设置控制服务未就绪，请确认 Host 与 Client 版本一致'))
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      }
    }

    const PACKAGE = 'dsh-bundle-antigravity-official-acp'
    const SERVICE = 'agyAcp'
    function codec(symbol, parse) {
      return { mode: 'strict', typeSymbol: PACKAGE + '#' + symbol, create: () => ({ parse }) }
    }
    function record(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    }
    const accountRequest = codec('AgYAcpAccountRequest', (value) => {
      if (value === undefined) return { action: 'status' }
      if (!record(value) || !['status', 'login', 'cancel'].includes(value.action)) throw new TypeError('Invalid ACP account action')
      return { action: value.action }
    })
    const modelsRequest = codec('AgYAcpModelsRequest', (value) => {
      if (value === undefined) return {}
      if (!record(value)) throw new TypeError('Invalid ACP model request')
      if (!('force' in value)) return {}
      if (typeof value.force !== 'boolean') throw new TypeError('Invalid ACP model refresh')
      return { force: value.force }
    })
    const accountResult = codec('AgYAcpAccountResult', (value) => {
      if (!record(value) || !['idle', 'connecting', 'cancelling', 'connected', 'cancelled', 'error'].includes(value.state) || typeof value.message !== 'string') throw new TypeError('Invalid ACP connection result')
      return value
    })
    const modelsResult = codec('AgYAcpModelsResult', (value) => {
      if (!record(value) || !['ok', 'error'].includes(value.status) || !Array.isArray(value.models)) throw new TypeError('Invalid ACP model result')
      return value
    })
    const descriptors = [
      ['account', accountRequest, accountResult],
      ['models', modelsRequest, modelsResult],
    ].map(([method, request, result]) => ({
      id: PACKAGE + '#' + SERVICE + '/' + method, service: SERVICE, namespace: SERVICE, method,
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: true, codec: request }],
      result,
    }))

    return {
      name: PACKAGE,
      inject: ['slots', 'remote', 'remote.settings', 'remote.llm'],
      apply(ctx) {
        ctx.effect(() => ctx.remote.$mount({ package: PACKAGE, descriptors }), 'antigravity-acp: settings remote')
        const control = makeControlReader(ctx)
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: PROVIDER,
          order: 42,
          label: () => 'Antigravity ACP',
          inject: () => ({ remote: ctx.remote, control }),
        }, AntigravitySettingsCard)), 'antigravity-acp: settings section')
      },
    }
  },
})
