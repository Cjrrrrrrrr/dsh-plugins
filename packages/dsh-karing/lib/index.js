/**
 * @local/dsh-karing —— 单独调用 Karing 的 DSH 插件（宿主侧）。
 *
 * 七个模型可用工具：
 *   · karing_status —— 状态总览：GUI/内核进程、三个入站端口、Clash 控制面、系统代理、节点、三路连通性实测
 *   · karing_start  —— 启动 Karing 内核（优先复用 GUI 已起的，没有才 standalone 起一个）
 *   · karing_stop   —— 停止插件起的内核（不动 GUI 的）
 *   · karing_mode   —— 切换分流模式：rule（内网直连+外网走代理）/ proxy（全代理）/ direct（全直连）
 *   · karing_nodes  —— 列节点 / 切节点 / 测延迟（Clash REST 控制面）
 *   · karing_search —— 经代理的多引擎检索
 *   · karing_fetch  —— 经代理抓正文，供资料搜集归档
 *
 * 与 Hiddify 版的关键差异：**Karing 一次开三个 mixed 入站**，用「连哪个端口」决定出口，
 * 所以换模式不用重启内核 —— karing_mode 只是把系统代理指到另一个端口，秒切。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MODES, MODE_INBOUND, LAN_CIDRS, CN_SUFFIXES, PLUGIN_PORTS, karingPaths, readService, readCore, describeInbounds, discoverTags,
  prepareRuntime, spawnService, isAlive, killTree, listCoreProcesses, listGuiProcesses,
  readRuntime, writeRuntime, clearRuntime, clashApi, embedKernel, pluginRoot, EMBED_EXE,
} from './core.js'
import { systemProxyStatus, systemProxyOn, systemProxyOff, probeAll, tcpProbe } from './net.js'
import { multiEngineSearch, fetchPage, ENGINE_NAMES, FOREIGN_ENGINES, DOMESTIC_ENGINES, ENGINES, DEFAULT_ENGINES, relevanceOf } from './search.js'

const { defineTool } = await import('@deepseek-ai/dsh-tools').catch(() => ({ defineTool: (d) => d }))
const schemastery = await import('@deepseek-ai/schemastery').catch(() => ({ default: undefined }))
const z = schemastery.default

export const name = 'dsh-karing'
export const inject = ['tools']

export const Config = z === undefined
  ? undefined
  : z.object({
      exePath: z.string().default('F:\\Karing\\karingService.exe'),
      appDataDir: z.string().default(''),
      dataDir: z.string().default(''),
      mode: z.string().default('rule'),
      cnBypass: z.boolean().default(true),
      lanDirect: z.boolean().default(true),
      systemProxy: z.boolean().default(false),
    })

const PLUGIN_ROOT = dirname(fileURLToPath(new URL('.', import.meta.url)))

function normalizeConfig(raw) {
  const c = raw ?? {}
  return {
    exePath: typeof c.exePath === 'string' && c.exePath.length > 0 ? c.exePath : 'F:\\Karing\\karingService.exe',
    appDataDir: typeof c.appDataDir === 'string' ? c.appDataDir : '',
    dataDir: typeof c.dataDir === 'string' && c.dataDir.length > 0 ? c.dataDir : join(PLUGIN_ROOT, 'data'),
    mode: MODES.includes(c.mode) ? c.mode : 'rule',
    cnBypass: c.cnBypass !== false,
    lanDirect: c.lanDirect !== false,
    systemProxy: c.systemProxy === true,
    statePath: join(typeof c.dataDir === 'string' && c.dataDir.length > 0 ? c.dataDir : join(PLUGIN_ROOT, 'data'), 'runtime.json'),
  }
}

const MODE_DOC = {
  rule: '规则分流：内网/私有网段直连 + 国内域名直连，其余走代理（推荐，对应入站 mixed_in_rule）',
  proxy: '全部走代理（对应入站 mixed_in_proxy）——外网最省心，国内站点会绕一圈',
  direct: '全部直连（对应入站 mixed_in_direct）——临时关翻墙，或只做本机端口转发',
}

/** 当前生效的代理地址（供 search / fetch 用）：优先 rule 口。 */
function currentProxy(cfg, runtime) {
  const ports = runtime?.ports
  if (ports === undefined) return undefined
  const port = ports.rule ?? ports.proxy ?? ports.direct
  return Number.isSafeInteger(port) ? `http://127.0.0.1:${port}` : undefined
}

