/**
 * 维基文库古籍批量抓取 —— 走 MediaWiki API 取**干净 wikitext**（比抓 HTML 少一大截导航噪声），
 * 按书目分卷归档到命理资料库。
 *
 * 用法：
 *   node tools/fetch-wikisource.mjs --list                 列出预置书目
 *   node tools/fetch-wikisource.mjs --book 紫微斗數全書      抓一本
 *   node tools/fetch-wikisource.mjs --all                   抓全部预置书目
 *   node tools/fetch-wikisource.mjs --book X --root <语料根>
 *
 * 实测（2026-10-17，经 Karing 代理 127.0.0.1:3067）：zh.wikisource.org MediaWiki API 200，
 * 《紫微斗數全書》解出 4 个子页面（全覽/卷一/卷二/卷三）。
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { proxyFetch } from '../lib/proxy.js'
import { readRuntime, isAlive } from '../lib/core.js'

const args = process.argv.slice(2)
const argOf = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : d }
const ROOT = argOf('root', 'E:\\deepseekharness\\mingli-corpus')
const ONLY = argOf('book', '')
const ALL = args.includes('--all')
const MAX_PAGES = Number(argOf('max-pages', '40'))
const MODE = argOf('mode', 'wikitext')
const PAGES = argOf('pages', '')

const rt = readRuntime(join(import.meta.dirname, '..', 'data', 'runtime.json'))
const PROXY = rt !== undefined && isAlive(rt.pid) ? `http://127.0.0.1:${rt.ports?.rule ?? 3067}` : `http://127.0.0.1:3067`
const API = 'https://zh.wikisource.org/w/api.php'

/** 预置书目 → 归档目录（标题用繁体，维基文库以繁体建页） */
const BOOKS = {
  紫微斗數全書: { dir: '01-紫微斗数与八字/紫微斗数', note: '明代紫微斗数传世原典（太微赋/形性赋/诸星问答论等）' },
  三命通會: { dir: '01-紫微斗数与八字/八字', note: '明·万民英撰，八字命理集大成之作' },
  淵海子平: { dir: '01-紫微斗数与八字/八字', note: '宋·徐大升编，子平法奠基之作' },
  滴天髓: { dir: '01-紫微斗数与八字/八字', note: '京图撰、刘伯温注、任铁樵疏' },
  煙波釣叟歌: { dir: '03-奇门遁甲', note: '奇门遁甲总纲歌诀' },
  奇門遁甲秘笈大全: { dir: '03-奇门遁甲', note: '奇门要诀汇编' },
  皇極經世書: { dir: '04-铁板神数', note: '宋·邵雍撰，元会运世数理，铁板/邵子神数的源头' },
  果老星宗: { dir: '02-七政四余', note: '七政四余（星宗）核心典籍' },
  星宗: { dir: '02-七政四余', note: '七政四余星命体系' },
  // ── 2026-10-17 补：上面三个在维基文库用别的标题建页（API 搜出来的真名）──
  皇極經世: { dir: '04-铁板神数', note: '宋·邵雍撰（维基文库正名条目）' },
  '皇極經世書 (四庫全書本)': { dir: '04-铁板神数', note: '四庫全書本《皇極經世書》' },
  張果星宗: { dir: '02-七政四余', note: '七政四余核心典籍（即俗称《果老星宗》）' },
  '星命溯源 (四庫全書本)': { dir: '02-七政四余', note: '四庫全書本星命溯源，七政四余体系' },
  '欽定古今圖書集成/博物彙編/藝術典/星命部': { dir: '02-七政四余', note: '古今圖書集成·星命部，历代星命术数汇编' },
  // ── 2026-10-19 补：奇门遁甲古籍（这是语料库最薄的一块，原来只有煙波釣叟歌）──
  奇門遁甲統宗: { dir: '03-奇门遁甲', note: '奇门遁甲要籍，统宗诸家起局与断法' },
  遁甲演義: { dir: '03-奇门遁甲', note: '明·程道生撰，四库全书子部术数类' },
  '遁甲演義 (四庫全書本)': { dir: '03-奇门遁甲', note: '四库全书本《遁甲演義》' },
  奇門遁甲元靈經: { dir: '03-奇门遁甲', note: '奇门遁甲元灵经' },
  奇门宝鉴御定: { dir: '03-奇门遁甲', note: '即《御定奇门宝鉴》，清宫御定奇门要籍' },
  '欽定古今圖書集成/博物彙編/藝術典/術數部': { dir: '06-其他命理', note: '古今图书集成·术数部，历代术数总汇' },
  // ── 补：紫微斗数与星学 ──
  紫微斗數: { dir: '01-紫微斗数与八字/紫微斗数', note: '紫微斗数总述条目' },
  // ── 2026-10-19 补：七政四余核心典籍《星學大成》（上轮被限流，这次重试成功）──
  '星學大成 (四庫全書本)': { dir: '02-七政四余', note: '明·万民英撰，四库全书本，七政四余集大成之作' },
  星學大成: { dir: '02-七政四余', note: '明·万民英撰，七政四余集大成之作' },
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const safeName = (s) => String(s).replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'untitled'

/** wikitext → 轻量清洗（去模板/链接语法，保留标题与正文） */
function cleanWikitext(t) {
  return String(t ?? '')
    .replace(/<noinclude>[\s\S]*?<\/noinclude>/g, '')
    .replace(/<ref[\s\S]*?<\/ref>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\{\{[\s\S]{0,400}?\}\}/g, '')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/'''?/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function api(params, { retries = 4 } = {}) {
  const url = `${API}?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const res = await proxyFetch(url, { proxy: PROXY, timeoutMs: 30000 })
      // 维基文库限流时返回纯文本 "You are making too many requests"
      if (/You are making too many requests/i.test(res.text)) {
        const wait = 5000 * attempt
        console.log(`    ⏳ 被限流，等 ${wait / 1000}s 后重试（${attempt}/${retries}）`)
        await sleep(wait)
        continue
      }
      return JSON.parse(res.text)
    } catch (error) {
      if (attempt === retries) throw error
      await sleep(2000 * attempt)
    }
  }
  throw new Error('重试耗尽（维基文库持续限流）')
}

/** 列出某书的所有子页面（含主页本身） */
async function listPages(book) {
  const j = await api({ action: 'query', list: 'allpages', apprefix: `${book}/`, aplimit: String(MAX_PAGES) })
  const subs = (j.query?.allpages ?? []).map((p) => p.title)
  // 主页单独确认存在性
  const main = await api({ action: 'query', titles: book, prop: 'info' })
  const exists = (main.query?.pages ?? []).some((p) => p.missing !== true)
  return exists ? [book, ...subs] : subs
}

/** 取单页 wikitext */
async function fetchWikitext(title) {
  const j = await api({ action: 'query', titles: title, prop: 'revisions', rvprop: 'content', rvslots: 'main' })
  const page = (j.query?.pages ?? [])[0]
  return page?.revisions?.[0]?.slots?.main?.content
}

/**
 * 取单页**渲染后**的纯文本（action=parse）。
 * 为什么需要：维基文库的「全覽」页 wikitext 里只有 {{:書名/卷一}} 这类模板引用，
 * 离线清洗会把它们全删掉 → 实测《紫微斗數全書/全覽》走 wikitext 只得 29 字，
 * 走 action=parse 能拿到 55,045 汉字（78% 汉字占比）。所以整本书用 parse 一次抓完更靠谱。
 */
async function fetchParsedText(title) {
  const u = `${API}?action=parse&page=${encodeURIComponent(title)}&prop=text&format=json&formatversion=2&disablelimitreport=1&disableeditsection=1`
  const res = await proxyFetch(u, { proxy: PROXY, timeoutMs: 60000 })
  if (/You are making too many requests/i.test(res.text)) throw new Error('限流')
  const j = JSON.parse(res.text)
  const html = j.parse?.text ?? ''
  // 去 script/style/标签：用 split 而不是带反斜杠的正则，避免转义地狱
  let t = html
  for (const tag of ['script', 'style']) {
    const parts = t.split('<' + tag)
    if (parts.length > 1) t = parts.map((c, i) => (i === 0 ? c : c.slice(c.indexOf('</' + tag + '>') + tag.length + 3))).join('')
  }
  t = t.replace(/<[^>]+>/g, ' ')
  t = t.split('&#160;').join(' ').split('&nbsp;').join(' ').split('&amp;').join('&')
  const NL = String.fromCharCode(10)
  t = t.split(NL).map((l) => l.split(' ').filter(Boolean).join(' ')).filter((l) => l.length > 0).join(NL)
  return t.trim()
}

if (args.includes('--list')) {
  for (const [k, v] of Object.entries(BOOKS)) console.log(`${k.padEnd(14)} → ${v.dir}   ${v.note}`)
  process.exit(0)
}
if (!ALL && ONLY.length === 0 && PAGES.length === 0) { console.log('用法：--all / --book <书名> / --pages <页面列表>；--list 看书目'); process.exit(1) }

if (PAGES.length > 0) {
  // 指定页面列表（逗号分隔），走 --mode 指定的取法
  const dirs = { '01': '01-紫微斗数与八字/紫微斗数', '02': '02-七政四余', '03': '03-奇门遁甲', '04': '04-铁板神数', '06': '06-其他命理' }
  const dir = argOf('dir', '06-其他命理')
  for (const title of PAGES.split(',').map((x) => x.trim()).filter(Boolean)) {
    try {
      const text = MODE === 'parse' ? await fetchParsedText(title) : cleanWikitext(await fetchWikitext(title))
      if (typeof text !== 'string' || text.length < 200) { console.log(`  ⚠️ ${title}：内容过短（${text?.length ?? 0} 字）`); continue }
      const outDir = join(ROOT, dir)
      mkdirSync(outDir, { recursive: true })
      const file = join(outDir, `古籍-${safeName(title)}.md`)
      writeFileSync(file, ['---', `title: ${JSON.stringify(title)}`, `url: https://zh.wikisource.org/zh-hans/${encodeURIComponent(title.replace(/ /g, '_'))}`, `source_engine: 维基文库（${MODE}）`, `fetched_at: ${new Date().toISOString()}`, `chars: ${text.length}`, '---', '', `# ${title}`, '', text, ''].join(String.fromCharCode(10)), 'utf8')
      console.log(`  ✅ ${title}（${text.length} 字）→ ${dir}`)
    } catch (error) {
      console.log(`  ❌ ${title}：${String(error?.message ?? error).slice(0, 60)}`)
    }
    await sleep(1800)
  }
  process.exit(0)
}

const targets = ALL ? Object.entries(BOOKS) : Object.entries(BOOKS).filter(([k]) => k === ONLY)
if (targets.length === 0) { console.log(`没有书目 "${ONLY}"；用 --list 看可用书目`); process.exit(1) }

console.log(`代理：${PROXY} ｜ 根目录：${ROOT}`)
let totalPages = 0
let totalChars = 0
for (const [book, spec] of targets) {
  const dir = join(ROOT, spec.dir)
  mkdirSync(dir, { recursive: true })
  let pages
  try {
    pages = await listPages(book)
  } catch (error) {
    console.log(`❌ ${book}：列子页面失败 ${String(error?.message ?? error).slice(0, 80)}`)
    continue
  }
  if (pages.length === 0) { console.log(`⚠️ ${book}：维基文库没有这个条目（跳过）`); continue }
  console.log(`\n===== ${book}（${pages.length} 页）→ ${spec.dir} =====`)
  let saved = 0
  for (const title of pages) {
    try {
      const wt = await fetchWikitext(title)
      if (typeof wt !== 'string' || wt.length < 50) { console.log(`  ⚠️ ${title}：内容过短（${wt?.length ?? 0} 字）`); continue }
      const body = cleanWikitext(wt)
      const file = join(dir, `古籍-${safeName(title)}.md`)
      writeFileSync(file, [
        '---',
        `title: ${JSON.stringify(title)}`,
        `url: https://zh.wikisource.org/zh-hans/${encodeURIComponent(title.replace(/ /g, '_'))}`,
        'source_engine: 维基文库 MediaWiki API',
        `book: ${JSON.stringify(book)}`,
        `note: ${JSON.stringify(spec.note)}`,
        `fetched_at: ${new Date().toISOString()}`,
        `chars: ${body.length}`,
        '---',
        '',
        `# ${title}`,
        '',
        `> 来源：维基文库（MediaWiki API 取 wikitext，已做轻量清洗）`,
        `> 说明：${spec.note}`,
        '',
        body,
        '',
      ].join('\n'), 'utf8')
      saved += 1
      totalPages += 1
      totalChars += body.length
      console.log(`  ✅ ${title}（${body.length} 字）`)
    } catch (error) {
      console.log(`  ❌ ${title}：${String(error?.message ?? error).slice(0, 80)}`)
    }
    await sleep(1800)   // 放慢：实测 400ms 会触发 wikisource 限流
  }
  console.log(`  ${book}：归档 ${saved}/${pages.length} 页`)
}
console.log(`\n合计归档 ${totalPages} 页，${totalChars} 字 → ${ROOT}`)
