/**
 * Unit tests for window.mjs (node --test). Run: `npm test`.
 *
 * These lock the two facts the whole keepalive feature rests on:
 *   ret=-2 → window closed; ret=-3 → window open; anything else → unknown.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  WINDOW_OPEN,
  WINDOW_CLOSED,
  WINDOW_UNKNOWN,
  extractRet,
  classifySendError,
  formatAge,
  buildWindowReport,
} from './window.mjs'

test('extractRet reads the code from an Error message', () => {
  assert.equal(extractRet(new Error('sendMessage ret=-2 prepare failed')), -2)
  assert.equal(extractRet(new Error('sendMessage ret=-3 invalid arguments')), -3)
})

test('extractRet prefers the numeric .ret field', () => {
  const error = new Error('sendMessage ret=-2 prepare failed')
  error.ret = -2
  assert.equal(extractRet(error), -2)
  assert.equal(extractRet({ ret: -3 }), -3)
  assert.equal(extractRet('no code here'), null)
})

test('classifySendError: ret=-2 is a closed window', () => {
  const result = classifySendError(new Error('sendMessage ret=-2 prepare failed'))
  assert.equal(result.window, WINDOW_CLOSED)
  assert.equal(result.reason, 'window_closed')
  assert.equal(result.ret, -2)
  assert.match(result.hint, /窗口已关闭/)
})

test('classifySendError: ret=-3 means the window is open', () => {
  const result = classifySendError(new Error('sendMessage ret=-3 invalid arguments'))
  assert.equal(result.window, WINDOW_OPEN)
  assert.equal(result.reason, 'window_open_invalid_arguments')
})

test('classifySendError: unknown errors stay unknown', () => {
  const result = classifySendError(new Error('socket hang up'))
  assert.equal(result.window, WINDOW_UNKNOWN)
  assert.equal(result.reason, 'send_failed')
})

test('formatAge is human readable', () => {
  assert.equal(formatAge(3 * 3_600_000), '3.0 小时')
  assert.equal(formatAge(22.7 * 3_600_000), '22.7 小时')
  assert.equal(formatAge(30 * 60_000), '30 分钟')
  assert.equal(formatAge(48 * 3_600_000), '2.0 天')
  assert.equal(formatAge(NaN), '未知')
})

test('buildWindowReport carries the inbound age and the hint', () => {
  const now = Date.parse('2026-09-19T12:00:00.000Z')
  const report = buildWindowReport({
    window: WINDOW_CLOSED,
    source: 'probe',
    observedAt: '2026-09-19T11:59:00.000Z',
    lastInbound: { at: '2026-09-19T11:00:00.000Z', ts: Date.parse('2026-09-19T11:00:00.000Z') },
    now,
    phase: 'logged_in',
  })
  assert.equal(report.window, WINDOW_CLOSED)
  assert.equal(report.lastInboundAt, '2026-09-19T11:00:00.000Z')
  assert.equal(report.ageMs, 3_600_000)
  assert.equal(report.age, '1.0 小时')
  assert.equal(report.observedAgeMs, 60_000)
  assert.match(report.hint, /回一句话/)
})

test('buildWindowReport defaults to unknown without observations', () => {
  const report = buildWindowReport({})
  assert.equal(report.window, WINDOW_UNKNOWN)
  assert.equal(report.age, '未知')
  assert.equal(report.lastInboundAt, null)
})
