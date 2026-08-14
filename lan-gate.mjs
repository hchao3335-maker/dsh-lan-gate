// DSH 内网访问网关（最终版，自包含）
// 功能：局域网设备经 0.0.0.0:3088 反向代理访问本机 DSH；首次访问需本机批准；
//       每台设备可指定访问方式（自动/手机/电脑）；手机模式注入紧凑排版。
// 安全：设备令牌 + Cookie 绑定（一次批准只绑定一个浏览器，令牌一次性认领）；
//       每 IP 每分钟限流（默认 120，超限 429）；监听地址可用 LAN_GATE_HOST 收紧为 127.0.0.1；
//       环境变量 LAN_GATE_PORT / LAN_GATE_HOST 可覆盖端口与监听地址。
// 管理面板：注入到 DSH「设置」界面（设置 → 内网访问）。
// 落点：.dsh/profiles/web/cordis.patch.yml（DSH 重启后自动加载，进程内运行，无子进程）。

import { networkInterfaces, homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'

export const name = 'lan-gate'
export const inject = ['webServer']

// 可用环境变量快速覆盖：LAN_GATE_PORT / LAN_GATE_HOST
const PROXY_PORT = Number(process.env.LAN_GATE_PORT || 3088)
// 使用前置反向代理/隧道时建议改为 '127.0.0.1'（也可用环境变量覆盖）
const LISTEN_HOST = process.env.LAN_GATE_HOST || '0.0.0.0'
// 每 IP 每分钟请求上限（滑动窗口），超限返回 429
const RATE_LIMIT_PER_MIN = 120
const TARGET_HOST = '127.0.0.1'
const TARGET_PORT = 3080

function dshHome() {
  return process.env.DSH_HOME || path.join(homedir(), '.dsh')
}

function stateFile() {
  return path.join(dshHome(), 'lan-gate-state.json')
}

function loadDecisions() {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    if (raw && typeof raw === 'object' && raw.decisions && typeof raw.decisions === 'object') return raw.decisions
  } catch (_err) {
    // 状态文件不存在或损坏时按空记录处理
  }
  return {}
}

function saveDecisions(decisions) {
  try {
    fs.mkdirSync(dshHome(), { recursive: true })
    const tmp = stateFile() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ decisions }, null, 2), 'utf8')
    fs.renameSync(tmp, stateFile())
  } catch (_err) {
    // 持久化失败不影响运行态
  }
}

function lanIps() {
  const result = []
  const ifaces = networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info && info.family === 'IPv4' && !info.internal) result.push(info.address)
    }
  }
  return result
}

function normalizeIp(raw) {
  return String(raw || '').replace(/^::ffff:/, '')
}

function isLoopbackIp(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost'
}

function deviceKind(decisions, ip) {
  const d = decisions[ip]
  if (!d || d.allow !== true || d.revoked === true) return undefined
  return d.kind === 'phone' || d.kind === 'desktop' ? d.kind : undefined
}

function isAllowed(decisions, ip) {
  const d = decisions[ip]
  return d !== undefined && d.allow === true && d.revoked !== true
}

function randomToken() {
  return randomBytes(16).toString('hex')
}

function parseCookies(req) {
  const out = {}
  const header = req.headers.cookie
  if (typeof header !== 'string' || header === '') return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (key !== '') out[key] = value
  }
  return out
}

function queryTicket(url) {
  const q = String(url || '').indexOf('?')
  if (q < 0) return undefined
  const m = url.slice(q + 1).match(/(?:^|&)t=([^&]*)/)
  return m ? decodeURIComponent(m[1]) : undefined
}

function setTokenCookie(res, token, secure) {
  const flags = 'Path=/; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : '')
  res.setHeader('Set-Cookie', 'lg_token=' + token + '; ' + flags)
}

// ---- 门禁页面（手机端优化版） ----

function gatePage(title, body) {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
    + '<meta name="theme-color" content="#0f1115">'
    + '<title>' + title + '</title><style>'
    + '*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}'
    + 'html,body{margin:0;padding:0}'
    + 'body{min-height:100dvh;display:flex;align-items:center;justify-content:center;'
    + 'font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;'
    + 'background:radial-gradient(1100px 700px at 50% -10%,#1b2233 0%,#0f1115 55%);color:#e6e8ec;'
    + 'padding:max(20px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) '
    + 'max(20px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));'
    + '-webkit-text-size-adjust:100%;text-size-adjust:100%}'
    + '.card{width:100%;max-width:460px;margin:0 auto;padding:38px 26px 30px;'
    + 'border:1px solid #2a2f3a;border-radius:20px;background:#161a22;text-align:center;'
    + 'box-shadow:0 20px 60px rgba(0,0,0,.45)}'
    + '.logo{width:56px;height:56px;margin:0 auto 18px;border-radius:16px;'
    + 'background:linear-gradient(135deg,#4c8dff,#7a5cff);display:flex;align-items:center;justify-content:center;'
    + 'font-size:24px;font-weight:700;color:#fff}'
    + 'h1{font-size:21px;margin:0 0 6px}'
    + '.sub{font-size:14px;color:#9aa3b2;margin:0 0 16px}'
    + '.ip{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:15px;color:#8fa3c8;'
    + 'background:#0b0e14;border:1px solid #232a37;border-radius:10px;padding:10px 16px;'
    + 'display:inline-block;margin:10px 0 4px;word-break:break-all}'
    + '.spinner{width:38px;height:38px;margin:20px auto;border-radius:50%;'
    + 'border:3px solid #2a2f3a;border-top-color:#4c8dff;animation:spin .9s linear infinite}'
    + '@keyframes spin{to{transform:rotate(360deg)}}'
    + 'p{font-size:14px;line-height:1.8;color:#9aa3b2;margin:8px 0}'
    + '.bar{height:3px;border-radius:99px;background:#232a37;overflow:hidden;margin:20px auto 0;max-width:220px}'
    + '.bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#4c8dff,#7a5cff);animation:fill 2.5s linear infinite}'
    + '@keyframes fill{from{width:0}to{width:100%}}'
    + '.btn{display:inline-block;margin-top:18px;padding:11px 30px;font-size:15px;font-weight:600;'
    + 'border:1px solid #4c8dff;color:#9cc0ff;background:rgba(76,141,255,.08);border-radius:12px;'
    + 'cursor:pointer;text-decoration:none;touch-action:manipulation;user-select:none}'
    + '.btn:active{background:rgba(76,141,255,.22)}'
    + '.bad{color:#f0716f}'
    + '</style></head><body><div class="card">' + body + '</div></body></html>'
}

