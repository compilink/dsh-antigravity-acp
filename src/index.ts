/**
 * Cordis 插件入口：向 ctx.llm 注册 antigravity-acp provider 的 LlmAdapter。
 *
 * 注入 'llm'（adapter 注册表）与 'subprocess'（生命周期受管子进程服务）。
 * 子进程一律经 ctx.subprocess 创建，绝不 import child_process。
 *
 * 生命周期闭环：dispose 时终止受管进程并关闭 AgentLink，确认退出后释放运行目录，
 * 最后关闭插件进程内的私有 loopback MCP 桥。
 */
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { LlmError } from '@deepseek-ai/dsh-llm'
import { llmError } from './runtime/llm-error.js'
import type {} from '@deepseek-ai/dsh-llm'
import type { ClientCapabilities } from '@agentclientprotocol/sdk'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { AntigravityAcpAdapter, AGY_PROVIDER_ID } from './adapter/antigravity-adapter.js'
import type { AdapterMetadata } from './adapter/antigravity-adapter.js'
import { PooledAcpAdapter } from './pool/pooled-adapter.js'
import { AgentLink, agentStreamFromSubprocess, AGY_CLIENT_INFO, AGY_LINK_ERROR, launchAcpAgent } from './protocol/agent-link.js'
import type { AgentLinkHandlers } from './protocol/agent-link.js'
import {
  AGY_BINARY_ERROR,
  cleanupStaleRuntimeDirectories,
  cleanupStaleStagingDirs,
  DEFAULT_ACP_SERVER_VERSION,
  ensureAgentBinary,
  resolveCacheDir,
  resolveInstallRoot,
  createRuntimeDirectory,
  releaseRuntimeDirectory,
  defaultAgentArgs,
} from './runtime/binary.js'
import type { RuntimeDirectoryLease } from './runtime/binary.js'
import { describeLowIntegrity, isLowIntegrityTarget } from './runtime/integrity.js'
import { describeAuthWait, redactSensitiveText } from './runtime/redact.js'
import { readCachedCatalog, writeCachedCatalog } from './runtime/catalog-cache.js'
import { createFileSessionMapStore } from './runtime/session-map.js'
import { AgYAcpService, registerAgYAcpRemote } from './settings/remote.js'
import { SettingsControl } from './settings/control.js'
import { AcpLifecycle } from './runtime/lifecycle.js'
import { liveHostConfig } from './settings.js'
import type { AntigravityHostConfig, AntigravityPluginConfig } from './settings.js'
export { AGY_PROVIDER_ID } from './adapter/antigravity-adapter.js'
export { Config } from './settings.js'
export type { AntigravityHostConfig } from './settings.js'

// Loader is optional in headless compositions; its live-update event is scoped
// to the owning plugin fiber, so unrelated settings never invalidate our catalog.
declare module '@deepseek-ai/cordis' {
  interface Events {
    'loader/volatile-update'(paths: string[][]): void
  }
}

export const name = 'llm-antigravity-acp'
export const inject = ['llm', 'subprocess']

/**
 * 本插件向 agent 声明的 client 能力：**全部关闭**。
 *
 * 无人值守原则：工具一律经私有 loopback MCP 桥暴露给 agent，agent 不直接
 * 触碰宿主文件系统或终端。因此 fs 读写与 terminal 全部为 false，agent 若仍
 * 发起这些原生请求，会被 adapter 记为「非预期原生活动」并终止回合
 * （见 adapter/prompt-turn.ts）。elicitation 也一并关闭：无人应答可收集。
 */
export const AGY_CLIENT_CAPABILITIES: ClientCapabilities = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  // elicitation 整体省略：按 ACP d.ts，省略与 null 等价于不声明该能力，
  // 因此 agent 不会发起 session/create_elicitation。
}

