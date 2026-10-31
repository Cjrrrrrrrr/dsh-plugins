/**
 * 定点补抓：把一份「高价值来源清单」经代理抓下来，按主题归档到资料库。
 * 用法：node tools/fetch-urls.mjs <清单.json> [--root <语料根>] [--min-chars 800]
 * 清单格式：[{"url":"...","dir":"01-紫微斗数与八字/紫微斗数","title":"...","note":"..."}]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fetchPage } from '../lib/search.js'
import { readRuntime, isAlive } from '../lib/core.js'

const args = process.argv.slice(2)
const listPath = args[0]
const i = args.indexOf('--root')
const ROOT = i >= 0 && args[i + 1] !== undefined ? args[i + 1] : 'E:\\deepseekharness\\mingli-corpus'
const j = args.indexOf('--min-chars')
const MIN = j >= 0 && args[j + 1] !== undefined ? Number(args[j + 1]) : 800

const rt = readRuntime(join(import.meta.dirname, '..', 'data', 'runtime.json'))
const PROXY = rt !== undefined && isAlive(rt.pid) ? `http://127.0.0.1:${rt.port}` : undefined
console.log(`代理：${PROXY ?? '未运行（直连）'}`)

const safeName = (s) => String(s).replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 70) || 'untitled'
const list = JSON.parse(readFileSync(listPath, 'utf8'))
let ok = 0
for (const item of list) {
  const dir = join(ROOT, item.dir)
  mkdirSync(dir, { recursive: true })
  try {
    const page = await fetchPage(item.url, { proxy: PROXY, timeoutMs: 40000, maxChars: 400000 })
    if (page.status !== 200 || page.text.length < MIN) {
      console.log(`⚠️ 跳过 ${item.title ?? item.url} — HTTP ${page.status} / 正文 ${page.text.length} 字`)
      continue
    }
    const file = join(dir, `${item.prefix ?? '古籍'}-${safeName(item.title ?? page.title)}.md`)
    writeFileSync(file, [
      '---',
      `title: ${JSON.stringify(item.title ?? page.title)}`,
      `url: ${item.url}`,
      `source_engine: ${item.source ?? '定点补抓'}`,
      `query: ${JSON.stringify(item.note ?? '')}`,
      `fetched_at: ${new Date().toISOString()}`,
      `topic: ${item.dir}`,
      `chars: ${page.text.length}`,
      '---',
      '',
      `# ${item.title ?? page.title}`,
      '',
      `> 来源：${item.url}`,
      item.note !== undefined ? `> 说明：${item.note}` : '',
      '',
      page.text,
      '',
    ].filter((x) => x !== undefined).join('\n'), 'utf8')
    ok += 1
    console.log(`✅ ${item.dir} / ${file.split('\\').pop()} (${page.text.length} 字)`)
  } catch (error) {
    console.log(`❌ ${item.title ?? item.url} — ${String(error?.message ?? error).slice(0, 100)}`)
  }
  await new Promise((r) => setTimeout(r, 500))
}
console.log(`\n完成：${ok}/${list.length} 篇已归档到 ${ROOT}`)
