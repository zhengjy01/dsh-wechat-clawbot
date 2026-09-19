/**
 * keepalive.mjs — pure conversation-window keepalive state machine.
 *
 * Tencent only accepts proactive pushes while the user's conversation window is
 * open. This pure function turns the gateway's `GET /window` report into the
 * next ledger plus an action for the host plugin (notify on close, recover,
 * time-based reminder, optional WeChat nudge).
 *
 * ⚠️ 2026-09-19 correction — the window signal is ONLY the outcome of a real
 * `/send`: `ret=-2 prepare failed` when the conversation context is unavailable
 * (window closed), success when it is open. A probe to a **bogus recipient**
 * returns `ret=-3 invalid arguments` no matter the window state (Tencent rejects
 * the recipient before it ever prepares a conversation), so it CANNOT judge the
 * window. `report.window` therefore carries the last real-send observation, and
 * the inbound clock (`lastInboundAt`) is the only other honest input.
 *
 * Kept free of I/O so the transitions and dedupe rules can be unit-tested.
 *
 * @typedef {'none'|'closed'|'recovered'} Transition
 */

export const WINDOW_OPEN = 'open'
export const WINDOW_CLOSED = 'closed'
export const WINDOW_UNKNOWN = 'unknown'

/**
 * @param {object} input
 * @param {object} [input.ledger]      previous keepalive ledger
 * @param {object|null} [input.report] `GET /window` body
 * @param {number} [input.now]         epoch ms
 * @param {number} [input.warnHours]   remind on the desktop when silence reaches this (0 = off)
 * @param {number} [input.nudgeHours]  additionally nudge on WeChat while open (0 = off)
 * @returns {{previous:string, windowState:string, transition:Transition,
 *            lastInboundMs:number, ledger:object}}
 */
export function evaluateWindowTick({ ledger = {}, report = null, now = Date.now(), warnHours = 0, nudgeHours = 0 } = {}) {
  const parsed = report?.lastInboundAt ? Date.parse(report.lastInboundAt) : NaN
  const lastInboundMs = Number.isFinite(parsed) ? parsed : 0
  const hasInbound = lastInboundMs > 0
  const previous = typeof ledger.windowState === 'string' ? ledger.windowState : WINDOW_UNKNOWN

  // Only the gateway's persisted real-send observation may set the state.
  const observed = report?.window
  const windowState =
    observed === WINDOW_OPEN || observed === WINDOW_CLOSED ? observed : previous

  const nowIso = new Date(now).toISOString()
  const next = {
    ...ledger,
    windowState,
    lastCheckAt: nowIso,
    ...(hasInbound ? { lastInboundMs } : {}),
  }
  // Never leak a previous tick's action into this one.
  delete next.dueWarnHours
  delete next.dueNudgeHours

  let transition = 'none'
  if (windowState === WINDOW_CLOSED) {
    next.closedSince = ledger.closedSince || nowIso
    if (previous !== WINDOW_CLOSED) {
      transition = 'closed'
      next.closedAlertAt = nowIso
    }
  } else {
    next.closedSince = null
    if (windowState === WINDOW_OPEN && previous === WINDOW_CLOSED) transition = 'recovered'
  }

  // Time-based reminder (reliable channel = desktop): the window can close
  // sooner than we can observe it, so once silence reaches the threshold remind
  // the user to reply — at most once per inbound message.
  if (hasInbound && warnHours > 0 && transition !== 'closed') {
    const silentHours = (now - lastInboundMs) / 3_600_000
    const alreadyWarned = (Number(ledger.lastWarnedInboundMs) || 0) >= lastInboundMs
    if (silentHours >= warnHours && !alreadyWarned) next.dueWarnHours = silentHours
  }

  // Optional old behaviour: nudge on WeChat while the window is still open.
  if (windowState === WINDOW_OPEN && nudgeHours > 0 && hasInbound) {
    const silentHours = (now - lastInboundMs) / 3_600_000
    const alreadyNudged = (Number(ledger.lastNudgeMs) || 0) > lastInboundMs
    if (silentHours >= nudgeHours && !alreadyNudged) next.dueNudgeHours = silentHours
  }

  return { previous, windowState, transition, lastInboundMs, ledger: next }
}
