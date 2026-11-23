/** 离线预览夹具共享模块：从真实 client 组件生成模拟数据的静态 HTML；无登录/联网/宿主访问。 */
import { buildClientSource } from './client-bundle.mjs'
import { runInNewContext } from 'node:vm'
const source = buildClientSource()
let plugin
runInNewContext(source, { window: { __ModuleLoader__: { load(value) { plugin = value } } } })
let index = 0
let states = {}
const React = {
  createElement: (type, props, ...children) => typeof type === 'function' ? type({ ...(props ?? {}), children: children.flat() }) : ({ type, props: props ?? {}, children: children.flat() }),
  useState: (initial) => [index in states ? states[index++] : (index++, initial), () => {}],
  useRef: (value) => ({ current: value }), useCallback: (fn) => fn, useEffect() {}, useId: () => 'preview',
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}
const components = new Map()
const ctx = {
  effect(fn) { fn(); return () => {} }, inject(_deps, fn) { fn(ctx) }, get() {},
  remote: { $mount() { return () => {} } },
  slots: { inject(_name, fn) { fn(); return () => {} }, register(row, component) { components.set(row.id, component); return () => {} } },
}
plugin.factory(() => React).apply(ctx)
const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const booleanAttributes = new Set(['disabled', 'checked', 'selected', 'multiple', 'readOnly', 'required'])
const unitlessStyles = new Set(['opacity', 'zIndex', 'fontWeight', 'lineHeight', 'flex', 'flexGrow', 'flexShrink', 'order'])
function html(node) {
  if (node === undefined || node === null || typeof node === 'boolean') return ''
  if (typeof node !== 'object') return escape(node)
  const { type, props, children } = node
  let attrs = ''
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || key === 'ref' || key === 'key' || key.startsWith('on')) continue
    if (key === 'style') {
      attrs += ' style="' + escape(Object.entries(value).map(([k, v]) => k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()) + ':' + (typeof v === 'number' && v !== 0 && !unitlessStyles.has(k) ? v + 'px' : v)).join(';')) + '"'
    } else if (booleanAttributes.has(key)) { if (value) attrs += ' ' + key.toLowerCase(); }
    else attrs += ' ' + key + '="' + escape(value) + '"'
  }
  const content = type === 'select' ? children.map((child) => child?.type === 'option' && child.props.value === props.value ? { ...child, props: { ...child.props, selected: true } } : child) : children
  return '<' + type + attrs + '>' + content.map(html).join('') + '</' + type + '>'
}
function render(id, values, props) { index = 0; states = values; return html(components.get(id)(props)) }

/** A static account fixture for checking the same settings components offline. */
export function previewSettings(tab = 'connection') {
  return render('antigravity-acp', {
    0: { state: 'connected', message: '官方 ACP 已连接（模拟）' },
    1: [{ id: 'example-model', name: '示例模型', inputModalities: ['text', 'image'] }],
    4: { revision: 1 }, 5: true, 6: { reuseSessions: true, modelOverrides: {} },
    8: false, 9: true, 13: tab,
  }, { remote: {}, control() {} })
}
