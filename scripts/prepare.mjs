#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { linkPeerShims } from './link-peer-shims.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GATEWAY = join(ROOT, 'wechat-gateway')

if (!existsSync(join(GATEWAY, 'node_modules'))) {
  console.log('dsh-wechat-clawbot: installing wechat-gateway dependencies...')
  const result = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--prefix', GATEWAY], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

linkPeerShims()
