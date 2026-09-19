# dsh-wechat-clawbot — WeChat floating-ball bridge for DeepSeek Harness

[中文文档](README.zh.md) | **English**

> **This repository (independently maintained):** [`zhengjy01/dsh-wechat-clawbot`](https://github.com/zhengjy01/dsh-wechat-clawbot) — a standalone repository, *not* a GitHub fork.
> **Upstream:** [`lubaiUwU/DSH-WeChatClawBot`](https://github.com/lubaiUwU/DSH-WeChatClawBot), MIT License, Copyright (c) 2026 lubai. Upstream's last commit was 2026-08-17 and its maintainer has been inactive since 2026-08-18; this repository carries the maintenance forward, including two local fixes.
> **Changes vs. upstream:** see [Changes in this repository](#changes-in-this-repository).

**Install (the only thing a user needs to say):** tell DSH `install the plugin https://github.com/zhengjy01/dsh-wechat-clawbot`.
Works on Windows / macOS / Linux, with DSH Desktop and the `dsh` CLI alike. The installing agent handles the profile, dependencies and floating-ball registration (see [For the installing agent](#for-the-installing-agent)).

Once installed, a **green WeChat floating ball** appears in the DSH GUI's bottom-right corner: click it, scan the QR code with your phone, and messages sent to that WeChat account flow into a **dedicated WeChat conversation area** (they never mix with your GUI session). Replies are sent back to WeChat automatically.

No OpenClaw and no external service is required. WeChat access uses Tencent's official channel protocol (iLink, the same lineage as `@tencent-weixin/openclaw-weixin`, MIT); the protocol core is extracted into a standalone gateway service.

```
WeChat (phone)
   │ QR login (the floating-ball panel shows the code)
   ▼
wechat-gateway        ← standalone Node service (iLink: receive/send, port 51235)
   │  SSE "message" events
   ▼
dsh-wechat-bot        ← DSH host plugin (spawns/supervises the gateway, injects sessions, sends replies)
   │  createBridge (session driver, shared with dsh-wechat-bridge)
   ▼
DSH agent (dedicated WeChat conversation area; context is kept long-term)
   ▲
   └── replies go back through the gateway → WeChat
```

## ✨ Features

- **Scan and go** — bind by scanning the floating-ball QR code with your phone. Credentials stay on the machine and **DSH reuses them after a restart** (only a revoked token needs a re-scan).
- **Dedicated conversation area** — WeChat messages never enter your GUI session; the conversation keeps continuous context and **history is restored after a restart** (persisted sessions + conversation mapping).
- **Explicit new-conversation command** — send `/new` in WeChat (or `/新对话` / `/新会话`), or press "New conversation" in the panel. Otherwise the same conversation is always reused.
- **ClawBot-specific model** — pick a model and thinking effort (off/high/max) in the panel; it persists across restarts and applies **only to WeChat turns**.
- **Contact allowlist** — allow everyone by default; approve or ignore new contacts from the panel.
- **Conversation-window health & keepalive** — Tencent only accepts proactive pushes while the user's conversation window is open (the local login `phase` does **not** reflect this). The gateway stamps every inbound message into `last-inbound.json`, exposes `GET /window` + `POST /probe` (a lossless probe that never messages the user), and rejects sends with a machine-readable `reason` (`window_closed` / `window_open_invalid_arguments`) plus a human hint. The host plugin runs a built-in keepalive loop: when the window silently closes it raises one desktop notification ("reply to renew") and stops probing until the user talks again. **No local script or launchd job is needed.**

## 🖥️ Requirements

| Dependency | Requirement | Notes |
|---|---|---|
| OS | **Windows / macOS / Linux** | `dsh plugin add` is recommended; Windows can also use `.\install-wechat.ps1` |
| DeepSeek Harness | DSH Desktop installed, or a working `dsh` command | The installing agent detects the profile |
| Node.js | **>= 22.19** (22.x or 24.x LTS recommended) | Matches the DSH engine requirement |
| npm / pnpm | Any recent version | `dsh plugin add` uses the profile's own pnpm; the only runtime dependency is `qrcode` |
| WeChat account | A phone WeChat that can scan QR codes | **A secondary account is recommended** — automating a personal WeChat account carries a ban/risk-control risk; judge for yourself |
| Model key | Optional | Configure it on DSH's Models page; the quick-pick list detects key availability |
| Ports | 51234 / 51235 / 51236 | All bound to loopback `127.0.0.1`; conflicts are rare |

### Ports and state directory

| Item | Value | Purpose |
|---|---|---|
| `127.0.0.1:51234` | dsh-wechat-bridge HTTP bridge | Debugging / OpenClaw forwarding |
| `127.0.0.1:51235` | wechat-gateway | WeChat protocol send/receive, QR login, SSE events |
| `127.0.0.1:51236` | dsh-wechat-bot model endpoint | The floating ball reads/writes the "ClawBot model" configuration |
| `~/.dsh-wechat/` | State directory | Credentials, allowlist, model config (`clawbot-model.json`), session mapping (`bridge-sessions.json`), conversation index (`wechat-session.json`), proactive-push context (`context-tokens.json`), inbound clock (`last-inbound.json`), window health (`window-state.json`) and the keepalive ledger (`window-keepalive.json`) |

`$DSH_HOME` defaults to **`~/.dsh`** (Windows: `C:\Users\<you>\.dsh`); on macOS the desktop `.app` may use `~/Library/Application Support/DeepSeekHarness`. Override it with the `DSH_HOME` environment variable. A DSH Desktop profile is usually named `desktop` and the CLI Web profile `web` — the installing agent picks automatically.

## 📦 Repository layout

```
dsh-wechat-clawbot/
├── package.json          # single bundle manifest (dsh.bundle → cordis.patch.yml; dsh.client → floating ball)
├── index.js              # host entry: re-exports ./dsh-wechat-bot (one installable unit)
├── cordis.patch.yml      # injects the wechat-bot row (host; the client half self-registers via dsh.client)
├── wechat-gateway/       # WeChat gateway (gateway.mjs, window.mjs; Node built-in fetch, depends on qrcode)
├── dsh-wechat-bot/       # host plugin (supervises the gateway, session injection, model endpoint, /probe, keepalive.mjs)
├── dsh-client-wechat-ui/ # browser floating-ball bundle (client.js, zero dependencies)
├── dsh-wechat-bridge/    # session-driver core (createBridge + optional HTTP bridge + unit tests)
├── install-wechat.sh     # local-checkout install (symlinks the repo, macOS/Linux/Git Bash)
├── install-wechat.ps1    # local-checkout install (junction, native Windows)
├── scripts/              # peer shims (symlink dev mode) + portability verification
├── PORTABILITY-SOP.md    # portability-verification SOP (pre-release gate)
└── README.md / README.zh.md
```

## 🚀 Install

The user only needs to tell DSH one sentence:

```
install the plugin https://github.com/zhengjy01/dsh-wechat-clawbot
```

Everything below is for the **installing AI / agent**. Read it and finish the job yourself; do not ask the user to choose a profile.

### For the installing agent

1. **Pick the profile automatically — do not default to `web`.**
   `$DSH_HOME` is normally `~/.dsh` (Windows: `%USERPROFILE%\.dsh`). Choose the first existing directory name in this order:
   - `$DSH_HOME/profiles/desktop` exists → use **`desktop`** (DSH Desktop / the official Windows desktop build is almost always this)
   - otherwise `$DSH_HOME/profiles/web` exists → use **`web`**
   - otherwise use whichever directory actually exists under `$DSH_HOME/profiles/`

   Call it `<profile>`.

2. **Install the bundle:**

   ```sh
   dsh plugin --profile <profile> add github:zhengjy01/dsh-wechat-clawbot
   ```

   This package has **no** `prepare` / `postinstall` build scripts (host + client ship together and `qrcode` is a plain dependency), so pnpm >= 10's `allowBuilds` will not block it. A successful install enters the profile's `dsh.profile.bundles`.

3. **Tell the user to restart DSH / DSH Desktop.** The green WeChat floating ball appears bottom-right after the restart, then scan to log in. Do not assume it works without a restart.

4. Do **not** only edit `cordis.patch.yml` without installing the package; do **not** assume the profile is `web`; do **not** drop `ELECTRON_RUN_AS_NODE` when spawning the gateway (on Windows Desktop `process.execPath` is an `.exe`, not node).

### Local-checkout install (development)

```sh
git clone https://github.com/zhengjy01/dsh-wechat-clawbot
cd dsh-wechat-clawbot
bash install-wechat.sh      # macOS / Linux / Git Bash
.\install-wechat.ps1        # Windows PowerShell
```

Then restart DSH and scan the floating ball.

## 📱 Usage

- **Receiving** — messages go into a **dedicated WeChat conversation area** (visible in the GUI sidebar, never mixed into your GUI chat); context is continuous and **history is restored after a restart**.
- **Switching conversations** — send `/new`, `/新对话` or `/新会话` in WeChat, or press "New conversation" in the floating-ball panel (the previous conversation is kept). Otherwise the current one is reused.
- **ClawBot model** — the panel's quick-pick lists models with configured keys; "custom" lets you type a provider/model, and you can choose a thinking effort (off/high/max). It applies **only to WeChat turns** and survives restarts; pick "follow DSH default" and save to clear it.
- **New contacts** — an empty allowlist allows everyone; strangers get an automatic notice and appear in the panel for approve/ignore.

## ⚙️ Configuration

`$DSH_HOME/profiles/<desktop|web>/cordis.patch.yml` (`dsh plugin add` writes this section; the full form):

```yaml
- insert:
    - id: wechat-bot
      name: dsh-wechat-clawbot
      config:
        gatewayPort: 51235        # WeChat gateway port (default 51235)
        modelPort: 51236          # model-config endpoint port (default 51236)
        timeoutMs: 300000         # per-turn timeout
        maxMessageChars: 20000
        approval: reject          # in-turn approvals: auto-reject with a note (re-runnable in the GUI)
        keepalive: true           # built-in conversation-window keepalive (default true)
        keepaliveIntervalMinutes: 30   # how often to check the window
        keepaliveNudgeHours: 0    # optional: nudge on WeChat while open & silent ≥ N hours (0 = off)
        keepaliveNotify: true     # desktop notification when the window closes (macOS)
```

Gateway environment variables (`wechat-gateway/gateway.mjs`): `PORT` (default 51235), `STATE_DIR` (default `~/.dsh-wechat`), `UNAPPROVED_REPLY`, `LOG_LEVEL` (debug/info).

The host plugin's ports and state directory can also be overridden by environment variables (defaults unchanged): `DSH_WECHAT_GATEWAY_PORT`, `DSH_WECHAT_MODEL_PORT`, `DSH_WECHAT_STATE_DIR`. The portability verification relies on these three to avoid ports already taken by the live instance.

## 🧪 Development and testing

- Syntax: `node --check <file>`. Gateway and plugins are plain JS ESM with **zero build**.
- Unit tests: `npm test` (window classification + keepalive state machine, `node --test`; no network).
- Session-settlement unit tests: `node dsh-wechat-bridge/settle.test.mjs` (turn/end settlement, timeout, errors, discard fallback, model override — 7 cases).
- The gateway can run standalone for debugging: `cd wechat-gateway && npm install && node gateway.mjs`.
- After changing the host plugin or the gateway you must **restart DSH**; `client.js` (floating ball) also needs a restart (boot-graph cache).

### Portability verification (pre-release gate)

Every release must be verified as if on **someone else's computer**: install a tarball into an empty profile inside an **isolated `DSH_HOME`** (never `link:`), then start it and check that declared entries are inside the package, the host health route answers, the client bundle registers, and the instance stays up afterwards. The health route is `GET /api/dsh-wechat-bot/probe`.

```sh
npm run verify:quick   # fast: skip the static audit, 5s stability watch
npm run verify         # standard: static audit + the full eight steps
npm run verify:full    # pre-release: standard + 30s stability watch
```

When running on the machine that already runs a live instance, move the ports out of the way first (optional):

```sh
DSH_WECHAT_GATEWAY_PORT=51335 DSH_WECHAT_MODEL_PORT=51336 \
DSH_WECHAT_STATE_DIR="$(mktemp -d)" npm run verify:full
```

Only `✅ 通过` permits a release. Criteria live in `PORTABILITY-SOP.md`.

## 🛠️ Troubleshooting

| Symptom | What to do |
|---|---|
| No floating ball | Make sure the package is installed into the profile that is actually running (`desktop` for Desktop, `web` for the CLI) and that the app was restarted |
| **DSH Desktop crashes on double-click** | Usually a missing `@deepseek-ai/schemastery`. Reinstall through the official path: `dsh plugin --profile desktop add github:zhengjy01/dsh-wechat-clawbot` (only the symlinked local-checkout dev mode needs `node scripts/link-peer-shims.mjs`) |
| Panel says "cannot reach gateway" | The gateway is not up. DSH Desktop (Electron) must spawn it with `ELECTRON_RUN_AS_NODE=1` (built in since 0.1.1). Check whether 51235 is LISTENING and look for `wechat-gateway:` log lines |
| Re-scan required after restart | Normally the session resumes; "login expired" means WeChat revoked the token, so scan again |
| WeChat messages get no reply | Confirm the panel shows "connected"; new contacts must be approved first; look for `dsh-wechat-bot:` log lines |
| Replies / proactive pushes fail | First check the window, not the login: `curl http://127.0.0.1:51235/window` (or `POST /probe`). `ret=-2 prepare failed` / `reason=window_closed` means Tencent's conversation window is closed — the inbound `context_token` alone cannot reopen it. Ask the user to send the bot one message; the keepalive loop will also raise a desktop notification on the open → closed transition. A stale login is the other cause: unbind in the panel and scan again, or delete `~/.dsh-wechat/accounts/` |
| `window_closed` but the user says they just wrote | The clock comes from real inbound messages (`last-inbound.json`); check that the phone actually delivered a message and that the gateway log shows the inbound. `POST /probe` returns `ret=-3` when the window is genuinely open |
| Model config has no effect | Make sure the panel saved it; the config applies only to **WeChat-initiated turns** (manual GUI turns are unaffected) |
| Reset everything | Delete `~/.dsh-wechat/` (credentials, model, session mapping) |

## Compatibility

Requires **DeepSeek Harness >= 0.1.5-rc.1** (declared as `dsh.engines.dsh`) and is verified against **0.1.5-rc.1** — including the isolated-`DSH_HOME` tarball install, the `/api/dsh-wechat-bot/probe` health route, and the client bundle registering in `__DSH_BOOT__.entries`. Node.js >= 22.19 is required by the DSH engine.

## 📄 License

MIT. The upstream [`lubaiUwU/DSH-WeChatClawBot`](https://github.com/lubaiUwU/DSH-WeChatClawBot) `LICENSE` (Copyright (c) 2026 lubai) is **kept verbatim** in this repository, and this repository's modifications are released under the same MIT terms without altering the original copyright notice. The protocol core (iLink client) derives from [`@tencent-weixin/openclaw-weixin`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin) (Tencent's official channel plugin, MIT).

> ⚠️ Disclaimer: this project is for learning and personal automation research. Automating a personal WeChat account carries **risk-control / ban risk** — use a secondary account and accept the consequences. This project is not affiliated with Tencent or DeepSeek.

## Changes in this repository

This repository (`zhengjy01/dsh-wechat-clawbot`) is an independently maintained line of upstream `lubaiUwU/DSH-WeChatClawBot`, not a GitHub fork. Changes relative to upstream (last commit 2026-08-17, `b817fc9`):

| Commit | Type | Content |
|---|---|---|
| `0.2.1` | **Fix** | **Conversation-window health moved into the plugin** (the real cause behind "the bot stopped notifying"): the gateway now stamps `last-inbound.json` on every inbound message, exposes `GET /window` + `POST /probe` (a lossless probe to a nonexistent recipient) and returns a machine-readable `reason`/`hint` on send failure; the host plugin runs a built-in keepalive loop that notifies once when the window closes and stops probing until the user talks again. The liveness probe now reports `version`. No local script/launchd job is required on a fresh machine. |
| `6668793` | **Fix** | **Login-loop state override**: each `startLogin` round increments `state.loginGen`, so a superseded round can only `bailIfSuperseded` and exit silently — it can no longer `setPhase`/refresh the QR code (it used to flip `logged_in` back to `waiting_qrcode`). `/send` now only checks that a token is held instead of hard-gating on `phase`, so replies generated while the QR code refreshes are not dropped. `modelServer` gained an `error` listener so a port conflict no longer kills the DSH host. |
| `273601d` | **Fix** | **`context_token` reuse for proactive pushes**: iLink's `sendmessage` needs an "open" conversation context. Inbound messages carry a `context_token`, but the original gateway only forwarded it on the auto-reply path, so every fire-and-forget push (daily reports, notifications, the task dispatcher) began failing with `502 ret=-2 prepare failed` once the last interaction went stale. The fix persists each sender's latest `context_token` (`<stateDir>/context-tokens.json`, mode 0600, at most 50 senders) and `/send` reuses it automatically when the caller does not supply one; callers can still override via `contextToken`. |
| This release | **Added / adjusted** | ① Shipped as a **single npm package** (`index.js` re-exports the host; `dsh.client` declares the floating ball) and dropped upstream's `file:` subpackage dependencies and `prepare`/`postinstall` — under pnpm 10 that structure makes `dsh plugin add` **fail outright** (unresolvable `file:` subpackage, or blocked build scripts). ② `GET /api/dsh-wechat-bot/probe` host liveness route. ③ `DSH_WECHAT_GATEWAY_PORT` / `DSH_WECHAT_MODEL_PORT` / `DSH_WECHAT_STATE_DIR` overrides (defaults unchanged) for the isolated portability verification. ④ Added `scripts/portability.mjs` + `PORTABILITY-SOP.md` + three `verify` npm scripts. ⑤ The host now imports `dsh-wechat-bridge` relatively, so the install path no longer depends on peer shims. |

Unchanged upstream behaviour: QR login, the floating-ball panel, the allowlist, ClawBot model configuration and `/new` conversation switching all stay the same. Upstream PR #1 (corresponding to `6668793`, no response since 2026-09-11) is left open for upstream to merge.
