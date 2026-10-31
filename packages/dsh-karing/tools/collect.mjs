/**
 * 命理资料采集器 —— 经 Hiddify 代理多引擎检索 + 抓正文 + 按主题分文件夹归档。
 *
 * 用法：
 *   node tools/collect.mjs --list                      只列出主题与查询
 *   node tools/collect.mjs --topic 紫微斗数             采集一个主题
 *   node tools/collect.mjs --all --max-fetch 10        全部主题，每主题最多抓 10 篇正文
 *   node tools/collect.mjs --all --dry                 只检索不抓正文（快）
 *
 * 产物（默认根目录 E:\deepseekharness\mingli-corpus）：
 *   <根>/<主题文件夹>/_检索结果.jsonl     每个查询的原始命中（可溯源）
 *   <根>/<主题文件夹>/<序号>-<标题>.md     抓到的正文（带元信息头）
 *   <根>/00-索引/采集清单.md              汇总
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { multiEngineSearch, fetchPage, searchEngine, DEFAULT_ENGINES } from '../lib/search.js'
import { readRuntime, isAlive, clashApi } from '../lib/core.js'

const args = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : dflt
}
const ROOT = argOf('root', 'E:\\deepseekharness\\mingli-corpus')
const MAX_FETCH = Number(argOf('max-fetch', '10'))
const ONLY = argOf('topic', '')
const DRY = args.includes('--dry')
const ENGINE_LIST = (argOf('engines', DEFAULT_ENGINES.join(','))).split(',').map((x) => x.trim()).filter(Boolean)
const NO_ROTATE = args.includes('--no-rotate')
const SKIP_EXISTING = args.includes('--skip-existing')
// 两阶段采集：--phase foreign-forced（强制走全代理口） / --phase domestic（直连）
const PHASE = argOf('phase', '')
const FORCE_PROXY_URL = argOf('force-proxy', '')     // 例：http://127.0.0.1:3066（Karing 全代理入站）
const FORCE_PROXY = FORCE_PROXY_URL.length > 0
const ALL = args.includes('--all')

const RUNTIME = readRuntime(join(import.meta.dirname, '..', 'data', 'runtime.json'))
// Karing 的运行时状态里是 ports 对象（direct/proxy/rule），不是单个 port
const PORT = RUNTIME?.ports?.rule ?? RUNTIME?.ports?.proxy ?? 3067
const ALIVE = RUNTIME !== undefined && isAlive(RUNTIME.pid)
const PROXY = FORCE_PROXY ? FORCE_PROXY_URL : (ALIVE ? `http://127.0.0.1:${PORT}` : `http://127.0.0.1:3067`)

/** 节点轮换：DuckDuckGo 会按出口 IP 限流（实测连续检索后返回 HTTP 403），
 *  换一个节点即恢复（实测切到 美国-003 后 DDG 立刻 200 / 10 条）。 */
const nodeState = { list: [], index: 0, selector: 'select' }
async function loadNodes() {
  if (!ALIVE) return
  const r = await clashApi({ port: RUNTIME.controlPort, secret: RUNTIME.secret, path: '/proxies' })
  const sel = Object.entries(r.json?.proxies ?? {}).find(([, v]) => v.type === 'Selector') ?? Object.entries(r.json?.proxies ?? {}).find(([, v]) => v.type === 'URLTest')
  if (sel === undefined) return
  nodeState.selector = sel[0]
  nodeState.list = (sel[1].all ?? []).filter((n) => n !== 'auto')
}
async function rotateNode() {
  if (NO_ROTATE || nodeState.list.length === 0) return undefined
  nodeState.index = (nodeState.index + 1) % nodeState.list.length
  const node = nodeState.list[nodeState.index]
  const r = await clashApi({ port: RUNTIME.controlPort, secret: RUNTIME.secret, path: `/proxies/${encodeURIComponent(nodeState.selector)}`, method: 'PUT', body: { name: node } })
  await sleep(1200)
  console.log(`  ↻ 轮换出口节点 → ${node}（${r.ok ? 'ok' : `失败 ${r.status}`}）`)
  return r.ok ? node : undefined
}

