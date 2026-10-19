/**
 * 开发用：起一个常驻内核（不退出），供手工验证 hiddify_search / hiddify_fetch 等链路。
 * 用法：node test/up.mjs [mode] [port]
 * 停止：node test/down.mjs
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hiddifyPaths, resolveProfile, buildConfig, spawnCore, isAlive, killTree, readRuntime, writeRuntime, readLiveClash } from '../lib/core.js'
import { tcpProbe } from '../lib/net.js'

const mode = process.argv[2] ?? 'cn-bypass'
const port = Number(process.argv[3] ?? 12399)
const clashPort = 6756
const dataDir = join(import.meta.dirname, '..', 'data')
mkdirSync(dataDir, { recursive: true })
const statePath = join(dataDir, 'runtime.json')

const paths = hiddifyPaths(undefined, undefined)
const profile = resolveProfile(paths, '')
const outPath = join(dataDir, `config-${mode}.json`)
const built = await buildConfig({ cliPath: paths.cliPath, workDir: paths.workDir, profilePath: profile.path, outPath, mode, lanDirect: true, port, dnsPort: port + 51, clashPort, clashSecret: '' })
if (!built.ok) { console.error('build 失败:', built.error); process.exit(1) }

const old = readRuntime(statePath)
if (old !== undefined && isAlive(old.pid)) { console.log('停掉旧实例', old.pid); await killTree(old.pid); await new Promise((r) => setTimeout(r, 1200)) }

const logPath = join(dataDir, 'core.log')
const pid = spawnCore({ cliPath: paths.cliPath, workDir: paths.workDir, configPath: outPath, logPath })
let ok = false
for (let i = 0; i < 25; i += 1) {
  await new Promise((r) => setTimeout(r, 1000))
  if ((await tcpProbe('127.0.0.1', port, 1500)).ok) { ok = true; break }
  if (!isAlive(pid)) break
}
if (!ok) { console.error('启动失败，日志尾部：\n', readFileSync(logPath, 'utf8').slice(-600)); process.exit(1) }
const live = readLiveClash(paths)
writeRuntime(statePath, { pid, port, clashPort: live?.port ?? clashPort, clashSecret: live?.secret ?? '', mode, lanDirect: true, profile: profile.path, configPath: outPath, startedAt: new Date().toISOString(), systemProxy: false })
console.log(`✅ 内核已起 pid=${pid} 模式=${mode} 代理=http://127.0.0.1:${port} clash=${live?.port} secret=${live?.secret ? '已取到' : '无'}`)
