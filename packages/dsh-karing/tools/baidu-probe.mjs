/**
 * dsh-karing · 百度恢复探测器
 *
 * 背景（2026-10-23 实测）：百度对同一 IP「一次一放」——
 * 拿到真实会话后首次放行（18 条/17 相关），之后无论间隔 30s 还是 60s 都 socket hang up。
 * 结论：不能靠调间隔救，只能**停打等自然恢复**。
 *
 * 这个脚本做三件事：
 *   1. 按计划延时，每 N 小时探一次（默认 6h 起探，最多 24h）
 *   2. 每次探测只发**一个**请求（用真实会话），成功即停
 *   3. 结果写进 data/baidu-recovery.json，可随时查看
 *
 * 用法：
 *   node tools/baidu-probe.mjs --now            立刻探一次（不等待）
 *   node tools/baidu-probe.mjs --at 6h          6 小时后探
 *   node tools/baidu-probe.mjs --watch          后台常驻：6h → 12h → 18h → 24h 逐次探测
 *   node tools/baidu-probe.mjs --status         看上次探测结果
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { searchEngine, relevanceOf } from '../lib/search.js'
import { sessionInfo } from '../lib/session.js'
import { readRuntime, isAlive } from '../lib/core.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DATA = join(ROOT, 'data')
const STATE = join(DATA, 'baidu-recovery.json')
const PROBE_QUERY = '紫微斗数'

const argv = process.argv.slice(2)
const argOf = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d }

function parseDelay(s) {
  const m = /^(\d+(?:\.\d+)?)\s*([smh]?)$/i.exec(String(s).trim())
  if (m === null) return 6 * 3600000
  const n = Number(m[1])
  const unit = (m[2] || 'h').toLowerCase()
  return n * (unit === 's' ? 1000 : unit === 'm' ? 60000 : 3600000)
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE, 'utf8')) } catch { return { attempts: [] } }
}

function saveState(s) {
  mkdirSync(DATA, { recursive: true })
  writeFileSync(STATE, JSON.stringify(s, null, 2), 'utf8')
}

function proxyUrl() {
  const rt = readRuntime(join(DATA, 'runtime.json'))
  return rt !== undefined && isAlive(rt.pid) ? `http://127.0.0.1:${rt.ports?.rule ?? 3167}` : 'http://127.0.0.1:3167'
}

async function probeOnce(reason = 'manual') {
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  let result
  try {
    const r = await searchEngine('baidu', PROBE_QUERY, { proxy: proxyUrl(), timeoutMs: 25000 })
    result = {
      ok: r.ok,
      status: r.status,
      via: r.via,
      count: r.results?.length ?? 0,
      relevant: r.ok ? relevanceOf(r.results, PROBE_QUERY) : 0,
      ms: r.ms,
      error: r.error ?? null,
    }
  } catch (error) {
    result = { ok: false, status: 0, count: 0, relevant: 0, ms: Date.now() - t0, error: String(error?.message ?? error).slice(0, 160) }
  }
  const state = loadState()
  state.attempts = (state.attempts ?? []).slice(-19)
  state.attempts.push({ at: startedAt, reason, query: PROBE_QUERY, ...result, session: sessionInfo('baidu') })
  state.last = { at: startedAt, ...result }
  if (result.ok) {
    state.recoveredAt = startedAt
    state.conclusion = `✅ 百度已恢复（${result.count} 条 / ${result.relevant} 相关 / ${result.ms}ms）。注意配额仍是 1 次/小时，别连着打。`
  } else {
    state.conclusion = `❌ 仍不可用：${result.error ?? '未知'}`
  }
  saveState(state)
  return result
}

function fmt(r) {
  return r.ok
    ? `✅ ${r.count} 条 / ${r.relevant} 相关 / ${r.ms}ms`
    : `❌ ${String(r.error ?? 'unknown').slice(0, 70)}`
}

const cmd = argv[0] ?? '--status'

if (cmd === '--status' || argv.includes('--status')) {
  const s = loadState()
  console.log('【百度恢复探测】')
  if (s.attempts === undefined || s.attempts.length === 0) {
    console.log('  还没有探测记录。用 --now 立刻探一次，或 --watch 后台逐次探。')
  } else {
    console.log(`  最近结论：${s.conclusion ?? '—'}`)
    if (s.recoveredAt !== undefined) console.log(`  恢复时间：${s.recoveredAt}`)
    console.log(`  探测历史（最近 ${s.attempts.length} 次）：`)
    for (const a of s.attempts.slice(-8)) {
      console.log(`    ${a.at.slice(0, 19)}  [${a.reason}]  ${fmt(a)}`)
    }
  }
  process.exit(0)
}

if (cmd === '--now') {
  console.log(`立刻探测百度（查询「${PROBE_QUERY}」）…`)
  const r = await probeOnce('manual')
  console.log(`  ${fmt(r)}`)
  process.exit(r.ok ? 0 : 1)
}

if (cmd === '--at') {
  const delay = parseDelay(argOf('at', '6h'))
  console.log(`将在 ${Math.round(delay / 60000)} 分钟后探测百度一次（PID ${process.pid}）`)
  await new Promise((r) => setTimeout(r, delay))
  const r = await probeOnce(`at+${Math.round(delay / 3600000)}h`)
  console.log(`  ${fmt(r)}`)
  process.exit(r.ok ? 0 : 1)
}

if (cmd === '--watch') {
  const plan = [6, 12, 18, 24]   // 小时后
  console.log('后台探测器已启动：将在 6h / 12h / 18h / 24h 各探一次百度，成功即停。')
  const t0 = Date.now()
  for (const h of plan) {
    const wait = t0 + h * 3600000 - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    console.log(`[+${h}h] 探测中…`)
    const r = await probeOnce(`schedule+${h}h`)
    console.log(`  ${fmt(r)}`)
    if (r.ok) { console.log('  ✅ 已恢复，停止后续探测'); break }
  }
  process.exit(0)
}

console.log(`用法：
  node tools/baidu-probe.mjs --status      查看探测记录
  node tools/baidu-probe.mjs --now         立刻探一次
  node tools/baidu-probe.mjs --at 6h       6 小时后探一次
  node tools/baidu-probe.mjs --watch       后台按 6/12/18/24h 逐次探`)
