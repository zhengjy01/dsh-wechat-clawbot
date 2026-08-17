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
| GET | `/status` | 状态（phase/message/accountId/qrcodeDataUrl/allowlist） |
| POST | `/login` | 获取/刷新登录二维码（已登录时拒绝，需先 `/logout`） |
| POST | `/verifycode` | `{code}` 提交手机验证码 |
| POST | `/logout` | 登出并停止轮询 |
| GET | `/events` | SSE：`login/state`、`message`、`approval`、`send/result` |
| POST | `/send` | `{to, text, contextToken?}` 发文本消息 |
| GET | `/allowlist` / POST | 白名单查询 / `{wxid, allow}` 批准 |

## 登录与持久化

- phase 状态机：`idle → waiting_qrcode → scanned → need_verifycode → logged_in`；`expired/error/logged_out` 为失败态。
- **重启自动恢复**：凭证存 `$STATE_DIR/accounts/`，启动时直接用保存的 bot token 恢复登录并开始轮询（无需重扫）；token 失效（errcode -14）转 `logged_out` 提示重扫。
- 只监听 `127.0.0.1`；只处理文本消息；`context_token` 随消息透传以保持微信侧会话连续。
