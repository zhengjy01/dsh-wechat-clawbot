# dsh-wechat-bridge

DeepSeek Harness 宿主插件：在本机回环地址上开一个 HTTP 桥，让外部消息渠道（OpenClaw + 微信 ClawBot）把消息注入到正在运行的 DSH agent 会话，并把 agent 的回复取回。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/message` | 请求 `{"text": "...", "sessionKey": "可选"}`；阻塞等待本轮结束，返回 `{"reply", "sessionId", "stopReason", "partial"}` |
| `POST` | `/cancel` | 请求 `{"sessionId"?: "...", "sessionKey"?: "..."}`；取消该会话正在进行的回合 |
| `GET` | `/health` | `{"ok", "mode", "session", "pending"}`，安装验证用 |
| `GET` | `/sessions` | 列出已知会话（id、是否存活、创建时间） |

鉴权：配置 `authToken` 后，请求需带 `Authorization: Bearer <token>`。默认仅绑定 `127.0.0.1`。

## 会话目标（`sessionMode`）

| 模式 | 行为 |
|---|---|
| `active`（默认） | 消息进入**最近创建的存活会话**——也就是你在 GUI 里正看着的那个对话。微信消息会直接出现在 GUI 会话里，回复两边同步。没有存活会话时自动创建一个桥接专用会话 |
| `dedicated` | 所有人共享一个桥接专用会话 |
| `keyed` | 按请求里的 `sessionKey`（OpenClaw 侧即微信会话 key）一人一个会话 |
| `explicit` | 固定使用配置 `sessionId` 指定的会话 |

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | 绑定地址；`0.0.0.0` 会暴露到局域网，务必配 `authToken` 或走 SSH 隧道 |
| `port` | `51234` | 监听端口 |
| `authToken` | `''` | Bearer 令牌，空为不鉴权（仅回环时建议） |
| `sessionMode` | `active` | 见上表 |
| `sessionId` | `''` | `explicit` 模式的目标会话 |
| `cwd` | `process.cwd()` | 桥接创建会话的工作目录 |
| `timeoutMs` | `300000` | 单回合超时，超时返回已收集的部分文本（`partial: true`） |
| `maxMessageChars` | `20000` | 入站文本长度上限 |
| `approval` | `reject` | 桥接回合遇到审批请求：`reject` 自动拒绝并在回复里注明；`ignore` 留给 GUI 处理 |
| `provider` / `model` | 继承默认 | 桥接创建会话时的模型路由；不填则用 `agentDefaultModel`（GUI 的默认模型） |

## 实现要点

- 零运行时依赖：只 import `@deepseek-ai/{cordis,schemastery,dsh-llm,dsh-session}`（peer）。
- 回复 = `session/event` 里已提交的 assistant 文本块（与 GUI 渲染的同一份内容）。
- 回合结算沿用 ACP 桥的模式：`agent/inbox/claimed` 关联回合号、`turn/end` 记录结束原因、`whenIdle` 结算（包含子 agent 延续）、超时兜底。
- 每个会话同时只跑一个回合，多余消息按会话排队。
- 卸载/热重载时先 `closeAllConnections()` 再关服务器，避免悬挂的长连接卡住 dispose。

## 本地快速验证

```sh
curl http://127.0.0.1:51234/health
curl -X POST http://127.0.0.1:51234/message \
  -H 'Content-Type: application/json' \
  -d '{"text": "你好，请介绍一下你自己", "sessionKey": "my-wechat"}'
```
