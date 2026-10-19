/**
 * dsh-karing · 核心层 —— 单独调用 Karing 的内核（karingService.exe），不依赖 GUI。
 *
 * 实测事实（2026-10-17，本机 F:\Karing，Karing 1.2.25.2802）：
 *   · Karing = Flutter GUI（karing.exe）+ sing-box 内核（karingService.exe，Cobra CLI）
 *   · 内核命令：run / run2 / check / format / merge / rule-set / geoip / geosite / version
 *   · 启动方式（实测唯一可行的一种）：
 *       karingService.exe run -s <service.json> -D <work_dir> --connected-port <port>
 *     注意：`-s` 与 `-c` 同时传会 FATAL「duplicate inbound tag」（service.json 里的
 *     core_path 已经指向 sing-box 配置，再传 -c 等于合并两份）。
 *   · service.json（GUI 生成）= 控制面描述：control_port / secret / core_path / work_dir
 *   · service_core.json（GUI 生成）= 真正的 sing-box 配置
 *   · **Karing 的分流模型和 Hiddify 完全不同**：它一次开三个 mixed 入站，
 *     用「连哪个端口」来决定走哪条出口 —— 换模式根本不用重启内核：
 *        mixed_in_direct  → direct_out   全直连（内网/国内）
 *        mixed_in_proxy   → urltest_out  全代理（外网）
 *        mixed_in_rule    → 按规则（private → direct，其余 → urltest_out）
 *   · 配置里自带 {"ip_is_private": true, "outbound": "direct_out"} → 内网天然直连
 *   · Clash REST 控制面：control_port（实测 3057）+ service.json 里的 secret
 *
 * 所以「电脑同时连外网与内网」在 Karing 上是**零成本**的：把系统代理指到 3067（rule）
 * 就是「内网直连 + 外网走代理」，指到 3065 就是全直连，指到 3066 就是全代理。
 */
import { spawn, execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, rmSync, copyFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

/** 三种模式 → 对应的 mixed 入站（Karing 原生设计，切换无需重启内核） */
export const MODES = ['rule', 'proxy', 'direct']
export const MODE_INBOUND = { rule: 'mixed_in_rule', proxy: 'mixed_in_proxy', direct: 'mixed_in_direct' }

/** 私有网段（sing-box 的 ip_is_private 已覆盖，这里用于文档与自检） */
export const LAN_CIDRS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '169.254.0.0/16', '100.64.0.0/10', 'fc00::/7', 'fe80::/10', '::1/128']

/** 国内直连：Karing 默认规则模式不带 CN 分流，插件按需注入（零外部依赖，只按域名后缀） */
export const CN_SUFFIXES = ['.cn', '.com.cn', '.net.cn', '.org.cn', '.gov.cn', '.edu.cn']

/** 插件根目录（lib/ 的上一级）。 */
export function pluginRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

/**
 * 插件**自带**内核的目录与专属端口。
 * 内化的意义：内核归插件管、端口与 GUI 完全隔离 —— 插件和 Karing GUI 可以同时跑，
 * 互不抢 3065-3067，也不再依赖「GUI 必须先运行过一次」。
 */
export const EMBED_DIR = 'runtime'
export const EMBED_EXE = 'karingService.exe'
export const PLUGIN_PORTS = { direct: 3165, proxy: 3166, rule: 3167, clash: 3157 }

/**
 * 把内核内化到插件目录（复制一份 karingService.exe）。
 * 实测：该二进制是 Go 静态链接，单文件复制后可直接运行（不依赖 F:\Karing 下的任何 DLL）。
 */
export function embedKernel({ installExe, targetDir } = {}) {
  const d = defaultPaths()
  const src = installExe && installExe.length > 0 ? installExe : d.installExe
  const dir = targetDir && targetDir.length > 0 ? targetDir : join(pluginRoot(), EMBED_DIR)
  if (!existsSync(src)) return { ok: false, error: `找不到源内核：${src}` }
  mkdirSync(dir, { recursive: true })
  const dst = join(dir, EMBED_EXE)
  copyFileSync(src, dst)
  return { ok: true, from: src, to: dst, bytes: statSync(dst).size, at: new Date().toISOString() }
}

