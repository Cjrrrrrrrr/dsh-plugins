/**
 * dsh-karing 工具层测试 —— 用最小 mock 宿主把 7 个工具全跑一遍，
 * 验证「模型实际会调到的那段代码」，不需要重启 DSH App。
 * 用法：node test/tools.mjs [--keep]
 */
const keep = process.argv.includes('--keep')

const tools = new Map()
const ctx = { tools: { register: (def) => { tools.set(def.name, def) } } }
const mod = await import('../lib/index.js')
mod.apply(ctx, { mode: 'rule', cnBypass: true, lanDirect: true })

console.log('注册到的工具:', [...tools.keys()].join(', '))
const want = ['karing_status', 'karing_start', 'karing_stop', 'karing_mode', 'karing_nodes', 'karing_search', 'karing_fetch']
const missing = want.filter((n) => !tools.has(n))
if (missing.length > 0) { console.error('❌ 缺工具:', missing.join(', ')); process.exit(1) }

const call = async (name, args) => {
  const def = tools.get(name)
  console.log(`\n──────── ${name} ${JSON.stringify(args ?? {})} ────────`)
  const started = Date.now()
  try {
    const out = await def.execute(args ?? {}, { signal: undefined })
    console.log(String(out).slice(0, 1500))
    console.log(`（${Date.now() - started}ms）`)
    return out
  } catch (error) {
    console.log(`❌ 抛异常：${error?.stack ?? error}`)
    return undefined
  }
}

await call('karing_status', { probe: false })
await call('karing_start', { mode: 'rule', systemProxy: false })
await call('karing_status', { probe: true })
await call('karing_nodes', { action: 'list' })
await call('karing_search', { query: '"铁板神数" 皇极经世', engines: ['duckduckgo', 'bing'], limit: 4 })
await call('karing_fetch', { url: 'https://zh.wikisource.org/zh-hans/%E7%85%99%E6%B3%A2%E9%87%A3%E5%8F%9F%E6%AD%8C', maxChars: 500 })
await call('karing_mode', { mode: 'proxy', systemProxy: true })
await call('karing_mode', { mode: 'rule', systemProxy: true })
if (!keep) await call('karing_stop', {})
else console.log('\n（--keep：保留内核运行）')
console.log('\n测试结束。')
