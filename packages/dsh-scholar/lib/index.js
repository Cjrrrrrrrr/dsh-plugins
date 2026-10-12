/**
 * @local/dsh-scholar —— 学术检索工具插件（宿主侧）。
 *
 * 注册四个模型可用工具：
 *   · paper_search    —— 跨 OpenAlex / arXiv / Crossref / Semantic Scholar / PubMed 检索论文
 *   · paper_get       —— 按 DOI / arXiv id / PMID 取单篇详情（元数据 + 摘要 + 开放获取 PDF）
 *   · paper_citations —— 引用网络（cited_by 谁引用了它 / cites 它引用了谁）
 *   · book_search     —— 图书与专著章节检索（OpenAlex book / book-chapter）
 *
 * 设计要点：
 *   · 全部走公开免费接口，无需 API key（Semantic Scholar 无 key 时限流紧，可在配置里补 key）；
 *   · 数据层在 ./sources.js，纯函数，可脱离宿主单独测试；
 *   · 网络层强制 IPv4（Windows + IPv6 下 Node fetch 连 arXiv 会超时，实测确认）；
 *   · 单个数据源失败不影响其它源，失败信息回传给模型，便于它换源重试。
 */
import { multiSearch, fetchPaper, findOpenAccess, getCitations, searchBooks, SOURCES } from './sources.js'

/**
 * 运行时包动态导入（带退化）：
 *   · 在 DSH 里必然解析成功 —— 用官方 defineTool 与 schemastery 校验；
 *   · 脱离 App 单测时退化为恒等实现（Config 置空，DSH 会跳过校验），
 *     于是同一份代码路径可以直接被测试脚本调用。
 */
const { defineTool } = await import('@deepseek-ai/dsh-tools')
  .catch(() => ({ defineTool: (definition) => definition }))
const schemastery = await import('@deepseek-ai/schemastery').catch(() => ({ default: undefined }))
const z = schemastery.default

/** Cordis 插件名。 */
export const name = 'dsh-scholar'

/** 需要 tools 服务来注册工具。 */
export const inject = ['tools']

/** 插件配置（DSH 会按此校验 profile 里该行的 config；非 DSH 环境为 undefined）。 */
export const Config = z === undefined
  ? undefined
  : z.object({
      mailto: z.string().default('dsh-scholar@users.noreply.github.com'),
      semanticScholarApiKey: z.string().default(''),
      maxAbstractChars: z.number().default(500),
    })

const SOURCE_NAMES = Object.keys(SOURCES)

/** 把一条记录渲染成紧凑的多行文本。 */
function renderRecord(record, index, maxAbstractChars) {
  const authors = record.authors ?? []
  const authorText = authors.length > 3 ? `${authors.slice(0, 3).join(', ')} 等 ${authors.length} 人` : authors.join(', ')
  const lines = [
    `${index === undefined ? '' : `${index}. `}[${record.source}] ${record.title}`,
    `   ${record.year ?? '?'} · ${record.venue ?? '(无期刊信息)'} · 被引 ${record.citations ?? '?'} · ${authorText || '(无作者)'}`,
    `   DOI: ${record.doi ?? '—'}`,
    `   链接: ${record.url ?? '—'}`,
  ]
  if (record.pdfUrl) lines.push(`   开放获取 PDF: ${record.pdfUrl}`)
  const abstract = String(record.abstract ?? '').trim()
  if (abstract.length > 0) {
    lines.push(`   摘要: ${abstract.length > maxAbstractChars ? `${abstract.slice(0, maxAbstractChars)}…` : abstract}`)
  }
  return lines.join('\n')
}

