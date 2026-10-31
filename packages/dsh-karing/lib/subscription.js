/**
 * dsh-karing · 订阅层 —— 插件自己拉订阅、自己解析节点、自己更新配置（不依赖 GUI）。
 *
 * 实测（2026-10-18）：订阅 HTTP 200 / 11184 字节 / 32 节点（16 hysteria2 + 16 vless），
 * 响应头带 subscription-userinfo（已用 3.66G / 共 100G，到期 2026-11-14）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { proxyFetch } from './proxy.js'
import { karingPaths, pluginRoot, injectSelector, applyPluginPorts, PLUGIN_PORTS, describeInbounds } from './core.js'

export const SUB_STATE = 'subscription.json'



/**
 * 找订阅 URL：**优先用插件自己记的**（内化后不再依赖 GUI），
 * 没有才回落到 Karing 的 karing_subscribe.json，并顺手记下来。
 */
function findSubscriptionUrl(dataDir) {
  const subStatePath = join(dataDir, SUB_STATE)
  if (existsSync(join(dataDir, SUB_STATE))) {
    try {
      const own = JSON.parse(readFileSync(join(dataDir, SUB_STATE), 'utf8'))
      if (typeof own.url === 'string' && own.url.startsWith('http')) return { url: own.url, from: 'plugin' }
    } catch { /* 落到 GUI */ }
  }
  const paths = karingPaths(undefined, undefined)
  if (!existsSync(paths.subscribeJson)) return undefined
  try {
    const j = JSON.parse(readFileSync(paths.subscribeJson, 'utf8'))
    const item = (j.items ?? []).find((it) => it.enable !== false && typeof it.urlOrPath === 'string' && it.urlOrPath.startsWith('http'))
    if (item === undefined) return undefined
    return { url: item.urlOrPath.split('#')[0], from: 'karing-gui' }
  } catch { return undefined }
}

/** 把订阅 URL 记到插件自己名下（只记一次）。 */
function rememberSubscriptionUrl(dataDir, url, from) {
  const subStatePath = join(dataDir, SUB_STATE)
  if (from === 'plugin') return
  writeFileSync(join(dataDir, SUB_STATE), JSON.stringify({ url, adoptedFrom: from, adoptedAt: new Date().toISOString() }, null, 1), 'utf8')
  console.log(`   已把订阅 URL 记到插件名下：${join(dataDir, SUB_STATE)}`)
}

