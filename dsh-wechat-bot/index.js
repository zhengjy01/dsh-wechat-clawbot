/**
 * dsh-wechat-bot — DeepSeek Harness host plugin.
 *
 * Bridges WeChat to the DSH agent without any external messenger stack:
 *
 *   1. Spawns the standalone `wechat-gateway` subprocess (Tencent iLink bot
 *      protocol: QR login, long-poll receive, send). The gateway exposes a
 *      localhost HTTP+SSE surface; the browser floating-ball UI talks to it
 *      directly for QR display and approval management.
 *   2. Consumes the gateway's SSE `message` events and pushes each WeChat
 *      text into the DSH agent via `createBridge` (dsh-wechat-bridge) — the
 *      same session-driving core as the HTTP bridge, so messages land in the
 *      GUI conversation ('active' mode) and replies stream back.
 *   3. Sends the committed reply back to WeChat through the gateway.
 *
 * Senders are approved through the gateway allowlist (empty = allow all);
 * unapproved senders get an automatic notice and show up as pending
 * approvals in the floating-ball panel.
 */

import { spawn, execFile } from 'node:child_process'
import { createServer } from 'node:http'
import fs from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import Schema from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { createBridge } from '../dsh-wechat-bridge/index.js'
import { evaluateWindowTick } from './keepalive.mjs'

const execFileAsync = promisify(execFile)

/** This package's version, reported by the liveness probe (CHANGELOG promised it). */
const PACKAGE_VERSION = (() => {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
    )
    return typeof pkg.version === 'string' ? pkg.version : ''
  } catch {
    return ''
  }
})()

export const name = 'dsh-wechat-bot'
/** The agent registry is accessed through createBridge; declare it for this fiber. */
export const inject = ['agents']

/**
 * Build the read-only liveness-probe payload.
 *
 * Kept as an exported pure function (not inlined in the route handler) so
 * `npm test` can assert the contract without mounting the plugin — mounting
 * spawns the gateway and binds ports. The `version` field is the local
 * package.json version: the 0.2.0 CHANGELOG promised it but the payload
 * omitted it until 0.2.1.
 */
export function probePayload(gatewayPort, modelPort) {
  return {
    ok: true,
    plugin: name,
    version: PACKAGE_VERSION,
    gatewayPort,
    modelPort,
  }
}

/** Read a positive integer from an environment variable, else the fallback. */
function envPort(name, fallback) {
  const raw = process.env[name]
  const value = raw === undefined || raw === '' ? Number.NaN : Number(raw)
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : fallback
}

