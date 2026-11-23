/**
 * 官方 Antigravity ACP server 二进制的解析与获取。
 *
 * 每次启动从经 SHA-256 验证的官方归档解压到独占目录。缓存只提供归档字节。
 */
import { constants, createReadStream, createWriteStream } from 'node:fs'
import { access, chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { homedir as osHomedir, tmpdir } from 'node:os'
import { dirname, join, normalize, resolve, sep, win32 } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'
import { officialArchiveDigest } from './official-release.js'

/** 默认下载的官方 server 版本（可经 config.acpVersion 配置）。 */
export const DEFAULT_ACP_SERVER_VERSION = '1.5.2'
/** 官方 zip 下载的整体超时（含读完响应体）。 */
export const DOWNLOAD_TIMEOUT_MS = 10 * 60_000
/** 唯一允许的下载域名。 */
export const DOWNLOAD_HOST_WHITELIST = 'dl.google.com'
/** 数据缓存（模型清单等**非可执行**产物）在 DSH home 下的相对位置。 */
export const CACHE_SUBPATH = ['cache', 'antigravity-acp'] as const
/** 可执行文件安装根目录的目录名。 */
export const INSTALL_DIR_NAME = 'dsh-antigravity-host'
/**
 * 解压上限（压缩炸弹纵深防御）。
 *
 * 2026-11-22 实测 dl.google.com 官方分发包 central directory 声明的解压大小：
 * - Windows x86_64：单条目最大约 156 MiB（localharness_external.exe）；
 * - macOS 两架构：单条目最大约 269 MiB；
 * - Linux 两架构：主程序 .par 为 681–890 MiB，1.4.x 两条目合计最高约 1.06 GiB。
 * 旧值 512 MiB / 1 GiB 只按 Windows/macOS 包校准，Linux 全版本（含当时默认的
 * 1.4.0）都会在写盘前被拒（issue #13）。下载源已限定 https + dl.google.com +
 * 拒绝重定向，这一层是纯纵深防御：条目数仍限 2000，单条目 1.5 GiB、总量
 * 2 GiB 相对实测最大值分别保留约 73% 与 102% 余量（1.7×–2×），同时挡住伪造
 * 的超大解压声明。
 */
export const MAX_EXTRACT_ENTRIES = 2_000
export const MAX_EXTRACT_BYTES = 2 * 1_024 * 1_024 * 1_024
/** 单个条目上限：官方最大条目是 Linux 主程序 .par（实测约 890 MiB）。 */
export const MAX_EXTRACT_ENTRY_BYTES = 1_536 * 1_024 * 1_024
/** 覆盖可执行文件安装根目录的环境变量名。 */
export const INSTALL_ROOT_ENV = 'AGY_ACP_HOME'

/**
 * 本包原创错误码体系（AGY_*）。与协议层的 AGY_LAUNCH_FAILED 等共用前缀，
 * 便于在日志中区分归属。
 */
export const AGY_BINARY_ERROR = {
  /** URL 不满足 https + dl.google.com 白名单。 */
  BLOCKED_URL: 'AGY_DOWNLOAD_BLOCKED',
  UNVERIFIED: 'AGY_BINARY_UNVERIFIED',
  /** 服务器返回 3xx 重定向；安全策略要求拒绝且不跟随。 */
  REDIRECT_REFUSED: 'AGY_DOWNLOAD_REDIRECT_REFUSED',
  /** 下载返回非 2xx（非 3xx）状态。 */
  BAD_STATUS: 'AGY_DOWNLOAD_BAD_STATUS',
  /** 流式下载中途失败：断网、超时或写盘错误。 */
  TRANSFER_FAILED: 'AGY_DOWNLOAD_TRANSFER_FAILED',
  /** zip 条目路径不安全（绝对路径、穿越、盘符等）。 */
  UNSAFE_ENTRY: 'AGY_UNSAFE_ZIP_ENTRY',
  /** zip 内找不到可执行文件等结构异常。 */
  ARCHIVE_LAYOUT: 'AGY_ARCHIVE_LAYOUT',
  /** zip 打开或读取失败。 */
  ARCHIVE_READ: 'AGY_ARCHIVE_READ',
  /** zip 条目数或解压后大小超过上限（压缩炸弹防护）。 */
  ARCHIVE_TOO_LARGE: 'AGY_ARCHIVE_TOO_LARGE',
  /** 所有解析顺序都未找到二进制且未启用自动下载。 */
  BINARY_MISSING: 'AGY_BINARY_MISSING',
  /** 当前平台/架构无法映射出已知的下载坐标。 */
  PLATFORM_UNSUPPORTED: 'AGY_PLATFORM_UNSUPPORTED',
  /** 可执行文件落在 Low 强制完整性目录：进程会被降权，官方 server 必然挂死。 */
  LOW_INTEGRITY: 'AGY_BINARY_LOW_INTEGRITY',
} as const

export class AgyBinaryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'AgyBinaryError'
  }
}

