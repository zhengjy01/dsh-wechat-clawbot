/**
 * Unit tests for the host liveness probe payload (node --test). Run: `npm test`.
 *
 * Regression guard: 0.2.0's CHANGELOG documented `{ok, plugin, version,
 * gatewayPort, modelPort}` but the handler omitted `version` until 0.2.1.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { probePayload } from './index.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('probe payload reports the package version from package.json', () => {
  const payload = probePayload(51235, 51236)
  assert.equal(payload.ok, true)
  assert.equal(payload.plugin, 'dsh-wechat-bot')
  assert.equal(
    payload.version,
    pkg.version,
    'probe.version must be this package\'s package.json version (0.2.0 forgot it)',
  )
})

test('probe payload version is a non-empty semver string', () => {
  const { version } = probePayload(1, 2)
  assert.equal(typeof version, 'string')
  assert.notEqual(version.trim(), '', 'an empty version would silently defeat the check')
  assert.match(version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/)
})

test('probe payload carries the configured ports and no unexpected keys', () => {
  const payload = probePayload(51235, 51236)
  assert.equal(payload.gatewayPort, 51235)
  assert.equal(payload.modelPort, 51236)
  assert.deepEqual(
    Object.keys(payload).sort(),
    ['gatewayPort', 'modelPort', 'ok', 'plugin', 'version'],
  )
})
