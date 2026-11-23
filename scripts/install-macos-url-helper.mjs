/** Installs the per-user macOS URL handler for a single DSH Docker deployment. */
import { execFileSync } from 'node:child_process'
import { constants, accessSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const appName = 'DSH Antigravity Login.app'
const identifier = 'io.github.compilink.dsh-antigravity-login'
const register = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
const handlerSource = fileURLToPath(new URL('./macos-login-url.applescript', import.meta.url))
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'"

/** Builds a signed app at a new location without registering or launching it. */
export function buildURLHelper(deployment, app) {
  if (process.platform !== 'darwin' || !isAbsolute(deployment)) {
    throw new Error('请在 macOS 上指定 DSH 部署根目录的绝对路径。')
  }
  const root = realpathSync(deployment)
  const profile = join(root, 'data/home')
  const login = join(root, 'data/profiles/web/node_modules/dsh-bundle-antigravity-official-acp/scripts/official-macos-login.mjs')
  if (!statSync(profile).isDirectory() || !statSync(login).isFile()) throw new Error('找不到已安装的插件或 DSH 绑定的主目录。')
  accessSync(profile, constants.W_OK | constants.X_OK)
  accessSync(login, constants.R_OK)
  execFileSync('/usr/bin/osacompile', ['-o', app, handlerSource])
  const info = {
    CFBundleExecutable: 'applet',
    CFBundleIdentifier: identifier,
    CFBundleName: 'DSH Antigravity Login',
    CFBundlePackageType: 'APPL',
    CFBundleVersion: '1',
    CFBundleIconFile: 'applet',
    CFBundleURLTypes: [{ CFBundleURLName: identifier, CFBundleTypeRole: 'Viewer', CFBundleURLSchemes: ['dsh-antigravity-login'] }],
    LSUIElement: true,
    OSAAppletShowStartupScreen: false,
  }
  execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', join(app, 'Contents/Info.plist'), '--', '-'], { input: JSON.stringify(info) })
  const command = [
    '#!/bin/zsh',
    'umask 077',
    'export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"',
    'if ! command -v node >/dev/null; then',
    "  print -u2 '登录器需要 macOS 上的 Node.js 22.19 或更新版本。'",
    '  exit 1',
    'fi',
    `/usr/bin/lockf -ks -t 0 ${shellQuote(join(profile, '.dsh-antigravity-login.lock'))} node ${shellQuote(login)} --home ${shellQuote(profile)} --cache-dir ${shellQuote(join(profile, '.cache/dsh-antigravity-host'))}`,
    'result=$?',
    `if [[ $result == 75 ]]; then print -u2 '已有登录正在进行，请回到已打开的终端窗口。'; fi`,
    'exit $result',
    '',
  ].join('\n')
  writeFileSync(join(app, 'Contents/Resources/Login.command'), command, { mode: 0o700, flag: 'wx' })
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app])
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', app])
}

function install(deployment) {
  const applications = join(homedir(), 'Applications')
  mkdirSync(applications, { recursive: true })
  const destination = join(applications, appName)
  const previous = lstatSync(destination, { throwIfNoEntry: false })
  if (previous && (!previous.isDirectory() || execFileSync('/usr/bin/plutil', [
    '-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(destination, 'Contents/Info.plist'),
  ], { encoding: 'utf8' }).trim() !== identifier)) {
    throw new Error(`同名应用属于其他程序，请先检查 ${destination}。`)
  }
  const stage = mkdtempSync(join(applications, '.dsh-antigravity-install-'))
  const replacement = join(stage, appName)
  const backup = join(stage, 'previous')
  let saved = false
  let moved = false
  try {
    buildURLHelper(deployment, replacement)
    if (previous) {
      renameSync(destination, backup)
      saved = true
    }
    renameSync(replacement, destination)
    moved = true
    execFileSync(register, ['-f', destination])
    saved = false
    console.log(`已注册本机登录助手：${destination}`)
  } catch (error) {
    if (moved) renameSync(destination, replacement)
    if (saved) {
      renameSync(backup, destination)
      saved = false
      execFileSync(register, ['-f', destination])
    }
    throw error
  } finally {
    if (!saved) rmSync(stage, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { deployment: { type: 'string' }, help: { type: 'boolean' } } })
    if (values.help) console.log('用法：node install-macos-url-helper.mjs --deployment <DSH 部署根目录绝对路径>')
    else if (!values.deployment) throw new Error('请用 --deployment 指定 DSH 部署根目录。')
    else install(values.deployment)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
