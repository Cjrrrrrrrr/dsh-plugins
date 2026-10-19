/**
 * dsh-hiddify · 搜索层 —— 经 Hiddify 代理调用多种外网搜索引擎 + 正文抓取。
 *
 * 引擎实测结论（2026-10-16，经 127.0.0.1:12399 代理，查询词 "铁板神数"）：
 *   ✅ duckduckgo   html.duckduckgo.com/html/   HTTP 200 / 33KB / 命中 29 处 / 10 条结果标记
 *   ✅ ddg-lite     lite.duckduckgo.com/lite/   HTTP 200 / 24KB / 命中 31 处
 *   ✅ bing         www.bing.com/search?mkt=zh-CN&ensearch=0  HTTP 200 / 100KB / 10 个 b_algo
 *      （注意：带 setlang 而不带 mkt 时 Bing 返回空结果页；带 mkt 才有结果，已实测）
 *   ⚠️ marginalia   search.marginalia.nu        可访问但中文命中低（独立网索引）
 *   ❌ google       返回 JS 墙（enablejs），无结果 → 保留为可选，失败即如实报告
 *   ❌ brave/startpage/mojeek/searx 公共实例/ecosia/yandex/yep：429 / 403 / JS 墙 / 无结果
 *   国内引擎（直连，不走代理）：baidu / so360 / sogou 均 200，中文命理内容覆盖最强
 */
import { proxyFetch } from './proxy.js'

/** 引擎定义：build(url) 生成请求地址，parse(html) 抽出结果。 */
export const ENGINES = {
  duckduckgo: {
    label: 'DuckDuckGo',
    region: 'foreign',
    build: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    parse: parseDuckDuckGo,
  },
  'ddg-lite': {
    label: 'DuckDuckGo Lite',
    region: 'foreign',
    build: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
    parse: parseDuckDuckGo,
  },
  bing: {
    label: 'Bing',
    region: 'foreign',
    build: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&mkt=zh-CN&ensearch=0&count=30`,
    parse: parseBing,
  },
  google: {
    label: 'Google',
    region: 'foreign',
    build: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&num=30&hl=zh-CN&gl=cn`,
    parse: parseGoogle,
  },
  marginalia: {
    label: 'Marginalia',
    region: 'foreign',
    build: (q) => `https://search.marginalia.nu/search?query=${encodeURIComponent(q)}`,
    parse: parseGeneric,
  },
  baidu: {
    label: '百度',
    region: 'domestic',
    build: (q) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}&rn=30`,
    parse: parseBaidu,
  },
  so360: {
    label: '360 搜索',
    region: 'domestic',
    build: (q) => `https://www.so.com/s?q=${encodeURIComponent(q)}&pn=1`,
    parse: parse360,
  },
  sogou: {
    label: '搜狗',
    region: 'domestic',
    build: (q) => `https://www.sogou.com/web?query=${encodeURIComponent(q)}`,
    parse: parseGeneric,
  },
  // ── 以下三个是「API 型」古籍源：不依赖搜索引擎的爬虫对抗，命中率稳定得多 ──
  wikisource: {
    label: '维基文库',
    region: 'foreign',
    api: true,
    build: (q) => `https://zh.wikisource.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&srlimit=20`,
    parse: parseWikisource,
  },
  'archive-org': {
    label: 'Internet Archive',
    region: 'foreign',
    api: true,
    build: (q) => `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=year&fl%5B%5D=mediatype&rows=20&page=1&output=json`,
    parse: parseArchiveOrg,
  },
  ctext: {
    label: '中国哲学书电子化计划',
    region: 'foreign',
    api: true,
    build: (q) => `https://ctext.org/searchbooks.pl?if=gb&searchu=${encodeURIComponent(q)}`,
    parse: parseCtext,
  },
}

export const ENGINE_NAMES = Object.keys(ENGINES)
export const FOREIGN_ENGINES = ENGINE_NAMES.filter((n) => ENGINES[n].region === 'foreign')
export const DOMESTIC_ENGINES = ENGINE_NAMES.filter((n) => ENGINES[n].region === 'domestic')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 去标签 + 解码实体。 */
export function stripTags(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\s+/g, ' ')
    .trim()
}

/** 解 DuckDuckGo 的跳转链接（//duckduckgo.com/l/?uddg=<encoded>）。 */
function unwrapDdg(href) {
  const m = String(href).match(/uddg=([^&]+)/)
  if (m === null) return String(href)
  try {
    return decodeURIComponent(m[1])
  } catch {
    return String(href)
  }
}

function parseDuckDuckGo(html) {
  const out = []
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]{0,1200}?)(?=<a[^>]*class="[^"]*result__a|$)/gi
  let m
  while ((m = re.exec(html)) !== null) {
    const url = unwrapDdg(m[1].replace(/&amp;/g, '&'))
    const title = stripTags(m[2])
    const snip = m[3].match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
    out.push({ title, url, snippet: snip === null ? '' : stripTags(snip[1]) })
  }
  return out
}

