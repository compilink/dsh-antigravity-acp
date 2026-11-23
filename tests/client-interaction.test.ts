import { buildClientSource } from '../scripts/client-bundle.mjs'
import { runInNewContext } from 'node:vm'
import React from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

type SettingsDocument = { writable: boolean; namespaces: Array<{ ns: string; revision: number; value: Record<string, unknown> }> }

function document(value: Record<string, unknown> = {}, revision = 1, writable = true): SettingsDocument {
  return { writable, namespaces: [{ ns: 'llm-antigravity-acp', revision, value }] }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const renderers: ReactTestRenderer[] = []
afterEach(async () => {
  await act(async () => { for (const renderer of renderers.splice(0)) renderer.unmount() })
})

type Browser = {
  location?: { protocol: string; hostname: string; assign(url: string): void }
  navigator?: { platform: string; maxTouchPoints?: number; language?: string }
  framed?: boolean
}

function loadCard(browser: Browser) {
  let registration: { factory(require: (id: string) => unknown): { apply(ctx: unknown): void } } | undefined
  const components = new Map<string, React.ComponentType<Record<string, unknown>>>()
  const intervals = new Map<number, { callback: () => void; delay: number }>()
  let timerId = 0
  runInNewContext(buildClientSource(), {
    window: { __ModuleLoader__: { load: (value: typeof registration) => { registration = value } }, location: browser.location, navigator: browser.navigator, top: browser.framed ? {} : undefined, innerHeight: 800, addEventListener: () => {}, removeEventListener: () => {} },
    navigator: browser.navigator,
    document: { documentElement: { clientWidth: 1200 }, addEventListener: () => {}, removeEventListener: () => {} },
    setInterval: (callback: () => void, delay: number) => { intervals.set(++timerId, { callback, delay }); return timerId },
    clearInterval: (id: number) => intervals.delete(id),
    setTimeout, clearTimeout,
  })
  const slots = {
    inject: (_name: string, callback: () => void) => { callback(); return () => {} },
    register: (row: { id: string; inject?: () => Record<string, unknown> }, component: React.ComponentType<Record<string, unknown>>) => {
      components.set(row.id, component)
      return () => {}
    },
  }
  const ctx = {
    slots,
    remote: { $mount: () => () => {} },
    get: () => undefined,
    effect: (callback: () => unknown) => callback(),
    inject: (_names: string[], callback: (scope: unknown) => void) => callback(ctx),
  }
  registration!.factory(() => React).apply(ctx)
  return { Card: components.get('antigravity-acp')!, intervals }
}

function transport(initial = document()) {
  let current = initial
  let listener: ((namespace: string) => void) | undefined
  const describe = vi.fn(async () => current)
  const mutate = vi.fn(async (_namespace: string, _ops: unknown[], _revision: number) => ({ ok: true, value: undefined }))
  return {
    describe, mutate,
    remote: {
      settings: { describe, mutate },
      llm: { listProviders: async () => [{ id: 'antigravity-acp' }] },
      $on: (_event: string, callback: (namespace: string) => void) => { listener = callback; return () => { listener = undefined } },
    },
    change(next: SettingsDocument) { current = next; listener?.('llm-antigravity-acp') },
    set(next: SettingsDocument) { current = next },
    notify() { listener?.('llm-antigravity-acp') },
  }
}

async function mount(remote: unknown, control?: unknown, browser: Browser = {}) {
  const { Card, intervals } = loadCard(browser)
  let renderer!: ReactTestRenderer
  await act(async () => { renderer = create(React.createElement(Card, { remote, control })) })
  renderers.push(renderer)
  return { renderer, intervals }
}

function button(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  return renderer.root.findAllByType('button').find((node) => node.children.join('') === label || node.props['aria-label'] === label)!
}
function fieldInput(renderer: ReactTestRenderer, name: string): ReactTestInstance {
  return renderer.root.findByProps({ name })
}
/** 逐模型列表里某一行的控件。 */
function modelControl(renderer: ReactTestRenderer, kind: 'enabled' | 'effort' | 'target' | 'name', id: string): ReactTestInstance {
  return renderer.root.findByProps({ name: `model-${kind}-${id}` })
}
function renderedText(renderer: ReactTestRenderer): string { return JSON.stringify(renderer.toJSON()) }

describe('settings card with real React state and effects', () => {
  const catalog = () => ({ status: 'ok' as const, models: [
    { id: 'gemini-3-pro', name: 'Gemini 3 Pro', inputModalities: ['text', 'image'] },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet' },
  ] })
  const controlWith = (models: unknown = catalog(), account: Record<string, unknown> = { state: 'idle', message: 'ready' }) =>
    vi.fn(async (method: string) => method === 'account' ? account : models)


  it('opening settings and saving preferences leave login and discovery idle until requested', async () => {
    const service = transport()
    const control = controlWith()
    const { renderer, intervals } = await mount(service.remote, control)
    expect(intervals.size).toBe(0)
    expect(control.mock.calls).toEqual([['account', { action: 'status' }], ['models', undefined]])
    await act(async () => { fieldInput(renderer, 'reuseSessions').props.onChange({ target: { checked: false } }) })
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(control).toHaveBeenCalledTimes(2)
    await act(async () => { await button(renderer, '连接 / 登录 ACP').props.onClick() })
    expect(control).toHaveBeenCalledWith('account', { action: 'login' })
    await act(async () => { await button(renderer, '刷新模型目录').props.onClick() })
    expect(control).toHaveBeenCalledWith('models', { force: true })
  })

  it('polls only read-only status during a pending connection and stops after cancellation', async () => {
    let state = 'idle'
    const control = vi.fn(async (method: string, request?: { action?: string; force?: boolean }) => {
      if (method === 'models') return catalog()
      if (request?.action === 'login') state = 'connecting'
      if (request?.action === 'cancel') state = 'cancelled'
      return { state, message: 'ACP' }
    })
    const { renderer, intervals } = await mount(transport().remote, control)
    await act(async () => { await button(renderer, '连接 / 登录 ACP').props.onClick() })
    expect(intervals.size).toBe(1)
    await act(async () => { for (const timer of intervals.values()) timer.callback() })
    expect(control.mock.calls.at(-1)).toEqual(['account', { action: 'status' }])
    await act(async () => { await button(renderer, '取消连接').props.onClick() })
    expect(intervals.size).toBe(0)
  })

  it.each(['localhost', '127.0.0.1', '[::1]'])('hands off explicit clicks on %s to the Mac helper and verifies separately', async (hostname) => {
    const assign = vi.fn()
    let state = 'idle'
    const control = vi.fn(async (method: string, request?: { action?: string }) => {
      if (method === 'models') return catalog()
      if (request?.action === 'verify') state = 'connecting'
      if (request?.action === 'cancel') state = 'cancelled'
      return { state, message: 'ACP' }
    })
    const { renderer, intervals } = await mount(transport().remote, control, {
      location: { hostname, protocol: 'http:', assign }, navigator: { platform: 'MacIntel' },
    })
    expect(assign).not.toHaveBeenCalled()
    const launch = button(renderer, '在 Mac 上授权').props.onClick
    await act(async () => { launch({ detail: 1 }); launch({ detail: 2 }) })
    expect(assign.mock.calls).toEqual([['dsh-antigravity-login://authorize']])
    expect(control.mock.calls).toEqual([['account', { action: 'status' }], ['models', undefined]])
    expect(intervals.size).toBe(0)
    expect(renderedText(renderer)).toContain('若助手未打开')
    await act(async () => { await button(renderer, '验证 ACP 连接').props.onClick() })
    expect(control.mock.calls.at(-1)).toEqual(['account', { action: 'verify' }])
    expect(button(renderer, '在 Mac 上授权').props.disabled).toBe(true)
    await act(async () => { await button(renderer, '取消连接').props.onClick() })
    expect(assign).toHaveBeenCalledTimes(1)
    expect(intervals.size).toBe(0)
  })

  it('shows the installation guide when browser policy refuses the helper', async () => {
    const { renderer, intervals } = await mount(transport().remote, controlWith(), {
      location: { hostname: 'localhost', protocol: 'https:', assign() { throw new Error('blocked') } },
      navigator: { platform: 'MacIntel', language: 'en-US' },
    })
    await act(async () => { button(renderer, 'Authorize on this Mac').props.onClick({ detail: 0 }) })
    expect(renderedText(renderer)).toContain('The browser could not open the sign-in helper.')
    expect(renderedText(renderer)).toContain('Helper installation guide')
    expect(button(renderer, 'Verify ACP connection').props.disabled).toBeFalsy()
    expect(intervals.size).toBe(0)
  })

  it.each([
    ['mac.example', 'https:', 'MacIntel', 0, false],
    ['localhost.example', 'http:', 'MacIntel', 0, false],
    ['127.0.0.1', 'file:', 'MacIntel', 0, false],
    ['localhost', 'http:', 'Win32', 0, false],
    ['localhost', 'http:', 'MacIntel', 5, false],
    ['localhost', 'http:', 'MacIntel', 0, true],
  ] as const)('keeps the host connection flow on %s %s %s with touch=%s framed=%s', async (hostname, protocol, platform, maxTouchPoints, framed) => {
    const assign = vi.fn()
    const control = controlWith()
    const { renderer } = await mount(transport().remote, control, { location: { hostname, protocol, assign }, navigator: { platform, maxTouchPoints }, framed })
    expect(button(renderer, '在 Mac 上授权')).toBeUndefined()
    await act(async () => { await button(renderer, '连接 / 登录 ACP').props.onClick() })
    expect(control).toHaveBeenCalledWith('account', { action: 'login' })
    expect(assign).not.toHaveBeenCalled()
  })

  it('保存栏常驻顶部，只提供一个保存入口，编辑和撤销更新未保存计数', async () => {
    const service = transport(document())
    const { renderer } = await mount(service.remote)
    const bar = renderer.root.findByProps({ 'aria-label': '设置保存操作' })
    expect(bar.props.style).toMatchObject({ position: 'sticky', top: 0, display: 'none' })
    expect(bar.findAllByType('button').filter(node => node.children.join('') === '保存')).toHaveLength(1)
    expect(button(renderer, '保存').props.disabled).toBe(true)
    await act(async () => { fieldInput(renderer, 'idleRecycleMs').props.onChange({ target: { value: '12000' } }) })
    expect(renderedText(renderer)).toContain('1 项未保存')
    expect(bar.props.style.display).toBe('grid')
    expect(button(renderer, '保存').props.disabled).toBe(false)
    await act(async () => { button(renderer, '撤销').props.onClick() })
    expect(renderedText(renderer)).not.toContain('项未保存')
    expect(button(renderer, '保存').props.disabled).toBe(true)
  })

  it('逐模型设置只提交有意义的字段，清空的项从配置里移除', async () => {
    const service = transport(document({
      modelOverrides: { 'gemini-3-pro': { enabled: false, effort: 'low', name: '旧名', target: 'gemini-3-pro-high' } },
    }))
    const { renderer } = await mount(service.remote, controlWith())
    expect(modelControl(renderer, 'enabled', 'gemini-3-pro').props.checked).toBe(false)
    expect(modelControl(renderer, 'effort', 'gemini-3-pro').props.value).toBe('low')
    expect(modelControl(renderer, 'name', 'gemini-3-pro').props.value).toBe('旧名')
    await act(async () => {
      modelControl(renderer, 'enabled', 'gemini-3-pro').props.onChange({ target: { checked: true } })
      modelControl(renderer, 'effort', 'gemini-3-pro').props.onChange({ target: { value: '' } })
      modelControl(renderer, 'name', 'gemini-3-pro').props.onChange({ target: { value: '  ' } })
      modelControl(renderer, 'target', 'gemini-3-pro').props.onChange({ target: { value: '' } })
    })
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(service.mutate).toHaveBeenCalledWith('llm-antigravity-acp', [{ op: 'set', path: ['modelOverrides'], value: {} }], 1)
  })

  it('设置页显示已观测的上下文和输出上限，不把容量当成草稿字段', async () => {
    const service = transport(document())
    const models = catalog()
    const control = controlWith({ ...models, models: models.models.map((row, i) => i === 0
      ? { ...row, contextWindow: 1048576, maxOutputTokens: 262144 } : row) })
    const { renderer } = await mount(service.remote, control)
    const text = renderedText(renderer)
    expect(text).toContain(`上下文窗口 ${(1048576).toLocaleString()} tokens`)
    expect(text).toContain(`输出上限 ${(262144).toLocaleString()} tokens`)
    expect(text).toContain('上下文窗口：尚未观测')
    expect(service.mutate).not.toHaveBeenCalled()
  })

  it('全部模型被隐藏时提示 provider 会从选择器消失，重新启用后提示消失', async () => {
    const service = transport(document({ modelOverrides: { 'gemini-3-pro': { enabled: false }, 'claude-sonnet-5-5': { enabled: false } } }))
    const { renderer } = await mount(service.remote, controlWith())
    expect(renderedText(renderer)).toContain('全部隐藏后')
    await act(async () => { modelControl(renderer, 'enabled', 'gemini-3-pro').props.onChange({ target: { checked: true } }) })
    expect(renderedText(renderer)).not.toContain('全部隐藏后')
    expect(renderedText(renderer)).toContain('已隐藏 1')
  })

  it('已经保存但当前目录没有的模型 ID 仍可编辑，并标注不在目录', async () => {
    const service = transport(document({ modelOverrides: { 'retired-model': { target: 'retired-model-high' } } }))
    const { renderer } = await mount(service.remote, controlWith())
    expect(modelControl(renderer, 'target', 'retired-model').props.value).toBe('retired-model-high')
    expect(renderedText(renderer)).toContain('不在当前目录')
    expect(renderedText(renderer)).toContain('全部 3')
  })

  it('模型可搜索并按启停筛选，折叠的高级映射仍可编辑', async () => {
    const service = transport(document({ modelOverrides: { 'gemini-3-pro': { enabled: false } } }))
    const { renderer } = await mount(service.remote, controlWith())
    const search = renderer.root.findByProps({ 'aria-label': '搜索模型' })
    await act(async () => { search.props.onChange({ target: { value: 'claude' } }) })
    expect(renderer.root.findAllByProps({ name: 'model-enabled-gemini-3-pro' })).toHaveLength(0)
    expect(modelControl(renderer, 'enabled', 'claude-sonnet-5-5')).toBeDefined()
    await act(async () => { search.props.onChange({ target: { value: '' } }) })
    const filter = renderer.root.findByProps({ 'aria-label': '筛选模型' })
    await act(async () => { filter.props.onChange({ target: { value: 'hidden' } }) })
    expect(modelControl(renderer, 'enabled', 'gemini-3-pro').props.checked).toBe(false)
    expect(renderer.root.findAllByProps({ name: 'model-enabled-claude-sonnet-5-5' })).toHaveLength(0)
    await act(async () => { button(renderer, '全部启用').props.onClick() })
    await act(async () => { filter.props.onChange({ target: { value: 'all' } }) })
    expect(modelControl(renderer, 'enabled', 'gemini-3-pro').props.checked).toBe(true)
  })

  it('缺少设置 namespace 时解释禁用原因，宿主恢复后重新启用控件', async () => {
    const service = transport({ writable: true, namespaces: [] })
    const { renderer } = await mount(service.remote)
    expect(fieldInput(renderer, 'idleRecycleMs').props.disabled).toBe(true)
    expect(renderedText(renderer)).toContain('尚未提供 Antigravity ACP 的可编辑设置')
    await act(async () => { service.change(document({ idleRecycleMs: 12000 })) })
    expect(fieldInput(renderer, 'idleRecycleMs').props.disabled).toBe(false)
    expect(renderedText(renderer)).not.toContain('尚未提供 Antigravity ACP 的可编辑设置')
  })

  it('respects read-only settings instead of offering a save that will fail', async () => {
    const service = transport(document({ idleRecycleMs: 10000 }, 1, false))
    const { renderer } = await mount(service.remote, controlWith())
    expect(fieldInput(renderer, 'idleRecycleMs').props.disabled).toBe(true)
    expect(modelControl(renderer, 'enabled', 'gemini-3-pro').props.disabled).toBe(true)
    expect(button(renderer, '保存').props.disabled).toBe(true)
    expect(renderedText(renderer)).toContain('只读设置')
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(service.mutate).not.toHaveBeenCalled()
  })

  it('preserves edited fields and merges untouched fields after an external update', async () => {
    const service = transport(document({ idleRecycleMs: 10000, modelOverrides: { 'gemini-3-pro': { effort: 'low' } } }))
    const { renderer } = await mount(service.remote, controlWith())
    await act(async () => { modelControl(renderer, 'target', 'gemini-3-pro').props.onChange({ target: { value: 'custom-target' } }) })
    // 外部同时改了回收时间和同一个模型的档位：草稿里的映射必须保留并提示冲突。
    await act(async () => { service.change(document({ idleRecycleMs: 15000, modelOverrides: { 'gemini-3-pro': { effort: 'high' } } }, 2)) })
    expect(modelControl(renderer, 'target', 'gemini-3-pro').props.value).toBe('custom-target')
    expect(modelControl(renderer, 'effort', 'gemini-3-pro').props.value).toBe('low')
    expect(fieldInput(renderer, 'idleRecycleMs').props.value).toBe(15000)
    expect(renderedText(renderer)).toContain('已保留你的输入')
    expect(renderedText(renderer)).toContain('模型列表设置')
    expect(renderedText(renderer)).toContain('1 项未保存')
    expect(button(renderer, '保存').props.disabled).toBe(false)
  })

  it('ignores an old settings request that resolves after the latest revision', async () => {
    const service = transport()
    const first = deferred<SettingsDocument>()
    service.describe.mockImplementationOnce(() => first.promise)
    const { renderer } = await mount(service.remote, controlWith())
    await act(async () => { service.change(document({ idleRecycleMs: 30000 }, 3)) })
    await act(async () => { first.resolve(document({ idleRecycleMs: 5000 }, 1)) })
    expect(fieldInput(renderer, 'idleRecycleMs').props.value).toBe(30000)
    expect(button(renderer, '保存').props.disabled).toBe(true)
  })

  it('can discard a conflicted draft and restore the latest server settings', async () => {
    const service = transport(document({ modelOverrides: { 'gemini-3-pro': { effort: 'low' } } }))
    const { renderer } = await mount(service.remote, controlWith())
    await act(async () => { modelControl(renderer, 'effort', 'gemini-3-pro').props.onChange({ target: { value: 'high' } }) })
    await act(async () => { service.change(document({ modelOverrides: { 'gemini-3-pro': { effort: 'medium' } } }, 2)) })
    await act(async () => { button(renderer, '撤销').props.onClick() })
    expect(modelControl(renderer, 'effort', 'gemini-3-pro').props.value).toBe('medium')
    expect(button(renderer, '保存').props.disabled).toBe(true)
    expect(renderedText(renderer)).not.toContain('其他位置更新了以下设置')
    expect(service.mutate).not.toHaveBeenCalled()
  })

  it('serializes save clicks and submits only edited fields, including zero', async () => {
    const service = transport(document({ idleRecycleMs: 10000 }))
    const saved = deferred<{ ok: boolean; value: undefined }>()
    service.mutate.mockImplementationOnce(() => saved.promise)
    const { renderer } = await mount(service.remote, controlWith())
    await act(async () => { fieldInput(renderer, 'idleRecycleMs').props.onChange({ target: { value: '0' } }) })
    const save = button(renderer, '保存').props.onClick as () => Promise<void>
    await act(async () => { void save(); void save() })
    expect(service.mutate).toHaveBeenCalledTimes(1)
    expect(service.mutate).toHaveBeenCalledWith('llm-antigravity-acp', [{ op: 'set', path: ['idleRecycleMs'], value: 0 }], 1)
    expect(button(renderer, '保存中…').props.disabled).toBe(true)
    expect(fieldInput(renderer, 'idleRecycleMs').props.disabled).toBe(true)
    await act(async () => {
      service.change(document({ idleRecycleMs: 0 }, 2))
      saved.resolve({ ok: true, value: undefined })
    })
    expect(fieldInput(renderer, 'idleRecycleMs').props.value).toBe(0)
    expect(button(renderer, '保存').props.disabled).toBe(true)
    expect(renderedText(renderer)).not.toContain('项未保存的修改')
  })

  it('preserves the draft and refreshes the revision after a rejected mutation', async () => {
    const service = transport(document({ idleRecycleMs: 10000 }))
    service.mutate.mockRejectedValueOnce(new Error('revision conflict'))
    const { renderer } = await mount(service.remote, controlWith())
    await act(async () => { fieldInput(renderer, 'idleRecycleMs').props.onChange({ target: { value: 20000 } }) })
    service.set(document({ idleRecycleMs: 15000 }, 2))
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(fieldInput(renderer, 'idleRecycleMs').props.value).toBe(20000)
    expect(renderedText(renderer)).toContain('revision conflict')
    expect(renderedText(renderer)).toContain('已保留你的输入')
    expect(button(renderer, '保存').props.disabled).toBe(false)
    service.set(document({ idleRecycleMs: 20000 }, 3))
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(service.mutate.mock.calls[1]?.[2]).toBe(2)
  })

  it('shows session switches and submits timers as numbers, preserving zero', async () => {
    const service = transport()
    const { renderer } = await mount(service.remote)
    expect(renderer.root.findByProps({ name: 'reuseSessions' }).props.checked).toBe(true)
    expect(renderer.root.findByProps({ name: 'resumeSessions' }).props.checked).toBe(false)
    expect(renderer.root.findByProps({ name: 'keepProcessAfterCancel' }).props.checked).toBe(false)
    expect(renderer.root.findByProps({ name: 'cancelGraceMs' }).props.value).toBe(30000)
    expect(renderer.root.findByProps({ name: 'idleRecycleMs' }).props.value).toBe(300000)
    await act(async () => {
      renderer.root.findByProps({ name: 'keepProcessAfterCancel' }).props.onChange({ target: { checked: true } })
      renderer.root.findByProps({ name: 'cancelGraceMs' }).props.onChange({ target: { value: '12000' } })
      renderer.root.findByProps({ name: 'idleRecycleMs' }).props.onChange({ target: { value: '0' } })
    })
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(service.mutate).toHaveBeenCalledWith('llm-antigravity-acp', [
      { op: 'set', path: ['keepProcessAfterCancel'], value: true },
      { op: 'set', path: ['cancelGraceMs'], value: 12000 },
      { op: 'set', path: ['idleRecycleMs'], value: 0 },
    ], 1)
  })

  for (const invalid of ['', '-1', '0.5', '60001', 'NaN']) {
    it(`rejects invalid cancel grace ${JSON.stringify(invalid)} without losing the draft`, async () => {
      const service = transport()
      const { renderer } = await mount(service.remote)
      await act(async () => { renderer.root.findByProps({ name: 'cancelGraceMs' }).props.onChange({ target: { value: invalid } }) })
      await act(async () => { await button(renderer, '保存').props.onClick() })
      expect(service.mutate).not.toHaveBeenCalled()
      expect(renderedText(renderer)).toContain('必须是 0–60000 的整数')
      expect(button(renderer, '保存').props.disabled).toBe(false)
    })
  }

  it('displays pool pressure and clears subscriptions and polling on unmount', async () => {
    const service = transport()
    const control = vi.fn(async (method: string) => method === 'account'
      ? { state: 'connected', message: 'ready', runtime: { phase: 'prompt', queue: { active: 2, parked: 1, waiting: 3, workers: 2, capacity: 2 } } }
      : { status: 'ok', models: [] })
    const { renderer, intervals } = await mount(service.remote, control)
    expect(renderedText(renderer)).toContain('运行 2 · 等待工具 1 · 排队 3')
    expect(button(renderer, '连接 / 登录 ACP').props.disabled).toBe(true)
    const before = service.describe.mock.calls.length
    await act(async () => { renderer.unmount() })
    expect(intervals.size).toBe(0)
    service.notify()
    expect(service.describe.mock.calls.length).toBe(before)
  })
})
