/**
 * 开发用：起一个常驻 Karing 内核（standalone，不退出），供手工验证检索/抓取链路。
 * 用法：node test/up.mjs [mode]     停止：node test/down.mjs
 */
import { join } from 'node:path'
import { karingPaths, prepareRuntime, spawnService, isAlive, killTree, readRuntime, writeRuntime, clashApi } from '../lib/core.js'
import { tcpProbe } from '../lib/net.js'

const mode = process.argv[2] ?? 'rule'
const dataDir = join(import.meta.dirname, '..', 'data')
const statePath = join(dataDir, 'runtime.json')

const paths = karingPaths(undefined, undefined)
const prepared = prepareRuntime({ paths, dataDir, cnBypass: true, lanDirect: true })
if (!prepared.ok) { console.error('准备配置失败:', prepared.error); process.exit(1) }

const old = readRuntime(statePath)
if (old !== undefined && isAlive(old.pid)) { console.log('停掉旧实例', old.pid); await killTree(old.pid); await new Promise((r) => setTimeout(r, 1200)) }

const logPath = join(dataDir, 'core.log')
const pid = spawnService({ exePath: paths.exePath, servicePath: prepared.servicePath, workDir: prepared.workDir, connectedPort: prepared.ports.rule, logPath })
let ok = false
for (let i = 0; i < 25; i += 1) {
  await new Promise((r) => setTimeout(r, 1000))
  if ((await tcpProbe('127.0.0.1', prepared.ports.rule, 1500)).ok) { ok = true; break }
  if (!isAlive(pid)) break
}
if (!ok) { console.error('启动失败，看日志:', logPath); process.exit(1) }

const ver = await clashApi({ port: prepared.controlPort, secret: prepared.secret, path: '/version' })
writeRuntime(statePath, {
  pid, source: 'plugin', ports: prepared.ports, tags: prepared.tags,
  controlPort: prepared.controlPort, secret: prepared.secret, nodeCount: prepared.nodeCount,
  workDir: prepared.workDir, servicePath: prepared.servicePath, corePath: prepared.corePath,
  mode, startedAt: new Date().toISOString(), systemProxy: false,
})
console.log(`✅ Karing 内核已起 pid=${pid} 模式=${mode}`)
console.log(`   入站 direct=${prepared.ports.direct} proxy=${prepared.ports.proxy} rule=${prepared.ports.rule}`)
console.log(`   控制面 127.0.0.1:${prepared.controlPort}（${ver.ok ? 'clash api 可用' : 'clash api 不通'}）｜ 节点 ${prepared.nodeCount} ｜ 规则 ${prepared.ruleCount} 条`)
console.log(`   代理地址 http://127.0.0.1:${prepared.ports.rule}`)
