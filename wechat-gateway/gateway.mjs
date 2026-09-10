/**
 * wechat-gateway — standalone WeChat (Weixin) bot gateway for DeepSeek Harness.
 *
 * A dependency-free Node service that speaks Tencent's official iLink bot
 * protocol: QR-code login, long-poll message delivery, and message sending.
 * It exposes a small HTTP + SSE surface so the DSH host plugin
 * (dsh-wechat-bot) and the browser floating-ball UI can drive it.
 *
 *   GET  /status          → { phase, qrcodeDataUrl?, qrcodeUrl?, accountId?, ... }
 *   POST /login           → start (or refresh) QR login
 *   POST /verifycode      → submit the numeric code WeChat shows after scanning
 *   POST /logout          → log out and stop the monitor
 *   GET  /events          → SSE: login/state, message, approval, send/result
 *   POST /send            → { to, text, contextToken? } send a text message
 *   GET  /allowlist       → approved wxids
 *   POST /allow           → { wxid, allow } approve/reject a sender
 *
 * Protocol core derived from @tencent-weixin/openclaw-weixin (MIT, Tencent):
 * https://github.com/Tencent/openclaw-weixin — same iLink API, no OpenClaw.
 *
 * Usage:  node gateway.mjs            (env: PORT=51235, STATE_DIR=~/.dsh-wechat)
 */

import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import QRCode from 'qrcode'

// ── configuration ──────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 51235)
const STATE_DIR = process.env.STATE_DIR?.trim() || path.join(os.homedir(), '.dsh-wechat')
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info'
const API_BASE = 'https://ilinkai.weixin.qq.com'
const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c'
/** iLink app identity (matches the official OpenClaw channel package). */
const ILINK_APP_ID = 'bot'
const ILINK_APP_CLIENT_VERSION = '0x00010000'
const CHANNEL_VERSION = 'dsh-wechat/0.1.0'
const BOT_AGENT = 'DSHWechat/0.1.0'
const STALE_TOKEN_ERRCODE = -14
/** Automatic reply sent to senders who are not yet approved. */
const UNAPPROVED_REPLY =
  process.env.UNAPPROVED_REPLY ||
  '⚠️ 该微信号尚未授权。请先在 DeepSeek Harness 的微信悬浮球面板中批准后重试。'

// ── logging ────────────────────────────────────────────────────────────────
const log = (level, msg) => {
  if (LOG_LEVEL === 'debug' || level !== 'debug') {
    console[level === 'error' ? 'error' : 'log'](
      `[gateway ${new Date().toISOString()}] ${level}: ${msg}`,
    )
  }
}

// ── storage ────────────────────────────────────────────────────────────────
const stateDir = () => STATE_DIR
const accountIndexPath = () => path.join(stateDir(), 'accounts.json')
const accountPath = (id) => path.join(stateDir(), 'accounts', `${id}.json`)
const syncBufPath = (id) => path.join(stateDir(), 'accounts', `${id}.sync.json`)
const allowlistPath = () => path.join(stateDir(), 'allowlist.json')

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch (error) {
    log('warn', `readJson ${file}: ${String(error)}`)
    return fallback
  }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf-8')
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* best effort */
  }
}
function listAccountIds() {
  const ids = readJson(accountIndexPath(), [])
  return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id.trim()) : []
}
function loadAccount(id) {
  return readJson(accountPath(id), null)
}
function saveAccount(id, update) {
  const existing = loadAccount(id) ?? {}
  const data = {
    ...(update.token?.trim() ? { token: update.token.trim(), savedAt: new Date().toISOString() } : {}),
    ...(update.baseUrl?.trim() ? { baseUrl: update.baseUrl.trim() } : {}),
    ...(update.userId !== undefined && update.userId.trim()
      ? { userId: update.userId.trim() }
      : {}),
    ...(existing.token && !update.token ? { token: existing.token, savedAt: existing.savedAt } : {}),
    ...(existing.baseUrl && !update.baseUrl ? { baseUrl: existing.baseUrl } : {}),
    ...(existing.userId && update.userId === undefined ? { userId: existing.userId } : {}),
  }
  writeJson(accountPath(id), data)
}
function registerAccountId(id) {
  const ids = listAccountIds()
  if (!ids.includes(id)) {
    ids.push(id)
    writeJson(accountIndexPath(), ids)
  }
}
function removeAccount(id) {
  for (const file of [accountPath(id), syncBufPath(id)]) {
    try {
      fs.unlinkSync(file)
    } catch {
      /* ignore */
    }
  }
  writeJson(
    accountIndexPath(),
    listAccountIds().filter((x) => x !== id),
  )
}
function loadSyncBuf(id) {
  return readJson(syncBufPath(id), '')
}
function saveSyncBuf(id, buf) {
  writeJson(syncBufPath(id), buf)
}
function loadAllowlist() {
  return readJson(allowlistPath(), [])
}
function isAllowed(wxid) {
  const list = loadAllowlist()
  return list.length === 0 || list.includes(wxid) // empty list = allow everyone
}
function setAllowed(wxid, allow) {
  let list = loadAllowlist()
  if (allow && !list.includes(wxid)) list.push(wxid)
  if (!allow) list = list.filter((x) => x !== wxid)
  writeJson(allowlistPath(), list)
  return list
}

