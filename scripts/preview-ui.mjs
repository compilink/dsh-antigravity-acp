/** Render the browser settings tabs with an offline fixture. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { previewSettings } from './preview-kit.mjs'

const out = new URL('../.local-preview/', import.meta.url)
mkdirSync(out, { recursive: true })
for (const tab of ['connection', 'models', 'advanced']) {
  const page = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Antigravity ACP</title><style>body{margin:0 auto;max-width:760px;font-family:system-ui,sans-serif}</style><p>离线预览 · 模拟数据</p>' + previewSettings(tab) + '</html>'
  writeFileSync(new URL('settings-' + tab + '.html', out), page)
}
