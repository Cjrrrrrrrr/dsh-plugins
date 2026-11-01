/**
 * 生成资料库索引：扫描 mingli-corpus 下所有归档 md 与 _检索结果.jsonl，
 * 产出 00-索引/采集清单.md（含每主题命中数、已归档篇目、按来源域名统计）。
 * 用法：node tools/index-corpus.mjs [--root E:\deepseekharness\mingli-corpus]
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const args = process.argv.slice(2)
const i = args.indexOf('--root')
const ROOT = i >= 0 && args[i + 1] !== undefined ? args[i + 1] : 'E:\\deepseekharness\\mingli-corpus'

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else out.push({ full, name, size: st.size })
  }
  return out
}

if (!existsSync(ROOT)) { console.log(`根目录不存在：${ROOT}`); process.exit(1) }
const files = walk(ROOT)
const DOC_EXT = new Set(['.pdf','.docx','.doc','.epub','.zip','.rar','.7z','.txt','.xlsx','.xls','.ppt','.pptx','.chm','.djvu','.mobi','.azw3','.caj'])
const ALL_MD = files.filter((f) => f.name.endsWith('.md') && !f.full.includes('00-索引'))
const mds = ALL_MD.filter((f) => !f.full.includes('_转换文本'))
const converted = ALL_MD.filter((f) => f.full.includes('_转换文本'))
const docs = files.filter((f) => DOC_EXT.has(require$ext(f.name)) && !f.full.includes('00-索引'))
function require$ext(n){ const i=n.lastIndexOf('.'); return i<0?'':n.slice(i).toLowerCase() }
const jsonls = files.filter((f) => f.name.endsWith('.jsonl'))

const byDir = new Map()
for (const f of mds) {
  const dir = relative(ROOT, f.full).split(/[\\/]/).slice(0, -1).join('/') || '(根)'
  if (!byDir.has(dir)) byDir.set(dir, [])
  const head = readFileSync(f.full, 'utf8').slice(0, 1200)
  const pick = (k) => (head.match(new RegExp(`^${k}: (.*)$`, 'm')) ?? [])[1]?.replace(/^"|"$/g, '') ?? ''
  byDir.get(dir).push({ name: f.name, title: pick('title'), url: pick('url'), engine: pick('source_engine'), chars: pick('chars'), size: f.size })
}

const hits = new Map()
let totalHits = 0
const domains = new Map()
for (const j of jsonls) {
  const dir = relative(ROOT, j.full).split(/[\\/]/).slice(0, -1).join('/') || '(根)'
  const lines = readFileSync(j.full, 'utf8').split('\n').filter((l) => l.trim().length > 0)
  hits.set(dir, lines.length)
  totalHits += lines.length
  for (const line of lines) {
    try {
      const rec = JSON.parse(line)
      const host = new URL(rec.url).hostname.replace(/^www\./, '')
      domains.set(host, (domains.get(host) ?? 0) + 1)
    } catch { /* 忽略 */ }
  }
}

