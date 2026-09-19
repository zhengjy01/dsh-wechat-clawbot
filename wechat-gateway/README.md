# wechat-gateway

独立微信（Weixin）机器人网关：腾讯官方 iLink bot 协议（扫码登录、长轮询收消息、发消息），零 OpenClaw 依赖。协议核心源自 `@tencent-weixin/openclaw-weixin`（MIT，腾讯）。

被 `dsh-wechat-bot` 宿主插件 spawn 管理；也可独立运行调试。

## 运行

```sh
npm install          # 依赖：qrcode
node gateway.mjs     # 默认 http://127.0.0.1:51235
```

环境变量：`PORT`（默认 51235）、`STATE_DIR`（默认 `~/.dsh-wechat`）、`LOG_LEVEL`（debug/info）、`UNAPPROVED_REPLY`。

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/status` | 状态（phase/message/accountId/qrcodeDataUrl/allowlist/window/lastInboundAt） |
| GET | `/window` | **会话窗口健康**：`window`(open/closed/unknown)、`lastInboundAt`、`age`、最近一次发送/探测结果与 `hint` |
| POST | `/probe` | **无损窗口探针**：发往不存在的收件人，腾讯走到参数校验即返回（`ret=-3` 窗口开 / `ret=-2` 窗口关），**不会给用户发消息** |
| POST | `/login` | 获取/刷新登录二维码（已登录时拒绝，需先 `/logout`） |
| POST | `/verifycode` | `{code}` 提交手机验证码 |
| POST | `/logout` | 登出并停止轮询 |
| GET | `/events` | SSE：`login/state`、`message`、`approval`、`send/result`、`window/state` |
| POST | `/send` | `{to, text, contextToken?}` 发文本消息；失败时返回 `reason`/`ret`/`window`/`hint` |
| GET | `/allowlist` / POST | 白名单查询 / `{wxid, allow}` 批准 |

## 会话窗口健康（2026-09-19）

腾讯 iLink 只在用户「会话窗口」打开时接受主动推送，而本地 `phase` 反映不出这一点（`logged_in` 也可能发不出去）。网关因此：

- 对**每条入站消息**落盘 `$STATE_DIR/last-inbound.json`（不能用 `context-tokens.json` 的 `updatedAt`——token 未变化时它跳过写入，时间会冻住）；
- 把最近一次发送/探测的观测落盘 `$STATE_DIR/window-state.json`，并由 `/status`、`/window` 暴露；
- `/send` 失败时按 `ret` 分类：`ret=-2` → `reason=window_closed`（窗口已关）、`ret=-3` → `window_open_invalid_arguments`（窗口开着，是请求本身的问题），并附人类可读 `hint`；
- `POST /probe` 用「发往不存在收件人」的方式无损探测窗口状态。

实测边界（2026-09-19）：距上次入站 3h / 5h 仍可发、22.7h 已关闭（5h–22.7h 之间未标定）。

## 登录与持久化

- phase 状态机：`idle → waiting_qrcode → scanned → need_verifycode → logged_in`；`expired/error/logged_out` 为失败态。
- **重启自动恢复**：凭证存 `$STATE_DIR/accounts/`，启动时直接用保存的 bot token 恢复登录并开始轮询（无需重扫）；token 失效（errcode -14）转 `logged_out` 提示重扫。
- 只监听 `127.0.0.1`；只处理文本消息；`context_token` 随消息透传以保持微信侧会话连续。