function pendingPage(ip) {
  return gatePage('等待本机批准 · DSH 内网访问',
    '<div class="logo">DSH</div>'
    + '<h1>正在等待本机批准</h1>'
    + '<p class="sub">首次访问需要电脑端确认</p>'
    + '<div class="spinner"></div>'
    + '<p>设备</p><span class="ip">' + ip + '</span>'
    + '<p>请在电脑上的 DSH 界面批准此设备：<br>设置 → 内网访问 → 允许</p>'
    + '<a class="btn" href="javascript:location.reload()">立即检查</a>'
    + '<div class="bar"><i></i></div>'
    + '<script>setTimeout(function(){location.reload()},2500)</script>')
}

function deniedPage(ip) {
  return gatePage('访问被拒绝 · DSH 内网访问',
    '<div class="logo">DSH</div>'
    + '<h1>访问被拒绝</h1>'
    + '<p class="sub">本机未批准此设备</p>'
    + '<p class="bad">设备 ' + ip + ' 未被允许访问本机的 DSH。</p>'
    + '<p>如需重新允许，请在本机 DSH 的「设置 → 内网访问」页面操作。</p>'
    + '<a class="btn" href="javascript:location.reload()">重新检查</a>'
    + '<script>setTimeout(function(){location.reload()},4000)</script>')
}

function boundPage(ip) {
  return gatePage('需要重新授权 · DSH 内网访问',
    '<div class="logo">DSH</div>'
    + '<h1>此设备的访问令牌已绑定到其他浏览器</h1>'
    + '<p class="sub">出于安全考虑，一次批准只绑定一个浏览器</p>'
    + '<p class="bad">设备 ' + ip + ' 的令牌已发放给其他浏览器。</p>'
    + '<p>如需在本浏览器使用，请在本机 DSH 的「设置 → 内网访问」中撤销该设备后重新批准。</p>'
    + '<a class="btn" href="javascript:location.reload()">重新检查</a>')
}

function rateLimitPage(ip) {
  return gatePage('请求过于频繁 · DSH 内网访问',
    '<div class="logo">DSH</div>'
    + '<h1>请求过于频繁</h1>'
    + '<p class="sub">已触发每分钟请求上限</p>'
    + '<p class="bad">设备 ' + ip + ' 的请求频率超过了每分钟 ' + RATE_LIMIT_PER_MIN + ' 次的限制。</p>'
    + '<p>请稍等一分钟后再试。</p>'
    + '<a class="btn" href="javascript:location.reload()">重新加载</a>')
}

// ---- 反向代理（进程内，含 Host 重写与设备属性注入） ----

function cleanHeaders(headers, clientIp) {
  const drop = { host: 1, origin: 1, connection: 1, 'proxy-connection': 1, 'keep-alive': 1, te: 1, trailer: 1, 'transfer-encoding': 1, upgrade: 1, 'proxy-authorization': 1, 'proxy-authenticate': 1 }
  const out = {}
  for (const key of Object.keys(headers || {})) {
    if (drop[String(key).toLowerCase()]) continue
    out[key] = headers[key]
  }
  out['host'] = TARGET_HOST + ':' + TARGET_PORT
  out['x-forwarded-for'] = clientIp
  return out
}

function injectDeviceAttr(html, kind) {
  const m = html.match(/<html[^>]*/i)
  if (!m) return html
  return html.slice(0, m.index) + m[0] + ' data-lan-device="' + kind + '"' + html.slice(m.index + m[0].length)
}

function forwardRequest(decisions, req, res, clientIp) {
  const headers = cleanHeaders(req.headers, clientIp)
  const upstream = http.request({
    host: TARGET_HOST,
    port: TARGET_PORT,
    method: req.method,
    path: req.url,
    headers: headers,
  }, (upRes) => {
    const outHeaders = {}
    for (const key of Object.keys(upRes.headers)) outHeaders[key] = upRes.headers[key]
    const contentType = String(outHeaders['content-type'] || '')
    const isHtml = contentType.indexOf('text/html') >= 0
    if (isHtml) outHeaders['cache-control'] = 'no-store'
    const kind = deviceKind(decisions, clientIp)
    if (isHtml && kind !== undefined) {
      const chunks = []
      let size = 0
      let sent = false
      const flush = () => {
        if (sent) return
        sent = true
        try {
          let html = Buffer.concat(chunks).toString('utf8')
          html = injectDeviceAttr(html, kind)
          res.writeHead(upRes.statusCode || 502, outHeaders)
          res.end(html)
        } catch (_err) {
          try { res.end() } catch (_err2) { /* 连接已关闭 */ }
        }
      }
      upRes.on('data', (chunk) => {
        if (sent) return
        if (size + chunk.length > 524288) { flush(); return }
        size += chunk.length
        chunks.push(chunk)
      })
      upRes.on('end', flush)
      upRes.on('error', flush)
      return
    }
    try { res.writeHead(upRes.statusCode || 502, outHeaders) } catch (_err) { /* 头部已发送 */ }
    upRes.pipe(res)
  })
  upstream.on('error', () => {
    try {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Bad Gateway')
    } catch (_err) { /* 连接已关闭 */ }
  })
  res.on('close', () => { try { upstream.destroy() } catch (_err) { /* 已销毁 */ } })
  req.pipe(upstream)
}

