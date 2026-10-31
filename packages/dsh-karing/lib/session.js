/**
 * dsh-karing · 会话与限速层 —— 给国内搜索引擎（尤其百度）一个「像人」的抓取姿势。
 *
 * 实测背景（2026-10-23，本机 IP）：
 *   · www.baidu.com/s 无论直连还是代理，一律 302 → wappass.baidu.com/static/captcha/tuxing_v2.html
 *   · 移动端 m.baidu.com、资讯 tn=news、带伪造 BAIDUID，全部同样 302
 *   · 但 www.baidu.com 首页仍 200 / 738KB —— 说明不是整站封，是**搜索接口按 IP 限流**
 *   · 360 同时 302、搜狗 000 —— 三家一起被限，是高频抓取累积触发的
 *
 * 所以这里做四件事，目标是**恢复后不再触发**：
 *   1. 会话：先 GET 首页拿真实 BAIDUID/BIDUPSID，搜索时带上完整浏览器请求头
 *   2. 限速：同一引擎两次请求之间有最小间隔，且随连续失败指数退避
 *   3. 识别：302 到 wappass / 内容含「安全验证」→ 明确判为「风控中」，不当成空结果
 *   4. 冷却：一旦判定风控，该引擎进入冷却期，期间不再打，避免越打越僵
 */
import http from 'node:http'

/** 浏览器级请求头（缺一项都容易触发风控）。 */
export const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-User': '?1',
  'Cache-Control': 'max-age=0',
}

/**
 * 每小时的「成功配额」。百度成功一次后基本就打不动了，所以主动限流，
 * 把宝贵的几次留给最需要的查询，而不是浪费在批量采集里。
 */
export const HOURLY_QUOTA = { baidu: 1, so360: 8, sogou: 4 }

/** 每个引擎的运行时状态：cookie、上次请求时间、连续失败次数、冷却截止。 */
const state = new Map()

function slot(engine) {
  if (!state.has(engine)) {
    state.set(engine, { cookie: '', lastAt: 0, fails: 0, cooldownUntil: 0, homeFetchedAt: 0, wins: [] })
  }
  return state.get(engine)
}

/**
 * 各引擎的最小请求间隔（毫秒）。
 *
 * 百度实测（2026-10-23）：**每次成功后会立刻收紧，同一 IP 短时间内只放行一次**。
 * 30 秒、60 秒间隔都照样 socket hang up —— 所以间隔不是关键，配额才是。
 */
export const MIN_INTERVAL = {
  baidu: 45000,
  so360: 20000,
  sogou: 15000,
  bing: 4000,
  duckduckgo: 4000,
  'ddg-lite': 5000,
  wikisource: 2500,
  'archive-org': 3000,
  ctext: 5000,
  marginalia: 5000,
  google: 8000,
}

