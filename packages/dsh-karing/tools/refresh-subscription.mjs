/**
 * 订阅自刷新 CLI（薄壳，逻辑在 lib/subscription.js，DSH 里的 karing_subscription 工具共用同一份）。
 *
 * 用法：
 *   node tools/refresh-subscription.mjs --dry            只看差异，不写盘
 *   node tools/refresh-subscription.mjs                  刷新并写回插件自有配置
 *   node tools/refresh-subscription.mjs --url <订阅地址>  指定订阅（会记到插件名下）
 *   node tools/refresh-subscription.mjs --proxy 3166     拉订阅用的入站端口（默认 3166 全代理口）
 */
import { refreshSubscription } from '../lib/subscription.js'
import { PLUGIN_PORTS } from '../lib/core.js'

const args = process.argv.slice(2)
const argOf = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : d }

const r = await refreshSubscription({
  proxyPort: Number(argOf('proxy', String(PLUGIN_PORTS.proxy))),
  explicitUrl: argOf('url', ''),
  dryRun: args.includes('--dry'),
})
if (!r.ok) { console.error('❌', r.error); process.exit(1) }
console.log(`订阅：${r.url.slice(0, 90)}  (来源：${r.from === 'plugin' ? '插件自持' : r.from === 'cli' ? '命令行指定' : 'Karing GUI 配置'})`)
console.log(`✅ HTTP 200 / ${r.bytes} 字节 ｜ 节点 ${r.nodeCount} 个`)
if (r.traffic !== undefined) console.log(`   流量：已用 ${r.traffic.usedGB} GB / 共 ${r.traffic.totalGB} GB ｜ 到期 ${r.traffic.expireAt}`)
console.log(`   差异：新增 ${r.added.length} ｜ 端点变化 ${r.changed.length} ｜ 消失 ${r.removed.length} ｜ 解析失败 ${r.failed.length}`)
for (const t of r.added.slice(0, 6)) console.log(`   + ${t}`)
for (const t of r.changed.slice(0, 6)) console.log(`   ~ ${t}`)
for (const t of r.removed.slice(0, 6)) console.log(`   - ${t}`)
console.log(r.dryRun ? '\n（--dry：未写盘）' : `\n✅ 已写回 ${r.corePath} ｜ 入站 ${JSON.stringify(r.ports)}\n   下一步：node test/down.mjs && node test/up.mjs rule`)
