/**
 * @local/dsh-hiddify —— 单独调用 Hiddify 的 DSH 插件（宿主侧）。
 *
 * 注册七个模型可用工具：
 *   · hiddify_status —— 状态总览：内核进程 / 监听端口 / 分流模式 / 系统代理 / 节点 / 三路连通性实测
 *   · hiddify_start  —— 启动内核（可指定分流模式、端口、是否开系统代理、是否保内网直连）
 *   · hiddify_stop   —— 停止内核（可选择是否保留系统代理）
 *   · hiddify_mode   —— 切换分流模式：global（全走代理）/ cn-bypass（国内直连）/ direct（全直连）
 *   · hiddify_nodes  —— 列节点 / 切换节点 / 测延迟（走内核的 Clash REST 控制面）
 *   · hiddify_search —— 经代理的多引擎检索（DuckDuckGo / Bing / 百度 / 360 / 搜狗 …）
 *   · hiddify_fetch  —— 经代理抓正文（HTML→文本），供资料搜集与归档
 *
 * 设计要点：
 *   · 不依赖 Hiddify 桌面 GUI，直接驱动 HiddifyCli.exe（实测 standalone 可跑）；
 *   · 不依赖 `-d` 设置文件（实测字段名不对应、只有 Region 生效）——改为 build 后直接改写 sing-box JSON，
 *     分流规则完全显式可审计；
 *   · 内网直连靠 route.rules 里的私有网段 ip_cidr → direct + 系统代理绕过白名单，双保险；
 *   · 网络层零依赖（node:http/https/tls 手写 CONNECT 隧道），Node 内置 fetch 不认代理这点已实测确认。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MODES, hiddifyPaths, resolveProfile, readProfiles, buildConfig, spawnCore, isAlive, killTree,
  readRuntime, writeRuntime, clearRuntime, clashApi, readLiveClash, LAN_CIDRS,
} from './core.js'
import { systemProxyStatus, systemProxyOn, systemProxyOff, probeAll, tcpProbe } from './net.js'
import { multiEngineSearch, fetchPage, ENGINE_NAMES, FOREIGN_ENGINES, DOMESTIC_ENGINES, ENGINES } from './search.js'

const { defineTool } = await import('@deepseek-ai/dsh-tools')
  .catch(() => ({ defineTool: (definition) => definition }))
const schemastery = await import('@deepseek-ai/schemastery').catch(() => ({ default: undefined }))
const z = schemastery.default

/** Cordis 插件名。 */
export const name = 'dsh-hiddify'

/** 需要 tools 服务来注册工具。 */
export const inject = ['tools']

/** 插件配置（profile 里该行的 config 按此校验）。 */
export const Config = z === undefined
  ? undefined
  : z.object({
      cliPath: z.string().default('E:\\Hiddify\\HiddifyCli.exe'),
      workDir: z.string().default('E:\\Hiddify'),
      profilePath: z.string().default(''),
      port: z.number().default(12399),
      clashPort: z.number().default(6756),
      mode: z.string().default('cn-bypass'),
      lanDirect: z.boolean().default(true),
      systemProxy: z.boolean().default(false),
      dataDir: z.string().default(''),
    })

const PLUGIN_ROOT = dirname(fileURLToPath(new URL('.', import.meta.url)))

function normalizeConfig(raw) {
  const c = raw ?? {}
  const cliPath = typeof c.cliPath === 'string' && c.cliPath.length > 0 ? c.cliPath : 'E:\\Hiddify\\HiddifyCli.exe'
  const workDir = typeof c.workDir === 'string' && c.workDir.length > 0 ? c.workDir : dirname(cliPath)
  const dataDir = typeof c.dataDir === 'string' && c.dataDir.length > 0 ? c.dataDir : join(PLUGIN_ROOT, 'data')
  return {
    cliPath,
    workDir,
    profilePath: typeof c.profilePath === 'string' ? c.profilePath : '',
    port: Number.isSafeInteger(c.port) && c.port > 0 ? c.port : 12399,
    clashPort: Number.isSafeInteger(c.clashPort) && c.clashPort > 0 ? c.clashPort : 6756,
    mode: MODES.includes(c.mode) ? c.mode : 'cn-bypass',
    lanDirect: c.lanDirect !== false,
    systemProxy: c.systemProxy === true,
    dataDir,
    statePath: join(dataDir, 'runtime.json'),
  }
}