export type AcpPlatform = 'windows' | 'darwin' | 'linux'
export type AcpArch = 'x86_64' | 'aarch64'
/** posix = darwin / linux（可执行文件挑选规则一致）。 */
export type ExecutableFlavor = 'windows' | 'posix'

/** 发行布局在 1.4.0–1.5.2 全平台实测一致：macOS/Linux 入口为 agy_acp_server.par，
 * Windows 为 agy_acp_server.exe，zip 内均为主程序与 localharness_external[.exe]
 * 两个条目。该表描述命名与入口，不宣称每个版本的协议行为都已实机验证。
 */
export const ACP_DISTRIBUTIONS = {
  windows: { directory: 'windows', executable: 'agy_acp_server.exe', defaultArgs: [] },
  darwin: { directory: 'macos', executable: 'agy_acp_server.par', defaultArgs: [] },
  linux: { directory: 'linux', executable: 'agy_acp_server.par', defaultArgs: ['--uid='] },
} as const

/**
 * 与主程序同目录、由主程序在 session/new 时拉起的 posix 辅助程序。
 * 解压不还原 zip 中的 Unix 权限位，它落盘后是 0644，缺执行位时官方进程以
 * `PermissionError: [Errno 13]` 失败，JSON-RPC 只回 `Internal error`（issue #3）。
 */
export const POSIX_HELPER_EXECUTABLES = ['localharness_external'] as const

export function defaultAgentArgs(platform: NodeJS.Platform = process.platform): readonly string[] {
  return platform === 'linux' ? [...ACP_DISTRIBUTIONS.linux.defaultArgs] : []
}

/** 拼接官方下载 URL，架构命名与本地 Node 架构名称分开处理。 */
export function resolveDownloadUrl(
  platform: AcpPlatform,
  arch: AcpArch,
  version: string = DEFAULT_ACP_SERVER_VERSION,
): string {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new AgyBinaryError(AGY_BINARY_ERROR.BLOCKED_URL, 'ACP 版本号格式无效')
  }
  const distribution = ACP_DISTRIBUTIONS[platform]
  const publishedArch = arch === 'aarch64' ? 'arm64' : 'x86_64'
  return `https://${DOWNLOAD_HOST_WHITELIST}/agy-extensions/releases/${distribution.directory}/agy-acp-server-${version}-${platform}-${publishedArch}.zip`
}

/** 校验下载 URL：仅 https + 白名单域名，其余一律拒绝。 */
export function assertDownloadUrl(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (cause) {
    throw new AgyBinaryError(AGY_BINARY_ERROR.BLOCKED_URL, `下载 URL 无法解析: ${url}`, { cause })
  }
  if (parsed.protocol !== 'https:') {
    throw new AgyBinaryError(AGY_BINARY_ERROR.BLOCKED_URL, `仅允许 https 下载，拒绝: ${parsed.protocol}`)
  }
  if (parsed.hostname !== DOWNLOAD_HOST_WHITELIST) {
    throw new AgyBinaryError(AGY_BINARY_ERROR.BLOCKED_URL, `仅允许 ${DOWNLOAD_HOST_WHITELIST} 域，拒绝: ${parsed.hostname}`)
  }
  return parsed
}

/** downloadBinary 可注入的最小 HTTP 响应形状（结构化，便于测试伪造）。 */
export interface HttpResponseLike {
  ok: boolean
  status: number
  arrayBuffer(): Promise<ArrayBuffer>
  body?: unknown
}

export type FetchLike = (
  url: string,
  init: { redirect: 'manual'; signal?: AbortSignal },
) => Promise<HttpResponseLike>