/** 把 Set-Cookie 数组压成 Cookie 头（同名取最后一次）。 */
function mergeCookies(existing, setCookieHeaders) {
  const jar = new Map()
  for (const part of String(existing ?? '').split(';')) {
    const kv = part.trim().split('=')
    if (kv[0] && kv[1] !== undefined) jar.set(kv[0], kv[1])
  }
  for (const sc of setCookieHeaders ?? []) {
    const first = String(sc).split(';')[0]
    const eq = first.indexOf('=')
    if (eq > 0) jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim())
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

/** 判断响应是不是风控/验证页。 */
export function detectAntiBot({ status, headers, text, finalUrl }) {
  const loc = String(headers?.location ?? '')
  if (status >= 300 && status < 400 && /wappass|captcha|verify|antispider/i.test(loc)) {
    return { blocked: true, why: `302 → 验证页(${loc.split('?')[0]})` }
  }
  const body = String(text ?? '')
  if (/wappass\.baidu\.com|tuxing_v2|请输入验证码|安全验证|百度安全验证/i.test(body)) {
    return { blocked: true, why: '页面内容含「安全验证/验证码」' }
  }
  if (body.length > 0 && body.length < 3000 && /captcha|验证/i.test(body)) {
    return { blocked: true, why: `短响应(${body.length}B)且含验证特征` }
  }
  if (finalUrl !== undefined && /wappass|captcha/i.test(finalUrl)) {
    return { blocked: true, why: `落地页是验证地址` }
  }
  return { blocked: false }
}

/** 冷却是否生效中。 */
export function isCoolingDown(engine) {
  const s = slot(engine)
  return s.cooldownUntil > Date.now()
}

/** 配额是否用尽（返回 0 表示还能用，>0 表示要等多少毫秒）。 */
export function quotaLeftMs(engine) {
  const cap = HOURLY_QUOTA[engine]
  if (cap === undefined) return 0
  const s = slot(engine)
  const now = Date.now()
  s.wins = (s.wins ?? []).filter((t) => now - t < 3600000)
  if (s.wins.length < cap) return 0
  return Math.max(0, 3600000 - (now - s.wins[0]))
}

/** 冷却剩余毫秒。 */
export function cooldownLeft(engine) {
  const s = slot(engine)
  return Math.max(0, s.cooldownUntil - Date.now())
}

/** 记录一次风控：指数退避 + 进入冷却。 */
export function recordBlocked(engine, baseMs = 600000) {
  const s = slot(engine)
  s.fails += 1
  // 第 1 次失败可能只是瞬断（socket hang up），先不退避；第 2 次起才进冷却
  if (s.fails < 2) return 0
  const backoff = Math.min(baseMs * 2 ** (s.fails - 2), 3600000)
  s.cooldownUntil = Date.now() + backoff
  return backoff
}

/** 记录一次成功：清零失败计数。 */
export function recordSuccess(engine) {
  const s = slot(engine)
  s.fails = 0
  s.cooldownUntil = 0
  s.wins = s.wins ?? []
  s.wins.push(Date.now())
}

/** 等待到满足最小间隔（返回实际等待毫秒）。 */
export async function throttle(engine, signal) {
  const s = slot(engine)
  const gap = MIN_INTERVAL[engine] ?? 3000
  const wait = Math.max(0, s.lastAt + gap - Date.now())
  if (wait > 0) {
    await new Promise((resolve) => {
      const t = setTimeout(resolve, wait)
      if (signal !== undefined) signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
    })
  }
  s.lastAt = Date.now()
  return wait
}

/**
 * 拿一次「首页会话」：GET 首页取 Set-Cookie（BAIDUID/BIDUPSID），
 * 缓存 30 分钟。失败不致命，只是少一层保护。
 */
export async function ensureSession(engine, fetchImpl, homeUrl, { proxy, maxAgeMs = 1800000, signal } = {}) {
  const s = slot(engine)
  if (s.homeFetchedAt > 0 && Date.now() - s.homeFetchedAt < maxAgeMs && s.cookie.length > 0) return s.cookie
  try {
    const res = await fetchImpl(homeUrl, {
      proxy,
      timeoutMs: 15000,
      maxRedirects: 5,
      headers: { ...BROWSER_HEADERS },
      signal,
    })
    const setCookie = res.headers?.['set-cookie']
    s.cookie = mergeCookies(s.cookie, Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []))
    s.homeFetchedAt = Date.now()
    s.lastHomeError = null
  } catch (error) {
    // 首页拿不到就空 cookie 继续，不阻断，但记下来便于排查
    s.lastHomeError = String(error?.message ?? error).slice(0, 120)
  }
  return s.cookie
}

/** 读当前会话 cookie（调试用）。 */
export function sessionInfo(engine) {
  const s = slot(engine)
  return {
    cookieKeys: String(s.cookie ?? '').split(';').map((x) => x.split('=')[0].trim()).filter(Boolean),
    cookieLen: String(s.cookie ?? '').length,
    fails: s.fails,
    cooldownLeftMs: Math.max(0, s.cooldownUntil - Date.now()),
    lastRequestAgoMs: s.lastAt > 0 ? Date.now() - s.lastAt : null,
    homeError: s.lastHomeError ?? null,
    quotaLeftMs: quotaLeftMs(engine),
    winsLastHour: (s.wins ?? []).filter((t) => Date.now() - t < 3600000).length,
  }
}
