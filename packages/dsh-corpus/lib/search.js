/**
 * dsh-corpus · 检索层 —— bigram 倒排 + 原文复核 + 上下文摘录。
 *
 * 流程：折叠查询 → 切 bigram → 倒排求交得候选文档 → 回原文按折叠位置定位 →
 *       从**原文**截取上下文（保持原字形，繁体还是繁体）→ 按出现次数排序。
 */
import { readFileSync } from 'node:fs'
import { fold } from './store.js'

/** 只保留有意义的字符（去标点/空白），用于切 bigram。 */
function normalizeQuery(q) {
  return String(q ?? '')
    .replace(/[「」『』“”"'’‘《》〈〉【】()（）\[\]{}<>]/g, ' ')
    .replace(/[，。；：、！？,.;:!?~`@#$%^&*+=|\\/-]+/g, ' ')
    .trim()
}

/** 把一个查询串切成 bigram（长度 1 的字单独保留，用于单字查询的回退）。 */
function bigramsOf(s) {
  const out = []
  for (let i = 0; i < s.length - 1; i += 1) out.push(s.slice(i, i + 2))
  return out
}

/**
 * 检索。
 * @returns {{hits:Array, candidates:number, ms:number, terms:string[]}}
 */
export function search(index, query, { limit = 20, contextChars = 80, kinds = [], minChars = 0 } = {}) {
  // 默认排除「元数据类」文档（命中记录 jsonl、索引清单），它们动辄几百次命中会把正文挤掉
  const EXCLUDED_BY_DEFAULT = ['命中记录', '索引']
  const t0 = Date.now()
  const norm = normalizeQuery(query)
  if (norm.length === 0) return { hits: [], candidates: 0, ms: 0, terms: [] }

  // 空格分词：每个词都要命中（AND）
  const terms = norm.split(/\s+/).filter((x) => x.length > 0).map((t) => fold(t))
  if (terms.length === 0) return { hits: [], candidates: 0, ms: 0, terms: [] }

  // 逐项求候选集，再取交集
  let candidate = undefined
  for (const term of terms) {
    const bgs = [...new Set(bigramsOf(term))]
    let set
    if (bgs.length === 0) {
      // 单字：扫全表（罕见，可接受）
      set = new Set(index.docs.filter((d) => d.chars >= minChars).map((d) => d.id))
    } else {
      // 取最短的 postings 先过滤
      const lists = bgs.map((b) => index.postings.get(b) ?? [])
      lists.sort((a, b) => a.length - b.length)
      if (lists[0].length === 0) return { hits: [], candidates: 0, ms: Date.now() - t0, terms }
      const counts = new Map()
      for (const id of lists[0]) counts.set(id, 1)
      for (let i = 1; i < lists.length; i += 1) {
        const l = lists[i]
        for (const id of l) if (counts.has(id)) counts.set(id, counts.get(id) + 1)
      }
      set = new Set([...counts.entries()].filter(([, c]) => c === lists.length).map(([id]) => id))
    }
    candidate = candidate === undefined ? set : new Set([...candidate].filter((id) => set.has(id)))
    if (candidate.size === 0) break
  }

  const ids = [...(candidate ?? new Set())]
  const hits = []
  for (const id of ids) {
    const doc = index.docs[id]
    if (doc === undefined) continue
    if (kinds.length > 0) { if (!kinds.includes(doc.kind)) continue }
    else if (EXCLUDED_BY_DEFAULT.includes(doc.kind)) continue
    let raw
    try { raw = readFileSync(doc.path, 'utf8') } catch { continue }
    const folded = fold(raw)
    // 跳过 YAML front-matter：否则上下文永远截在 title/url 那几行
    let bodyStart = 0
    if (folded.startsWith('---')) {
      const fmEnd = folded.indexOf('---', 3)
      if (fmEnd > 0 && fmEnd < 1500) bodyStart = fmEnd + 3
    }
    const foldedTerms = terms.map((t) => t)
    // 所有词都要出现在原文里（bigram 只是粗筛，这里做精确复核）
    let ok = true
    const positions = []
    for (const t of foldedTerms) {
      const p = folded.indexOf(t, bodyStart)
      if (p < 0) { ok = false; break }
      positions.push(p)
    }
    if (!ok) continue
    // 统计出现次数（第一个词）
    let count = 0
    let from = bodyStart
    const first = foldedTerms[0]
    while (true) {
      const p = folded.indexOf(first, from)
      if (p < 0) break
      count += 1
      from = p + first.length
      if (count > 999) break
    }
    const at = Math.min(...positions)
    const start = Math.max(bodyStart, at - contextChars)   // 上下文不要越界回到 front-matter
    const end = Math.min(raw.length, at + first.length + contextChars)
    const snippet = (start > 0 ? '…' : '') + raw.slice(start, end).replace(/\s+/g, ' ').trim() + (end < raw.length ? '…' : '')
    hits.push({ id, rel: doc.rel, name: doc.name, kind: doc.kind, chars: doc.chars, count, at, snippet })
  }

  hits.sort((a, b) => b.count - a.count || a.chars - b.chars)
  return { hits: hits.slice(0, limit), candidates: ids.length, total: hits.length, ms: Date.now() - t0, terms }
}

/** 读某个文件的片段（首 N 字，或指定位置附近）。 */
export function readDoc(index, { path, rel, name, at, chars = 1200 }) {
  const doc = path !== undefined
    ? index.docs.find((d) => d.path === path)
    : rel !== undefined
      ? index.docs.find((d) => d.rel === rel)
      : name !== undefined
        ? index.docs.find((d) => d.name === name || d.name.includes(name))
        : undefined
  if (doc === undefined) return undefined
  const raw = readFileSync(doc.path, 'utf8')
  const start = at !== undefined ? Math.max(0, at - 200) : 0
  return { doc, total: raw.length, start, text: raw.slice(start, start + chars) }
}