/** 执行下载请求并校验安全策略（白名单域名、https、拒绝 3xx 重定向、2xx 状态）。 */
async function fetchDownloadResponse(
  url: string,
  options: { fetchImpl?: FetchLike; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<HttpResponseLike> {
  assertDownloadUrl(url)
  const doFetch: FetchLike = options.fetchImpl ?? ((url2, init) => fetch(url2, init))
  // 整体超时：无超时的 fetch 在网络挂住时会让首轮对话永远等下去（连同 single-flight
  // 汇聚的所有并发回合）。调用方的 signal（卸载取消）与超时任一触发都中止。
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const response = await doFetch(url, { redirect: 'manual', signal })
  if (response.status >= 300 && response.status < 400) {
    throw new AgyBinaryError(
      AGY_BINARY_ERROR.REDIRECT_REFUSED,
      `下载返回重定向 ${response.status}，安全策略拒绝跟随: ${url}`,
    )
  }
  if (!response.ok) {
    throw new AgyBinaryError(AGY_BINARY_ERROR.BAD_STATUS, `下载失败，HTTP ${response.status}: ${url}`)
  }
  return response
}

/**
 * 下载二进制到内存。redirect 显式设为 'manual'，任何 3xx 都视为错误——
 * 官方分发应直链；重定向意味着 URL 失效或被劫持，不跟随。
 */
export async function downloadBinary(
  url: string,
  options: { fetchImpl?: FetchLike; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Uint8Array> {
  const response = await fetchDownloadResponse(url, options)
  return new Uint8Array(await response.arrayBuffer())
}

/** Compressed input is bounded before ZIP inspection or extraction. */
export const MAX_ARCHIVE_BYTES = 1_536 * 1_024 * 1_024

function limitArchiveSize(): Transform {
  let bytes = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, next) {
      bytes += chunk.length
      if (bytes > MAX_ARCHIVE_BYTES) next(new AgyBinaryError(AGY_BINARY_ERROR.ARCHIVE_TOO_LARGE, '官方归档超出下载大小上限'))
      else next(null, chunk)
    },
  })
}

/**
 * 流式下载二进制并直接写入指定文件路径。
 * 若 response.body 提供可读流则以管道直写，避免将 ~100MB 的 zip 整包载入 V8 堆内存；
 * 若未提供流（如测试用 arrayBuffer 替身）则回退到 arrayBuffer 写入。
 */
export async function downloadBinaryToFile(
  url: string,
  destPath: string,
  options: { fetchImpl?: FetchLike; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  const response = await fetchDownloadResponse(url, options)
  if (response.body && typeof Readable.fromWeb === 'function') {
    try {
      const nodeStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
      await pipeline(nodeStream, limitArchiveSize(), createWriteStream(destPath, { flags: 'wx', mode: 0o600 }))
      return
    } catch (error) {
      // body 已经被流式读取消费，再调 `response.arrayBuffer()` 只会抛
      // 「Body is unusable」，把断网/超时/写盘失败的真实原因盖掉。直接上报。
      if (error instanceof AgyBinaryError) throw error
      throw new AgyBinaryError(
        AGY_BINARY_ERROR.TRANSFER_FAILED,
        `下载中断（${url}）：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }
  // 没有可读流（测试替身或探针响应）时才走整包读取。
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new AgyBinaryError(AGY_BINARY_ERROR.ARCHIVE_TOO_LARGE, '官方归档超出下载大小上限')
  await writeFile(destPath, bytes, { flag: 'wx', mode: 0o600 })
}

/**
 * 校验单个 zip 条目路径，返回规范化的 POSIX 相对路径（目录条目保留尾随 `/`）。
 *
 * 拒绝：空路径、反斜杠分隔、绝对路径、Windows 盘符、`.`/`..` 段、中间空段。
 * 放行：以 `/` 结尾的**目录条目**（`dir/`、`dir/sub/`）——它们是合法的 zip
 * 布局（yauzl 的 validateFileName 同样接受），其尾随斜杠只是「这是目录」的
 * 标记，不构成路径穿越或绝对路径；解压时按目录创建。
 */
export function validateZipEntryPath(entryName: string): string {
  if (entryName.length === 0) {
    throw new AgyBinaryError(AGY_BINARY_ERROR.UNSAFE_ENTRY, 'zip 条目路径为空')
  }
  if (entryName.includes('\\')) {
    throw new AgyBinaryError(AGY_BINARY_ERROR.UNSAFE_ENTRY, `zip 条目含反斜杠分隔符（Windows 路径注入嫌疑）: ${entryName}`)
  }
  if (entryName.startsWith('/')) {
    throw new AgyBinaryError(AGY_BINARY_ERROR.UNSAFE_ENTRY, `zip 条目为绝对路径: ${entryName}`)
  }
  if (/^[A-Za-z]:/.test(entryName)) {
    throw new AgyBinaryError(AGY_BINARY_ERROR.UNSAFE_ENTRY, `zip 条目含 Windows 盘符: ${entryName}`)
  }
  const isDirectory = entryName.endsWith('/')
  // 目录条目：只在末尾允许一个空段（`dir//` 这类畸形写法仍会在下面的循环里被拒）。
  const segments = isDirectory ? entryName.split('/').slice(0, -1) : entryName.split('/')
  if (segments.length === 0) {
    throw new AgyBinaryError(AGY_BINARY_ERROR.UNSAFE_ENTRY, `zip 条目含非法段（空/./..）: ${entryName}`)
  }
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new AgyBinaryError(AGY_BINARY_ERROR.UNSAFE_ENTRY, `zip 条目含非法段（空/./..）: ${entryName}`)
    }
  }
  return isDirectory ? `${segments.join('/')}/` : segments.join('/')
}

/**
 * 从已校验的相对条目列表里挑出 ACP server 可执行文件。
 * 优先只接受官方入口名，兼容旧版 hyphen 拼写。挑选必须确定性：取路径深度最小、
 * 同深度取字典序最小。找不到抛 AGY_ARCHIVE_LAYOUT。
 */
export function pickExecutablePath(entries: readonly string[], flavor: ExecutableFlavor): string {
  const candidates = entries.filter((entry) => {
    if (entry.endsWith('/')) return false
    const base = entry.split('/').at(-1) ?? ''
    if (flavor === 'windows') return /^(agy_acp_server|agy-acp-server)\.exe$/i.test(base)
    return base === 'agy_acp_server.par' || base === 'agy-acp-server' || base === 'agy_acp_server'
  })
  if (candidates.length === 0) {
    throw new AgyBinaryError(
      AGY_BINARY_ERROR.ARCHIVE_LAYOUT,
      `zip 内未找到 ACP server 可执行文件（flavor=${flavor}，条目数=${entries.length}）`,
    )
  }
  const depth = (entry: string): number => entry.split('/').length
  return candidates
    .slice()
    .sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0))
    .at(0)!
}

/** 解压目标子目录名（限定在版本缓存目录内）。 */
export function extractDirName(version: string): string {
  return `extract-${version}`
}

/**
 * 解析缓存根目录（**只放数据，不放可执行文件**）。优先 $DSH_HOME（宿主注入的
 * 环境变量）；缺失时回退到用户 home 下的 `.dsh`（与 DSH 默认 home 布局一致，
 * 注释性回退而非承诺）；两者都不可用则退到系统临时目录，保证本插件在无
 * DSH_HOME 的开发环境也能运行。
 *
 * 注意：目录树可能带 Low 强制完整性标签，因此**可执行文件绝不能装在这里**，
 * 见 {@link resolveInstallRoot}。
 */
export function resolveCacheDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  homedir: () => string = osHomedir,
): string {
  const dshHome = env.DSH_HOME
  if (dshHome && dshHome.trim().length > 0) {
    return join(dshHome, ...CACHE_SUBPATH)
  }
  try {
    return join(homedir(), '.dsh', ...CACHE_SUBPATH)
  } catch {
    return join(tmpdir(), 'dsh-antigravity-cache')
  }
}

