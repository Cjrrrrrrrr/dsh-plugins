/**
 * 知乎真实案例采集 —— 用知乎开放平台 CLI 检索社区原始内容（真实案例/反馈/讨论），
 * 按主题归档到资料库：案例正文进 05-真实案例与反馈/ 或对应术数目录，原始 JSON 全量留档。
 *
 * 用法：node tools/zhihu-cases.mjs [--count 12] [--root <语料根>]
 * CLI 路径取自 `scripts/run.ps1 status` 的 binary_path（本机实测：C:\Users\14247\AppData\Local\ZhihuCLI\current\zhihu-cli.exe）
 */
import { execFile } from 'node:child_process'
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const argOf = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d }
const ROOT = argOf('root', 'E:\\deepseekharness\\mingli-corpus')
const COUNT = Math.min(Number(argOf('count', '10')), 10)  // CLI 限制：1-10
const CLI = argOf('cli', 'C:\\Users\\14247\\AppData\\Local\\ZhihuCLI\\current\\zhihu-cli.exe')

/** 查询 → 归档目录 */
const QUERIES = [
  ['紫微斗数 案例 直断 应验', '05-真实案例与反馈'],
  ['紫微斗数 命例 反馈', '01-紫微斗数与八字/紫微斗数'],
  ['八字 案例 断命 反馈', '05-真实案例与反馈'],
  ['八字 用神 命例 实战', '01-紫微斗数与八字/八字'],
  ['八字 紫微 合参 案例', '01-紫微斗数与八字/八紫合参'],
  ['奇门遁甲 案例 实战 断卦', '03-奇门遁甲'],
  ['铁板神数 案例 条文 应验', '04-铁板神数'],
  ['七政四余 星盘 案例 断验', '02-七政四余'],
  ['命理 预测 复盘 案例 记录', '05-真实案例与反馈'],
]

const run = (argv) => new Promise((resolve) => {
  execFile(CLI, argv, { maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
    resolve({
      ok: error === null,
      stdout: String(stdout ?? ''),
      stderr: String(stderr ?? ''),
      error: error === null ? undefined : `exit=${error.code} ${String(error.message).slice(0, 120)}`,
    })
  })
})

const safeName = (s) => String(s).replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'untitled'

let total = 0
const perDir = new Map()
for (const [query, dir] of QUERIES) {
  const res = await run(['search', 'zhihu', '--query', query, '--count', String(COUNT)])
  if (!res.ok && res.stdout.trim().length === 0) {
    console.log(`❌ [${query}] ${res.error} ｜ stderr: ${res.stderr.slice(0, 200)}`)
    continue
  }
  let json
  try { json = JSON.parse(res.stdout) } catch { console.log(`❌ [${query}] 输出不是 JSON：${res.stdout.slice(0, 200)}`); continue }
  if (json.Code !== 0) { console.log(`❌ [${query}] Code=${json.Code} ${json.Message}`); continue }
  const items = json.Data?.Items ?? []
  const outDir = join(ROOT, dir)
  mkdirSync(outDir, { recursive: true })
  appendFileSync(join(outDir, '_知乎案例.jsonl'), items.map((x) => JSON.stringify({ query, ...x })).join('\n') + '\n', 'utf8')

  const md = [
    '---',
    `title: ${JSON.stringify(`知乎案例集：${query}`)}`,
    `source_engine: 知乎开放平台`,
    `query: ${JSON.stringify(query)}`,
    `fetched_at: ${new Date().toISOString()}`,
    `topic: ${dir}`,
    `count: ${items.length}`,
    '---',
    '',
    `# 知乎案例集：${query}`,
    '',
    `> 来源：知乎开放平台搜索（原始 JSON 见同目录 \`_知乎案例.jsonl\`）`,
    `> 命中 ${items.length} 条`,
    '',
  ]
  items.forEach((it, i) => {
    md.push(`## ${i + 1}. ${it.Title}`, '', `- 作者：${it.AuthorName ?? '?'}　赞同 ${it.VoteUpCount ?? 0}　评论 ${it.CommentCount ?? 0}`, `- 原文：${String(it.Url ?? '').split('?')[0]}`, '', String(it.ContentText ?? '').trim(), '')
  })
  const file = join(outDir, `知乎案例-${safeName(query)}.md`)
  writeFileSync(file, md.join('\n'), 'utf8')
  perDir.set(dir, (perDir.get(dir) ?? 0) + items.length)
  total += items.length
  console.log(`✅ [${query}] ${items.length} 条 → ${dir}/${file.split('\\').pop()}`)
  await new Promise((r) => setTimeout(r, 400))
}

console.log(`\n知乎案例合计 ${total} 条：`)
for (const [d, n] of perDir) console.log(`  ${d}  ${n} 条`)
