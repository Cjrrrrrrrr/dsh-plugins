/**
 * 命理学术文献采集 —— 用 dsh-scholar 的数据层（OpenAlex/Crossref）按英文主题词检索
 * 中国命理（八字、紫微、奇门、相术、风水、择日…）的学术研究，归档到 16-学术研究。
 *
 * 为什么需要这个：前面所有采集都是「网页/古籍」，唯独缺**学术视角**——
 * 人类学、宗教学、科学传播学里关于命理的实证研究、批判研究、田野调查，一条都没有。
 *
 * 用法：
 *   node tools/collect-scholar.mjs --list
 *   node tools/collect-scholar.mjs --run            跑全部主题
 *   node tools/collect-scholar.mjs --run --topic 八字
 */
import { writeFileSync, appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CORPUS = 'E:\\deepseekharness\\mingli-corpus\\16-学术研究'
const SCHOLAR = 'E:\\deepseekharness\\dsh-scholar\\lib\\sources.js'

const argv = process.argv.slice(2)
const argOf = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d }

/** 主题 → 英文检索词（学术库中文覆盖率低，用英文最有效）。 */
const TOPICS = {
  八字: 'Chinese astrology Bazi four pillars birth fate',
  紫微斗数: 'Zi Wei Dou Shu Purple Star astrology Chinese',
  奇门遁甲: 'Qimen Dunjia Chinese divination metaphysics',
  风水: 'Chinese feng shui geomancy anthropology',
  择日: 'Chinese calendar almanac day selection auspicious',
  相术: 'Chinese physiognomy face reading divination',
  命理通论: 'Chinese divination destiny fatalism anthropology',
  算命实践: 'Chinese fortune telling practice ethnography',
  易学象数: 'Yijing I Ching numerology cosmology',
  姓名学: 'Chinese name analysis numerology onomancy',
}

// OpenAlex/Crossref 的 polite pool 联系邮箱。请设环境变量 SCHOLAR_MAILTO 或 --mailto 传入，
// 留空也能用（只是拿不到 polite pool 的更高频率配额）。
const MAILTO = (argOf('mailto', '') || process.env.SCHOLAR_MAILTO || '').trim()
if (MAILTO.length === 0) console.warn('提示：未提供联系邮箱（--mailto 或 SCHOLAR_MAILTO），OpenAlex/Crossref 会走较低频率的公共池')

/** 把一条学术记录渲染成 md。 */
function renderRecord(r, topic, query) {
  return [
    '---',
    `title: ${JSON.stringify(r.title ?? '')}`,
    `url: ${r.url ?? ''}`,
    `doi: ${r.doi ?? ''}`,
    'source_engine: OpenAlex/Crossref 学术检索',
    `topic: ${topic}`,
    `query: ${JSON.stringify(query)}`,
    `year: ${r.year ?? ''}`,
    `venue: ${JSON.stringify(r.venue ?? '')}`,
    `authors: ${JSON.stringify(r.authors ?? [])}`,
    `citations: ${r.citations ?? 0}`,
    `pdf: ${r.pdfUrl ?? ''}`,
    `fetched_at: ${new Date().toISOString()}`,
    '---',
    '',
    `# ${r.title ?? '(无标题)'}`,
    '',
    `> 作者：${(r.authors ?? []).join(', ') || '(无)'}`,
    `> 发表于：${r.venue ?? '(无)'} ｜ ${r.year ?? '?'} ｜ 被引 ${r.citations ?? 0}`,
    `> DOI：${r.doi ?? '—'}`,
    `> 链接：${r.url ?? '—'}`,
    r.pdfUrl ? `> 开放获取 PDF：${r.pdfUrl}` : '',
    '',
    '## 摘要',
    '',
    String(r.abstract ?? '(无摘要)').trim(),
    '',
  ].filter((x) => x !== '').join('\n')
}

const safe = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'untitled'

if (argv.includes('--list')) {
  for (const [k, v] of Object.entries(TOPICS)) console.log(`${k.padEnd(10)} → ${v}`)
  process.exit(0)
}

if (!argv.includes('--run')) {
  console.log('用法：--list 看主题 / --run 跑全部 / --run --topic 八字')
  process.exit(0)
}

const only = argOf('topic', '')
const targets = only.length > 0 ? Object.entries(TOPICS).filter(([k]) => k === only) : Object.entries(TOPICS)
if (targets.length === 0) { console.error(`没有主题 ${only}`); process.exit(1) }

const { multiSearch } = await import('file://' + SCHOLAR.replace(/\\/g, '/'))
mkdirSync(CORPUS, { recursive: true })
const manifestPath = join(CORPUS, '_学术清单.jsonl')
const seen = new Set()
if (existsSync(manifestPath)) {
  for (const line of readFileSync(manifestPath, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue
    try { const r = JSON.parse(line); if (r.doi) seen.add(r.doi); else if (r.title) seen.add(r.title) } catch { /* 忽略 */ }
  }
}

let total = 0
let saved = 0
for (const [topic, query] of targets) {
  console.log(`\n===== ${topic} ===== ${query}`)
  let res
  try {
    res = await multiSearch({ query, sources: ['openalex', 'crossref'], limit: 20, sort: 'relevance', mailto: MAILTO })
  } catch (error) {
    console.log(`  ❌ 检索失败：${String(error?.message ?? error).slice(0, 80)}`)
    continue
  }
  console.log(`  命中 ${res.results.length} 条` + (res.errors?.length ? ` ｜ 部分源失败：${res.errors.map((e) => e.source).join(',')}` : ''))
  for (const r of res.results) {
    total += 1
    const key = r.doi ?? r.title
    if (key !== undefined && seen.has(key)) continue
    if (key !== undefined) seen.add(key)
    const file = join(CORPUS, `${safe(topic)}-${safe(r.title ?? 'untitled')}.md`)
    writeFileSync(file, renderRecord(r, topic, query), 'utf8')
    appendFileSync(join(CORPUS, '_学术清单.jsonl'), JSON.stringify({ topic, query, title: r.title, doi: r.doi, year: r.year, venue: r.venue, url: r.url, pdf: r.pdfUrl, file }) + '\n')
    saved += 1
  }
  await new Promise((r) => setTimeout(r, 1200))
}