function parseBing(html) {
  const out = []
  const blocks = String(html).split(/<li class="b_algo"/i).slice(1)
  for (const block of blocks) {
    const link = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (link === null) continue
    const para = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
    out.push({ title: stripTags(link[2]), url: link[1].replace(/&amp;/g, '&'), snippet: para === null ? '' : stripTags(para[1]) })
  }
  return out
}

function parseGoogle(html) {
  const out = []
  const re = /<a href="\/url\?q=([^"&]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    const url = decodeURIComponent(m[1])
    if (url.startsWith('https://www.google.') || url.startsWith('https://webcache.googleusercontent')) continue
    out.push({ title: stripTags(m[2]), url, snippet: '' })
  }
  return out
}

function parseBaidu(html) {
  const out = []
  const blocks = String(html).split(/<div[^>]*class="result[^"]*"/i).slice(1)
  for (const block of blocks) {
    const link = block.match(/<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (link === null) continue
    const abs = block.match(/mu="([^"]+)"/i)
    const url = abs === null ? link[1] : abs[1]
    const text = stripTags(block)
    out.push({ title: stripTags(link[2]), url, snippet: text.slice(0, 240) })
  }
  return out
}

/** 360 搜索：结果在 <li class="res-list"> 里，链接是 so.com 的跳转地址（真实地址需跟随跳转，抓取时自动处理）。 */
function parse360(html) {
  const out = []
  const blocks = String(html).split(/<li class="res-list"/i).slice(1)
  for (const block of blocks) {
    const link = block.match(/<h3[^>]*>[\s\S]{0,300}?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (link === null) continue
    const title = stripTags(link[2])
    if (title.length < 4) continue
    const cite = block.match(/<cite[^>]*>([\s\S]*?)<\/cite>/i)
    const desc = block.match(/class="res-desc"[^>]*>([\s\S]*?)<\/p>/i)
    out.push({
      title,
      url: link[1].replace(/&amp;/g, '&'),
      snippet: desc === null ? stripTags(block).slice(0, 200) : stripTags(desc[1]),
      note: cite === null ? undefined : `真实站点 ${stripTags(cite[1])}`,
    })
  }
  return out
}

/** 维基文库（MediaWiki API）：返回经典古籍全文检索命中。 */
function parseWikisource(body) {
  let json
  try { json = JSON.parse(body) } catch { return [] }
  const hits = json?.query?.search ?? []
  return hits.map((h) => ({
    title: h.title,
    url: `https://zh.wikisource.org/zh-hans/${encodeURIComponent(String(h.title).replace(/ /g, '_'))}`,
    snippet: stripTags(h.snippet ?? '').slice(0, 240),
    note: h.wordcount !== undefined ? `约 ${h.wordcount} 词` : undefined,
  }))
}

/** Internet Archive 高级检索：古籍扫描件/全文条目。 */
function parseArchiveOrg(body) {
  let json
  try { json = JSON.parse(body) } catch { return [] }
  const docs = json?.response?.docs ?? []
  return docs.map((d) => ({
    title: Array.isArray(d.title) ? d.title[0] : (d.title ?? d.identifier),
    url: `https://archive.org/details/${d.identifier}`,
    snippet: [d.mediatype, d.year].filter((x) => x !== undefined && x !== '').join(' · '),
    note: `identifier: ${d.identifier}`,
  }))
}

/** 中国哲学书电子化计划：站内检索，链接指向 ctext 内部文档。 */
function parseCtext(html) {
  const out = []
  const seen = new Set()
  const re = /<a[^>]*href="(\/(?:wiki|text|searchbooks)\.pl\?[^"]+)"[^>]*>([\s\S]{2,120}?)<\/a>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    const title = stripTags(m[2])
    if (title.length < 2) continue
    const url = `https://ctext.org${m[1].replace(/&amp;/g, '&')}`
    if (seen.has(url)) continue
    seen.add(url)
    out.push({ title, url, snippet: '' })
  }
  return out
}

function parseGeneric(html) {
  const out = []
  const seen = new Set()
  const re = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]{2,160}?)<\/a>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    const url = m[1].replace(/&amp;/g, '&')
    if (/(duckduckgo|bing|google|baidu|sogou|so\.com|w3\.org|schema\.org|microsoft|gstatic|googleapis)/i.test(url)) continue
    if (seen.has(url)) continue
    const title = stripTags(m[2])
    if (title.length < 4) continue
    seen.add(url)
    out.push({ title, url, snippet: '' })
  }
  return out
}

/** 抓一个引擎。外网引擎走代理，国内引擎直连（正好对应 cn-bypass 的分流设计）。
 *  返回 {engine, label, ok, results, status, ms, error} */