/** 探测 Clash 控制面是否活着（= 有一个内核在跑，不管是谁起的）。 */
async function coreAlive(cfg) {
  const paths = karingPaths(cfg.exePath, cfg.appDataDir)
  const svc = readService(paths)
  // 插件自有配置优先（自持后不再依赖 GUI 的 service.json）
  const ownServicePath = join(cfg.dataDir, 'service.json')
  const ownCorePath = join(cfg.dataDir, 'core.json')
  let controlPort = svc?.controlPort
  let secret = svc?.secret
  let core
  if (existsSync(ownServicePath)) {
    try {
      const own = JSON.parse(readFileSync(ownServicePath, 'utf8'))
      controlPort = Number(own.control_port ?? controlPort)
      secret = String(own.secret ?? secret)
    } catch { /* 退回 GUI 的 */ }
  }
  if (existsSync(ownCorePath)) {
    try { core = JSON.parse(readFileSync(ownCorePath, 'utf8')) } catch { /* 忽略 */ }
  }
  if (controlPort === undefined) return undefined
  const r = await clashApi({ port: controlPort, secret, path: '/version', timeoutMs: 4000 })
  if (!r.ok) return undefined
  if (core === undefined) core = readCore(paths)
  return {
    controlPort,
    secret,
    ports: describeInbounds(core ?? {}),
    tags: discoverTags(core ?? {}),
    nodeCount: (core?.outbounds ?? []).filter((o) => !['direct', 'block', 'urltest', 'selector'].includes(o.type)).length,
    version: r.json?.version ?? r.text.slice(0, 40),
  }
}

/** 确保有一个可用内核：先复用，起不来才 standalone 起。 */
async function ensureCore(cfg, { start = true } = {}) {
  const paths = karingPaths(cfg.exePath, cfg.appDataDir)
  const existing = await coreAlive(cfg)
  if (existing !== undefined) {
    return { ok: true, source: 'existing', kernelSource: paths.kernelSource, ...existing }
  }
  if (!start) return { ok: false, error: '内核未运行（Clash 控制面不通）' }
  if (!existsSync(paths.exePath)) return { ok: false, error: `找不到 ${paths.exePath}` }

  const prepared = prepareRuntime({ paths, dataDir: cfg.dataDir, cnBypass: cfg.cnBypass, lanDirect: cfg.lanDirect })
  if (!prepared.ok) return prepared

  // 端口可能被别的内核占用（GUI 正在连），先确认
  const clashProbe = await tcpProbe('127.0.0.1', prepared.controlPort, 2000)
  if (clashProbe.ok) {
    const again = await coreAlive(cfg)
    if (again !== undefined) return { ok: true, source: 'existing', kernelSource: paths.kernelSource, ...again }
  }

  const logPath = join(cfg.dataDir, 'core.log')
  mkdirSync(cfg.dataDir, { recursive: true })
  const pid = spawnService({
    exePath: paths.exePath,
    servicePath: prepared.servicePath,
    workDir: prepared.workDir,
    connectedPort: prepared.ports.rule ?? 3067,
    logPath,
  })

  let ready = false
  for (let i = 0; i < 25; i += 1) {
    await new Promise((r) => setTimeout(r, 1000))
    const probe = await tcpProbe('127.0.0.1', prepared.ports.rule ?? 3067, 1500)
    if (probe.ok) { ready = true; break }
    if (!isAlive(pid)) break
  }
  if (!ready) {
    await killTree(pid)
    return { ok: false, error: `内核启动后入站端口未监听（pid=${pid}，日志 ${logPath}）` }
  }
  const runtime = {
    pid,
    source: 'plugin',
    ports: prepared.ports,
    tags: prepared.tags,
    controlPort: prepared.controlPort,
    secret: prepared.secret,
    nodeCount: prepared.nodeCount,
    workDir: prepared.workDir,
    servicePath: prepared.servicePath,
    corePath: prepared.corePath,
    startedAt: new Date().toISOString(),
    systemProxy: false,
  }
  writeRuntime(cfg.statePath, runtime)
  return { ok: true, source: 'plugin', ...runtime, logPath }
}

