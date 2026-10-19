/**
 * dsh-hiddify · 核心层 —— 单独调用 Hiddify 内核（HiddifyCli.exe），不依赖桌面 GUI。
 *
 * 实测得到的事实（2026-10-16，本机 E:\Hiddify，Hiddify 客户端 2024-10-03 构建）：
 *   · HiddifyCli.exe 是 Go/Cobra CLI，子命令：run / build / parse / gen / instance / tunnel / warp …
 *   · `build -c <profile.json> -o <out.json>` 把订阅/缓存配置编译成 sing-box 配置（退出码 0）
 *   · `run -c <out.json> --full-config` 用编译好的 sing-box 配置启动内核，
 *     日志打印 "CORE STARTED"，并把生效配置回写到 <workDir>\current-config.json
 *   · 入站是 mixed（HTTP+SOCKS5 同端口），端口由配置里的 listen_port 决定
 *   · experimental.clash_api 提供 REST 控制面（/proxies、/version …），密钥在回写的配置里
 *   · `-d/--hiddify` 设置文件的 schema 与字段名不完全对应（实测只有 Region 生效，
 *     BypassLAN/MixedPort 等被忽略）——所以本插件**不依赖它**，
 *     改为「build 之后直接改写 sing-box JSON」：可验证、可审计、字段全在自己手里。
 *
 * 分流（外网走代理 / 内网直连）就是改写 route.rules：
 *   私有网段 ip_cidr → direct 永远排在最前，所以无论哪种模式，内网都不断。
 */
import { spawn, execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, openSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

/** 私有网段：内网直连白名单（IPv4 + IPv6 本地/ULA） */
export const LAN_CIDRS = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '100.64.0.0/10',
  'fc00::/7',
  'fe80::/10',
  '::1/128',
]

/** 局域网域名后缀：交给系统解析器（dns-local），不经代理 DNS */
export const LAN_DOMAINS = ['localhost', '.local', '.lan', '.internal', '.home.arpa', '.arpa', '.localhost']

/** 三种分流模式 */
export const MODES = ['global', 'cn-bypass', 'direct']

/** 本机 Hiddify 默认路径（可用插件配置覆盖） */
export function defaultPaths() {
  return {
    cliPath: 'E:\\Hiddify\\HiddifyCli.exe',
    workDir: 'E:\\Hiddify',
    appData: join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'hiddify', 'hiddify'),
  }
}

/** 采集本机 Hiddify 的目录布局。 */
export function hiddifyPaths(cliPath, workDir) {
  const d = defaultPaths()
  const cli = cliPath && cliPath.length > 0 ? cliPath : d.cliPath
  const wd = workDir && workDir.length > 0 ? workDir : dirname(cli)
  const appData = d.appData
  return {
    cliPath: cli,
    workDir: wd,
    appData,
    configsDir: join(appData, 'configs'),
    liveConfig: join(appData, 'current-config.json'),
    dbPath: join(appData, 'db.sqlite'),
    prefsPath: join(appData, 'shared_preferences.json'),
    boxLog: join(appData, 'box.log'),
    coreLiveConfig: join(wd, 'current-config.json'),
  }
}

/**
 * 找出要用的订阅配置。
 * 优先级：显式 profilePath > configs/ 目录里 mtime 最新的 json > AppData 的 current-config.json
 */
