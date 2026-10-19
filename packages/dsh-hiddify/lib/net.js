/**
 * dsh-hiddify · 系统层 —— 系统代理开关 + 三路连通性实测。
 *
 * 「电脑可同时连接外网与内网」的两个着力点：
 *   1) 路由层：sing-box 的 route.rules 里私有网段 ip_cidr → direct（见 core.js），
 *      TUN 模式与系统代理模式下内网都不会被劫持；
 *   2) 系统代理层：Windows 的 ProxyOverride 白名单把内网段列进去，
 *      于是走系统代理的应用访问内网时也直连。实测本机原有白名单已含 192.168 段、10 段、172.16-31 段。
 *
 * 只改 HKCU（当前用户），不需要管理员权限；ProxyEnable 改回 0 即回滚。
 */
import { execFile } from 'node:child_process'
import net from 'node:net'
import { proxyFetch, parseProxy } from './proxy.js'

const REG_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

/** 默认的内网绕过白名单（Windows ProxyOverride 语法：分号分隔，支持 * 通配）。 */
export const DEFAULT_BYPASS = [
  '<local>',
  'localhost',
  '127.*',
  '10.*',
  '172.16.*',
  '172.17.*',
  '172.18.*',
  '172.19.*',
  '172.20.*',
  '172.21.*',
  '172.22.*',
  '172.23.*',
  '172.24.*',
  '172.25.*',
  '172.26.*',
  '172.27.*',
  '172.28.*',
  '172.29.*',
  '172.30.*',
  '172.31.*',
  '192.168.*',
  '169.254.*',
  '*.local',
]

function reg(args, timeoutMs = 10000) {
  return new Promise((resolve) => {
    execFile('reg', args, { windowsHide: true, timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({ ok: error === null, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error: error === null ? undefined : String(error.message).slice(0, 200) })
    })
  })
}

function powershell(script, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({ ok: error === null, stdout: String(stdout ?? '').trim(), stderr: String(stderr ?? '').trim(), error: error === null ? undefined : String(error.message).slice(0, 200) })
    })
  })
}

