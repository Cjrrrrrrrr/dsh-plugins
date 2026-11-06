/**
 * GitHub 开源项目采集 —— 命理资料的第 4 个搜索面（网页/古籍 + 群文件 + 学术之后）。
 *
 * 为什么需要：Bing/百度/360 对「铁板神数」这类冷门主题已经见底（实测 10 条 0 相关），
 * 但 GitHub 上有大量排盘引擎、条文数据集、古籍纯文本仓库——搜索引擎索引不到。
 *
 * 用法：
 *   node tools/collect-github.mjs --dry                只检索，看命中
 *   node tools/collect-github.mjs --run --max-repos 12 检索并抓 README 归档
 *   node tools/collect-github.mjs --run --topic 铁板神数
 *
 * 产物：mingli-corpus/17-开源项目/<主题>/<owner>__<repo>.md
 *       mingli-corpus/17-开源项目/_github清单.jsonl（去重与溯源）
 *
 * 速率：未认证搜索 10 次/分钟、核心 API 60 次/小时 —— 所以默认每个主题只搜 1 次、
 *       每轮最多抓 12 个 README，超了会自动等。
 */
import { mkdirSync, existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { proxyFetch } from '../lib/proxy.js'
import { clashApi, readRuntime } from '../lib/core.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT = 'E:\\deepseekharness\\mingli-corpus\\17-开源项目'
const MANIFEST = join(OUT, '_github清单.jsonl')
const PROXY = 'http://127.0.0.1:3166'

const argv = process.argv.slice(2)
const argOf = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d }
const DRY = argv.includes('--dry')
const RUN = argv.includes('--run')
const ONLY = argOf('topic', '')
const MAX_REPOS = Number(argOf('max-repos', '12'))

const TOPICS = {
  铁板神数: ['铁板神数', '邵子神数', 'tieban shenshu'],
  紫微斗数: ['紫微斗数', 'ziwei doushu', '紫微斗數'],
  八字: ['八字 排盘', 'bazi calculator', '四柱'],
  七政四余: ['七政四余', 'qizheng siyu', '七政四餘'],
  奇门遁甲: ['奇门遁甲', 'qimen dunjia'],
  六爻: ['六爻 排盘', 'liuyao'],
  风水: ['风水 罗盘', 'fengshui luopan'],
  命理数据: ['命理 数据集', '万年历 数据集', 'lunar calendar chinese'],
}