export function defaultPaths() {
  return {
    installExe: 'F:\\Karing\\karingService.exe',
    guiPath: 'F:\\Karing\\karing.exe',
    appData: join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'karing', 'karing'),
  }
}

/** Karing 的目录布局。 */
export function karingPaths(exePath, appDataDir) {
  const d = defaultPaths()
  const embedded = join(pluginRoot(), EMBED_DIR, EMBED_EXE)
  const external = exePath && exePath.length > 0 ? exePath : d.installExe
  const useEmbedded = existsSync(embedded)
  const exe = useEmbedded ? embedded : external
  const appData = appDataDir && appDataDir.length > 0 ? appDataDir : d.appData
  return {
    exePath: exe,
    /** embedded = 插件自带内核；external = 用 Karing 安装目录里的 */
    kernelSource: useEmbedded ? 'embedded' : 'external',
    embeddedPath: embedded,
    externalPath: external,
    installDir: dirname(exe),
    appData,
    guiServiceJson: join(appData, 'service.json'),
    guiCoreJson: join(appData, 'service_core.json'),
    guiLog: join(appData, 'service_core.log'),
    guiAppLog: join(appData, 'app.log'),
    settingsJson: join(appData, 'karing_setting.json'),
    routingJson: join(appData, 'karing_routing_group.json'),
    subscribeJson: join(appData, 'karing_subscribe.json'),
  }
}

/** 读 GUI 的 service.json（控制面描述）。 */
export function readService(paths) {
  try {
    const raw = JSON.parse(readFileSync(paths.guiServiceJson, 'utf8'))
    return {
      controlPort: Number(raw.control_port ?? 0),
      secret: String(raw.secret ?? ''),
      workDir: String(raw.work_dir ?? ''),
      corePath: String(raw.core_path ?? ''),
      baseDir: String(raw.base_dir ?? ''),
      version: String(raw.version ?? ''),
      id: String(raw.id ?? ''),
      raw,
    }
  } catch {
    return undefined
  }
}

/** 读 GUI 的 sing-box 配置。 */
export function readCore(paths) {
  try {
    return JSON.parse(readFileSync(paths.guiCoreJson, 'utf8'))
  } catch {
    return undefined
  }
}

/** 从配置里解出三个入站的端口（tag 由 Karing 固定，端口可能被 GUI 改）。 */
export function describeInbounds(config) {
  const out = {}
  for (const inb of config?.inbounds ?? []) {
    if (inb.tag === 'mixed_in_direct') out.direct = inb.listen_port
    if (inb.tag === 'mixed_in_proxy') out.proxy = inb.listen_port
    if (inb.tag === 'mixed_in_rule') out.rule = inb.listen_port
  }
  return out
}

/** 出站 tag 发现（不写死，GUI 版本变化也能跟上）。 */
export function discoverTags(config) {
  const outs = config?.outbounds ?? []
  const direct = outs.find((o) => o.type === 'direct')?.tag ?? 'direct_out'
  const proxy = config?.route?.final ?? outs.find((o) => o.type === 'urltest')?.tag ?? 'urltest_out'
  const block = outs.find((o) => o.type === 'block')?.tag ?? 'block_out'
  return { direct, proxy, block }
}

/**
 * 在配置里补齐「内网直连 + 国内直连」规则（幂等）。
 * Karing 自带 ip_is_private → direct；这里只补 CN 域名后缀与局域网域名后缀。
 */