/** 注册工具。 */
export function apply(ctx, rawConfig) {
  const config = rawConfig ?? {}
  const mailto = typeof config.mailto === 'string' && config.mailto.length > 0 ? config.mailto : undefined
  const semanticScholarApiKey = typeof config.semanticScholarApiKey === 'string' && config.semanticScholarApiKey.length > 0
    ? config.semanticScholarApiKey
    : undefined
  const maxAbstractChars = Number.isSafeInteger(config.maxAbstractChars) && config.maxAbstractChars > 0 ? config.maxAbstractChars : 500

  ctx.tools.register(defineTool({
    name: 'paper_search',
    description: [
      '检索学术论文，覆盖国内外主流文献库：OpenAlex（2.5 亿+ 全学科）、arXiv（数理/CS 最新预印本）、',
      'Crossref（DOI 权威元数据）、Semantic Scholar（语义+引用）、PubMed（生物医学）。',
      '返回标题、作者、年份、期刊、被引次数、DOI、开放获取 PDF 与摘要。',
      '英文检索词命中率最高；中文文献建议用英文关键词或主题词。',
      `可用数据源：${SOURCE_NAMES.join(' / ')}。`,
    ].join(''),
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: '检索词/主题（英文效果最好，可用 AND/OR 组合概念）。',
      },
      sources: {
        type: 'array',
        items: { type: 'string' },
        description: `要检索的数据源，默认 openalex + arxiv。可选：${SOURCE_NAMES.join(', ')}。`,
      },
      limit: {
        type: 'integer',
        description: '返回条数（1-25，默认 8）。',
      },
      yearFrom: {
        type: 'integer',
        description: '只要该年份及之后的文献，例如 2023。',
      },
      sort: {
        type: 'string',
        description: '排序：relevance（默认，主题相关性）/ cited（先按相关性筛候选再按被引降序——找该主题最有影响力的）/ recent（先筛相关性再按年份降序——找该主题最新进展）。',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const query = String(args?.query ?? '').trim()
      if (query.length === 0) return 'paper_search: `query` 不能为空。'
      const requested = Array.isArray(args?.sources) && args.sources.length > 0
        ? args.sources.map((s) => String(s).toLowerCase()).filter((s) => SOURCE_NAMES.includes(s))
        : ['openalex', 'arxiv']
      const sources = requested.length > 0 ? requested : ['openalex', 'arxiv']
      const limit = Number.isSafeInteger(args?.limit) ? Math.min(Math.max(args.limit, 1), 25) : 8
      const yearFrom = Number.isSafeInteger(args?.yearFrom) ? args.yearFrom : undefined
      const sort = ['relevance', 'cited', 'recent'].includes(args?.sort) ? args.sort : 'relevance'

      const { results, errors } = await multiSearch({
        query,
        sources,
        limit,
        yearFrom,
        sort,
        mailto,
        semanticScholarApiKey,
        signal: exec?.signal,
      })

      const header = `paper_search "${query}" ｜ 数据源 ${sources.join('+')}${yearFrom === undefined ? '' : ` ｜ ≥${yearFrom}`} ｜ 排序 ${sort} ｜ 命中 ${results.length} 条`
      const body = results.length === 0
        ? '（无结果：换英文关键词、去掉 yearFrom，或换数据源重试）'
        : results.map((r, i) => renderRecord(r, i + 1, maxAbstractChars)).join('\n\n')
      const errorText = errors.length === 0
        ? ''
        : `\n\n[部分数据源失败] ${errors.map((e) => `${e.source}: ${e.message.slice(0, 120)}`).join(' ｜ ')}`
      return `${header}\n\n${body}${errorText}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'paper_get',
    description: [
      '按标识符取单篇论文详情：DOI（如 10.1038/s41586-021-03819-2）、arXiv id（如 1706.03762，或用 abs 链接）、',
      '或 PubMed PMID（纯数字）。返回标题、作者、期刊、年份、被引、开放获取 PDF 与摘要。',
    ].join(''),
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'DOI / arXiv id / PubMed PMID / doi.org 或 arxiv.org 链接。',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const id = String(args?.id ?? '').trim()
      if (id.length === 0) return 'paper_get: `id` 不能为空。'
      try {
        const record = await fetchPaper({ id, mailto, signal: exec?.signal })
        if (record === null) return `paper_get: 未找到 "${id}"（可先用 paper_search 确认标识符）。`
        let text = renderRecord(record, undefined, maxAbstractChars)
        // 没拿到开放获取 PDF 时，用 Unpaywall 再找一次合法免费全文（对付付费墙）
        if (record.pdfUrl === undefined && typeof record.doi === 'string' && record.doi.length > 0) {
          const openAccess = await findOpenAccess({ doi: record.doi, email: mailto, signal: exec?.signal })
            .catch((error) => ({ error: error instanceof Error ? error.message : String(error) }))
          if (openAccess !== null && openAccess !== undefined) {
            if (openAccess.error !== undefined) {
              // Unpaywall 要求真实邮箱；占位邮箱会 422，必须把原因说出来而不是静默跳过
              const hint = openAccess.error.includes('422') ? '（Unpaywall 需要真实邮箱：请在插件配置 mailto 里填你自己的邮箱）' : ''
              text += `\n   Unpaywall 查询失败：${openAccess.error.slice(0, 140)}${hint}`
            } else if (openAccess.pdfUrl === undefined) {
              text += `\n   Unpaywall: 该 DOI 暂无合法开放获取版本（is_oa=${String(openAccess.isOpenAccess)}）`
            } else {
              text += `\n   Unpaywall 合法开放获取全文: ${openAccess.pdfUrl}${openAccess.version === undefined ? '' : `（${openAccess.version} 版本）`}`
            }
          }
        }
        return text
      } catch (error) {
        return `paper_get 失败（${id}）：${error instanceof Error ? error.message : String(error)}`
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'paper_citations',
    description: [
      '取一篇论文的引用网络（Semantic Scholar）：direction="cited_by" 看谁引用了它（追后续进展、找改进与综述）；',
      'direction="cites" 看它引用了谁（追根溯源、找奠基文献）。无 key 时该接口限流紧（可能 429），失败可稍后重试。',
    ].join(''),
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'DOI / arXiv id / PMID / Semantic Scholar paperId。',
      },
      direction: {
        type: 'string',
        description: 'cited_by（默认：谁引用了它）/ cites（它引用了谁）。',
      },
      limit: {
        type: 'integer',
        description: '返回条数（1-100，默认 15）。',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const id = String(args?.id ?? '').trim()
      if (id.length === 0) return 'paper_citations: `id` 不能为空。'
      const direction = args?.direction === 'cites' ? 'cites' : 'cited_by'
      const limit = Number.isSafeInteger(args?.limit) ? Math.min(Math.max(args.limit, 1), 100) : 15
      try {
        const rows = await getCitations({ id, direction, limit, apiKey: semanticScholarApiKey, signal: exec?.signal })
        if (rows.length === 0) return `paper_citations(${id}, ${direction}): 无记录。`
        const header = `paper_citations("${id}") ｜ ${direction === 'cites' ? '它引用了' : '引用它的'} ${rows.length} 篇`
        return `${header}\n\n${rows.map((r, i) => renderRecord(r, i + 1, maxAbstractChars)).join('\n\n')}`
      } catch (error) {
        return `paper_citations 失败（${id}）：${error instanceof Error ? error.message : String(error)}`
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'book_search',
    description: '检索图书（Open Library，2700 万+ 条目）：书名、作者、首版年、出版社、版本数、ISBN 与条目链接。用于补论文之外的资料与知识面。',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: '书名 / 作者 / 主题关键词。',
      },
      limit: {
        type: 'integer',
        description: '返回条数（1-25，默认 8）。',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const query = String(args?.query ?? '').trim()
      if (query.length === 0) return 'book_search: `query` 不能为空。'
      const limit = Number.isSafeInteger(args?.limit) ? Math.min(Math.max(args.limit, 1), 25) : 8
      try {
        const rows = await searchBooks({ query, limit, mailto, signal: exec?.signal })
        if (rows.length === 0) return `book_search "${query}": 无结果。`
        return `book_search "${query}" ｜ 命中 ${rows.length} 条\n\n${rows.map((r, i) => renderRecord(r, i + 1, maxAbstractChars)).join('\n\n')}`
      } catch (error) {
        return `book_search 失败（${query}）：${error instanceof Error ? error.message : String(error)}`
      }
    },
  }))
}
