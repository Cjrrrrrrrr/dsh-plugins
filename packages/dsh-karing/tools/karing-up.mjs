/**
 * karing-up —— 命令行启动 Karing 内核（等价于插件工具 karing_start，systemProxy=false）。
 *
 * 为什么不改系统代理：本脚本只让三个本地入站在 3165/3166/3167 上监听，
 * 采集脚本用 `--force-proxy http://127.0.0.1:3166` 显式指定出口，不动注册表。
 *
 * 用法：
 *   node tools/karing-up.mjs            # 启动（已有内核则复用）
 *   node tools/karing-up.mjs --stop     # 停止插件起的那个
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  karingPaths, prepareRuntime, spawnService, listCoreProcesses,
  readRuntime, writeRuntime, clearRuntime, isAlive, killTree, PLUGIN_PORTS,
} from '../lib/core.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DATA = join(ROOT, 'data')
const STATE = join(DATA, 'runtime.json')
const STOP = process.argv.includes('--stop')

if (STOP) {
  const rt = readRuntime(STATE)
  if (rt === undefined) {
    console.log('没有插件启动记录，未动任何进程')
  } else if (!isAlive(rt.pid)) {
    clearRuntime(STATE)
    console.log(`pid=${rt.pid} 已不在运行，已清理状态文件`)
  } else {
    await killTree(rt.pid)
    clearRuntime(STATE)
    console.log(`已停止 pid=${rt.pid}（系统代理未改动）`)
  }
  process.exit(0)
}

const existing = listCoreProcesses()
if (existing.length > 0) {
  console.log('已有 karingService 在跑，直接复用：')
  for (const p of existing) console.log('  pid', p.pid ?? p)
  process.exit(0)
}

const paths = karingPaths('', '')
const rt = prepareRuntime({ paths, dataDir: DATA, ports: PLUGIN_PORTS })
if (rt?.ok !== true) {
  console.log('prepareRuntime 失败：', rt?.error ?? '未知')
  process.exit(1)
}

const pid = spawnService({
  exePath: paths.exePath,
  servicePath: rt.servicePath,
  workDir: rt.workDir,
  connectedPort: PLUGIN_PORTS.rule,
  logPath: rt.logPath,
})

const state = {
  pid,
  source: 'plugin',
  ports: rt.ports,
  tags: rt.tags,
  controlPort: rt.controlPort,
  secret: rt.secret,
  nodeCount: rt.nodeCount,
  workDir: rt.workDir,
  servicePath: rt.servicePath,
  corePath: rt.corePath,
  mode: 'rule',
  systemProxy: false,
  startedAt: new Date().toISOString(),
}
writeRuntime(STATE, state)

await new Promise((r) => setTimeout(r, 2500))
console.log(`✅ 已启动 pid=${pid}  内核来源=${rt.kernelSource}  节点 ${rt.nodeCount}`)
console.log(`   入站：direct=${rt.ports.direct} proxy=${rt.ports.proxy} rule=${rt.ports.rule}  控制面 ${rt.controlPort}`)
console.log(`   存活：${isAlive(pid) ? '是' : '否（看 data/core.log）'}`)
