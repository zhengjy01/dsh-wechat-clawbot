/**
 * Unit tests for keepalive.mjs (node --test). Run: `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateWindowTick } from './keepalive.mjs'

const NOW = Date.parse('2026-09-19T12:00:00.000Z')
const report = (at) => ({ window: 'open', lastInboundAt: at })

test('probes while unknown/open and skips probing once closed', () => {
  const first = evaluateWindowTick({ now: NOW })
  assert.equal(first.needProbe, true)
  assert.equal(first.windowState, 'unknown')

  const closed = evaluateWindowTick({ ledger: { windowState: 'closed' }, now: NOW })
  assert.equal(closed.needProbe, false, 'must not hammer the API while closed')

  const changed = evaluateWindowTick({
    ledger: { windowState: 'closed', lastProbeInboundMs: Date.parse('2026-09-19T10:00:00.000Z') },
    report: report('2026-09-19T11:00:00.000Z'),
    now: NOW,
  })
  assert.equal(changed.needProbe, true, 'a new inbound must trigger one confirmation probe')
})

test('open → closed transition fires exactly once', () => {
  const probe = { window: 'closed', reason: 'window_closed' }
  const t1 = evaluateWindowTick({ ledger: { windowState: 'open' }, probe, now: NOW })
  assert.equal(t1.transition, 'closed')
  assert.equal(t1.ledger.closedAlertAt, new Date(NOW).toISOString())

  const t2 = evaluateWindowTick({ ledger: t1.ledger, probe, now: NOW + 60_000 })
  assert.equal(t2.transition, 'none', 'already-closed must not re-notify')
  assert.equal(t2.ledger.closedAlertAt, t1.ledger.closedAlertAt)
})

test('closed → open recovers and clears closedSince', () => {
  const t = evaluateWindowTick({
    ledger: { windowState: 'closed', closedSince: '2026-09-19T09:00:00.000Z' },
    probe: { window: 'open' },
    now: NOW,
  })
  assert.equal(t.transition, 'recovered')
  assert.equal(t.ledger.closedSince, null)
})

test('probe result wins over the stale /window state', () => {
  const t = evaluateWindowTick({
    ledger: { windowState: 'unknown' },
    report: { window: 'open', lastInboundAt: '2026-09-19T11:00:00.000Z' },
    probe: { window: 'closed' },
    now: NOW,
  })
  assert.equal(t.windowState, 'closed')
  assert.equal(t.transition, 'closed')
})

test('nudges only when open, silent past the threshold, once per inbound', () => {
  const ledger = { windowState: 'open' }
  const stale = evaluateWindowTick({
    ledger,
    report: report('2026-09-19T04:00:00.000Z'), // 8h silent
    probe: { window: 'open' },
    now: NOW,
    nudgeHours: 5,
  })
  assert.equal(stale.ledger.dueNudgeHours, 8)

  const already = evaluateWindowTick({
    ledger: { ...ledger, lastNudgeMs: NOW - 1000, lastProbeInboundMs: Date.parse('2026-09-19T04:00:00.000Z') },
    report: report('2026-09-19T04:00:00.000Z'),
    probe: { window: 'open' },
    now: NOW,
    nudgeHours: 5,
  })
  assert.equal(already.ledger.dueNudgeHours, undefined)

  const fresh = evaluateWindowTick({
    ledger,
    report: report('2026-09-19T11:00:00.000Z'), // 1h silent
    probe: { window: 'open' },
    now: NOW,
    nudgeHours: 5,
  })
  assert.equal(fresh.ledger.dueNudgeHours, undefined)
})
