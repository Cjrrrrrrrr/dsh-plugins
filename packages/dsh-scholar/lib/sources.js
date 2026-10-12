/**
 * sources.js —— 学术检索数据源（纯函数 + fetch，无 DSH 依赖，可脱离 App 单测）。
 *
 * 全部走公开免费接口、无需 API key：
 *   · OpenAlex        2.5 亿+ 学术作品，全学科，元数据最全（含开放获取链接）
 *   · Crossref        DOI 权威注册库（出版社侧元数据）
 *   · arXiv           预印本（数理/CS/AI 最新成果，更新最快）
 *   · Semantic Scholar AI 语义检索 + 引用网络（无 key 时限流较紧）
 *   · PubMed          生物医学（NLM 官方 E-utilities）
 *
 * 统一记录形状：
 *   { source, id, doi, title, year, authors[], venue, citations, url, pdfUrl, abstract }
 */

import https from 'node:https'
import http from 'node:http'

/**
 * 单次 HTTP 请求。
 *
 * 为什么不用全局 fetch：本机（Windows + IPv6）下 Node 的 fetch 连
 * export.arxiv.org:443 会 "Connect Timeout Error"，而 curl（IPv4）正常。
 * 这里显式 family:4 强制 IPv4，并自带超时/重定向/取消，避免依赖运行时行为。
 */
function requestOnce(urlString, { timeoutMs, headers, signal }) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString)
    const mod = url.protocol === 'http:' ? http : https
    const req = mod.request(url, { method: 'GET', family: 4, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      // 响应流也必须挂 error：连接在中途被重置时若不处理，会在宿主里变成未捕获异常。
      res.on('error', reject)
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        location: res.headers.location,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)))
    req.on('error', reject)
    if (signal) {
      const onAbort = () => req.destroy(new Error('aborted'))
      signal.addEventListener('abort', onAbort, { once: true })
      req.on('close', () => signal.removeEventListener('abort', onAbort))
    }
    req.end()
  })
}

/** 带超时/重定向的文本 GET：非 2xx 抛错（错误里带前 200 字符正文）。 */
async function getText(url, { signal, timeoutMs = 20000, headers, redirects = 3 } = {}) {
  let current = url
  for (let hop = 0; hop <= redirects; hop++) {
    const res = await requestOnce(current, {
      timeoutMs,
      signal,
      headers: { 'user-agent': 'dsh-scholar/1.0 (research tool)', accept: '*/*', ...(headers ?? {}) },
    })
    if ([301, 302, 303, 307, 308].includes(res.status) && typeof res.location === 'string') {
      current = new URL(res.location, current).toString()
      continue
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`)
    return res.body
  }
  throw new Error(`too many redirects for ${url}`)
}

async function getJson(url, options) {
  return JSON.parse(await getText(url, options))
}

/** 把 OpenAlex 的倒排索引还原成摘要文本。 */
export function invertAbstract(inverted) {
  if (inverted === null || typeof inverted !== 'object') return ''
  const slots = []
  for (const [word, positions] of Object.entries(inverted)) {
    for (const position of positions ?? []) slots[position] = word
  }
  return slots.filter((x) => x !== undefined).join(' ')
}

/** 去掉 JATS/HTML 标签（Crossref 摘要常带）。 */
function stripMarkup(text) {
  return String(text ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

const year = (value) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 1500 && n < 2200 ? n : undefined
}

/** OpenAlex work → 统一记录。 */
export function mapOpenAlexWork(w) {
  return {
    source: 'openalex',
    id: w.id,
    doi: typeof w.doi === 'string' ? w.doi.replace(/^https?:\/\/doi\.org\//, '') : undefined,
    title: w.display_name ?? w.title ?? '(无标题)',
    year: year(w.publication_year),
    authors: (w.authorships ?? []).map((a) => a.author?.display_name).filter(Boolean),
    venue: w.primary_location?.source?.display_name ?? undefined,
    citations: w.cited_by_count,
    url: w.primary_location?.landing_page_url ?? w.id,
    pdfUrl: w.best_oa_location?.pdf_url ?? w.open_access?.oa_url ?? undefined,
    abstract: invertAbstract(w.abstract_inverted_index),
    isOpenAccess: w.open_access?.is_oa === true,
  }
}

/** Crossref item → 统一记录。 */
export function mapCrossrefItem(it) {
  return {
    source: 'crossref',
    id: it.DOI,
    doi: it.DOI,
    title: stripMarkup(it.title?.[0]) || '(无标题)',
    year: year(it.issued?.['date-parts']?.[0]?.[0]),
    authors: (it.author ?? []).map((a) => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean),
    venue: it['container-title']?.[0] ?? undefined,
    citations: it['is-referenced-by-count'],
    url: it.URL ?? (it.DOI ? `https://doi.org/${it.DOI}` : undefined),
    pdfUrl: (it.link ?? []).find((l) => l['content-type'] === 'application/pdf')?.URL,
    abstract: stripMarkup(it.abstract),
  }
}

// ───────────────────────── OpenAlex ─────────────────────────
export async function searchOpenAlex({ query, limit = 8, yearFrom, sort = 'relevance', mailto, signal } = {}) {
  const params = new URLSearchParams({ search: query, 'per-page': String(Math.min(limit, 50)) })
  if (mailto) params.set('mailto', mailto)
  if (yearFrom) params.set('filter', `from_publication_date:${yearFrom}-01-01`)
  if (sort === 'cited') params.set('sort', 'cited_by_count:desc')
  else if (sort === 'recent') params.set('sort', 'publication_date:desc')
  const data = await getJson(`https://api.openalex.org/works?${params}`, { signal })
  return (data.results ?? []).map(mapOpenAlexWork)
}

// ───────────────────────── Crossref ─────────────────────────
export async function searchCrossref({ query, limit = 8, yearFrom, sort = 'relevance', mailto, signal } = {}) {
  const params = new URLSearchParams({ query, rows: String(Math.min(limit, 50)) })
  if (mailto) params.set('mailto', mailto)
  if (sort === 'cited') params.set('sort', 'is-referenced-by-count'), params.set('order', 'desc')
  else if (sort === 'recent') params.set('sort', 'published'), params.set('order', 'desc')
  const data = await getJson(`https://api.crossref.org/works?${params}`, { signal })
  return (data.message?.items ?? [])
    .filter((it) => yearFrom === undefined || (year(it.issued?.['date-parts']?.[0]?.[0]) ?? 0) >= yearFrom)
    .map(mapCrossrefItem)
}

// ───────────────────────── arXiv ─────────────────────────
function xmlTag(block, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block)
  return m ? m[1].replace(/\s+/g, ' ').trim() : ''
}