const MODE_DOC = {
  global: '全部流量走代理（仅内网直连）——外网最省心，国内站点会绕一圈',
  'cn-bypass': '国内直连 + 国外走代理（推荐）——.cn 域名与 geoip-cn/geosite-cn 命中直连',
  direct: '全部直连，只保留本地代理端口——用于临时关闭翻墙、只做本机端口转发',
}

/** 当前生效的代理地址（供 search / fetch 用）。 */
function currentProxy(cfg, runtime) {
  if (runtime !== undefined && isAlive(runtime.pid)) return `http://127.0.0.1:${runtime.port}`
  return undefined
}

/** 启动内核的完整流程（供 start / mode 复用）。 */
async function startCore(cfg, { mode, port, systemProxy, lanDirect, profilePath, clashPort, dnsPort }) {
  const paths = hiddifyPaths(cfg.cliPath, cfg.workDir)
  if (!existsSync(paths.cliPath)) {
    return { ok: false, error: `找不到 HiddifyCli.exe：${paths.cliPath}（请在插件配置里改 cliPath）` }
  }
  const profile = resolveProfile(paths, profilePath.length > 0 ? profilePath : cfg.profilePath)
  if (profile === undefined) {
    return { ok: false, error: `找不到订阅配置：${paths.configsDir} 为空且无 current-config.json。请先在 Hiddify 客户端里添加订阅。` }
  }

  // 已有实例先停（同一端口不能起两个）
  const old = readRuntime(cfg.statePath)
  if (old !== undefined && isAlive(old.pid)) {
    await killTree(old.pid)
    await new Promise((r) => setTimeout(r, 800))
  }

  mkdirSync(cfg.dataDir, { recursive: true })
  const outPath = join(cfg.dataDir, `config-${mode}.json`)
  const built = await buildConfig({
    cliPath: paths.cliPath,
    workDir: paths.workDir,
    profilePath: profile.path,
    outPath,
    mode,
    lanDirect,
    port,
    dnsPort: dnsPort ?? (port + 51),
    clashPort,
    clashSecret: '',
  })
  if (!built.ok) return { ok: false, error: built.error }

  const logPath = join(cfg.dataDir, 'core.log')
  const pid = spawnCore({ cliPath: paths.cliPath, workDir: paths.workDir, configPath: built.configPath, logPath })

  // 等端口起来（最多 ~25s）；端口被占等瞬时失败时重试一次
  let listening = false
  for (let i = 0; i < 25; i += 1) {
    await new Promise((r) => setTimeout(r, 1000))
    const probe = await tcpProbe('127.0.0.1', port, 1500)
    if (probe.ok) { listening = true; break }
    if (!isAlive(pid)) break
  }
  if (!listening) {
    await killTree(pid)
    await new Promise((r) => setTimeout(r, 1500))
    const retryPid = spawnCore({ cliPath: paths.cliPath, workDir: paths.workDir, configPath: built.configPath, logPath })
    for (let i = 0; i < 25; i += 1) {
      await new Promise((r) => setTimeout(r, 1000))
      const probe = await tcpProbe('127.0.0.1', port, 1500)
      if (probe.ok) { listening = true; break }
      if (!isAlive(retryPid)) break
    }
    if (!listening) {
      return { ok: false, error: `内核启动后 ${port} 端口未监听（首次 pid=${pid}、重试 pid=${retryPid}；日志 ${logPath}）——常见原因是端口被桌面版 Hiddify 占用` }
    }
    return await finalizeStart({ cfg, paths, profile, built, port, mode, lanDirect, systemProxy, logPath, pid: retryPid, clashPort })
  }
  return await finalizeStart({ cfg, paths, profile, built, port, mode, lanDirect, systemProxy, logPath, pid, clashPort })
}