// ---- 主页注入：polyfill + 设备排版 + 设置界面管理面板 ----

const UUID_POLYFILL = 'if(typeof crypto!=="undefined"&&typeof crypto.randomUUID!=="function"){crypto.randomUUID=function(){var b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;var h=Array.prototype.map.call(b,function(x){return x.toString(16).padStart(2,"0")}).join("");return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20)}}'

const DEVICE_CSS = '<style>'
  + 'html[data-lan-device="phone"]{-webkit-text-size-adjust:100%;text-size-adjust:100%}'
  + 'html[data-lan-device="phone"] [data-slot="conversation"] [data-phase]{--dsh-composer-side-clearance:2px;--dsw-font-s-14-font-size:12px;--dsw-font-xs-13-font-size:11px;--dsw-font-xxs-12-font-size:10.5px;--dsw-font-xxxs-11-font-size:9.5px}'
  + 'html[data-lan-device="phone"] [data-slot="conversation"] [data-phase]{--dsw-font-markdown-base-font-size:13.5px;--dsw-font-markdown-base-strong-font-size:13.5px;--dsw-font-markdown-base-italic-font-size:13.5px;--dsw-font-markdown-base-strong-italic-font-size:13.5px;--dsw-font-markdown-small-font-size:12px;--dsw-font-markdown-small-strong-font-size:12px;--dsw-font-markdown-small-italic-font-size:12px;--dsw-font-markdown-small-strong-italic-font-size:12px;--dsw-font-markdown-code-font-size:11.5px;--dsw-font-markdown-code-block-font-size:11px;--dsw-font-markdown-code-block-small-font-size:10px;--dsw-font-markdown-table-font-size:12px;--dsw-font-markdown-table-head-font-size:12px;--dsw-font-markdown-h1-font-size:17px;--dsw-font-markdown-h2-font-size:15px;--dsw-font-markdown-h3-font-size:14px;--dsw-font-markdown-h4-font-size:13px}'
  + 'html[data-lan-device="phone"] [data-chat-flow]{line-height:1.4;gap:6px}'
  + 'html[data-lan-device="phone"] [data-chat-flow] pre{font-size:11px;max-width:100%}'
  + 'html[data-lan-device="phone"] [data-slot="conversation"] input,html[data-lan-device="phone"] [data-slot="conversation"] textarea{font-size:16px}'
  + 'html[data-lan-device="phone"] [data-slot="conversation"] button,html[data-lan-device="phone"] [data-slot="sidebar"] button{min-height:32px;touch-action:manipulation}'
  + 'html[data-lan-device="phone"] [data-slot="conversation"],html[data-lan-device="phone"] [data-slot="sidebar"]{-webkit-tap-highlight-color:transparent}'
  + 'html[data-lan-device="phone"] [data-composer-card] button{min-height:28px}'
  + 'html[data-lan-device="phone"] [data-composer-card] select{max-width:120px;font-size:12px;height:24px;padding:0 14px 0 6px}'
  + 'html[data-lan-device="phone"] [data-composer-card] > div:last-child > div:first-child{gap:8px}'
  + 'html[data-lan-device="phone"] [data-composer-card] > div:last-child > div:last-child{flex:0 1 auto;min-width:0;gap:8px}'
  + 'html[data-lan-device="phone"] [role="dialog"][aria-modal="true"]{display:flex;flex-direction:column;width:100vw;height:100dvh;max-width:100vw;max-height:100dvh;border-radius:0}'
  + 'html[data-lan-device="phone"] [role="presentation"]:has([role="dialog"]){padding:0}'
  + 'html[data-lan-device="phone"] [role="dialog"][aria-modal="true"] nav{width:100%;flex:none;flex-direction:column;gap:6px;padding:10px 12px 6px}'
  + 'html[data-lan-device="phone"] [role="dialog"][aria-modal="true"] nav>div:last-child{display:flex;flex-direction:row;flex-wrap:nowrap;overflow-x:auto;gap:4px}'
  + 'html[data-lan-device="phone"] [role="dialog"][aria-modal="true"] > div:last-child{flex:1;min-height:0}'
  + 'html[data-lan-device="phone"] [role="dialog"][aria-modal="true"] > div:last-child > div:last-child{flex:1;min-height:0;overflow-y:auto}'
  + 'html[data-lan-device="phone"] [data-slot="conversation.input.model"] [role="menu"]{position:fixed;right:max(8px,env(safe-area-inset-right));left:auto;top:96px;bottom:auto;width:min(240px,calc(100vw - 72px));max-height:min(360px,calc(100dvh - 150px));z-index:120}'
  + 'html[data-lan-device="phone"] [data-composer-card] [role="dialog"]{position:fixed;right:max(8px,env(safe-area-inset-right));left:auto;top:96px;bottom:90px;width:min(320px,calc(100vw - 72px));max-height:min(420px,calc(100dvh - 200px));z-index:120}'
  + '@media (max-width:820px){'
  + 'html:not([data-lan-device="desktop"]){-webkit-text-size-adjust:100%;text-size-adjust:100%}'
  + 'html:not([data-lan-device="desktop"]) [data-slot="conversation"] [data-phase]{--dsh-composer-side-clearance:2px;--dsw-font-s-14-font-size:12px;--dsw-font-xs-13-font-size:11px;--dsw-font-xxs-12-font-size:10.5px;--dsw-font-xxxs-11-font-size:9.5px}'
  + 'html:not([data-lan-device="desktop"]) [data-slot="conversation"] [data-phase]{--dsw-font-markdown-base-font-size:13.5px;--dsw-font-markdown-base-strong-font-size:13.5px;--dsw-font-markdown-base-italic-font-size:13.5px;--dsw-font-markdown-base-strong-italic-font-size:13.5px;--dsw-font-markdown-small-font-size:12px;--dsw-font-markdown-small-strong-font-size:12px;--dsw-font-markdown-small-italic-font-size:12px;--dsw-font-markdown-small-strong-italic-font-size:12px;--dsw-font-markdown-code-font-size:11.5px;--dsw-font-markdown-code-block-font-size:11px;--dsw-font-markdown-code-block-small-font-size:10px;--dsw-font-markdown-table-font-size:12px;--dsw-font-markdown-table-head-font-size:12px;--dsw-font-markdown-h1-font-size:17px;--dsw-font-markdown-h2-font-size:15px;--dsw-font-markdown-h3-font-size:14px;--dsw-font-markdown-h4-font-size:13px}'
  + 'html:not([data-lan-device="desktop"]) [data-chat-flow]{line-height:1.4;gap:6px}'
  + 'html:not([data-lan-device="desktop"]) [data-chat-flow] pre{font-size:11px;max-width:100%}'
  + 'html:not([data-lan-device="desktop"]) [data-slot="conversation"] input,html:not([data-lan-device="desktop"]) [data-slot="conversation"] textarea{font-size:16px}'
  + 'html:not([data-lan-device="desktop"]) [data-slot="conversation"] button,html:not([data-lan-device="desktop"]) [data-slot="sidebar"] button{min-height:32px;touch-action:manipulation}'
  + 'html:not([data-lan-device="desktop"]) [data-slot="conversation"],html:not([data-lan-device="desktop"]) [data-slot="sidebar"]{-webkit-tap-highlight-color:transparent}'
  + 'html:not([data-lan-device="desktop"]) [data-composer-card] button{min-height:28px}'
  + 'html:not([data-lan-device="desktop"]) [data-composer-card] select{max-width:120px;font-size:12px;height:24px;padding:0 14px 0 6px}'
  + 'html:not([data-lan-device="desktop"]) [data-composer-card] > div:last-child > div:first-child{gap:8px}'
  + 'html:not([data-lan-device="desktop"]) [data-composer-card] > div:last-child > div:last-child{flex:0 1 auto;min-width:0;gap:8px}'
  + 'html:not([data-lan-device="desktop"]) [role="dialog"][aria-modal="true"]{display:flex;flex-direction:column;width:100vw;height:100dvh;max-width:100vw;max-height:100dvh;border-radius:0}'
  + 'html:not([data-lan-device="desktop"]) [role="presentation"]:has([role="dialog"]){padding:0}'
  + 'html:not([data-lan-device="desktop"]) [role="dialog"][aria-modal="true"] nav{width:100%;flex:none;flex-direction:column;gap:6px;padding:10px 12px 6px}'
  + 'html:not([data-lan-device="desktop"]) [role="dialog"][aria-modal="true"] nav>div:last-child{display:flex;flex-direction:row;flex-wrap:nowrap;overflow-x:auto;gap:4px}'
  + 'html:not([data-lan-device="desktop"]) [role="dialog"][aria-modal="true"] > div:last-child{flex:1;min-height:0}'
  + 'html:not([data-lan-device="desktop"]) [role="dialog"][aria-modal="true"] > div:last-child > div:last-child{flex:1;min-height:0;overflow-y:auto}'
  + 'html:not([data-lan-device="desktop"]) [data-slot="conversation.input.model"] [role="menu"]{position:fixed;right:max(8px,env(safe-area-inset-right));left:auto;top:96px;bottom:auto;width:min(240px,calc(100vw - 72px));max-height:min(360px,calc(100dvh - 150px));z-index:120}'
  + 'html:not([data-lan-device="desktop"]) [data-composer-card] [role="dialog"]{position:fixed;right:max(8px,env(safe-area-inset-right));left:auto;top:96px;bottom:90px;width:min(320px,calc(100vw - 72px));max-height:min(420px,calc(100dvh - 200px));z-index:120}'
  + '}'
  + '</style>'

