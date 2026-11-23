import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { buildClientSource } from '../scripts/client-bundle.mjs'

const packageId = 'dsh-bundle-antigravity-official-acp'

type Registration = {
  id: string
  factory(require: (id: string) => unknown): { name: string; inject: string[]; apply(ctx: unknown): void }
}
type Codec = { typeSymbol: string; create(): { parse(value: unknown): unknown } }
type Descriptor = { id: string; method: string; namespace: string; parameters: Array<{ codec: Codec }>; result: Codec }

describe('official ACP browser client', () => {
  it('registers only the ACP settings section and the two host controls', () => {
    let registration!: Registration
    runInNewContext(buildClientSource(), { window: { __ModuleLoader__: { load: (value: Registration) => { registration = value } } } })
    const module = registration.factory(() => ({}))
    const mount = vi.fn((_bundle: { package: string; descriptors: Descriptor[] }) => () => {})
    const register = vi.fn()
    const get = vi.fn()
    module.apply({ effect: (setup: () => unknown) => setup(), remote: { $mount: mount }, get,
      slots: { inject: (_name: string, setup: () => unknown) => setup(), register } })
    expect(registration.id).toBe(packageId)
    expect(module.name).toBe(packageId)
    expect(module.inject).toEqual(['slots', 'remote', 'remote.settings', 'remote.llm'])
    expect(register).toHaveBeenCalledTimes(1)
    expect(register.mock.calls[0]![0]).toMatchObject({ id: 'antigravity-acp', name: 'settings.section' })
    expect(get).not.toHaveBeenCalled()
    expect(mount).toHaveBeenCalledTimes(1)
    const bundle = mount.mock.calls[0]![0]
    expect(bundle.package).toBe(packageId)
    const [account, models] = bundle.descriptors
    expect(bundle.descriptors.map(item => item.id)).toEqual([packageId + '#agyAcp/account', packageId + '#agyAcp/models'])
    expect(account!.parameters[0]!.codec.typeSymbol).toBe(packageId + '#AgYAcpAccountRequest')
    expect(models!.result.typeSymbol).toBe(packageId + '#AgYAcpModelsResult')
    expect(() => account!.parameters[0]!.codec.create().parse({ action: 'unexpected' })).toThrow()
    expect(() => models!.parameters[0]!.codec.create().parse({ force: 'yes' })).toThrow()
  })
})