/** 取 arXiv Atom 里的 PDF 链接（属性顺序不固定，故按整标签匹配）。 */
function arxivPdfLink(block) {
  for (const m of block.matchAll(/<link\b[^>]*>/g)) {
    if (!/title="pdf"/.test(m[0])) continue
    const href = /href="([^"]+)"/.exec(m[0])
    if (href) return href[1]
  }
  return undefined
}

export async function searchArxiv({ query, limit = 8, yearFrom, sort = 'relevance', signal } = {}) {
  const sortBy = sort === 'recent' ? 'submittedDate' : 'relevance'
  const params = new URLSearchParams({
    search_query: `all:${query}`,
    start: '0',
    max_results: String(Math.min(limit, 50)),
    sortBy,
    sortOrder: 'descending',
  })
  const xml = await getText(`https://export.arxiv.org/api/query?${params}`, { signal, timeoutMs: 60000 })
    .catch(() => getText(`https://export.arxiv.org/api/query?${params}`, { signal, timeoutMs: 60000 }))
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1])
  return entries
    .map((e) => {
      const idUrl = xmlTag(e, 'id')
      const published = xmlTag(e, 'published')
      const authors = [...e.matchAll(/<author>[\s\S]*?<name>([^<]+)<\/name>/g)].map((m) => m[1].trim())
      const pdfLink = arxivPdfLink(e)
      return {
        source: 'arxiv',
        id: idUrl,
        doi: xmlTag(e, 'doi') || undefined,
        title: xmlTag(e, 'title') || '(无标题)',
        year: year(published.slice(0, 4)),
        authors,
        venue: 'arXiv preprint',
        citations: undefined,
        url: idUrl,
        pdfUrl: pdfLink,
        abstract: xmlTag(e, 'summary'),
      }
    })
    .filter((r) => yearFrom === undefined || (r.year ?? 0) >= yearFrom)
}

