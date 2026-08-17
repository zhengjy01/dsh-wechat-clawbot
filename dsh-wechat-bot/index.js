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

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import fs from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, isAbsolute } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { createBridge } from 'dsh-wechat-bridge'

export const name = 'dsh-wechat-bot'
/** The agent registry is accessed through createBridge; declare it for this fiber. */
export const inject = ['agents']

/** Plugin config, validated by schemastery at mount time. */
export const Config = Schema.object({
  /** Gateway HTTP port. */
  gatewayPort: Schema.number().default(51235),
  /** Directory containing the wechat-gateway package (gateway.mjs). */
  gatewayDir: Schema.string().default(''),
  /** Gateway state dir (accounts/allowlist); empty = ~/.dsh-wechat. */
  stateDir: Schema.string().default(''),
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
  /** HTTP port for the ClawBot model-management endpoint (GET/POST /model). */
  modelPort: Schema.number().default(51236),
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

  startGateway()
  void consumeEvents()
  void healthLoop()

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
  modelServer.listen(config.modelPort, '127.0.0.1', () => {
    logger.info(`dsh-wechat-bot: model endpoint on http://127.0.0.1:${config.modelPort}`)
  })

  ctx.effect(
    () => () => {
      stopped = true
      eventsAbort?.abort()
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