/** 读当前系统代理设置。 */
export async function systemProxyStatus() {
  const res = await reg(['query', REG_PATH])
  if (!res.ok) return { ok: false, error: res.error ?? res.stderr.slice(0, 200) }
  const pick = (name) => {
    const m = res.stdout.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.*)`))
    return m === null ? undefined : m[1].trim()
  }
  const enable = pick('ProxyEnable')
  return {
    ok: true,
    enabled: enable === '0x1',
    server: pick('ProxyServer'),
    override: pick('ProxyOverride'),
    autoConfigUrl: pick('AutoConfigURL'),
  }
}

/** 打开系统代理，指向本机 Hiddify 的 mixed 端口，并把内网段放进绕过白名单。 */
export async function systemProxyOn(port, extraBypass = []) {
  const override = [...new Set([...DEFAULT_BYPASS, ...extraBypass])].join(';')
  const server = `http://127.0.0.1:${port}`
  const a = await reg(['add', REG_PATH, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', server, '/f'])
  const b = await reg(['add', REG_PATH, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', override, '/f'])
  const c = await reg(['add', REG_PATH, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f'])
  await notifyWinInet()
  return { ok: a.ok && b.ok && c.ok, server, overrideCount: override.split(';').length, errors: [a, b, c].filter((x) => !x.ok).map((x) => x.error ?? x.stderr.slice(0, 120)) }
}

/** 关闭系统代理（回滚动作：ProxyEnable=0）。 */
export async function systemProxyOff() {
  const c = await reg(['add', REG_PATH, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f'])
  await notifyWinInet()
  return { ok: c.ok, error: c.ok ? undefined : (c.error ?? c.stderr.slice(0, 120)) }
}

/** 通知 WinINET 设置已变（浏览器/系统组件立刻感知；失败不影响注册表已写入的事实）。 */
export async function notifyWinInet() {
  const script = [
    '$sig = \'[DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);\'',
    'Add-Type -MemberDefinition $sig -Name W -Namespace N -ErrorAction SilentlyContinue | Out-Null',
    '[N.W]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null',
    '[N.W]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null',
    'Write-Output "notified"',
  ].join('; ')
  const res = await powershell(script)
  return res.ok
}

/** TCP 连通性探测（不依赖目标协议，够快够准）。 */
export function tcpProbe(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const started = Date.now()
    const socket = net.connect({ host, port })
    const done = (ok, extra = {}) => {
      socket.destroy()
      resolve({ host, port, ok, ms: Date.now() - started, ...extra })
    }
    socket.setTimeout(timeoutMs)
    socket.on('connect', () => done(true))
    socket.on('timeout', () => done(false, { reason: 'timeout' }))
    socket.on('error', (error) => done(false, { reason: String(error.code ?? error.message) }))
  })
}

/** 取全部默认网关（一台机器可能同时挂着有线/无线/虚拟网卡，各有各的内网）。 */
export async function defaultGateways() {
  const res = await powershell("Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | ForEach-Object { \"$($_.NextHop)|$($_.InterfaceAlias)|$($_.RouteMetric)\" }")
  const seen = new Set()
  const out = []
  for (const raw of res.stdout.split(/\r?\n/)) {
    const [hop, iface, metric] = raw.split('|').map((x) => (x ?? '').trim())
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(hop ?? '')) continue
    if (seen.has(hop)) continue
    seen.add(hop)
    out.push({ gateway: hop, iface, metric: Number(metric) })
  }
  return out
}

/** 取默认网关（保留旧接口：返回 metric 最小的那个）。 */
export async function defaultGateway() {
  const list = await defaultGateways()
  return list[0]?.gateway
}

/** ping 一台内网主机（ICMP 比 TCP 更能代表「内网可达」）。 */
export function pingHost(host, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const started = Date.now()
    execFile('ping', ['-n', '2', '-w', '1500', host], { windowsHide: true, timeout: timeoutMs, encoding: 'buffer' }, (error, stdout) => {
      const text = Buffer.from(stdout ?? '').toString('latin1')
      // 中文/英文 Windows 的 ping 输出都能靠「丢包率 / Lost」判断
      const lost = /(\d+)%\s*(丢失|loss)/i.exec(text)
      const ok = lost !== null ? Number(lost[1]) === 0 : error === null
      resolve({ host, ok, ms: Date.now() - started, raw: text.replace(/\s+/g, ' ').slice(0, 200) })
    })
  })
}

/**
 * 三路连通性实测 —— 「外网 / 国内 / 内网」各自给证据。
 * @returns {Promise<{proxyPort:object, foreign:object[], domestic:object[], lan:object}>}
 */
export async function probeAll({ proxy, port, signal } = {}) {
  const p = parseProxy(proxy)
  const viaProxy = { proxy: p === undefined ? undefined : `http://${p.host}:${p.port}`, timeoutMs: 12000, signal, maxRedirects: 2 }
  const direct = { proxy: undefined, timeoutMs: 8000, signal, maxRedirects: 2 }

  const foreignTargets = [
    ['google', 'https://www.google.com/generate_204'],
    ['duckduckgo', 'https://html.duckduckgo.com/html/?q=test'],
    ['github-raw', 'https://raw.githubusercontent.com/hiddify/hiddify-geo/main/README.md'],
  ]
  const domesticTargets = [
    ['baidu', 'https://www.baidu.com/'],
    ['tencent', 'https://www.qq.com/'],
  ]

  const measure = async (label, url, options) => {
    const started = Date.now()
    try {
      const res = await proxyFetch(url, options)
      return { label, url, ok: res.status > 0 && res.status < 500, status: res.status, ms: Date.now() - started }
    } catch (error) {
      return { label, url, ok: false, status: 0, ms: Date.now() - started, error: String(error?.message ?? error).slice(0, 120) }
    }
  }

  const [foreign, domestic] = await Promise.all([
    Promise.all(foreignTargets.map(([l, u]) => measure(l, u, viaProxy))),
    Promise.all(domesticTargets.map(([l, u]) => measure(l, u, direct))),
  ])

  const gateways = await defaultGateways()
  const lan = { gateways: [], ok: false }
  for (const g of gateways.slice(0, 4)) {
    const ping = await pingHost(g.gateway)
    const tcp = ping.ok ? undefined : await tcpProbe(g.gateway, 80, 2500)
    const entry = {
      gateway: g.gateway,
      iface: g.iface,
      ok: ping.ok || tcp?.ok === true,
      method: ping.ok ? 'icmp' : 'tcp',
      ms: ping.ok ? ping.ms : tcp?.ms,
    }
    lan.gateways.push(entry)
    if (entry.ok) lan.ok = true
  }
  if (gateways.length === 0) lan.reason = '未取到默认网关'
  lan.primary = lan.gateways.find((g) => g.ok) ?? lan.gateways[0]

  const proxyPort = Number.isSafeInteger(port) && port > 0
    ? await tcpProbe('127.0.0.1', port)
    : { ok: false, reason: '未提供代理端口' }

  return { proxyPort, foreign, domestic, lan }
}
