/**
 * 把 Karing 内核**内化**到插件目录 —— 复制 karingService.exe 到 <插件>/runtime/，
 * 之后插件启动的是自己这份副本，不再依赖外部 Karing 安装（也不怕它升级/卸载/被杀）。
 *
 * 用法：
 *   node tools/embed-kernel.mjs                 内化（源 = 默认安装路径）
 *   node tools/embed-kernel.mjs --from <exe>    指定源
 *   node tools/embed-kernel.mjs --status        只看状态，不复制
 *
 * 实测：karingService.exe 是 Go 静态链接，单文件复制后可直接运行，
 * 不依赖 F:\Karing 下的任何 DLL（已用复制品跑通 google 204）。
 */
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { embedKernel, karingPaths, pluginRoot, EMBED_DIR, EMBED_EXE, PLUGIN_PORTS, prepareRuntime, readService } from '../lib/core.js'

const args = process.argv.slice(2)
const argOf = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : d }
const from = argOf('from', '')
const statusOnly = args.includes('--status')

const paths = karingPaths(undefined, undefined)
console.log('插件根目录：', pluginRoot())
console.log('内化目标：  ', paths.embeddedPath, existsSync(paths.embeddedPath) ? `（已存在，${(statSync(paths.embeddedPath).size / 1048576).toFixed(1)} MB）` : '（不存在）')
console.log('外部源：    ', from.length > 0 ? from : paths.externalPath, existsSync(from.length > 0 ? from : paths.externalPath) ? '✅' : '❌')
console.log('当前内核来源：', paths.kernelSource === 'embedded' ? '✅ 插件自带（已内化）' : '⚠️ 外部安装')

if (statusOnly) process.exit(0)

const res = embedKernel({ installExe: from })
if (!res.ok) { console.error('❌ 内化失败：', res.error); process.exit(1) }
console.log(`\n✅ 已内化：${res.from}`)
console.log(`        → ${res.to}（${(res.bytes / 1048576).toFixed(1)} MB）`)

// 顺带把配置也自持化（端口换成插件专属，避免和 GUI 抢）
const dataDir = join(pluginRoot(), 'data')
const after = karingPaths(undefined, undefined)
const prepared = prepareRuntime({ paths: after, dataDir, cnBypass: true, lanDirect: true })
if (prepared.ok) {
  console.log(`\n✅ 配置已自持：${prepared.corePath}`)
  console.log(`   三个入站：direct=${prepared.ports.direct} proxy=${prepared.ports.proxy} rule=${prepared.ports.rule}（与 GUI 的 3065-3067 隔离）`)
  console.log(`   控制面：127.0.0.1:${prepared.controlPort} ｜ 节点 ${prepared.nodeCount} ｜ 规则 ${prepared.ruleCount} 条`)
  console.log(`   ${prepared.bootstrapped ? '（本次从 GUI 配置 bootstrap 了一次，之后不再依赖 GUI）' : '（使用已有的插件自有配置）'}`)
} else {
  console.log(`\n⚠️ 配置自持失败：${prepared.error}`)
}
console.log(`\n下一步：node test/up.mjs rule   然后  node test/down.mjs`)