/** Plugin config, validated by schemastery at mount time. */
export const Config = Schema.object({
  /** Gateway HTTP port. Env override: DSH_WECHAT_GATEWAY_PORT. */
  gatewayPort: Schema.number().default(envPort('DSH_WECHAT_GATEWAY_PORT', 51235)),
  /** Directory containing the wechat-gateway package (gateway.mjs). */
  gatewayDir: Schema.string().default(''),
  /** Gateway state dir (accounts/allowlist); empty = ~/.dsh-wechat. Env override: DSH_WECHAT_STATE_DIR. */
  stateDir: Schema.string().default(process.env.DSH_WECHAT_STATE_DIR ?? ''),
  /** Which session inbound messages target: active | dedicated | keyed | explicit. */
  sessionMode: Schema.union([
    Schema.const('active'),
    Schema.const('dedicated'),
    Schema.const('keyed'),
    Schema.const('explicit'),
  ]).default('active'),
  /** Session id for sessionMode 'explicit'. */
  sessionId: Schema.string().default(''),
  /** Workspace cwd for bridge-owned sessions. */
  cwd: Schema.string().default(process.cwd()),
  /** How long one turn may run before the bridge settles with what it has. */
  timeoutMs: Schema.number().default(300000),
  /** Reject inbound text longer than this many characters. */
  maxMessageChars: Schema.number().default(20000),
  /** Approval policy for bridged turns: 'reject' auto-rejects, 'ignore' leaves the ask pending in the GUI. */
  approval: Schema.union([Schema.const('reject'), Schema.const('ignore')]).default('reject'),
  /** Optional provider override for bridge-owned sessions. */
  provider: Schema.string(),
  /** Optional model override for bridge-owned sessions. */
  model: Schema.string(),
  /** Restart the gateway after this many consecutive failed health checks (0 = never). */
  healthCheckLimit: Schema.number().default(5),
  /**
   * Built-in conversation-window keepalive (2026-09-19). Tencent only accepts
   * proactive pushes while the user's conversation window is open; the gateway
   * persists an inbound clock and exposes GET /window + POST /probe, and this
   * loop turns a silent "open → closed" transition into an explicit desktop
   * notification. No local launchd job / hand-written script is required on a
   * fresh machine — it ships with the plugin.
   */
  keepalive: Schema.boolean().default(true),
  /** How often to check the window (minutes). */
  keepaliveIntervalMinutes: Schema.number().default(30),
  /** Optional old behaviour: nudge on WeChat when open and silent ≥ this many hours (0 = off). */
  keepaliveNudgeHours: Schema.number().default(0),
  /** Show a desktop notification when the window closes (macOS only). */
  keepaliveNotify: Schema.boolean().default(true),
  /** HTTP port for the ClawBot model-management endpoint (GET/POST /model). Env override: DSH_WECHAT_MODEL_PORT. */
  modelPort: Schema.number().default(envPort('DSH_WECHAT_MODEL_PORT', 51236)),
  /** Optional initial ClawBot model override: { provider, model, reasoningEffort? }. */
  modelOverride: Schema.object({
    provider: Schema.string(),
    model: Schema.string(),
    reasoningEffort: Schema.string(),
  }),
  /** Optional Node/Electron binary used to spawn wechat-gateway; empty = process.execPath. */
  gatewayNode: Schema.string().default(''),
})

/** Resolve the gateway package directory (config value, sibling checkout, or pnpm dep). */
function resolveGatewayDir(config) {
  if (config.gatewayDir !== '') {
    if (isAbsolute(config.gatewayDir)) return config.gatewayDir
    return join(process.cwd(), config.gatewayDir)
  }
  const sibling = join(dirname(fileURLToPath(import.meta.url)), '..', 'wechat-gateway')
  if (fs.existsSync(join(sibling, 'gateway.mjs'))) return sibling
  try {
    const pkgUrl = import.meta.resolve('wechat-gateway/package.json')
    return dirname(fileURLToPath(pkgUrl))
  } catch {
    return sibling
  }
}

/** Parse an SSE stream into {event, data} lines. */
async function* sseEvents(response) {
  const decoder = new TextDecoder()
  const reader = response.body.getReader()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        let event = 'message'
        let data = ''
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data += line.slice(5).trim()
        }
        if (data !== '') yield { event, data: JSON.parse(data) }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** Sleep helper. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Mount the WeChat bot.
 * @param ctx - Cordis context.
 * @param config - validated plugin config.
 */