const UA = 'dsh-karing-collector/1.0 (+local research)'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function gh(path, { accept = 'application/vnd.github+json', timeoutMs = 30000 } = {}) {
  try {
    return await proxyFetch(`https://api.github.com${path}`, {
      proxy: PROXY,
      timeoutMs,
      headers: { 'User-Agent': UA, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' },
    })
  } catch (e) {
    // 超时/连接重置统一折成 status=0，交给 ghWithRetry 轮换节点重试
    return { status: 0, text: '', error: e?.message ?? String(e) }
  }
}

/** 节点轮换：某些节点访问 api.github.com 直接 000（实测日本节点不通、美国/新加坡通）。 */
async function rotateNode() {
  const rt = readRuntime(join(ROOT, 'data', 'runtime.json'))
  if (rt === undefined) return false
  try {
    const sel = await clashApi({ port: rt.controlPort, secret: rt.secret, path: '/proxies/dsh_selector' })
    if (sel.status !== 200) return false
    const info = JSON.parse(sel.text)   // 只有 all/now，比 /proxies 小得多
    const now = info.now ?? ''
    const nodes = (info.all ?? []).filter((k) => k !== now && k !== 'urltest_out')
    if (nodes.length === 0) return false
    const pick = nodes[Math.floor(Math.random() * nodes.length)]
    const put = await clashApi({
      port: rt.controlPort, secret: rt.secret, path: '/proxies/dsh_selector',
      method: 'PUT', body: { name: pick },
    })
    console.log(`   ↻ 轮换节点 → ${pick}（${put.status}）`)
    return put.status === 204 || put.status === 200
  } catch (e) {
    console.log(`   ↻ 轮换失败：${e?.message ?? e}`)
    return false
  }
}

async function ghWithRetry(path, opts, tries = 4) {
  for (let i = 0; i < tries; i += 1) {
    const res = await gh(path, opts)
    if (res.status === 200) return res
    if (res.status === 403 || res.status === 429) {
      console.log(`   ⚠️ GitHub 限流/拒绝（${res.status}），等 20s`)
      await sleep(20000)
      continue
    }
    if (res.status === 0 || res.status >= 500 || res.status === 0) {
      await rotateNode()
      await sleep(1200)
      continue
    }
    return res
  }
  return { status: 0, text: '' }
}

function loadSeen() {
  const seen = new Set()
  if (!existsSync(MANIFEST)) return seen
  for (const line of readFileSync(MANIFEST, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue
    try { seen.add(JSON.parse(line).full_name) } catch { /* 忽略 */ }
  }
  return seen
}

function safeName(s) {
  return s.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
}

async function main() {
  if (!RUN && !DRY) {
    console.log('需要 --dry 或 --run')
    return
  }
  mkdirSync(OUT, { recursive: true })
  const seen = loadSeen()
  const topics = ONLY ? { [ONLY]: TOPICS[ONLY] } : TOPICS
  let fetched = 0
  const summary = []

  for (const [topic, keywords] of Object.entries(topics)) {
    if (keywords === undefined) { console.log(`未知主题 ${topic}`); continue }
    const q = encodeURIComponent(`${keywords.join(' OR ')}`)
    const res = await ghWithRetry(`/search/repositories?q=${q}&sort=stars&order=desc&per_page=15`)
    if (res.status !== 200) {
      console.log(`[${topic}] 搜索失败 status=${res.status}`)
      summary.push({ topic, status: res.status, items: 0, fetched: 0 })
      await sleep(7000)
      continue
    }
    let data
    try { data = JSON.parse(res.text) } catch { data = { items: [] } }
    // 相关性过滤：仓库名或描述里必须真的出现主题词，否则 GitHub 的模糊匹配会放进
    // 一堆同名噪音（实测「shenshu」会命中 shenshuai89 这类个人 profile 仓库）。
    const kws = keywords.map((k) => k.toLowerCase())
    const items = (data.items ?? []).filter((r) => {
      const hay = `${r.name} ${r.full_name} ${r.description ?? ''}`.toLowerCase()
      return kws.some((k) => hay.includes(k))
    })
    console.log(`[${topic}] 命中 ${data.total_count ?? 0}，本页 ${(data.items ?? []).length}，相关 ${items.length}`)
    let grabbed = 0
    for (const r of items) {
      if (fetched >= MAX_REPOS) break
      if (seen.has(r.full_name)) continue
      const desc = (r.description ?? '').replace(/\s+/g, ' ')
      console.log(`   ★${String(r.stargazers_count).padEnd(6)} ${r.full_name}  ${desc.slice(0, 56)}`)
      if (!RUN) continue

      const rd = await ghWithRetry(`/repos/${r.full_name}/readme`, { accept: 'application/vnd.github.raw' })
      if (rd.status !== 200) {
        console.log(`      README 抓取失败 ${rd.status}`)
        continue
      }
      const body = rd.text.slice(0, 200000)
      const head = [
        '---',
        `repo: ${r.full_name}`,
        `url: ${r.html_url}`,
        `stars: ${r.stargazers_count}`,
        `forks: ${r.forks_count}`,
        `language: ${r.language ?? ''}`,
        `updated: ${r.updated_at}`,
        `license: ${r.license?.spdx_id ?? ''}`,
        `topic: ${topic}`,
        '---',
        '',
        `# ${r.full_name}`,
        '',
        desc,
        '',
      ].join('\n')
      const dir = join(OUT, safeName(topic))
      mkdirSync(dir, { recursive: true })
      const file = join(dir, safeName(r.full_name) + '.md')
      writeFileSync(file, head + body, 'utf8')
      appendFileSync(MANIFEST, JSON.stringify({
        full_name: r.full_name, topic, stars: r.stargazers_count, url: r.html_url,
        desc, savedAt: new Date().toISOString(),
      }) + '\n', 'utf8')
      seen.add(r.full_name)
      fetched += 1
      grabbed += 1
      await sleep(300)
    }
    summary.push({ topic, status: res.status, items: items.length, fetched: grabbed })
    if (fetched >= MAX_REPOS) {
      console.log(`已达本轮上限 ${MAX_REPOS}，停止`)
      break
    }
    await sleep(7000) // 搜索 API 未认证限制 10 次/分钟
  }

  console.log('\n=== 本轮汇总 ===')
  for (const s of summary) console.log(`  ${s.topic.padEnd(8)} 命中页 ${String(s.items).padStart(2)} ｜ 归档 ${s.fetched}`)
  console.log(`  合计归档 ${fetched} 个仓库`)
}

main()
