# dsh-wechat-bot

DSH 宿主插件：微信 ↔ DSH 独立对话区桥接（悬浮球方案的宿主侧）。

职责：
1. spawn 并守护 `wechat-gateway` 子进程（崩溃自动重启，健康检查失败自动重启）。
2. 消费网关 SSE `message` 事件；微信消息进入**独立的微信对话区**（`keyed` 语义，绝不注入 GUI 会话）。
3. 用 `createBridge`（`dsh-wechat-bridge`）驱动会话；回复经网关 `/send` 回传微信。
4. 对话区编号持久化（`~/.dsh-wechat/wechat-session.json`）；`/new`、`/新对话`、`/新会话` 命令新建对话区。
5. 模型端点 `127.0.0.1:51236`：`GET/POST /model`（ClawBot 专用模型 + 思考强度，持久化 `clawbot-model.json`，重启恢复）、`GET /wechat/status`、`POST /wechat/new`。

环境要求与安装见仓库根目录 README。