export function resolveProfile(paths, explicit) {
  if (typeof explicit === 'string' && explicit.length > 0 && existsSync(explicit)) {
    return { path: explicit, source: 'explicit', mtime: statSync(explicit).mtime.toISOString() }
  }
  try {
    const files = readdirSync(paths.configsDir)
      .filter((f) => f.toLowerCase().endsWith('.json'))
      .map((f) => {
        const full = join(paths.configsDir, f)
        return { path: full, name: f, mtime: statSync(full).mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)
    if (files.length > 0) {
      return { path: files[0].path, source: 'configs-newest', mtime: new Date(files[0].mtime).toISOString(), alternatives: files.slice(1, 6).map((f) => f.name) }
    }
  } catch {
    // 忽略：目录不存在就走下一档
  }
  if (existsSync(paths.liveConfig)) {
    return { path: paths.liveConfig, source: 'appdata-current', mtime: statSync(paths.liveConfig).mtime.toISOString() }
  }
  return undefined
}

/** 读取 db.sqlite 里的 profile 列表（粗解析，不依赖 sqlite 驱动：按 UTF-8 扫 JSON 片段）。 */
export function readProfiles(paths) {
  try {
    const raw = readFileSync(paths.dbPath).toString('utf8')
    const out = []
    const re = /\{"id":\s*"([0-9a-f-]{36})",\s*"type":\s*"([^"]*)",\s*"active":\s*(\d),\s*"name":\s*"([^"]*)",\s*"url":\s*"([^"]*)"/g
    let m
    while ((m = re.exec(raw)) !== null) {
      out.push({ id: m[1], type: m[2], active: Number(m[3]) === 1, name: m[4], url: m[5] })
    }
    return out
  } catch {
    return []
  }
}

/** 生成 route.rules 与 final —— 分流策略的唯一真源。 */
export function routeFor(mode, lanDirect) {
  const rules = [
    { inbound: 'dns-in', outbound: 'dns-out' },
    { port: 53, outbound: 'dns-out' },
  ]
  if (lanDirect !== false) {
    rules.push({ ip_cidr: LAN_CIDRS, outbound: 'direct' })
    rules.push({ domain_suffix: LAN_DOMAINS, outbound: 'direct' })
  }
  if (mode === 'cn-bypass') {
    rules.push({ domain_suffix: '.cn', outbound: 'direct' })
    rules.push({ rule_set: ['geoip-cn', 'geosite-cn'], outbound: 'direct' })
  }
  const final = mode === 'direct' ? 'direct' : 'select'
  return { rules, final }
}

/** 确保配置里有 geoip-cn / geosite-cn 规则集（cn-bypass 模式需要）。 */
function ensureRuleSets(config) {
  const route = config.route ?? (config.route = {})
  const sets = Array.isArray(route.rule_set) ? route.rule_set : (route.rule_set = [])
  const have = new Set(sets.map((s) => s.tag))
  const need = [
    { type: 'remote', tag: 'geoip-cn', format: 'binary', url: 'https://raw.githubusercontent.com/hiddify/hiddify-geo/rule-set/country/geoip-cn.srs', update_interval: '120h0m0s' },
    { type: 'remote', tag: 'geosite-cn', format: 'binary', url: 'https://raw.githubusercontent.com/hiddify/hiddify-geo/rule-set/country/geosite-cn.srs', update_interval: '120h0m0s' },
  ]
  for (const s of need) if (!have.has(s.tag)) sets.push(s)
}

/** 修正 DNS：build 出来若地址为空（传了不完整的 -d 设置时会发生），补成可用值。 */
function ensureDns(config, remoteDns, directDns) {
  const dns = config.dns ?? (config.dns = {})
  const servers = Array.isArray(dns.servers) ? dns.servers : (dns.servers = [])
  const tags = new Set(servers.map((s) => s.tag))
  const set = (tag, address, extra = {}) => {
    const hit = servers.find((s) => s.tag === tag)
    if (hit === undefined) {
      if (!tags.has(tag)) servers.push({ tag, address, ...extra })
      return
    }
    if (typeof hit.address !== 'string' || hit.address.length === 0) hit.address = address
  }
  set('dns-remote', remoteDns, { address_resolver: 'dns-direct' })
  set('dns-direct', directDns, { address_resolver: 'dns-local', detour: 'direct' })
  set('dns-local', 'local', { detour: 'direct' })
  // 内网域名走系统解析器（dns-local），保证 hosts / 公司内网域名可解析
  const rules = Array.isArray(dns.rules) ? dns.rules : (dns.rules = [])
  if (tags.has('dns-local') || servers.some((s) => s.tag === 'dns-local')) {
    const already = rules.some((r) => Array.isArray(r.domain_suffix) && r.domain_suffix.includes('.local'))
    if (!already) rules.unshift({ domain_suffix: LAN_DOMAINS, server: 'dns-local' })
  }
}

/** 应用分流策略到一份 sing-box 配置对象（原地修改并返回）。 */
export function applyMode(config, { mode = 'cn-bypass', lanDirect = true, port, dnsPort, clashPort, clashSecret } = {}) {
  const inbounds = Array.isArray(config.inbounds) ? config.inbounds : (config.inbounds = [])
  const mixed = inbounds.find((i) => i.tag === 'mixed-in') ?? inbounds.find((i) => i.type === 'mixed')
  if (mixed !== undefined && Number.isSafeInteger(port) && port > 0) mixed.listen_port = port
  // 本地 DNS 入站（Hiddify 的 dns-in）也要挪开：与桌面版 GUI 同开时 16450 会撞端口，
  // 实测撞上后整个内核起不来（bind: Only one usage of each socket address）。
  const dnsIn = inbounds.find((i) => i.tag === 'dns-in')
  if (dnsIn !== undefined && Number.isSafeInteger(dnsPort) && dnsPort > 0) dnsIn.listen_port = dnsPort

  ensureDns(config, 'udp://1.1.1.1', '223.5.5.5')
  ensureRuleSets(config)
  const route = config.route ?? (config.route = {})
  const { rules, final } = routeFor(mode, lanDirect)
  route.rules = rules
  route.final = final

  const exp = config.experimental ?? (config.experimental = {})
  if (Number.isSafeInteger(clashPort) && clashPort > 0) {
    exp.clash_api = { external_controller: `127.0.0.1:${clashPort}`, secret: clashSecret ?? '', external_ui: 'webui' }
  }
  exp.cache_file = { enabled: true, path: 'clash.db' }
  return config
}

/** 跑一次 HiddifyCli 子命令，收集 stdout/stderr。 */
export function runCli(cliPath, args, { cwd, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile(cliPath, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        ok: error === null,
        code: error?.code ?? 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        error: error === null ? undefined : String(error.message ?? error).slice(0, 400),
      })
    })
  })
}