export function applyRoutingPolicy(config, { cnBypass = true, lanDirect = true } = {}) {
  const route = config.route ?? (config.route = {})
  const { direct } = discoverTags(config)
  const rules = Array.isArray(route.rules) ? route.rules : (route.rules = [])
  const has = (name) => rules.some((r) => r.name === name)

  // 规则顺序：私有网段最前，其次局域网域名，再是国内域名，最后才是 Karing 原有规则
  const inject = []
  if (lanDirect && !has('dsh-lan-direct')) {
    inject.push({ ip_is_private: true, outbound: direct, name: 'dsh-lan-direct' })
    inject.push({ domain_suffix: ['localhost', '.local', '.lan', '.internal', '.home.arpa'], outbound: direct, name: 'dsh-lan-domains' })
  }
  if (cnBypass && !has('dsh-cn-direct')) {
    inject.push({ domain_suffix: CN_SUFFIXES, outbound: direct, name: 'dsh-cn-direct' })
  }
  // 去掉重复的 ip_is_private（Karing 自带一条同义规则）
  const seen = new Set()
  route.rules = [...inject, ...rules].filter((r) => {
    const key = r.ip_is_private === true ? 'ip_is_private' : r.name
    if (key === undefined) return true
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return config
}

/**
 * 注入一个可选节点的 selector 组。
 *
 * 为什么需要：Karing 默认配置里只有 `urltest_out`（URLTest 型），而 Clash API 对 URLTest 组
 * **不支持手动选择** —— 实测 `PUT /proxies/urltest_out` 返回 400，于是「换节点」这个能力等于没有。
 * 这里补一个标准 sing-box selector（默认走 urltest_out，也可手动钉死某个节点），
 * 并把 route.final 指过去，`karing_nodes action=select` 就能真正生效。
 */
export function injectSelector(config, tag = 'dsh_selector') {
  const outs = Array.isArray(config.outbounds) ? config.outbounds : (config.outbounds = [])
  if (outs.some((o) => o.tag === tag)) return config
  const urltest = outs.find((o) => o.type === 'urltest')
  const nodes = outs.filter((o) => !['direct', 'block', 'urltest', 'selector'].includes(o.type)).map((o) => o.tag)
  if (urltest === undefined || nodes.length === 0) return config
  outs.push({ type: 'selector', tag, outbounds: [urltest.tag, ...nodes], default: urltest.tag })
  const route = config.route ?? (config.route = {})
  // final 与「全代理」入站都改走 selector，手动切换才有意义
  if (route.final === urltest.tag) route.final = tag
  for (const rule of route.rules ?? []) {
    if (rule.outbound === urltest.tag) rule.outbound = tag
  }
  return config
}

/**
 * 准备插件自己的运行时配置：复制 GUI 配置 → 注入策略 → 写插件目录下的 service.json。
 * 为什么要复制：GUI 会随时覆写 service_core.json，插件不能跟它抢同一个文件。
 */
export function prepareRuntime({ paths, dataDir, cnBypass = true, lanDirect = true, forceBootstrap = false, ports = PLUGIN_PORTS } = {}) {
  mkdirSync(dataDir, { recursive: true })
  const corePath = join(dataDir, 'core.json')
  const servicePath = join(dataDir, 'service.json')
  const logPath = join(dataDir, 'core.log')

  // ── 配置自持 ──
  // 插件目录已有 core.json 就直接用（不再依赖 GUI）；没有才从 GUI 配置 bootstrap 一次。
  let core
  let bootstrapped = false
  if (!forceBootstrap && existsSync(corePath)) {
    try {
      core = JSON.parse(readFileSync(corePath, 'utf8'))
    } catch {
      core = undefined
    }
  }
  if (core === undefined) {
    const guiCore = readCore(paths)
    if (guiCore === undefined) {
      return { ok: false, error: `没有插件自有配置，且读不到 ${paths.guiCoreJson}（首次内化需要 GUI 至少生成过一次配置）` }
    }
    core = guiCore
    bootstrapped = true
  }

  // ── 端口隔离：插件用 3165/3166/3167 + 控制面 3157，与 GUI 的 3065-3067/3057 井水不犯河水 ──
  applyPluginPorts(core, ports)
  applyRoutingPolicy(core, { cnBypass, lanDirect })
  injectSelector(core)
  writeFileSync(corePath, JSON.stringify(core, null, 1), 'utf8')

  // ── service.json（控制面描述）──
  const svc = readService(paths)
  const workDir = svc?.workDir && svc.workDir.length > 0 ? svc.workDir : join(dataDir, 'work')
  mkdirSync(workDir, { recursive: true })
  const service = {
    ...(svc?.raw ?? {}),
    control_port: ports.clash,
    secret: svc?.secret && svc.secret.length > 0 ? svc.secret : 'dshkaringlocal',
    base_dir: dataDir,
    work_dir: workDir,
    core_path: corePath,
    log_path: logPath,
    err_path: join(dataDir, 'core-err.log'),
    name: 'Karing (dsh-karing embedded)',
  }
  writeFileSync(servicePath, JSON.stringify(service, null, 1), 'utf8')

  const inbounds = describeInbounds(core)
  const tags = discoverTags(core)
  const nodes = (core.outbounds ?? []).filter((o) => !['direct', 'block', 'urltest', 'selector'].includes(o.type))
  return {
    ok: true,
    servicePath,
    corePath,
    logPath,
    workDir,
    controlPort: service.control_port,
    secret: service.secret,
    ports: inbounds,
    tags,
    nodeCount: nodes.length,
    ruleCount: core.route.rules.length,
    selectorTag: (core.outbounds ?? []).some((o) => o.tag === 'dsh_selector') ? 'dsh_selector' : undefined,
    bootstrapped,
    kernelSource: paths.kernelSource,
  }
}

/** 把三个入站与控制面端口钉到插件专属值（幂等）。 */
export function applyPluginPorts(config, ports = PLUGIN_PORTS) {
  for (const inb of config.inbounds ?? []) {
    if (inb.tag === 'mixed_in_direct') inb.listen_port = ports.direct
    if (inb.tag === 'mixed_in_proxy') inb.listen_port = ports.proxy
    if (inb.tag === 'mixed_in_rule') inb.listen_port = ports.rule
  }
  const exp = config.experimental ?? (config.experimental = {})
  exp.clash_api = { ...(exp.clash_api ?? {}), external_controller: `127.0.0.1:${ports.clash}` }
  return config
}

/** 启动内核（detached；工具调用结束后继续跑）。 */
export function spawnService({ exePath, servicePath, workDir, connectedPort, logPath }) {
  const fd = openSync(logPath, 'a')
  const child = spawn(exePath, ['run', '-s', servicePath, '-D', workDir, '--connected-port', String(connectedPort)], {
    cwd: dirname(exePath),
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  })
  child.unref()
  return child.pid
}

export function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

export function killTree(pid) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: error === null, output: String(stdout ?? stderr ?? '').slice(0, 300) })
    })
  })
}