// ───────────────────────── Semantic Scholar ─────────────────────────
export async function searchSemanticScholar({ query, limit = 8, yearFrom, sort = 'relevance', apiKey, signal } = {}) {
  const params = new URLSearchParams({
    query,
    limit: String(Math.min(limit, 25)),
    fields: 'title,abstract,year,venue,authors,citationCount,externalIds,openAccessPdf,url',
  })
  if (yearFrom) params.set('year', `${yearFrom}-`)
  const headers = apiKey ? { 'x-api-key': apiKey } : undefined
  const data = await getJson(`https://api.semanticscholar.org/graph/v1/paper/search?${params}`, { signal, headers })
  return (data.data ?? []).map((p) => ({
    source: 'semanticscholar',
    id: p.paperId,
    doi: p.externalIds?.DOI,
    title: p.title ?? '(无标题)',
    year: year(p.year),
    authors: (p.authors ?? []).map((a) => a.name).filter(Boolean),
    venue: p.venue || undefined,
    citations: p.citationCount,
    url: p.url ?? (p.externalIds?.DOI ? `https://doi.org/${p.externalIds.DOI}` : undefined),
    pdfUrl: p.openAccessPdf?.url,
    abstract: p.abstract ?? '',
  }))
}

// ───────────────────────── PubMed ─────────────────────────
export async function searchPubMed({ query, limit = 8, yearFrom, signal } = {}) {
  const base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'
  const term = yearFrom ? `${query} AND ("${yearFrom}"[dp] : "3000"[dp])` : query
  const esearch = await getJson(`${base}/esearch.fcgi?db=pubmed&retmode=json&retmax=${Math.min(limit, 50)}&term=${encodeURIComponent(term)}`, { signal })
  const ids = esearch.esearchresult?.idlist ?? []
  if (ids.length === 0) return []
  const summary = await getJson(`${base}/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(',')}`, { signal })
  return ids
    .map((id) => summary.result?.[id])
    .filter(Boolean)
    .map((r) => ({
      source: 'pubmed',
      id: r.uid,
      doi: (r.articleids ?? []).find((a) => a.idtype === 'doi')?.value,
      title: stripMarkup(r.title) || '(无标题)',
      year: year((r.pubdate ?? '').slice(0, 4)),
      authors: (r.authors ?? []).map((a) => a.name).filter(Boolean),
      venue: r.fulljournalname || r.source || undefined,
      citations: undefined,
      url: `https://pubmed.ncbi.nlm.nih.gov/${r.uid}/`,
      pdfUrl: undefined,
      abstract: '', // esummary 不含摘要；需要全文摘要请用 paper_get
    }))
}

/** 数据源注册表：名称 → 实现。 */
export const SOURCES = {
  openalex: searchOpenAlex,
  crossref: searchCrossref,
  arxiv: searchArxiv,
  semanticscholar: searchSemanticScholar,
  pubmed: searchPubMed,
}

/**
 * 并行检索多个源；单个源失败不影响其它源（错误回传在 errors 里）。
 * @returns {{ results: object[], errors: {source: string, message: string}[] }}
 */
export async function multiSearch({ query, sources = ['openalex', 'arxiv'], limit = 8, yearFrom, sort = 'relevance', mailto, semanticScholarApiKey, signal } = {}) {
  // 过采样：一律先按【相关性】取足量候选，再在本地按被引/年份排序。
  //
  // 为什么不能直接把 sort=cited_by_count:desc 交给 API（实测踩中）：
  // 那样会返回"全库被引最高且碰巧含关键词"的论文 —— 搜 LLM agent 工具使用，
  // 第一条回来的是 1990 年的 BLAST（被引 10.9 万），主题完全不相关。
  // 先相关性筛选、再排序，才能得到"相关文献里最有影响力的"。
  const perSource = Math.min(50, Math.max(6, Math.ceil(limit / Math.max(1, sources.length)) * 4))
  const settled = await Promise.all(sources.map(async (name) => {
    const fn = SOURCES[name]
    if (fn === undefined) return { name, error: `未知数据源 "${name}"（可用：${Object.keys(SOURCES).join(', ')}）` }
    try {
      const results = await fn({ query, limit: perSource, yearFrom, sort: 'relevance', mailto, apiKey: semanticScholarApiKey, signal })
      return { name, results }
    } catch (error) {
      return { name, error: error instanceof Error ? error.message : String(error) }
    }
  }))
  const errors = settled.filter((s) => s.error !== undefined).map((s) => ({ source: s.name, message: s.error }))
  const deduped = []
  const seen = new Set()
  for (const r of settled.flatMap((s) => s.results ?? [])) {
    const doiKey = typeof r.doi === 'string' && r.doi.length > 0 ? `doi:${r.doi.toLowerCase()}` : undefined
    const titleKey = `t:${String(r.title ?? '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')}`
    if ((doiKey !== undefined && seen.has(doiKey)) || seen.has(titleKey)) continue
    if (doiKey !== undefined) seen.add(doiKey)
    seen.add(titleKey)
    deduped.push(r)
  }
  if (sort === 'cited') deduped.sort((a, b) => (b.citations ?? -1) - (a.citations ?? -1))
  else if (sort === 'recent') deduped.sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
  return { results: deduped.slice(0, limit), errors }
}