function renderProbe(probe) {
  const line = (p) => `${p.ok ? '✅' : '❌'} ${p.label ?? p.host}${p.ok ? ` HTTP ${p.status}` : ''} ${p.ms}ms${p.ok ? '' : ` — ${p.error ?? p.reason ?? `HTTP ${p.status}`}`}`
  const lanText = probe.lan?.gateways?.length > 0
    ? probe.lan.gateways.map((g) => `${g.gateway}${g.iface !== undefined ? `(${g.iface})` : ''} ${g.ok ? `✅ ${g.method} ${g.ms}ms` : '❌ 不可达'}`).join(' ｜ ')
    : `❌ ${probe.lan?.reason ?? '未取到网关'}`
  return [
    `代理端口 127.0.0.1:${probe.proxyPort?.port ?? '?'} ${probe.proxyPort?.ok ? '✅ 在听' : '❌ 未监听'}`,
    `外网（经代理）：${probe.foreign.map(line).join(' ｜ ')}`,
    `国内（直连）：${probe.domestic.map(line).join(' ｜ ')}`,
    `内网（默认网关）：${lanText}`,
  ].join('\n')
}

export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig)

  ctx.tools.register(defineTool({
    name: 'karing_status',
    description: [
      '查看 Karing 代理的完整状态：GUI/内核进程、三个 mixed 入站端口（direct/proxy/rule）、Clash 控制面、',
      '系统代理开关、节点数与当前节点，并**实测**外网（经代理）/ 国内（直连）/ 内网（网关）三路连通性。',
      '排障、确认「外网与内网是否同时可用」时先跑这个。',
    ].join(''),
    parameters: { probe: { type: 'boolean', description: '是否做连通性实测（默认 true，约 5-20 秒）。' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    timeoutMs: 90000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const paths = karingPaths(cfg.exePath, cfg.appDataDir)
      const svc = readService(paths)
      const core = readCore(paths)
      const gui = await listGuiProcesses()
      const procs = await listCoreProcesses()
      const alive = await coreAlive(cfg)
      const runtime = readRuntime(cfg.statePath)
      const sp = await systemProxyStatus()
      const ports = alive?.ports ?? describeInbounds(core ?? {})
      const lines = [
        '【Karing 状态】',
        `GUI 进程：${gui.length > 0 ? `✅ 运行中 pid=${gui.join(',')}` : '❌ 未运行'}`,
        `内核进程：${procs.length > 0 ? `✅ ${procs.length} 个（${procs.map((p) => p.pid).join(',')}）${runtime !== undefined && procs.some((p) => p.pid === runtime.pid) ? ' [含插件起的]' : ' [GUI 起的]'}` : '❌ 未运行'}`,
        `内核：${paths.kernelSource === 'embedded' ? '✅ 插件自带（已内化）' : '⚠️ 外部安装（未内化）'} ${paths.exePath} ${existsSync(paths.exePath) ? '' : '❌ 不存在'}`,
        `  内化命令：node tools/embed-kernel.mjs（复制 ${EMBED_EXE} → ${join(pluginRoot(), 'runtime')}）`,
        `插件自有配置：${existsSync(join(cfg.dataDir, 'core.json')) ? '✅ 已自持（不依赖 GUI）' : '⛔ 未生成（首次启动会从 GUI bootstrap 一次）'}`,
        `配置：${svc === undefined ? '❌ 读不到 service.json' : `service.json v${svc.version} ｜ 控制面 127.0.0.1:${svc.controlPort}`}`,
        `三个入站：direct=${ports.direct ?? '?'} ｜ proxy=${ports.proxy ?? '?'} ｜ **rule=${ports.rule ?? '?'}**`,
        `节点数：${alive?.nodeCount ?? '—'} ｜ 当前节点：${alive === undefined ? '—（内核未跑）' : '(见 karing_nodes)'}`,
        `系统代理：${sp.ok ? `${sp.enabled ? '✅ 开' : '⛔ 关'} ${sp.server ?? ''}` : `读取失败 ${sp.error ?? ''}`}`,
        `  绕过白名单：${sp.override === undefined ? '—' : `${sp.override.split(';').length} 条（含内网段：${/192\.168\.\*/.test(sp.override) ? '✅' : '❌'}）`}`,
        `内网直连：${alive === undefined ? '—' : '✅ 配置含 ip_is_private → direct'}（网段 ${LAN_CIDRS.slice(0, 4).join(', ')} …）`,
        `国内直连：${cfg.cnBypass ? `✅ 注入 ${CN_SUFFIXES.join('/')} → direct` : '⛔ 关闭'}`,
      ]
      if (args?.probe !== false && alive !== undefined) {
        const probe = await probeAll({ proxy: `http://127.0.0.1:${ports.rule ?? ports.proxy}`, port: ports.rule ?? ports.proxy, signal: exec?.signal })
        lines.push('', '【三路连通性实测】', renderProbe(probe))
      } else if (args?.probe !== false) {
        lines.push('', '【三路连通性实测】跳过：内核未运行（用 karing_start 启动）')
      }
      return lines.join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'karing_start',
    description: [
      '启动 Karing 内核。**优先复用 GUI 已经起的那个**（不重复起、不抢端口）；GUI 没连时才 standalone 起一个。',
      'standalone 用的是插件自己的配置副本（%插件目录%/data/core.json + service.json），不会和 GUI 抢文件。',
      `可用模式：${MODES.map((m) => `${m}（${MODE_DOC[m]}）`).join('；')}。`,
      'systemProxy=true 会把 Windows 系统代理指向该模式的入站端口（注册表 HKCU，改回 0 即回滚）。',
    ].join(''),
    parameters: {
      mode: { type: 'string', description: `分流模式：${MODES.join(' / ')}（默认 ${cfg.mode}）。` },
      systemProxy: { type: 'boolean', description: '是否同时打开 Windows 系统代理（默认 false）。' },
      cnBypass: { type: 'boolean', description: '是否注入国内域名直连规则（默认 true）。' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    timeoutMs: 180000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const mode = MODES.includes(args?.mode) ? args.mode : cfg.mode
      const cnBypass = args?.cnBypass !== false && cfg.cnBypass
      const res = await ensureCore({ ...cfg, cnBypass }, { start: true })
      if (!res.ok) return `karing_start 失败：${res.error}`
      const port = res.ports[mode] ?? res.ports.rule
      let spOk = false
      if (args?.systemProxy === true || (args?.systemProxy === undefined && cfg.systemProxy)) {
        const sp = await systemProxyOn(port)
        spOk = sp.ok
        const rt = readRuntime(cfg.statePath)
        if (rt !== undefined) writeRuntime(cfg.statePath, { ...rt, systemProxy: sp.ok, mode })
      }
      const probe = await probeAll({ proxy: `http://127.0.0.1:${port}`, port, signal: exec?.signal })
      return [
        `✅ Karing 内核就绪（${res.source === 'existing' ? '复用已在运行的内核' : '插件 standalone 启动'} ｜ 内核来源：${res.kernelSource === 'embedded' ? '插件自带（已内化）' : '外部安装'}${res.bootstrapped === true ? ' ｜ 本次从 GUI 配置 bootstrap 了一次' : ''}）`,
        `${res.pid !== undefined ? `pid=${res.pid} ｜ ` : ''}控制面 127.0.0.1:${res.controlPort} ｜ 节点 ${res.nodeCount}`,
        `三个入站：direct=${res.ports.direct} ｜ proxy=${res.ports.proxy} ｜ rule=${res.ports.rule}`,
        `当前模式 ${mode}：${MODE_DOC[mode]} → 入站端口 ${port}`,
        `系统代理：${spOk ? `✅ 已指向 http://127.0.0.1:${port}` : '未开（只起本地端口）'}`,
        '',
        '【三路连通性实测】', renderProbe(probe),
      ].join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'karing_stop',
    description: '停止**插件自己启动的** Karing 内核（不会去杀 GUI 起的那个）。keepSystemProxy=false（默认）时同时关闭 Windows 系统代理。',
    parameters: { keepSystemProxy: { type: 'boolean', description: '是否保留系统代理设置（默认 false = 一起关掉）。' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const runtime = readRuntime(cfg.statePath)
      const lines = []
      if (runtime === undefined) {
        lines.push('karing_stop：没有插件启动记录，未动任何进程（GUI 起的实例请用 GUI 断开）。')
      } else if (!isAlive(runtime.pid)) {
        clearRuntime(cfg.statePath)
        lines.push(`karing_stop：pid=${runtime.pid} 已不在运行，已清理状态文件。`)
      } else {
        const killed = await killTree(runtime.pid)
        await new Promise((r) => setTimeout(r, 500))
        clearRuntime(cfg.statePath)
        lines.push(`${isAlive(runtime.pid) ? '⚠️ 进程仍在' : '✅ 已停止'} pid=${runtime.pid}`, `taskkill: ${killed.output.slice(0, 120)}`)
      }
      if (args?.keepSystemProxy !== true) {
        const off = await systemProxyOff()
        lines.push(`系统代理：${off.ok ? '✅ 已关闭（ProxyEnable=0）' : `⚠️ 关闭失败 ${off.error ?? ''}`}`)
      }
      return lines.join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'karing_mode',
    description: [
      '切换分流模式。**Karing 的三个入站常驻，所以切模式只是把系统代理指到另一个端口，不用重启内核**（秒切）。',
      MODES.map((m) => `${m}：${MODE_DOC[m]}`).join('\n'),
      '\n「自由控制电脑可同时连接外网与内网」就靠这里：rule 让内网/国内直连、外网走代理；',
      'proxy 让全部流量走代理（内网仍因 ip_is_private 规则直连）；direct 全直连。',
    ].join(''),
    parameters: {
      mode: { type: 'string', required: true, description: `目标模式：${MODES.join(' / ')}。` },
      systemProxy: { type: 'boolean', description: '是否同时打开系统代理（默认 true；direct 模式下也指到 direct 入站）。' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    timeoutMs: 90000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const mode = String(args?.mode ?? '')
      if (!MODES.includes(mode)) return `karing_mode：mode 必须是 ${MODES.join(' / ')} 之一。`
      const res = await ensureCore(cfg, { start: true })
      if (!res.ok) return `karing_mode 失败：${res.error}`
      const port = res.ports[mode] ?? res.ports.rule
      const wantProxy = args?.systemProxy !== false
      const sp = wantProxy ? await systemProxyOn(port) : await systemProxyOff()
      const rt = readRuntime(cfg.statePath)
      if (rt !== undefined) writeRuntime(cfg.statePath, { ...rt, mode, systemProxy: wantProxy && sp.ok })
      const probe = await probeAll({ proxy: `http://127.0.0.1:${port}`, port, signal: exec?.signal })
      return [
        `✅ 已切到 ${mode}（入站 ${MODE_INBOUND[mode]} @ ${port}）`,
        `系统代理：${wantProxy ? (sp.ok ? `✅ 已指向 http://127.0.0.1:${port}` : `⚠️ 设置失败 ${sp.error ?? ''}`) : '⛔ 已关闭（系统直连）'}`,
        `内核来源：${res.source === 'existing' ? '复用已在运行的实例' : '插件 standalone'} ｜ 未重启内核`,
        '',
        '【切换后三路连通性实测】', renderProbe(probe),
      ].join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'karing_nodes',
    description: [
      '查看 / 切换代理节点（走内核的 Clash REST 控制面，无需重启）。',
      'action=list 列出所有节点与当前选中；action=select 切到指定节点；action=auto 切回自动测速；action=delay 对候选节点测延迟。',
    ].join(''),
    parameters: {
      action: { type: 'string', description: 'list（默认）/ select / auto / delay。' },
      node: { type: 'string', description: 'action=select 时的节点名（先用 list 拿准确名称）。' },
      limit: { type: 'integer', description: 'delay 时最多测几个节点（默认 8）。' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const alive = await coreAlive(cfg)
      if (alive === undefined) return 'karing_nodes：内核未运行，先用 karing_start 启动。'
      const api = { port: alive.controlPort, secret: alive.secret }
      const action = String(args?.action ?? 'list')
      const list = await clashApi({ ...api, path: '/proxies' })
      if (!list.ok) return `karing_nodes：控制面不可用（HTTP ${list.status}${list.error !== undefined ? ` ${list.error}` : ''}）。`
      const proxies = list.json?.proxies ?? {}
      const selector = Object.entries(proxies).find(([, v]) => v.type === 'Selector') ?? Object.entries(proxies).find(([, v]) => v.type === 'URLTest')
      if (selector === undefined) return 'karing_nodes：配置里没有可切换的节点组。'
      const [selName, sel] = selector
      const nodes = (sel.all ?? []).filter((n) => n !== 'auto')
      if (action === 'select') {
        const target = String(args?.node ?? '')
        if (!(sel.all ?? []).includes(target)) return `karing_nodes：节点名 "${target}" 不在候选列表里。用 action=list 看准确名称。`
        const put = await clashApi({ ...api, path: `/proxies/${encodeURIComponent(selName)}`, method: 'PUT', body: { name: target } })
        return put.ok ? `✅ 已切到：${target}（原：${sel.now}）` : `切换失败：HTTP ${put.status}`
      }
      if (action === 'auto') {
        const put = await clashApi({ ...api, path: `/proxies/${encodeURIComponent(selName)}`, method: 'PUT', body: { name: 'auto' } })
        return put.ok ? '✅ 已切回 auto（自动测速择优）' : `切换失败：HTTP ${put.status}`
      }
      if (action === 'delay') {
        const limit = Number.isSafeInteger(args?.limit) ? Math.min(Math.max(args.limit, 1), 40) : 8
        const targets = nodes.slice(0, limit)
        const results = await Promise.all(targets.map(async (n) => {
          const r = await clashApi({ ...api, path: `/proxies/${encodeURIComponent(n)}/delay?timeout=5000&url=https://www.gstatic.com/generate_204`, timeoutMs: 12000 })
          return `${r.ok ? '✅' : '❌'} ${n} ${r.json?.delay !== undefined ? `${r.json.delay}ms` : `(${r.status})`}`
        }))
        return [`节点组 ${selName} ｜ 当前：${sel.now}`, '', ...results].join('\n')
      }
      return [`节点组 ${selName} ｜ 当前：${sel.now} ｜ 候选 ${nodes.length} 个`, '', ...nodes.map((n) => `${n === sel.now ? '▶' : ' '} ${n}`)].join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'karing_search',
    description: [
      '经 Karing 代理调用多种搜索引擎检索（外网走代理，国内引擎直连），返回标题/链接/摘要，跨引擎按 URL 去重。',
      `外网引擎：${FOREIGN_ENGINES.join(' / ')}。国内引擎：${DOMESTIC_ENGINES.join(' / ')}。`,
      `默认引擎集（按实测可用性排序）：${DEFAULT_ENGINES.join(' / ')}。`,
      '每个引擎都内置「代理→直连」双通道降级：代理不通时会自动改走直连。',
      '搜中文专业术语（命理/古籍/术数等）建议加引号精确匹配，如 "铁板神数" 皇极经世。',
    ].join(''),
    parameters: {
      query: { type: 'string', required: true, description: '检索词。建议用引号做精确匹配。' },
      engines: { type: 'array', items: { type: 'string' }, description: `引擎列表，默认 ["duckduckgo","bing"]。可选：${ENGINE_NAMES.join(', ')}。` },
      limit: { type: 'integer', description: '每引擎最多取几条（默认 10）。' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    timeoutMs: 150000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const query = String(args?.query ?? '').trim()
      if (query.length === 0) return 'karing_search：query 不能为空。'
      const runtime = readRuntime(cfg.statePath)
      const alive = await coreAlive(cfg)
      const proxy = alive !== undefined ? `http://127.0.0.1:${alive.ports.rule ?? alive.ports.proxy}` : currentProxy(cfg, runtime)
      const engines = Array.isArray(args?.engines) && args.engines.length > 0
        ? args.engines.filter((e) => ENGINE_NAMES.includes(e))
        : DEFAULT_ENGINES
      const limit = Number.isSafeInteger(args?.limit) ? Math.min(Math.max(args.limit, 1), 30) : 10
      const res = await multiEngineSearch(query, { engines, proxy, signal: exec?.signal })
      const head = [
        `karing_search "${query}"`,
        `引擎：${res.engines.map((e) => `${ENGINES[e].label}(${ENGINES[e].region === 'foreign' ? '代理' : '直连'})`).join(' + ')}`,
        `代理：${proxy ?? '未使用（内核未运行，引擎会自行降级直连）'}`,
        `去重后 ${res.dedupedCount} 条`,
        '',
        '各引擎：' + res.perEngine.map((r) => `${r.label}: ${r.ok ? `✅ ${r.results.length} 条（${relevanceOf(r.results, query)} 相关）${r.ms}ms via ${r.via}` : `❌ ${r.error ?? `HTTP ${r.status}`}`}`).join(' ｜ '),
        res.merged.length > 0 && relevanceOf(res.merged, query) === 0
          ? `⚠️ 去重后 ${res.merged.length} 条里没有一条命中核心词 —— 出口 IP 可能被引擎投毒，建议 karing_nodes action=auto 换节点后重试`
          : '',
        '',
      ].join('\n')
      const body = res.merged.slice(0, limit * engines.length).map((r, i) => [
        `${i + 1}. [${r.engine}] ${r.title}`,
        `   ${r.url}`,
        r.snippet.length > 0 ? `   ${r.snippet.slice(0, 200)}` : '',
      ].filter((x) => x.length > 0).join('\n')).join('\n\n')
      return `${head}${body.length === 0 ? '（无结果：换关键词、换引擎，或先 karing_start 把代理起来）' : body}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'karing_fetch',
    description: '经 Karing 代理抓取网页并转成纯文本（自动跟随跳转、自动解 gzip/br），用于资料搜集与归档。',
    parameters: {
      url: { type: 'string', required: true, description: '目标网址（http/https）。' },
      maxChars: { type: 'integer', description: '返回正文的最大字符数（默认 6000，上限 200000）。' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const url = String(args?.url ?? '').trim()
      if (!/^https?:\/\//i.test(url)) return 'karing_fetch：url 必须是 http/https 开头。'
      const runtime = readRuntime(cfg.statePath)
      const alive = await coreAlive(cfg)
      const proxy = alive !== undefined ? `http://127.0.0.1:${alive.ports.rule ?? alive.ports.proxy}` : currentProxy(cfg, runtime)
      const maxChars = Number.isSafeInteger(args?.maxChars) ? Math.min(Math.max(args.maxChars, 500), 200000) : 6000
      try {
        const page = await fetchPage(url, { proxy, signal: exec?.signal, maxChars: 200000 })
        return [
          `karing_fetch ${page.url}`,
          `HTTP ${page.status} ｜ 原始 ${page.bytes} 字节 ｜ 标题：${page.title || '(无)'} ｜ 正文 ${page.text.length} 字`,
          `代理：${proxy ?? '未使用（直连）'}`,
          '',
          page.text.slice(0, maxChars),
          page.text.length > maxChars ? `\n…（还有 ${page.text.length - maxChars} 字，可提高 maxChars 再取）` : '',
        ].join('\n')
      } catch (error) {
        return `karing_fetch 失败（${url}）：${String(error?.message ?? error).slice(0, 200)}`
      }
    },
  }))
}
