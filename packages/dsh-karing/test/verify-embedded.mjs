/** 从「profile 安装位置」验证内化插件：自带内核 + 自持配置 + 独立端口。 */
import { karingPaths, prepareRuntime, spawnService, isAlive, writeRuntime } from '../lib/core.js'
import { tcpProbe } from '../lib/net.js'
import { join } from 'node:path'
const dataDir = join(import.meta.dirname, '..', 'data')
const paths = karingPaths(undefined, undefined)
console.log('内核来源:', paths.kernelSource, '|', paths.exePath)
const prep = prepareRuntime({ paths, dataDir })
console.log('配置自持:', prep.ok, '| 本次 bootstrap:', prep.bootstrapped === true, '| 端口:', JSON.stringify(prep.ports), '| 节点', prep.nodeCount)
if (!prep.ok) process.exit(1)
const pid = spawnService({ exePath: paths.exePath, servicePath: prep.servicePath, workDir: prep.workDir, connectedPort: prep.ports.rule, logPath: prep.logPath })
let ok = false
for (let i = 0; i < 20; i += 1) {
  await new Promise((r) => setTimeout(r, 1000))
  if ((await tcpProbe('127.0.0.1', prep.ports.rule, 1500)).ok) { ok = true; break }
  if (!isAlive(pid)) break
}
console.log(ok ? `✅ 内化内核启动成功 pid=${pid} 入站 rule=${prep.ports.rule}` : '❌ 启动失败')
writeRuntime(join(dataDir, 'runtime.json'), { pid, source: 'plugin', ports: prep.ports, tags: prep.tags, controlPort: prep.controlPort, secret: prep.secret, nodeCount: prep.nodeCount, workDir: prep.workDir, servicePath: prep.servicePath, corePath: prep.corePath, mode: 'rule', startedAt: new Date().toISOString(), systemProxy: false })