const now = new Date().toISOString()
const lines = [
  '# 命理资料库 · 采集清单',
  '',
  `> 生成时间：${now}`,
  `> 根目录：\`${ROOT}\``,
  `> 检索命中合计 **${totalHits}** 条 ｜ 已归档正文 **${mds.length}** 篇 ｜ 群文件资料 **${docs.length}** 个（${(docs.reduce((n,d)=>n+d.size,0)/1073741824).toFixed(2)} GB） ｜ 二进制转文本 **${converted.length}** 篇（另计，见 _转换文本/ 目录）`,
  '',
  '## 采集方式',
  '',
  '- 检索：`dsh-karing` 插件分两阶段 —— **强制外网阶段**经 Karing 全代理口（3166）调用 DuckDuckGo/Bing/维基文库/Internet Archive；**国内阶段**直连调用百度/360/搜狗。',
  '- 归档：`karing_fetch` 经代理抓取页面并转纯文本，保留 title / url / 来源引擎 / 检索词 / 阶段 / 抓取时间，便于溯源。',
  '- 古籍：`tools/fetch-wikisource.mjs` 走维基文库 MediaWiki API 取干净 wikitext，`tools/clean-wikitext.mjs` 做离线清洗。',
  '- 原始命中（含未抓正文的）逐条留在各主题目录的 `_检索结果.jsonl`。',
  '- 二进制转文本：`tools/extract-text.py` 把 PDF/DOC/DOCX/XLS/XLSX 抽成 md 落到 `_转换文本/`（镜像原目录），让 bigram 索引能搜到；扫描件无文字层的不生成空文件，见 `_转换报告.json`。',
  '',
  '## 目录结构',
  '',
  '```',
  'mingli-corpus/',
  '├── 00-索引/                     本清单',
  '├── 01-紫微斗数与八字/           ← 紫微斗数与八字放同一文件夹（按你的要求）',
  '│   ├── 紫微斗数/',
  '│   ├── 八字/',
  '│   └── 八紫合参/',
  '├── 02-七政四余/',
  '├── 03-奇门遁甲/',
  '├── 04-铁板神数/',
  '└── 05-真实案例与反馈/',
  '```',
  '',
  '## 各主题统计',
  '',
  '| 主题目录 | 检索命中 | 已归档正文 |',
  '|---|---:|---:|',
]
const dirs = [...new Set([...byDir.keys(), ...hits.keys()])].sort()
for (const d of dirs) lines.push(`| ${d} | ${hits.get(d) ?? 0} | ${(byDir.get(d) ?? []).length} |`)

lines.push('', '## 已归档篇目', '')
for (const d of dirs.sort()) {
  const list = byDir.get(d) ?? []
  if (list.length === 0) continue
  lines.push(`### ${d}（${list.length} 篇）`, '')
  for (const f of list.sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`- **${f.title || f.name}** ｜ ${f.chars || '?'} 字 ｜ ${f.engine || '?'} ｜ ${f.url}`)
    lines.push(`  - 文件：\`${d}/${f.name}\``)
  }
  lines.push('')
}

lines.push('## 群文件资料（QQ 群文件夹收集）', '', `共 ${docs.length} 个文件，合计 ${(docs.reduce((n,d)=>n+d.size,0)/1073741824).toFixed(2)} GB`, '', '| 目录 | 文件数 | 大小 |', '|---|---:|---:|')
{
  const byDir = new Map()
  for (const d of docs) {
    const dir = relative(ROOT, d.full).split(String.fromCharCode(92)).join('/').split('/').slice(0, -1).join('/') || '(根)'
    const cur = byDir.get(dir) ?? { n: 0, b: 0 }
    cur.n += 1; cur.b += d.size
    byDir.set(dir, cur)
  }
  for (const [dir, v] of [...byDir.entries()].sort((a, b) => b[1].b - a[1].b)) {
    lines.push(`| ${dir} | ${v.n} | ${(v.b / 1048576).toFixed(1)} MB |`)
  }
}
lines.push('', '归档清单（可溯源到原路径）：`07-群文件资料/_归档清单.jsonl`', '')

lines.push('## 来源域名分布（检索命中）', '', '| 域名 | 命中数 |', '|---|---:|')
for (const [d, n] of [...domains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) lines.push(`| ${d} | ${n} |`)

lines.push('', '## 使用与注意事项', '',
  '- 文本由 HTML 抽取，可能夹带导航/页脚噪声；引用前请回到 `url` 核对原文。',
  '- 命中与正文均为公开网页内容，版权归原站所有；本目录仅作个人研究检索用，勿再分发。',
  '- 未抓到正文的命中仍保留在 `_检索结果.jsonl`，可按需用 `hiddify_fetch` 补抓。',
  '')

mkdirSync(join(ROOT, '00-索引'), { recursive: true })
writeFileSync(join(ROOT, '00-索引', '采集清单.md'), lines.join('\n'), 'utf8')
console.log(`索引已写入 ${join(ROOT, '00-索引', '采集清单.md')}`)
console.log(`命中 ${totalHits} 条 ｜ 归档 ${mds.length} 篇 ｜ 主题 ${dirs.length} 个`)