/**
 * 解析**可执行文件**安装根目录——刻意不放在 `$DSH_HOME` 之下。
 *
 * ## 为什么必须离开 DSH home
 *
 * DSH 把 `$DSH_HOME`（默认 `~/.dsh`）整棵树显式标成 **Low 强制完整性**
 * （`icacls` 可见 `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`，属沙箱地基），
 * 新建文件一律继承该标签；而 Windows 在创建进程时**会采用映像文件的强制完整性
 * 标签**。于是装在 `~/.dsh` 下的官方 exe 只能以 LOW 运行，受 MIC「禁止向上写」
 * 约束，写不进中等完整性的 `~/.gemini/antigravity-acp/`——官方 server 保存凭据用的
 * `tempfile.NamedTemporaryFile` 会因此在 `PermissionError` 上无限重试，
 * `session/new` 永不返回（2026-10-16 实测定位，详见 `integrity.ts`）。
 *
 * 因此安装根默认取用户级应用数据目录（Windows: `%LOCALAPPDATA%`；
 * POSIX: `$XDG_CACHE_HOME` 或 `~/.cache`），它们不在 Low 标签树内。
 * `AGY_ACP_HOME` 用于指定私有安装根目录。
 */
export function resolveInstallRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  homedir: () => string = osHomedir,
): string {
  const override = env[INSTALL_ROOT_ENV]
  if (override && override.trim().length > 0) return override.trim()
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim()
    if (localAppData) return win32.join(localAppData, INSTALL_DIR_NAME)
    const profile = env.USERPROFILE?.trim()
    if (profile) return win32.join(profile, 'AppData', 'Local', INSTALL_DIR_NAME)
    throw new AgyBinaryError(AGY_BINARY_ERROR.UNVERIFIED, '缺少私有安装目录，请设置 AGY_ACP_HOME')
  }
  const xdgCache = env.XDG_CACHE_HOME?.trim()
  if (xdgCache) return join(xdgCache, INSTALL_DIR_NAME)
  try {
    return join(homedir(), '.cache', INSTALL_DIR_NAME)
  } catch {
    throw new AgyBinaryError(AGY_BINARY_ERROR.UNVERIFIED, '缺少私有安装目录，请设置 AGY_ACP_HOME')
  }
}

/** 版本缓存目录与其解压子目录。 */
export function versionCachePaths(cacheDir: string, version: string): { versionDir: string; extractDir: string } {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new AgyBinaryError(AGY_BINARY_ERROR.BLOCKED_URL, 'ACP 版本号格式无效')
  }
  const versionDir = join(cacheDir, version)
  return { versionDir, extractDir: join(versionDir, extractDirName(version)) }
}

/** 运行代码与可执行文件同属用户级安装根，禁止放回 Low 标签的数据缓存树。 */
export function resolveRuntimeRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  homedir: () => string = osHomedir,
): string {
  return join(resolveInstallRoot(env, platform, homedir), 'runtime')
}

const OWNER_FILE = 'dsh-owner.json'
const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString()
interface DirectoryOwner { version: 1; pid: number; id: string; startedAt: string; state: 'active' | 'exited' }
export interface RuntimeDirectory { path: string; root: string; ownerId: string }
export type RuntimeDirectoryLease = RuntimeDirectory
export type ProcessLiveness = (pid: number) => boolean | undefined | Promise<boolean | undefined>

/** 只把 ESRCH 视为死亡；权限不足、PID 复用或任何未知状态均保留文件。 */
export function isProcessAlive(pid: number): boolean | undefined {
  try { process.kill(pid, 0); return true } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : undefined
  }
}

