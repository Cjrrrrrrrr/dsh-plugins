/**
 * 重点目录定向扫描 CLI —— 只盯浏览器下载 / QQ / 微信三个进料渠道。
 *
 * 用法：
 *   node tools/scan-focus.mjs --list                    列出重点目录与体量
 *   node tools/scan-focus.mjs --since 7d                扫最近 7 天新增（最快，日常用这个）
 *   node tools/scan-focus.mjs --since 30d --limit 50
 *   node tools/scan-focus.mjs --channel qq/browser      只扫某个渠道
 *   node tools/scan-focus.mjs --all                     扫全部（建立完整清单）
 *   node tools/scan-focus.mjs --since 7d --copy         扫描并复制到语料库（去重）
 */
import { availableDirs, scanFocusDirs, parseSince, humanSize, FOCUS_DIRS, DOC_EXT } from '../lib/focus.js'
import { readdirSync, statSync, existsSync, mkdirSync, copyFileSync, readFileSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CORPUS = 'E:\\deepseekharness\\mingli-corpus'
const MANIFEST = join(CORPUS, '07-群文件资料', '_归档清单.jsonl')

const argv = process.argv.slice(2)
const argOf = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d }
const has = (f) => argv.includes(`--${f}`)

/** 领域 → 语料库子目录 */
const TOPIC_DIR = {
  紫微斗数: '01-紫微斗数与八字/紫微斗数',
  八字: '01-紫微斗数与八字/八字',
  七政四余: '02-七政四余',
  奇门遁甲: '03-奇门遁甲',
  铁板神数: '04-铁板神数',
  邵子神数: '09-邵子神数',
  六爻占卜: '10-六爻占卜',
  三式六壬太乙: '11-三式六壬太乙',
  风水堪舆: '12-风水堪舆',
  择日黄历: '13-择日黄历',
  姓名学: '14-姓名学',
  相术: '15-相术',
  称骨算命: '08-称骨算命',
  其他命理: '06-其他命理',
  '(未分类)': '06-其他命理',
}

/** 目录体检：文档数 / 总量 / 7 天与 30 天内新增。 */
function survey(dirs) {
  const now = Date.now()
  return dirs.map((d) => {
    let n = 0; let sz = 0; let d7 = 0; let d30 = 0
    const walk = (dir, depth) => {
      if (depth > d.maxDepth) return
      let es
      try { es = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of es) {
        const full = join(dir, e.name)
        if (e.isDirectory()) { walk(full, depth + 1); continue }
        if (!DOC_EXT.has(e.name.slice(e.name.lastIndexOf('.')).toLowerCase())) continue
        try {
          const st = statSync(full)
          n += 1; sz += st.size
          const age = (now - st.mtimeMs) / 86400000
          if (age <= 7) d7 += 1
          if (age <= 30) d30 += 1
        } catch { /* 忽略 */ }
      }
    }
    walk(d.realPath, 0)
    return { ...d, n, sz, d7, d30 }
  })
}

if (has('list')) {
  const dirs = availableDirs()
  const rows = survey(dirs)
  console.log('【重点扫描目录】按进料优先级排序\n')
  console.log('  优先级  渠道          目录                                    文档     总量   7天  30天')
  for (const r of rows) {
    console.log(`  ${String(r.priority).padStart(6)}  ${r.channel.padEnd(12)}  ${r.realPath.padEnd(38)} ${String(r.n).padStart(5)} ${humanSize(r.sz).padStart(8)} ${String(r.d7).padStart(4)} ${String(r.d30).padStart(4)}`)
  }
  const miss = FOCUS_DIRS.filter((d) => !dirs.some((x) => x.key === d.key))
  if (miss.length > 0) {
    console.log('\n  不存在（跳过）：')
    for (const m of miss) console.log(`    - ${m.path}  (${m.label})`)
  }
  process.exit(0)
}