/** 本插件持有并需在 dispose 时清理的活动 ACP 资源。 */
export interface ActiveAcpRuntime {
  cleanup?: Promise<void>
  releaseBinary?: () => Promise<void>
  directory?: RuntimeDirectoryLease
  lifecycle?: AcpLifecycle
  link?: AgentLink
  handle?: SubprocessHandle
  /**
   * 正在进行的启动流程。`ensureAcpRuntime` 的判重到写入 `link` 之间横跨
   * `ensureAgentBinary` / `mkdir` / spawn 多个 await，仅靠同步的 `active.link`
   * 检查无法阻止并发首轮各自 spawn 一条官方进程（进而孤儿一条 handle、双弹一次
   * OAuth）。这个 promise 让并发调用汇聚到同一次启动。
   */
  inflight?: Promise<AgentLink>
  /** 插件已卸载。置位后不再启动新链路，dispose 会等在途启动收尾再清理。 */
  disposed?: boolean
  /** 卸载时中止在途的二进制下载（否则卸载要等一次可能长达数分钟的下载）。 */
  abort?: AbortController
  /** 插件进程内私有 loopback MCP 桥的关闭钩子（由 adapter 登记）。 */
  bridgeTeardown?: () => Promise<void>
}

/** 关闭工具桥和在途连接，确认子进程退出后才释放其临时目录。 */
export async function disposeAcpRuntime(active: ActiveAcpRuntime): Promise<void> {
  active.disposed = true
  // 同步封住 adapter 的生产者与定时器，再切断链接；不等待桥清理才终止子进程。
  const bridgeCleanup = active.bridgeTeardown?.()
  void bridgeCleanup?.catch(() => undefined)
  active.abort?.abort(new Error('插件已卸载'))
  active.handle?.terminate()
  await active.link?.close().catch(() => undefined)
  await active.inflight?.catch(() => undefined)
  const handle = active.handle
  handle?.terminate()
  if (!handle || await handle.waitForExit(AbortSignal.timeout(10_000)).catch(() => false)) await releaseFiles(active)
  await bridgeCleanup
  active.lifecycle?.stopped('disposed')
}

export type { AgentLinkHandlers }

async function releaseFiles(active: ActiveAcpRuntime): Promise<void> {
  if (active.cleanup) await active.cleanup
  const { directory, releaseBinary } = active
  if (!directory && !releaseBinary) return
  active.directory = undefined
  active.releaseBinary = undefined
  const cleanup = (async () => {
    try {
      if (directory) await releaseRuntimeDirectory(directory)
    } finally {
      await releaseBinary?.()
    }
  })()
  active.cleanup = cleanup
  try { await cleanup }
  finally { if (active.cleanup === cleanup) active.cleanup = undefined }
}

/** 回收失败/取消的连接与其受管进程，不卸载插件；旧连接不能终止后来者。 */
export async function recycleAcpRuntime(active: ActiveAcpRuntime, link: AgentLink): Promise<void> {
  const handle = active.link === link ? active.handle : undefined
  if (active.link === link) active.lifecycle?.recycling()
  handle?.terminate()
  await link.close()
  if (handle && !await handle.waitForExit(AbortSignal.timeout(10_000))) {
    throw llmError('Antigravity ACP 受管进程未能在回收期限内退出，拒绝开启新回合', AGY_LINK_ERROR.LINK_CLOSED)
  }
  if (active.link === link) await releaseFiles(active)
  if (active.link === link) { active.link = undefined; active.lifecycle?.stopped() }
  if (handle && active.handle === handle) active.handle = undefined
}

/** 运行时取消和二进制校验的依赖。 */
export interface AcpRuntimeDeps {
  signal?: AbortSignal
  resolveBinary?: typeof ensureAgentBinary
  /** Windows 低完整性探测；默认经 ctx.subprocess 只读跑一次 icacls。 */
  probeLowIntegrity?: (executablePath: string, subprocess: SubprocessRuntime) => Promise<boolean>
}

