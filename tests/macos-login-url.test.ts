import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

describe.skipIf(process.platform !== 'darwin')('macOS login URL helper', () => {
  let folder: string
  let deployment: string
  let app: string
  let home: string
  let command: string
  let script: string
  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), 'dsh-login-url-'))
    deployment = join(folder, "My DSH 'with spaces' $(whoami)")
    home = join(deployment, 'data/home')
    const scripts = join(deployment, 'data/profiles/web/node_modules/dsh-bundle-antigravity-official-acp/scripts')
    mkdirSync(scripts, { recursive: true })
    mkdirSync(home, { recursive: true })
    writeFileSync(join(scripts, 'official-macos-login.mjs'), "console.log(JSON.stringify(process.argv.slice(2)))\n")
    app = join(folder, 'DSH Antigravity Login.app')
    const installer: { buildURLHelper: (deployment: string, app: string) => void } =
      await import(new URL('../scripts/install-macos-url-helper.mjs', import.meta.url).href)
    installer.buildURLHelper(deployment, app)
    command = join(app, 'Contents/Resources/Login.command')
    script = join(app, 'Contents/Resources/Scripts/main.scpt')
  })
  afterAll(() => { if (folder) rmSync(folder, { force: true, recursive: true }) })

  it('advertises only the fixed login scheme and seals the bundle', () => {
    const plist = join(app, 'Contents/Info.plist')
    const types = JSON.parse(execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleURLTypes', 'json', '-o', '-', plist], { encoding: 'utf8' }))
    expect(types.map((entry: { CFBundleURLSchemes: string[] }) => entry.CFBundleURLSchemes)).toEqual([['dsh-antigravity-login']])
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', app])
  })

  it('accepts exactly the fixed action including case, without paths, fragments or parameters', () => {
    const check = [
      'on run argv',
      'set handlerApp to load script (POSIX file (item 1 of argv))',
      'set answers to {}',
      'repeat with requestIndex from 2 to count of argv',
      "set end of answers to handlerApp's acceptsLoginURL(item requestIndex of argv)",
      'end repeat',
      'return answers',
      'end run',
    ].join('\n')
    const urls = ['dsh-antigravity-login://authorize', 'dsh-antigravity-login://authorize/', 'dsh-antigravity-login://Authorize',
      'dsh-antigravity-login://authorize?user=test', 'dsh-antigravity-login://authorize#target', 'dsh-antigravity-login://authorizé',
      'dsh-antigravity-login://user@authorize', 'dsh-antigravity-login://authorize/command', 'https://authorize']
    const result = execFileSync('/usr/bin/osascript', ['-e', check, script, ...urls], { encoding: 'utf8' })
    expect(result.trim().split(', ')).toEqual(['true', ...urls.slice(1).map(() => 'false')])
  })

  it('passes only the bound deployment paths to the official login entrypoint', () => {
    const result = execFileSync(command, ['ignored://argument'], { encoding: 'utf8' })
    const canonicalHome = realpathSync(home)
    expect(JSON.parse(result)).toEqual(['--home', canonicalHome, '--cache-dir', join(canonicalHome, '.cache/dsh-antigravity-host')])
  })

  it('rejects a second login while the first holds the lock', () => {
    const result = spawnSync('/usr/bin/lockf', ['-k', join(home, '.dsh-antigravity-login.lock'), command], { encoding: 'utf8' })
    expect(result.status).toBe(75)
    expect(result.stderr).toContain('已有登录正在进行')
  })
})
