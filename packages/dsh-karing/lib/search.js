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
    // 维基文库按**繁体**建索引：简体检索词 + 引号精确匹配实测返回 0 命中，
    // 所以这里先把检索词折成繁体、去掉引号，再交给 MediaWiki 搜索。
    build: (q) => `https://zh.wikisource.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(foldScript(String(q).replace(/["'“”]/g, ' ').trim()))}&format=json&srlimit=20`,
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

/**
 * 默认引擎集 —— 按 2026-10-17 经 Karing 代理的实测结果排序：
 *   百度   直连 200 / 29 条 / 29 相关 / 1.6s   ← 中文覆盖最好
 *   360    直连 200 /  7 条 /  7 相关 / 1.1s
 *   Bing   代理 200 /  1 条 /  0 相关 / 1.0s   ← 通但会投毒，留作补充
 *   维基文库 代理 200 /  4 条 /  4 相关 / 1.8s   ← 古籍原文唯一稳定源
 *   IA     代理 200 /  8 条 /  4 相关 / 1.2s   ← 古籍扫描件
 * DuckDuckGo / Google / ctext 实测已不可用（超时或解析不出），故不入默认集。
 */
export const DEFAULT_ENGINES = ['baidu', 'so360', 'bing', 'wikisource', 'archive-org']

/**
 * 简繁折叠表（只覆盖本领域高频字，够用且零依赖）。
 * 为什么要它：维基文库/古籍源用**繁体**建页，而检索词多是简体 ——
 * 实测 `"奇门遁甲" 秘笈` 在维基文库能返回 15+ 条，但相关性判定按字符严格比对会全部判 0，
 * 结果被整批丢掉。折叠后再比，简繁两边就能对上。
 */
export const S2T = {
  数: '數', 门: '門', 铁: '鐵', 阴: '陰', 阳: '陽', 术: '術', 余: '餘', 书: '書', 经: '經',
  传: '傳', 学: '學', 历: '曆', 纪: '紀', 记: '記', 录: '錄', 谱: '譜', 验: '驗', 证: '證',
  统: '統', 关: '關', 图: '圖', 说: '說', 论: '論', 诀: '訣', 赋: '賦', 星: '星', 斗: '斗',
  微: '微', 紫: '紫', 奇: '奇', 遁: '遁', 甲: '甲', 政: '政', 四: '四', 八: '八', 字: '字',
  命: '命', 理: '理', 神: '神', 板: '板', 版: '版', 皇: '皇', 极: '極', 世: '世', 渊: '淵',
  海: '海', 子: '子', 平: '平', 滴: '滴', 天: '天', 髓: '髓', 通: '通', 会: '會', 三: '三',
  星: '星', 宗: '宗', 果: '果', 老: '老', 张: '張', 阁: '閣', 阁: '閣', 阵: '陣', 局: '局',
  盘: '盤', 宫: '宮', 曜: '曜', 宿: '宿', 运: '運', 元: '元', 节: '節', 气: '氣', 时: '時',
  间: '間', 定: '定', 例: '例', 法: '法', 起: '起', 用: '用', 断: '斷', 卦: '卦', 案: '案',
  实: '實', 战: '戰', 秘: '秘', 籍: '籍', 古: '古', 本: '本', 源: '源', 流: '流', 派: '派',
  择: '擇', 日: '日', 课: '課', 卜: '卜', 筮: '筮', 六: '六', 爻: '爻', 太: '太', 乙: '乙',
  符: '符', 应: '應', 变: '變', 化: '化', 格: '格', 曜: '曜', 煞: '煞', 空: '空', 亡: '亡',
  贵: '貴', 禄: '祿', 权: '權', 科: '科', 忌: '忌', 凶: '凶', 吉: '吉', 旺: '旺', 衰: '衰',
  庙: '廟', 陷: '陷', 田: '田', 宅: '宅', 财: '財', 帛: '帛', 官: '官', 禄: '祿', 夫: '夫',
  妻: '妻', 疾: '疾', 厄: '厄', 迁: '遷', 移: '移', 奴: '奴', 仆: '僕', 福: '福', 德: '德',
}

/** 简繁折叠：把文本里的字统一折到繁体一侧（表里没有的字原样保留）。 */
export function foldScript(text) {
  let out = ''
  for (const ch of String(text ?? '')) out += S2T[ch] ?? ch
  return out
}

