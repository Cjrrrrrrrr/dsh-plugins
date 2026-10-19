/** 停掉 test/up.mjs 起的常驻 Karing 内核（等价于 DSH 里的 karing_stop 工具）。 */
import { join } from 'node:path'
import { readRuntime, isAlive, killTree, clearRuntime } from '../lib/core.js'
import { systemProxyOff, systemProxyStatus } from '../lib/net.js'

const statePath = join(import.meta.dirname, '..', 'data', 'runtime.json')
const rt = readRuntime(statePath)
if (rt === undefined) { console.log('没有运行记录，无需操作（GUI 起的实例请用 GUI 断开）。'); process.exit(0) }
if (!isAlive(rt.pid)) { clearRuntime(statePath); console.log(`pid=${rt.pid} 已不在运行，已清理状态。`); process.exit(0) }
const k = await killTree(rt.pid)
await new Promise((r) => setTimeout(r, 500))
console.log(`${isAlive(rt.pid) ? '⚠️ 仍在运行' : '✅ 已停止'} pid=${rt.pid} ｜ ${k.output.slice(0, 100)}`)
clearRuntime(statePath)
const sp = await systemProxyStatus()
if (sp.ok && sp.enabled) {
  const off = await systemProxyOff()
  console.log(`系统代理原为开启（指向 ${sp.server}），已关闭：${off.ok ? 'ok' : off.error}`)
} else {
  console.log('系统代理本来就没开，无需回滚。')
}