// ── iLink protocol core (from @tencent-weixin/openclaw-weixin, MIT) ────────
function randomWechatUin() {
  const uint32 = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf-8').toString('base64')
}
function buildCommonHeaders() {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION,
  }
}
function buildHeaders(token) {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    ...buildCommonHeaders(),
    ...(token?.trim() ? { Authorization: `Bearer ${token.trim()}` } : {}),
  }
}
function buildBaseInfo() {
  return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT }
}
async function apiPost({ baseUrl, endpoint, body, token, timeoutMs, signal }) {
  const url = new URL(endpoint, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  const controller = timeoutMs !== undefined ? new AbortController() : undefined
  const timer =
    controller !== undefined && timeoutMs !== undefined
      ? setTimeout(() => controller.abort(), timeoutMs)
      : undefined
  const abort = () => controller?.abort()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: buildHeaders(token),
      body,
      ...(controller ? { signal: controller.signal } : {}),
    })
    const rawText = await res.text()
    if (!res.ok) throw new Error(`${endpoint} ${res.status}: ${rawText.slice(0, 200)}`)
    return rawText
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
async function apiGet({ baseUrl, endpoint, timeoutMs }) {
  const url = new URL(endpoint, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  const controller = timeoutMs !== undefined ? new AbortController() : undefined
  const timer =
    controller !== undefined ? setTimeout(() => controller.abort(), timeoutMs) : undefined
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: buildCommonHeaders(),
      ...(controller ? { signal: controller.signal } : {}),
    })
    const rawText = await res.text()
    if (!res.ok) throw new Error(`${endpoint} ${res.status}: ${rawText.slice(0, 200)}`)
    return rawText
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
async function fetchQRCode() {
  const localTokens = listAccountIds()
    .map((id) => loadAccount(id)?.token)
    .filter((t) => typeof t === 'string' && t.trim())
    .slice(-10)
  const raw = await apiPost({
    baseUrl: API_BASE,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent('3')}`,
    body: JSON.stringify({ local_token_list: localTokens }),
    timeoutMs: 15000,
  })
  return JSON.parse(raw)
}
async function pollQRStatus(qrcode, verifyCode, baseUrl = API_BASE) {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`
  try {
    return JSON.parse(
      await apiGet({ baseUrl, endpoint, timeoutMs: 35000 }),
    )
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return { status: 'wait' }
    log('warn', `pollQRStatus: ${String(error)}`)
    return { status: 'wait' }
  }
}
async function getUpdates({ baseUrl, token, get_updates_buf, timeoutMs, signal }) {
  try {
    const raw = await apiPost({
      baseUrl,
      endpoint: 'ilink/bot/getupdates',
      body: JSON.stringify({
        get_updates_buf: get_updates_buf ?? '',
        base_info: buildBaseInfo(),
      }),
      token,
      timeoutMs,
      signal,
    })
    return JSON.parse(raw)
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: get_updates_buf ?? '' }
    }
    throw error
  }
}
async function sendMessage({ baseUrl, token, body, timeoutMs }) {
  const raw = await apiPost({
    baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    body: JSON.stringify({ ...body, base_info: buildBaseInfo() }),
    token,
    timeoutMs: timeoutMs ?? 15000,
  })
  const resp = JSON.parse(raw)
  if (resp.ret && resp.ret !== 0) throw new Error(`sendMessage ret=${resp.ret} ${resp.errmsg ?? ''}`)
  return resp
}
async function notifyStart(baseUrl, token) {
  try {
    await apiPost({
      baseUrl,
      endpoint: 'ilink/bot/msg/notifystart',
      body: JSON.stringify({ base_info: buildBaseInfo() }),
      token,
      timeoutMs: 10000,
    })
  } catch (error) {
    log('warn', `notifyStart: ${String(error)}`)
  }
}
async function notifyStop(baseUrl, token) {
  try {
    await apiPost({
      baseUrl,
      endpoint: 'ilink/bot/msg/notifystop',
      body: JSON.stringify({ base_info: buildBaseInfo() }),
      token,
      timeoutMs: 10000,
    })
  } catch {
    /* best effort */
  }
}