/** 找本机所有 karingService.exe 进程（含 GUI 拉起的那个）。 */
export function listCoreProcesses() {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command',
      "@(Get-CimInstance Win32_Process -Filter \"Name='karingService.exe'\") | ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" }"],
      { windowsHide: true, timeout: 15000 }, (error, stdout) => {
      if (error !== null) { resolve([]); return }
      const out = []
      for (const line of String(stdout).split(/\r?\n/)) {
        const [pid, cmd] = line.split('|')
        if (/^\d+$/.test((pid ?? '').trim())) out.push({ pid: Number(pid.trim()), commandLine: (cmd ?? '').trim() })
      }
      resolve(out)
    })
  })
}

/** GUI 的 karing.exe 是否在跑。 */
export function listGuiProcesses() {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command',
      "@(Get-CimInstance Win32_Process -Filter \"Name='karing.exe'\").ProcessId"],
      { windowsHide: true, timeout: 15000 }, (error, stdout) => {
      if (error !== null) { resolve([]); return }
      resolve(String(stdout).split(/\r?\n/).map((x) => Number(x.trim())).filter((n) => Number.isSafeInteger(n) && n > 0))
    })
  })
}

export function readRuntime(statePath) {
  try { return JSON.parse(readFileSync(statePath, 'utf8')) } catch { return undefined }
}

export function writeRuntime(statePath, state) {
  mkdirSync(dirname(statePath), { recursive: true })
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8')
}

export function clearRuntime(statePath) {
  try { rmSync(statePath, { force: true }) } catch { /* 忽略 */ }
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
