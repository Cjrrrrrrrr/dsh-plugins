/**
 * dsh-karing · 重点目录定向扫描 —— 只为三个进料渠道服务，不扫全盘。
 *
 * 实测依据（2026-10-25 本机）：
 *   渠道            目录                      文档数   总量    7天内  30天内
 *   浏览器下载      C:\Users\...\Downloads        0   0.00G     0      0
 *   桌面临时        C:\Users\...\Desktop          1   0.00G     0      1
 *   QQ+微信(主)     D:\weixinwenjian           1346   8.18G    27    212
 *   QQ+微信(备)     E:\Wendang                2153   6.08G     9     88
 *   百度网盘        D:\BaiduNetdiskDownload      23   0.06G     0      0
 *
 * 结论：资料几乎全部从 QQ / 微信进来，其次浏览器下载。所以：
 *   · 重点目录只盯这 5 个，默认按优先级排序
 *   · 支持 `--since 7d` 只扫最近变更，把一次扫描从 11 万文件降到几十个
 *   · 用「文件名关键词」先做粗筛，再决定要不要读内容
 */
import { readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

/** 文档类扩展名。 */
export const DOC_EXT = new Set(['.pdf', '.docx', '.doc', '.epub', '.zip', '.rar', '.7z', '.txt', '.chm', '.djvu', '.mobi', '.azw3', '.caj', '.xls', '.xlsx', '.ppt', '.pptx', '.html', '.htm'])

/** 命理关键词（按领域分组，便于后续分流归档）。 */
export const TOPIC_PATTERNS = [
  ['紫微斗数', /紫微|斗数|斗數|紫薇|十八飞星|飛星|策天|道藏紫微|河洛/],
  ['八字', /八字|四柱|子平|滴天髓|渊海|淵海|三命|盲派|用神|神煞|十神|穷通宝鉴|窮通寶鑑/],
  ['七政四余', /七政|四余|四餘|星宗|星命|果老|张果|張果|星学/],
  ['奇门遁甲', /奇门|奇門|遁甲|烟波|煙波|金函玉镜|金函玉鏡/],
  ['铁板神数', /铁板|鐵板|铁版|鐵版|神数|神數|铁算盘|鐵算盤|邵子神數/],
  ['邵子神数', /邵子|邵雍|河洛理数|皇极经世|皇極經世/],
  ['六爻占卜', /六爻|纳甲|納甲|卜筮|增删卜易|火珠林/],
  ['三式六壬太乙', /六壬|太乙|金口诀|金口訣|课经|課經/],
  ['风水堪舆', /风水|風水|玄空|八宅|堪舆|堪輿|阳宅|陰宅|阴宅/],
  ['择日黄历', /择日|擇日|黄历|黃曆|通书|通書|建除|协纪辨方/],
  ['姓名学', /姓名学|姓名學|五格|三才|取名|起名/],
  ['相术', /相术|相術|面相|手相|麻衣|神相|掌纹/],
  ['称骨算命', /称骨|稱骨|袁天罡|骨重/],
  ['其他命理', /术数|術數|玄学|玄學|易学|易學|占星|星盘|星盤|罗盘|羅盤|历法|曆法|占卜|卦/],
]

/** 不是资料的文件（安装包、注册机等），扫描时排除。 */
export const EXCLUDE_PATTERN = /安裝程式|安装程序|安装包|setup|installer|破解|注册机|注册码|crack|keygen|\.tmp$|\.crdownload$/i

/**
 * 重点目录（按进料量排序）。priority 越高越先扫。
 * 每项可配 maxDepth —— 微信/QQ 目录层级深，但要防爆炸。
 */
export const FOCUS_DIRS = [
  { key: 'qq-wechat-main', path: 'D:\\weixinwenjian', label: 'QQ+微信落地区（主）', channel: 'qq/wechat', priority: 1, maxDepth: 6 },
  { key: 'qq-wechat-alt', path: 'E:\\Wendang', label: 'QQ+微信落地区（备）', channel: 'qq/wechat', priority: 2, maxDepth: 6 },
  { key: 'qq-weixin-alt2', path: 'D:\\QQxinxi', label: 'QQ 数据目录（独立）', channel: 'qq', priority: 3, maxDepth: 5 },
  { key: 'wechat-e', path: 'E:\\Wendang\\WeChat Files', label: '微信文件（独立）', channel: 'wechat', priority: 4, maxDepth: 6 },
  { key: 'browser-downloads', path: 'C:\\Users\\%USER%\\Downloads', label: '浏览器下载（Edge/Firefox 默认）', channel: 'browser', priority: 5, maxDepth: 3 },
  { key: 'desktop', path: 'C:\\Users\\%USER%\\Desktop', label: '桌面（临时落点）', channel: 'browser', priority: 6, maxDepth: 2 },
  { key: 'baidu-netdisk', path: 'D:\\BaiduNetdiskDownload', label: '百度网盘下载', channel: 'netdisk', priority: 7, maxDepth: 3 },
  { key: 'baidu-pan-e', path: 'E:\\BaiduWangPan', label: '百度网盘（E 盘）', channel: 'netdisk', priority: 8, maxDepth: 3 },
]

/** 把 %USER% 展开成当前用户名。 */
export function expandPath(p, username) {
  const user = username ?? (process.env.USERNAME ?? '')
  return String(p).replace(/%USER%/g, user)
}

/** 列出实际存在、且可读的重点目录。 */
export function availableDirs(username) {
  return FOCUS_DIRS
    .map((d) => ({ ...d, realPath: expandPath(d.path, username), exists: existsSync(expandPath(d.path, username)) }))
    .filter((d) => d.exists)
    .sort((a, b) => a.priority - b.priority)
}

/** 解析 `--since`：7d / 24h / 30m / all。 */
export function parseSince(s) {
  if (s === undefined || s === '' || s === 'all') return 0
  const m = /^(\d+(?:\.\d+)?)\s*([dhm]?)$/i.exec(String(s).trim())
  if (m === null) return 0
  const n = Number(m[1])
  const u = (m[2] || 'd').toLowerCase()
  return n * (u === 'm' ? 60000 : u === 'h' ? 3600000 : 86400000)
}

/** 按文件名判定领域（返回最具体的一个）。 */
export function classifyTopic(name) {
  for (const [topic, rx] of TOPIC_PATTERNS) {
    if (rx.test(name)) return topic
  }
  return undefined
}

/**
 * 扫描重点目录。
 * @param {object} opts
 * @param {string[]} [opts.only]      只扫这些 key
 * @param {number}   [opts.sinceMs]   只收 mtime 在最近 N 毫秒内的文件
 * @param {boolean}  [opts.includeAll] 不过滤关键词，返回所有文档（用于建立索引）
 * @param {number}   [opts.limit]      最多返回多少条
 * @returns {{items:Array, scanned:number, skippedOld:number, byChannel:object, byTopic:object}}
 */
export function scanFocusDirs({ only = [], sinceMs = 0, includeAll = false, limit = 0, username } = {}) {
  const dirs = availableDirs(username).filter((d) => only.length === 0 || only.includes(d.key))
  const cutoff = sinceMs > 0 ? Date.now() - sinceMs : 0
  const items = []
  const byChannel = {}
  const byTopic = {}
  let scanned = 0
  let skippedOld = 0

  const walk = (dir, depth, maxDepth, root, meta) => {
    if (depth > maxDepth) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (limit > 0 && items.length >= limit) return
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '$RECYCLE.BIN') continue
      const full = join(dir, e.name)
      if (e.isDirectory()) { walk(full, depth + 1, maxDepth, root, meta); continue }
      const ext = e.name.slice(e.name.lastIndexOf('.')).toLowerCase()
      if (!DOC_EXT.has(ext)) continue
      scanned += 1
      let st
      try { st = statSync(full) } catch { continue }
      if (cutoff > 0 && st.mtimeMs < cutoff) { skippedOld += 1; continue }
      if (EXCLUDE_PATTERN.test(e.name)) continue
      const topic = classifyTopic(e.name)
      if (topic === undefined && !includeAll) continue
      items.push({
        path: full,
        name: e.name,
        size: st.size,
        mtime: new Date(st.mtimeMs).toISOString(),
        ageDays: Math.round((Date.now() - st.mtimeMs) / 86400000),
        topic: topic ?? '(未分类)',
        channel: meta.channel,
        dirKey: meta.key,
        dirLabel: meta.label,
        rel: relative(root, full),
      })
      byChannel[meta.channel] = (byChannel[meta.channel] ?? 0) + 1
      const t = topic ?? '(未分类)'
      byTopic[t] = (byTopic[t] ?? 0) + 1
    }
  }

  for (const d of dirs) walk(d.realPath, 0, d.maxDepth, d.realPath, d)
  items.sort((a, b) => b.size - a.size)
  return { items, scanned, skippedOld, byChannel, byTopic, dirsScanned: dirs.length }
}

/** 人可读大小。 */
export function humanSize(n) {
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}