/** 端口就绪后的收尾：读 live clash 密钥、写状态、开系统代理。 */
async function finalizeStart({ cfg, paths, profile, built, port, mode, lanDirect, systemProxy, logPath, pid, clashPort }) {
  const live = readLiveClash(paths)
  const runtime = {
    pid,
    port,
    clashPort: live?.port ?? clashPort,
    clashSecret: live?.secret ?? '',
    mode,
    lanDirect,
    profile: profile.path,
    configPath: built.configPath,
    startedAt: new Date().toISOString(),
    systemProxy: false,
  }
  if (systemProxy) {
    const sp = await systemProxyOn(port)
    runtime.systemProxy = sp.ok
  }
  writeRuntime(cfg.statePath, runtime)
  return { ok: true, runtime, paths, profile, built, logPath }
}

/** 把一次探测结果渲染成紧凑文本。 */
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

/** 注册工具。 */
export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig)

  ctx.tools.register(defineTool({
    name: 'hiddify_status',
    description: [
      '查看 Hiddify 代理的完整状态：内核进程与 PID、本地代理端口、当前分流模式、系统代理开关、',
      '可用节点与当前选中节点，并**实测**外网（经代理）/ 国内（直连）/ 内网（网关）三路连通性。',
      '排障、确认「外网与内网是否同时可用」时先跑这个。',
    ].join(''),
    parameters: {
      probe: { type: 'boolean', description: '是否做连通性实测（默认 true，约 5-20 秒）。' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    timeoutMs: 90000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const paths = hiddifyPaths(cfg.cliPath, cfg.workDir)
      const runtime = readRuntime(cfg.statePath)
      const alive = runtime !== undefined && isAlive(runtime.pid)
      const proxy = currentProxy(cfg, runtime)
      const sp = await systemProxyStatus()
      const profile = resolveProfile(paths, cfg.profilePath)
      const profiles = readProfiles(paths)
      const lines = [
        '【Hiddify 状态】',
        `内核进程：${alive ? `✅ 运行中 pid=${runtime.pid}（模式 ${runtime.mode}${runtime.lanDirect ? ' + 内网直连' : ''}）` : '❌ 未运行（插件未启动过或已退出）'}`,
        `代理端口：${proxy ?? `—（配置默认 ${cfg.port}）`}`,
        `CLI：${paths.cliPath} ${existsSync(paths.cliPath) ? '✅' : '❌ 不存在'}`,
        `订阅配置：${profile === undefined ? '❌ 未找到' : `${profile.path}（来源 ${profile.source}，mtime ${profile.mtime}）`}`,
        `订阅条目：${profiles.length === 0 ? '—（db.sqlite 未解析到）' : profiles.map((p) => `${p.name}${p.active ? '★当前' : ''}`).join('、')}`,
        `系统代理：${sp.ok ? `${sp.enabled ? '✅ 开' : '⛔ 关'} ${sp.server ?? ''}` : `读取失败 ${sp.error ?? ''}`}`,
        `  绕过白名单：${sp.override === undefined ? '—' : `${sp.override.split(';').length} 条（含内网段：${/192\.168\.\*/.test(sp.override) ? '✅' : '❌'}）`}`,
        `内网直连网段：${LAN_CIDRS.slice(0, 6).join(', ')} …`,
      ]
      if (args?.probe !== false && alive) {
        const probe = await probeAll({ proxy, port: runtime.port, signal: exec?.signal })
        lines.push('', '【三路连通性实测】', renderProbe(probe))
      } else if (args?.probe !== false) {
        lines.push('', '【三路连通性实测】跳过：内核未运行（用 hiddify_start 启动）')
      }
      return lines.join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'hiddify_start',
    description: [
      '单独启动 Hiddify 内核（不打开桌面 GUI）。默认用 cn-bypass 模式：国外走代理、国内与内网直连。',
      `可用模式：${MODES.map((m) => `${m}（${MODE_DOC[m]}）`).join('；')}。`,
      'systemProxy=true 会同时把 Windows 系统代理指向该端口（注册表 HKCU，ProxyEnable 改 0 即回滚）。',
    ].join(''),
    parameters: {
      mode: { type: 'string', description: `分流模式：${MODES.join(' / ')}（默认 ${cfg.mode}）。` },
      port: { type: 'integer', description: `本地混合代理端口（默认 ${cfg.port}）。` },
      systemProxy: { type: 'boolean', description: '是否同时打开 Windows 系统代理（默认 false，只起本地端口）。' },
      lanDirect: { type: 'boolean', description: '是否保内网直连（默认 true；关闭后内网也会被代理，通常不需要关）。' },
      profilePath: { type: 'string', description: '指定订阅配置 json 路径（默认自动取最新）。' },
      clashPort: { type: 'integer', description: `Clash REST 控制面端口（默认 ${cfg.clashPort}）。` },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    timeoutMs: 180000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const mode = MODES.includes(args?.mode) ? args.mode : cfg.mode
      const port = Number.isSafeInteger(args?.port) && args.port > 0 ? args.port : cfg.port
      const clashPort = Number.isSafeInteger(args?.clashPort) && args.clashPort > 0 ? args.clashPort : cfg.clashPort
      const systemProxy = args?.systemProxy === true || (args?.systemProxy === undefined && cfg.systemProxy)
      const lanDirect = args?.lanDirect !== false && cfg.lanDirect
      const profilePath = typeof args?.profilePath === 'string' ? args.profilePath : ''

      const res = await startCore(cfg, { mode, port, systemProxy, lanDirect, profilePath, clashPort })
      if (!res.ok) return `hiddify_start 失败：${res.error}`
      const probe = await probeAll({ proxy: `http://127.0.0.1:${port}`, port, signal: exec?.signal })
      return [
        '✅ Hiddify 内核已启动（standalone，不依赖 GUI）',
        `pid=${res.runtime.pid} ｜ 代理 http://127.0.0.1:${port} ｜ 模式 ${mode}（${MODE_DOC[mode]}）`,
        `内网直连：${lanDirect ? '开' : '关'} ｜ 系统代理：${res.runtime.systemProxy ? '已开' : '未开'}`,
        `Clash 控制面：127.0.0.1:${res.runtime.clashPort} ｜ 节点数：${res.built.nodeCount}`,
        `配置：${res.built.configPath}`,
        '',
        '【三路连通性实测】', renderProbe(probe),
      ].join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'hiddify_stop',
    description: '停止 Hiddify 内核进程。keepSystemProxy=false（默认）时同时关闭 Windows 系统代理，避免系统代理指向一个已死端口。',
    parameters: {
      keepSystemProxy: { type: 'boolean', description: '是否保留系统代理设置（默认 false = 一起关掉）。' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const runtime = readRuntime(cfg.statePath)
      if (runtime === undefined) return 'hiddify_stop：没有插件启动记录（runtime.json 不存在），无需操作。'
      if (!isAlive(runtime.pid)) {
        clearRuntime(cfg.statePath)
        return `hiddify_stop：pid=${runtime.pid} 已不在运行，已清理状态文件。`
      }
      const killed = await killTree(runtime.pid)
      await new Promise((r) => setTimeout(r, 500))
      const stillAlive = isAlive(runtime.pid)
      clearRuntime(cfg.statePath)
      const lines = [`${stillAlive ? '⚠️ 进程仍在' : '✅ 已停止'} pid=${runtime.pid}`, `taskkill: ${killed.output.slice(0, 120)}`]
      if (args?.keepSystemProxy !== true) {
        const off = await systemProxyOff()
        lines.push(`系统代理：${off.ok ? '✅ 已关闭（ProxyEnable=0）' : `⚠️ 关闭失败 ${off.error ?? ''}`}`)
      } else {
        lines.push('系统代理：按参数保留（注意：端口已无监听，走系统代理的应用会连不上）')
      }
      return lines.join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'hiddify_mode',
    description: [
      '切换分流模式并立即生效（重建配置 + 重启内核，约 5-25 秒）。',
      MODES.map((m) => `${m}：${MODE_DOC[m]}`).join('\n'),
      '\n「自由控制电脑可同时连接外网与内网」就靠这里：cn-bypass 让国内/内网直连、国外走代理；',
      'global 让全部外网流量走代理但内网仍直连；direct 全直连。',
    ].join(''),
    parameters: {
      mode: { type: 'string', required: true, description: `目标模式：${MODES.join(' / ')}。` },
      systemProxy: { type: 'boolean', description: '同时调整系统代理开关（不传则保持现状）。' },
      lanDirect: { type: 'boolean', description: '是否保内网直连（默认 true）。' },
      port: { type: 'integer', description: `本地混合代理端口（默认沿用 ${cfg.port}）。` },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    timeoutMs: 180000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const mode = String(args?.mode ?? '')
      if (!MODES.includes(mode)) return `hiddify_mode：mode 必须是 ${MODES.join(' / ')} 之一。`
      const runtime = readRuntime(cfg.statePath)
      const port = Number.isSafeInteger(args?.port) && args.port > 0 ? args.port : (runtime?.port ?? cfg.port)
      const lanDirect = args?.lanDirect !== false && cfg.lanDirect
      const systemProxy = typeof args?.systemProxy === 'boolean' ? args.systemProxy : (runtime?.systemProxy ?? cfg.systemProxy)

      const res = await startCore(cfg, { mode, port, systemProxy, lanDirect, profilePath: cfg.profilePath, clashPort: runtime?.clashPort ?? cfg.clashPort })
      if (!res.ok) return `hiddify_mode 失败：${res.error}`
      if (systemProxy === false) await systemProxyOff()
      const probe = await probeAll({ proxy: `http://127.0.0.1:${port}`, port, signal: exec?.signal })
      return [
        `✅ 已切到 ${mode}：${MODE_DOC[mode]}`,
        `pid=${res.runtime.pid} ｜ 代理 http://127.0.0.1:${port} ｜ 内网直连 ${lanDirect ? '开' : '关'} ｜ 系统代理 ${res.runtime.systemProxy ? '开' : '关'}`,
        '',
        '【切换后三路连通性实测】', renderProbe(probe),
      ].join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'hiddify_nodes',
    description: [
      '查看 / 切换代理节点（走内核的 Clash REST 控制面，无需重启）。',
      'action=list 列出所有节点与当前选中；action=select 切到指定节点名；action=auto 切回自动测速；',
      'action=delay 对候选节点测延迟（并发，可能较慢）。',
    ].join(''),
    parameters: {
      action: { type: 'string', description: 'list（默认）/ select / auto / delay。' },
      node: { type: 'string', description: 'action=select 时的节点名（先用 list 拿到准确名称）。' },
      limit: { type: 'integer', description: 'delay 时最多测几个节点（默认 8）。' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const runtime = readRuntime(cfg.statePath)
      if (runtime === undefined || !isAlive(runtime.pid)) return 'hiddify_nodes：内核未运行，先用 hiddify_start 启动。'
      const api = { port: runtime.clashPort, secret: runtime.clashSecret }
      const action = String(args?.action ?? 'list')
      const list = await clashApi({ ...api, path: '/proxies' })
      if (!list.ok) return `hiddify_nodes：控制面不可用（HTTP ${list.status}${list.error !== undefined ? ` ${list.error}` : ''}）。`
      const proxies = list.json?.proxies ?? {}
      const selector = Object.entries(proxies).find(([, v]) => v.type === 'Selector')
      if (selector === undefined) return 'hiddify_nodes：配置里没有 Selector 组。'
      const [selName, sel] = selector
      const nodes = (sel.all ?? []).filter((n) => n !== 'auto')

      if (action === 'select') {
        const target = String(args?.node ?? '')
        if (!(sel.all ?? []).includes(target)) return `hiddify_nodes：节点名 "${target}" 不在候选列表里。用 action=list 看准确名称。`
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
          const r = await clashApi({ ...api, path: `/proxies/${encodeURIComponent(n)}/delay?timeout=5000&url=http://cp.cloudflare.com/`, timeoutMs: 12000 })
          return `${r.ok ? '✅' : '❌'} ${n} ${r.json?.delay !== undefined ? `${r.json.delay}ms` : `(${r.status})`}`
        }))
        return [`当前：${selName} → ${sel.now}`, '', ...results].join('\n')
      }
      return [
        `选择器 ${selName} ｜ 当前：${sel.now} ｜ 候选 ${nodes.length} 个`,
        '',
        ...nodes.map((n) => `${n === sel.now ? '▶' : ' '} ${n}`),
      ].join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'hiddify_search',
    description: [
      '经 Hiddify 代理调用多种搜索引擎检索（外网走代理，国内引擎直连），返回标题 / 链接 / 摘要，跨引擎按 URL 去重。',
      `外网引擎：${FOREIGN_ENGINES.join(' / ')}（实测可用：duckduckgo、ddg-lite、bing）。`,
      `国内引擎：${DOMESTIC_ENGINES.join(' / ')}。`,
      '搜中文专业术语（命理/古籍/术数等）建议加引号精确匹配，如 "铁板神数" 皇极经世。',
    ].join(''),
    parameters: {
      query: { type: 'string', required: true, description: '检索词。建议用引号做精确匹配。' },
      engines: { type: 'array', items: { type: 'string' }, description: `引擎列表，默认 ["duckduckgo","bing"]。可选：${ENGINE_NAMES.join(', ')}。` },
      limit: { type: 'integer', description: '每引擎最多取几条（默认 10）。' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const query = String(args?.query ?? '').trim()
      if (query.length === 0) return 'hiddify_search：query 不能为空。'
      const runtime = readRuntime(cfg.statePath)
      const proxy = currentProxy(cfg, runtime)
      const engines = Array.isArray(args?.engines) && args.engines.length > 0
        ? args.engines.filter((e) => ENGINE_NAMES.includes(e))
        : ['duckduckgo', 'bing']
      const limit = Number.isSafeInteger(args?.limit) ? Math.min(Math.max(args.limit, 1), 30) : 10
      const res = await multiEngineSearch(query, { engines, proxy, signal: exec?.signal })
      const head = [
        `hiddify_search "${query}"`,
        `引擎：${res.engines.map((e) => `${ENGINES[e].label}(${ENGINES[e].region === 'foreign' ? '代理' : '直连'})`).join(' + ')}`,
        `代理：${proxy ?? '未使用（内核未运行，国内引擎仍直连可用）'}`,
        `去重后 ${res.dedupedCount} 条`,
        '',
        '各引擎：' + res.perEngine.map((r) => `${r.label}: ${r.ok ? `✅ ${r.results.length} 条 ${r.ms}ms` : `❌ ${r.error ?? `HTTP ${r.status}`}`}`).join(' ｜ '),
        '',
      ].join('\n')
      const body = res.merged.slice(0, limit * engines.length).map((r, i) => [
        `${i + 1}. [${r.engine}] ${r.title}`,
        `   ${r.url}`,
        r.snippet.length > 0 ? `   ${r.snippet.slice(0, 200)}` : '',
      ].filter((x) => x.length > 0).join('\n')).join('\n\n')
      return `${head}${body.length === 0 ? '（无结果：换关键词、换引擎，或先 hiddify_start 把代理起来）' : body}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'hiddify_fetch',
    description: [
      '经 Hiddify 代理抓取网页并转成纯文本（自动跟随跳转、自动解 gzip/br），用于资料搜集与归档。',
      '返回状态码、标题、正文字数与前若干字符；正文很长时可分段再取。',
    ].join(''),
    parameters: {
      url: { type: 'string', required: true, description: '目标网址（http/https）。' },
      maxChars: { type: 'integer', description: '返回正文的最大字符数（默认 6000，上限 200000）。' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const url = String(args?.url ?? '').trim()
      if (!/^https?:\/\//i.test(url)) return 'hiddify_fetch：url 必须是 http/https 开头。'
      const runtime = readRuntime(cfg.statePath)
      const proxy = currentProxy(cfg, runtime)
      const maxChars = Number.isSafeInteger(args?.maxChars) ? Math.min(Math.max(args.maxChars, 500), 200000) : 6000
      try {
        const page = await fetchPage(url, { proxy, signal: exec?.signal, maxChars: 200000 })
        return [
          `hiddify_fetch ${page.url}`,
          `HTTP ${page.status} ｜ 原始 ${page.bytes} 字节 ｜ 标题：${page.title || '(无)'} ｜ 正文 ${page.text.length} 字`,
          `代理：${proxy ?? '未使用（直连）'}`,
          '',
          page.text.slice(0, maxChars),
          page.text.length > maxChars ? `\n…（还有 ${page.text.length - maxChars} 字，可提高 maxChars 再取）` : '',
        ].join('\n')
      } catch (error) {
        return `hiddify_fetch 失败（${url}）：${String(error?.message ?? error).slice(0, 200)}`
      }
    },
  }))
}