/** 并发启动请求共用一次官方进程握手。 */
export async function ensureAcpRuntime(
  ctx: Context,
  config: AntigravityHostConfig,
  handlers: AgentLinkHandlers,
  active: ActiveAcpRuntime,
  deps: AcpRuntimeDeps = {},
): Promise<AgentLink> {
  if (active.disposed) {
    throw llmError('Antigravity ACP 插件已卸载，无法启动 ACP 链路', AGY_LINK_ERROR.LINK_CLOSED)
  }
  if (active.inflight) return active.inflight
  if (active.link) {
    if (!active.link.closed) { active.lifecycle?.reused(); return active.link }
    // 链路自己关了（对端断流 / 流读取失败 / 回收中途失败）但子进程可能仍活着、
    // handle.done 不会触发：不能把这条死链永久交给调用方，否则之后每个回合都会
    // 在 session/new 上报「ACP 链路已关闭」直到重启。终止旧进程并全新启动。
  }
  // 同步赋值：startAcpRuntime 内部第一个 await 之前不会有别的调用者插进来。
  active.lifecycle?.starting()
  const inflight = startAcpRuntime(ctx, config, handlers, active, deps)
  active.inflight = inflight
  try {
    return await inflight
  } catch (error) {
    if (!active.disposed) {
      active.lifecycle?.stopped()
      if (!deps.signal?.aborted) active.lifecycle?.failed(error)
    }
    throw error
  } finally {
    // 成功路径下 link 已就位；失败路径下这里清掉 inflight，让下次能全新重试。
    // 只有仍是本次这一个 promise 时才清，避免误删后来者的。
    if (active.inflight === inflight) active.inflight = undefined
  }
}

