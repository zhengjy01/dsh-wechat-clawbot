/**
 * WeChat remote-approval harness for createBridge (config.approval = 'wechat'):
 * a bridge-driven turn that hits `approval/request` gets the question pushed to
 * its conversation, waits for a 1 / 2 reply, and falls back to the GUI answerer
 * on timeout / delivery failure — never failing the action silently closed.
 *
 * Uses the same fake-cordis ctx as settle.test.mjs (no network, no DSH host).
 */
import { createBridge } from './index.js'

function makeCtx(agents) {
  const listeners = new Map()
  const ctx = {
    agents: {
      list: () => [...agents.values()],
      get: (id) => agents.get(String(id)),
      create: async () => { throw new Error('no create in test') },
      resume: async () => { throw new Error('no resume in test') },
    },
    get: () => undefined,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: () => {},
    on: (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
      return () => {}
    },
  }
  return { ctx, listeners }
}

function makeAgent(id) {
  const agent = {
    session: { id },
    followup: (msg) => { agent.lastMessage = msg },
    cancel: () => {},
    whenIdle: () => new Promise(() => {}),
  }
  return agent
}

let passed = 0
let failed = 0
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✅ ${name}`) }
  else { failed++; console.log(`  ❌ ${name} — ${detail ?? ''}`) }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Mount one bridge with a capture transport and start an in-flight WeChat turn.
 * @returns { bridge, agent, sent, ask, nextCalls }
 */
async function harness({ timeoutMs = 5000, approvalTimeoutMs = 5000, notify } = {}) {
  const agent = makeAgent('s1')
  const { ctx, listeners } = makeCtx(new Map([['s1', agent]]))
  const sent = []
  const bridge = createBridge(ctx, {
    sessionMode: 'explicit',
    sessionId: 's1',
    cwd: process.cwd(),
    timeoutMs,
    maxMessageChars: 1000,
    approval: 'wechat',
    approvalTimeoutMs,
    provider: 'p',
    model: 'm',
    notify: notify ?? (async (text, sessionKey) => { sent.push({ text, sessionKey }) }),
  })
  const turn = bridge.sendText('做点什么', 'wechat:1')
  turn.catch(() => {}) // settled by the test, never awaited here
  await tick()
  const nextCalls = { count: 0 }
  const next = () => { nextCalls.count += 1; return 'allowed-once' }
  /** Fire one approval ask exactly as the DSH approval service would. */
  const ask = (overrides = {}) => {
    const request = {
      agent,
      toolName: 'bash',
      reason: '命令超出只读范围',
      signal: new AbortController().signal,
      ...overrides,
    }
    return listeners.get('approval/request')[0](request, next)
  }
  return { bridge, agent, sent, ask, nextCalls, turn, listeners }
}

// ── 场景 1：回复 1 → 批准一次 ──────────────────────────────────────────────
{
  console.log('场景 1: 微信回 1 → allowed-once')
  const h = await harness()
  const outcome = h.ask()
  await tick()
  check('问句已发到该对话（带工具名与理由）',
    h.sent.length === 1 && h.sent[0].text.includes('bash') && h.sent[0].text.includes('命令超出只读范围'),
    JSON.stringify(h.sent))
  check('问句回到正确的对话 key', h.sent[0]?.sessionKey === 'wechat:1', h.sent[0]?.sessionKey)
  check('待批计数为 1', h.bridge.approvalCount() === 1, String(h.bridge.approvalCount()))
  check('回复被认领', h.bridge.claimApprovalReply('1', 'wechat:1') === true)
  const resolved = await outcome
  check('交回 allowed-once', resolved === 'allowed-once', String(resolved))
  await tick()
  check('回执已发（✅ 已批准一次）',
    h.sent.some((m) => m.text.includes('已批准一次')), JSON.stringify(h.sent))
  check('答完清空待批', h.bridge.approvalCount() === 0, String(h.bridge.approvalCount()))
  check('未回退给 GUI', h.nextCalls.count === 0, String(h.nextCalls.count))
}

// ── 场景 2：回复 2（以及 /reject）→ 拒绝 ──────────────────────────────────
{
  console.log('场景 2: 微信回 2 → rejected')
  const h = await harness()
  const outcome = h.ask()
  await tick()
  check('回复被认领', h.bridge.claimApprovalReply('2', 'wechat:1') === true)
  check('交回 rejected', (await outcome) === 'rejected')
  await tick()
  check('回执已发（❌ 已拒绝）', h.sent.some((m) => m.text.includes('已拒绝')), JSON.stringify(h.sent))
}
{
  console.log('场景 2b: /reject 同样被认领')
  const h = await harness()
  const outcome = h.ask()
  await tick()
  check('斜杠命令被认领', h.bridge.claimApprovalReply('/reject', 'wechat:1') === true)
  check('交回 rejected', (await outcome) === 'rejected')
}

// ── 场景 3：无关文本不得被吞（否则会把 prompt 当审批） ─────────────────────
{
  console.log('场景 3: 无关文本不认领')
  const h = await harness()
  const outcome = h.ask()
  await tick()
  for (const text of ['你好', '1+1', '帮我看下日志', '']) {
    check(`「${text}」不认领`, h.bridge.claimApprovalReply(text, 'wechat:1') === false)
  }
  check('仍在待批', h.bridge.approvalCount() === 1)
  check('别的对话答不了', h.bridge.claimApprovalReply('1', 'wechat:2') === false)
  h.bridge.claimApprovalReply('1', 'wechat:1')
  await outcome
}

// ── 场景 4：超时 → 让位给 GUI（next），并告知用户 ─────────────────────────
{
  console.log('场景 4: 超时 → 转 GUI')
  const h = await harness({ approvalTimeoutMs: 40 })
  const outcome = await h.ask()
  // delegate 路径把 GUI answerer 的结果原样交回瀑布（这里 fake next 返回 allowed-once）
  check('转给 GUI answerer', h.nextCalls.count === 1, String(h.nextCalls.count))
  check('瀑布拿到 GUI 的决定', outcome === 'allowed-once', String(outcome))
  check('已告知用户超时', h.sent.some((m) => m.text.includes('超时')), JSON.stringify(h.sent))
  check('待批已清空', h.bridge.approvalCount() === 0)
}

// ── 场景 5：问句发不出去（窗口关/发送失败）→ 也不能卡死，转 GUI ───────────
{
  console.log('场景 5: 问句投递失败 → 转 GUI')
  const h = await harness({ notify: async () => { throw new Error('ret=-2 prepare failed') } })
  const outcome = await h.ask()
  check('转给 GUI answerer', h.nextCalls.count === 1, String(h.nextCalls.count))
  check('瀑布拿到 GUI 的决定', outcome === 'allowed-once', String(outcome))
  check('待批已清空', h.bridge.approvalCount() === 0)
}

// ── 场景 6：非桥接会话（GUI 自己发起的回合）一律让位 ──────────────────────
{
  console.log('场景 6: 非桥接回合不插手')
  const h = await harness()
  const otherAgent = makeAgent('gui-session')
  const nextCalls = { count: 0 }
  const handlers = h.listeners.get('approval/request')
  const outcome = await handlers[0](
    { agent: otherAgent, toolName: 'bash', signal: new AbortController().signal },
    () => { nextCalls.count += 1; return 'allowed-once' },
  )
  check('让位给 GUI answerer', nextCalls.count === 1 && outcome === 'allowed-once', JSON.stringify({ nextCalls, outcome }))
  check('没有发问句', h.sent.length === 0, JSON.stringify(h.sent))
}

// ── 场景 7：并发 ask 串行发问，一次只问一条 ──────────────────────────────
{
  console.log('场景 7: 多条待批串行发问')
  const h = await harness()
  const first = h.ask({ toolName: 'bash' })
  const second = h.ask({ toolName: 'write' })
  const third = h.ask({ toolName: 'edit' })
  await tick()
  check('只发了第一条问句', h.sent.length === 1 && h.sent[0].text.includes('bash'), JSON.stringify(h.sent))
  check('待批计数为 3', h.bridge.approvalCount() === 3, String(h.bridge.approvalCount()))
  h.bridge.claimApprovalReply('1', 'wechat:1')
  await tick()
  const secondText = h.sent.find((m) => m.text.includes('write'))?.text ?? ''
  check('答完后自动发第二条', secondText !== '', JSON.stringify(h.sent.map((m) => m.text)))
  check('第二条标注还有 1 条排队', secondText.includes('还有 1 条排队'), secondText)
  check('第三条仍未发出', !h.sent.some((m) => m.text.includes('edit')), JSON.stringify(h.sent.map((m) => m.text)))
  h.bridge.claimApprovalReply('2', 'wechat:1')
  await tick()
  check('答完后发第三条', h.sent.some((m) => m.text.includes('edit')), JSON.stringify(h.sent.map((m) => m.text)))
  h.bridge.claimApprovalReply('2', 'wechat:1')
  check('三条结果正确',
    (await first) === 'allowed-once' && (await second) === 'rejected' && (await third) === 'rejected',
    JSON.stringify(await Promise.all([first, second, third])))
}

// ── 场景 8：回合结束（超时/取消）→ 待批作废，交回 cancelled ─────────────
{
  console.log('场景 8: 回合结束作废待批')
  const h = await harness({ timeoutMs: 40 })
  const outcome = h.ask()
  await tick()
  const settled = await h.turn // 回合超时 → releaseApprovals
  check('回合以超时收场', settled.stopReason === 'timeout', settled.stopReason)
  check('待批交回 cancelled', (await outcome) === 'cancelled')
  check('待批已清空', h.bridge.approvalCount() === 0)
}

// ── 场景 9：reject 模式不变；wechat 模式没有出站通道时退化为让位 ──────────
{
  console.log('场景 9: 旧模式与无通道兜底')
  const agent = makeAgent('s9')
  const { ctx, listeners } = makeCtx(new Map([['s9', agent]]))
  const bridge = createBridge(ctx, {
    sessionMode: 'explicit', sessionId: 's9', cwd: process.cwd(), timeoutMs: 5000,
    maxMessageChars: 1000, approval: 'reject', provider: 'p', model: 'm',
  })
  void bridge.sendText('hi', 'wechat:1')
  await tick()
  const outcome = await listeners.get('approval/request')[0](
    { agent, toolName: 'bash', signal: new AbortController().signal },
    () => 'allowed-once',
  )
  check('reject 模式直接拒绝', outcome === 'rejected', String(outcome))

  const agent2 = makeAgent('s9b')
  const plain = makeCtx(new Map([['s9b', agent2]]))
  const bridge2 = createBridge(plain.ctx, {
    sessionMode: 'explicit', sessionId: 's9b', cwd: process.cwd(), timeoutMs: 5000,
    maxMessageChars: 1000, approval: 'wechat', approvalTimeoutMs: 5000,
    provider: 'p', model: 'm',
  })
  void bridge2.sendText('hi', 'wechat:1')
  await tick()
  let calls = 0
  const out2 = await plain.listeners.get('approval/request')[0](
    { agent: agent2, toolName: 'bash', signal: new AbortController().signal },
    () => { calls += 1; return 'rejected' },
  )
  check('wechat 模式无 notify 时让位给 GUI', calls === 1 && out2 === 'rejected', JSON.stringify({ calls, out2 }))
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
