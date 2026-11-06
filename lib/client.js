/* dsh-vision — settings surface.
 * Browser half of the plugin: a single settings.section card that shows the
 * live state of the vision bridge and lets the operator drive it.
 * Loaded as a lazy CJS module by the DSH client module loader.
 */
window.__ModuleLoader__.load({
  id: 'dsh-vision',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    // The host module loader hands every client plugin a `require`; React is one
    // of the shared externals. Without this binding every React.createElement
    // call below throws and the card silently never renders.
    let React = null
    try {
      React = require('react')
    } catch (error) {
      console.error('[dsh-vision] react is not reachable from the client module: ' + String(error))
    }

    const API = {
      state: '/dsh-vision/state',
      config: '/dsh-vision/config',
      models: '/dsh-vision/models',
      probe: '/dsh-vision/probe',
      reset: '/dsh-vision/stats/reset',
      clearLog: '/dsh-vision/log/clear',
      restart: '/dsh-vision/restart',
      customModels: '/dsh-vision/custom-models',
      hostModels: '/dsh-vision/host-models',
      detect: '/dsh-vision/detect'
    }

    // ------------------------------------------------------------------ util

    function readJson(res) {
      return res
        .json()
        .catch(() => ({}))
        .then((body) => {
          if (!res.ok || body.ok === false) {
            throw new Error(body && body.error ? body.error : 'HTTP ' + res.status)
          }
          return body
        })
    }

    function apiGet(path) {
      return fetch(path, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' }
      }).then(readJson)
    }

    function apiPost(path, payload) {
      return fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(payload === undefined ? {} : payload)
      }).then(readJson)
    }

    function errorText(error) {
      if (error instanceof Error) return error.message
      return String(error)
    }

    function fmtTime(value) {
      if (!value) return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return '—'
      const pad = (n) => String(n).padStart(2, '0')
      return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
    }

    function fmtDay(value) {
      if (!value) return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return '—'
      const pad = (n) => String(n).padStart(2, '0')
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    }

    function fmtBytes(bytes) {
      const n = Number(bytes) || 0
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB'
      return (n / 1024 / 1024).toFixed(1) + ' MB'
    }

    function fmtMs(ms) {
      const n = Number(ms) || 0
      if (n < 1000) return n + ' ms'
      return (n / 1000).toFixed(1) + ' s'
    }

    function sameRoutes(a, b) {
      const left = JSON.stringify(a || [])
      const right = JSON.stringify(b || [])
      return left === right
    }

    // ------------------------------------------------------------------ style

    const C = {
      text: 'var(--dsw-alias-label-primary, #1f2328)',
      sub: 'var(--dsw-alias-label-tertiary, #6b7280)',
      line: 'var(--dsw-alias-border-l2, #e5e7eb)',
      soft: 'var(--dsw-alias-bg-layer-3, #f6f7f8)',
      accent: 'var(--dsw-alias-label-primary, #2563eb)',
      ok: '#15803d',
      okBg: 'rgba(21,128,61,0.10)',
      warn: '#b45309',
      warnBg: 'rgba(180,83,9,0.10)',
      bad: '#b42318',
      badBg: 'rgba(180,35,24,0.10)',
      placeholder: '#9ca3af',
      trackOff: '#94a3b8',
      trackOn: '#16a34a',
      knob: '#ffffff',
      knobShadow: '0 1px 3px rgba(16,24,40,0.35), 0 0 0 0.5px rgba(16,24,40,0.10)',
      inset: 'inset 0 1px 2px rgba(16,24,40,0.18)',
      radius: 10
    }

    // The shell swaps its --dsw-alias-* variables between themes, but a few
    // surfaces (status text, switch track, knob shadow) need real values.
    // Detect the theme from the page background instead of guessing at an
    // attribute name, and repaint the palette in place so the next render of
    // every component picks the new colours up.
    function detectDark() {
      try {
        const body = document.body
        if (!body) return false
        const raw = window.getComputedStyle(body).backgroundColor || ''
        const match = /rgba?\(([^)]+)\)/.exec(raw)
        if (match) {
          const parts = match[1].split(',').map((value) => Number.parseFloat(value))
          const [r, g, b] = parts
          if ([r, g, b].every((value) => Number.isFinite(value))) {
            const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
            return luminance < 0.5
          }
        }
      } catch (error) {
        /* fall through to the media query */
      }
      try {
        return window.matchMedia('(prefers-color-scheme: dark)').matches === true
      } catch (error) {
        return false
      }
    }

    function applyTheme() {
      const dark = detectDark()
      C.ok = dark ? '#4ade80' : '#15803d'
      C.okBg = dark ? 'rgba(74,222,128,0.16)' : 'rgba(21,128,61,0.10)'
      C.warn = dark ? '#fbbf24' : '#b45309'
      C.warnBg = dark ? 'rgba(251,191,36,0.16)' : 'rgba(180,83,9,0.10)'
      C.bad = dark ? '#f87171' : '#b42318'
      C.badBg = dark ? 'rgba(248,113,113,0.16)' : 'rgba(180,35,24,0.10)'
      C.placeholder = dark ? '#6b7280' : '#9ca3af'
      C.trackOff = dark ? '#475569' : '#94a3b8'
      C.trackOn = dark ? '#22c55e' : '#16a34a'
      C.knob = dark ? '#f8fafc' : '#ffffff'
      C.knobShadow = dark
        ? '0 1px 3px rgba(0,0,0,0.55), 0 0 0 0.5px rgba(255,255,255,0.16)'
        : '0 1px 3px rgba(16,24,40,0.35), 0 0 0 0.5px rgba(16,24,40,0.10)'
      C.inset = dark ? 'inset 0 1px 2px rgba(0,0,0,0.45)' : 'inset 0 1px 2px rgba(16,24,40,0.18)'
      applyShellSwitchStyle(dark)
      return dark
    }

    // The shell's own <Switch> (role="switch") paints its OFF track with
    // --dsw-alias-border-l3, which is #0000001f in the light theme and
    // #ffffff29 in the dark one, and its thumb with --dsw-alias-switch-thumb.
    // On a card background that reads as one white pill, so every plugin row
    // and every settings toggle looks like it has no state. Give it the same
    // contrast as the switches inside our own card, scoped to the shell's
    // markup only (our own switches carry data-dsh-vision and are untouched).
    const SWITCH_STYLE_ID = 'dsh-vision-shell-switch'
    let lastSwitchCss = ''

    function applyShellSwitchStyle(dark) {
      try {
        const trackOff = dark ? '#475569' : '#cbd5e1'
        const trackOn = dark ? '#22c55e' : '#16a34a'
        const knob = dark ? '#f8fafc' : '#ffffff'
        const shadow = dark
          ? '0 1px 3px rgba(0,0,0,0.55)'
          : '0 1px 3px rgba(16,24,40,0.35)'
        const scope = '[role="switch"]:not([data-dsh-vision])'
        const css =
          scope + '[aria-checked="false"]{background:' + trackOff + ' !important;}' +
          scope + '[aria-checked="true"]{background:' + trackOn + ' !important;}' +
          scope + '>span{background:' + knob + ' !important;box-shadow:' + shadow + ' !important;}'
        if (css === lastSwitchCss) return
        lastSwitchCss = css
        let element = document.getElementById(SWITCH_STYLE_ID)
        if (!element) {
          element = document.createElement('style')
          element.id = SWITCH_STYLE_ID
          document.head.appendChild(element)
        }
        element.textContent = css
      } catch (error) {
        /* a stylesheet is a nicety, never break the panel over it */
      }
    }

    applyTheme()

    const S = {
      card: {
        border: '1px solid ' + C.line,
        borderRadius: 12,
        padding: '14px 16px',
        marginBottom: 12,
        background: 'transparent',
        minWidth: 0,
        boxSizing: 'border-box',
        transition: 'border-color 160ms ease, background 160ms ease'
      },
      rowBetween: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 12,
        minWidth: 0
      },
      sectionTitle: {
        fontSize: 13,
        fontWeight: 600,
        color: C.text,
        letterSpacing: '0.01em',
        margin: 0
      },
      sectionDesc: {
        margin: '4px 0 0',
        fontSize: 12,
        lineHeight: '18px',
        color: C.sub
      },
      label: { fontSize: 12.5, color: C.text, fontWeight: 500 },
      hint: { fontSize: 11.5, color: C.sub, lineHeight: '16px', marginTop: 2 },
      input: {
        width: '100%',
        minWidth: 0,
        boxSizing: 'border-box',
        padding: '7px 9px',
        fontSize: 12.5,
        color: C.text,
        background: 'transparent',
        border: '1px solid ' + C.line,
        borderRadius: 8,
        outline: 'none',
        transition: 'border-color 140ms ease, box-shadow 140ms ease',
        fontFamily: 'inherit'
      },
      select: {
        width: '100%',
        minWidth: 0,
        boxSizing: 'border-box',
        padding: '7px 9px',
        fontSize: 12.5,
        color: C.text,
        background: 'transparent',
        border: '1px solid ' + C.line,
        borderRadius: 8,
        outline: 'none',
        fontFamily: 'inherit'
      },
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        minHeight: 62,
        padding: '7px 9px',
        fontSize: 12.5,
        lineHeight: '18px',
        color: C.text,
        background: 'transparent',
        border: '1px solid ' + C.line,
        borderRadius: 8,
        outline: 'none',
        resize: 'vertical',
        fontFamily: 'inherit'
      },
      btn: {
        padding: '6px 12px',
        fontSize: 12.5,
        fontWeight: 500,
        whiteSpace: 'nowrap',
        flex: '0 0 auto',
        color: C.text,
        background: 'transparent',
        border: '1px solid ' + C.line,
        borderRadius: 8,
        cursor: 'pointer',
        transition: 'background 140ms ease, border-color 140ms ease, opacity 140ms ease',
        fontFamily: 'inherit'
      },
      btnPrimary: {
        padding: '6px 14px',
        fontSize: 12.5,
        fontWeight: 600,
        color: '#fff',
        background: 'var(--dsw-alias-label-primary, #2563eb)',
        border: '1px solid transparent',
        borderRadius: 8,
        cursor: 'pointer',
        transition: 'opacity 140ms ease, transform 140ms ease',
        fontFamily: 'inherit'
      },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 6px 3px 9px',
        fontSize: 12,
        color: C.text,
        background: C.soft,
        border: '1px solid ' + C.line,
        borderRadius: 999,
        lineHeight: '18px',
        maxWidth: '100%',
        minWidth: 0,
        boxSizing: 'border-box'
      },
      chipX: {
        border: 0,
        background: 'transparent',
        color: C.sub,
        cursor: 'pointer',
        fontSize: 13,
        lineHeight: '14px',
        padding: '0 2px',
        transition: 'color 120ms ease'
      }
    }

    function badge(kind, text, title) {
      const tone =
        kind === 'ok'
          ? { color: C.ok, background: C.okBg }
          : kind === 'warn'
            ? { color: C.warn, background: C.warnBg }
            : kind === 'bad'
              ? { color: C.bad, background: C.badBg }
              : { color: C.sub, background: C.soft }
      return React.createElement(
        'span',
        {
          title: title || undefined,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '1px 7px',
            fontSize: 11,
            fontWeight: 600,
            borderRadius: 999,
            whiteSpace: 'nowrap',
            ...tone
          }
        },
        text
      )
    }

    function dot(color, pulse) {
      return React.createElement('span', {
        style: {
          display: 'inline-block',
          width: 7,
          height: 7,
          borderRadius: 999,
          background: color,
          marginRight: 6,
          boxShadow: pulse ? '0 0 0 3px ' + color + '22' : 'none',
          transition: 'box-shadow 240ms ease'
        }
      })
    }

    function Toggle(props) {
      const on = props.checked === true
      const disabled = props.disabled === true
      // Colours come from C so a light/dark switch repaints them on the next
      // render; --dsw-alias-border-l2 is a near-white hairline and made the
      // "off" state indistinguishable from the card background.
      const knobLeft = on ? 21 : 3
      return React.createElement(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 7, flex: '0 0 auto' } },
        React.createElement(
          'button',
          {
            type: 'button',
            role: 'switch',
            'aria-checked': on ? 'true' : 'false',
            'data-dsh-vision': 'true',
            'aria-label': props.label || undefined,
            disabled: disabled,
            onClick: () => {
              if (!disabled) props.onChange(!on)
            },
            style: {
              position: 'relative',
              flex: '0 0 auto',
              width: 42,
              height: 23,
              padding: 0,
              border: 0,
              borderRadius: 999,
              cursor: disabled ? 'not-allowed' : 'pointer',
              background: on ? C.trackOn : C.trackOff,
              boxShadow: C.inset,
              opacity: disabled ? 0.45 : 1,
              transition: 'background 180ms cubic-bezier(.4,0,.2,1)'
            }
          },
          React.createElement('span', {
            style: {
              position: 'absolute',
              top: 2.5,
              left: knobLeft,
              width: 18,
              height: 18,
              borderRadius: 999,
              background: C.knob,
              boxShadow: C.knobShadow,
              transition: 'left 180ms cubic-bezier(.4,0,.2,1)'
            }
          })
        ),
        React.createElement(
          'span',
          {
            style: {
              fontSize: 12,
              fontWeight: 500,
              minWidth: 14,
              color: on ? C.trackOn : C.sub
            }
          },
          on ? '开' : '关'
        )
      )
    }

    function Segmented(props) {
      const options = props.options || []
      return React.createElement(
        'div',
        {
          style: {
            display: 'inline-flex',
            padding: 2,
            gap: 2,
            background: C.soft,
            border: '1px solid ' + C.line,
            borderRadius: 9
          }
        },
        options.map((option) =>
          React.createElement(
            'button',
            {
              key: option.value,
              type: 'button',
              onClick: () => props.onChange(option.value),
              title: option.title || undefined,
              style: {
                padding: '4px 10px',
                fontSize: 12,
                fontWeight: props.value === option.value ? 600 : 500,
                color: props.value === option.value ? C.text : C.sub,
                background: props.value === option.value ? 'var(--dsw-alias-bg-layer-3, #fff)' : 'transparent',
                border: 0,
                borderRadius: 7,
                cursor: 'pointer',
                transition: 'color 160ms ease, background 160ms ease',
                fontFamily: 'inherit'
              }
            },
            option.label
          )
        )
      )
    }

    function Field(props) {
      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 } },
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
          React.createElement('span', { style: S.label }, props.label),
          props.restart ? badge('warn', '需重启', '这一项在启动时固化，改完要重启 DSH') : null,
          props.hot === false ? null : null
        ),
        props.children,
        props.hint ? React.createElement('div', { style: S.hint }, props.hint) : null
      )
    }

    function Section(props) {
      const [open, setOpen] = React.useState(props.defaultOpen !== false)
      const collapsible = props.collapsible === true
      return React.createElement(
        'div',
        { style: S.card },
        React.createElement(
          'div',
          { style: S.rowBetween },
          React.createElement(
            'div',
            { style: { minWidth: 0 } },
            React.createElement(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              React.createElement('h3', { style: S.sectionTitle }, props.title),
              props.badge || null
            ),
            props.desc ? React.createElement('p', { style: S.sectionDesc }, props.desc) : null
          ),
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' } },
            props.right || null,
            collapsible
              ? React.createElement(
                  'button',
                  {
                    type: 'button',
                    onClick: () => setOpen(!open),
                    'aria-expanded': open ? 'true' : 'false',
                    style: {
                      ...S.btn,
                      padding: '3px 8px',
                      fontSize: 12,
                      color: C.sub
                    }
                  },
                  open ? '收起' : '展开'
                )
              : null
          )
        ),
        React.createElement(
          'div',
          {
            style: {
              display: 'grid',
              gridTemplateRows: collapsible ? (open ? '1fr' : '0fr') : '1fr',
              transition: 'grid-template-rows 220ms cubic-bezier(.4,0,.2,1)'
            }
          },
          React.createElement(
            'div',
            { style: { overflow: 'hidden', minHeight: 0 } },
            React.createElement('div', { style: { paddingTop: 12 } }, collapsible && !open ? null : props.children)
          )
        )
      )
    }

    function Stat(props) {
      return React.createElement(
        'div',
        { style: { minWidth: 0 } },
        React.createElement(
          'div',
          { style: { fontSize: 17, fontWeight: 600, color: C.text, letterSpacing: '-0.01em' } },
          props.value
        ),
        React.createElement('div', { style: { fontSize: 11.5, color: C.sub, marginTop: 1 } }, props.label)
      )
    }

    // -------------------------------------------------------------- the panel

    const KEYS = [
      'enabled',
      'route',
      'fallbackEnabled',
      'fallbacks',
      'transport',
      'customRoutes',
      'timeoutMs',
      'maxImageBytes',
      'maxImages',
      'promptPrefix',
      'defaultTask',
      'taskTemplates',
      'verbosity',
      'recordLog',
      'logLimit'
    ]

    const TASK_LABELS = [
      { value: 'describe', label: '通用描述' },
      { value: 'text', label: '纯文字转写' },
      { value: 'ui', label: '界面截图' },
      { value: 'chart', label: '图表读数' },
      { value: 'diff', label: '多图对比' },
      { value: 'question', label: '定向提问' },
      { value: 'auto', label: '自动（模型自己写指令）' }
    ]

    function pick(config) {
      const out = {}
      for (const key of KEYS) out[key] = config[key]
      return out
    }

    function Panel() {
      const [state, setState] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [loadError, setLoadError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [message, setMessage] = React.useState(null)
      const [probe, setProbe] = React.useState(null)
      const [addingFallback, setAddingFallback] = React.useState('')
      const [restarting, setRestarting] = React.useState(false)
      const [newRoute, setNewRoute] = React.useState({ name: '', label: '', baseUrl: '', model: '', apiKey: '', apiKeyRef: '' })
      const [modelChoices, setModelChoices] = React.useState([])
      const [direct, setDirect] = React.useState([])
      const [detecting, setDetecting] = React.useState('')
      const [modelBusy, setModelBusy] = React.useState(false)
      const [editing, setEditing] = React.useState('')
      const [expanded, setExpanded] = React.useState('')
      const [editTask, setEditTask] = React.useState('describe')

      // Follow the shell's light/dark mode. The palette is repainted in place
      // and a state bump forces every subcomponent to re-read it.
      const [, setThemeTick] = React.useState(0)
      React.useEffect(() => {
        const repaint = () => {
          applyTheme()
          setThemeTick((value) => value + 1)
        }
        repaint()
        let media = null
        try {
          media = window.matchMedia('(prefers-color-scheme: dark)')
          if (media && typeof media.addEventListener === 'function') media.addEventListener('change', repaint)
        } catch (error) {
          media = null
        }
        let observer = null
        try {
          if (typeof MutationObserver === 'function' && document.documentElement) {
            observer = new MutationObserver(repaint)
            observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
          }
        } catch (error) {
          observer = null
        }
        return () => {
          try {
            if (media && typeof media.removeEventListener === 'function') media.removeEventListener('change', repaint)
          } catch (error) {
            /* ignore */
          }
          if (observer) observer.disconnect()
        }
      }, [])

      function applyState(next) {
        setState(next)
        setDraft(pick(next.config))
        setDirect(Array.isArray(next.directModels) ? next.directModels : [])
      }

      function refresh() {
        setBusy('load')
        return apiGet(API.state)
          .then((next) => {
            applyState(next)
            setLoadError('')
          })
          .catch((error) => setLoadError(errorText(error)))
          .finally(() => setBusy(''))
      }

      React.useEffect(() => {
        refresh()
      }, [])

      React.useEffect(() => {
        if (!message) return undefined
        const timer = setTimeout(() => setMessage(null), 6000)
        return () => clearTimeout(timer)
      }, [message])

      if (loadError !== '' && state === null) {
        return React.createElement(
          'div',
          { style: S.card },
          React.createElement('h3', { style: S.sectionTitle }, '视觉'),
          React.createElement('p', { style: S.sectionHint || S.hint }, '读取状态失败：' + loadError),
          React.createElement('button', { type: 'button', onClick: refresh, style: S.btn }, '重试')
        )
      }

      if (state === null || draft === null) {
        return React.createElement(
          'div',
          { style: { ...S.card, color: C.sub, fontSize: 12.5 } },
          '正在读取视觉插件状态…'
        )
      }

      const config = state.config
      const stats = state.stats
      const models = Array.isArray(state.models) ? state.models : []
      const customRoutes = Array.isArray(draft.customRoutes) ? draft.customRoutes : []
      const hostModels = models.filter((model) => model.custom !== true)
      const customModels = models.filter((model) => model.custom === true)
      const dirty = JSON.stringify(pick(config)) !== JSON.stringify(draft)
      const providerMounted = state.provider !== undefined && state.provider.mounted === true
      const providerRow = React.createElement(
        'div',
        { style: { ...S.hint, marginTop: 2 } },
        providerMounted
          ? '已注册到模型选择：dsh-vision/* 会出现在 DSH 的模型列表里（可直接选来对话，也能原生收图）'
          : '未注册到模型选择' +
              (state.provider !== undefined && state.provider.error ? '（' + String(state.provider.error).slice(0, 120) + '）' : '')
      )
      const running = config.enabled === true && state.services.llm === true
      const routeChoices = models.map((model) => ({
        value: model.route,
        label: model.custom === true ? model.route + ' · 自定义' : model.route
      }))
      const otherChoices = (Array.isArray(state.otherModels) ? state.otherModels : []).map((model) => ({
        value: model.route,
        label: model.route
      }))

      // 一个下拉里分两组：先自动发现的视觉模型，再其余模型（未声明图片输入，选了就是强制尝试）。
      function renderRouteGroups(primary, secondary, isHidden, selected) {
        const keep = (list) => list.filter((choice) => !isHidden(choice.value))
        const first = keep(primary)
        const second = keep(secondary)
        const nodes = []
        nodes.push(
          React.createElement(
            'option',
            { key: '__auto', value: '' },
            '自动选择（用宿主已声明的第一条视觉模型）'
          )
        )
        if (selected && !first.some((choice) => choice.value === selected) && !second.some((choice) => choice.value === selected)) {
          nodes.push(React.createElement('option', { key: '__current', value: selected }, selected + '（当前值，未在列表里）'))
        }
        if (first.length > 0) {
          nodes.push(
            React.createElement(
              'optgroup',
              { key: 'vision', label: '自动发现 · 声明支持图片（' + first.length + '）' },
              first.map((choice) => React.createElement('option', { key: choice.value, value: choice.value }, choice.label))
            )
          )
        }
        if (second.length > 0) {
          nodes.push(
            React.createElement(
              'optgroup',
              { key: 'rest', label: '其余模型 · 未声明图片输入，选了就是强制尝试（' + second.length + '）' },
              second.map((choice) => React.createElement('option', { key: choice.value, value: choice.value }, choice.label))
            )
          )
        }
        return nodes
      }

      function patch(update) {
        setDraft({ ...draft, ...update })
      }

      function save() {
        setBusy('save')
        setMessage(null)
        apiPost(API.config, { patch: draft })
          .then((body) => {
            applyState(body.state || { config: body.config })
            if (Array.isArray(body.dropped) && body.dropped.length > 0) {
              setMessage({ kind: 'warn', text: '已保存，忽略未知项：' + body.dropped.join('、') })
            } else {
              setMessage({ kind: 'ok', text: '已保存 · 配置立即生效，下一次读图就用新设置' })
            }
          })
          .catch((error) => setMessage({ kind: 'bad', text: '保存失败：' + errorText(error) }))
          .finally(() => setBusy(''))
      }

      function runProbe() {
        setBusy('probe')
        setProbe(null)
        setMessage(null)
        apiPost(API.probe, {})
          .then((body) => {
            setProbe(body)
            setMessage(
              body.matched
                ? { kind: 'ok', text: '自检通过 · ' + body.route + ' · ' + fmtMs(body.ms) }
                : { kind: 'warn', text: '自检未通过 · 模型回答与图片颜色不符' }
            )
            refresh()
          })
          .catch((error) => setMessage({ kind: 'bad', text: '自检失败：' + errorText(error) }))
          .finally(() => setBusy(''))
      }

      function resetStats() {
        setBusy('reset')
        apiPost(API.reset, {})
          .then(() => {
            setMessage({ kind: 'ok', text: '统计已清零' })
            return refresh()
          })
          .catch((error) => setMessage({ kind: 'bad', text: errorText(error) }))
          .finally(() => setBusy(''))
      }

      function clearLog() {
        setBusy('log')
        apiPost(API.clearLog, {})
          .then(() => {
            setMessage({ kind: 'ok', text: '调用明细已清空' })
            return refresh()
          })
          .catch((error) => setMessage({ kind: 'bad', text: errorText(error) }))
          .finally(() => setBusy(''))
      }

      function restartApp() {
        if (restarting) return
        const ok =
          typeof window === 'undefined' ||
          typeof window.confirm !== 'function' ||
          window.confirm('重启 DeepSeek Harness？应用会关闭并在约 3 秒后自动重新打开，当前会话会被恢复。')
        if (!ok) return
        setRestarting(true)
        setMessage({ kind: 'warn', text: '正在重启应用…' })
        apiPost(API.restart, {})
          .then(() => {
            setMessage({ kind: 'ok', text: '重启指令已发出，应用马上会关闭。' })
          })
          .catch((error) => {
            setRestarting(false)
            setMessage({ kind: 'bad', text: '重启失败：' + errorText(error) })
          })
      }

      function addFallback() {
        const route = addingFallback
        if (route === '') return
        const list = Array.isArray(draft.fallbacks) ? draft.fallbacks.slice() : []
        if (!list.includes(route)) list.push(route)
        patch({ fallbacks: list })
        setAddingFallback('')
      }

      function removeFallback(index) {
        const list = (draft.fallbacks || []).slice()
        list.splice(index, 1)
        patch({ fallbacks: list })
      }

      function moveFallback(index, delta) {
        const list = (draft.fallbacks || []).slice()
        const target = index + delta
        if (target < 0 || target >= list.length) return
        const moved = list.splice(index, 1)[0]
        list.splice(target, 0, moved)
        patch({ fallbacks: list })
      }

      function fetchCustomModels() {
        const baseUrl = newRoute.baseUrl.trim()
        if (baseUrl === '') {
          setMessage({ kind: 'warn', text: '先填接口地址，才能去上游拉模型列表' })
          return
        }
        setModelBusy(true)
        setMessage(null)
        apiPost(API.customModels, { baseUrl, apiKey: newRoute.apiKey, apiKeyRef: newRoute.apiKeyRef.trim() })
          .then((body) => {
            const list = Array.isArray(body.models) ? body.models : []
            if (body.ok !== true || list.length === 0) {
              setModelChoices([])
              setMessage({ kind: 'warn', text: '没拿到模型列表：' + (body.error || '上游没有返回 data 数组') })
              return
            }
            setModelChoices(list)
            if (list.length === 1) setNewRoute({ ...newRoute, model: list[0] })
            setMessage({ kind: 'ok', text: '拿到 ' + list.length + ' 个模型，从下拉里选一个' })
          })
          .catch((error) => setMessage({ kind: 'bad', text: '获取失败：' + errorText(error) }))
          .finally(() => setModelBusy(false))
      }

      function detectOne(route) {
        setDetecting(route)
        return apiPost(API.detect, { route })
          .then((body) => {
            if (body.ok !== true) {
              setMessage({ kind: 'warn', text: '检测没跑通：' + (body.error || '未知原因') })
              return false
            }
            const canSee = body.matched === true
            setDirect((list) =>
              list.map((item) =>
                item.route === route
                  ? { ...item, tested: canSee, answer: body.answer || '', testedAt: Date.now() }
                  : item
              )
            )
            setMessage({
              kind: canSee ? 'ok' : 'warn',
              text: canSee
                ? route + ' 能看图（回答：' + (body.answer || '').slice(0, 40) + '）'
                : route + ' 看不到图（回答：' + ((body.answer || '没有文字').slice(0, 40)) + '）'
            })
            return canSee
          })
          .catch((error) => {
            setMessage({ kind: 'bad', text: '检测失败：' + errorText(error) })
            return false
          })
          .finally(() => setDetecting(''))
      }

      function detectAll() {
        setBusy('detect')
        setMessage(null)
        const queue = direct.filter((item) => item.tested !== true)
        const step = (index) => {
          if (index >= queue.length) {
            setBusy('')
            return Promise.resolve()
          }
          return detectOne(queue[index].route).then(() => step(index + 1))
        }
        return step(0)
      }

      function addCustomRoute() {
        const entry = {
          name: newRoute.name.trim().toLowerCase(),
          label: newRoute.label.trim(),
          baseUrl: newRoute.baseUrl.trim(),
          model: newRoute.model.trim(),
          apiKey: newRoute.apiKey,
          apiKeyRef: newRoute.apiKeyRef.trim()
        }
        if (entry.name === '' || entry.baseUrl === '' || entry.model === '') {
          setMessage({ kind: 'warn', text: '自定义 API 需要填 名称 / 接口地址 / 模型名' })
          return
        }
        const list = customRoutes.slice()
        const existing = list.findIndex((item) => item.name === entry.name)
        if (existing >= 0) list[existing] = { ...list[existing], ...entry }
        else list.push(entry)
        patch({ customRoutes: list })
        setNewRoute({ name: '', label: '', baseUrl: '', model: '', apiKey: '', apiKeyRef: '' })
        setEditing('')
        setMessage({ kind: 'ok', text: '已加入草稿，点保存后生效' })
      }

      function removeCustomRoute(name) {
        patch({ customRoutes: customRoutes.filter((item) => item.name !== name) })
      }

      const statsRow = React.createElement(
        'div',
        {
          style: {
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(104px, 1fr))',
            gap: 10,
            marginTop: 12
          }
        },
        React.createElement(Stat, { value: String(stats.calls), label: '累计调用' }),
        React.createElement(Stat, {
          value: stats.successRate === null ? '—' : String(stats.successRate) + '%',
          label: '成功率 · 均 ' + fmtMs(stats.averageMs)
        }),
        React.createElement(Stat, { value: fmtBytes(stats.totalBytes), label: '累计图片' }),
        React.createElement(Stat, {
          value: stats.lastOkAt ? fmtTime(stats.lastOkAt) : '—',
          label: '最近成功'
        })
      )

      const header = React.createElement(
        'div',
        { style: S.card },
        React.createElement(
          'div',
          { style: S.rowBetween },
          React.createElement(
            'div',
            { style: { minWidth: 0 } },
            React.createElement(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              dot(running ? C.ok : config.enabled ? C.warn : C.placeholder, running),
              React.createElement('h3', { style: { ...S.sectionTitle, fontSize: 14 } }, '视觉'),
              badge(running ? 'ok' : config.enabled ? 'warn' : 'mute', running ? '运行中' : config.enabled ? '服务未就绪' : '已停用'),
              dirty ? badge('warn', '未保存') : null
            ),
            React.createElement(
              'p',
              { style: S.sectionDesc },
              '主路线 ' + config.route + ' · 工具 ' + config.toolName + ' · ' + models.length + ' 条路线'
            ),
            providerRow
          ),
          React.createElement(
            'div',
            { style: { display: 'flex', gap: 8, flex: '0 0 auto' } },
            React.createElement(
              'button',
              { type: 'button', onClick: refresh, disabled: busy !== '', style: { ...S.btn, opacity: busy === 'load' ? 0.6 : 1 } },
              busy === 'load' ? '刷新中' : '刷新'
            ),
            React.createElement(
              'button',
              { type: 'button', onClick: runProbe, disabled: busy !== '', style: { ...S.btnPrimary, opacity: busy === 'probe' ? 0.7 : 1 } },
              busy === 'probe' ? '自检中…' : '运行自检'
            )
          )
        ),
        statsRow,
        message
          ? React.createElement(
              'div',
              {
                style: {
                  marginTop: 10,
                  padding: '7px 10px',
                  fontSize: 12,
                  borderRadius: 8,
                  color: message.kind === 'bad' ? C.bad : message.kind === 'warn' ? C.warn : C.ok,
                  background: message.kind === 'bad' ? C.badBg : message.kind === 'warn' ? C.warnBg : C.okBg
                }
              },
              message.text
            )
          : null,
        stats.lastError
          ? React.createElement(
              'div',
              { style: { ...S.hint, marginTop: 8, color: C.bad } },
              '上次错误：' + stats.lastError
            )
          : null
      )

      const routing = React.createElement(
        Section,
        {
          title: '路线',
          desc: '主路线负责默认读图；主路线失败时按顺序尝试备用路线。模型来自宿主实时发现，分两组：上面是声明了图片输入的，下面是没声明的（宿主会把图片换成占位符，选了就是强制尝试）。'
        },
        React.createElement(
          'div',
          { style: { display: 'grid', gap: 12 } },
          React.createElement(
            Field,
            { label: '主路线' },
            React.createElement(
              'select',
              {
                style: S.select,
                value: draft.route,
                onChange: (event) => patch({ route: event.target.value })
              },
              renderRouteGroups(routeChoices, otherChoices, () => false, draft.route)
            )
          ),
          React.createElement(
            Field,
            {
              label: '图片传输',
              hint: String(draft.route || '').indexOf('custom/') === 0
                ? '当前主路线是自定义接口，固定走「内联」：插件直接用 HTTP 把图片字节发给对方，没有宿主附件服务可用。'
                : '内联＝图片字节直接随请求发出；附件＝走宿主附件服务；自动＝先内联，失败换另一种。'
            },
            String(draft.route || '').indexOf('custom/') === 0
              ? React.createElement(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                  React.createElement(Segmented, {
                    value: 'inline',
                    options: [{ value: 'inline', label: '内联' }],
                    onChange: () => patch({ transport: 'inline' })
                  }),
                  React.createElement('span', { style: S.hint }, '自定义接口只能内联')
                )
              : React.createElement(Segmented, {
                  value: draft.transport,
                  options: [
                    { value: 'inline', label: '内联' },
                    { value: 'attachment', label: '附件' },
                    { value: 'auto', label: '自动' }
                  ],
                  onChange: (value) => patch({ transport: value })
                })
          ),
          React.createElement(
            'div',
            { style: { ...S.rowBetween, alignItems: 'flex-start' } },
            React.createElement(
              'div',
              null,
              React.createElement('div', { style: S.label }, '启用备用路线'),
              React.createElement('div', { style: S.hint }, '主路线不可用时自动降级，失败原因会写进调用明细。')
            ),
            React.createElement(Toggle, {
              label: '启用备用路线',
              checked: draft.fallbackEnabled !== false,
              onChange: (value) => patch({ fallbackEnabled: value })
            })
          ),
          React.createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            React.createElement('div', { style: S.label }, '备用顺序'),
            customRoutes.length === 0 && models.length === 0
              ? React.createElement('div', { style: S.hint }, '尚未发现可用路线')
              : null,
            React.createElement(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
              (draft.fallbacks || []).length === 0
                ? React.createElement('span', { style: S.hint }, '（空）')
                : (draft.fallbacks || []).map((route, index) =>
                    React.createElement(
                      'span',
                      { key: route, style: S.chip },
                      React.createElement('span', { style: { color: C.sub, fontSize: 11 } }, String(index + 1)),
                      route,
                      React.createElement(
                        'button',
                        {
                          type: 'button',
                          title: '上移（优先级提高）',
                          disabled: index === 0,
                          onClick: () => moveFallback(index, -1),
                          style: { ...S.chipX, opacity: index === 0 ? 0.3 : 1, cursor: index === 0 ? 'default' : 'pointer' }
                        },
                        '↑'
                      ),
                      React.createElement(
                        'button',
                        {
                          type: 'button',
                          title: '下移（优先级降低）',
                          disabled: index === (draft.fallbacks || []).length - 1,
                          onClick: () => moveFallback(index, 1),
                          style: {
                            ...S.chipX,
                            opacity: index === (draft.fallbacks || []).length - 1 ? 0.3 : 1,
                            cursor: index === (draft.fallbacks || []).length - 1 ? 'default' : 'pointer'
                          }
                        },
                        '↓'
                      ),
                      React.createElement(
                        'button',
                        {
                          type: 'button',
                          title: '移除',
                          onClick: () => removeFallback(index),
                          style: S.chipX
                        },
                        '×'
                      )
                    )
                  )
            ),
            React.createElement(
              'div',
              { style: { display: 'flex', gap: 8 } },
              React.createElement(
                'select',
                {
                  style: S.select,
                  value: addingFallback,
                  onChange: (event) => setAddingFallback(event.target.value)
                },
                React.createElement('option', { value: '' }, '从发现的模型里选一条…'),
                renderRouteGroups(
                  routeChoices,
                  otherChoices,
                  (value) => (draft.fallbacks || []).includes(value) || value === draft.route,
                  ''
                )
              ),
              React.createElement(
                'button',
                {
                  type: 'button',
                  onClick: addFallback,
                  disabled: addingFallback === '',
                  style: { ...S.btn, flex: '0 0 auto', opacity: addingFallback === '' ? 0.5 : 1 }
                },
                '添加'
              )
            ),
            React.createElement(
              'div',
              { style: S.hint },
              '共发现 ' + models.length + ' 条可用路线（宿主 ' + hostModels.length + ' 条 · 自定义 ' + customModels.length + ' 条）'
            )
          )
        )
      )

      const templates = draft.taskTemplates || {}
      const defaultTemplates = state.defaultTaskTemplates || {}
      const hostModelsSection = React.createElement(
        Section,
        {
          title: '宿主模型直连探测',
          collapsible: true,
          defaultOpen: false,
          desc:
            '宿主把没声明图片输入的模型一律换成占位符，所以"能不能看图"只能实测：这里直接复用宿主自己的 baseURL 与密钥，' +
            '用一张纯色测试图打一次真请求，回答的颜色对得上才算能看图。测出来的路线可以直接设为主路线，不用手抄地址和密钥。'
        },
        React.createElement(
          'div',
          { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 } },
          React.createElement(
            'button',
            {
              type: 'button',
              disabled: busy !== '' || direct.length === 0,
              style: { ...S.btn, opacity: busy !== '' || direct.length === 0 ? 0.55 : 1 },
              onClick: detectAll
            },
            busy === 'detect' ? '检测中…' : '检测全部（未测过的）'
          ),
          React.createElement(
            'button',
            { type: 'button', disabled: busy !== '', style: { ...S.btn, opacity: busy !== '' ? 0.55 : 1 }, onClick: refresh },
            '刷新列表'
          ),
          React.createElement(
            'span',
            { style: { ...S.hint, alignSelf: 'center' } },
            direct.length + ' 条候选 · ' + direct.filter((item) => item.tested === true).length + ' 条已确认能看图'
          )
        ),
        direct.length === 0
          ? React.createElement(
              'div',
              { style: S.hint },
              '没有从宿主配置里读到 OpenAI 兼容的 provider（需要 baseURL + apiKeyEnv）。'
            )
          : React.createElement(
              'div',
              { style: { maxHeight: 210, overflowY: 'auto', display: 'grid', gap: 6, minWidth: 0 } },
              direct.map((item) =>
                React.createElement(
                  'div',
                  {
                    key: item.route,
                    style: {
                      border: '1px solid ' + C.line,
                      borderRadius: 8,
                      padding: '6px 9px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      flexWrap: 'wrap',
                      minWidth: 0
                    }
                  },
                  React.createElement(
                    'div',
                    { style: { minWidth: 0, flex: '1 1 190px' } },
                    React.createElement(
                      'div',
                      { style: { fontSize: 12, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                      item.model
                    ),
                    React.createElement(
                      'div',
                      { style: { ...S.hint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                      item.provider + ' · ' + (item.keyRef || '无密钥引用') +
                        (item.answer ? ' · 回答 ' + String(item.answer).slice(0, 24) : '')
                    )
                  ),
                  item.tested === true
                    ? badge('ok', '能看图')
                    : item.tested === false
                      ? badge('bad', '看不到')
                      : badge('mute', '未测'),
                  React.createElement(
                    'button',
                    {
                      type: 'button',
                      disabled: detecting !== '',
                      style: { ...S.btn, padding: '3px 9px', fontSize: 12, opacity: detecting !== '' ? 0.5 : 1 },
                      onClick: () => detectOne(item.route)
                    },
                    detecting === item.route ? '检测中…' : '检测'
                  ),
                  React.createElement(
                    'button',
                    {
                      type: 'button',
                      disabled: item.tested !== true,
                      style: { ...S.btn, padding: '3px 9px', fontSize: 12, opacity: item.tested === true ? 1 : 0.5 },
                      onClick: () => patch({ route: item.route })
                    },
                    '设为主路线'
                  )
                )
              )
            )
      )

      const prompts = React.createElement(
        Section,
        {
          title: '提示词',
          desc: '读图的提示词由插件内置，不由调用方临时编写——换模型、换会话，结果的颗粒度都一样。调用方只需选任务，必要时补一句附加要求。',
          collapsible: true,
          defaultOpen: false
        },
        React.createElement(
          'div',
          { style: { display: 'grid', gap: 12 } },
          React.createElement(
            Field,
            { label: '默认任务', hint: '调用方不指定任务时用这一套模板' },
            React.createElement(
              'select',
              {
                style: S.select,
                value: draft.defaultTask,
                onChange: (event) => patch({ defaultTask: event.target.value })
              },
              TASK_LABELS.map((task) =>
                React.createElement('option', { key: task.value, value: task.value }, task.label + ' · ' + task.value)
              )
            )
          ),
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            React.createElement('span', { style: S.label }, '任务模板'),
            React.createElement(
              'select',
              {
                style: { ...S.select, width: 'auto' },
                value: editTask,
                onChange: (event) => setEditTask(event.target.value)
              },
              TASK_LABELS.map((task) => React.createElement('option', { key: task.value, value: task.value }, task.label))
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                style: { ...S.btn, padding: '3px 9px', fontSize: 12 },
                onClick: () => {
                  if (defaultTemplates[editTask] === undefined) return
                  patch({ taskTemplates: { ...templates, [editTask]: defaultTemplates[editTask] } })
                }
              },
              '恢复默认'
            )
          ),
          React.createElement('textarea', {
            style: { ...S.textarea, minHeight: 124 },
            value: templates[editTask] || '',
            placeholder: editTask === 'auto'
              ? 'auto 档没有内置模板：调用方在 prompt 里写完整指令，插件原样发送。'
              : '',
            onChange: (event) => patch({ taskTemplates: { ...templates, [editTask]: event.target.value } })
          }),
          editTask === 'auto'
            ? React.createElement('div', { style: S.hint },
                '选 auto 时调用方自己写提示词（原样发送，不叠加模板）。好处是灵活，代价是不同会话的措辞不稳定——固定场景建议用上面几个内置档。')
            : null,
          React.createElement(
            Field,
            { label: '附加指令', hint: '每次读图都加在最前面；适合固定输出语言或格式' },
            React.createElement('textarea', {
              style: S.textarea,
              value: draft.promptPrefix || '',
              onChange: (event) => patch({ promptPrefix: event.target.value })
            })
          )
        )
      )

      const customSection = React.createElement(
        Section,
        {
          title: '自定义 API',
          desc: '接入宿主不认识的视觉服务：任何兼容 /chat/completions 的接口都行，图片以 base64 内联发出。密钥只存在本机，保存后不再回显。',
          collapsible: true,
          defaultOpen: customRoutes.length > 0,
          badge: customRoutes.length > 0 ? badge('mute', String(customRoutes.length)) : null
        },
        React.createElement(
          'div',
          { style: { display: 'grid', gap: 10 } },
          customRoutes.length === 0
            ? React.createElement('div', { style: S.hint }, '还没有自定义接口。')
            : customRoutes.map((entry) =>
                React.createElement(
                  'div',
                  {
                    key: entry.name,
                    style: {
                      border: '1px solid ' + C.line,
                      borderRadius: 9,
                      padding: '8px 10px',
                      display: 'grid',
                      gap: 6,
                      minWidth: 0
                    }
                  },
                  React.createElement(
                    'div',
                    { style: { ...S.rowBetween, flexWrap: 'wrap', alignItems: 'flex-start', gap: 8 } },
                    React.createElement(
                      'div',
                      { style: { minWidth: 0, flex: '1 1 150px' } },
                      React.createElement(
                        'div',
                        { style: { fontSize: 12.5, fontWeight: 600, color: C.text } },
                        'custom/' + entry.name,
                        React.createElement('span', { style: { ...S.hint, marginLeft: 8 } }, entry.label)
                      ),
                      React.createElement(
                        'div',
                        { style: { ...S.hint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                        entry.baseUrl + ' · ' + entry.model + ' · ' +
                          (entry.apiKeySet ? '密钥已存' : entry.apiKeyRef ? '引用 ' + entry.apiKeyRef + (entry.refFound ? '' : '（未找到）') : '无密钥')
                      )
                    ),
                    React.createElement(
                      'div',
                      { style: { display: 'flex', gap: 6, flex: '0 0 auto', marginLeft: 'auto' } },
                      React.createElement(
                        'button',
                        {
                          type: 'button',
                          style: { ...S.btn, padding: '3px 9px', fontSize: 12 },
                          onClick: () => setEditing(editing === entry.name ? '' : entry.name)
                        },
                        editing === entry.name ? '取消' : '密钥'
                      ),
                      React.createElement(
                        'button',
                        {
                          type: 'button',
                          style: { ...S.btn, padding: '3px 9px', fontSize: 12, color: C.bad },
                          onClick: () => removeCustomRoute(entry.name)
                        },
                        '移除'
                      )
                    )
                  ),
                  editing === entry.name
                    ? React.createElement('input', {
                        style: S.input,
                        type: 'password',
                        placeholder: entry.apiKeySet ? '已存密钥，留空则保持不变' : '粘贴 API Key（可留空）',
                        value: entry.apiKey || '',
                        onChange: (event) => {
                          const list = customRoutes.map((item) =>
                            item.name === entry.name ? { ...item, apiKey: event.target.value } : item
                          )
                          patch({ customRoutes: list })
                        }
                      })
                    : null
                )
              ),
          React.createElement(
            'div',
            {
              style: {
                borderTop: '1px dashed ' + C.line,
                paddingTop: 10,
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                gap: 8,
                minWidth: 0
              }
            },
            React.createElement('input', {
              style: S.input,
              placeholder: '名称（英数，如 my-vl）',
              value: newRoute.name,
              onChange: (event) => setNewRoute({ ...newRoute, name: event.target.value })
            }),
            React.createElement('input', {
              style: S.input,
              placeholder: '显示名（可选）',
              value: newRoute.label,
              onChange: (event) => setNewRoute({ ...newRoute, label: event.target.value })
            }),
            React.createElement('input', {
              style: S.input,
              placeholder: '接口地址，如 https://api.example.com/v1',
              value: newRoute.baseUrl,
              onChange: (event) => setNewRoute({ ...newRoute, baseUrl: event.target.value })
            }),
            React.createElement('input', {
              style: S.input,
              placeholder: '模型名，如 gpt-4o-mini / qwen-vl-max',
              value: newRoute.model,
              onChange: (event) => setNewRoute({ ...newRoute, model: event.target.value })
            }),
            React.createElement(
              'div',
              { style: { display: 'flex', gap: 8, flexWrap: 'wrap', gridColumn: '1 / -1', minWidth: 0 } },
              React.createElement(
                'button',
                {
                  type: 'button',
                  disabled: modelBusy,
                  style: { ...S.btn, flex: '0 0 auto', opacity: modelBusy ? 0.6 : 1 },
                  onClick: fetchCustomModels
                },
                modelBusy ? '获取中…' : '获取模型列表'
              ),
              modelChoices.length > 0
                ? React.createElement(
                    'select',
                    {
                      style: { ...S.select, flex: '1 1 160px', minWidth: 0 },
                      value: modelChoices.includes(newRoute.model) ? newRoute.model : '',
                      onChange: (event) => {
                        if (event.target.value !== '') setNewRoute({ ...newRoute, model: event.target.value })
                      }
                    },
                    React.createElement('option', { value: '' }, '从上游模型里选（共 ' + modelChoices.length + ' 个）…'),
                    modelChoices.map((id) => React.createElement('option', { key: id, value: id }, id))
                  )
                : React.createElement(
                    'div',
                    { style: { ...S.hint, alignSelf: 'center' } },
                    '填好接口地址和密钥后点左边的按钮，直接拉上游 /models 列表'
                  )
            ),
            React.createElement('input', {
              style: S.input,
              type: 'password',
              placeholder: 'API Key（可留空）',
              value: newRoute.apiKey,
              onChange: (event) => setNewRoute({ ...newRoute, apiKey: event.target.value })
            }),
            React.createElement('input', {
              style: S.input,
              placeholder: '或填凭据引用，如 ALIYUN_API_KEY（密钥不落明文）',
              value: newRoute.apiKeyRef,
              onChange: (event) => setNewRoute({ ...newRoute, apiKeyRef: event.target.value })
            }),
            React.createElement(
              'button',
              { type: 'button', onClick: addCustomRoute, style: S.btnPrimary },
              '加入草稿'
            )
          ),
          React.createElement(
            'div',
            { style: S.hint },
            '接口地址写 base，插件自己拼 /chat/completions；也接受直接写完整的 …/chat/completions。'
          )
        )
      )

      const params = React.createElement(
        Section,
        {
          title: '参数',
          desc: '影响每一次读图的超时、体积与输出风格。',
          collapsible: true,
          defaultOpen: false
        },
        React.createElement(
          'div',
          { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 } },
          React.createElement(
            Field,
            { label: '超时（秒）', hint: '单次读图上限' },
            React.createElement('input', {
              style: S.input,
              type: 'number',
              min: 5,
              max: 900,
              value: Math.round((draft.timeoutMs || 0) / 1000),
              onChange: (event) => patch({ timeoutMs: Math.max(5, Math.min(900, Number(event.target.value) || 5)) * 1000 })
            })
          ),
          React.createElement(
            Field,
            { label: '单张上限（MB）', hint: '超过直接拒绝' },
            React.createElement('input', {
              style: S.input,
              type: 'number',
              min: 1,
              max: 64,
              value: Math.round((draft.maxImageBytes || 0) / 1048576),
              onChange: (event) =>
                patch({ maxImageBytes: Math.max(1, Math.min(64, Number(event.target.value) || 1)) * 1048576 })
            })
          ),
          React.createElement(
            Field,
            { label: '最多图片数', hint: '一次调用' },
            React.createElement('input', {
              style: S.input,
              type: 'number',
              min: 1,
              max: 8,
              value: draft.maxImages || 1,
              onChange: (event) => patch({ maxImages: Math.max(1, Math.min(8, Number(event.target.value) || 1)) })
            })
          ),
          React.createElement(
            Field,
            { label: '返回风格' },
            React.createElement(Segmented, {
              value: draft.verbosity,
              options: [
                { value: 'rich', label: '详细' },
                { value: 'quiet', label: '只回正文' }
              ],
              onChange: (value) => patch({ verbosity: value })
            })
          ),
          React.createElement(
            Field,
            { label: '工具名', restart: true, hint: '启动时注册，改名要重启' },
            React.createElement('input', {
              style: S.input,
              value: draft.toolName || '',
              onChange: (event) => patch({ toolName: event.target.value })
            })
          ),
          React.createElement(
            Field,
            { label: '明细条数', hint: '保留最近多少条' },
            React.createElement('input', {
              style: S.input,
              type: 'number',
              min: 5,
              max: 200,
              value: draft.logLimit || 40,
              onChange: (event) => patch({ logLimit: Math.max(5, Math.min(200, Number(event.target.value) || 40)) })
            })
          )
        )
      )

      const switches = React.createElement(
        Section,
        { title: '开关', desc: '关掉后工具立即失效，但配置与统计保留。' },
        React.createElement(
          'div',
          { style: { display: 'grid', gap: 12 } },
          React.createElement(
            'div',
            { style: S.rowBetween },
            React.createElement(
              'div',
              null,
              React.createElement('div', { style: S.label }, '启用视觉工具'),
              React.createElement('div', { style: S.hint }, '关闭后模型调用会直接报错，不再发请求。')
            ),
            React.createElement(Toggle, {
              label: '启用视觉工具',
              checked: draft.enabled !== false,
              onChange: (value) => patch({ enabled: value })
            })
          ),
          React.createElement(
            'div',
            { style: S.rowBetween },
            React.createElement(
              'div',
              null,
              React.createElement('div', { style: S.label }, '记录调用明细'),
              React.createElement('div', { style: S.hint }, '关闭后只累计数字，不留单条明细。')
            ),
            React.createElement(Toggle, {
              label: '记录调用明细',
              checked: draft.recordLog !== false,
              onChange: (value) => patch({ recordLog: value })
            })
          )
        )
      )

      const logRows = Array.isArray(stats.log) ? stats.log : []

      const logSection = React.createElement(
        Section,
        {
          title: '调用记录',
          desc: '最近 ' + logRows.length + ' 条，超出数量自动淘汰。',
          right: React.createElement(
            'div',
            { style: { display: 'flex', gap: 8 } },
            React.createElement(
              'button',
              { type: 'button', onClick: resetStats, disabled: busy !== '', style: { ...S.btn, padding: '3px 9px', fontSize: 12 } },
              '清零统计'
            ),
            React.createElement(
              'button',
              { type: 'button', onClick: clearLog, disabled: busy !== '', style: { ...S.btn, padding: '3px 9px', fontSize: 12 } },
              '清空明细'
            )
          )
        },
        React.createElement(
          'div',
          {
            style: {
              maxHeight: 190,
              overflowY: 'auto',
              border: '1px solid ' + C.line,
              borderRadius: 9,
              background: C.soft
            }
          },
          logRows.length === 0
            ? React.createElement(
                'div',
                { style: { padding: '18px 12px', fontSize: 12, color: C.sub, textAlign: 'center' } },
                '还没有调用记录'
              )
            : logRows.map((entry, index) =>
                React.createElement(
                  'div',
                  {
                    key: index,
                    style: {
                      display: 'grid',
                      gridTemplateColumns: '62px 1fr auto',
                      gap: 8,
                      alignItems: 'center',
                      padding: '6px 10px',
                      borderTop: index === 0 ? 'none' : '1px solid ' + C.line,
                      fontSize: 11.5
                    }
                  },
                  React.createElement('span', { style: { color: C.sub, fontVariantNumeric: 'tabular-nums' } }, fmtTime(entry.at)),
                  React.createElement(
                    'div',
                    { style: { minWidth: 0 } },
                    React.createElement(
                      'div',
                      {
                        style: {
                          color: C.text,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap'
                        },
                        title: entry.error ? entry.route + ' · ' + entry.error : entry.route
                      },
                      entry.route
                    ),
                    entry.error
                      ? React.createElement(
                          'div',
                          {
                            style: {
                              color: C.bad,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap'
                            },
                            title: entry.error
                          },
                          entry.error
                        )
                      : null
                  ),
                  React.createElement(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto' } },
                    badge(entry.ok ? 'ok' : 'bad', entry.ok ? 'OK' : 'FAIL'),
                    React.createElement('span', { style: { color: C.sub, fontVariantNumeric: 'tabular-nums' } }, fmtMs(entry.ms))
                  )
                )
              )
        )
      )

      const actions = React.createElement(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            position: 'sticky',
            bottom: 0,
            padding: '10px 0 2px',
            background: 'transparent'
          }
        },
        React.createElement(
          'div',
          { style: { fontSize: 11.5, color: C.sub } },
          dirty ? '有未保存的修改' : '配置已保存 · 除「工具名」外都立即生效'
        ),
        React.createElement(
          'div',
          { style: { display: 'flex', gap: 8 } },
          React.createElement(
            'button',
            { type: 'button', onClick: () => setDraft(pick(config)), disabled: !dirty || busy !== '', style: { ...S.btn, opacity: !dirty || busy !== '' ? 0.5 : 1 } },
            '放弃修改'
          ),
          React.createElement(
            'button',
            { type: 'button', onClick: save, disabled: !dirty || busy !== '', style: { ...S.btnPrimary, opacity: !dirty || busy !== '' ? 0.5 : 1 } },
            busy === 'save' ? '保存中…' : '保存'
          )
        )
      )

      const probeCard = probe
        ? React.createElement(
            'div',
            { style: { ...S.card, background: C.soft } },
            React.createElement(
              'div',
              { style: S.rowBetween },
              React.createElement('div', { style: S.label }, '自检结果'),
              badge(probe.matched ? 'ok' : 'warn', probe.matched ? '通过' : '未通过')
            ),
            React.createElement(
              'div',
              { style: { ...S.hint, marginTop: 6 } },
              '路线 ' + probe.route + ' · 期望颜色 ' + probe.expected + ' · 耗时 ' + fmtMs(probe.ms)
            ),
            React.createElement(
              'pre',
              {
                style: {
                  margin: '8px 0 0',
                  padding: 10,
                  fontSize: 11.5,
                  lineHeight: '17px',
                  color: C.text,
                  background: 'var(--dsw-alias-bg-layer-3, #fff)',
                  border: '1px solid ' + C.line,
                  borderRadius: 8,
                  maxHeight: 120,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap'
                }
              },
              probe.answer || '(空回答)'
            )
          )
        : null

      const maintenance = React.createElement(
        Section,
        {
          title: '维护',
          desc: '宿主没有热重载接口：改了宿主代码或 cordis 配置后必须重启进程才能生效。'
        },
        React.createElement(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          React.createElement(
            'button',
            {
              type: 'button',
              onClick: restartApp,
              disabled: restarting,
              style: { ...S.btn, opacity: restarting ? 0.6 : 1 }
            },
            restarting ? '正在重启…' : '重启应用'
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              onClick: () => {
                if (typeof window !== 'undefined' && window.location) window.location.reload()
              },
              style: { ...S.btn }
            },
            '只刷新页面 (F5)'
          ),
          React.createElement(
            'span',
            { style: S.hint },
            restarting
              ? '应用会在约 2 秒后关闭，然后自动重新打开；这个页面稍后刷新即可。'
              : '重启会自动重新打开应用，已保存的配置和调用记录不受影响。'
          )
        )
      )

      return React.createElement(
        'div',
        { style: { padding: '4px 0 8px', minWidth: 0, maxWidth: '100%', boxSizing: 'border-box', overflowX: 'hidden' } },
        header,
        routing,
        hostModelsSection,
        prompts,
        customSection,
        params,
        switches,
        probeCard,
        logSection,
        maintenance,
        actions
      )
    }

    // ------------------------------------------------------------- registering

    function apply(ctx) {
      // `slots` arrives through the declarative inject list below, the same way
      // the other client plugins get it. `ctx.inject(...)` is a cordis
      // plugin-registration API; it does not exist on the browser-side plugin
      // context, so using it here silently produced no card at all.
      try {
        if (React === null || !ctx || !ctx.slots) return
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'dsh-vision', order: 56, label: () => '视觉' },
            Panel
          )
        )
      } catch (error) {
        // A settings card must never take the settings page down with it.
        console.error('[dsh-vision] could not register the settings section: ' + errorText(error))
      }
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  }
})