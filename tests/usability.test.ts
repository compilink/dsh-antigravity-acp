import { describe, expect, it } from 'vitest'
import type { AnyMessage, Stream } from '@agentclientprotocol/sdk'
import { AgentLink, AGY_CLIENT_INFO, AGY_LINK_ERROR } from '../src/protocol/agent-link.js'
import { downloadBinary } from '../src/runtime/binary.js'
describe('downloadBinary 超时与取消', () => {
  const hang = (_url: string, init: { signal?: AbortSignal }): Promise<never> =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })

  it('网络挂住时按超时中止，而不是永远等待', async () => {
    await expect(downloadBinary('https://dl.google.com/x.zip', { fetchImpl: hang, timeoutMs: 30 })).rejects.toBeDefined()
  })

  it('调用方 signal（插件卸载）可立即取消下载', async () => {
    const controller = new AbortController()
    const pending = downloadBinary('https://dl.google.com/x.zip', { fetchImpl: hang, signal: controller.signal, timeoutMs: 60_000 })
    controller.abort(new Error('插件已卸载'))
    await expect(pending).rejects.toThrow('插件已卸载')
  })
})

describe('AgentLink 细节', () => {
  it('signal 已中止时不发出请求', async () => {
    const written: AnyMessage[] = []
    const stream: Stream = {
      readable: new ReadableStream<AnyMessage>(),
      writable: new WritableStream<AnyMessage>({ write: (message) => { written.push(message) } }),
    }
    const link = new AgentLink({ stream })
    const controller = new AbortController()
    controller.abort(new Error('用户取消'))
    await expect(link.request('session/prompt', {}, { signal: controller.signal })).rejects.toMatchObject({
      code: AGY_LINK_ERROR.REQUEST_TIMEOUT,
    })
    expect(written).toEqual([])
  })

  it('clientInfo 版本取自 package.json，而不是硬编码的 0.1.0', async () => {
    const { readFileSync } = await import('node:fs')
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(AGY_CLIENT_INFO.version).toBe(pkg.version)
  })
})