/** base64 → 明文订阅（兼容标准/URL-safe 与缺失填充）。 */
function decodeSubscription(text) {
  const t = text.trim().replace(/\s+/g, '')
  if (/:\/\//.test(t)) return t                    // 本来就是明文
  const norm = t.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(norm + '='.repeat((4 - (norm.length % 4)) % 4), 'base64').toString('utf8')
}

/** hysteria2://auth@host:port?sni=&obfs=salamander&obfs-password=&insecure=0#name */
function parseHysteria2(uri, template) {
  const u = new URL(uri)
  const q = u.searchParams
  return {
    ...template,
    type: 'hysteria2',
    tag: decodeURIComponent(u.hash.slice(1)) || `${u.hostname}:${u.port}`,
    server: u.hostname,
    server_port: Number(u.port || 443),
    password: decodeURIComponent(u.username || ''),
    ...(q.get('obfs') !== null ? { obfs: { type: q.get('obfs'), password: q.get('obfs-password') ?? '' } } : {}),
    tls: {
      enabled: true,
      server_name: q.get('sni') ?? u.hostname,
      insecure: q.get('insecure') === '1',
      alpn: (q.get('alpn') ?? 'h3').split(','),
    },
  }
}

/** vless://id@host:port?sni=&type=tcp&security=reality&pbk=&sid=&fp=&flow=#name */
function parseVless(uri, template) {
  const u = new URL(uri)
  const q = u.searchParams
  const tls = {
    enabled: q.get('security') !== 'none',
    server_name: q.get('sni') ?? q.get('host') ?? u.hostname,
    alpn: (q.get('alpn') ?? 'h2,http/1.1').split(',').map((x) => decodeURIComponent(x)),
  }
  if (q.get('fp') !== null) tls.utls = { enabled: true, fingerprint: q.get('fp') }
  if (q.get('security') === 'reality') {
    tls.reality = { enabled: true, public_key: q.get('pbk') ?? '', short_id: q.get('sid') ?? '' }
  }
  return {
    ...template,
    type: 'vless',
    tag: decodeURIComponent(u.hash.slice(1)) || `${u.hostname}:${u.port}`,
    server: u.hostname,
    server_port: Number(u.port || 443),
    uuid: decodeURIComponent(u.username || ''),
    ...(q.get('flow') !== null && q.get('flow') !== '' ? { flow: q.get('flow') } : {}),
    tls,
  }
}


/**
 * 刷新订阅并写回插件自有配置。
 * @returns {Promise<object>} 报告（含流量、节点数、差异）
 */
export async function refreshSubscription({ proxyPort = PLUGIN_PORTS.proxy, dataDir = join(pluginRoot(), 'data'), explicitUrl = '', dryRun = false, timeoutMs = 40000 } = {}) {
  const subStatePath = join(dataDir, SUB_STATE)
  const corePath = join(dataDir, 'core.json')
  const found = explicitUrl.length > 0 ? { url: explicitUrl, from: 'cli' } : findSubscriptionUrl(dataDir)
  if (found === undefined) return { ok: false, error: '找不到订阅 URL（插件没记过、Karing 配置里也没有启用的 http 订阅）' }
  if (!existsSync(corePath)) return { ok: false, error: `没有插件自有配置：${corePath}（先跑 node tools/embed-kernel.mjs）` }

  const res = await proxyFetch(found.url, { proxy: `http://127.0.0.1:${proxyPort}`, timeoutMs, headers: { 'User-Agent': 'Karing/1.2.25' } })
  if (res.status !== 200 || res.body.length < 100) return { ok: false, error: `拉取失败：HTTP ${res.status} / ${res.body.length} 字节`, url: found.url, from: found.from }

  const traffic = parseUserInfo(res.headers['subscription-userinfo'])
  const plain = decodeSubscription(res.text)
  const uris = plain.split(String.fromCharCode(10)).map((l) => l.trim()).filter((l) => /^(hysteria2|vless|vmess|trojan|ss):\/\//i.test(l))

  const core = JSON.parse(readFileSync(corePath, 'utf8'))
  const outs = core.outbounds ?? []
  const keep = outs.filter((o) => ['direct', 'block', 'urltest', 'selector'].includes(o.type))
  const oldNodes = outs.filter((o) => !['direct', 'block', 'urltest', 'selector'].includes(o.type))
  const baseOf = (t) => (t?.domain_resolver !== undefined ? { domain_resolver: t.domain_resolver } : {})
  const tpl = { hysteria2: baseOf(oldNodes.find((o) => o.type === 'hysteria2')), vless: baseOf(oldNodes.find((o) => o.type === 'vless')) }

  const parsed = []
  const failed = []
  for (const uri of uris) {
    try {
      if (/^hysteria2:\/\//i.test(uri)) parsed.push(parseHysteria2(uri, tpl.hysteria2))
      else if (/^vless:\/\//i.test(uri)) parsed.push(parseVless(uri, tpl.vless))
      else failed.push(uri.slice(0, 40))
    } catch (error) {
      failed.push(`${uri.slice(0, 40)} (${String(error?.message).slice(0, 40)})`)
    }
  }
  if (parsed.length === 0) return { ok: false, error: '一个节点都没解析出来', url: found.url, traffic }

  const oldByName = new Map(oldNodes.map((o) => [o.tag, o]))
  const added = parsed.filter((p) => !oldByName.has(p.tag)).map((p) => p.tag)
  const removed = oldNodes.filter((o) => !parsed.some((p) => p.tag === o.tag)).map((o) => o.tag)
  const changed = parsed.filter((p) => { const o = oldByName.get(p.tag); return o !== undefined && (o.server !== p.server || o.server_port !== p.server_port) }).map((p) => p.tag)

  if (!dryRun) {
    rememberSubscriptionUrl(dataDir, found.url, found.from)
    const urltest = keep.find((o) => o.type === 'urltest') ?? { type: 'urltest', tag: 'urltest_out', url: 'https://www.gstatic.com/generate_204', interval: '8h', tolerance: 0 }
    const tags = parsed.map((p) => p.tag)
    urltest.outbounds = tags
    if (!tags.includes(urltest.default)) urltest.default = tags[0]
    core.outbounds = [...parsed, urltest, ...keep.filter((o) => o.type !== 'urltest')]
    applyPluginPorts(core, PLUGIN_PORTS)
    injectSelector(core)
    writeFileSync(corePath, JSON.stringify(core, null, 1), 'utf8')
  }
  return { ok: true, url: found.url, from: found.from, bytes: res.body.length, traffic, nodeCount: parsed.length, added, removed, changed, failed, corePath, dryRun, ports: describeInbounds(core) }
}

/** 解析 subscription-userinfo 头。 */
export function parseUserInfo(raw) {
  if (typeof raw !== 'string') return undefined
  const m = Object.fromEntries(raw.split(';').map((x) => x.trim().split('=')))
  const gb = (n) => Number((Number(n ?? 0) / 1073741824).toFixed(2))
  return {
    uploadGB: gb(m.upload), downloadGB: gb(m.download), totalGB: gb(m.total),
    usedGB: gb(Number(m.upload ?? 0) + Number(m.download ?? 0)),
    expireAt: Number(m.expire ?? 0) > 0 ? new Date(Number(m.expire) * 1000).toISOString().slice(0, 10) : undefined,
  }
}
