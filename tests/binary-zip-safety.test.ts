/**
 * 下载安全测试：重定向拒绝、非 2xx 状态、zip 条目校验、可执行挑选、
 * 临时文件失败清理。全部使用注入的 fake fetch / 真实临时目录，无网络。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import * as registry from '../src/runtime/official-release.js'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgyBinaryError,
  AGY_BINARY_ERROR,
  MAX_EXTRACT_BYTES,
  MAX_EXTRACT_ENTRY_BYTES,
  downloadBinary,
  downloadBinaryToFile,
  ensureAgentBinary,
  ensureExecutable,
  extractZipSafely,
  pickExecutablePath,
  validateZipEntryPath,
} from '../src/runtime/binary.js'
import type { FetchLike } from '../src/runtime/binary.js'
import { zip, zipToFile } from './helpers/make-zip.js'

function fakeFetch(status: number, body: Uint8Array | string = new Uint8Array([1, 2, 3])): FetchLike {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => (typeof body === 'string' ? new TextEncoder().encode(body).buffer : body.slice().buffer),
  })
}

describe('downloadBinary', () => {
  it('3xx 重定向被拒绝且不跟随（AGY_DOWNLOAD_REDIRECT_REFUSED）', async () => {
    const fetchImpl = fakeFetch(302, '')
    await expect(
      downloadBinary('https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.0-windows-x86_64.zip', {
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: AGY_BINARY_ERROR.REDIRECT_REFUSED })
  })

  it('非 2xx 非 3xx 状态报 AGY_DOWNLOAD_BAD_STATUS', async () => {
    await expect(
      downloadBinary('https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.0-windows-x86_64.zip', {
        fetchImpl: fakeFetch(404),
      }),
    ).rejects.toMatchObject({ code: AGY_BINARY_ERROR.BAD_STATUS })
  })

  it('200 时返回字节', async () => {
    const bytes = await downloadBinary('https://dl.google.com/agy-extensions/releases/windows/a.zip', {
      fetchImpl: fakeFetch(200, new Uint8Array([9, 9, 9])),
    })
    expect(Array.from(bytes)).toEqual([9, 9, 9])
  })

  it('非白名单 URL 在下载前即被拒绝', async () => {
    await expect(downloadBinary('https://evil.example.com/a.zip', { fetchImpl: fakeFetch(200) })).rejects.toMatchObject({
      code: AGY_BINARY_ERROR.BLOCKED_URL,
    })
  })

  it('downloadBinaryToFile 支持流式下载直接写入文件', async () => {
    const tmp = join(tmpdir(), `test-dl-${Date.now()}.bin`)
    try {
      const data = new Uint8Array([1, 2, 3, 4, 5])
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(data)
          controller.close()
        },
      })
      await downloadBinaryToFile('https://dl.google.com/test.zip', tmp, {
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          body: stream,
          arrayBuffer: async () => data.buffer,
        }),
      })
      const saved = await readFile(tmp)
      expect(Array.from(saved)).toEqual([1, 2, 3, 4, 5])
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined)
    }
  })

  it('downloadBinaryToFile 在未提供 stream body 时回退写入 arrayBuffer', async () => {
    const tmp = join(tmpdir(), `test-dl-fb-${Date.now()}.bin`)
    try {
      const data = new Uint8Array([6, 7, 8])
      await downloadBinaryToFile('https://dl.google.com/test.zip', tmp, {
        fetchImpl: fakeFetch(200, data),
      })
      const saved = await readFile(tmp)
      expect(Array.from(saved)).toEqual([6, 7, 8])
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined)
    }
  })
})

describe('validateZipEntryPath', () => {
  it.each([
    ['ok/file.exe', 'ok/file.exe'],
    ['agy-acp-server-1.4.0-windows-x86_64/agy-acp-server.exe', 'agy-acp-server-1.4.0-windows-x86_64/agy-acp-server.exe'],
    // 目录条目：尾随斜杠是「这是目录」的标记，不是穿越/绝对路径，必须放行
    // （官方 zip 常带 `bin/`、`bin/lib/` 这类条目，旧实现把它们整包判死）。
    ['bin/', 'bin/'],
    ['bin/lib/', 'bin/lib/'],
    ['agy-acp-server-1.4.0-windows-x86_64/bin/', 'agy-acp-server-1.4.0-windows-x86_64/bin/'],
  ])('接受安全相对路径 %s', (input, expected) => {
    expect(validateZipEntryPath(input)).toBe(expected)
  })

  it.each([
    ['绝对路径', '/etc/passwd'],
    ['Windows 盘符（反斜杠）', 'C:\\Windows\\evil.exe'],
    ['Windows 盘符（正斜杠）', 'C:/Windows/evil.exe'],
    ['反斜杠分隔', 'dir\\evil.exe'],
    ['.. 穿越段', '../evil.exe'],
    ['嵌套 .. 穿越段', 'ok/../../evil.exe'],
    ['当前目录段', './evil.exe'],
    ['空路径', ''],
    // 目录条目只在末尾允许一个空段；穿越、绝对、重复斜杠一律照旧拒绝。
    ['目录条目穿越 ..', '../evil/'],
    ['目录条目绝对路径', '/etc/'],
    ['目录条目盘符', 'C:/evil/'],
    ['目录条目反斜杠', 'dir\\evil\\'],
    ['目录条目当前段', './bin/'],
    ['目录条目重复斜杠', 'bin//'],
    ['目录条目仅尾随斜杠后仍有内容', 'bin/../'],
  ])('拒绝不安全条目：%s', (_label, input) => {
    expect(() => validateZipEntryPath(input as string)).toThrowError(AgyBinaryError)
    try {
      validateZipEntryPath(input as string)
    } catch (error) {
      expect((error as AgyBinaryError).code).toBe(AGY_BINARY_ERROR.UNSAFE_ENTRY)
    }
  })
})

describe('pickExecutablePath', () => {
  const windowsEntries = ['agy-acp-server-1.4.0-windows-x86_64/', 'agy-acp-server-1.4.0-windows-x86_64/agy-acp-server.exe', 'docs/readme.txt']

  it('windows：挑出唯一 .exe', () => {
    expect(pickExecutablePath(windowsEntries, 'windows')).toBe('agy-acp-server-1.4.0-windows-x86_64/agy-acp-server.exe')
  })

  it('posix：挑出 agy-acp-server 无扩展名文件', () => {
    const entries = ['agy-acp-server-1.4.0-linux-x86_64/agy-acp-server', 'notes.txt']
    expect(pickExecutablePath(entries, 'posix')).toBe('agy-acp-server-1.4.0-linux-x86_64/agy-acp-server')
  })

  it('找不到可执行文件抛 AGY_ARCHIVE_LAYOUT', () => {
    expect(() => pickExecutablePath(['docs/readme.txt'], 'windows')).toThrowError(
      expect.objectContaining({ code: AGY_BINARY_ERROR.ARCHIVE_LAYOUT }),
    )
  })

  it('多个候选时确定性取最浅深度', () => {
    const entries = ['a/b/agy_acp_server.exe', 'agy_acp_server.exe', 'aaa-helper.exe']
    expect(pickExecutablePath(entries, 'windows')).toBe('agy_acp_server.exe')
  })

  it('识别官方 POSIX .par 入口，不选择旁边的 helper', () => {
    expect(pickExecutablePath(['localharness_external', 'agy_acp_server.par'], 'posix')).toBe('agy_acp_server.par')
  })
})

describe('extractZipSafely', () => {
  it('拒绝含穿越条目的 zip 并不写出越界文件', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'agy-extract-'))
    try {
      const malicious = await zipToFile(
        [
          { name: 'ok.txt', data: Buffer.from('fine') },
          { name: '../escape.txt', data: Buffer.from('bad') },
        ],
        join(dest, 'malicious.zip'),
      )
      await expect(extractZipSafely(malicious, dest)).rejects.toMatchObject({ code: AGY_BINARY_ERROR.UNSAFE_ENTRY })
      // ok.txt 可能在出错前已写出，但越界文件绝不允许存在。
      const dir = await readdir(dest)
      expect(dir).not.toContain('escape.txt')
    } finally {
      await rm(dest, { recursive: true, force: true })
    }
  })

  it('正常 zip 全部解出并返回相对条目', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'agy-extract-'))
    try {
      const safe = await zipToFile(
        [
          { name: 'agy-acp-server-1.4.0-windows-x86_64/agy-acp-server.exe', data: Buffer.from('MZ fake exe') },
          { name: 'agy-acp-server-1.4.0-windows-x86_64/README.txt', data: Buffer.from('hi') },
        ],
        join(dest, 'safe.zip'),
      )
      const extracted = await extractZipSafely(safe, dest)
      expect(extracted).toContain('agy-acp-server-1.4.0-windows-x86_64/agy-acp-server.exe')
      expect(extracted).toContain('agy-acp-server-1.4.0-windows-x86_64/README.txt')
    } finally {
      await rm(dest, { recursive: true, force: true })
    }
  })

  it('含目录条目（bin/、bin/lib/）的 zip 解压成功并真的建出目录', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'agy-extract-'))
    try {
      const archive = await zipToFile(
        [
          { name: 'bin/', data: Buffer.alloc(0) },
          { name: 'bin/lib/', data: Buffer.alloc(0) },
          { name: 'bin/agy-acp-server.exe', data: Buffer.from('MZ fake exe') },
        ],
        join(dest, 'dirs.zip'),
      )
      const extracted = await extractZipSafely(archive, dest)
      // 目录条目只负责建目录（返回值沿用既有语义：只列文件条目）。
      expect(extracted).toEqual(['bin/agy-acp-server.exe'])
      const entries = await readdir(join(dest, 'bin'))
      expect(entries.sort()).toEqual(['agy-acp-server.exe', 'lib'])
      expect(pickExecutablePath(extracted, 'windows')).toBe('bin/agy-acp-server.exe')
    } finally {
      await rm(dest, { recursive: true, force: true })
    }
  })

  it('目录条目形式的穿越（../evil/）仍被拒绝且不建出越界目录', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'agy-extract-'))
    const escapeName = 'agy-zip-escape-dir'
    try {
      const malicious = await zipToFile(
        [
          { name: 'ok/', data: Buffer.alloc(0) },
          { name: `../${escapeName}/`, data: Buffer.alloc(0) },
        ],
        join(dest, 'evil-dir.zip'),
      )
      await expect(extractZipSafely(malicious, dest)).rejects.toMatchObject({ code: AGY_BINARY_ERROR.UNSAFE_ENTRY })
      expect(await readdir(dest)).not.toContain(escapeName)
      expect(await readdir(join(dest, '..'))).not.toContain(escapeName)
    } finally {
      await rm(dest, { recursive: true, force: true })
      await rm(join(dest, '..', escapeName), { recursive: true, force: true })
    }
  })

  it('条目数超过上限时整包拒绝，且在写盘前就报 ARCHIVE_TOO_LARGE', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'agy-extract-'))
    try {
      // 注入小上限验证守卫本身，不依赖"真实上限正好比官方包大"这种巧合。
      const inputs = Array.from({ length: 4 }, (_, index) => ({ name: `f${index}.bin`, data: Buffer.alloc(0) }))
      const archive = await zipToFile(inputs, join(dest, 'many.zip'))
      await expect(extractZipSafely(archive, dest, { maxEntries: 3 }))
        .rejects.toMatchObject({ code: AGY_BINARY_ERROR.ARCHIVE_TOO_LARGE })
      // 恰好等于上限时仍允许。
      expect(await extractZipSafely(archive, dest, { maxEntries: 4 })).toHaveLength(4)
    } finally {
      await rm(dest, { recursive: true, force: true })
    }
  })

  it('单条目与总量超限时拒绝，正常包在上限内照常解出', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'agy-extract-'))
    try {
      const archive = await zipToFile(
        [
          { name: 'a.bin', data: Buffer.alloc(2_048, 7) },
          { name: 'b.bin', data: Buffer.alloc(2_048, 8) },
        ],
        join(dest, 'sized.zip'),
      )
      // 单条目超限（第一个条目就拦住，不写后续）。
      await expect(extractZipSafely(archive, dest, { maxEntryBytes: 1_024 }))
        .rejects.toMatchObject({ code: AGY_BINARY_ERROR.ARCHIVE_TOO_LARGE })
      // 每个条目都合规，但累计超限。
      await expect(extractZipSafely(archive, dest, { maxEntryBytes: 4_096, maxTotalBytes: 3_000 }))
        .rejects.toMatchObject({ code: AGY_BINARY_ERROR.ARCHIVE_TOO_LARGE })
      // 上限足够时全部解出，证明失败来自上限而非其它解析问题。
      expect(await extractZipSafely(archive, dest, { maxEntryBytes: 4_096, maxTotalBytes: 8_192 }))
        .toEqual(['a.bin', 'b.bin'])
    } finally {
      await rm(dest, { recursive: true, force: true })
    }
  })

  it('中央目录谎报解压大小时被拒绝，不会写出超出实际数据量', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'agy-extract-'))
    try {
      // 真实 4KB 条目，但两处头都把 uncompressedSize 改小成 1：
      // 预检以"1 字节"放行，后续必须靠校验/实际字节守卫拒绝。
      const archive = await zipToFile([{ name: 'liar.bin', data: Buffer.alloc(4_096, 3) }], join(dest, 'liar.zip'))
      const raw = await readFile(archive)
      raw.writeUInt32LE(1, 22) // 本地文件头 uncompressedSize
      const central = raw.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
      expect(central).toBeGreaterThan(0)
      raw.writeUInt32LE(1, central + 24) // 中央目录 uncompressedSize
      await writeFile(archive, raw)

      // 无论由 yauzl 的 validateEntrySizes 还是我们的字节守卫拦下，
      // 都必须失败——绝不能当成功处理。
      await expect(extractZipSafely(archive, dest)).rejects.toBeInstanceOf(AgyBinaryError)
      expect(await readdir(dest)).not.toContain('liar.bin')
    } finally {
      await rm(dest, { recursive: true, force: true })
    }
  })
})

describe('解压守卫常量覆盖官方分发包实测体积', () => {
  it('单条目与总量上限严格高于 2026-11-22 实测的最大官方包（#13 回归）', () => {
    // 实测最大单条目：linux arm64 1.4.1 的 agy_acp_server.par = 933,416,796 字节（约 890 MiB）。
    // 旧常量 512 MiB 导致 Linux 全版本在写盘前被拒，ACP 连接直接失败。
    expect(MAX_EXTRACT_ENTRY_BYTES).toBeGreaterThan(933_416_796)
    // 实测最大解压总量：linux x86_64 1.4.1 两条目合计 = 1,062,014,265 字节（约 1.01 GiB）。
    // 旧常量 1 GiB 只给单条目调阈值会立刻撞上第二道总量守卫。
    expect(MAX_EXTRACT_BYTES).toBeGreaterThan(1_062_014_265)
  })
})

describe('ensureAgentBinary 临时文件清理', () => {
  it('posix 下主程序与同目录 localharness_external 都补执行位（issue #3）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agy-exec-'))
    try {
      const main = join(dir, 'agy_acp_server.par')
      await writeFile(main, 'main')
      await writeFile(join(dir, 'localharness_external'), 'helper')
      const calls: Array<[string, number]> = []
      await ensureExecutable(main, 'posix', async (path, mode) => { calls.push([path, mode]) })
      expect(calls).toEqual([[main, 0o755], [join(dir, 'localharness_external'), 0o755]])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('辅助程序缺失或不是普通文件时只处理主程序；windows 不改权限', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agy-exec-'))
    try {
      const main = join(dir, 'agy_acp_server.par')
      await writeFile(main, 'main')
      const calls: string[] = []
      const record = async (path: string): Promise<void> => { calls.push(path) }
      await ensureExecutable(main, 'posix', record)
      expect(calls).toEqual([main])
      calls.length = 0
      await mkdir(join(dir, 'localharness_external'))
      await ensureExecutable(main, 'posix', record)
      expect(calls).toEqual([main])
      calls.length = 0
      await ensureExecutable(main, 'windows', record)
      expect(calls).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

})

describe('official archive verification', () => {
  const roots: string[] = []
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  async function fixture() {
    const cacheDir = await mkdtemp(join(tmpdir(), 'agy-signed-cache-'))
    roots.push(cacheDir)
    const archive = zip([
      { name: 'agy_acp_server.par', data: Buffer.from('main') },
      { name: 'localharness_external', data: Buffer.from('helper') },
    ])
    vi.spyOn(registry, 'officialArchiveDigest').mockReturnValue(createHash('sha256').update(archive).digest('hex'))
    const options = { cacheDir, version: '1.5.2', platform: 'linux' as const, arch: 'arm64', env: {}, fetchImpl: fakeFetch(200, Uint8Array.from(archive)) }
    const cacheFile = join(cacheDir, '1.5.2', 'official-linux-aarch64.zip')
    return { archive, options, cacheFile }
  }

  it('pins every supported architecture to the registry and rejects unknown releases', () => {
    for (const platform of ['linux', 'darwin', 'windows'] as const) {
      for (const arch of ['x86_64', 'aarch64'] as const) expect(registry.officialArchiveDigest('1.5.2', platform, arch)).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(registry.officialArchiveDigest('1.5.2', 'linux', 'aarch64')).toBe('e729e05ef54ef0763e48900032466b47fa7c9939cde257f93ba49410ab577acb')
    expect(registry.officialArchiveDigest('9.9.9', 'linux', 'aarch64')).toBeUndefined()
    return expect(ensureAgentBinary({ version: '9.9.9', env: {} })).rejects.toMatchObject({ code: AGY_BINARY_ERROR.UNVERIFIED })
  })

  it('restores both executables from a verified offline ZIP, ignoring previously edited siblings and extra files', async () => {
    const { options, archive, cacheFile } = await fixture()
    const first = await ensureAgentBinary(options)
    expect(first).toMatchObject({ source: 'download', checksumVerified: true })
    expect(await readFile(cacheFile)).toEqual(archive)
    const sibling = (path: string, name: string) => join(path, '..', name)
    await writeFile(first.executablePath, 'modified main')
    await writeFile(sibling(first.executablePath, 'localharness_external'), 'modified helper')
    await writeFile(sibling(first.executablePath, 'extra.dll'), 'unpackaged DLL')
    const second = await ensureAgentBinary({ ...options, autoDownload: false })
    expect(second).toMatchObject({ source: 'cache', checksumVerified: true })
    expect(second.executablePath).not.toBe(first.executablePath)
    expect(await readFile(second.executablePath, 'utf8')).toBe('main')
    expect(await readFile(sibling(second.executablePath, 'localharness_external'), 'utf8')).toBe('helper')
    expect(await readdir(sibling(second.executablePath, '.'))).not.toContain('extra.dll')
    if (process.platform !== 'win32') {
      expect((await stat(second.executablePath)).mode & 0o111).toBe(0o111)
      expect((await stat(sibling(second.executablePath, 'localharness_external'))).mode & 0o111).toBe(0o111)
    }
    await first.release()
    expect(await readFile(second.executablePath, 'utf8')).toBe('main')
    await second.release()
    expect(await readdir(join(options.cacheDir, 'runtime'))).toEqual([])
  })

  it('rejects a changed ZIP in cache, including a change confined to the helper', async () => {
    const { options, cacheFile } = await fixture()
    const first = await ensureAgentBinary(options)
    await first.release()
    await writeFile(cacheFile, zip([
      { name: 'agy_acp_server.par', data: Buffer.from('main') },
      { name: 'localharness_external', data: Buffer.from('modified') },
    ]))
    await expect(ensureAgentBinary({ ...options, autoDownload: false })).rejects.toMatchObject({ code: AGY_BINARY_ERROR.UNVERIFIED })
    expect(await readdir(join(options.cacheDir, 'runtime'))).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('refuses a previously shared runtime directory', async () => {
    const { options } = await fixture()
    const runtime = join(options.cacheDir, 'runtime')
    await mkdir(runtime)
    await chmod(runtime, 0o777)
    await expect(ensureAgentBinary(options)).rejects.toMatchObject({ code: AGY_BINARY_ERROR.UNVERIFIED })
    expect(await readdir(runtime)).toEqual([])
  })

  it('rejects a download with a different digest before populating the cache', async () => {
    const { options, cacheFile } = await fixture()
    await expect(ensureAgentBinary({ ...options, fetchImpl: fakeFetch(200, 'changed') })).rejects.toMatchObject({ code: AGY_BINARY_ERROR.UNVERIFIED })
    await expect(stat(cacheFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(join(options.cacheDir, 'runtime'))).toEqual([])
  })

  it('separate hosts can install and release without overwriting each other’s running files', async () => {
    const { options, archive } = await fixture()
    let arrived = 0
    let release!: () => void
    const both = new Promise<void>((resolve) => { release = resolve })
    const fetchImpl: FetchLike = async () => {
      if (++arrived === 2) release()
      await both
      return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(archive).buffer }
    }
    const [first, second] = await Promise.all([ensureAgentBinary({ ...options, fetchImpl }), ensureAgentBinary({ ...options, fetchImpl })])
    expect(first.executablePath).not.toBe(second.executablePath)
    await first.release()
    expect(await readFile(second.executablePath, 'utf8')).toBe('main')
    await second.release()
  })

  it('cleans a failed download and refuses extraction-only legacy caches offline', async () => {
    const { options } = await fixture()
    await expect(ensureAgentBinary({ ...options, fetchImpl: fakeFetch(302) })).rejects.toMatchObject({ code: AGY_BINARY_ERROR.REDIRECT_REFUSED })
    const legacy = join(options.cacheDir, '1.5.2', 'extract-1.5.2')
    await mkdir(legacy)
    await writeFile(join(legacy, 'agy_acp_server.par'), 'unsigned')
    await expect(ensureAgentBinary({ ...options, autoDownload: false })).rejects.toMatchObject({ code: AGY_BINARY_ERROR.BINARY_MISSING })
    expect(await readdir(join(options.cacheDir, 'runtime'))).toEqual([])
  })
})
