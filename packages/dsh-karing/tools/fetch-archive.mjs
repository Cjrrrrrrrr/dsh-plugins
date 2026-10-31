/**
 * archive.org 古籍全文抓取 —— 维基文库没有的书，从 archive.org 的 OCR 全文（*_djvu.txt）补。
 *
 * 为什么需要：维基文库的紫微斗数只有《紫微斗數全書》三卷；而 archive.org 上有
 * 《术天机太乙金井紫微斗数》《飞星紫微斗数》等真古籍的 OCR 全文（实测 6 本全部可取）。
 *
 * 用法：
 *   node tools/fetch-archive.mjs --search 紫微斗数            只列出候选（含是否可全文）
 *   node tools/fetch-archive.mjs --fetch 20210924_20210924_0626 --dir 01-紫微斗数与八字/紫微斗数
 *   node tools/fetch-archive.mjs --auto 紫微斗数 --dir 01-... --min-chars 5000  一键：搜+抓全部可用的
 *
 * 质量把关：OCR 全文会混进页眉页脚与乱码，抓完会统计「汉字占比」，低于阈值的跳过并报警。
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { proxyFetch } from '../lib/proxy.js'
import { readRuntime, isAlive } from '../lib/core.js'

const args = process.argv.slice(2)
const argOf = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : d }
const ROOT = argOf('root', 'E:\\deepseekharness\\mingli-corpus')
const MIN_CHARS = Number(argOf('min-chars', '5000'))
// OCR 质量红线：实测真古籍（维基文库）汉字占比 66%-83%，而 archive.org 的竖排扫描件 OCR 只有 35%
const MIN_CJK = Number(argOf('min-cjk', '0.60'))
// 标题必须命中关键词（archive.org 会按正文匹配，会捞进报纸/无关书）
const TITLE_MUST = argOf('title-must', '')

const rt = readRuntime(join(import.meta.dirname, '..', 'data', 'runtime.json'))
const PROXY = rt !== undefined && isAlive(rt.pid) ? `http://127.0.0.1:${rt.ports?.rule ?? 3167}` : 'http://127.0.0.1:3167'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const safe = (s) => String(s).replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60)

/** 汉字占比（判 OCR 质量）。 */
function cjkRatio(text) {
  if (text.length === 0) return 0
  const m = text.match(/[\u4e00-\u9fff]/g)
  return (m === null ? 0 : m.length) / text.length
}

async function search(query, rows = 20) {
  const u = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=year&fl%5B%5D=mediatype&rows=${rows}&page=1&output=json`
  const r = await proxyFetch(u, { proxy: PROXY, timeoutMs: 45000 })
  const docs = JSON.parse(r.text).response?.docs ?? []
  return docs.map((d) => ({ identifier: d.identifier, title: Array.isArray(d.title) ? d.title[0] : d.title, year: d.year, mediatype: d.mediatype }))
}

/** 取 metadata，找 *_djvu.txt 并下载全文。 */
async function fetchFullText(identifier) {
  const m = await proxyFetch(`https://archive.org/metadata/${identifier}`, { proxy: PROXY, timeoutMs: 45000 })
  const meta = JSON.parse(m.text)
  const files = (meta.files ?? []).map((f) => f.name)
  const djvu = files.find((f) => /_djvu\.txt$/.test(f)) ?? files.find((f) => /_text\.txt$/.test(f))
  if (djvu === undefined) return { ok: false, error: '没有 OCR 全文（只有扫描件）' }
  const r = await proxyFetch(`https://archive.org/download/${identifier}/${encodeURIComponent(djvu)}`, { proxy: PROXY, timeoutMs: 180000 })
  if (r.status !== 200 || r.body.length < 1000) return { ok: false, error: `下载失败 HTTP ${r.status} / ${r.body.length} 字节` }
  return { ok: true, text: r.text, title: meta.metadata?.title, bytes: r.body.length, file: djvu }
}

