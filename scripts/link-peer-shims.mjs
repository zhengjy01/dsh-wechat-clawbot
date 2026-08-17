#!/usr/bin/env node
/**
 * Link @deepseek-ai peer packages into plugin folders.
 *
 * DSH loads plugins by realpath, so nested packages (especially
 * dsh-wechat-bridge) cannot walk up to $DSH_HOME/profiles/node_modules.
 * This script is used by prepare (dsh plugin add) and the install scripts.
 */
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PEERS = ['cordis', 'schemastery', 'dsh-agent', 'dsh-llm', 'dsh-session', 'dsh-settings']
const TARGETS = ['dsh-wechat-bot', 'dsh-wechat-bridge']

function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME?.trim()
  if (fromEnv) return fromEnv
  const candidates = [
    join(homedir(), '.dsh'),
    process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'DeepSeekHarness') : '',
    process.env.APPDATA ? join(process.env.APPDATA, 'DeepSeekHarness') : '',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'DeepSeekHarness') : '',
  ].filter(Boolean)
  for (const dir of candidates) {
    if (existsSync(join(dir, 'profiles', 'node_modules', '@deepseek-ai'))) return dir
    if (existsSync(join(dir, 'profiles', 'desktop')) || existsSync(join(dir, 'profiles', 'web'))) return dir
  }
  return join(homedir(), '.dsh')
}

function removeLink(link) {
  if (!existsSync(link)) {
    try { lstatSync(link) } catch { return }
  }
  if (process.platform === 'win32') {
    spawnSync('cmd.exe', ['/c', 'rmdir', link], { stdio: 'ignore', windowsHide: true })
    if (!existsSync(link)) return
  }
  rmSync(link, { recursive: true, force: true })
}

function linkDir(target, link) {
  mkdirSync(dirname(link), { recursive: true })
  removeLink(link)
  const type = process.platform === 'win32' ? 'junction' : 'dir'
  try {
    symlinkSync(target, link, type)
  } catch (error) {
    if (process.platform === 'win32') {
      const result = spawnSync('cmd.exe', ['/c', 'mklink', '/J', link, target], {
        stdio: 'ignore',
        windowsHide: true,
      })
      if (result.status === 0) return
    }
    throw error
  }
}

export function linkPeerShims(dshHome = resolveDshHome()) {
  const fallback = join(dshHome, 'profiles', 'node_modules', '@deepseek-ai')
  if (!existsSync(fallback)) {
    console.warn(`dsh-wechat-clawbot: skip peer shims — ${fallback} not found (run DSH once, or set DSH_HOME)`)
    return false
  }
  let linked = 0
  for (const pkgDir of TARGETS) {
    const destRoot = join(ROOT, pkgDir, 'node_modules', '@deepseek-ai')
    mkdirSync(destRoot, { recursive: true })
    for (const name of PEERS) {
      const src = join(fallback, name)
      if (!existsSync(src)) continue
      linkDir(src, join(destRoot, name))
      linked += 1
    }
  }
  const botShim = join(ROOT, 'dsh-wechat-bot', 'node_modules', 'dsh-wechat-bridge')
  linkDir(join(ROOT, 'dsh-wechat-bridge'), botShim)
  console.log(`dsh-wechat-clawbot: linked ${linked} peer shims from ${fallback}`)
  return true
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) linkPeerShims()