/** 从检索词里抽出「核心词」用于相关性打分（去引号、去 site:/OR 等操作符）。 */
export function coreTerm(query) {
  const t = String(query ?? '')
    .replace(/site:\S+/gi, ' ')
    .replace(/(OR|AND)/gi, ' ')
    .replace(/["'“”]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((x) => x.length >= 2)
    .sort((a, b) => b.length - a.length)[0] ?? ''
  return t
}

/**
 * 统计一批结果里有多少条真的命中了核心词 —— 用来判断引擎是否被限流/投毒。
 * 用「核心词的字符按序出现」而不是正则子串匹配：中文检索里能容忍分词与标点差异，
 * 又不会像 `铁板` 那样误判「钢板规格表」（因为核心词取的是最长词，例如 `铁板神数`）。
 */
export function relevanceOf(results, query) {
  const term = coreTerm(query)
  if (term.length === 0) return results.length
  const chars = [...foldScript(term)]
  return results.filter((r) => {
    const hay = foldScript(`${r.title} ${r.snippet}`)
    let i = 0
    for (const c of hay) {
      if (c === chars[i]) i += 1
      if (i === chars.length) break
    }
    return i === chars.length
  }).length
}

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

/** 摘要清洗：百度/360 的片段里常夹着 `srcid="1" data-op={...}` 这类属性噪声。 */
export function cleanSnippet(text) {
  let t = String(text ?? '')
  // 百度结果块尾部会夹 JSON（","url":{"url":"..."}），在第一个 JSON 分隔符处截断
  const cut = t.search(/["']\s*,\s*["']|["']\s*:\s*\{|\{\s*"/)
  if (cut > 30) t = t.slice(0, cut)
  return t
    .replace(/[a-zA-Z-]+="[^"]*"/g, ' ')
    .replace(/[a-zA-Z-]+=\{[^}]*\}/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s>·—\-|]+/, '')
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
    // 摘要优先取 abstract 类元素；取不到再退回「块尾部」（百度把属性放在块首，尾部才是正文）
    const absEl = block.match(/class="[^"]*(?:abstract|c-abstract|content-right|line-clamp|summary|content-line)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span|p)>/i)
    const snippet = absEl !== null
      ? cleanSnippet(stripTags(absEl[1])).slice(0, 240)
      : cleanSnippet(stripTags(block).slice(-300)).slice(0, 240)
    const title = stripTags(link[2])
    // 摘要与标题重复时留空，避免把标题当摘要灌进语料
    out.push({ title, url, snippet: snippet.length > 0 && !title.includes(snippet.slice(0, 20)) && !snippet.includes(title.slice(0, 20)) ? snippet : '' })
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
export async function searchEngine(engine, query, { proxy, timeoutMs = 20000, signal, forceProxy = false } = {}) {
  const def = ENGINES[engine]
  if (def === undefined) return { engine, ok: false, error: `未知引擎 ${engine}` }
  const url = def.build(query)
  // 三通道策略：
  //   forceProxy=true → **只走代理**，不降级（「强制外网检索」模式，国内引擎也会被带出国外出口）
  //   外网引擎        → 先代理、再直连
  //   国内引擎        → 先直连、再代理
  // 依据实测：同一天里代理可用→不可用、而 Bing/维基文库直连可用，只认一条路会让整层检索随通道波动而全灭。
  const order = forceProxy
    ? [{ p: proxy, via: 'proxy-forced' }]
    : (def.region === 'foreign'
        ? [{ p: proxy, via: 'proxy' }, { p: undefined, via: 'direct' }]
        : [{ p: undefined, via: 'direct' }, { p: proxy, via: 'proxy' }])
  const attempts = order.filter((a, i) => i === 0 || a.p !== undefined || order[0].p !== undefined || true)
  const started = Date.now()
  let last = undefined
  for (const attempt of attempts) {
    if (attempt.via.startsWith('proxy') && (attempt.p === undefined || attempt.p === null)) continue
    try {
      const perEngineTimeout = def.api === true ? Math.max(timeoutMs, 35000) : timeoutMs
      const res = await proxyFetch(url, { proxy: attempt.p, timeoutMs: perEngineTimeout, signal, headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' } })
      const results = def.parse(res.text).filter((r) => r.url.startsWith('http')).slice(0, 30)
      if (res.status === 200 && results.length > 0) {
        const relevant = relevanceOf(results, query)
        return { engine, label: def.label, ok: true, status: res.status, bytes: res.body.length, via: attempt.via, ms: Date.now() - started, results, relevant }
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
export async function multiEngineSearch(query, { engines, proxy, timeoutMs, signal, forceProxy = false } = {}) {
  const picked = Array.isArray(engines) && engines.length > 0 ? engines.filter((e) => ENGINES[e] !== undefined) : DEFAULT_ENGINES
  const settled = await Promise.all(picked.map((e) => searchEngine(e, query, { proxy, timeoutMs, signal, forceProxy })))
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
