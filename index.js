/**
 * @local/lan-access — Host half.
 *
 * 目标：让局域网里的其他设备能打开本机的 dsh Web GUI。
 *
 * 背景（本机实测）：
 *  - dsh 的 webserver 只接受一个具体的本地地址，**拒绝 0.0.0.0**（wildcard），
 *    所以没法直接把宿主监听改成 0.0.0.0。
 *  - 宿主监听谁家都在 127.0.0.1:<随机端口>，且首个页面请求 <b>必须带进程 token</b>
 *    （实测裸 GET / 返回 401）。
 *  - connection 服务提供 authenticatedUrl(baseUrl)，能把一段干净的
 *    http(s)://host:port/ 变成带当前进程 token 的「首次登录」URL。
 *
 * 做法（不改任何 profile 配置、不碰宿主监听）：
 *  插件自己起一个 HTTP/WebSocket 反向代理，监听 `0.0.0.0:<config.port>`，
 *  把每个请求（含 upgrade）原样转发到 `127.0.0.1:<宿主真实端口>`。
 *  Host 头保持客户端访问时用的 authority（192.168.x.x:port），这样宿主 mint 的
 *  会话 cookie 会绑定到该 authority，浏览器后续请求才会带上它。
 *
 *  面板展示本机所有 IPv4 地址，以及每个地址对应的、带 token 的可访问链接。
 *
 * 这是「可配置端口 + 自动 0.0.0.0 + 局域网链接」唯一可控的实现路径；
 * 监听失败（端口占用/地址消失）只让本插件的代理失效，宿主本身不受影响。
 */

import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { networkInterfaces } from 'node:os'

export const name = '@local/lan-access'

/** 依赖宿主 web 载体与连接信任服务。 */
export const inject = ['webServer', 'connection']

/** 插件默认配置；profile 的 cordis.patch.yml 可用同名 id 覆盖（整体替换）。 */
const DEFAULTS = { enabled: true, port: 3180 }

/** 每跳都应重建的头（RFC 9110 7.6.1）。 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** 解析某个 origin 的端口。 */
function originPort(origin) {
  try {
    const url = new URL(origin)
    if (url.port !== '') return Number(url.port)
    return url.protocol === 'https:' ? 443 : 80
  } catch {
    return undefined
  }
}

/** 归一化配置：端口收敛到 1..65535，enabled 缺省为真。 */
function normalizeConfig(config) {
  const source = config && typeof config === 'object' ? config : {}
  let port = Number(source.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) port = DEFAULTS.port
  const enabled = source.enabled === undefined ? DEFAULTS.enabled : source.enabled !== false
  return { enabled, port }
}

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** 虚拟网卡/隧道/容器网桥：其地址通常不是局域网内其他设备能直达的出口。 */
const VIRTUAL_IFACE_PREFIXES = [
  'docker', 'veth', 'virbr', 'vmnet', 'vboxnet', 'vethernet', 'br-',
  'utun', 'tun', 'tap', 'ppp', 'ipsec', 'wg', 'wireguard', 'tailscale',
  'nordlynx', 'proton', 'openvpn', 'zt', 'flclash', 'clash', 'mihomo',
]

function isVirtualIface(name) {
  const lower = String(name || '').toLowerCase()
  return VIRTUAL_IFACE_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

/** 局域网对端无法路由到的 IPv4 段（保留/回环/链路本地/CGNAT/基准测试/组播）。 */
function isReservedIPv4(address) {
  const octets = String(address).split('.').map((part) => Number(part))
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true
  const [a, b] = octets
  if (a === 0) return true
  if (a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 169 && b === 254) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a >= 224) return true
  return false
}

/** 采集本机全部非内部 IPv4 地址（含网卡名）与「是否可能被局域网对端直达」。 */
function collectAddresses() {
  const out = []
  let ifaces
  try {
    ifaces = networkInterfaces()
  } catch {
    return out
  }
  for (const [iface, list] of Object.entries(ifaces)) {
    const virtual = isVirtualIface(iface)
    for (const item of list || []) {
      if (!item || item.family !== 'IPv4' || item.internal) continue
      out.push({ iface, address: item.address, virtual, reachable: !virtual && !isReservedIPv4(item.address) })
    }
  }
  return out
}

