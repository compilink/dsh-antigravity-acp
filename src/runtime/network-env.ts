/** Network settings inherited by the official child process. */
const ALWAYS_BYPASS = ['localhost', '127.0.0.1', '::1'] as const

export function resolveProxyBypass(raw: string | undefined): string {
  const entries: string[] = []
  for (const part of (raw ?? '').split(',')) {
    const entry = part.trim()
    if (entry !== '' && !entries.includes(entry)) entries.push(entry)
  }
  for (const entry of ALWAYS_BYPASS) {
    if (!entries.includes(entry)) entries.push(entry)
  }
  return entries.join(',')
}

export function ambientProxyEnv(
  parent: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv | undefined {
  const pick = (names: readonly string[]): string | undefined => {
    for (const name of names) {
      const value = parent[name]
      if (value && value.trim().length > 0) return value.trim()
    }
    return undefined
  }
  const generic = pick(['all_proxy', 'ALL_PROXY'])
  const httpProxy = pick(['http_proxy', 'HTTP_PROXY']) ?? generic
  const httpsProxy = pick(['https_proxy', 'HTTPS_PROXY']) ?? generic
  if (!httpProxy && !httpsProxy) return undefined
  const bypass = resolveProxyBypass(pick(['no_proxy', 'NO_PROXY']))
  const env: NodeJS.ProcessEnv = { NO_PROXY: bypass, no_proxy: bypass }
  if (httpProxy) {
    env.HTTP_PROXY = httpProxy
    env.http_proxy = httpProxy
  }
  if (httpsProxy) {
    env.HTTPS_PROXY = httpsProxy
    env.https_proxy = httpsProxy
  }
  if (generic) {
    env.ALL_PROXY = generic
    env.all_proxy = generic
  }
  return env
}
