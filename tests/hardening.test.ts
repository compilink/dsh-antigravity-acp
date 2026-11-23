/** Error isolation for agent notifications and asynchronous handlers. */
import { afterEach, describe, expect, it } from 'vitest'
import type { AnyMessage, Stream } from '@agentclientprotocol/sdk'
import { AgentLink } from '../src/protocol/agent-link.js'

function fakePair(): {
  stream: Stream
  agentIn: ReadableStreamDefaultReader<AnyMessage>
  agentOut: WritableStreamDefaultWriter<AnyMessage>
} {
  const agentToClient = new TransformStream<AnyMessage, AnyMessage>()
  const clientToAgent = new TransformStream<AnyMessage, AnyMessage>()
  return {
    stream: { writable: clientToAgent.writable, readable: agentToClient.readable },
    agentIn: clientToAgent.readable.getReader(),
    agentOut: agentToClient.writable.getWriter(),
  }
}

type AgentView = AnyMessage & { method?: string; id?: string | number | null }

/** 假 agent：对 initialize 应答，其余请求交给 onRequest；返回「client→agent」消息记录。 */
function runAgent(
  pair: ReturnType<typeof fakePair>,
  onRequest: (message: AgentView) => AnyMessage | undefined = () => undefined,
): AgentView[] {
  const seen: AgentView[] = []
  void (async () => {
    for (;;) {
      const { done, value } = await pair.agentIn.read()
      if (done) break
      const message = value as AgentView
      seen.push(message)
      if (message.method === 'initialize') {
        await pair.agentOut.write({ jsonrpc: '2.0', id: message.id!, result: { protocolVersion: 1, agentCapabilities: {} } })
        continue
      }
      const reply = onRequest(message)
      if (reply) await pair.agentOut.write(reply)
    }
  })()
  return seen
}

const unhandled: unknown[] = []
process.on('unhandledRejection', (reason) => { unhandled.push(reason) })
afterEach(() => { unhandled.length = 0 })

const SESSION_UPDATE: AnyMessage = {
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId: 's-1', update: { sessionUpdate: 'agent_message_chunk' } },
}

describe('AgentLink 回调健壮性', () => {
  it('session/update 回调同步抛错：链路保持可用，后续请求仍可应答', async () => {
    const pair = fakePair()
    runAgent(pair, (message) => message.method === 'session/new'
      ? { jsonrpc: '2.0', id: message.id!, result: { sessionId: 's-1' } }
      : undefined)
    const link = new AgentLink({
      stream: pair.stream,
      handlers: { onSessionUpdate: () => { throw new Error('handler boom') } },
    })
    link.start()
    await link.initialize()
    await pair.agentOut.write(SESSION_UPDATE)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(link.closed).toBe(false)
    const session = await link.newSession({ cwd: '.', mcpServers: [] })
    expect(session.sessionId).toBe('s-1')
    await link.close()
  })

  it('session/update 回调异步 reject：不产生 unhandledRejection', async () => {
    const pair = fakePair()
    runAgent(pair)
    const link = new AgentLink({
      stream: pair.stream,
      handlers: { onSessionUpdate: async () => { throw new Error('async boom') } },
    })
    link.start()
    await link.initialize()
    await pair.agentOut.write(SESSION_UPDATE)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(unhandled).toEqual([])
    expect(link.closed).toBe(false)
    await link.close()
  })

  it('非预期入站请求的观测回调抛错：仍回 method-not-found，且无 unhandledRejection', async () => {
    const pair = fakePair()
    const seen = runAgent(pair)
    const link = new AgentLink({
      stream: pair.stream,
      handlers: { onUnexpectedAgentRequest: async () => { throw new Error('observer boom') } },
    })
    link.start()
    await link.initialize()
    await pair.agentOut.write({ jsonrpc: '2.0', id: 'agent-1', method: 'fs/read_text_file', params: { sessionId: 's', path: 'x' } })
    await new Promise((resolve) => setTimeout(resolve, 30))
    const answer = seen.find((message) => (message as { id?: unknown }).id === 'agent-1' && 'error' in message) as
      | { error?: { code: number } }
      | undefined
    expect(answer?.error?.code).toBe(-32601)
    expect(unhandled).toEqual([])
    await link.close()
  })
})