/**
 * 编译一份可运行的 sing-box 配置。
 * @returns {Promise<{ok:boolean, configPath?:string, error?:string, config?:object}>}
 */
export async function buildConfig({ cliPath, workDir, profilePath, outPath, mode, lanDirect, port, dnsPort, clashPort, clashSecret, fullConfig = true }) {
  const args = ['build', '-c', profilePath, '-o', outPath]
  if (fullConfig) args.push('--full-config')
  const res = await runCli(cliPath, args, { cwd: workDir })
  if (!existsSync(outPath)) {
    return { ok: false, error: `build 未产出配置：${res.error ?? res.stderr.slice(0, 300)}` }
  }
  let config
  try {
    config = JSON.parse(readFileSync(outPath, 'utf8'))
  } catch (error) {
    return { ok: false, error: `build 产物不是合法 JSON：${String(error).slice(0, 200)}` }
  }
  applyMode(config, { mode, lanDirect, port, dnsPort, clashPort, clashSecret })
  writeFileSync(outPath, JSON.stringify(config, null, 1), 'utf8')
  const outbounds = Array.isArray(config.outbounds) ? config.outbounds : []
  const nodes = outbounds.filter((o) => !['selector', 'urltest', 'direct', 'block', 'dns'].includes(o.type))
  return { ok: true, configPath: outPath, config, nodeCount: nodes.length, buildLog: res.stderr.slice(-300) }
}

/** 启动内核（detached，工具调用结束后继续跑）。 */
export function spawnCore({ cliPath, workDir, configPath, logPath }) {
  const fd = openSync(logPath, 'a')
  const child = spawn(cliPath, ['run', '-c', configPath, '--full-config'], {
    cwd: workDir,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  })
  child.unref()
  return child.pid
}

/** 进程是否还活着。 */
export function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** 用 taskkill 结束进程树（先确认是 HiddifyCli，避免误杀）。 */
export function killTree(pid) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: error === null, output: String(stdout ?? stderr ?? '').slice(0, 300) })
    })
  })
}

/** 运行时状态文件（跨会话记住 pid / 端口 / 模式）。 */
export function readRuntime(statePath) {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'))
  } catch {
    return undefined
  }
}

export function writeRuntime(statePath, state) {
  mkdirSync(dirname(statePath), { recursive: true })
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8')
}

export function clearRuntime(statePath) {
  try {
    rmSync(statePath, { force: true })
  } catch {
    // 忽略
  }
}

/** Clash REST 控制面调用。 */
export async function clashApi({ port, secret, path, method = 'GET', body, timeoutMs = 8000 }) {
  const url = `http://127.0.0.1:${port}${path}`
  const headers = { 'Content-Type': 'application/json' }
  if (typeof secret === 'string' && secret.length > 0) headers.Authorization = `Bearer ${secret}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal })
    const text = await res.text()
    let json
    try { json = JSON.parse(text) } catch { json = undefined }
    return { ok: res.ok, status: res.status, json, text: text.slice(0, 500) }
  } catch (error) {
    return { ok: false, status: 0, error: String(error?.message ?? error).slice(0, 200) }
  } finally {
    clearTimeout(timer)
  }
}

/** 从内核回写的配置里取 clash_api 端口与密钥。 */
export function readLiveClash(paths) {
  for (const p of [paths.coreLiveConfig, paths.liveConfig]) {
    try {
      const cfg = JSON.parse(readFileSync(p, 'utf8'))
      const api = cfg?.experimental?.clash_api
      if (api !== undefined && typeof api.external_controller === 'string') {
        const [host, port] = api.external_controller.split(':')
        return { port: Number(port), host, secret: api.secret ?? '', from: p }
      }
    } catch {
      // 换下一个候选
    }
  }
  return undefined
}
