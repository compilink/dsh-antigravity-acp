/** Opens personal authentication in Google's macOS ACP agent using the Docker profile's HOME. */
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { AGY_CLIENT_INFO, AgentLink, OAUTH_PERSONAL_AUTH_METHOD, agentStreamFromSubprocess } from '../dist/protocol/agent-link.js'
import { ensureAgentBinary } from '../dist/runtime/binary.js'
import { ambientProxyEnv } from '../dist/runtime/network-env.js'

async function main() {
  const { values } = parseArgs({ options: {
    home: { type: 'string' },
    'cache-dir': { type: 'string' },
    'check-only': { type: 'boolean' },
    help: { type: 'boolean' },
  } })
  if (values.help) {
    console.log('用法：node official-macos-login.mjs --home <Docker 绑定的主目录> [--check-only] [--cache-dir <归档目录>]')
    return
  }
  if (process.platform !== 'darwin' || !values.home || !isAbsolute(values.home)) {
    throw new Error('INVALID_HOME')
  }
  const home = await realpath(values.home)
  if (!(await stat(home)).isDirectory()) throw new Error('INVALID_HOME')
  await access(home, constants.W_OK | constants.X_OK)
  process.umask(0o077)
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  const temp = await mkdtemp(join(tmpdir(), 'dsh-official-acp-login-'))
  let bundle
  let child
  let exited
  let link
  try {
    console.log('正在校验 Google 官方 macOS ACP 程序…')
    bundle = await ensureAgentBinary({ cacheDir: values['cache-dir'] ? resolve(values['cache-dir']) : undefined, signal: controller.signal })
    controller.signal.throwIfAborted()
    // The official process is the only participant that receives the shared profile as HOME.
    child = spawn(bundle.executablePath, [], {
      cwd: dirname(bundle.executablePath),
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: temp, TMP: temp, TEMP: temp, ...ambientProxyEnv(process.env) },
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    exited = new Promise(resolveExit => {
      child.once('close', resolveExit)
      child.once('error', resolveExit)
    })
    const stopChild = () => { child.kill() }
    controller.signal.addEventListener('abort', stopChild, { once: true })
    if (controller.signal.aborted) stopChild()
    link = new AgentLink({
      stream: agentStreamFromSubprocess(child),
      clientInfo: AGY_CLIENT_INFO,
      handlers: {},
      handshakeTimeoutMs: 120000,
      authTimeoutMs: 300000,
    })
    link.start()
    const result = await link.initialize({ clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
    if (!result.authMethods?.some(m => m.id === OAUTH_PERSONAL_AUTH_METHOD)) throw new Error('NO_PERSONAL_AUTH')
    if (values['check-only']) {
      console.log('官方 ACP 已完成握手，支持 Google 个人账号授权。本次只检查连接。')
      return
    }
    console.log('请在 Google 官方程序打开的浏览器中登录。可按 Control-C 取消。')
    await link.authenticate(OAUTH_PERSONAL_AUTH_METHOD, controller.signal)
    console.log('官方 ACP 已确认授权。请回到 DSH 的 Antigravity ACP 设置，点“验证 ACP 连接”，再刷新模型列表。')
  } finally {
    if (child) {
      child.kill()
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
      try { await exited } finally { clearTimeout(timer) }
    }
    try { await link?.close() } finally {
      try { await bundle?.release() } finally {
        await rm(temp, { recursive: true, force: true })
        process.off('SIGINT', cancel)
        process.off('SIGTERM', cancel)
      }
    }
  }
}

main().catch(error => {
  // Provider and transport errors can include personal OAuth parameters. Keep diagnostics fixed.
  const known = {
    INVALID_HOME: '请在 macOS 上运行，并传入 DSH 已绑定、可写的 HOME 目录。',
    EACCES: '目录不可写，或 macOS 阻止了程序启动。请检查运行账户权限。',
    ENOENT: '未找到绑定目录或程序文件。请先将 Antigravity ACP 插件安装到 DSH。',
    AGY_BINARY_UNVERIFIED: '官方归档或缓存目录未通过完整性检查。',
    AGY_DOWNLOAD_TRANSFER_FAILED: '官方下载失败，请检查网络后重试。',
    AGY_AUTH_TIMEOUT: '登录未在五分钟内完成，可重新打开登录器。',
    NO_PERSONAL_AUTH: '此版本的官方 ACP 未提供个人账号授权。',
  }
  const reason = error?.name === 'AbortError' ? '已取消登录。' : known[error?.code] ?? known[error?.message]
  console.error(reason ?? '官方 ACP 操作未完成。请重试并检查 Google 网络连接和默认浏览器。')
  process.exitCode = 1
})
