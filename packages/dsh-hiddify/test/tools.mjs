/**
 * dsh-hiddify 工具层测试 —— 用最小 mock 宿主（假的 ctx.tools.register）把 7 个工具全跑一遍，
 * 验证的是「模型实际会调到的那段代码」，不需要重启 DSH App。
 * 用法：node test/tools.mjs [--keep]
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const keep = process.argv.includes('--keep')

// ── mock 宿主 ────────────────────────────────────────────────
const tools = new Map()
const ctx = { tools: { register: (def) => { tools.set(def.name, def) } } }
const mod = await import('../lib/index.js')
mod.apply(ctx, { port: 12399, clashPort: 6756, mode: 'cn-bypass', lanDirect: true })

console.log('注册到的工具:', [...tools.keys()].join(', '))
const missing = ['hiddify_status', 'hiddify_start', 'hiddify_stop', 'hiddify_mode', 'hiddify_nodes', 'hiddify_search', 'hiddify_fetch'].filter((n) => !tools.has(n))
if (missing.length > 0) { console.error('❌ 缺工具:', missing.join(', ')); process.exit(1) }

const call = async (name, args) => {
  const def = tools.get(name)
  console.log(`\n──────── ${name} ${JSON.stringify(args ?? {})} ────────`)
  const started = Date.now()
  try {
    const out = await def.execute(args ?? {}, { signal: undefined })
    console.log(String(out).slice(0, 1400))
    console.log(`（${Date.now() - started}ms）`)
    return out
  } catch (error) {
    console.log(`❌ 抛异常：${error?.stack ?? error}`)
    return undefined
  }
}

await call('hiddify_status', { probe: false })
await call('hiddify_start', { mode: 'cn-bypass', systemProxy: false })
await call('hiddify_status', { probe: true })
await call('hiddify_nodes', { action: 'list' })
await call('hiddify_search', { query: '"紫微斗数" 古本 全书', engines: ['duckduckgo', 'bing', 'baidu'], limit: 4 })
await call('hiddify_fetch', { url: 'https://zh.wikipedia.org/zh-hans/%E7%B4%AB%E5%BE%AE%E6%96%97%E6%95%B8', maxChars: 600 })
await call('hiddify_mode', { mode: 'global' })
await call('hiddify_mode', { mode: 'cn-bypass' })
if (!keep) await call('hiddify_stop', {})
else console.log('\n（--keep：保留内核运行）')
console.log('\n测试结束。')