async function writeDirectoryOwner(path: string, pid = process.pid): Promise<DirectoryOwner> {
  const owner: DirectoryOwner = { version: 1, pid, id: randomUUID(), startedAt: PROCESS_STARTED_AT, state: 'active' }
  await writeFile(join(path, OWNER_FILE), JSON.stringify(owner), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  return owner
}

async function readDirectoryOwner(path: string): Promise<DirectoryOwner | undefined> {
  try {
    const file = join(path, OWNER_FILE)
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) return undefined
    const value = JSON.parse(await readFile(file, 'utf8')) as DirectoryOwner
    return value.version === 1 && Number.isSafeInteger(value.pid) && value.pid > 0
      && typeof value.id === 'string' && value.id.length > 0 && typeof value.startedAt === 'string'
      ? value : undefined
  } catch { return undefined }
}

/** 创建一次启动独占的目录。调用方需在 spawn 前检查 Windows 完整性标签。 */
export async function createRuntimeDirectory(options: { root?: string; ownerPid?: number } = {}): Promise<RuntimeDirectory> {
  const requestedRoot = resolve(options.root ?? resolveRuntimeRoot())
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 })
  const root = await realpath(requestedRoot)
  const path = await mkdtemp(join(root, 'instance-'))
  try {
    const owner = await writeDirectoryOwner(path, options.ownerPid)
    return { path, root, ownerId: owner.id }
  } catch (error) {
    await rm(path, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

async function isOwnedDirectChild(path: string, root: string, prefix: string): Promise<boolean> {
  const target = resolve(path)
  if (dirname(target) !== resolve(root) || !target.slice(dirname(target).length + 1).startsWith(prefix)) return false
  try {
    const info = await lstat(target)
    return info.isDirectory() && !info.isSymbolicLink() && await realpath(target) === target
  } catch { return false }
}

/** 仅在关联子进程已确认退出后调用；ownerId 防止清除后来替换的目录。 */
export async function releaseRuntimeDirectory(lease: RuntimeDirectory): Promise<void> {
  if (!(await isOwnedDirectChild(lease.path, lease.root, 'instance-'))) return
  const owner = await readDirectoryOwner(lease.path)
  if (owner?.id !== lease.ownerId) return
  // 先记下由 waitForExit 证实的退出事实，删除受文件锁阻塞时可在后续启动重试。
  await writeFile(join(lease.path, OWNER_FILE), JSON.stringify({ ...owner, state: 'exited' }), { encoding: 'utf8', mode: 0o600 })
  await rm(lease.path, { recursive: true, force: true, maxRetries: 2 })
}

/** 仅重试已经明确记录子进程退出的目录。宿主死亡不代表其所有后代已停止。 */
export async function cleanupStaleRuntimeDirectories(
  root: string = resolveRuntimeRoot(),
): Promise<number> {
  let canonicalRoot: string
  try { canonicalRoot = await realpath(root) } catch { return 0 }
  const entries = await readdir(canonicalRoot, { withFileTypes: true }).catch(() => [])
  let removed = 0
  for (const entry of entries) {
    const path = join(canonicalRoot, entry.name)
    if (!(await isOwnedDirectChild(path, canonicalRoot, 'instance-'))) continue
    const owner = await readDirectoryOwner(path)
    if (!owner || owner.state !== 'exited') continue
    await releaseRuntimeDirectory({ path, root: canonicalRoot, ownerId: owner.id }).then(() => { removed += 1 }, () => undefined)
  }
  return removed
}

/** PyInstaller onefile 的解压目录前缀。 */
export const PYI_TEMP_PREFIX = '_MEI'
/** 旧 API 保留的常量；不再用年龄判断运行目录能否安全删除。 */
export const PYI_TEMP_MAX_AGE_MS = 3_600_000

/**
 * @deprecated 旧版共享 _MEI 无所有权记录，不能安全自动清理。
 * 新运行目录通过 cleanupStaleRuntimeDirectories 清理。
 */
export async function cleanupStalePyiTempDirs(
  _dir: string,
  _options: { maxAgeMs?: number; now?: () => number } = {},
): Promise<number> {
  // 旧版共享 _MEI 目录没有进程所有权记录；年龄无法证明进程已死，禁止自动删除。
  return 0
}

/** 下载解压暂存目录前缀。 */
export const STAGING_DIR_PREFIX = '.staging-'
/** 判定暂存目录「陈旧」的默认阈值（1 小时）。 */
export const STAGING_MAX_AGE_MS = 3_600_000

/**
 * 清理下载或解压过程中因强杀/异常中断而残留的陈旧 `.staging-*` 目录。
 * 遍历指定目录自身及其直接子目录（如 `<installRoot>/<version>/.staging-*`）。
 * 仅删除有所有权记录、宿主 PID 已确认死亡且 mtime 超过阈值的目录。
 * 旧版未记录 owner 的目录保留，避免干扰仍在执行的安装。
 */
export async function cleanupStaleStagingDirs(
  dir: string,
  options: { maxAgeMs?: number; now?: () => number; isProcessAlive?: ProcessLiveness } = {},
): Promise<number> {
  const maxAgeMs = options.maxAgeMs ?? STAGING_MAX_AGE_MS
  const now = (options.now ?? Date.now)()
  let removed = 0
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => undefined)
  if (!entries) return 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith(STAGING_DIR_PREFIX)) {
      const target = join(dir, entry.name)
      try {
        const info = await stat(target)
        const owner = await readDirectoryOwner(target)
        if (now - info.mtimeMs >= maxAgeMs && owner && await (options.isProcessAlive ?? isProcessAlive)(owner.pid) === false) {
          await rm(target, { recursive: true, force: true, maxRetries: 2 })
          removed += 1
        }
      } catch {
        // 忽略删除失败
      }
    } else {
      const subdir = join(dir, entry.name)
      const subentries = await readdir(subdir, { withFileTypes: true }).catch(() => undefined)
      if (!subentries) continue
      for (const sub of subentries) {
        if (!sub.isDirectory() || !sub.name.startsWith(STAGING_DIR_PREFIX)) continue
        const subtarget = join(subdir, sub.name)
        try {
          const info = await stat(subtarget)
          const owner = await readDirectoryOwner(subtarget)
          if (now - info.mtimeMs >= maxAgeMs && owner && await (options.isProcessAlive ?? isProcessAlive)(owner.pid) === false) {
            await rm(subtarget, { recursive: true, force: true, maxRetries: 2 })
            removed += 1
          }
        } catch {
          // 忽略删除失败
        }
      }
    }
  }
  return removed
}