const PANEL_CSS = '<style>'
  + '.lg-nav-cell{display:flex;align-items:center;gap:8px;height:40px;padding:9px 16px 9px 12px;box-sizing:border-box;border:none;border-radius:12px;background:transparent;cursor:pointer;font-family:inherit;font-size:14px;line-height:22px;font-weight:400;color:var(--dsw-alias-label-primary);text-align:left;white-space:nowrap;flex:none}'
  + '.lg-nav-cell:hover{background:var(--dsw-specific-sidebar-nav-item-hover,var(--dsw-alias-bg-layer-2))}'
  + '.lg-nav-active{background:var(--dsw-specific-sidebar-nav-item-active,var(--dsw-alias-bg-layer-2))}'
  + '.lg-section-on button:not([data-lg-nav]){background:transparent;color:var(--dsw-alias-label-primary);font-weight:400}'
  + '.lg-nav-icon{flex:none}'
  + '.lg-panel{display:flex;flex-direction:column;gap:10px}'
  + '.lg-panel .lg-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}'
  + '.lg-panel .lg-badge{display:inline-flex;align-items:center;font-size:12px;border-radius:999px;padding:3px 10px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}'
  + '.lg-panel .lg-badge-running{color:var(--dsw-alias-state-success-primary);border-color:currentColor}'
  + '.lg-panel .lg-badge-starting{color:var(--dsw-alias-state-warn-primary);border-color:currentColor}'
  + '.lg-panel .lg-badge-error{color:var(--dsw-alias-state-error-primary);border-color:currentColor}'
  + '.lg-panel .lg-badge-stopped{color:var(--dsw-alias-state-error-primary);border-color:currentColor}'
  + '.lg-panel .lg-label{font-size:13px;font-weight:600;margin:10px 0 6px;color:var(--dsw-alias-label-primary)}'
  + '.lg-panel .lg-muted{color:var(--dsw-alias-label-secondary);font-size:13px;margin:4px 0}'
  + '.lg-panel .lg-small{font-size:12px}'
  + '.lg-panel .lg-ip{font-family:ui-monospace,Consolas,monospace;font-size:13px;color:var(--dsw-alias-label-primary)}'
  + '.lg-panel .lg-url{font-family:ui-monospace,Consolas,monospace;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 10px;margin:4px 0;word-break:break-all;cursor:pointer}'
  + '.lg-panel .lg-item{padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}'
  + '.lg-panel .lg-item:last-child{border-bottom:none}'
  + '.lg-panel .lg-row{display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap}'
  + '.lg-panel .lg-btn{font-size:12px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 12px;cursor:pointer}'
  + '.lg-panel .lg-btn:hover{background:var(--dsw-alias-bg-layer-2)}'
  + '.lg-panel .lg-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}'
  + '.lg-panel .lg-btn-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}'
  + '.lg-panel .lg-kind-on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}'
  + '.lg-panel .lg-error{color:var(--dsw-alias-state-error-primary);font-size:13px;margin:4px 0}'
  + '.lg-nav-holder{flex:1;min-height:0;overflow-y:auto;padding:0 24px 24px}'
  + '</style>'

