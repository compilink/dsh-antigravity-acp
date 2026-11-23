/** Host gateway for explicit Antigravity ACP connections and model discovery. */
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { InvocationDescriptor, TypertCodec, TypertSchema } from '@deepseek-ai/dsh-typert-protocol'
import type { SettingsControl, AccountAction, AccountSnapshot, ModelSnapshot } from './control.js'

export const PACKAGE_NAME = 'dsh-bundle-antigravity-official-acp'
export const AGY_ACP_SERVICE = 'agyAcp'

function parseRequest(value: unknown): { force?: boolean } {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid ACP model request')
  if (!('force' in value)) return {}
  if (typeof value.force !== 'boolean') throw new TypeError('Invalid ACP model refresh')
  return { force: value.force }
}

function strictCodec(typeSymbol: string, parse: (value: unknown) => unknown): TypertCodec {
  const schema: TypertSchema = { parse }
  return { mode: 'strict', typeSymbol, create: () => schema }
}

const requestCodec = strictCodec(`${PACKAGE_NAME}#AgYAcpModelsRequest`, parseRequest)

function parseAccountRequest(value: unknown): { action: AccountAction } {
  if (value === undefined) return { action: 'status' }
  if (!value || typeof value !== 'object' || !('action' in value)) throw new TypeError('Invalid AgYAccountRequest')
  const { action } = value
  if (action === 'status' || action === 'verify' || action === 'login' || action === 'cancel') return { action }
  throw new TypeError('Invalid AgYAccountRequest')
}
function parseAccount(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('state' in value) || !('message' in value)
    || !['idle', 'connecting', 'cancelling', 'connected', 'cancelled', 'error'].includes(String(value.state))
    || typeof value.message !== 'string') throw new TypeError('Invalid AgYAccountResult')
  return value
}
function parseModels(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('models' in value) || !Array.isArray(value.models)
    || !('status' in value) || !['ok', 'error'].includes(String(value.status))) throw new TypeError('Invalid AgYModelsResult')
  return value
}

export const AGY_ACP_INVOCATIONS: readonly InvocationDescriptor[] =
  (['account', 'models'] as const).map((method): InvocationDescriptor => ({
    id: `${PACKAGE_NAME}#${AGY_ACP_SERVICE}/${method}`,
    service: AGY_ACP_SERVICE, namespace: AGY_ACP_SERVICE, method,
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: true,
      codec: method === 'account' ? strictCodec(`${PACKAGE_NAME}#AgYAcpAccountRequest`, parseAccountRequest) : requestCodec }],
    result: method === 'account' ? strictCodec(`${PACKAGE_NAME}#AgYAcpAccountResult`, parseAccount) : strictCodec(`${PACKAGE_NAME}#AgYAcpModelsResult`, parseModels),
  }))

interface TypertContribution {
  readonly package: string
  readonly face: 'host' | 'client'
  readonly schemas: readonly unknown[]
  readonly model: {
    readonly services: readonly unknown[]
    readonly events: readonly unknown[]
    readonly objects: readonly unknown[]
  }
  readonly invocations: readonly InvocationDescriptor[]
}

interface HostTypertRegistrar {
  register(contribution: TypertContribution): () => void | Promise<void>
}

function isRegistrar(value: unknown): value is HostTypertRegistrar {
  return typeof value === 'object' && value !== null
    && typeof (value as { register?: unknown }).register === 'function'
}

export function registerAgYAcpRemote(ctx: Context): void {
  ctx.inject(['typert'], scope => {
    scope.effect(() => {
      const registrar = scope.get('typert')
      if (!isRegistrar(registrar)) throw new Error('ACP 设置服务无法注册')
      return registrar.register({
        package: PACKAGE_NAME, face: 'host', schemas: [],
        model: { services: [], events: [], objects: [] },
        invocations: AGY_ACP_INVOCATIONS,
      })
    }, 'antigravity-acp: settings remote')
  })
}

export class AgYAcpService extends TypertRemoteService {
  private readonly control: SettingsControl

  constructor(ctx: Context, options: { control: SettingsControl }) {
    super(ctx, AGY_ACP_SERVICE)
    this.control = options.control
  }

  account(request?: { action: AccountAction }): AccountSnapshot {
    return this.control.account(parseAccountRequest(request).action)
  }

  models(request?: { force?: boolean }): Promise<ModelSnapshot> {
    return this.control.models(parseRequest(request).force === true)
  }
}