/**
 * Node 的 process.platform / process.arch → 下载坐标映射。
 * 未登记的平台或架构无法解析到可信发行包。
 */
export function mapNodePlatform(platform: NodeJS.Platform, arch: string): { platform: AcpPlatform; arch: AcpArch } {
  const mappedPlatform: AcpPlatform | undefined =
    platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : undefined
  const mappedArch: AcpArch | undefined = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : undefined
  if (!mappedPlatform || !mappedArch) {
    throw new AgyBinaryError(
      AGY_BINARY_ERROR.PLATFORM_UNSUPPORTED,
      `未知平台组合 ${platform}/${arch}；此平台没有可验证的官方发行包`,
    )
  }
  return { platform: mappedPlatform, arch: mappedArch }
}

/** posix 解压产物补执行位：主程序与同目录的辅助程序（存在且为普通文件时）。 */
export async function ensureExecutable(
  file: string,
  flavor: ExecutableFlavor,
  chmodImpl: (path: string, mode: number) => Promise<void> = chmod,
): Promise<void> {
  if (flavor === 'posix') {
    await chmodImpl(file, 0o755)
    for (const name of POSIX_HELPER_EXECUTABLES) {
      const helper = join(dirname(file), name)
      const info = await lstat(helper).catch(() => undefined)
      if (info?.isFile()) await chmodImpl(helper, 0o755)
    }
  } else {
    // windows 无需额外操作；存在性检查交给调用方。
    await access(file)
  }
}

/** 解压上限；默认取文件顶部常量，测试可注入小值验证守卫本身。 */
export interface ExtractLimits {
  maxEntries?: number
  maxTotalBytes?: number
  maxEntryBytes?: number
}

