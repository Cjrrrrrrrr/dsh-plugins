/**
 * @local/dsh-corpus —— 命理语料库全文检索。
 *
 * 三个工具：
 *   · corpus_search —— 全文检索（bigram 倒排 + 原文复核 + 上下文摘录，两字起就能命中，简繁互通）
 *   · corpus_index  —— 建/重建索引、看索引状态
 *   · corpus_read   —— 按文件名/相对路径读某篇的片段
 *
 * 为什么自己建索引：SQLite FTS5 的 trigram 分词对**两字词**不命中（实测「紫微」「用神」都返回 0），
 * 而中文命理检索大量是两字词。bigram 倒排实测：566 万字建索引 1.5s、索引 11MB、查询 0ms。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync } from 'node:fs'
import { buildIndex, saveIndex, loadIndex, fold } from './store.js'
import { search, readDoc } from './search.js'

const { defineTool } = await import('@deepseek-ai/dsh-tools').catch(() => ({ defineTool: (d) => d }))
const schemastery = await import('@deepseek-ai/schemastery').catch(() => ({ default: undefined }))
const z = schemastery.default

export const name = 'dsh-corpus'
export const inject = ['tools']

export const Config = z === undefined
  ? undefined
  : z.object({
      corpusRoot: z.string().default('E:\\deepseekharness\\mingli-corpus'),
      dataDir: z.string().default(''),
    })

const PLUGIN_ROOT = dirname(fileURLToPath(new URL('.', import.meta.url)))

function normalizeConfig(raw) {
  const c = raw ?? {}
  return {
    corpusRoot: typeof c.corpusRoot === 'string' && c.corpusRoot.length > 0 ? c.corpusRoot : 'E:\\deepseekharness\\mingli-corpus',
    dataDir: typeof c.dataDir === 'string' && c.dataDir.length > 0 ? c.dataDir : join(PLUGIN_ROOT, 'data'),
  }
}

/** 路径比较忽略分隔符差异 */
function samePath(a, b) {
  const norm = (x) => String(x ?? '').split(String.fromCharCode(92)).join('/').replace(/[\/]+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/** 索引常驻内存，避免每次工具调用都读 11MB JSON。 */
const cache = { index: undefined, root: undefined, loadedAt: 0 }

function getIndex(cfg, { force = false } = {}) {
  if (!force && cache.index !== undefined && samePath(cache.root, cfg.corpusRoot)) return cache.index
  const loaded = loadIndex(cfg.dataDir)
  if (loaded !== undefined && samePath(loaded.root, cfg.corpusRoot)) {
    cache.index = loaded; cache.root = cfg.corpusRoot; cache.loadedAt = Date.now()
    return loaded
  }
  return undefined
}

function humanChars(n) {
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万字`
  return `${n} 字`
}

export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig)

  ctx.tools.register(defineTool({
    name: 'corpus_index',
    description: [
      '管理命理语料库的全文索引。action=status 看索引状态（文档数、字数、bigram 数、体积、上次构建时间）；',
      'action=rebuild 重建索引（566 万字约 1.5 秒）。语料库文件有增减后需要重建。',
    ].join(''),
    parameters: { action: { type: 'string', description: 'status（默认）/ rebuild。' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    timeoutMs: 300000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const action = String(args?.action ?? 'status')
      if (action === 'rebuild') {
        if (!existsSync(cfg.corpusRoot)) return `corpus_index：语料库不存在 ${cfg.corpusRoot}`
        const built = buildIndex({ root: cfg.corpusRoot })
        const saved = saveIndex(cfg.dataDir, { ...built, root: cfg.corpusRoot })
        cache.index = undefined
        const idx = getIndex(cfg, { force: true })
        return [
          '✅ 索引已重建',
          `文档 ${built.docs.length} 篇 ｜ ${humanChars(built.chars)} ｜ bigram ${built.postings.size} 个`,
          `构建 ${built.ms}ms ｜ 索引文件 ${(saved.bytes / 1048576).toFixed(1)} MB`,
          `路径 ${saved.file}`,
        ].join('\n')
      }
      const loaded = loadIndex(cfg.dataDir)
      if (loaded === undefined) return `corpus_index：还没有索引。用 action=rebuild 建一个（语料库 ${cfg.corpusRoot}）。`
      const kinds = {}
      for (const d of loaded.docs) kinds[d.kind] = (kinds[d.kind] ?? 0) + 1
      return [
        '【语料库索引状态】',
        `语料库：${loaded.root}`,
        `文档 ${loaded.docs.length} 篇 ｜ ${humanChars(loaded.chars)} ｜ bigram ${(loaded.postings.size ?? Object.keys(loaded.postings).length)} 个`,
        `索引：${(loaded.bytes / 1048576).toFixed(1)} MB ｜ 构建于 ${loaded.builtAt}（${loaded.buildMs}ms）`,
        `按类型：${Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' ｜ ')}`,
        '',
        '用 corpus_search 检索；文件有增减后用 action=rebuild。',
      ].join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'corpus_search',
    description: [
      '在命理语料库（古籍原文 + 网页正文 + 案例 + 检索记录）里全文检索，返回命中片段、文件路径与出现次数。',
      '**两字就能搜**（紫微、用神、斗數都行），**简繁互通**（搜「紫微斗数」能命中「紫微斗數」）。',
      '多个词用空格分隔表示 AND（都要出现）。可用 kinds 限定板块：古籍 / 网页正文 / 案例 / 命中记录。',
    ].join(''),
    parameters: {
      query: { type: 'string', required: true, description: '检索词，支持空格分隔多词（AND）。' },
      limit: { type: 'integer', description: '返回条数（默认 20）。' },
      contextChars: { type: 'integer', description: '每段上下文前后各留多少字（默认 80）。' },
      kinds: { type: 'array', items: { type: 'string' }, description: '限定板块：古籍/网页正文/案例/命中记录。' },
      minChars: { type: 'integer', description: '只搜正文不少于 N 字的文件（可过滤掉索引页/目录页）。' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const query = String(args?.query ?? '').trim()
      if (query.length === 0) return 'corpus_search：query 不能为空。'
      const index = getIndex(cfg)
      if (index === undefined) return 'corpus_search：还没有索引。先跑 corpus_index action=rebuild。'
      const r = search(index, query, {
        limit: Number.isSafeInteger(args?.limit) ? Math.min(Math.max(args.limit, 1), 100) : 20,
        contextChars: Number.isSafeInteger(args?.contextChars) ? Math.min(Math.max(args.contextChars, 20), 500) : 80,
        kinds: Array.isArray(args?.kinds) ? args.kinds.map(String) : [],
        minChars: Number.isSafeInteger(args?.minChars) ? args.minChars : 0,
      })
      if (r.hits.length === 0) {
        return [
          `corpus_search "${query}" — 无命中`,
          `（候选 ${r.candidates} 篇，${r.ms}ms）`,
          '',
          '建议：换更短的词（两字即可）、去掉书名号、或先 corpus_index action=status 确认索引是否覆盖了你要的板块。',
        ].join('\n')
      }
      const lines = [
        `corpus_search "${query}" ｜ 命中 ${r.total} 篇（显示 ${r.hits.length}）｜ ${r.ms}ms`,
        `词：${r.terms.join(' + ')}`,
        '',
      ]
      r.hits.forEach((h, i) => {
        lines.push(`${i + 1}. [${h.kind}] ${h.name.slice(0, 60)}  —  ${h.count} 次`)
        lines.push(`   ${h.rel}`)
        lines.push(`   ${h.snippet}`)
        lines.push('')
      })
      return lines.join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'corpus_read',
    description: '按文件名（可只给片段）/相对路径读语料库某篇的内容片段，用于看完检索命中的上下文。',
    parameters: {
      name: { type: 'string', description: '文件名或其中的一段（模糊匹配）。' },
      rel: { type: 'string', description: '相对路径（精确）。' },
      at: { type: 'integer', description: '从第几个字符附近开始读（默认从头）。' },
      chars: { type: 'integer', description: '读多少字符（默认 1200，上限 20000）。' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const index = getIndex(cfg)
      if (index === undefined) return 'corpus_read：还没有索引。先跑 corpus_index action=rebuild。'
      const r = readDoc(index, {
        rel: typeof args?.rel === 'string' ? args.rel : undefined,
        name: typeof args?.name === 'string' ? args.name : undefined,
        at: Number.isSafeInteger(args?.at) ? args.at : undefined,
        chars: Number.isSafeInteger(args?.chars) ? Math.min(Math.max(args.chars, 200), 20000) : 1200,
      })
      if (r === undefined) return `corpus_read：没找到（name=${args?.name ?? ''} rel=${args?.rel ?? ''}）。先用 corpus_search 拿到准确路径。`
      return [
        `【${r.doc.rel}】${r.doc.chars} 字 ｜ 本次从第 ${r.start} 字符起读 ${r.text.length} 字`,
        '',
        r.text,
        r.start + r.text.length < r.total ? `\n…（还有 ${r.total - r.start - r.text.length} 字，用 at=${r.start + r.text.length} 继续）` : '',
      ].join('\n')
    },
  }))
}