// ── runtime state ──────────────────────────────────────────────────────────
const state = {
  phase: 'idle', // idle | waiting_qrcode | scanned | need_verifycode | expired | logged_in | logged_out | error
  message: '',
  qrcode: undefined, // protocol qrcode key
  qrcodeUrl: undefined, // URL encoded in the QR
  qrcodeDataUrl: undefined, // PNG data URL for the browser
  accountId: undefined,
  baseUrl: API_BASE,
  token: undefined,
  pendingVerifyCode: undefined,
  /** 登录轮次：每次 startLogin 自增，已作废的旧轮次不得再改全局状态。 */
  loginGen: 0,
  loginLoop: undefined,
  monitorAbort: undefined,
}

/** SSE client registry. */
const sseClients = new Set()
function broadcast(event, data) {
  const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of sseClients) {
    try {
      res.write(line)
    } catch {
      sseClients.delete(res)
    }
  }
}
function setPhase(phase, message = '') {
  state.phase = phase
  state.message = message
  log('info', `state -> ${phase}${message ? ` (${message})` : ''}`)
  broadcast('login/state', { phase, message, accountId: state.accountId })
}
/** 该登录轮次是否已被更新的轮次取代。 */
function loginSuperseded(gen) {
  return state.loginGen !== gen
}
/** 若本登录轮次已被取代则记一条 debug 并返回 true（调用方立即 return）。 */
function bailIfSuperseded(gen) {
  if (!loginSuperseded(gen)) return false
  log('debug', `login loop gen ${gen} superseded — exiting`)
  return true
}
/**
 * setPhase，但仅当 gen 仍是当前登录轮次。
 *
 * 关键：被取代的旧循环（例如用户连点两次「刷新二维码」）不能再去改全局
 * 状态。否则旧二维码过期时会把已经 logged_in 的状态改回 waiting_qrcode，
 * 于是 /send 被判成「未登录」，DSH 生成好的回复全部发不出去——表现为
 * 「微信里发消息没反应」，而收消息的 monitor 其实一直活着。
 */
function setPhaseCurrent(gen, phase, message = '') {
  if (loginSuperseded(gen)) {
    log('info', `stale login loop (gen ${gen}) ignored: state -> ${phase}`)
    return false
  }
  setPhase(phase, message)
  return true
}