/** 用 yauzl 把 zip 安全解到 destDir；返回全部已校验的相对条目路径。 */
export async function extractZipSafely(zipPath: string, destDir: string, limits: ExtractLimits = {}): Promise<readonly string[]> {
  const maxEntries = limits.maxEntries ?? MAX_EXTRACT_ENTRIES
  const maxTotalBytes = limits.maxTotalBytes ?? MAX_EXTRACT_BYTES
  const maxEntryBytes = limits.maxEntryBytes ?? MAX_EXTRACT_ENTRY_BYTES
  const zip = await new Promise<yauzl.ZipFile>((resolveOpen, rejectOpen) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (error, file) => {
      if (error) rejectOpen(new AgyBinaryError(AGY_BINARY_ERROR.ARCHIVE_READ, `无法打开 zip: ${zipPath}`, { cause: error }))
      else resolveOpen(file!)
    })
  })
  const extracted: string[] = []
  let entryCount = 0
  let totalBytes = 0
  try {
    for (;;) {
      const entry = await new Promise<yauzl.Entry | null>((resolveNext, rejectNext) => {
        // 每次读取只挂一条 entry/error/end 监听，settle 后立即摘除：条目很多时
        // 累积监听器会触发 MaxListenersExceededWarning，并让旧条目的事件重复结算。
        let settled = false
        const cleanup = (): void => {
          zip.removeListener('entry', onEntry)
          zip.removeListener('error', onError)
          zip.removeListener('end', onEnd)
        }
        const settleOnce = (run: () => void): void => {
          if (settled) return
          settled = true
          cleanup()
          run()
        }
        const onEntry = (e: yauzl.Entry): void => settleOnce(() => resolveNext(e))
        // yauzl 自身也会对恶意 fileName 报 error（absolute path / invalid
        // relative path / invalid characters in fileName）；统一映射为
        // UNSAFE_ENTRY，与我们的条目校验共用一个错误码。
        const onError = (error: Error): void => settleOnce(() => {
          const message = error instanceof Error ? error.message : String(error)
          const unsafe = /fileName|relative path|absolute path/.test(message)
          rejectNext(
            new AgyBinaryError(
              unsafe ? AGY_BINARY_ERROR.UNSAFE_ENTRY : AGY_BINARY_ERROR.ARCHIVE_READ,
              `读取 zip 条目失败: ${zipPath}`,
              { cause: error },
            ),
          )
        })
        const onEnd = (): void => settleOnce(() => resolveNext(null))
        zip.on('entry', onEntry)
        zip.on('error', onError)
        zip.on('end', onEnd)
        zip.readEntry()
      })
      if (!entry) break
      // 上限判定先于任何写盘：解压炸弹必须在产生磁盘副作用之前拦住。
      entryCount += 1
      if (entryCount > maxEntries) {
        throw new AgyBinaryError(
          AGY_BINARY_ERROR.ARCHIVE_TOO_LARGE,
          `zip 条目数超过上限 ${maxEntries}：${zipPath}`,
        )
      }
      const declared = entry.uncompressedSize
      if (declared > maxEntryBytes) {
        throw new AgyBinaryError(
          AGY_BINARY_ERROR.ARCHIVE_TOO_LARGE,
          `zip 条目声明大小超过上限 ${maxEntryBytes} 字节：${entry.fileName}`,
        )
      }
      totalBytes += declared
      if (totalBytes > maxTotalBytes) {
        throw new AgyBinaryError(
          AGY_BINARY_ERROR.ARCHIVE_TOO_LARGE,
          `zip 解压后总大小超过上限 ${maxTotalBytes} 字节：${zipPath}`,
        )
      }
      const safeRelative = validateZipEntryPath(entry.fileName)
      // 双保险：join 后的绝对路径必须仍限定在 destDir 内。
      const target = resolve(destDir, safeRelative)
      if (target !== normalize(destDir) && !target.startsWith(normalize(destDir) + sep)) {
        throw new AgyBinaryError(AGY_BINARY_ERROR.UNSAFE_ENTRY, `zip 条目逃出解压目录: ${entry.fileName}`)
      }
      if (entry.fileName.endsWith('/')) {
        await mkdir(target, { recursive: true })
        continue
      }
      await mkdir(dirname(target), { recursive: true })
      // 中央目录里声明的 uncompressedSize 可以撒谎（zip 允许缺失/伪造）。
      // 当前 yauzl 默认开启 validateEntrySizes，声明不符会在流内就报错，所以
      // 正常情况下走不到这里的上限；它守的是「该校验被关掉或换实现」的纵深，
      // 以及单条目合规但累计超限时必须按实际字节即时中止。
      let written = 0
      const budget = Math.min(maxEntryBytes, maxTotalBytes - (totalBytes - declared))
      const guard = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          written += chunk.length
          if (written > budget) {
            callback(new AgyBinaryError(
              AGY_BINARY_ERROR.ARCHIVE_TOO_LARGE,
              `zip 条目实际大小超过上限 ${budget} 字节：${entry.fileName}`,
            ))
            return
          }
          callback(null, chunk)
        },
      })
      await new Promise<void>((resolveWrite, rejectWrite) => {
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            rejectWrite(new AgyBinaryError(AGY_BINARY_ERROR.ARCHIVE_READ, `读取条目内容失败: ${entry.fileName}`, { cause: error }))
            return
          }
          // yauzl 的 openReadStream 产出 node Readable；经 guard 后写盘。
          pipeline(stream, guard, createWriteStream(target))
            // 把预检时按「声明值」记的账改成「实际写出值」：声明偏大时不把没写出的
            // 字节算作已用，避免后续条目被虚假的累计量挤掉。夹到非负，防止异常
            // 时序下 totalBytes 漂成负数后反过来放宽上限。
            .then(() => { totalBytes = Math.max(0, totalBytes - declared + written); resolveWrite() })
            .catch((cause) => rejectWrite(cause instanceof AgyBinaryError
              ? cause
              : new AgyBinaryError(AGY_BINARY_ERROR.ARCHIVE_READ, `写出条目失败: ${entry.fileName}`, { cause })))
        })
      })
      extracted.push(safeRelative)
    }
  } finally {
    zip.close()
  }
  return extracted
}

export interface AgentBinaryResolution {
  executablePath: string
  source: 'cache' | 'download'
  version: string
  checksumVerified: true
  /** Release only when the spawned agent and its helpers have exited. */
  release(): Promise<void>
}

export interface AgentBinaryOptions {
  /** Legacy configuration is rejected explicitly to avoid executing unsigned local files. */
  binaryPath?: string
  autoDownload?: boolean
  version?: string
  downloadUrl?: string
  fetchImpl?: FetchLike
  signal?: AbortSignal
  env?: Readonly<Record<string, string | undefined>>
  cacheDir?: string
  platform?: NodeJS.Platform
  arch?: string
}