/** 带自愈的检索：外网引擎被限流 / 返回无关内容时轮换出口节点重试。
 *  实测（2026-10-16）：同一查询在 德国-001 上 Bing 返回「海底捞」，切到 新加坡-001 后
 *  Bing/DDG 双双给出 10/10 相关命中 —— 所以「结果相关性」本身就是出口 IP 是否被污染的探针。 */
function relevantCount(results, keyRe) {
  return results.filter((r) => keyRe.test(`${r.title} ${r.snippet}`)).length
}

async function searchWithHeal(query, engines, keyRe, { maxAttempts = 5 } = {}) {
  let best = undefined
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = await multiEngineSearch(query, { engines, proxy: PROXY, forceProxy: FORCE_PROXY })
    const scored = res.perEngine.map((r) => ({ ...r, relevant: relevantCount(r.results, keyRe) }))
    const usable = scored.filter((r) => r.ok && r.relevant > 0)
    const total = scored.reduce((n, r) => n + r.relevant, 0)
    if (usable.length >= 1 && total >= 3) {
      // 只保留「相关命中」的引擎结果，垃圾引擎的整批结果丢弃
      const merged = []
      const seen = new Set()
      for (const r of scored) {
        if (!r.ok || r.relevant === 0) continue
        for (const item of r.results) {
          if (!keyRe.test(`${item.title} ${item.snippet}`)) continue
          const key = item.url.replace(/[#?].*$/, '').replace(/\/$/, '')
          if (seen.has(key)) continue
          seen.add(key)
          merged.push({ ...item, engine: r.engine })
        }
      }
      return { query, engines, perEngine: scored, merged, dedupedCount: merged.length, attempts: attempt }
    }
    if (best === undefined || total > best.total) best = { res, scored, total }
    const detail = scored.map((r) => `${r.label}:${r.status}/${r.results.length}条/相关${r.relevant}`).join(' ')
    console.log(`  ⚠️ 第 ${attempt} 次命中质量不足（${detail}）→ 轮换出口节点重试`)
    const node = await rotateNode()
    if (node === undefined) break
  }
  console.log('  ❌ 多次轮换仍无相关命中，本轮记 0 条')
  return { query, engines, perEngine: [], merged: [], dedupedCount: 0, attempts: maxAttempts }
}

/** 主题 → 文件夹 + 检索词。检索词分「古籍原典」「现代研究」「案例反馈」三类，故意错开以求覆盖面。 */
const TOPICS = {
  紫微斗数: {
    dir: '01-紫微斗数与八字/紫微斗数',
    queries: [
      '"紫微斗数全书" 原文',
      '紫微斗数 古本 明代 版本 考',
      '"紫微斗数" 十四主星 星曜 详解',
      '紫微斗数 排盘 格局 论命 方法',
      '紫微斗数 案例 反馈 验证',
      '紫微斗数 与 八字 合参 差异',
      // ── 2026-10-19 补 ──
      '紫微斗数 四化 飞星 详解',
      '紫微斗数 大限 流年 推算 方法',
      '紫微斗数 格局 详解 命例',
      // ── 2026-10-23 补：具体星曜与宫位（前几轮都是主题词，这轮换细节词）──
      '紫微斗数 紫微星 天府星 详解',
      '紫微斗数 十二宫 三方四正 详解',
      '紫微斗数 命宫 身宫 区别',
      '紫微斗数 化禄 化权 化科 化忌 详解',
      '紫微斗数 流年 大限 小限 推算',
      '紫微斗数 辅星 煞星 杂曜 详解',
    ],
  },
  八字: {
    dir: '01-紫微斗数与八字/八字',
    queries: [
      '"渊海子平" 原文 全文',
      '"滴天髓" 原文 注解',
      '"三命通会" 白话 解读',
      '八字 用神 取法 实例 分析',
      '子平 格局 实战 案例',
      '八字 命例 反馈 应验',
    ],
  },
  八紫合参: {
    dir: '01-紫微斗数与八字/八紫合参',
    queries: [
      '紫微斗数 八字 同参 合参 方法',
      '八紫 双盘 对照 实例',
      '紫微 八字 结论 冲突 取舍',
      // ── 2026-10-19 补：八紫合参最缺「实例」，现有多是方法论与工具站 ──
      '八字 紫微 双盘 合参 实例 解析',
      '紫微斗数 八字 交叉验证 命例',
      '星平合参 命例 实例 案例',
      '紫微斗数 八字 哪个更准 实例对比',
      '四柱 紫微 同断 案例 印证',
    ],
  },
  七政四余: {
    dir: '02-七政四余',
    queries: [
      '"七政四余" 果老星宗 原文',
      '七政四余 天星择日 方法',
      '"张果星宗" 星命 古籍',
      '七政四余 案例 断验',
      '七政四余 现代 研究者 传承',
      // ── 补采 ──
      '七政四余 星盘 排盘 教程 入门',
      '七政四余 二十八宿 十二宫 分野',
      '"郑氏星案" 星命 案例',
      '七政四余 立命 安身 度主',
      '星宗 四余 罗计炁孛 含义',
      // ── 2026-10-23 补 ──
      '七政四余 断命 实例 详解',
      '七政四余 行限 流年 推算',
      '七政四余 十二宫 命宫 安法',
      '果老星宗 白话 解读 章节',
      '七政四余 与 八字 配合 使用',
    ],
  },
  奇门遁甲: {
    dir: '03-奇门遁甲',
    queries: [
      '"奇门遁甲" 烟波钓叟歌 原文',
      '奇门遁甲 排盘 起局 方法 详解',
      '奇门遁甲 用神 断卦 实例',
      '奇门遁甲 古籍 版本 秘本',
      '奇门遁甲 案例 反馈 应验',
      // ── 补采 ──
      '奇门遁甲 阴遁 阳遁 排局 教程',
      '奇门遁甲 十干克应 格局 详解',
      '"御定奇门宝鉴" 原文 影印',
      '奇门遁甲 三奇 六仪 八门 九星',
      '奇门遁甲 与 六壬 太乙 三式 比较',
      // ── 2026-10-19 补 ──
      '奇门遁甲 起局 详解 时家 转盘',
      '奇门遁甲 现代 应用 案例 复盘',
      '御定奇门宝鉴 内容 提要',
    ],
  },
  铁板神数: {
    dir: '04-铁板神数',
    queries: [
      '"铁板神数" 皇极经世 考刻',
      '"邵子神数" 条文 原文',
      '铁板神数 计算 方法 流程 详解',
      '铁板神数 案例 应验 反馈',
      '铁板神数 传承 流派 争议',
      // ── 2026-10-16 补采：绕开被「钢板规格」污染的检索词 ──
      '"铁板神数" 条文 目录 一万二千',
      '"铁版神数" 考刻 定数 方法',
      '皇极经世 元会运世 起数 推命',
      '邵雍 皇极经世 数理 命理 关系',
      '铁板神数 真伪 考证 争议 学界',
      '"太极数" 铁算盘 命理 术数',
      // ── 2026-10-19 补：皇極經世已有 51 篇古籍，缺的是**铁板神数本体**的条文与考刻法 ──
      '铁板神数 条文 一万二千 条 解读',
      '铁板神数 考刻 方法 八刻 分金',
      '铁板神数 起数 太玄数 先天卦',
      '铁板神数 与 皇极经世 关系 原理',
      '铁板神数 实例 断语 条文 对应',
      // ── 2026-10-23 补 ──
      '铁板神数 条文 父母 兄弟 夫妻 断语',
      '铁板神数 先天数 后天数 推算',
      '铁板神数 六亲 考证 方法',
      '邵子神数 条文 一百 条 解',
      '铁板神术 命例 批断 记录',
    ],
  },
  紫占: {
    dir: '05-真实案例与反馈',
    queries: [
      '"紫占" 紫微 占卜 方法',
      '紫微斗数 占卜 问事 实例',
      '紫微 占卦 应期 案例',
      '星盘 占星 案例 记录 反馈',
      // ── 2026-10-19 补：「紫占」单字太窄，改用组合词（实测 DDG 命中率更高）──
      '紫微斗数 测事 问卦 实例 分享',
      '命理 占卜 应期 断验 案例 记录',
      '紫微斗数 预测 验证 复盘 命例',
      '占卜 问事 结果 反馈 应验 论坛',
    ],
  },
  称骨算命: {
    dir: '08-称骨算命',
    queries: [
      '袁天罡 称骨 算命 歌诀 原文',
      '称骨算命 男命 女命 骨重 对照表',
      '称骨歌 全文 解释',
      '称骨算命 准不准 争议 讨论',
      '袁天罡称骨 四两 五两 详解',
      '称骨算命 与 八字 区别',
    ],
  },
  邵子神数: {
    dir: '09-邵子神数',
    queries: [
      '邵子神数 条文 原文',
      '邵雍 邵子神数 起数 方法',
      '邵子神数 考刻 定数 原理',
      '河洛理数 邵雍 命理',
      '邵子神数 与 铁板神数 区别',
      '皇极经世 邵子 先天卦 起数',
    ],
  },
  六爻占卜: {
    dir: '10-六爻占卜',
    queries: [
      '六爻 纳甲 装卦 方法 详解',
      '增删卜易 原文 白话',
      '卜筮正宗 原文 注解',
      '六爻 铜钱起卦 摇卦 步骤',
      '六爻 用神 断卦 实例 技法',
      '六爻 六亲 六神 世应 详解',
      '火珠林 纳甲 体系 讲解',
    ],
  },
  三式六壬太乙: {
    dir: '11-三式六壬太乙',
    queries: [
      '大六壬 起课 方法 详解',
      '大六壬 课体 格局 断法',
      '太乙神数 排盘 方法',
      '金口诀 起课 实战',
      '六壬大全 卷 解读',
      '三式 奇门 六壬 太乙 比较',
      '六壬 案例 占断 实录',
    ],
  },
  风水堪舆: {
    dir: '12-风水堪舆',
    queries: [
      '八宅明镜 原文 白话',
      '玄空飞星 排盘 方法 详解',
      '三元 三合 风水 区别',
      '阳宅 风水 布局 实例',
      '阴宅 堪舆 寻龙点穴',
      '沈氏玄空学 内容',
      '风水 二十四山 罗盘 用法',
    ],
  },
  择日黄历: {
    dir: '13-择日黄历',
    queries: [
      '择日 择吉 方法 通书 原理',
      '建除十二神 黄道吉日 详解',
      '二十四节气 与 命理 关系',
      '协纪辨方书 择日 原文',
      '黄历 宜忌 推算 方法',
      '嫁娶 择日 择时 实例',
    ],
  },
  姓名学: {
    dir: '14-姓名学',
    queries: [
      '五格剖象法 姓名学 三才五格',
      '熊崎健翁 姓名学 原理',
      '八字 起名 用神 取名 方法',
      '姓名 笔画 五行 计算 方法',
      '姓名学 争议 科学性 讨论',
      // ── 补：前一轮命中多但归档少（工具站过多），换更「内容向」的词 ──
      '五格剖象法 原理 来历 熊崎',
      '姓名学 三才配置 五行 生克 详解',
      '取名 用神 补益 实例 分析',
      '姓名学 笔划 计算方法 康熙字典',
      '好名字 标准 音形义 命理 结合',
    ],
  },
  相术: {
    dir: '15-相术',
    queries: [
      '麻衣神相 原文 白话',
      '神相全编 相术 古籍',
      '面相 五官 十二宫 详解',
      '手相 掌纹 解读 方法',
      '相术 气色 形态 断法',
      '相术 与 命理 关系',
    ],
  },
  真实案例与反馈: {
    dir: '05-真实案例与反馈',
    queries: [
      '命理 预测 应验 案例 记录',
      '八字 紫微 预测 准确 反馈 讨论',
      '命理 从业者 案例 复盘',
      '算命 应验 案例 知乎',
      '奇门 六爻 预测 案例 记录',
      // ── 2026-10-19 补：05 专题攻坚 —— 案例库/命例集/断案 ──
      '命理 案例库 命例集 合集',
      '八字 命例 详解 合集 解析',
      '紫微斗数 命例集 解析 精选',
      '命理 断案 实例 古籍 案例',
      '占卜 案例 复盘 记录 应验',
      '算命 真实案例 记录 分享 论坛',
    ],
  },
}

/** 每个主题的「相关性关键词」——命中数用来判断出口 IP 是否被搜索引擎污染。 */
const KEY = {
  紫微斗数: /紫微斗数|紫微星|斗数|ziwei/i,
  八字: /八字|四柱|子平|命理|用神|滴天髓|渊海子平|三命通会|十神/,
  八紫合参: /紫微斗数|八字|斗数|合参|双盘/,
  七政四余: /七政四余|七政|四余|果老星宗|星宗|星命|张果/,
  奇门遁甲: /奇门遁甲|奇门|遁甲|烟波钓叟/,
  // 注意：「铁板」单独出现会命中钢板规格表（实测被污染过），必须要求完整术语
  铁板神数: /铁板神数|铁版神数|铁板神算|铁版神算|邵子神数|皇极经世|铁板算命|太极数/,
  紫占: /紫占|紫微|占卜|占星|星盘|星盤|卦/,
  称骨算命: /称骨|袁天罡|骨重|几两/,
  邵子神数: /邵子|邵雍|神数|河洛理数|皇极经世/,
  六爻占卜: /六爻|纳甲|起卦|摇卦|卜筮|增删卜易|火珠林|世应/,
  三式六壬太乙: /六壬|太乙|金口诀|三式|课体/,
  风水堪舆: /风水|堪舆|玄空|八宅|阳宅|阴宅|罗盘|飞星/,
  择日黄历: /择日|择吉|黄历|通书|建除|吉日|宜忌|协纪辨方/,
  姓名学: /姓名|五格|三才|取名|起名|笔画|剖象/,
  相术: /相术|面相|手相|麻衣|神相|五官|掌纹/,
  真实案例与反馈: /命理|预测|案例|反馈|应验|八字|紫微|奇门|卦/,
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const safeName = (s) => String(s).replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 70) || 'untitled'

function loadSeen(jsonlPath) {
  const seen = new Set()
  if (!existsSync(jsonlPath)) return seen
  for (const line of readFileSync(jsonlPath, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue
    try {
      const rec = JSON.parse(line)
      if (typeof rec.url === 'string') seen.add(rec.url.replace(/[#?].*$/, '').replace(/\/$/, ''))
    } catch { /* 忽略坏行 */ }
  }
  return seen
}

async function collectTopic(name, spec, { maxFetch, dry }) {
  const dir = join(ROOT, spec.dir)
  mkdirSync(dir, { recursive: true })
  const jsonlPath = join(dir, '_检索结果.jsonl')
  const seen = loadSeen(jsonlPath)
  const fresh = []
  console.log(`\n===== ${name} → ${spec.dir} =====`)

  // 「已采」按 (检索词 × 阶段) 去重：同一检索词在 domestic 阶段跑过，
  // 不代表 foreign-forced 阶段也跑过 —— 两个阶段要各自留一份命中。
  const MY_PHASE = PHASE || (FORCE_PROXY ? 'foreign-forced' : 'domestic')
  const doneQueries = new Set()
  if (SKIP_EXISTING && existsSync(jsonlPath)) {
    for (const line of readFileSync(jsonlPath, 'utf8').split(String.fromCharCode(10))) {
      if (line.trim().length === 0) continue
      try {
        const rec = JSON.parse(line)
        doneQueries.add(`${rec.query}|${rec.phase ?? 'legacy'}`)
      } catch { /* 忽略 */ }
    }
  }
  for (const query of spec.queries) {
    if (doneQueries.has(`${query}|${MY_PHASE}`)) { console.log(`  [跳过·本阶段已采] ${query}`); continue }
    const res = await searchWithHeal(query, ENGINE_LIST, KEY[name])
    const stat = res.perEngine.map((r) => `${r.label}:${r.ok ? `${r.results.length}(${r.relevant}相关)` : '✗'}`).join(' ')
    console.log(`  [${query}] 去重 ${res.dedupedCount} ｜ ${stat}`)
    for (const r of res.merged) {
      const key = r.url.replace(/[#?].*$/, '').replace(/\/$/, '')
      if (seen.has(key)) continue
      seen.add(key)
      const rec = { topic: name, query, engine: r.engine, title: r.title, url: r.url, snippet: r.snippet, phase: PHASE || (FORCE_PROXY ? 'foreign-forced' : 'domestic'), via: r.via, at: new Date().toISOString() }
      appendFileSync(jsonlPath, `${JSON.stringify(rec)}\n`, 'utf8')
      fresh.push(rec)
    }
    await sleep(1500)
  }

  console.log(`  新增命中 ${fresh.length} 条（累计 ${seen.size}）`)
  if (dry) return { name, dir, newHits: fresh.length, saved: 0 }

  // 抓正文：优先抓内容型域名，跳过纯工具/商城/聚合站
  const bad = /(1688|taobao|tmall|jd\.com|amazon|zhihu\.com\/search|baidu\.com\/s\?|bing\.com|google\.com|so\.com|sogou\.com|apps\.apple|play\.google)/i
  const good = /(zhihu|baike|wikipedia|github|book|gushi|guoxue|zhonghua|wenku|doc|blog|csdn|sohu|163\.com|qq\.com|sina|artron|cnki|xiaohongshu|bilibili|tieba|douban)/i
  const rank = (r) => (good.test(r.url) ? 0 : 1) + (bad.test(r.url) ? 10 : 0)
  const candidates = fresh.filter((r) => !bad.test(r.url)).sort((a, b) => rank(a) - rank(b))

  let saved = 0
  let idx = 0
  for (const rec of candidates) {
    if (saved >= maxFetch) break
    idx += 1
    try {
      const page = await fetchPage(rec.url, { proxy: PROXY, timeoutMs: 25000, maxChars: 200000 })
      if (page.status !== 200 || page.text.length < 400) {
        console.log(`  ⚠️ 跳过（HTTP ${page.status} / 正文 ${page.text.length} 字）${rec.url.slice(0, 70)}`)
        continue
      }
      const file = join(dir, `${String(idx).padStart(2, '0')}-${safeName(rec.title)}.md`)
      mkdirSync(dir, { recursive: true })
      const body = [
        `---`,
        `title: ${JSON.stringify(rec.title)}`,
        `url: ${rec.url}`,
        `source_engine: ${rec.engine}`,
        `query: ${JSON.stringify(rec.query)}`,
        `fetched_at: ${new Date().toISOString()}`,
        `topic: ${name}`,
        `chars: ${page.text.length}`,
        `---`,
        ``,
        `# ${rec.title}`,
        ``,
        `> 来源：${rec.url}（${rec.engine} 检索命中）`,
        `> 摘要：${rec.snippet.slice(0, 300)}`,
        ``,
        page.text,
        ``,
      ].join('\n')
      writeFileSync(file, body, 'utf8')
      saved += 1
      console.log(`  ✅ ${file.split('\\').pop()} (${page.text.length} 字)`)
    } catch (error) {
      console.log(`  ❌ 抓取失败 ${rec.url.slice(0, 70)} — ${String(error?.message ?? error).slice(0, 80)}`)
    }
    await sleep(600)
  }
  return { name, dir, newHits: fresh.length, saved }
}

// ── 主流程 ────────────────────────────────────────────────
if (args.includes('--list')) {
  for (const [k, v] of Object.entries(TOPICS)) console.log(`${k}  →  ${v.dir}  (${v.queries.length} 组检索词)`)
  process.exit(0)
}
if (!ALL && ONLY.length === 0) { console.log('用法：--all 或 --topic <主题名>；--list 看主题'); process.exit(1) }

console.log(`代理：${PROXY}`)
console.log(`根目录：${ROOT} ｜ 每主题最多抓 ${MAX_FETCH} 篇${DRY ? ' ｜ dry 模式' : ''}`)

const targets = ALL ? Object.entries(TOPICS) : Object.entries(TOPICS).filter(([k]) => k === ONLY)
if (targets.length === 0) { console.log(`没有主题 "${ONLY}"；用 --list 看可用主题`); process.exit(1) }

const summary = []
await loadNodes()
console.log(`出口节点候选：${nodeState.list.length} 个（403 时自动轮换）`)
for (const [name, spec] of targets) {
  summary.push(await collectTopic(name, spec, { maxFetch: MAX_FETCH, dry: DRY }))
}

console.log('\n===== 汇总 =====')
for (const s of summary) console.log(`${s.name.padEnd(10)} 新增命中 ${String(s.newHits).padStart(4)} ｜ 归档正文 ${s.saved}`)
console.log(`\n根目录：${ROOT}`)
