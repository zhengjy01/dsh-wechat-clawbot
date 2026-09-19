/**
 * keepalive.mjs — pure conversation-window keepalive state machine.
 *
 * Tencent only accepts proactive pushes while the user's conversation window is
 * open. The gateway persists the inbound clock and answers `GET /window` +
 * `POST /probe`; this pure function turns those observations into the next
 * ledger plus an action for the host plugin (notify on close, recover, nudge).
 *
 * Kept free of I/O so the open → closed → open transitions (and the "stop
 * probing once closed until the user talks again" rule) can be unit-tested.
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
 * @param {object|null} [input.probe]  `POST /probe` body (null = not probed)
 * @param {number} [input.now]         epoch ms
 * @param {number} [input.nudgeHours]  0 = never nudge
 * @returns {{previous:string, windowState:string, needProbe:boolean, transition:Transition,
 *            lastInboundMs:number, ledger:object}}
 */
export function evaluateWindowTick({ ledger = {}, report = null, probe = null, now = Date.now(), nudgeHours = 0 } = {}) {
  const parsed = report?.lastInboundAt ? Date.parse(report.lastInboundAt) : NaN
  const lastInboundMs = Number.isFinite(parsed) ? parsed : 0
  const hasInbound = lastInboundMs > 0
  const previous = typeof ledger.windowState === 'string' ? ledger.windowState : WINDOW_UNKNOWN
  const inboundChanged = hasInbound && lastInboundMs > (Number(ledger.lastProbeInboundMs) || 0)
  // Probe while the window is open/unknown, and once more after a new inbound
  // (the user may have reopened it); never hammer the API while known closed.
  const needProbe = previous !== WINDOW_CLOSED || inboundChanged
  const windowState =
    typeof probe?.window === 'string' ? probe.window : report?.window ?? previous
  const nowIso = new Date(now).toISOString()

  const next = {
    ...ledger,
    windowState,
    lastCheckAt: nowIso,
    ...(probe
      ? { lastProbeMs: now, lastProbeAt: nowIso, lastProbeReason: probe.reason ?? '' }
      : {}),
    ...(hasInbound ? { lastProbeInboundMs: lastInboundMs } : {}),
  }

  let transition = 'none'
  if (windowState === WINDOW_CLOSED) {
    next.closedSince = ledger.closedSince || nowIso
    if (previous !== WINDOW_CLOSED) {
      transition = 'closed'
      next.closedAlertAt = nowIso
    }
  } else {
    next.closedSince = null
    if (windowState === WINDOW_OPEN) {
      if (previous === WINDOW_CLOSED) transition = 'recovered'
      if (nudgeHours > 0 && hasInbound) {
        const silentHours = (now - lastInboundMs) / 3_600_000
        const alreadyNudged = (Number(ledger.lastNudgeMs) || 0) > lastInboundMs
        if (silentHours >= nudgeHours && !alreadyNudged) next.dueNudgeHours = silentHours
      }
    }
  }

  return { previous, windowState, needProbe, transition, lastInboundMs, ledger: next }
}
