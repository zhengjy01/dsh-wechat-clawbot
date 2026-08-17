/**
 * Minimal harness for createBridge settlement logic: simulates a cordis ctx
 * with a fake agent registry and replays the event sequence of one turn.
 */
import { createBridge } from './index.js'

function makeCtx(agents) {
  const listeners = new Map()
  const ctx = {
    agents: {
      list: () => [...agents.values()],
      get: (id) => agents.get(String(id)),
      create: async () => { throw new Error('no create in test') },
    },
    get: () => undefined,
    logger: { info: () => {}, warn: (m) => console.log('  [warn]', m), error: () => {} },
    effect: () => {},
    on: (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
      return () => {}
    },
  }
  return { ctx, listeners }
}

function makeAgent(id, { idleDelayMs = 0, neverIdle = false } = {}) {
  const agent = {
    session: { id },
    followup: (msg) => { agent.lastMessage = msg },
    cancel: () => {},
    whenIdle: () =>
      new Promise((resolve) => {
        if (neverIdle) return // never resolves — the bug scenario
        setTimeout(resolve, idleDelayMs)
      }),
  }
  return agent
}

/** Fire one session/event on the ctx. */
function fire(listeners, sessionId, event) {
  for (const fn of listeners.get('session/event') ?? []) fn({ header: { id: sessionId } }, event)
}

let passed = 0
let failed = 0
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✅ ${name}`) }
  else { failed++; console.log(`  ❌ ${name} — ${detail ?? ''}`) }
}

const config = {
  sessionMode: 'dedicated', sessionId: '', cwd: process.cwd(), timeoutMs: 5000,
  maxMessageChars: 1000, approval: 'reject', provider: 'p', model: 'm',
}

// ── 场景 1（核心 bug）：agent 处理完我们的回合后仍不空闲（如 GUI 用户在打字）
//    旧逻辑：whenIdle 永不 resolve → 回复卡死。新逻辑：turn/end 一到就结算。
{
  console.log('场景 1: turn/end 即结算（agent 持续不空闲）')
  const agent = makeAgent('s1', { neverIdle: true })
  const { ctx, listeners } = makeCtx(new Map([['s1', agent]]))
  const bridge = createBridge(ctx, { ...config, sessionMode: 'explicit', sessionId: 's1' })
  const promise = bridge.sendText('你好', undefined)
  await Promise.resolve() // let the async ensureAgent/followup run
  const msg = agent.lastMessage
  fire(listeners, 's1', { type: 'agent/inbox/claimed' }) // ignored by session/event
  for (const fn of listeners.get('agent/inbox/claimed') ?? []) {
    fn({ agent, message: { id: msg.id }, turn: 7 })
  }
  // agent 的回复（本 turn）
  fire(listeners, 's1', {
    type: 'assistant/message',
    data: { turn: 7, message: { content: [{ type: 'text', text: '你好！' }] } },
  })
  // 别的 turn 的回复（GUI 用户并行）不应混入
  fire(listeners, 's1', {
    type: 'assistant/message',
    data: { turn: 8, message: { content: [{ type: 'text', text: '这是别人的回合' }] } },
  })
  fire(listeners, 's1', {
    type: 'turn/end',
    data: { turn: 7, reason: { kind: 'normal' } },
  })
  const result = await promise
  check('收到回复（不被 whenIdle 卡死）', result.reply === '你好！', result.reply)
  check('stopReason=end_turn', result.stopReason === 'end_turn', result.stopReason)
  check('未混入其他回合文本', !result.reply.includes('别人的回合'), result.reply)
}

// ── 场景 2：超时兜底
{
  console.log('场景 2: 超时兜底')
  const agent = makeAgent('s2', { neverIdle: true })
  const { ctx, listeners } = makeCtx(new Map([['s2', agent]]))
  const bridge = createBridge(ctx, { ...config, sessionMode: 'explicit', sessionId: 's2', timeoutMs: 200 })
  const t0 = Date.now()
  const result = await bridge.sendText('hi', undefined)
  check('超时返回 partial', result.partial === true, JSON.stringify(result))
  check('耗时约等于 timeout', Date.now() - t0 < 2000, String(Date.now() - t0))
}

// ── 场景 3：turn/end 报错
{
  console.log('场景 3: turn 报错')
  const agent = makeAgent('s3', { neverIdle: true })
  const { ctx, listeners } = makeCtx(new Map([['s3', agent]]))
  const bridge = createBridge(ctx, { ...config, sessionMode: 'explicit', sessionId: 's3' })
  const promise = bridge.sendText('hi', undefined)
  await Promise.resolve() // let the async ensureAgent/followup run
  const msg = agent.lastMessage
  for (const fn of listeners.get('agent/inbox/claimed') ?? []) {
    fn({ agent, message: { id: msg.id }, turn: 3 })
  }
  fire(listeners, 's3', { type: 'turn/end', data: { turn: 3, reason: { kind: 'error', error: new Error('boom') } } })
  try {
    await promise
    check('应 reject', false, 'resolved instead')
  } catch (e) {
    check('错误透出', String(e).includes('boom'), String(e))
  }
}

// ── 场景 4：消息被 admission 丢弃（turn 从未认领）→ whenIdle 兜底 cancelled
{
  console.log('场景 4: turn 从未认领')
  const agent = makeAgent('s4', { idleDelayMs: 50 })
  const { ctx, listeners } = makeCtx(new Map([['s4', agent]]))
  const bridge = createBridge(ctx, { ...config, sessionMode: 'explicit', sessionId: 's4' })
  const result = await bridge.sendText('hi', undefined)
  check('cancelled 兜底', result.stopReason === 'cancelled', result.stopReason)
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
