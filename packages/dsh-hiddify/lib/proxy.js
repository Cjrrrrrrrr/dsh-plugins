/**
 * dsh-hiddify · 网络层 —— 零依赖的「经代理抓取」实现。
 *
 * 为什么不用全局 fetch：
 *   Node 内置 fetch（undici）**不读 HTTP_PROXY/HTTPS_PROXY 环境变量**，
 *   要让它走代理必须显式构造 dispatcher，而 DSH profile 里不保证装了 undici。
 *   这里直接用 node:http / node:https / node:tls / node:zlib 手写：
 *     · http 目标  → 以 absolute-form 请求行发给代理（GET http://host/path）
 *     · https 目标 → 先 CONNECT host:443 建隧道，再在隧道上 tls.connect 发请求
 *   全部走本机 Hiddify 的 mixed 入站端口（默认 127.0.0.1:12399）。
 *
 * 只依赖 Node 标准库，可脱离 DSH 宿主单独 node -e 测试。
 */
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import zlib from 'node:zlib'

/** 解析代理地址：http://127.0.0.1:12399 → { host, port } */
export function parseProxy(proxyUrl) {
  const raw = String(proxyUrl ?? '').trim()
  if (raw.length === 0) return undefined
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`
  const u = new URL(withScheme)
  return { host: u.hostname, port: Number(u.port || 80) }
}

/** 把可能被压缩的响应体解成明文 Buffer。 */
function decompress(buffer, encoding) {
  const enc = String(encoding ?? '').toLowerCase()
  try {
    if (enc.includes('br')) return zlib.brotliDecompressSync(buffer)
    if (enc.includes('gzip')) return zlib.gunzipSync(buffer)
    if (enc.includes('deflate')) return zlib.inflateSync(buffer)
  } catch {
    // 解压失败就返回原文，交给上层按文本尽力解析
  }
  return buffer
}

/** 只有域名才能设 servername；IP 字面量会被 Node 拒绝（ERR_INVALID_ARG_VALUE）。 */
function serverNameFor(hostname) {
  return net.isIP(hostname) === 0 ? hostname : undefined
}

/** 单次请求（不跟随跳转）。返回 { status, headers, body, location } */
function once(target, options, redirectDepth) {
  const { proxy, method = 'GET', headers = {}, body, timeoutMs = 20000, signal } = options
  const url = new URL(target)
  const isHttps = url.protocol === 'https:'
  const port = Number(url.port || (isHttps ? 443 : 80))
  const requestHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    ...headers,
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout after ${timeoutMs}ms: ${target}`))
    }, timeoutMs)
    const done = (fn) => (value) => {
      clearTimeout(timer)
      fn(value)
    }
    const fail = done(reject)
    const ok = done(resolve)
    if (signal !== undefined) {
      signal.addEventListener('abort', () => fail(new Error('aborted')), { once: true })
    }

    /** 在给定 socket 上发送 HTTP/1.1 请求并收集响应。 */
    const send = (socket) => {
      const mod = socket instanceof tls.TLSSocket ? https : http
      // 明文 HTTP 走代理时，请求行必须是 absolute-form（GET http://host/path HTTP/1.1）
      const requestPath = !isHttps && proxy !== undefined ? url.toString() : url.pathname + url.search
      const req = mod.request({
        createConnection: () => socket,
        method,
        path: requestPath,
        headers: { ...requestHeaders, Host: url.host },
        setHost: false,
        timeout: timeoutMs,
      }, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const raw = Buffer.concat(chunks)
          ok({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: decompress(raw, res.headers['content-encoding']),
            location: res.headers.location,
            url: target,
          })
        })
        res.on('error', fail)
      })
      req.on('error', fail)
      req.on('timeout', () => { req.destroy(new Error('socket timeout')) })
      if (body !== undefined && body !== null) req.write(body)
      req.end()
    }

    try {
      if (!isHttps) {
        // 明文 HTTP：走代理时用 absolute-form 请求行（path 由 http.request 的 path 参数给全 URL）
        if (proxy === undefined) {
          send(net.connect({ host: url.hostname, port, timeout: timeoutMs }))
        } else {
          send(net.connect({ host: proxy.host, port: proxy.port, timeout: timeoutMs }))
        }
        return
      }
      if (proxy === undefined) {
        send(tls.connect({ host: url.hostname, port, servername: serverNameFor(url.hostname), timeout: timeoutMs }))
        return
      }
      // HTTPS over proxy：先 CONNECT 建隧道
      const connectReq = http.request({
        host: proxy.host,
        port: proxy.port,
        method: 'CONNECT',
        path: `${url.hostname}:${port}`,
        headers: { Host: `${url.hostname}:${port}`, 'Proxy-Connection': 'Keep-Alive' },
        timeout: timeoutMs,
      })
      connectReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy()
          fail(new Error(`proxy CONNECT 失败：HTTP ${res.statusCode}`))
          return
        }
        socket.setTimeout(0)
        send(tls.connect({ socket, servername: serverNameFor(url.hostname), timeout: timeoutMs }))
      })
      connectReq.on('error', fail)
      connectReq.on('timeout', () => { connectReq.destroy(new Error('proxy connect timeout')) })
      connectReq.end()
    } catch (error) {
      fail(error)
    }
  })
}

/**
 * 经代理（或直连）抓取一个 URL，自动跟随跳转。
 * @returns {Promise<{status:number, headers:object, body:Buffer, url:string, text:string}>}
 */
export async function proxyFetch(target, options = {}) {
  // 允许调用方直接传 'http://127.0.0.1:12399' 这样的字符串
  const opts = typeof options.proxy === 'string' ? { ...options, proxy: parseProxy(options.proxy) } : options
  const maxRedirects = Number.isSafeInteger(opts.maxRedirects) ? opts.maxRedirects : 5
  let current = target
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const res = await once(current, opts, hop)
    const location = res.location
    if (res.status >= 300 && res.status < 400 && typeof location === 'string' && location.length > 0) {
      current = new URL(location, current).toString()
      continue
    }
    return { ...res, text: res.body.toString('utf8') }
  }
  throw new Error(`跳转次数超过 ${maxRedirects}：${target}`)
}

/** 便捷封装：抓文本页。 */
export async function fetchText(url, options = {}) {
  const res = await proxyFetch(url, options)
  return res
}