/** 真正执行一次启动的内部实现；调用方负责 single-flight 汇聚。 */
async function startAcpRuntime(
  ctx: Context,
  config: AntigravityHostConfig,
  handlers: AgentLinkHandlers,
  active: ActiveAcpRuntime,
  deps: AcpRuntimeDeps,
): Promise<AgentLink> {
  // Recovery belongs to the same single-flight operation as creation.
  if (active.link) await recycleAcpRuntime(active, active.link)
  if (active.handle) {
    active.handle.terminate()
    if (!await active.handle.waitForExit(AbortSignal.timeout(10_000)).catch(() => false)) {
      throw llmError('前一个 ACP 进程尚未确认退出，无法安全启动新连接', AGY_LINK_ERROR.LINK_CLOSED)
    }
    active.handle = undefined
    await releaseFiles(active)
  }
  const subprocess: SubprocessRuntime = ctx.subprocess
  active.abort ??= new AbortController()
  const startupSignal = AbortSignal.any([active.abort.signal, ...(deps.signal ? [deps.signal] : [])])
  startupSignal.throwIfAborted()
  const resolution = await (deps.resolveBinary ?? ensureAgentBinary)({
    autoDownload: config.autoDownload,
    version: config.acpVersion,
    signal: startupSignal,
  })
  active.releaseBinary = resolution.release
  try {
    // Windows：映像文件若带 Low 强制完整性标签（例如装在带该标签的 DSH home 下），
    // 官方进程会被降成 LOW，受 MIC「禁止向上写」约束而写不进 ~/.gemini/antigravity-acp，
    // 表现为 session/new 永久挂起。这里只读探测一次并显式报错，不把挂死留给用户。
    const probeLowIntegrity =
      deps.probeLowIntegrity ?? ((path: string, sp: SubprocessRuntime) => isLowIntegrityTarget(path, (target) => runIcacls(sp, target)))
    if (await probeLowIntegrity(resolution.executablePath, subprocess)) {
      throw llmError(describeLowIntegrity(resolution.executablePath), AGY_BINARY_ERROR.LOW_INTEGRITY)
    }
    // 下载可能耗时数分钟，期间插件可能被卸载：这时不再 spawn，避免出现一个
    // dispose 之后才出生、无人终止的进程。
    if (active.disposed) {
      throw llmError('Antigravity ACP 插件已卸载，取消启动 ACP 链路', AGY_LINK_ERROR.LINK_CLOSED)
    }
    startupSignal.throwIfAborted()
    active.lifecycle?.startupPhase('spawn')
    const directory = await createRuntimeDirectory()
    active.directory = directory
    let handle: SubprocessHandle
    try {
      startupSignal.throwIfAborted()
      if (await probeLowIntegrity(directory.path, subprocess)) {
        throw llmError(describeLowIntegrity(directory.path), AGY_BINARY_ERROR.LOW_INTEGRITY)
      }
      startupSignal.throwIfAborted()
      handle = launchAcpAgent(subprocess, {
        executable: resolution.executablePath,
        extraArgs: defaultAgentArgs(),
        tmpDir: directory.path,
      })
    } catch (error) {
      await releaseRuntimeDirectory(directory).catch(() => undefined)
      active.directory = undefined
      throw error
    }
    active.handle = handle
    active.lifecycle?.spawned()
    let link: AgentLink | undefined
    const cancelStartup = (): void => {
      handle.terminate()
      void link?.close().catch(() => undefined)
    }
    try {
      link = new AgentLink({
        stream: agentStreamFromSubprocess(handle),
        clientInfo: AGY_CLIENT_INFO,
        handlers,
        requestTimeoutMs: config.requestTimeoutMs,
        handshakeTimeoutMs: config.handshakeTimeoutMs ?? 120_000,
        // 认证需要人工在浏览器里点授权，走独立的更长超时（默认 5 分钟）。
        authTimeoutMs: config.authTimeoutMs,
        // session/new 失败（如辅助程序缺执行位）只回 Internal error，附脱敏 stderr 尾部。
        diagnostics: () => readStderr(handle) || undefined,
      })
      startupSignal.addEventListener('abort', cancelStartup, { once: true })
      link.start()
      startupSignal.throwIfAborted()
      // initialize 上报关闭全部本地能力的 clientCapabilities（ACP v1 的
      // ClientCapabilities 属于 initialize 请求，session/new 没有这个字段）。
      active.lifecycle?.startupPhase('initialize')
      await link.initialize({ clientCapabilities: AGY_CLIENT_CAPABILITIES })
      startupSignal.throwIfAborted()
    } catch (error) {
      // Handshake errors leave the process attached until its exit is confirmed.
      handle.terminate()
      await link?.close().catch(() => undefined)
      if (await handle.waitForExit(AbortSignal.timeout(10_000)).catch(() => false)) {
        await releaseRuntimeDirectory(directory).catch(() => undefined)
        if (active.directory === directory) active.directory = undefined
        if (active.handle === handle) active.handle = undefined
      }
      throw toLaunchError(error, readStderr(handle))
    } finally {
      startupSignal.removeEventListener('abort', cancelStartup)
    }
    // The official service checks authentication when creating a session.
    active.link = link
    const readyLink = link
    active.lifecycle?.ready()
    const startup = active.lifecycle?.read().startup
    if (startup) ctx.logger?.info?.(`antigravity-acp: ACP 连接就绪 startupMs=${Math.round(startup.elapsedMs)} timings=${JSON.stringify(startup.timings)}`)
    // 子进程意外退出：清掉 active 上的指向，否则下次 ensureAcpRuntime 会因
    // `if (active.link) return active.link` 永久复用死链（S2 的姊妹场景）。
    void handle.done
      .catch(() => undefined)
      .then(async () => {
        const exited = await handle.waitForExit(AbortSignal.timeout(10_000)).catch(() => false)
        if (exited && active.directory === directory) await releaseFiles(active).catch(() => undefined)
        if (active.link === readyLink && exited) { active.link = undefined; active.lifecycle?.stopped() }
        if (active.handle === handle && exited) active.handle = undefined
        await readyLink.close().catch(() => undefined)
      })
    return link
  } catch (error) {
    if (!active.handle) await releaseFiles(active)
    throw error
  }
}

/**
 * 读取并脱敏官方进程的 stderr 尾部。官方会把完整 OAuth 授权 URL（含 state、
 * code_challenge）打进 stderr，未脱敏的原文不能进入错误消息。
 */
function readStderr(handle: SubprocessHandle): string {
  const raw = handle.collected.stderr?.readFrom(0).text.trim() ?? ''
  return redactSensitiveText(raw).slice(-1500)
}