/** 按 arXiv id 精确取单篇（用 id_list，而非 all: 全文检索——后者会返回 400）。 */
export async function getArxivById({ id, signal } = {}) {
  const arxivId = String(id).replace(/^.*abs\//, '').replace(/^arxiv:/i, '').trim()
  const xml = await getText(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`, { signal, timeoutMs: 30000 })
  const entry = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1])[0]
  if (entry === undefined) return null
  const idUrl = xmlTag(entry, 'id')
  const published = xmlTag(entry, 'published')
  return {
    source: 'arxiv',
    id: idUrl,
    doi: xmlTag(entry, 'doi') || undefined,
    title: xmlTag(entry, 'title') || '(无标题)',
    year: year(published.slice(0, 4)),
    authors: [...entry.matchAll(/<author>[\s\S]*?<name>([^<]+)<\/name>/g)].map((m) => m[1].trim()),
    venue: 'arXiv preprint',
    citations: undefined,
    url: idUrl,
    pdfUrl: arxivPdfLink(entry),
    abstract: xmlTag(entry, 'summary'),
  }
}

/**
 * 按 DOI 精确取单篇。
 * 关键：必须走「精确端点」而不是 query= 检索——后者是模糊匹配，
 * 实测把 10.1038/s41586-021-03819-2 匹配成了另一个不同 DOI。
 */
export async function getByDoi({ doi: rawDoi, mailto, signal } = {}) {
  const doi = String(rawDoi ?? '').replace(/^https?:\/\/doi\.org\//i, '').replace(/^doi:/i, '').trim()
  if (doi.length === 0) return null
  try {
    const data = await getJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, { signal })
    if (data?.message !== undefined) return mapCrossrefItem(data.message)
  } catch { /* 落到 OpenAlex */ }
  try {
    const suffix = mailto === undefined ? '' : `?mailto=${encodeURIComponent(mailto)}`
    const work = await getJson(`https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}${suffix}`, { signal })
    if (work?.id !== undefined) return mapOpenAlexWork(work)
  } catch { /* 未找到 */ }
  return null
}

/** 按 PMID 取单篇（esummary 元数据 + efetch 摘要文本）。 */
export async function getPubMedById({ pmid, signal } = {}) {
  const base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'
  const summary = await getJson(`${base}/esummary.fcgi?db=pubmed&retmode=json&id=${encodeURIComponent(pmid)}`, { signal })
  const r = summary.result?.[String(pmid)]
  if (r === undefined) return null
  let abstract = ''
  try {
    const text = await getText(`${base}/efetch.fcgi?db=pubmed&rettype=abstract&retmode=text&id=${encodeURIComponent(pmid)}`, { signal, timeoutMs: 30000 })
    const match = /AB\s+-\s+([\s\S]*?)(?:\n[A-Z]{2,4}\s+-|\nPMID\b)/.exec(text)
    abstract = (match ? match[1] : text).replace(/\s+/g, ' ').trim().slice(0, 4000)
  } catch { /* 摘要可选 */ }
  return {
    source: 'pubmed',
    id: r.uid,
    doi: (r.articleids ?? []).find((a) => a.idtype === 'doi')?.value,
    title: stripMarkup(r.title) || '(无标题)',
    year: year((r.pubdate ?? '').slice(0, 4)),
    authors: (r.authors ?? []).map((a) => a.name).filter(Boolean),
    venue: r.fulljournalname || r.source || undefined,
    citations: undefined,
    url: `https://pubmed.ncbi.nlm.nih.gov/${r.uid}/`,
    pdfUrl: undefined,
    abstract,
  }
}

/** 按标识符取单篇详情：arXiv id / DOI / PMID。 */
export async function fetchPaper({ id, mailto, signal } = {}) {
  const value = String(id ?? '').trim()
  if (/^\d{5,9}$/.test(value)) {
    const hit = await getPubMedById({ pmid: value, signal }).catch(() => null)
    if (hit !== null) return hit
  }
  if (/arxiv/i.test(value) || /^\d{4}\.\d{4,5}(v\d+)?$/.test(value)) {
    const hit = await getArxivById({ id: value, signal }).catch(() => null)
    if (hit !== null) return hit
  }
  return getByDoi({ doi: value, mailto, signal })
}