export function apply(ctx, config) {
  const logger = ctx.logger
  const stateBase = config.stateDir !== '' ? config.stateDir : join(homedir(), '.dsh-wechat')

  // bridgeConfig 是传给 createBridge 的共享配置对象；modelOverride 槽由
  // 模型端点动态替换，bridge 每次 model 请求实时读取（不会丢失）。
  const bridgeConfig = {
    sessionMode: 'keyed', // 微信消息固定走独立会话，不进 GUI 当前会话
    sessionId: config.sessionId,
    cwd: config.cwd,
    timeoutMs: config.timeoutMs,
    maxMessageChars: config.maxMessageChars,
    approval: config.approval,
    provider: config.provider,
    model: config.model,
    modelOverride: undefined,
    sessionMapFile: join(stateBase, 'bridge-sessions.json'),
  }
  const bridge = createBridge(ctx, bridgeConfig)

  const gatewayDir = resolveGatewayDir(config)
  const gatewayUrl = `http://127.0.0.1:${config.gatewayPort}`

  // ClawBot 模型覆盖：持久化到网关 state dir，重启后自动恢复。
  const modelStateFile = join(stateBase, 'clawbot-model.json')
  try {
    const stored = JSON.parse(fs.readFileSync(modelStateFile, 'utf8'))
    if (stored?.provider && stored?.model) bridgeConfig.modelOverride = stored
  } catch {
    /* no persisted override */
  }
  const saveModelOverride = (next) => {
    bridgeConfig.modelOverride = next
    try {
      fs.mkdirSync(dirname(modelStateFile), { recursive: true })
      if (next === undefined) {
        try { fs.unlinkSync(modelStateFile) } catch { /* absent */ }
      } else {
        fs.writeFileSync(modelStateFile, JSON.stringify(next, null, 2), 'utf8')
      }
    } catch (error) {
      logger.warn(`dsh-wechat-bot: persist model override failed: ${String(error)}`)
    }
  }

  // 微信对话区编号：所有微信消息进同一个会话（上下文连续），收到 /new
  // 命令才递增开新会话。编号持久化，重启后回到当前对话。
  const wechatSessionFile = join(stateBase, 'wechat-session.json')
  let wechatSessionIndex = 1
  try {
    const stored = JSON.parse(fs.readFileSync(wechatSessionFile, 'utf8'))
    if (typeof stored?.index === 'number' && stored.index >= 1) wechatSessionIndex = stored.index
  } catch {
    /* start at the first conversation */
  }
  const saveWechatSessionIndex = () => {
    try {
      fs.mkdirSync(dirname(wechatSessionFile), { recursive: true })
      fs.writeFileSync(wechatSessionFile, JSON.stringify({ index: wechatSessionIndex }, null, 2), 'utf8')
    } catch (error) {
      logger.warn(`dsh-wechat-bot: persist wechat session index failed: ${String(error)}`)
    }
  }
  const newWechatSession = () => {
    wechatSessionIndex += 1
    saveWechatSessionIndex()
    logger.info(`dsh-wechat-bot: new WeChat conversation #${wechatSessionIndex}`)
    return wechatSessionIndex
  }

  let child = undefined
  let eventsAbort = undefined
  let stopped = false
  let healthFailures = 0

  /** POST JSON to the gateway. */
  const gatewayPost = async (pathname, body) => {
    const res = await fetch(`${gatewayUrl}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`gateway ${pathname} ${res.status}: ${text.slice(0, 200)}`)
    return text === '' ? {} : JSON.parse(text)
  }

  /** Send a reply back to a WeChat sender; retry once without the context token. */
  const sendToWechat = async (to, text, contextToken) => {
    try {
      await gatewayPost('/send', { to, text, ...(contextToken ? { contextToken } : {}) })
    } catch (error) {
      logger.error(`dsh-wechat-bot: reply to ${to} failed (will retry without context): ${String(error)}`)
      try {
        await gatewayPost('/send', { to, text })
      } catch (retryError) {
        logger.error(`dsh-wechat-bot: reply to ${to} failed on retry: ${String(retryError)}`)
      }
    }
  }

  /** Handle one inbound WeChat message: run it through the DSH agent. */
  const handleMessage = async (event) => {
    const { from, text, contextToken } = event
    const body = typeof text === 'string' ? text.trim() : ''
    if (!from || body === '') return
    // 切换对话命令：开一个新的微信对话区（不发给 agent）
    if (body === '/new' || body === '/新对话' || body === '/新会话') {
      const index = newWechatSession()
      await sendToWechat(from, `✅ 已切换到第 ${index} 个对话（新对话区）。`, contextToken)
      return
    }
    if (body.length > config.maxMessageChars) {
      await sendToWechat(from, `⚠️ 消息超过 ${config.maxMessageChars} 字符，请分段发送。`, contextToken)
      return
    }
    logger.info(`dsh-wechat-bot: message from ${from} (chat #${wechatSessionIndex}): ${body.slice(0, 60)}`)
    try {
      // 微信消息固定进「微信对话区」（bridge 创建的独立会话，keyed 按编号
      // 复用上下文）；绝不注入 GUI 当前会话。
      const result = await bridge.sendText(body, `wechat:${wechatSessionIndex}`)
      if (result.reply !== '') await sendToWechat(from, result.reply, contextToken)
    } catch (error) {
      logger.warn(`dsh-wechat-bot: turn failed for ${from}: ${String(error)}`)
      await sendToWechat(
        from,
        `⚠️ DSH 处理失败：${String(error.message ?? error).slice(0, 300)}`,
        contextToken,
      )
    }
  }

  /** Consume the gateway SSE stream; reconnect with backoff on drop. */
  const consumeEvents = async () => {
    while (!stopped) {
      try {
        const controller = new AbortController()
        eventsAbort = controller
        logger.info(`dsh-wechat-bot: connecting to gateway events (${gatewayUrl}/events)`)
        const res = await fetch(`${gatewayUrl}/events`, { signal: controller.signal })
        if (!res.ok) throw new Error(`events HTTP ${res.status}`)
        for await (const { event, data } of sseEvents(res)) {
          if (event === 'message') void handleMessage(data)
          else if (event === 'login/state') {
            logger.info(`dsh-wechat-bot: wechat login state: ${data.phase} ${data.message ?? ''}`)
          }
        }
      } catch (error) {
        if (stopped) return
        logger.warn(`dsh-wechat-bot: gateway events disconnected: ${String(error)}`)
      }
      if (stopped) return
      await sleep(2000)
    }
  }

  /** Node binary for the gateway: config / DSH_NODE / current process (Electron needs ELECTRON_RUN_AS_NODE). */
  const resolveGatewayNode = () => {
    if (config.gatewayNode !== '') return config.gatewayNode
    if (process.env.DSH_NODE) return process.env.DSH_NODE
    return process.execPath
  }

  /** Spawn (or respawn) the gateway subprocess. */
  const startGateway = () => {
    if (stopped) return
    if (child !== undefined && child.exitCode === null) return
    const entry = join(gatewayDir, 'gateway.mjs')
    const nodeBin = resolveGatewayNode()
    logger.info(`dsh-wechat-bot: starting gateway ${entry} via ${nodeBin} (port ${config.gatewayPort})`)
    child = spawn(nodeBin, [entry], {
      cwd: gatewayDir,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PORT: String(config.gatewayPort),
        ...(config.stateDir !== '' ? { STATE_DIR: config.stateDir } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    const forward = (stream, level) => {
      stream?.on('data', (line) => {
        for (const l of line.split('\n').filter(Boolean)) logger[level](`wechat-gateway: ${l}`)
      })
    }
    forward(child.stdout, 'info')
    forward(child.stderr, 'error')
    child.on('exit', (code, signal) => {
      logger.warn(`dsh-wechat-bot: gateway exited (code=${code} signal=${signal})`)
      child = undefined
      if (!stopped) setTimeout(startGateway, 3000)
    })
    child.on('error', (error) => {
      logger.error(`dsh-wechat-bot: gateway spawn failed: ${String(error)}`)
      child = undefined
      if (!stopped) setTimeout(startGateway, 10000)
    })
  }

  /** Health-check the gateway; restart when it stops answering. */
  const healthLoop = async () => {
    while (!stopped) {
      await sleep(10000)
      if (stopped) return
      try {
        const res = await fetch(`${gatewayUrl}/status`, { signal: AbortSignal.timeout(3000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        healthFailures = 0
      } catch (error) {
        healthFailures += 1
        if (config.healthCheckLimit > 0 && healthFailures >= config.healthCheckLimit) {
          logger.warn(`dsh-wechat-bot: gateway unhealthy (${healthFailures} checks), restarting`)
          healthFailures = 0
          child?.kill('SIGKILL')
          startGateway()
        }
      }
    }
  }

  /** Read a JSON file, falling back to an empty object. */
  const readJsonFile = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return {}
    }
  }
  const writeJsonFile = (file, value) => {
    try {
      fs.mkdirSync(dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
    } catch (error) {
      logger.warn(`dsh-wechat-bot: persist ${file} failed: ${String(error)}`)
    }
  }

  /** Recipient resolution, same convention as the notify/daily-report scripts. */
  const resolveRecipient = () => {
    const accountsDir = join(stateBase, 'accounts')
    const readUserId = (file) => {
      const parsed = readJsonFile(file)
      const v = parsed && typeof parsed === 'object' ? parsed.userId : ''
      return typeof v === 'string' ? v.trim() : ''
    }
    const list = readJsonFile(join(stateBase, 'accounts.json'))
    if (Array.isArray(list)) {
      for (const id of [...list].reverse()) {
        if (typeof id !== 'string' || id.trim() === '') continue
        const found = readUserId(join(accountsDir, `${id.trim()}.json`))
        if (found) return found
      }
    }
    try {
      for (const f of fs.readdirSync(accountsDir)) {
        if (!f.endsWith('.json') || f.endsWith('.sync.json')) continue
        const found = readUserId(join(accountsDir, f))
        if (found) return found
      }
    } catch {
      /* no accounts yet */
    }
    return ''
  }

  /** Best-effort desktop notification (macOS only, never throws). */
  const desktopNotify = async (title, text) => {
    if (!config.keepaliveNotify || process.platform !== 'darwin') return false
    const script = [
      `display notification ${JSON.stringify(String(text).slice(0, 220))}`,
      `with title ${JSON.stringify(String(title).slice(0, 80))}`,
      'sound name "Glass"',
    ].join(' ')
    try {
      await execFileAsync('osascript', ['-e', script])
      return true
    } catch {
      return false
    }
  }

  /**
   * Conversation-window keepalive. Tencent only accepts proactive pushes while
   * the user's conversation window is open; the gateway persists the inbound
   * clock and answers GET /window + POST /probe. The state machine:
   *   1. window open   → do nothing (don't nag)
   *   2. open → closed → desktop notification once ("reply to renew")
   *   3. already closed → stop probing until the inbound clock changes
   * Optional old behaviour --keepaliveNudgeHours > 0 nudges on WeChat while open.
   */
  const keepaliveFile = join(stateBase, 'window-keepalive.json')
  let keepaliveTimer

  const keepaliveTick = async () => {
    const ledger = readJsonFile(keepaliveFile)
    let report
    try {
      const res = await fetch(`${gatewayUrl}/window`, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      report = await res.json()
    } catch (error) {
      logger.warn(`dsh-wechat-bot: window check failed: ${String(error)}`)
      return
    }

    // Decide first (pure), then probe only if the state machine asks for it.
    const dry = evaluateWindowTick({
      ledger,
      report,
      nudgeHours: config.keepaliveNudgeHours,
    })
    let probe = null
    if (dry.needProbe) {
      try {
        probe = await gatewayPost('/probe', {})
      } catch (error) {
        logger.warn(`dsh-wechat-bot: window probe failed: ${String(error)}`)
      }
    }
    const now = Date.now()
    const decision = evaluateWindowTick({
      ledger,
      report,
      probe,
      now,
      nudgeHours: config.keepaliveNudgeHours,
    })
    const next = decision.ledger

    if (decision.transition === 'closed') {
      const ageText = report?.age && report.age !== '未知' ? `距用户上次发消息约 ${report.age}` : '静默时长未知'
      const okNotify = await desktopNotify(
        '微信会话窗口已关闭',
        `${ageText}。回机器人一句话即可恢复微信推送；期间通知走 macOS 横幅兜底，不会漏。`,
      )
      logger.warn(`dsh-wechat-bot: 微信会话窗口已关闭（${ageText}），桌面提醒${okNotify ? '已弹出' : '未弹出'}`)
    } else if (decision.transition === 'recovered') {
      logger.info('dsh-wechat-bot: 微信会话窗口已恢复（用户回话生效）')
    }

    // Optional old behaviour: while open and silent past the threshold, nudge
    // the user on WeChat to renew the window (off by default).
    if (typeof next.dueNudgeHours === 'number') {
      const silentHours = next.dueNudgeHours
      delete next.dueNudgeHours
      const to = resolveRecipient()
      if (to) {
        const text =
          `【通道保鲜提醒】你已经 ${silentHours.toFixed(1)} 小时没跟机器人说话了。\n` +
          '腾讯侧的会话窗口会随时间关闭——一旦关闭，我就再也推不出任何消息（日报、任务通知全部静默）。\n' +
          '回我一句就行（「在」也可以），窗口立刻续期。'
        try {
          await gatewayPost('/send', { to, text })
          next.lastNudgeMs = now
          next.lastNudgeAt = new Date(now).toISOString()
          logger.info(`dsh-wechat-bot: 已发送通道保鲜提醒（静默 ${silentHours.toFixed(1)} 小时 → ${to}）`)
        } catch (error) {
          logger.warn(`dsh-wechat-bot: 保鲜提醒发送失败：${String(error)}`)
        }
      }
    }

    writeJsonFile(keepaliveFile, next)
  }

  startGateway()
  void consumeEvents()
  void healthLoop()

  // Built-in conversation-window keepalive — ships with the plugin, so a fresh
  // install needs no local launchd job or hand-written script. The first tick
  // waits one full interval (default 30 min), which also keeps the isolated
  // portability verification from probing the real account.
  if (config.keepalive) {
    const intervalMs = Math.max(5, config.keepaliveIntervalMinutes) * 60_000
    keepaliveTimer = setInterval(() => {
      void keepaliveTick()
    }, intervalMs)
    keepaliveTimer.unref?.()
    logger.info(`dsh-wechat-bot: conversation-window keepalive every ${Math.round(intervalMs / 60_000)} min`)
  }

  // ── ClawBot model management endpoint ────────────────────────────────
  const DEEPSEEK_EFFORTS = ['off', 'high', 'max']
  const DEEPSEEK_DEFAULT_MODELS = [
    { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
  ]

  /** Available models: provider catalog from settings, keyed by credentials. */
  const availableModels = async () => {
    const out = []
    const settings = ctx.get('settings')
    const section = settings?.get(settingsNamespace('llm-deepseek')) ?? {}
    const apiKeyEnv = typeof section.apiKeyEnv === 'string' && section.apiKeyEnv !== ''
      ? section.apiKeyEnv
      : 'DEEPSEEK_API_KEY'
    const credentials = ctx.get('credentials')
    let hasKey = process.env[apiKeyEnv] !== undefined
    if (!hasKey && credentials !== undefined) {
      try {
        hasKey = (await credentials.resolve(apiKeyEnv)) !== undefined
      } catch {
        hasKey = false
      }
    }
    const models = Array.isArray(section.models) && section.models.length > 0
      ? section.models
      : DEEPSEEK_DEFAULT_MODELS
    for (const m of models) {
      out.push({
        provider: 'deepseek-official',
        model: typeof m.id === 'string' ? m.id : m,
        name: typeof m.name === 'string' ? m.name : undefined,
        hasKey,
      })
    }
    return out
  }

  const modelServer = createServer(async (req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }
    const json = (status, body) => {
      const payload = JSON.stringify(body)
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        ...cors,
      })
      res.end(payload)
    }
    const readBody = () =>
      new Promise((resolve, reject) => {
        let data = ''
        req.setEncoding('utf8')
        req.on('data', (c) => {
          data += c
          if (data.length > 65536) {
            reject(new Error('body too large'))
            req.destroy()
          }
        })
        req.on('end', () => resolve(data))
        req.on('error', reject)
      })
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      return res.end()
    }
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
    try {
      if (req.method === 'GET' && url.pathname === '/model') {
        const override = bridgeConfig.modelOverride
        return json(200, {
          current: override?.provider && override?.model ? override : null,
          available: await availableModels(),
          efforts: DEEPSEEK_EFFORTS,
        })
      }
      if (req.method === 'POST' && url.pathname === '/model') {
        let body = {}
        try {
          body = JSON.parse((await readBody()) || '{}')
        } catch {
          return json(400, { error: 'invalid JSON' })
        }
        const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
        const model = typeof body.model === 'string' ? body.model.trim() : ''
        // provider 与 model 都为空 = 清除覆盖，恢复跟随 DSH 默认
        if (provider === '' && model === '') {
          saveModelOverride(undefined)
          logger.info('dsh-wechat-bot: ClawBot model override cleared')
          return json(200, { ok: true, current: null })
        }
        if (!provider || !model) return json(400, { error: 'provider and model are required' })
        const effort = typeof body.reasoningEffort === 'string' && body.reasoningEffort !== ''
          ? body.reasoningEffort
          : undefined
        const next = effort ? { provider, model, reasoningEffort: effort } : { provider, model }
        saveModelOverride(next)
        logger.info(`dsh-wechat-bot: ClawBot model set to ${provider}/${model}${effort ? ` (${effort})` : ''}`)
        return json(200, { ok: true, current: next })
      }
      if (req.method === 'GET' && url.pathname === '/wechat/status') {
        return json(200, { sessionIndex: wechatSessionIndex, sessionKey: `wechat:${wechatSessionIndex}` })
      }
      if (req.method === 'POST' && url.pathname === '/wechat/new') {
        return json(200, { ok: true, sessionIndex: newWechatSession() })
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(200, { ok: true, model: bridgeConfig.modelOverride ?? null })
      }
      return json(404, { error: 'not found' })
    } catch (error) {
      return json(500, { error: String(error.message ?? error) })
    }
  })
  modelServer.on('error', (error) => {
    // 端口被占（例如上一个实例没退干净）时不能让 'error' 事件冒泡：
    // Server 上未处理的 error 会直接终结 DSH 宿主进程。
    logger.warn(`dsh-wechat-bot: model endpoint (port ${config.modelPort}) unavailable: ${String(error)}`)
  })
  modelServer.listen(config.modelPort, '127.0.0.1', () => {
    logger.info(`dsh-wechat-bot: model endpoint on http://127.0.0.1:${config.modelPort}`)
  })

  // ── Host liveness probe ──────────────────────────────────────────────
  // GET /api/dsh-wechat-bot/probe — read-only; proves this host plugin really
  // mounted on the DSH web server. Added by zhengjy01 for the release-kit
  // portability gate (AGENTS.md §10) and any external watcher.
  //
  // The web server may not exist yet when apply() runs, so wait for it with a
  // scoped inject instead of a required `inject` entry: headless profiles stay
  // usable (no web server) while web profiles get the probe.
  const registerProbe = (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: '/api/dsh-wechat-bot/probe',
        handler: (req, res) => {
          const payload = JSON.stringify(probePayload(config.gatewayPort, config.modelPort))
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(payload)
        },
      }),
      'dsh-wechat-bot.probe',
    )
  }
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], registerProbe)
  else logger.warn('dsh-wechat-bot: ctx.inject unavailable — /api/dsh-wechat-bot/probe not registered')

  ctx.effect(
    () => () => {
      stopped = true
      eventsAbort?.abort()
      if (keepaliveTimer !== undefined) clearInterval(keepaliveTimer)
      modelServer.closeAllConnections?.()
      modelServer.close()
      if (child !== undefined) {
        child.kill('SIGTERM')
        setTimeout(() => child?.kill('SIGKILL'), 3000).unref?.()
      }
    },
    'dsh-wechat-bot.lifecycle',
  )
}
