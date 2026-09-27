/**
 * dsh-wechat-bridge — DeepSeek Harness host plugin.
 *
 * Exposes a loopback HTTP bridge that lets an external messenger talk to the
 * DSH agent running in this process:
 *
 *   POST /message   { text, sessionKey? }  →  { reply, sessionId, stopReason }
 *   POST /cancel    { sessionId? }         →  { ok }
 *   GET  /health                           →  { ok, session, pending, approvals }
 *   GET  /sessions                         →  { sessions: [...] }
 *
 * The reply is the committed assistant text of the turn, collected from
 * `session/event` streams — the same committed text the GUI renders. One turn
 * per session runs at a time; extra messages queue per session.
 *
 * With `approval: 'wechat'` the caller may inject a `notify(text, sessionKey)`
 * transport into the config; bridge-driven turns then ask the messenger for a
 * decision (`claimApprovalReply(text, sessionKey)` consumes the answer) and
 * delegate the ask to the GUI answerer on timeout or delivery failure.
 *
 * The session-driving core is exported as {@link createBridge} so other host
 * plugins (e.g. dsh-wechat-bot) can inject messages without the HTTP surface.
 *
 * Session targeting (config `sessionMode`):
 *   active     — most recently created live session (the GUI conversation the
 *                user is currently looking at); falls back to a bridge-owned
 *                session when none exists.
 *   dedicated  — one bridge-owned session shared by everyone.
 *   keyed      — one bridge-owned session per inbound `sessionKey`
 *                (per WeChat conversation, passed by the OpenClaw plugin).
 *   explicit   — a fixed session id from config `sessionId`.
 *
 * Security: binds 127.0.0.1 by default. For remote use bind 0.0.0.0 and set
 * `authToken` (sent as `Authorization: Bearer <token>`), or tunnel over SSH.
 */

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { dirname } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'dsh-wechat-bridge'
/** The agent registry is the only injected service; everything else is events. */
export const inject = ['agents']

/** Plugin config, validated by schemastery at mount time. */
export const Config = Schema.object({
  /** Loopback bind host. '0.0.0.0' exposes the bridge to the LAN — pair with authToken. */
  host: Schema.string().default('127.0.0.1'),
  /** Listen port. */
  port: Schema.number().default(51234),
  /** Optional bearer token; empty means no auth (loopback only). */
  authToken: Schema.string().default(''),
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
  /** How long a turn may run before the bridge settles with what it has. */
  timeoutMs: Schema.number().default(300000),
  /** Reject inbound text longer than this many characters. */
  maxMessageChars: Schema.number().default(20000),
  /**
   * Approval policy for bridged turns:
   *   'reject' — auto-reject and note it in the reply (the GUI user can re-run);
   *   'ignore' — leave the ask pending for the GUI answerer;
   *   'wechat' — ask in the messenger and wait for a reply (1 批准 / 2 拒绝);
   *              without a `notify` transport, or on timeout, it delegates to
   *              the GUI answerer instead of failing the action closed.
   */
  approval: Schema.union([
    Schema.const('reject'),
    Schema.const('ignore'),
    Schema.const('wechat'),
  ]).default('reject'),
  /**
   * How long a messenger approval question waits for a reply before it is
   * delegated to the GUI answerer (ms; 0 = wait until the turn ends).
   */
  approvalTimeoutMs: Schema.number().default(180000),
  /** Optional provider override for bridge-owned sessions. */
  provider: Schema.string(),
  /** Optional model override for bridge-owned sessions. */
  model: Schema.string(),
})

/** Extract committed assistant text blocks from one assistant message event. */
function assistantText(event) {
  const parts = []
  for (const block of event.data.message.content) {
    if (block.type === 'text' && block.text.length > 0) parts.push(block.text)
    else if (block.type === 'image') parts.push(`[图片附件 ${block.attachment.attachmentId}]`)
  }
  return parts
}

/**
 * The session-driving core shared by the HTTP bridge and dsh-wechat-bot.
 * Owns per-session turn serialization, committed-reply collection, and the
 * event correlation that settles a turn at whole-agent idle.
 * @param ctx - Cordis context carrying the agent registry.
 * @param config - validated bridge configuration (sessionMode/sessionId/cwd/timeoutMs/...).
 * @returns the bridge handle.
 */