function archive(identifier, title, text, dir) {
  const outDir = join(ROOT, dir)
  mkdirSync(outDir, { recursive: true })
  const body = [
    '---',
    `title: ${JSON.stringify(title ?? identifier)}`,
    `url: https://archive.org/details/${identifier}`,
    'source_engine: Internet Archive (OCR 全文)',
    `identifier: ${identifier}`,
    `fetched_at: ${new Date().toISOString()}`,
    `chars: ${text.length}`,
    `cjk_ratio: ${cjkRatio(text).toFixed(3)}`,
    '---',
    '',
    `# ${title ?? identifier}`,
    '',
    `> 来源：https://archive.org/details/${identifier}（OCR 全文，未经校勘）`,
    '',
    text,
    '',
  ].join('\n')
  const file = join(outDir, `古籍-${safe(title ?? identifier)}.md`)
  writeFileSync(file, body, 'utf8')
  return file
}

const listQuery = argOf('search', '')
const autoQuery = argOf('auto', '')
const fetchId = argOf('fetch', '')
const dir = argOf('dir', '06-其他命理')

if (fetchId.length > 0) {
  const r = await fetchFullText(fetchId)
  if (!r.ok) { console.error('❌', r.error); process.exit(1) }
  const ratio = cjkRatio(r.text)
  console.log(`✅ ${r.title ?? fetchId}｜${r.text.length} 字｜汉字占比 ${(ratio * 100).toFixed(1)}%`)
  if (r.text.length < MIN_CHARS) { console.error(`❌ 正文太短（< ${MIN_CHARS} 字），跳过`); process.exit(1) }
  console.log('   写入：', archive(fetchId, r.title, r.text, dir))
} else if (listQuery.length > 0 || autoQuery.length > 0) {
  const q = listQuery.length > 0 ? listQuery : autoQuery
  console.log(`archive.org 检索：${q}`)
  const items = await search(q)
  console.log(`  命中 ${items.length} 条`)
  for (const it of items) {
    await sleep(500)
    const m = await proxyFetch(`https://archive.org/metadata/${it.identifier}`, { proxy: PROXY, timeoutMs: 45000 }).catch(() => undefined)
    let hasText = false
    if (m !== undefined) {
      try { hasText = (JSON.parse(m.text).files ?? []).some((f) => /_djvu\.txt$/.test(f?.name ?? '')) } catch { hasText = false }
    }
    console.log(`  ${hasText ? '📖' : '🖼️ '} ${it.identifier.padEnd(32)} ${String(it.title ?? '').slice(0, 44)}`)
    if (autoQuery.length === 0) continue
    if (!hasText) continue
    if (TITLE_MUST.length > 0 && !new RegExp(TITLE_MUST).test(String(it.title ?? ''))) { console.log('       ⏭ 标题不含关键词，跳过'); continue }
    const r = await fetchFullText(it.identifier)
    if (!r.ok) { console.log(`       ❌ ${r.error}`); continue }
    const ratio = cjkRatio(r.text)
    if (r.text.length < MIN_CHARS) { console.log(`       ⚠️ 正文太短（${r.text.length} 字），跳过`); continue }
    if (ratio < 0.6) { console.log(`       ⚠️ 汉字占比过低（${(ratio * 100).toFixed(0)}% < 60%），判为 OCR 噪声，跳过`); continue }
    const f = archive(it.identifier, r.title ?? it.title, r.text, dir)
    console.log(`       ✅ ${r.text.length} 字（汉字 ${(ratio * 100).toFixed(0)}%）→ ${f.split('\\').pop()}`)
    await sleep(800)
  }
} else {
  console.log(`用法：
  node tools/fetch-archive.mjs --search <关键词>                       只列候选
  node tools/fetch-archive.mjs --fetch <identifier> --dir <目录>       抓单本
  node tools/fetch-archive.mjs --auto <关键词> --dir <目录>            搜+抓全部可用的
`)
}