/**
 * 只读跑一次 `icacls <目标>` 读强制完整性标签。
 *
 * 经宿主的 subprocess 服务执行（本插件不 import child_process）；任何失败都返回
 * undefined，由调用方 fail-open——探测不可用不能让正常配置变得不可用。
 */
async function runIcacls(subprocess: SubprocessRuntime, target: string): Promise<string | undefined> {
  try {
    const handle = subprocess.spawn({
      argv: ['icacls', target],
      cwd: dirname(target),
      env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' },
      stdio: { stdin: 'ignore', stdout: { maxBytes: 32 * 1024 }, stderr: { maxBytes: 8 * 1024 } },
      graceMs: 3_000,
      signal: AbortSignal.timeout(10_000),
    })
    await handle.done.catch(() => undefined)
    return handle.collected.stdout?.readFrom(0).text
  } catch {
    return undefined
  }
}

/** 只附加已脱敏的官方进程诊断。 */
function toLaunchError(error: unknown, stderr: string): LlmError {
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'AGY_LINK_CLOSED'
  const message = error instanceof Error ? error.message : String(error)
  const waitingForLogin = describeAuthWait(stderr) !== undefined
  const detail = waitingForLogin ? describeAuthWait(stderr) : stderr || undefined
  return llmError(
    detail ? `${message}（诊断：${detail}）` : message,
    code,
    { cause: error },
  )
}