// ───────────────────────── Unpaywall：为任意 DOI 找合法开放获取全文 ─────────────────────────
/**
 * Unpaywall 是全球开放获取索引（与出版商合作），能给出「合法免费全文」的直链。
 * 有了它，看到付费墙论文也能先找免费版本，而不是直接放弃。
 */
export async function findOpenAccess({ doi: rawDoi, email, signal } = {}) {
  const doi = String(rawDoi ?? '').replace(/^https?:\/\/doi\.org\//i, '').replace(/^doi:/i, '').trim()
  if (doi.length === 0) return null
  const mail = typeof email === 'string' && email.length > 0 ? email : 'dsh-scholar@users.noreply.github.com'
  const data = await getJson(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(mail)}`, { signal })
  const location = data?.best_oa_location ?? (Array.isArray(data?.oa_locations) ? data.oa_locations[0] : undefined)
  if (location === undefined || location === null) return { isOpenAccess: data?.is_oa === true, pdfUrl: undefined }
  return {
    isOpenAccess: data?.is_oa === true,
    pdfUrl: location.url_for_pdf ?? undefined,
    landingUrl: location.url ?? undefined,
    hostType: location.host_type ?? undefined,
    version: location.version ?? undefined,
    license: location.license ?? undefined,
  }
}

// ───────────────────────── Semantic Scholar：引用网络 ─────────────────────────
/** 把各种标识符规范成 Semantic Scholar 认识的写法。 */
export function s2PaperId(value) {
  const v = String(value ?? '').trim()
  if (/^10\.\d{4,9}\//.test(v) || /^https?:\/\/doi\.org\/10\./i.test(v)) return `DOI:${v.replace(/^https?:\/\/doi\.org\//i, '')}`
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(v)) return `ARXIV:${v}`
  if (/^\d{5,9}$/.test(v)) return `PMID:${v}`
  return v
}

/**
 * 取引用网络：direction='cited_by' 谁引用了它；direction='cites' 它引用了谁。
 * 注意：Semantic Scholar 无 key 时限流很紧（实测 429），失败会抛错由上层提示。
 */
export async function getCitations({ id, direction = 'cited_by', limit = 15, apiKey, signal } = {}) {
  const endpoint = direction === 'cites' ? 'references' : 'citations'
  const params = new URLSearchParams({
    fields: 'title,year,venue,citationCount,externalIds,authors,abstract',
    limit: String(Math.min(Math.max(limit, 1), 100)),
  })
  const headers = typeof apiKey === 'string' && apiKey.length > 0 ? { 'x-api-key': apiKey } : undefined
  const data = await getJson(`https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(s2PaperId(id))}/${endpoint}?${params}`, { signal, headers })
  return (data.data ?? []).map((row) => {
    const p = row.citingPaper ?? row.citedPaper ?? {}
    const doi = p.externalIds?.DOI
    return {
      source: 'semanticscholar',
      id: p.paperId,
      doi,
      title: p.title ?? '(无标题)',
      year: year(p.year),
      authors: (p.authors ?? []).map((a) => a.name).filter(Boolean),
      venue: p.venue || undefined,
      citations: p.citationCount,
      url: doi ? `https://doi.org/${doi}` : (p.paperId ? `https://www.semanticscholar.org/paper/${p.paperId}` : undefined),
      pdfUrl: undefined,
      abstract: p.abstract ?? '',
    }
  })
}

// ───────────────────────── 图书检索（走 OpenAlex 的 book / book-chapter 类型） ─────────────────────────
/**
 * 检索图书与专著章节。
 *
 * 为什么不用 Open Library：实测本机不可达（curl 21s 超时、Node 20s 超时），
 * 而 OpenAlex 同样收录 book / book-chapter 且可达、免 key。
 */
export async function searchBooks({ query, limit = 8, mailto, signal } = {}) {
  const params = new URLSearchParams({
    search: query,
    filter: 'type:book|book-chapter',
    'per-page': String(Math.min(Math.max(limit, 1), 50)),
  })
  if (typeof mailto === 'string' && mailto.length > 0) params.set('mailto', mailto)
  const data = await getJson(`https://api.openalex.org/works?${params}`, { signal })
  return (data.results ?? []).map((w) => ({
    ...mapOpenAlexWork(w),
    source: w.type === 'book-chapter' ? 'openalex-book-chapter' : 'openalex-book',
    venue: w.primary_location?.source?.display_name ?? w.host_venue?.display_name ?? undefined,
  }))
}