// ── QR login loop ──────────────────────────────────────────────────────────
async function startLogin({ force } = {}) {
  if (state.loginLoop) {
    if (!force && ['waiting_qrcode', 'scanned', 'need_verifycode'].includes(state.phase)) {
      return { ok: true, message: 'login already in progress' }
    }
    // force refresh: let the old loop exit on its next iteration
  }
  if (state.monitorAbort) {
    state.monitorAbort.abort()
    state.monitorAbort = undefined
  }
  // 递增登录轮次：此前仍在轮询的登录循环自此刻起作废，只能安静退出。
  const gen = ++state.loginGen
  const loop = (async () => {
    try {
      const qr = await fetchQRCode()
      if (bailIfSuperseded(gen)) return
      if (!qr.qrcode || !qr.qrcode_img_content) {
        throw new Error(`QR fetch failed: ${JSON.stringify(qr).slice(0, 200)}`)
      }
      state.qrcode = qr.qrcode
      state.qrcodeUrl = qr.qrcode_img_content
      state.qrcodeDataUrl = await QRCode.toDataURL(qr.qrcode_img_content, { margin: 1 })
      state.pendingVerifyCode = undefined
      setPhaseCurrent(gen, 'waiting_qrcode', '请用手机微信扫描二维码')
      const deadline = Date.now() + 480_000
      let qrRefreshes = 0
      while (Date.now() < deadline) {
        if (bailIfSuperseded(gen)) return
        const resp = await pollQRStatus(
          state.qrcode,
          state.pendingVerifyCode,
          state.baseUrl === API_BASE ? API_BASE : state.baseUrl,
        )
        if (bailIfSuperseded(gen)) return
        switch (resp.status) {
          case 'wait':
            break
          case 'scaned':
            state.pendingVerifyCode = undefined
            setPhaseCurrent(gen, 'scanned', '已扫码，请在手机上确认')
            break
          case 'need_verifycode':
            setPhaseCurrent(gen, 'need_verifycode', '请在手机上查看验证码并输入')
            // wait for POST /verifycode; poll again after a short pause
            await new Promise((r) => setTimeout(r, 2000))
            break
          case 'expired':
          case 'verify_code_blocked': {
            qrRefreshes += 1
            if (qrRefreshes >= 3) {
              setPhaseCurrent(gen, 'error', '二维码多次失效，请重新登录')
              return
            }
            const fresh = await fetchQRCode()
            if (bailIfSuperseded(gen)) return
            state.qrcode = fresh.qrcode
            state.qrcodeUrl = fresh.qrcode_img_content
            state.qrcodeDataUrl = await QRCode.toDataURL(fresh.qrcode_img_content, { margin: 1 })
            state.pendingVerifyCode = undefined
            setPhaseCurrent(gen, 'waiting_qrcode', '二维码已刷新，请重新扫描')
            break
          }
          case 'binded_redirect':
            setPhaseCurrent(gen, 'expired', '该微信已绑定过，请刷新二维码')
            break
          case 'scaned_but_redirect':
            if (resp.redirect_host) state.baseUrl = `https://${resp.redirect_host}`
            break
          case 'confirmed': {
            if (bailIfSuperseded(gen)) return
            if (!resp.ilink_bot_id) throw new Error('login confirmed but missing ilink_bot_id')
            state.token = resp.bot_token
            state.accountId = resp.ilink_bot_id
            if (resp.baseurl) state.baseUrl = resp.baseurl
            saveAccount(resp.ilink_bot_id, {
              token: resp.bot_token,
              baseUrl: state.baseUrl,
              userId: resp.ilink_user_id,
            })
            registerAccountId(resp.ilink_bot_id)
            state.qrcode = undefined
            state.qrcodeUrl = undefined
            state.qrcodeDataUrl = undefined
            setPhaseCurrent(gen, 'logged_in', '已连接微信')
            startMonitor()
            return
          }
          default:
            log('debug', `pollQRStatus: unknown status ${resp.status}`)
        }
        await new Promise((r) => setTimeout(r, 1000))
      }
      setPhaseCurrent(gen, 'expired', '二维码已过期，请重新登录')
    } catch (error) {
      setPhaseCurrent(gen, 'error', String(error.message ?? error))
    } finally {
      if (state.loginLoop === loop) state.loginLoop = undefined
    }
  })()
  state.loginLoop = loop
  return { ok: true }
}

// ── message monitor ────────────────────────────────────────────────────────
function extractText(itemList) {
  if (!Array.isArray(itemList)) return ''
  const item = itemList.find((i) => i?.type === 1 && i.text_item?.text != null)
  return item ? String(item.text_item.text) : ''
}

