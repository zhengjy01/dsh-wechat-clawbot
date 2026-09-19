/**
 * window.mjs — pure helpers for the WeChat (iLink) conversation-window health.
 *
 * Background (2026-09-19): Tencent's iLink `sendmessage` only succeeds while the
 * user's conversation window is open. The local `phase` never reflects that — it
 * can say `logged_in` while every proactive push is rejected. Two `ret` codes are
 * the whole story:
 *
 *   ret=-2  prepare failed    → window CLOSED (no conversation context)
 *   ret=-3  invalid arguments → window OPEN   (Tencent reached parameter validation)
 *
 * A send to a **nonexistent** recipient therefore reaches parameter validation
 * without delivering anything: it is a harmless, zero-message window probe.
 * Measured boundary (2026-09-19): 3h / 5h after the last inbound still works,
 * 22.7h is closed (the real value between 5h and 22.7h is not calibrated).
 *
 * This module has no I/O and no server state, so the gateway and the unit tests
 * share exactly one implementation of the classification/reporting rules.
 */

export const WINDOW_OPEN = 'open'
export const WINDOW_CLOSED = 'closed'
export const WINDOW_UNKNOWN = 'unknown'

/** Recipient used by the silent probe. Must never exist. */
export const PROBE_RECIPIENT = 'dsh-window-probe-0000@im.wechat'

/**
 * Extract the iLink `ret` code from an Error (with a numeric `.ret`), from a raw
 * response object, or from a message string (`"sendMessage ret=-2 prepare failed"`).
 * Returns `null` when no code is present.
 */
export function extractRet(value) {
  if (value !== null && typeof value === 'object') {
    const direct = Number(value.ret)
    if (Number.isFinite(direct) && direct !== 0) return direct
  }
  const text =
    typeof value === 'string' ? value : String(value?.message ?? value ?? '')
  const match = /ret=(-?\d+)\b/.exec(text)
  return match ? Number(match[1]) : null
}

/**
 * Classify a failed send into a window observation plus a human-readable hint.
 * Never throws.
 */
export function classifySendError(value) {
  const ret = extractRet(value)
  if (ret === -2) {
    return {
      ret,
      reason: 'window_closed',
      window: WINDOW_CLOSED,
      hint:
        '腾讯侧会话窗口已关闭：主动推送拿不到会话上下文。让用户在微信里给机器人回一句话即可恢复；恢复前请用其它渠道（例如 macOS 通知）兜底。',
    }
  }
  if (ret === -3) {
    return {
      ret,
      reason: 'window_open_invalid_arguments',
      window: WINDOW_OPEN,
      hint:
        '会话窗口是开着的（腾讯已进到参数校验）；这次失败是请求本身的问题，不是窗口关闭。',
    }
  }
  return {
    ret,
    reason: 'send_failed',
    window: WINDOW_UNKNOWN,
    hint: '无法判断会话窗口状态：上游返回了未预期的错误。',
  }
}

/** Human-readable age from milliseconds. */
export function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '未知'
  const hours = ms / 3_600_000
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))} 分钟`
  if (hours < 48) return `${hours.toFixed(1)} 小时`
  return `${(hours / 24).toFixed(1)} 天`
}

/**
 * Build the `GET /window` report from raw persisted state. Pure.
 *
 * @param {object} input
 * @param {string} [input.window]      last observed window state (open|closed|unknown)
 * @param {string} [input.observedAt]  ISO time of that observation
 * @param {string} [input.source]      how it was observed (probe|send|unknown)
 * @param {object} [input.lastInbound] last-inbound record ({ at, ts, from, preview, count })
 * @param {object} [input.lastSend]    last outbound send result
 * @param {number} [input.now]         epoch ms for the report
 * @param {string} [input.phase]       gateway login phase
 */
export function buildWindowReport(input = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  const inbound = input.lastInbound && typeof input.lastInbound === 'object' ? input.lastInbound : null
  const ts = Number(inbound?.ts)
  const parsedAt = inbound?.at ? Date.parse(inbound.at) : NaN
  const lastInboundMs = Number.isFinite(ts) ? ts : parsedAt
  const ageMs = Number.isFinite(lastInboundMs) ? Math.max(0, now - lastInboundMs) : null
  const window =
    input.window === WINDOW_OPEN || input.window === WINDOW_CLOSED
      ? input.window
      : WINDOW_UNKNOWN
  const observedAt = typeof input.observedAt === 'string' ? input.observedAt : null
  const observedMs = observedAt ? Date.parse(observedAt) : NaN
  const hint =
    window === WINDOW_CLOSED
      ? '窗口已关闭：主动推送会被腾讯以 ret=-2 拒绝。让用户回一句话即可恢复。'
      : window === WINDOW_OPEN
        ? '窗口开着：可以主动推送。'
        : '尚无窗口观测：窗口状态只来自最近一次**真实发送**（/send）的结果，等下一次发送后即可判定；POST /probe 只能验证上游可达、不作数。'
  return {
    ok: true,
    phase: typeof input.phase === 'string' ? input.phase : WINDOW_UNKNOWN,
    window,
    source: typeof input.source === 'string' ? input.source : 'unknown',
    observedAt,
    observedAgeMs: Number.isFinite(observedMs) ? Math.max(0, now - observedMs) : null,
    lastInbound: inbound,
    lastInboundAt: inbound?.at ?? null,
    ageMs,
    age: ageMs === null ? '未知' : formatAge(ageMs),
    lastSend: input.lastSend ?? null,
    hint,
  }
}
