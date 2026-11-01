/**
 * dsh-corpus · 索引层 —— 给命理语料库建 bigram 倒排索引。
 *
 * 为什么不用 SQLite FTS5：实测 `tokenize='trigram'` 对**两字词**（紫微/用神/斗數）返回 0 条，
 * 而中文命理检索大量是两字词。所以自己建 bigram 倒排：两字起就能命中，查询 0ms。
 *
 * 为什么不用外部依赖：语料 566 万字，bigram 58 万个，建索引 1.5 秒、JSON 11MB —— 纯 Node 够用。
 *
 * 简繁处理：索引与查询都先折叠（S2T），所以「紫微斗数」能命中「紫微斗數」。
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs'
import { join, relative, basename } from 'node:path'

/** 简繁折叠表（与 dsh-karing 同源，覆盖命理古籍高频字）。 */
export const S2T = {
  数: '數', 门: '門', 铁: '鐵', 阴: '陰', 阳: '陽', 术: '術', 余: '餘', 书: '書', 经: '經',
  传: '傳', 学: '學', 历: '曆', 纪: '紀', 记: '記', 录: '錄', 谱: '譜', 验: '驗', 证: '證',
  统: '統', 关: '關', 图: '圖', 说: '說', 论: '論', 诀: '訣', 赋: '賦', 斗: '斗',
  微: '微', 紫: '紫', 奇: '奇', 遁: '遁', 甲: '甲', 政: '政', 四: '四', 八: '八', 字: '字',
  命: '命', 理: '理', 神: '神', 板: '板', 版: '版', 皇: '皇', 极: '極', 世: '世', 渊: '淵',
  海: '海', 子: '子', 平: '平', 滴: '滴', 天: '天', 髓: '髓', 通: '通', 会: '會', 三: '三',
  宗: '宗', 果: '果', 老: '老', 张: '張', 阁: '閣', 阵: '陣', 局: '局',
  盘: '盤', 宫: '宮', 曜: '曜', 宿: '宿', 运: '運', 元: '元', 节: '節', 气: '氣', 时: '時',
  间: '間', 定: '定', 例: '例', 法: '法', 起: '起', 用: '用', 断: '斷', 卦: '卦', 案: '案',
  实: '實', 战: '戰', 秘: '秘', 籍: '籍', 古: '古', 本: '本', 源: '源', 流: '流', 派: '派',
  择: '擇', 日: '日', 课: '課', 卜: '卜', 筮: '筮', 六: '六', 爻: '爻', 太: '太', 乙: '乙',
  符: '符', 应: '應', 变: '變', 化: '化', 格: '格', 煞: '煞', 空: '空', 亡: '亡',
  贵: '貴', 禄: '祿', 权: '權', 科: '科', 忌: '忌', 凶: '凶', 吉: '吉', 旺: '旺', 衰: '衰',
  庙: '廟', 陷: '陷', 田: '田', 宅: '宅', 财: '財', 帛: '帛', 官: '官', 夫: '夫',
  妻: '妻', 疾: '疾', 厄: '厄', 迁: '遷', 移: '移', 奴: '奴', 仆: '僕', 福: '福', 德: '德',
  星: '星', 布: '布', 阵: '陣', 诀: '訣', 论: '論', 诀: '訣', 图: '圖', 说: '說',
  凡: '凡', 例: '例', 卷: '卷', 篇: '篇', 章: '章', 节: '節', 条: '條', 文: '文',
  义: '義', 释: '釋', 注: '注', 解: '解', 疏: '疏', 评: '評', 批: '批', 断: '斷',
  真: '真', 诠: '詮', 宝: '寶', 鉴: '鑑', 镜: '鏡', 诀: '訣', 窍: '竅', 旨: '旨', 归: '歸',
  大: '大', 全: '全', 集: '集', 要: '要', 精: '精', 华: '華', 粹: '粹', 编: '編', 纂: '纂',
}

/** 折叠：统一折到繁体一侧（表里没有的字原样保留）。 */
export function fold(text) {
  let out = ''
  for (const ch of String(text ?? '')) out += S2T[ch] ?? ch
  return out
}

/** 文档类型判定（用于检索时按板块过滤）。 */
export function kindOf(relPath, name) {
  if (relPath.includes('00-索引')) return '索引'
  if (relPath.includes('_转换文本')) return 'PDF转换'
  if (name.startsWith('古籍-')) return '古籍'
  if (name.startsWith('知乎案例-')) return '案例'
  if (name.startsWith('_')) return '命中记录'
  if (/案例|命例|实例|复盘|断验|应验/.test(name)) return '案例'
  if (/^0\d-|^\d\d-/.test(name)) return '网页正文'
  return '其他'
}

/**
 * 扫描语料库，建索引。
 * @returns {{docs:Array, postings:Map, chars:number, ms:number}}
 */
export function buildIndex({ root, includeJsonl = true } = {}) {
  const t0 = Date.now()
  const docs = []
  const postings = new Map()

  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) { walk(full); continue }
      const isMd = e.name.endsWith('.md')
      const isJsonl = e.name.endsWith('.jsonl')
      if (!isMd && !(isJsonl && includeJsonl)) continue
      if (isMd && e.name === 'README.md') continue
      let text
      try { text = readFileSync(full, 'utf8') } catch { continue }
      // md 跳过 front-matter，只索引正文
      if (isMd) {
        const i = text.indexOf('\n# ')
        if (i > 0) text = text.slice(i)
        const j = text.indexOf('\n---\n')
        if (j > 0 && j < 50) text = text.slice(0, j)
      }
      const rel = relative(root, full)
      const id = docs.length
      docs.push({ id, path: full, rel, name: e.name, chars: text.length, kind: kindOf(rel, e.name), size: statSync(full).size })
      const folded = fold(text)
      const seen = new Set()
      for (let k = 0; k < folded.length - 1; k += 1) {
        const bg = folded.slice(k, k + 2)
        const c0 = bg.charCodeAt(0); const c1 = bg.charCodeAt(1)
        // 只索引含汉字的 bigram
        if (c0 < 0x3400 && c1 < 0x3400) continue
        if (seen.has(bg)) continue
        seen.add(bg)
        let arr = postings.get(bg)
        if (arr === undefined) { arr = []; postings.set(bg, arr) }
        arr.push(id)
      }
    }
  }
  walk(root)
  return { docs, postings, chars: docs.reduce((n, d) => n + d.chars, 0), ms: Date.now() - t0 }
}

/** 持久化：postings 用「bigram → [docId...]」，JSON 直存。 */
export function saveIndex(dir, { docs, postings, chars, ms, root }) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'index.json')
  const obj = { v: 1, builtAt: new Date().toISOString(), root, chars, buildMs: ms, docs, postings: Object.fromEntries(postings) }
  writeFileSync(file, JSON.stringify(obj), 'utf8')
  return { file, bytes: statSync(file).size }
}

export function loadIndex(dir) {
  const file = join(dir, 'index.json')
  if (!existsSync(file)) return undefined
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'))
    return { ...j, postings: new Map(Object.entries(j.postings)), file, bytes: statSync(file).size }
  } catch { return undefined }
}