async function startMonitor() {
  if (state.monitorAbort) return
  const abort = new AbortController()
  state.monitorAbort = abort
  const accountId = state.accountId
  const token = state.token
  const baseUrl = state.baseUrl
  void notifyStart(baseUrl, token)
  log('info', `monitor started (${baseUrl}, account=${accountId})`)
  let buf = loadSyncBuf(accountId)
  let consecutiveFailures = 0
  while (!abort.signal.aborted) {
    try {
      const resp = await getUpdates({
        baseUrl,
        token,
        get_updates_buf: buf,
        timeoutMs: 35000,
        signal: abort.signal,
      })
      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0)
      if (isApiError) {
        if (resp.errcode === STALE_TOKEN_ERRCODE || resp.ret === STALE_TOKEN_ERRCODE) {
          log('error', 'token stale, logging out')
          broadcast('login/state', { phase: 'logged_out', message: '登录已失效，请重新扫码' })
          void notifyStop(baseUrl, token)
          abort.abort()
          state.monitorAbort = undefined
          state.phase = 'logged_out'
          return
        }
        consecutiveFailures += 1
        log('warn', `getUpdates failed ret=${resp.ret} errcode=${resp.errcode} (${consecutiveFailures}/3)`)
        await new Promise((r) => setTimeout(r, consecutiveFailures >= 3 ? 30000 : 2000))
        continue
      }
      consecutiveFailures = 0
      if (resp.get_updates_buf != null && resp.get_updates_buf !== '') {
        saveSyncBuf(accountId, resp.get_updates_buf)
        buf = resp.get_updates_buf
      }
      for (const full of resp.msgs ?? []) {
        const from = full.from_user_id ?? ''
        const text = extractText(full.item_list)
        const contextToken = full.context_token ?? undefined
        if (!from) continue
        if (!isAllowed(from)) {
          broadcast('approval', { wxid: from, text: text.slice(0, 200), ts: Date.now() })
          if (text) {
            try {
              await sendMessage({
                baseUrl,
                token,
                body: {
                  msg: {
                    from_user_id: '',
                    to_user_id: from,
                    client_id: `dsh:${Date.now()}-${randomBytes(4).toString('hex')}`,
                    message_type: 2,
                    message_state: 2,
                    item_list: [{ type: 1, text_item: { text: UNAPPROVED_REPLY } }],
                    context_token: contextToken,
                  },
                },
              })
            } catch (error) {
              log('warn', `unapproved auto-reply failed: ${String(error)}`)
            }
          }
          continue
        }
        if (text) {
          broadcast('message', { from, text, contextToken, ts: Date.now() })
        }
      }
    } catch (error) {
      if (abort.signal.aborted) {
        log('info', 'monitor stopped')
        return
      }
      consecutiveFailures += 1
      log('warn', `getUpdates error (${consecutiveFailures}/3): ${String(error)}`)
      await new Promise((r) => setTimeout(r, consecutiveFailures >= 3 ? 30000 : 2000))
    }
  }
}

function stopMonitor() {
  if (state.monitorAbort) {
    state.monitorAbort.abort()
    state.monitorAbort = undefined
  }
}