export function apply(ctx: Context, input: AntigravityPluginConfig): void {
  const config = liveHostConfig(input)
  const cacheDir = resolveCacheDir()
  const acpVersion = config.acpVersion ?? DEFAULT_ACP_SERVER_VERSION

  // 只回收带本插件所有权且已确认退出的运行目录；未知 / 活跃目录不按年龄删除。
  void cleanupStaleRuntimeDirectories().catch(() => 0)
  void cleanupStaleStagingDirs(resolveInstallRoot()).catch(() => 0)

  let modelCatalogRevision = 0
  const catalogChanged = (): void => {
    modelCatalogRevision++
    // The host model picker subscribes to this existing registry notification.
    try { ctx.emit('llm/adapters-updated') } catch { /* Observers cannot veto catalog updates. */ }
  }
  ctx.on('loader/volatile-update', (paths) => {
    // 模型显示开关、默认档位与映射都会改变选择器与路由，需要通知宿主刷新目录。
    if (paths.some(([key]) => key === 'modelOverrides')) catalogChanged()
  })
  let attachmentStore: AttachmentStore | undefined

  // The store is lazy: no lock or file is opened until recovery is enabled and used.
  const sessionStore = createFileSessionMapStore(cacheDir,
    () => ctx.logger?.warn?.('antigravity-acp: 会话映射不可用或由另一 Host 占用，跨进程恢复已降级；不影响本地聊天'),
  )
  const workers: AntigravityAcpAdapter[] = []
  let metadata: AdapterMetadata | undefined
  // Serialize binary setup across workers; inference remains concurrent.
  let startupBarrier: Promise<unknown> = Promise.resolve()
  const adapter = new PooledAcpAdapter(() => {
    const lifecycle = new AcpLifecycle()
    const active: ActiveAcpRuntime = { lifecycle }
    const worker = new AntigravityAcpAdapter({
      lifecycle,
      // handler 对象由 adapter 构造时创建且身份稳定：AgentLink 只在构造时取一次
      // handlers，后续回合只更换 adapter 内部的当前回合。
      getLink: (handlers, signal) => {
        const launch = startupBarrier.catch(() => undefined).then(() => {
          signal?.throwIfAborted()
          return ensureAcpRuntime(ctx, { ...config }, handlers, active, { signal })
        })
        startupBarrier = launch.then(() => undefined, () => undefined)
        return launch
      },
      recycleLink: (link) => recycleAcpRuntime(active, link),
      registerBridgeTeardown: (teardown) => {
        active.bridgeTeardown = teardown
      },
      promptTimeoutMs: config.promptTimeoutMs,
      parkSettleMs: config.bridgeParkSettleMs,
      modelOverrides: config.modelOverrides,
      readSettings: () => ({ ...config, sessionStore: config.resumeSessions ? sessionStore : undefined }),
      // ACP 会话复用：同一条 DSH 对话的后续回合只发增量；重启恢复默认关闭。
      reuseSessions: config.reuseSessions,
      resumeSessions: config.resumeSessions,
      keepProcessAfterCancel: config.keepProcessAfterCancel,
      cancelGraceMs: config.cancelGraceMs,
      idleRecycleMs: config.idleRecycleMs,
      sessionStore: config.resumeSessions ? sessionStore : undefined,
      canReadImages: () => attachmentStore !== undefined,
      readImage: (ref, signal) => {
        if (!attachmentStore) throw llmError('宿主附件服务不可用，无法读取图片', 'AGY_IMAGE_UNAVAILABLE')
        return attachmentStore.readImage(ref, signal)
      },
      onMetadataChanged: (snapshot) => {
        metadata = snapshot
        for (const peer of workers) if (peer !== worker) peer.importMetadata(snapshot)
        catalogChanged()
      },
      // 冷启动目录：真实目录只能观测到之后才有，先用磁盘缓存兜住模型选择器。
      loadCachedCatalog: () => readCachedCatalog({ cacheDir, acpVersion }),
      saveCatalog: (models) => writeCachedCatalog({ cacheDir, acpVersion, models }),
      // 自诊断：模型路由与 set_config_option 失败会写进宿主日志（宿主对 typert /
      // 适配器内部一律不记日志，出问题时这是唯一的现场）。
      log: {
        info: (message: string) => ctx.logger?.info?.(message),
        warn: (message: string, error?: unknown) => ctx.logger?.warn?.(redactSensitiveText(`${message}${error ? `: ${error instanceof Error ? error.message : String(error)}` : ''}`)),
      },
    })
    if (metadata) worker.importMetadata(metadata)
    workers.push(worker)
    return {
      adapter: worker,
      ensureImages: (signal) => worker.prepareImages(signal),
      read: () => lifecycle.read(),
      dispose: () => disposeAcpRuntime(active),
    }
  }, {
    capacity: config.maxConcurrentSessions,
    queueTimeoutMs: config.queueTimeoutMs,
    // 复用会话时同一对话必须粘在同一个 worker；关闭复用时回到纯负载调度。
    sessionAffinity: () => config.reuseSessions !== false,
  })
  ctx.inject(['attachments'], (scope) => {
    const store = scope.attachments
    attachmentStore = store
    adapter.invalidatePreparation()
    catalogChanged()
    scope.effect(() => () => {
      if (attachmentStore === store) {
        attachmentStore = undefined
        adapter.invalidatePreparation()
        catalogChanged()
      }
    })
  })
  const control = new SettingsControl({
    runtime: () => ({ ...adapter.read(), modelCatalogRevision }),
    connect: async (signal) => { await adapter.discoverModels(signal, true) },
    models: async (force) => {
      if (force) await adapter.discoverModels(undefined, false)
      // Include disabled rows in Settings so users can re-enable them.
      return workers[0]!.settingsModels(AGY_PROVIDER_ID)
    },
  })
  const registration = ctx.llm.registerAdapter([AGY_PROVIDER_ID], adapter)
  registerAgYAcpRemote(ctx)
  ctx.plugin(AgYAcpService, { control })

  // Config 的即时字段由 settings 投影；使用自定义卡片，不重复生成页面。
  // 弱依赖 settings，无 Web 的 profile 仍能加载。
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.get('settings') as {
      configure: (opts: { auto: boolean }, fiber: unknown) => () => void
    }
    settingsCtx.effect(
      () => settings.configure({ auto: false }, ctx.fiber),
      'antigravity-acp: schema settings form',
    )
  })

  // cordis 4.x 的规范 dispose 挂点：generator effect，卸载时逆序执行。
  ctx.effect(function* () {
    yield () => registration()
    yield async () => control.dispose()
    yield async () => {
      try { await adapter.dispose() }
      finally { await sessionStore.close() }
    }
  }, 'antigravity-acp 生命周期清理')
}