// 设置界面注入脚本：严格使用单引号；HTML 属性也用单引号，避免转义问题。
const PANEL_JS = '<scr' + 'ipt>'
  + '(function(){'
  + 'var KIND={auto:\'自动\',phone:\'手机\',desktop:\'电脑\'};'
  + 'var STATE={running:\'运行中\',starting:\'启动中\',stopped:\'已停止\',error:\'出错\'};'
  + 'var pendingKinds={};'
  + 'var active=false;'
  + 'var timer=null;'
  + 'var optionsNode=null;'
  + 'var panelNode=null;'
  + 'var cell=null;'
  + 'function esc(s){return String(s==null?\'\':s).replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/\'/g,\'&#39;\').replace(/"/g,\'&quot;\')}'
  + 'function fmt(ms){return ms?new Date(ms).toLocaleString():\'\'}'
  + 'function kindBtns(cur,act,ip){'
  + 'var h=\'<span class="lg-muted">访问方式：</span>\';'
  + 'var ks=[\'auto\',\'phone\',\'desktop\'];'
  + 'for(var i=0;i<ks.length;i++){var k=ks[i];h+=\'<button class="lg-btn\'+(cur===k?\' lg-kind-on\':\'\')+\'" data-act="\'+act+\'" data-kind="\'+k+\'" data-ip="\'+ip+\'">\'+KIND[k]+\'</button>\'}'
  + 'return h}'
  + 'function post(action,ip,kind){'
  + 'fetch(\'/lan-gate/action\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},body:JSON.stringify({action:action,ip:ip||null,kind:kind||null})})'
  + '.then(function(){if(active)refresh()}).catch(function(){})}'
  + 'function refresh(){'
  + 'fetch(\'/lan-gate/status\').then(function(r){return r.json()}).then(render)'
  + '.catch(function(){if(panelNode)panelNode.innerHTML=\'<div class="lg-panel"><div class="lg-error">无法读取状态（插件可能未运行）</div></div>\'})}'
  + 'function render(s){'
  + 'if(!panelNode)return;'
  + 'var pending=s.pending||[],approved=s.approved||[],denied=s.denied||[];'
  + 'var h=\'<div class="lg-head"><span class="lg-badge lg-badge-\'+esc(s.state)+\'">\'+(STATE[s.state]||s.state)+\'</span>\';'
  + 'h+=(s.state===\'running\'||s.state===\'starting\')?\'<button class="lg-btn" data-act="stop">停止</button>\':\'<button class="lg-btn lg-btn-primary" data-act="restart">启动 / 重启</button>\';'
  + 'h+=\'</div><div class="lg-muted">端口 \'+esc(s.port)+\' · 转发到 \'+esc(s.target)+\'</div>\';'
  + 'if(s.state===\'running\'){'
  + 'h+=\'<div class="lg-label">内网访问地址（点击复制）</div>\';'
  + 'for(var i=0;i<(s.urls||[]).length;i++){h+=\'<div class="lg-url" data-copy="\'+esc(s.urls[i])+\'">\'+esc(s.urls[i])+\'</div>\'}}'
  + 'if(s.state===\'error\')h+=\'<div class="lg-error">错误：\'+esc(s.lastError||\'未知\')+\'</div>\';'
  + 'if(pending.length){'
  + 'h+=\'<div class="lg-label">待批准设备（先选访问方式再允许）</div>\';'
  + 'for(var j=0;j<pending.length;j++){var p=pending[j];var cur=pendingKinds[p.ip]||\'auto\';'
  + 'h+=\'<div class="lg-item"><div class="lg-ip">\'+esc(p.ip)+\'</div><div class="lg-muted lg-small">\'+esc(p.ua||\'\')+\'</div><div class="lg-row">\'+kindBtns(cur,\'kind\',p.ip)+\'</div><div class="lg-row"><button class="lg-btn lg-btn-primary" data-act="approve" data-ip="\'+esc(p.ip)+\'">允许</button><button class="lg-btn lg-btn-danger" data-act="deny" data-ip="\'+esc(p.ip)+\'">拒绝</button></div></div>\'}}'
  + 'if(approved.length){'
  + 'h+=\'<div class="lg-label">已批准设备（可为每台设备指定访问方式）</div>\';'
  + 'for(var a=0;a<approved.length;a++){var d=approved[a];var dk=d.kind||\'auto\';'
  + 'h+=\'<div class="lg-item"><div class="lg-ip">\'+esc(d.ip)+\' · \'+(KIND[dk]||\'自动\')+\'</div><div class="lg-muted lg-small">\'+fmt(d.at)+\'</div><div class="lg-row">\'+kindBtns(dk,\'set-kind\',d.ip)+\'</div><div class="lg-row"><button class="lg-btn" data-act="revoke" data-ip="\'+esc(d.ip)+\'">撤销</button></div></div>\'}'
  + 'h+=\'<div class="lg-row"><button class="lg-btn lg-btn-danger" data-act="revoke-all">全部撤销</button></div>\'}'
  + 'if(denied.length){'
  + 'h+=\'<div class="lg-label">已拒绝设备</div>\';'
  + 'for(var b=0;b<denied.length;b++){var dn=denied[b];h+=\'<div class="lg-item"><div class="lg-ip">\'+esc(dn.ip)+\'</div><div class="lg-row"><button class="lg-btn lg-btn-primary" data-act="approve" data-ip="\'+esc(dn.ip)+\'">重新允许</button></div></div>\'}}'
  + 'h+=\'<div class="lg-muted">说明：只有已批准设备的请求才会转发到本机 DSH；修改访问方式后该设备刷新页面即生效。</div>\';'
  + 'panelNode.innerHTML=\'<div class="lg-panel">\'+h+\'</div>\'}'
  + 'function startPoll(){stopPoll();timer=setInterval(function(){if(active)refresh()},2000)}'
  + 'function stopPoll(){if(timer){clearInterval(timer);timer=null}}'
  + 'function styleActive(){'
  + 'var all=document.querySelectorAll(\'.lg-nav-cell\');'
  + 'for(var i=0;i<all.length;i++){if(all[i]===cell&&active){all[i].classList.add(\'lg-nav-active\')}else{all[i].classList.remove(\'lg-nav-active\')}}'
  + 'var listNode=cell?cell.parentNode:null;'
  + 'if(listNode){if(active){listNode.classList.add(\'lg-section-on\')}else{listNode.classList.remove(\'lg-section-on\')}}}'
  + 'function attach(){'
  + 'var dialog=document.querySelector(\'[role="dialog"][aria-modal="true"]\');'
  + 'if(!dialog||dialog.getAttribute(\'data-lg-attached\'))return;'
  + 'var nav=dialog.querySelector(\'nav\');'
  + 'if(!nav)return;'
  + 'var kids=nav.children;'
  + 'var list=kids.length>1?kids[kids.length-1]:null;'
  + 'if(!list)return;'
  + 'var contentNode=dialog.children[dialog.children.length-1];'
  + 'if(!contentNode)return;'
  + 'var opts=contentNode.children[contentNode.children.length-1];'
  + 'if(!opts)return;'
  + 'dialog.setAttribute(\'data-lg-attached\',\'1\');'
  + 'fetch(\'/lan-gate/status\').then(function(r){'
  + 'if(r.status===403)return;'
  + 'optionsNode=opts;'
  + 'panelNode=document.createElement(\'div\');'
  + 'panelNode.className=\'lg-nav-holder\';'
  + 'panelNode.style.display=\'none\';'
  + 'contentNode.appendChild(panelNode);'
  + 'panelNode.addEventListener(\'click\',function(ev){'
  + 'var el=ev.target;'
  + 'if(!el||!el.getAttribute)return;'
  + 'var copy=el.getAttribute(\'data-copy\');'
  + 'if(copy){try{if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(copy)}catch(e){}return}'
  + 'var act=el.getAttribute(\'data-act\');'
  + 'if(!act)return;'
  + 'var ip=el.getAttribute(\'data-ip\');'
  + 'var kind=el.getAttribute(\'data-kind\');'
  + 'if(act===\'kind\'){pendingKinds[ip]=kind;refresh();return}'
  + 'if(act===\'approve\'){post(\'approve\',ip,pendingKinds[ip]||\'auto\');return}'
  + 'if(act===\'deny\'){post(\'deny\',ip);return}'
  + 'if(act===\'set-kind\'){post(\'set-kind\',ip,kind);return}'
  + 'if(act===\'revoke\'){post(\'revoke\',ip);return}'
  + 'if(act===\'revoke-all\'){post(\'revoke-all\');return}'
  + 'if(act===\'stop\'){post(\'stop\');return}'
  + 'if(act===\'restart\'){post(\'restart\');return}'
  + '});'
  + 'cell=document.createElement(\'button\');'
  + 'cell.type=\'button\';'
  + 'cell.className=\'lg-nav-cell\';'
  + 'cell.setAttribute(\'data-lg-nav\',\'1\');'
  + 'cell.innerHTML=\'<span class="lg-nav-icon">🌐</span><span>内网访问</span>\';'
  + 'cell.addEventListener(\'click\',function(ev){'
  + 'ev.stopPropagation();'
  + 'active=true;'
  + 'opts.style.display=\'none\';'
  + 'if(panelNode)panelNode.style.display=\'block\';'
  + 'styleActive();'
  + 'refresh();'
  + 'startPoll()});'
  + 'list.appendChild(cell);'
  + 'list.addEventListener(\'click\',function(ev){'
  + 'if(!ev.target.closest(\'[data-lg-nav]\')){active=false;stopPoll();opts.style.display=\'\';if(panelNode)panelNode.style.display=\'none\';styleActive()}}'
  + ',true)}).catch(function(){})}'
  + 'var mo=new MutationObserver(function(muts){'
  + 'for(var i=0;i<muts.length;i++){'
  + 'var nodes=muts[i].addedNodes;'
  + 'for(var j=0;j<nodes.length;j++){'
  + 'var n=nodes[j];'
  + 'if(n.nodeType===1&&(n.matches?n.matches(\'[role="dialog"][aria-modal="true"]\'):false)){attach();return}'
  + 'if(n.nodeType===1&&n.querySelector&&n.querySelector(\'[role="dialog"][aria-modal="true"]\')){attach();return}}}});'
  + 'mo.observe(document.body,{childList:true,subtree:true});'
  + 'attach();'
  + '})()'
  + '</scr' + 'ipt>'