/**
 * 启动一个把 `0.0.0.0:<port>` 的 HTTP/WS 流量转发到 `127.0.0.1:<upstream>` 的代理。
 * `getUpstreamPort` 每次请求时调用，确保宿主端口在 listen 之后才解析。
 */
function createForwarder(getUpstreamPort) {
  const sockets = new Set()
  const state = { listening: false, port: undefined, error: undefined }
  let server
  let boundPort

  function forwardHttp(req, res) {
    const port = getUpstreamPort()
    if (!port) {
      sendJson(res, 502, { error: 'upstream-unavailable' })
      return
    }
    const headers = {}
    for (const [rawName, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      const lower = rawName.toLowerCase()
      if (HOP_BY_HOP.has(lower)) continue
      headers[rawName] = Array.isArray(value) ? value.join(', ') : value
    }
    // 关键：把上游请求伪装成「本机 loopback 桌面访问」。
    // dsh 的 Host/Origin 栅栏只接受绑定地址与受信任 authority；LAN IP 会被 403。
    // 改成 loopback authority 后，页面、/api、cookies 全部按本机访问处理：
    //  - 浏览器看到的地址栏仍是 LAN authority，Set-Cookie（host-only）按它存储；
    //  - cookie 内容与请求 Host 都是 loopback，admit 校验一致通过。
    const authority = `127.0.0.1:${port}`
    headers.host = authority
    if (headers.origin !== undefined) headers.origin = `http://${authority}`
    if (headers.referer !== undefined) headers.referer = `http://${authority}/`
    headers['sec-fetch-site'] = 'same-origin'
    const upstream = httpRequest(
      { host: '127.0.0.1', port, path: req.url, method: req.method, headers },
      (upstreamRes) => {
        const out = {}
        for (const [rawName, value] of Object.entries(upstreamRes.headers)) {
          if (value === undefined) continue
          if (HOP_BY_HOP.has(rawName.toLowerCase())) continue
          out[rawName] = value
        }
        try {
          res.writeHead(upstreamRes.statusCode || 502, out)
        } catch {
          res.destroy()
          return
        }
        upstreamRes.pipe(res)
        upstreamRes.on('error', () => res.destroy())
      },
    )
    upstream.on('error', () => {
      try {
        if (!res.headersSent) sendJson(res, 502, { error: 'upstream-error' })
        else res.destroy()
      } catch {
        /* ignore */
      }
    })
    req.on('error', () => upstream.destroy())
    req.pipe(upstream)
  }

  function forwardUpgrade(req, socket, head) {
    const port = getUpstreamPort()
    if (!port) {
      socket.destroy()
      return
    }
    const upstream = connect(port, '127.0.0.1', () => {
      const lines = [`${req.method || 'GET'} ${req.url || '/'} HTTP/1.1`]
      const raw = req.rawHeaders
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const lower = String(raw[i]).toLowerCase()
        if (lower === 'host' || lower === 'origin' || lower === 'referer') continue
        lines.push(`${raw[i]}: ${raw[i + 1]}`)
      }
      lines.push(`Host: 127.0.0.1:${port}`)
      lines.push(`Origin: http://127.0.0.1:${port}`)
      lines.push(`X-Forwarded-Proto: http`)
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head && head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
    socket.on('close', () => upstream.destroy())
    upstream.on('close', () => socket.destroy())
  }

  function start(port) {
    if (server) return Promise.resolve(state)
    return new Promise((resolve) => {
      const next = createServer(forwardHttp)
      next.on('upgrade', forwardUpgrade)
      next.on('connection', (socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
      })
      next.on('error', (error) => {
        const reason = error && error.code ? `${error.code}: ${error.message}` : String(error && error.message ? error.message : error)
        state.listening = false
        state.error = reason
        if (server === next) server = undefined
        releaseSockets()
        resolve(state)
      })
      server = next
      next.listen(port, '0.0.0.0', () => {
        const address = next.address()
        boundPort = typeof address === 'object' && address !== null ? address.port : port
        state.listening = true
        state.port = boundPort
        state.error = undefined
        resolve(state)
      })
    })
  }

  function releaseSockets() {
    for (const socket of sockets) {
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
    }
    sockets.clear()
  }

  function stop() {
    const current = server
    server = undefined
    state.listening = false
    releaseSockets()
    if (!current) return Promise.resolve()
    return new Promise((resolve) => {
      try {
        current.close(() => resolve())
      } catch {
        resolve()
      }
    })
  }

  function snapshot() {
    return { listening: state.listening, port: state.port, error: state.error }
  }

  return { start, stop, snapshot }
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  const webServer = ctx.webServer || (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined)
  const connection = ctx.connection || (typeof ctx.get === 'function' ? ctx.get('connection') : undefined)
  const getWebApp = () => (typeof ctx.get === 'function' ? ctx.get('webApp') : undefined)
  if (!webServer || typeof webServer.register !== 'function') {
    try {
      console.warn('[lan-access] webServer unavailable; plugin inactive')
    } catch {
      /* ignore */
    }
    return
  }

  const upstreamPort = () => {
    try {
      return originPort(webServer.getOrigin())
    } catch {
      return undefined
    }
  }

  const forwarder = createForwarder(upstreamPort)

  /** 生成某个 authority 的「首次登录」URL；connection 不可用时退化为普通 URL。 */
  function accessUrl(address) {
    const base = `http://${address}:${cfg.port}/`
    if (connection && typeof connection.authenticatedUrl === 'function') {
      try {
        return connection.authenticatedUrl(base)
      } catch {
        /* fall through */
      }
    }
    return base
  }

  /** 组装给面板的快照。 */
  function snapshot() {
    const state = forwarder.snapshot()
    const upPort = upstreamPort()
    let advertised = ''
    try {
      const app = getWebApp()
      advertised = app && typeof app.getAdvertisedUrl === 'function' ? app.getAdvertisedUrl() : ''
    } catch {
      advertised = ''
    }
    const addresses = collectAddresses()
    const links = addresses.map((entry) => ({
      iface: entry.iface,
      address: entry.address,
      virtual: entry.virtual,
      reachable: entry.reachable,
      url: accessUrl(entry.address),
    }))
    return {
      enabled: cfg.enabled,
      listening: state.listening,
      listenHost: '0.0.0.0',
      port: state.port !== undefined ? state.port : cfg.port,
      configuredPort: cfg.port,
      error: state.error,
      upstreamPort: upPort,
      advertised,
      addresses,
      links,
    }
  }

  // 1) 信息路由（挂载在宿主 webServer 上，面板用同源 fetch 读取）。
  const INFO_PATH = '/lan-access/info'
  const infoHandler = (req, res) => {
    try {
      const rejection = connection && typeof connection.requestRejection === 'function'
        ? connection.requestRejection(req)
        : undefined
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405
        res.setHeader('allow', 'GET, HEAD')
        res.end()
        return
      }
      sendJson(res, 200, snapshot())
    } catch (error) {
      sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
    }
  }

  const registerInfo = () => webServer.register({ kind: 'exact', path: INFO_PATH, handler: infoHandler })
  if (typeof ctx.effect === 'function') ctx.effect(registerInfo, 'lan-access: info route')
  else registerInfo()

  // 2) 局域网代理。
  if (cfg.enabled) {
    const startProxy = () => {
      forwarder.start(cfg.port).catch(() => undefined)
    }
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => {
        startProxy()
        return () => {
          void forwarder.stop()
        }
      }, 'lan-access: forwarder')
    } else {
      startProxy()
    }
  }
}
