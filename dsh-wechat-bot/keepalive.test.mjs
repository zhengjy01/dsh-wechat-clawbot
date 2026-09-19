/**
 * Unit tests for keepalive.mjs (node --test). Run: `npm test`.
 *
 * These lock the corrected contract (2026-09-19): the window state comes ONLY
 * from the gateway's real-send observation (`report.window`), never from a probe
 * to a bogus recipient.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateWindowTick } from './keepalive.mjs'

const NOW = Date.parse('2026-09-19T12:00:00.000Z')
const report = (window, at) => ({ window, lastInboundAt: at })

test('uses the real-send observation, not a probe', () => {
  const t = evaluateWindowTick({
    ledger: { windowState: 'open' },
    report: report('closed', '2026-09-19T11:00:00.000Z'),
    now: NOW,
  })
  assert.equal(t.windowState, 'closed')
  assert.equal(t.transition, 'closed')
})

test('unknown report keeps the previous state', () => {
  const t = evaluateWindowTick({
    ledger: { windowState: 'closed', closedSince: '2026-09-19T09:00:00.000Z' },
    report: report('unknown', '2026-09-19T11:00:00.000Z'),
    now: NOW,
  })
  assert.equal(t.windowState, 'closed')
  assert.equal(t.transition, 'none')
  assert.equal(t.ledger.closedSince, '2026-09-19T09:00:00.000Z')
})

test('open → closed fires exactly once', () => {
  const t1 = evaluateWindowTick({ ledger: { windowState: 'open' }, report: report('closed', '2026-09-19T11:00:00.000Z'), now: NOW })
  assert.equal(t1.transition, 'closed')
  assert.equal(t1.ledger.closedAlertAt, new Date(NOW).toISOString())
  const t2 = evaluateWindowTick({ ledger: t1.ledger, report: report('closed', '2026-09-19T11:00:00.000Z'), now: NOW + 60_000 })
  assert.equal(t2.transition, 'none', 'already-closed must not re-notify')
  assert.equal(t2.ledger.closedAlertAt, t1.ledger.closedAlertAt)
})

test('closed → open recovers and clears closedSince', () => {
  const t = evaluateWindowTick({
    ledger: { windowState: 'closed', closedSince: '2026-09-19T09:00:00.000Z' },
    report: report('open', '2026-09-19T11:00:00.000Z'),
    now: NOW,
  })
  assert.equal(t.transition, 'recovered')
  assert.equal(t.ledger.closedSince, null)
})

test('time-based reminder fires once per inbound, never at 0 hours', () => {
  const inbound = '2026-09-19T04:00:00.000Z' // 8h silent
  const first = evaluateWindowTick({
    ledger: { windowState: 'open' },
    report: report('open', inbound),
    now: NOW,
    warnHours: 2,
  })
  assert.equal(first.ledger.dueWarnHours, 8)

  const second = evaluateWindowTick({
    ledger: { ...first.ledger, lastWarnedInboundMs: Date.parse(inbound) },
    report: report('open', inbound),
    now: NOW + 60_000,
    warnHours: 2,
  })
  assert.equal(second.ledger.dueWarnHours, undefined, 'no repeat for the same inbound')

  const fresh = evaluateWindowTick({
    ledger: { windowState: 'open' },
    report: report('open', '2026-09-19T11:00:00.000Z'), // 1h silent
    now: NOW,
    warnHours: 2,
  })
  assert.equal(fresh.ledger.dueWarnHours, undefined)

  const off = evaluateWindowTick({
    ledger: { windowState: 'open' },
    report: report('open', inbound),
    now: NOW,
    warnHours: 0,
  })
  assert.equal(off.ledger.dueWarnHours, undefined, '0 = never warn')
})

test('nudges only when open, silent past the threshold, once per inbound', () => {
  const inbound = '2026-09-19T04:00:00.000Z'
  const t = evaluateWindowTick({
    ledger: { windowState: 'open' },
    report: report('open', inbound),
    now: NOW,
    nudgeHours: 5,
  })
  assert.equal(t.ledger.dueNudgeHours, 8)

  const already = evaluateWindowTick({
    ledger: { windowState: 'open', lastNudgeMs: NOW - 1000 },
    report: report('open', inbound),
    now: NOW,
    nudgeHours: 5,
  })
  assert.equal(already.ledger.dueNudgeHours, undefined)

  const closed = evaluateWindowTick({
    ledger: { windowState: 'open' },
    report: report('closed', inbound),
    now: NOW,
    nudgeHours: 5,
  })
  assert.equal(closed.ledger.dueNudgeHours, undefined, 'never nudge on a closed window')
})

test('a just-detected closure suppresses the time-based reminder for that tick', () => {
  const t = evaluateWindowTick({
    ledger: { windowState: 'open' },
    report: report('closed', '2026-09-19T04:00:00.000Z'),
    now: NOW,
    warnHours: 2,
  })
  assert.equal(t.transition, 'closed')
  assert.equal(t.ledger.dueWarnHours, undefined)
})