function injectPanel(html) {
  if (typeof html !== 'string' || html === '') return html
  const headOpen = html.search(/<head[^>]*>/i)
  if (headOpen < 0) return html
  const headInsert = html.indexOf('>', headOpen) + 1
  const bodyOpen = html.search(/<body[^>]*>/i)
  if (bodyOpen < 0) return html
  const bodyInsert = html.indexOf('>', bodyOpen) + 1
  return html.slice(0, headInsert)
    + '<script>' + UUID_POLYFILL + '</script>' + DEVICE_CSS + PANEL_CSS
    + html.slice(headInsert, bodyInsert)
    + PANEL_JS
    + html.slice(bodyInsert)
}

// ---- 本机专属控制路由（经代理的设备会带 x-forwarded-for，仅放行本机） ----

function isLocalRequest(req) {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff !== 'string' || xff === '') return true
  const first = xff.split(',')[0].trim()
  if (isLoopbackIp(first)) return true
  return lanIps().indexOf(first) >= 0
}

function json(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

// ---- 插件主体 ----

export function apply(ctx) {
  const webServer = ctx.webServer
  const decisions = loadDecisions()
  const seen = {}
  const live = new Map()
  const rateMap = new Map()

  let server = null
  let running = false
  let userStopped = false
  let lastError = ''
  let starting = false

  function save() {
    saveDecisions(decisions)
  }

  function decide(ip, allow, kind) {
    const prev = decisions[ip]
    const nextKind = kind === 'phone' || kind === 'desktop'
      ? kind
      : (prev && (prev.kind === 'phone' || prev.kind === 'desktop') ? prev.kind : 'auto')
    decisions[ip] = { ip: ip, allow: allow, at: Date.now(), revoked: false, kind: nextKind, token: randomToken(), issued: false }
    save()
  }

  function revokeIp(ip) {
    const prev = decisions[ip]
    decisions[ip] = { ip: ip, allow: prev ? prev.allow === true : true, at: Date.now(), revoked: true, kind: prev && prev.kind ? prev.kind : 'auto' }
    save()
  }

  function buildStatus() {
    const pending = []
    const approved = []
    const denied = []
    for (const ip of Object.keys(decisions)) {
      const d = decisions[ip]
      if (d.revoked === true) continue
      if (d.allow === true) approved.push({ ip: ip, at: d.at, kind: d.kind || 'auto' })
      else if (d.allow === false) denied.push({ ip: ip, at: d.at })
    }
    for (const ip of Object.keys(seen)) {
      const d = decisions[ip]
      if (d && d.revoked !== true) continue
      pending.push({ ip: ip, firstSeen: seen[ip].firstSeen, ua: seen[ip].ua })
    }
    const ips = lanIps()
    return {
      state: userStopped ? 'stopped' : running ? 'running' : starting ? 'starting' : 'error',
      port: PROXY_PORT,
      target: TARGET_HOST + ':' + TARGET_PORT,
      urls: ips.map((ip) => 'http://' + ip + ':' + PROXY_PORT),
      pending: pending,
      approved: approved,
      denied: denied,
      lastError: lastError,
    }
  }

  function statusHandler(req, res) {
    if (!isLocalRequest(req)) { json(res, 403, { ok: false, reason: 'forbidden' }); return }
    json(res, 200, buildStatus())
  }

  function actionHandler(req, res) {
    if (!isLocalRequest(req)) { json(res, 403, { ok: false, reason: 'forbidden' }); return }
    if (req.method !== 'POST') { json(res, 405, { ok: false, reason: 'post-only' }); return }
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      if (size < 16384) { size += chunk.length; chunks.push(chunk) }
    })
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch (_err) { json(res, 400, { ok: false }); return }
      const action = String(body.action || '')
      const ip = String(body.ip || '')
      const kind = String(body.kind || '')
      if (action === 'approve') decide(ip, true, kind)
      else if (action === 'deny') decide(ip, false, 'auto')
      else if (action === 'set-kind') { if (decisions[ip] && decisions[ip].allow === true && decisions[ip].revoked !== true) decide(ip, true, kind) }
      else if (action === 'revoke') revokeIp(ip)
      else if (action === 'revoke-all') { for (const key of Object.keys(decisions)) revokeIp(key) }
      else if (action === 'stop') {
        userStopped = true
        if (server) { try { server.close() } catch (_err) { /* 已关闭 */ } server = null }
        running = false
      } else if (action === 'restart') {
        userStopped = false
        lastError = ''
        if (server) { try { server.close() } catch (_err) { /* 已关闭 */ } server = null }
        running = false
        setTimeout(startProxy, 300)
      } else { json(res, 400, { ok: false }); return }
      json(res, 200, { ok: true })
    })
  }

  function overRate(ip) {
    const now = Date.now()
    let rate = rateMap.get(ip)
    if (!rate || now - rate.started >= 60000) { rate = { started: now, count: 0 }; rateMap.set(ip, rate) }
    rate.count += 1
    return rate.count > RATE_LIMIT_PER_MIN
  }

  function startProxy() {
    if (server || userStopped) return
    starting = true
    const proxy = http.createServer((req, res) => {
      const ip = normalizeIp(req.socket.remoteAddress)
      if (overRate(ip)) {
        res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '60' })
        res.end(rateLimitPage(ip))
        return
      }
      if (isLoopbackIp(ip) || lanIps().indexOf(ip) >= 0) {
        forwardRequest(decisions, req, res, ip)
        return
      }
      const d = decisions[ip]
      if (d && d.allow === true && d.revoked !== true) {
        if (!d.token) { d.token = randomToken(); d.issued = false; save() }
        if (parseCookies(req).lg_token === d.token) {
          forwardRequest(decisions, req, res, ip)
          return
        }
        if (d.issued === true) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(boundPage(ip))
          return
        }
        if (queryTicket(req.url) === d.token) {
          d.issued = true
          save()
          setTokenCookie(res, d.token, false)
          res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' })
          res.end('')
          return
        }
        res.writeHead(302, { Location: '/?t=' + encodeURIComponent(d.token), 'Cache-Control': 'no-store' })
        res.end('')
        return
      }
      if (!seen[ip]) seen[ip] = { firstSeen: Date.now(), ua: String(req.headers['user-agent'] || '').slice(0, 160) }
      if (d && d.allow === false && d.revoked !== true) {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(deniedPage(ip))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(pendingPage(ip))
    })
    proxy.on('upgrade', (req, socket, head) => {
      const ip = normalizeIp(socket.remoteAddress)
      if (overRate(ip)) {
        try { socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n') } catch (_err) { /* 已关闭 */ }
        return
      }
      const d = decisions[ip]
      const ok = isLoopbackIp(ip) || lanIps().indexOf(ip) >= 0
        || (d !== undefined && d.allow === true && d.revoked !== true && d.token !== undefined && parseCookies(req).lg_token === d.token)
      if (!ok) {
        try { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n') } catch (_err) { /* 已关闭 */ }
        return
      }
      const headers = cleanHeaders(req.headers, ip)
      headers['upgrade'] = req.headers['upgrade'] || 'websocket'
      headers['connection'] = 'Upgrade'
      const upstream = net.connect(TARGET_PORT, TARGET_HOST, () => {
        let raw = req.method + ' ' + req.url + ' HTTP/1.1\r\n'
        for (const key of Object.keys(headers)) {
          const value = headers[key]
          if (Array.isArray(value)) {
            for (const v of value) raw += key + ': ' + v + '\r\n'
          } else {
            raw += key + ': ' + value + '\r\n'
          }
        }
        raw += '\r\n'
        let set = live.get(ip)
        if (!set) { set = new Set(); live.set(ip, set) }
        set.add(socket)
        set.add(upstream)
        const kill = () => {
          const s = live.get(ip)
          if (s) { s.delete(socket); s.delete(upstream); if (s.size === 0) live.delete(ip) }
          try { socket.destroy() } catch (_err) { /* 已销毁 */ }
          try { upstream.destroy() } catch (_err) { /* 已销毁 */ }
        }
        socket.on('error', kill)
        upstream.on('error', kill)
        socket.on('close', kill)
        upstream.on('close', kill)
        try { upstream.write(raw) } catch (_err) { /* 已关闭 */ }
        if (head && head.length > 0) { try { upstream.write(head) } catch (_err) { /* 已关闭 */ } }
        socket.pipe(upstream)
        upstream.pipe(socket)
      })
      upstream.on('error', () => { try { socket.destroy() } catch (_err) { /* 已销毁 */ } })
    })
    proxy.on('clientError', (_err, socket) => {
      try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n') } catch (_err2) { /* 已关闭 */ }
    })
    proxy.on('error', (err) => {
      lastError = String(err && err.message ? err.message : err)
      starting = false
      running = false
      server = null
    })
    proxy.listen(PROXY_PORT, LISTEN_HOST, () => {
      running = true
      starting = false
      lastError = ''
      console.log('[lan-gate] listening on ' + LISTEN_HOST + ':' + PROXY_PORT + ' -> ' + TARGET_HOST + ':' + TARGET_PORT)
    })
    server = proxy
  }

  ctx.effect(() => webServer.register({ kind: 'exact', path: '/lan-gate/status', handler: statusHandler }), 'lan-gate: status route')
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/lan-gate/action', handler: actionHandler }), 'lan-gate: action route')
  ctx.effect(() => webServer.tapIndex(injectPanel), 'lan-gate: index injection')

  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [ip, rate] of rateMap) {
      if (now - rate.started >= 120000) rateMap.delete(ip)
    }
    for (const [ip, set] of live) {
      if (isLoopbackIp(ip) || lanIps().indexOf(ip) >= 0 || isAllowed(decisions, ip)) continue
      for (const sock of set) { try { sock.destroy() } catch (_err) { /* 已销毁 */ } }
      live.delete(ip)
    }
  }, 3000)

  ctx.effect(() => {
    startProxy()
    return () => {
      clearInterval(sweep)
      userStopped = true
      const s = server
      server = null
      if (s) { try { s.close() } catch (_err) { /* 已关闭 */ } }
    }
  })
}