export function createBridge(ctx, config) {
  const agents = ctx.agents
  const logger = ctx.logger

  /** sessionId (string) → record of one session the bridge may drive. */
  const records = new Map()
  /** sessionId → registration time, for 'active' mode (most recent wins). */
  const known = new Map()
  /** Logical bridge key ('active' | 'default' | per-conversation key) → real session id. */
  const ownedSessions = new Map()

  // 持久化 key→sessionId 映射：重启后同一微信对话（如 wechat:1）回到同一
  // 个会话 id，配合 agents.resume 恢复历史上下文，而不是另开新会话。
  const sessionMapFile = config.sessionMapFile
  if (sessionMapFile) {
    try {
      const stored = JSON.parse(fs.readFileSync(sessionMapFile, 'utf8'))
      for (const [key, id] of Object.entries(stored)) {
        if (typeof key === 'string' && typeof id === 'string' && id !== '') {
          ownedSessions.set(key, id)
        }
      }
    } catch {
      /* no persisted map yet */
    }
  }
  const persistSessionMap = () => {
    if (!sessionMapFile) return
    try {
      fs.mkdirSync(dirname(sessionMapFile), { recursive: true })
      fs.writeFileSync(
        sessionMapFile,
        JSON.stringify(Object.fromEntries(ownedSessions), null, 2),
        'utf8',
      )
    } catch {
      /* best effort */
    }
  }

  /** Resolve (and on first use allocate) the real session id for a bridge-owned key. */
  const ownedSessionId = (key) => {
    let sessionId = ownedSessions.get(key)
    if (sessionId === undefined) {
      sessionId = String(SessionId(randomUUID()))
      ownedSessions.set(key, sessionId)
      persistSessionMap()
    }
    return sessionId
  }

  // Sweep already-live agents at mount (a hot reload does not replay
  // session/created), then keep tracking newly created sessions.
  const sweep = () => {
    for (const agent of agents.list()) known.set(String(agent.session.id), Date.now())
  }
  sweep()
  ctx.on('session/created', (session) => {
    known.set(String(session.header.id), Date.now())
  })
  ctx.on('session/disposed', (session) => {
    known.delete(String(session.header.id))
  })

  const recordFor = (sessionId) => {
    let record = records.get(sessionId)
    if (record === undefined) {
      record = { inflight: undefined, queue: [] }
      records.set(sessionId, record)
    }
    return record
  }

  // ── messenger approvals (config.approval === 'wechat') ─────────────────────
  // A bridged turn that hits an approval ask sends the question to its own
  // conversation and waits for the reply. `notify` is the outbound transport
  // injected by the caller (dsh-wechat-bot wires it to the gateway); the HTTP
  // bridge has none, so 'wechat' degrades to delegating the ask to the GUI.
  const notify = typeof config.notify === 'function' ? config.notify : undefined
  /** Words accepted as a grant / a refusal, matched case-insensitively. */
  const APPROVAL_ALLOW = new Set(['1', 'y', 'yes', 'ok', 'approve', '/approve', '批准', '同意', '允许', '通过'])
  const APPROVAL_DENY = new Set(['2', 'n', 'no', 'reject', '/reject', '拒绝', '不同意', '驳回'])
  /** conversation key → { pending: ask[], active?: ask }; one question in flight per conversation. */
  const approvals = new Map()

  const approvalQueueFor = (key) => {
    let queue = approvals.get(key)
    if (queue === undefined) {
      queue = { pending: [], active: undefined }
      approvals.set(key, queue)
    }
    return queue
  }

  const askText = (ask, waiting) =>
    [
      `⚠️ 需要审批${waiting > 1 ? `（还有 ${waiting - 1} 条排队）` : ''}`,
      `工具：${ask.tool}`,
      ...(ask.reason !== undefined && ask.reason !== '' ? [`理由：${ask.reason}`] : []),
      '',
      '回复 1 = 批准一次 / 2 = 拒绝',
      config.approvalTimeoutMs > 0
        ? `${Math.round(config.approvalTimeoutMs / 1000)} 秒内未回复则转到电脑上的 DSH 界面处理。`
        : '未回复前该操作会一直等待。',
    ].join('\n')

  /**
   * Settle one ask and move the conversation's queue forward.
   * @param ask - the ask being settled.
   * @param outcome - 'allowed-once' | 'rejected' | 'cancelled' | 'delegate'.
   * @param note - optional confirmation line pushed back to the conversation.
   */
  const finishAsk = (ask, outcome, note) => {
    if (ask.settled) return
    ask.settled = true
    clearTimeout(ask.timer)
    const queue = approvals.get(ask.key)
    if (queue !== undefined) {
      const at = queue.pending.indexOf(ask)
      if (at >= 0) queue.pending.splice(at, 1)
      if (queue.active === ask) queue.active = undefined
      if (queue.pending.length === 0 && queue.active === undefined) approvals.delete(ask.key)
    }
    ask.resolve(outcome)
    if (note !== undefined && notify !== undefined) {
      void Promise.resolve()
        .then(() => notify(note, ask.sessionKey))
        .catch((error) => logger.warn(`dsh-wechat-bridge: approval note failed: ${String(error)}`))
    }
    const next = approvals.get(ask.key)?.pending[0]
    if (next !== undefined) void sendAsk(next)
  }

  /** Push one ask to its conversation and arm its timeout. */
  const sendAsk = async (ask) => {
    const queue = approvals.get(ask.key)
    if (queue === undefined || ask.settled) return
    queue.active = ask
    try {
      await notify(askText(ask, queue.pending.length), ask.sessionKey)
    } catch (error) {
      logger.warn(`dsh-wechat-bridge: approval prompt not delivered (${String(error)}) — delegating to the GUI`)
      finishAsk(ask, 'delegate')
      return
    }
    if (ask.settled) return
    if (config.approvalTimeoutMs > 0) {
      ask.timer = setTimeout(() => {
        finishAsk(ask, 'delegate', `⏱ 审批超时（${ask.tool}），已转到电脑上的 DSH 界面处理。`)
      }, config.approvalTimeoutMs)
    }
  }

  /**
   * Ask the messenger to decide one approval request.
   * @returns 'allowed-once' | 'rejected' | 'cancelled', or 'delegate' when the
   *   question could not be asked (no transport) so the caller calls `next()`.
   */
  const askInMessenger = (key, sessionKey, request) =>
    new Promise((resolve) => {
      const ask = {
        key,
        sessionKey,
        tool: request.toolName,
        reason: typeof request.reason === 'string' ? request.reason : undefined,
        resolve,
        timer: undefined,
        settled: false,
      }
      queueMicrotask(() => {
        if (ask.settled) return
        const queue = approvalQueueFor(key)
        queue.pending.push(ask)
        // Withdrawing the question (turn ended / cancelled) releases the wait:
        // the service already settled the request, so the value is discarded.
        request.signal?.addEventListener?.('abort', () => finishAsk(ask, 'cancelled'), { once: true })
        if (queue.active === undefined) void sendAsk(ask)
      })
    })

  /**
   * Consume one inbound messenger text as the answer to a pending question.
   * @returns true when the text was consumed — callers must not forward it to
   *   the agent as a prompt.
   */
  const claimApprovalReply = (text, sessionKey) => {
    const token = String(text ?? '').trim().toLowerCase()
    const outcome = APPROVAL_ALLOW.has(token)
      ? 'allowed-once'
      : APPROVAL_DENY.has(token)
        ? 'rejected'
        : undefined
    if (outcome === undefined) return false
    const key = sessionKey ?? ''
    const ask = approvals.get(key)?.active
    if (ask === undefined) return false
    finishAsk(
      ask,
      outcome,
      outcome === 'allowed-once'
        ? `✅ 已批准一次（${ask.tool}）`
        : `❌ 已拒绝（${ask.tool}）`,
    )
    return true
  }

  /** Release every question of a session whose turn settled or failed. */
  const releaseApprovals = (sessionId, sessionKey) => {
    for (const key of new Set([sessionKey ?? sessionId, sessionId])) {
      const queue = approvals.get(key)
      if (queue === undefined) continue
      for (const ask of [...queue.pending]) finishAsk(ask, 'cancelled')
    }
  }

  /** Questions currently waiting for a messenger reply. */
  const approvalCount = () =>
    [...approvals.values()].reduce((n, queue) => n + queue.pending.length, 0)

  /** Resolve the target session id for one inbound message. */
  const resolveSessionId = (requestedKey) => {
    if (config.sessionMode === 'explicit') {
      if (config.sessionId === '') throw new Error('sessionMode explicit requires config sessionId')
      return config.sessionId
    }
    if (config.sessionMode === 'keyed') {
      if (requestedKey === undefined || requestedKey === '') {
        throw new Error('sessionMode keyed requires a sessionKey in the request body')
      }
      return ownedSessionId(`key:${requestedKey}`)
    }
    if (config.sessionMode === 'dedicated') return ownedSessionId('default')
    // active: most recently created live session, else a bridge-owned one.
    let newest
    let newestAt = -1
    for (const [id, at] of known) {
      if (at > newestAt && agents.get(SessionId(id)) !== undefined) {
        newest = id
        newestAt = at
      }
    }
    return newest ?? ownedSessionId('active')
  }

  /** Ensure a live Agent exists for a session id; resume persisted ones on demand. */
  const ensureAgent = async (sessionId) => {
    const live = agents.get(SessionId(sessionId))
    if (live !== undefined) return live
    // Bridge-owned sessions need an explicit model route: the persona section
    // resolves {{model}} from the agent's options, which entry-point-created
    // agents only get when the caller passes them. Read the deployment's
    // default selection (the same source the GUI uses) unless the plugin
    // config overrides provider/model.
    let provider = config.modelOverride?.provider ?? config.provider
    let model = config.modelOverride?.model ?? config.model
    if (provider === undefined || model === undefined) {
      const fallback = ctx.get('agentDefaultModel')?.currentSelection()
      if (fallback !== undefined) {
        provider ??= fallback.provider
        model ??= fallback.model
      }
    }
    const options = {}
    if (provider !== undefined) options.provider = provider
    if (model !== undefined) options.model = model
    const common = {
      meta: { cwd: config.cwd },
      agentOptions: options,
    }
    // 先尝试恢复持久化会话（重启后同 key 回到同一会话，上下文延续）；
    // 该 id 从未持久化时 resume 失败，退回新建。
    let handle
    try {
      handle = await agents.resume({ resumeSessionId: SessionId(sessionId), ...common })
      logger.info(`dsh-wechat-bridge: resumed session ${sessionId} (${provider ?? '?'}/${model ?? '?'})`)
    } catch (resumeError) {
      handle = await agents.create({ sessionId: SessionId(sessionId), ...common })
      logger.info(`dsh-wechat-bridge: created session ${sessionId} (${provider ?? '?'}/${model ?? '?'})`)
    }
    const agent = handle.agent
    ctx.effect(() => handle.dispose, `dsh-wechat-bridge.agent(${sessionId})`)
    return agent
  }

  /**
   * Start one turn on a session and collect the committed reply.
   * Correlation mirrors the ACP bridge: the turn number is learned from
   * `agent/inbox/claimed`, and the turn settles at its own `turn/end` — NOT at
   * whole-agent idle. A shared GUI session never idles while the human types
   * or a background task runs; waiting for idle left WeChat replies stuck
   * even though the GUI already showed the answer. `whenIdle` remains only as
   * a fallback for turns the admission gate discarded (no turn ever claimed).
   */
  const startTurn = (record, sessionId, text, sessionKey, resolve, reject) => {
    const agent = agents.get(SessionId(sessionId))
    if (agent === undefined) throw new Error(`session ${sessionId} is gone`)
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    const inflight = {
      messageId: message.id,
      turn: undefined,
      sessionKey,
      chunks: [],
      timer: undefined,
      resolve,
      reject,
      settle: undefined,
      fail: undefined,
    }
    record.inflight = inflight
    const settle = (reason) => {
      if (record.inflight !== inflight) return
      record.inflight = undefined
      clearTimeout(inflight.timer)
      releaseApprovals(sessionId, inflight.sessionKey)
      inflight.resolve({
        reply: inflight.chunks.join(''),
        stopReason: reason,
        partial: reason === 'timeout' || reason === 'cancelled',
      })
      drain(record, sessionId)
    }
    const fail = (error) => {
      if (record.inflight !== inflight) return
      record.inflight = undefined
      clearTimeout(inflight.timer)
      releaseApprovals(sessionId, inflight.sessionKey)
      inflight.reject(error)
      drain(record, sessionId)
    }
    inflight.settle = settle
    inflight.fail = fail
    inflight.timer = setTimeout(() => {
      logger.warn(`dsh-wechat-bridge: turn timeout after ${config.timeoutMs}ms in ${sessionId}`)
      settle('timeout')
    }, config.timeoutMs)
    try {
      agent.followup(message)
    } catch (error) {
      fail(new Error(`message was not queued: ${String(error)}`))
      return
    }
    // Fallback only: if no turn was ever claimed, the admission gate dropped
    // the message — settle cancelled rather than hang.
    void agent.whenIdle().then(() => {
      if (record.inflight !== inflight) return
      if (inflight.turn === undefined) settle('cancelled')
    })
  }

  /** Run one user text through a session, serialized behind in-flight turns. */
  const enqueue = (record, sessionId, text, sessionKey) =>
    new Promise((resolve, reject) => {
      if (record.inflight === undefined) {
        try {
          startTurn(record, sessionId, text, sessionKey, resolve, reject)
        } catch (error) {
          reject(error)
        }
      } else {
        record.queue.push({ text, sessionKey, resolve, reject })
      }
    })

  /** Dequeue the next waiting message for a session. */
  const drain = (record, sessionId) => {
    if (record.inflight !== undefined || record.queue.length === 0) return
    const next = record.queue.shift()
    try {
      startTurn(record, sessionId, next.text, next.sessionKey, next.resolve, next.reject)
    } catch (error) {
      next.reject(error)
      drain(record, sessionId)
    }
  }

  // ── agent event correlation: stream committed text, settle at turn/end ──
  ctx.on('session/event', (session, event) => {
    const record = records.get(String(session.header.id))
    const inflight = record?.inflight
    if (inflight === undefined) return
    try {
      if (event.type === 'assistant/message') {
        // Once the turn is known, keep only that turn's committed text so a
        // parallel GUI conversation cannot leak into the WeChat reply.
        if (inflight.turn === undefined || event.data.turn === inflight.turn) {
          for (const part of assistantText(event)) inflight.chunks.push(part)
        }
      }
    } finally {
      if (event.type === 'turn/end' && inflight.turn === event.data.turn) {
        if (event.data.reason.kind === 'error') {
          inflight.fail(new Error(`turn failed: ${event.data.reason.error.message}`))
        } else {
          inflight.settle(event.data.reason.kind === 'max-tokens' ? 'max-tokens' : 'end_turn')
        }
      }
    }
  })

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const record = records.get(String(agent.session.id))
    const inflight = record?.inflight
    if (inflight !== undefined && inflight.messageId === message.id) inflight.turn = turn
  })

  ctx.on('agent/error', ({ agent, turn, error }) => {
    const record = records.get(String(agent.session.id))
    const inflight = record?.inflight
    if (record === undefined || inflight === undefined || inflight.turn !== turn) return
    const sessionId = String(agent.session.id)
    clearTimeout(inflight.timer)
    record.inflight = undefined
    inflight.reject(new Error(String(error)))
    drain(record, sessionId)
  })

  // Dynamic ClawBot model: when a modelOverride is configured, every model
  // request of a bridge-driven turn (matched by turn number) is rewritten to
  // the override's provider/model/reasoning effort. GUI-initiated turns of the
  // same session are untouched, so the two surfaces never fight.
  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    const record = records.get(String(payload.agent.session.id))
    const inflight = record?.inflight
    const override = config.modelOverride
    if (inflight === undefined || inflight.turn !== payload.turn || override === undefined) {
      return resolved
    }
    const { reasoningEffort: inheritedEffort, ...withoutInheritedEffort } = resolved
    return {
      ...withoutInheritedEffort,
      provider: override.provider,
      model: override.model,
      ...(override.reasoningEffort
        ? { reasoningEffort: override.reasoningEffort }
        : {}),
    }
  })

  // Bridged turns decide approvals here, per config.approval:
  //   'reject' — refuse and note it in the reply (the GUI user can re-run);
  //   'ignore' — leave the ask to the GUI answerer;
  //   'wechat' — ask in the messenger and wait for 1 / 2, delegating to the GUI
  //              on timeout, on delivery failure, or when no transport exists.
  // Asks from sessions the bridge does not drive always fall through to `next()`.
  ctx.on('approval/request', async (request, next) => {
    const record = records.get(String(request.agent.session.id))
    if (record === undefined || record.inflight === undefined) return next()
    if (config.approval === 'ignore') return next()
    if (config.approval === 'wechat') {
      if (notify === undefined) return next()
      const sessionKey = record.inflight.sessionKey
      const key = sessionKey ?? String(request.agent.session.id)
      const outcome = await askInMessenger(key, sessionKey, request)
      if (outcome === 'delegate') return next()
      return outcome
    }
    record.inflight.chunks.push('\n\n> ⚠️ 该操作需要批准，已在 GUI 中拒绝，请在 GUI 中手动执行。')
    return 'rejected'
  })

  /** Send one user text into a bridge-targeted session; resolves with the committed reply. */
  const sendText = async (text, sessionKey) => {
    const sessionId = resolveSessionId(sessionKey)
    await ensureAgent(sessionId)
    const record = recordFor(sessionId)
    const result = await enqueue(record, sessionId, text, sessionKey)
    return { ...result, sessionId }
  }

  /** Live sessions known to the bridge, newest last. */
  const liveSessionIds = () =>
    [...known.keys()].filter((id) => agents.get(SessionId(id)) !== undefined)

  /** Number of pending + in-flight turns across all bridged sessions. */
  const pendingCount = () =>
    [...records.values()].reduce(
      (n, r) => n + (r.inflight !== undefined ? 1 : 0) + r.queue.length,
      0,
    )

  /** Cancel the in-flight turn of a bridge-targeted session (if any). */
  const cancelTurn = (sessionKey) => {
    const sessionId = resolveSessionId(sessionKey)
    const agent = agents.get(SessionId(sessionId))
    const record = records.get(sessionId)
    if (agent !== undefined) agent.cancel({ kind: 'user' })
    if (record?.inflight !== undefined) {
      clearTimeout(record.inflight.timer)
      record.inflight.resolve({
        reply: record.inflight.chunks.join(''),
        stopReason: 'cancelled',
        partial: true,
      })
      record.inflight = undefined
      drain(record, sessionId)
    }
    return sessionId
  }

  return {
    sendText,
    cancelTurn,
    liveSessionIds,
    pendingCount,
    resolveSessionId,
    claimApprovalReply,
    approvalCount,
  }
}