/** The runtime root must not allow another local user to substitute a launch directory. */
async function preparePrivateRoot(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const canonical = await realpath(path)
  const uid = process.getuid?.()
  if (uid !== undefined) {
    // Walk canonical parents as well. A sticky shared ancestor (e.g. /tmp) protects a user-owned entry.
    for (let current = canonical;; current = dirname(current)) {
      const info = await lstat(current)
      const trustedOwner = info.uid === uid || info.uid === 0
      const writableByOthers = (info.mode & 0o022) !== 0
      const stickyAncestor = current !== canonical && (info.mode & 0o1000) !== 0
      if (!info.isDirectory() || !trustedOwner || (writableByOthers && !stickyAncestor)) {
        throw new AgyBinaryError(AGY_BINARY_ERROR.UNVERIFIED, '官方 ACP 运行目录或其父目录允许其他用户修改')
      }
      if (dirname(current) === current) break
    }
  }
  return canonical
}

/** Copy untrusted cache bytes into a private file before hashing and opening them as a ZIP. */
async function snapshotCachedArchive(path: string, dest: string, signal?: AbortSignal): Promise<boolean> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!file) return false
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > MAX_ARCHIVE_BYTES) {
      throw new AgyBinaryError(AGY_BINARY_ERROR.UNVERIFIED, '归档缓存不是大小允许的普通文件')
    }
    await pipeline(file.createReadStream({ autoClose: false }), limitArchiveSize(),
      createWriteStream(dest, { flags: 'wx', mode: 0o600 }), { signal })
    return true
  } finally {
    await file.close()
  }
}

async function verifyArchive(path: string, expected: string, signal?: AbortSignal): Promise<void> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash, { signal })
  if (hash.digest('hex') !== expected) {
    throw new AgyBinaryError(AGY_BINARY_ERROR.UNVERIFIED, '官方 ACP 归档 SHA-256 不匹配，已拒绝启动；请替换或移除损坏的 ZIP 缓存')
  }
}

/** Verify the entire platform archive and materialize a fresh private copy of every executable for this launch. */
export async function ensureAgentBinary(options: AgentBinaryOptions = {}): Promise<AgentBinaryResolution> {
  const env = options.env ?? process.env
  if (options.binaryPath?.trim() || env.AGY_ACP_BIN?.trim() || options.downloadUrl?.trim() || env.AGY_ACP_URL?.trim()) {
    throw new AgyBinaryError(AGY_BINARY_ERROR.UNVERIFIED, '仅接受已登记的官方 ACP 归档，禁止自定义可执行文件或下载地址')
  }
  const version = options.version ?? DEFAULT_ACP_SERVER_VERSION
  const { platform, arch } = mapNodePlatform(options.platform ?? process.platform, options.arch ?? process.arch)
  const expected = officialArchiveDigest(version, platform, arch)
  if (!expected) throw new AgyBinaryError(AGY_BINARY_ERROR.UNVERIFIED, '此 ACP 版本尚无已登记的 SHA-256')
  const cacheDir = await preparePrivateRoot(options.cacheDir ?? resolveInstallRoot(env))
  const { versionDir } = versionCachePaths(cacheDir, version)
  const versionRoot = await preparePrivateRoot(versionDir)
  const runRoot = await preparePrivateRoot(join(cacheDir, 'runtime'))
  const cache = join(versionRoot, `official-${platform}-${arch}.zip`)
  const lease = await createRuntimeDirectory({ root: runRoot })
  const archive = join(lease.path, 'release.zip')
  const release = () => releaseRuntimeDirectory(lease)
  try {
    const cached = await snapshotCachedArchive(cache, archive, options.signal)
    if (!cached) {
      if (options.autoDownload === false) {
        throw new AgyBinaryError(AGY_BINARY_ERROR.BINARY_MISSING, '未找到官方 ZIP 缓存且已禁用自动下载')
      }
      await downloadBinaryToFile(resolveDownloadUrl(platform, arch, version), archive, options)
    }
    await verifyArchive(archive, expected, options.signal)
    const extracted = join(lease.path, 'bin')
    await mkdir(extracted, { mode: 0o700 })
    const entries = await extractZipSafely(archive, extracted)
    options.signal?.throwIfAborted()
    const entry = ACP_DISTRIBUTIONS[platform].executable
    if (!entries.includes(entry)) throw new AgyBinaryError(AGY_BINARY_ERROR.ARCHIVE_LAYOUT, '官方 ACP 归档缺少已登记的入口')
    const executablePath = join(extracted, entry)
    await ensureExecutable(executablePath, platform === 'windows' ? 'windows' : 'posix')
    if (cached) await rm(archive)
    else {
      // Concurrent publishers only publish complete verified archives. Each launch uses its own extracted files.
      await rename(archive, cache).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error
        const winner = await lstat(cache).catch(() => undefined)
        if (!winner?.isFile()) throw error
        await rm(archive)
      })
    }
    return { executablePath, source: cached ? 'cache' : 'download', version, checksumVerified: true, release }
  } catch (error) {
    await release()
    throw error
  }
}