export async function searchEngine(engine, query, { proxy, timeoutMs = 20000, signal } = {}) {
  const def = ENGINES[engine]
  if (def === undefined) return { engine, ok: false, error: `未知引擎 ${engine}` }
  const url = def.build(query)
  // 双通道：外网引擎「先代理、再直连」，国内引擎「先直连、再代理」。
  // 依据 2026-10-16 实测：同一天里代理可用→不可用、而 Bing/维基文库/ctext 直连可用，
  // 只认一条路会让整层检索随通道波动而全灭。
  const order = def.region === 'foreign'
    ? [{ p: proxy, via: 'proxy' }, { p: undefined, via: 'direct' }]
    : [{ p: undefined, via: 'direct' }, { p: proxy, via: 'proxy' }]
  const attempts = order.filter((a, i) => i === 0 || a.p !== undefined || order[0].p !== undefined || true)
  const started = Date.now()
  let last = undefined
  for (const attempt of attempts) {
    if (attempt.via === 'proxy' && (attempt.p === undefined || attempt.p === null)) continue
    try {
      const res = await proxyFetch(url, { proxy: attempt.p, timeoutMs, signal, headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' } })
      const results = def.parse(res.text).filter((r) => r.url.startsWith('http')).slice(0, 30)
      if (res.status === 200 && results.length > 0) {
        return { engine, label: def.label, ok: true, status: res.status, bytes: res.body.length, via: attempt.via, ms: Date.now() - started, results }
      }
      last = { status: res.status, bytes: res.body.length, via: attempt.via, results: [] }
    } catch (error) {
      last = { status: 0, via: attempt.via, results: [], error: String(error?.message ?? error).slice(0, 160) }
    }
  }
  return {
    engine,
    label: def.label,
    ok: false,
    status: last?.status ?? 0,
    bytes: last?.bytes,
    via: last?.via,
    ms: Date.now() - started,
    results: [],
    error: last?.error ?? (last?.status === 202 || last?.status === 403 || last?.status === 429
      ? `HTTP ${last.status}：出口 IP 被该引擎限流/挑战（换节点可恢复，见 hiddify_nodes）`
      : `HTTP ${last?.status ?? 0} 但未解析出结果（可能无结果、被反爬，或查询词过度限定）`),
  }
}

/** 旧实现保留为参考（单通道） */
async function searchEngineSinglePath(engine, query, { proxy, timeoutMs = 20000, signal } = {}) {
  const def = ENGINES[engine]
  if (def === undefined) return { engine, ok: false, error: `未知引擎 ${engine}` }
  const url = def.build(query)
  const useProxy = def.region === 'foreign' ? proxy : undefined
  const started = Date.now()
  try {
    const res = await proxyFetch(url, { proxy: useProxy, timeoutMs, signal, headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' } })
    const results = def.parse(res.text).filter((r) => r.url.startsWith('http')).slice(0, 30)
    return {
      engine,
      label: def.label,
      ok: res.status === 200 && results.length > 0,
      status: res.status,
      bytes: res.body.length,
      via: useProxy === undefined ? 'direct' : 'proxy',
      ms: Date.now() - started,
      results,
      error: results.length === 0
        ? (res.status === 202 || res.status === 403 || res.status === 429
            ? `HTTP ${res.status}：出口 IP 被该引擎限流/挑战（换节点可恢复，见 hiddify_nodes）`
            : `HTTP ${res.status} 但未解析出结果（可能无结果、被反爬，或查询词过度限定）`)
        : undefined,
    }
  } catch (error) {
    return { engine, label: def.label, ok: false, status: 0, via: useProxy === undefined ? 'direct' : 'proxy', ms: Date.now() - started, results: [], error: String(error?.message ?? error).slice(0, 160) }
  }
}

/** 多引擎并发检索 + 按 URL 去重。 */
export async function multiEngineSearch(query, { engines, proxy, timeoutMs, signal } = {}) {
  const picked = Array.isArray(engines) && engines.length > 0 ? engines.filter((e) => ENGINES[e] !== undefined) : ['duckduckgo', 'bing']
  const settled = await Promise.all(picked.map((e) => searchEngine(e, query, { proxy, timeoutMs, signal })))
  const seen = new Set()
  const merged = []
  for (const r of settled) {
    for (const item of r.results) {
      const key = item.url.replace(/[#?].*$/, '').replace(/\/$/, '')
      if (seen.has(key)) continue
      seen.add(key)
      merged.push({ ...item, engine: r.engine })
    }
  }
  return { query, engines: picked, perEngine: settled, merged, dedupedCount: merged.length }
}

/** 抓页面正文（HTML → 文本），供资料搜集使用。 */
export async function fetchPage(url, { proxy, timeoutMs = 30000, signal, maxChars = 200000 } = {}) {
  const res = await proxyFetch(url, { proxy, timeoutMs, signal, headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } })
  const raw = res.text
  const title = (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) ?? [])[1] ?? ''
  const text = stripTags(raw).slice(0, maxChars)
  return { url: res.url, status: res.status, title: stripTags(title), text, bytes: res.body.length }
}