// ── HTTP + SSE surface ─────────────────────────────────────────────────────
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}
function json(res, status, body, extra = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...corsHeaders(),
    ...extra,
  })
  res.end(payload)
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (c) => {
      data += c
      if (data.length > 1024 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}
function publicStatus() {
  return {
    phase: state.phase,
    message: state.message,
    accountId: state.accountId,
    qrcodeUrl: state.qrcodeUrl,
    qrcodeDataUrl: state.qrcodeDataUrl,
    allowlist: loadAllowlist(),
    port: PORT,
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders())
    return res.end()
  }
  try {
    if (req.method === 'GET' && url.pathname === '/status') {
      return json(res, 200, publicStatus())
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...corsHeaders(),
      })
      res.write(`event: login/state\ndata: ${JSON.stringify({ phase: state.phase, message: state.message, accountId: state.accountId })}\n\n`)
      sseClients.add(res)
      const heartbeat = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch {
          clearInterval(heartbeat)
          sseClients.delete(res)
        }
      }, 15000)
      req.on('close', () => {
        clearInterval(heartbeat)
        sseClients.delete(res)
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/login') {
      let body = {}
      try {
        body = JSON.parse((await readBody(req)) || '{}')
      } catch {
        /* ignore */
      }
      // 防误触：已绑定（登录成功）时拒绝重新登录，必须先 /logout 解绑。
      if (state.phase === 'logged_in' && body.force !== true) {
        return json(res, 409, { error: 'already bound — call /logout first' })
      }
      const result = await startLogin({ force: body.force === true })
      return json(res, 200, result)
    }
    if (req.method === 'POST' && url.pathname === '/verifycode') {
      let body = {}
      try {
        body = JSON.parse((await readBody(req)) || '{}')
      } catch {
        return json(res, 400, { error: 'invalid JSON' })
      }
      const code = typeof body.code === 'string' ? body.code.trim() : ''
      if (!code) return json(res, 400, { error: 'missing code' })
      if (!['need_verifycode', 'scanned', 'waiting_qrcode'].includes(state.phase)) {
        return json(res, 409, { error: 'no login in progress' })
      }
      state.pendingVerifyCode = code
      return json(res, 200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/logout') {
      if (state.accountId && state.token) {
        void notifyStop(state.baseUrl, state.token)
      }
      stopMonitor()
      state.token = undefined
      state.accountId = undefined
      setPhase('logged_out', '已登出')
      return json(res, 200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/send') {
      let body = {}
      try {
        body = JSON.parse((await readBody(req)) || '{}')
      } catch {
        return json(res, 400, { error: 'invalid JSON' })
      }
      const to = typeof body.to === 'string' ? body.to : ''
      const text = typeof body.text === 'string' ? body.text : ''
      if (!to || !text) return json(res, 400, { error: 'missing to/text' })
      // 只要还持有有效凭证就允许发送：登录轮次切换 / 二维码刷新期间 phase
      // 可能被短暂改写，此时绝不能把 DSH 已经生成好的回复丢掉（否则表现
      // 为「微信发消息没反应」）。
      if (!state.token) {
        return json(res, 409, { error: 'not logged in' })
      }
      try {
        await sendMessage({
          baseUrl: state.baseUrl,
          token: state.token,
          body: {
            msg: {
              from_user_id: '',
              to_user_id: to,
              client_id: `dsh:${Date.now()}-${randomBytes(4).toString('hex')}`,
              message_type: 2,
              message_state: 2,
              item_list: [{ type: 1, text_item: { text } }],
              ...(body.contextToken ? { context_token: body.contextToken } : {}),
            },
          },
        })
        broadcast('send/result', { to, ok: true, ts: Date.now() })
        return json(res, 200, { ok: true })
      } catch (error) {
        broadcast('send/result', { to, ok: false, error: String(error), ts: Date.now() })
        return json(res, 502, { error: String(error.message ?? error) })
      }
    }
    if (req.method === 'GET' && url.pathname === '/allowlist') {
      return json(res, 200, { allowed: loadAllowlist(), mode: loadAllowlist().length === 0 ? 'allow-all' : 'allowlist' })
    }
    if (req.method === 'POST' && url.pathname === '/allow') {
      let body = {}
      try {
        body = JSON.parse((await readBody(req)) || '{}')
      } catch {
        return json(res, 400, { error: 'invalid JSON' })
      }
      const wxid = typeof body.wxid === 'string' ? body.wxid : ''
      if (!wxid) return json(res, 400, { error: 'missing wxid' })
      const allowed = setAllowed(wxid, body.allow !== false)
      return json(res, 200, { ok: true, allowed })
    }
    return json(res, 404, { error: 'not found' })
  } catch (error) {
    log('error', `http: ${String(error)}`)
    return json(res, 500, { error: String(error.message ?? error) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  log('info', `wechat-gateway listening on http://127.0.0.1:${PORT} (state dir: ${STATE_DIR})`)
})

// Auto-resume (hot login): a saved bot token is directly usable — start the
// message monitor immediately without re-scanning. If the token was revoked,
// getUpdates returns errcode -14 and the monitor flips to logged_out with a
// re-scan prompt.
if (listAccountIds().length > 0) {
  const last = listAccountIds()[listAccountIds().length - 1]
  const acc = loadAccount(last)
  if (acc?.token) {
    state.accountId = last
    state.token = acc.token
    state.baseUrl = acc.baseUrl || API_BASE
    setPhase('logged_in', '已恢复登录（使用已保存的凭证）')
    startMonitor()
  }
}