const sinceStr = argOf('since', has('all') ? 'all' : '7d')
const sinceMs = parseSince(sinceStr)
const channel = argOf('channel', '')
const limit = Number(argOf('limit', '0')) || 0
const only = channel.length > 0
  ? availableDirs().filter((d) => d.channel === channel || d.channel.split('/').includes(channel)).map((d) => d.key)
  : []

const res = scanFocusDirs({ only, sinceMs, includeAll: has('all'), limit })
console.log(`【定向扫描】最近 ${sinceStr === 'all' ? '全部' : sinceStr}${only.length > 0 ? ` ｜ 渠道 ${channel}` : ''}`)
console.log(`  扫了 ${res.dirsScanned} 个重点目录，遍历 ${res.scanned} 个文档，命中 ${res.items.length} 个`)
if (res.skippedOld > 0) console.log(`  跳过 ${res.skippedOld} 个旧文件（超出时间窗口）`)
console.log()
if (Object.keys(res.byChannel).length > 0) {
  console.log('  按渠道：' + Object.entries(res.byChannel).map(([k, v]) => `${k} ${v}`).join(' ｜ '))
  console.log('  按领域：' + Object.entries(res.byTopic).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' ｜ '))
  console.log()
}
for (const it of res.items.slice(0, Number(argOf('list-n', '60')))) {
  console.log(`  ${humanSize(it.size).padStart(10)}  [${it.topic}]  ${it.ageDays}天前  ${it.name.slice(0, 56)}`)
}
if (res.items.length > 60) console.log(`  … 还有 ${res.items.length - 60} 个`)

if (!has('copy')) {
  console.log('\n  （加 --copy 可复制到语料库并自动去重）')
  process.exit(0)
}

// ── 复制到语料库（内容级去重） ──
console.log('\n【归集到语料库】')
const knownSrc = new Set()
if (existsSync(MANIFEST)) {
  for (const line of readFileSync(MANIFEST, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue
    try { knownSrc.add(readFileSync(line, 'utf8') === '' ? '' : (JSON.parse(line).source ?? '')) } catch { /* 忽略 */ }
  }
}
let copied = 0
let dup = 0
let dupContent = 0
// 内容级去重：同 MD5 只收一份（文件名可能不同，如「手抄道藏紫微斗数」=「十八飞星…全集」）
const seenHash = new Map()
for (const it of res.items) {
  let h
  try { h = createHash('md5').update(readFileSync(it.path)).digest('hex') } catch { h = undefined }
  if (h !== undefined && seenHash.has(h)) {
    dupContent += 1
    console.log(`  ⧗ 内容重复，跳过 ${it.name.slice(0, 46)}（同 ${seenHash.get(h).slice(0, 34)}）`)
    continue
  }
  if (h !== undefined) seenHash.set(h, it.name)
  const topic = it.topic === '(未分类)' ? '其他命理' : it.topic
  const dir = join(CORPUS, ...(TOPIC_DIR[topic] ?? '06-其他命理').split('/'))
  const safe = it.name.replace(/[\\/:*?"<>|]/g, '_')
  const dst = join(dir, safe)
  if (existsSync(dst) && statSync(dst).size === it.size) { dup += 1; continue }
  mkdirSync(dir, { recursive: true })
  let final = dst
  if (existsSync(final)) {
    const dot = safe.lastIndexOf('.')
    final = join(dir, `${safe.slice(0, dot)}_from-${it.dirKey}${safe.slice(dot)}`)
  }
  copyFileSync(it.path, final)
  appendFileSync(MANIFEST, JSON.stringify({
    name: it.name, topic, size: it.size, source: it.path,
    target: final, mode: 'copy', via: `focus-scan/${it.dirKey}`, at: new Date().toISOString(),
  }) + '\n', 'utf8')
  copied += 1
  console.log(`  ✅ ${humanSize(it.size).padStart(10)} [${topic}] ${it.name.slice(0, 52)}`)
}
console.log(`\n  复制 ${copied} 个 ｜ 跳过已存在 ${dup} 个`)