/**
 * Mount the bridge.
 * @param ctx - Cordis context carrying the agent registry.
 * @param config - validated plugin config.
 */
export function apply(ctx, config) {
  const bridge = createBridge(ctx, config)
  const agents = ctx.agents
  const logger = ctx.logger

  // ── HTTP surface ─────────────────────────────────────────────────────────
  const authorized = (req) =>
    config.authToken === '' || req.headers.authorization === `Bearer ${config.authToken}`

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let data = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        data += chunk
        if (data.length > 1024 * 1024) {
          reject(new Error('request body too large'))
          req.destroy()
        }
      })
      req.on('end', () => resolve(data))
      req.on('error', reject)
    })

  const json = (res, status, body) => {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
    })
    res.end(payload)
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
    try {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' })
      if (req.method === 'GET' && url.pathname === '/health') {
        const live = bridge.liveSessionIds()
        return json(res, 200, {
          ok: true,
          mode: config.sessionMode,
          session: live.length > 0 ? live[live.length - 1] : null,
          pending: bridge.pendingCount(),
          approvals: bridge.approvalCount(),
        })
      }
      if (req.method === 'GET' && url.pathname === '/sessions') {
        const sessions = bridge.liveSessionIds()
        return json(res, 200, { sessions })
      }
      if (req.method === 'POST' && url.pathname === '/message') {
        let body
        try {
          body = JSON.parse((await readBody(req)) || '{}')
        } catch {
          return json(res, 400, { error: 'invalid JSON body' })
        }
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (text === '') return json(res, 400, { error: 'missing text' })
        if (text.length > config.maxMessageChars) {
          return json(res, 400, { error: `text exceeds ${config.maxMessageChars} characters` })
        }
        const sessionKey = typeof body.sessionKey === 'string' ? body.sessionKey : undefined
        try {
          const result = await bridge.sendText(text, sessionKey)
          return json(res, 200, result)
        } catch (error) {
          return json(res, 502, { error: String(error.message ?? error) })
        }
      }
      if (req.method === 'POST' && url.pathname === '/cancel') {
        let body = {}
        try {
          body = JSON.parse((await readBody(req)) || '{}')
        } catch {
          /* ignore body parse errors on cancel */
        }
        const sessionKey = typeof body.sessionKey === 'string' ? body.sessionKey : undefined
        try {
          const sessionId = bridge.cancelTurn(sessionKey)
          return json(res, 200, { ok: true, sessionId })
        } catch (error) {
          return json(res, 400, { error: String(error.message ?? error) })
        }
      }
      return json(res, 404, { error: 'not found' })
    } catch (error) {
      logger.warn(`dsh-wechat-bridge: ${String(error)}`)
      return json(res, 500, { error: String(error.message ?? error) })
    }
  })

  server.on('error', (error) => {
    logger.error(`dsh-wechat-bridge: HTTP server failed: ${String(error)}`)
  })

  server.listen(config.port, config.host, () => {
    logger.info(
      `dsh-wechat-bridge: listening on http://${config.host}:${config.port} (mode ${config.sessionMode})`,
    )
  })

  // Close active long-polls first so disposal never waits on a pending turn.
  ctx.effect(
    () => () => {
      server.closeAllConnections?.()
      server.close()
    },
    'dsh-wechat-bridge.server',
  )
}
