/**
 * dsh-hiddify 冒烟测试 —— 脱离 DSH 宿主直接跑，验证插件核心链路：
 *   发现订阅 → build 配置 → 注入分流规则 → 启动内核 → 三路连通性 → 多引擎搜索 → 抓正文 → 停止
 * 用法：node test/smoke.mjs [mode]
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  hiddifyPaths, resolveProfile, readProfiles, buildConfig, spawnCore, isAlive, killTree,
  readRuntime, writeRuntime, clearRuntime, readLiveClash, applyMode,
} from '../lib/core.js'
import { systemProxyStatus, probeAll, tcpProbe } from '../lib/net.js'
import { multiEngineSearch, fetchPage, ENGINE_NAMES } from '../lib/search.js'

const mode = process.argv[2] ?? 'cn-bypass'
const port = 12399
const clashPort = 6756
const dataDir = join(import.meta.dirname, '..', 'data')
mkdirSync(dataDir, { recursive: true })
const statePath = join(dataDir, 'runtime.json')

const log = (...a) => console.log(...a)
const step = (n, t) => log(`\n=== ${n}. ${t} ===`)

const paths = hiddifyPaths(undefined, undefined)
step(1, '路径与订阅发现')
log('cli   :', paths.cliPath, existsSync(paths.cliPath) ? '✅' : '❌')
log('appdata:', paths.appData)
const profiles = readProfiles(paths)
log('db.sqlite 订阅条目:', profiles.length, profiles.map((p) => `${p.name}${p.active ? '★' : ''}`).join('、'))
const profile = resolveProfile(paths, '')
log('选中配置:', profile?.path, `(来源 ${profile?.source}, mtime ${profile?.mtime})`)
if (profile === undefined) process.exit(1)

step(2, `build 配置 + 注入 ${mode} 分流规则`)
const outPath = join(dataDir, `config-${mode}.json`)
const built = await buildConfig({ cliPath: paths.cliPath, workDir: paths.workDir, profilePath: profile.path, outPath, mode, lanDirect: true, port, dnsPort: port + 51, clashPort, clashSecret: '' })
log('ok:', built.ok, '| 节点数:', built.nodeCount, '| 配置:', built.configPath)
if (!built.ok) { log('错误:', built.error); process.exit(1) }
const cfg = built.config
log('route.final:', cfg.route.final)
log('route.rules:')
for (const r of cfg.route.rules) log('  -', JSON.stringify(r).slice(0, 160))
log('rule_set:', cfg.route.rule_set.map((s) => s.tag).join(', ') || '(无)')
log('mixed 端口:', cfg.inbounds.find((i) => i.tag === 'mixed-in')?.listen_port)
log('dns servers:', cfg.dns.servers.map((s) => `${s.tag}=${s.address}`).join(' | '))
log('dns rules:', JSON.stringify(cfg.dns.rules).slice(0, 200))
log('clash_api:', JSON.stringify(cfg.experimental.clash_api))

step(3, '启动内核（standalone）')
const old = readRuntime(statePath)
if (old !== undefined && isAlive(old.pid)) { log('清理旧实例 pid', old.pid); await killTree(old.pid); await new Promise((r) => setTimeout(r, 800)) }
const logPath = join(dataDir, 'core.log')
const pid = spawnCore({ cliPath: paths.cliPath, workDir: paths.workDir, configPath: outPath, logPath })
let listening = false
for (let i = 0; i < 25; i += 1) {
  await new Promise((r) => setTimeout(r, 1000))
  if ((await tcpProbe('127.0.0.1', port, 1500)).ok) { listening = true; break }
  if (!isAlive(pid)) break
}
log(`pid=${pid} 存活=${isAlive(pid)} 端口${port}监听=${listening}`)
if (!listening) { log('内核日志尾部:\n', readFileSync(logPath, 'utf8').slice(-800)); process.exit(1) }
const live = readLiveClash(paths)
log('live clash api:', JSON.stringify(live))
const runtime = { pid, port, clashPort: live?.port ?? clashPort, clashSecret: live?.secret ?? '', mode, lanDirect: true, profile: profile.path, configPath: outPath, startedAt: new Date().toISOString(), systemProxy: false }
writeRuntime(statePath, runtime)

step(4, '系统代理现状')
log(JSON.stringify(await systemProxyStatus()))

step(5, '三路连通性实测')
const probe = await probeAll({ proxy: `http://127.0.0.1:${port}`, port })
log('代理端口:', JSON.stringify(probe.proxyPort))
for (const p of probe.foreign) log('外网', p.ok ? '✅' : '❌', p.label, p.ok ? p.status : (p.error ?? p.status), p.ms + 'ms')
for (const p of probe.domestic) log('国内', p.ok ? '✅' : '❌', p.label, p.ok ? p.status : (p.error ?? p.status), p.ms + 'ms')
log('内网:', JSON.stringify(probe.lan))

step(6, '多引擎搜索（外网经代理 + 国内直连）')
const search = await multiEngineSearch('"铁板神数" 皇极经世', { engines: ['duckduckgo', 'bing', 'baidu'], proxy: `http://127.0.0.1:${port}` })
for (const r of search.perEngine) log(`${r.label}: ${r.ok ? '✅' : '❌'} ${r.results.length} 条 ${r.ms}ms ${r.error ?? ''}`)
log('去重后:', search.dedupedCount)
for (const r of search.merged.slice(0, 6)) log(' -', `[${r.engine}]`, r.title.slice(0, 60), '→', r.url.slice(0, 80))

step(7, '抓正文')
const page = await fetchPage('https://qing-source.github.io/tieban/', { proxy: `http://127.0.0.1:${port}` })
log(`HTTP ${page.status} | ${page.bytes} bytes | 标题: ${page.title} | 正文 ${page.text.length} 字`)
log(page.text.slice(0, 300))

step(8, '停止内核（保留状态文件，便于后续 hiddify_status 观察）')
const killed = await killTree(pid)
await new Promise((r) => setTimeout(r, 600))
log('taskkill:', killed.output.slice(0, 120), '| 仍存活:', isAlive(pid))
log('\n全部步骤跑完。')
