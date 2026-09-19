# Changelog

> dsh-wechat-clawbot 的全部版本变更。本文件由 `scripts/release.mjs` 在发布时自动补写。
> 格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.2.2] - 2026-09-19

修正 0.2.1 里一个会让保鲜功能**静默失效**的判据错误。

### 背景（0.2.1 的漏洞）

0.2.1 把「往不存在的收件人发 `/send`」当成窗口探针，认为 `ret=-3` = 窗口开着、`ret=-2` = 窗口已关。**这是错的**：腾讯在收件人不存在时会**在「准备会话」之前**就做参数校验，所以在**任何**窗口状态下都返回 `ret=-3`。

**实测反证（2026-09-19 发布后）**：`POST /probe` 报 `window=open` 的一秒后，一次**完全不带 `context_token`** 的真实发送仍然返回 `ret=-2 prepare failed`；同一时刻的 `/send` 也是 `ret=-2`。→ 探针从来测不到窗口，0.2.1 的保鲜循环会把状态一直当成「开着」、**永不提醒**。

### 修复 (Fixed)

- **`POST /probe` 不再充当窗口判据**：改为「只验证上游可达」的探测，返回 `conclusive:false`，并且**不再改写 `window-state.json`**（不会伪造窗口状态）。
- **窗口状态只取真实发送的结果**：`GET /window` 的 `window` 仅由最近一次真实 `/send` 决定（成功=open / `ret=-2`=closed），这是唯一可靠信号。
- **新增按静默时长的桌面提醒** `keepaliveWarnHours`（默认 2 小时，`0`=关）：窗口可能在我们观测到之前就已关闭，因此「距上次入站超过阈值」时用**桌面通道**（可靠）提醒用户回一句续期，**每个入站只提醒一次**。
- **修掉跨 tick 漏出的旧 action 字段**：`evaluateWindowTick()` 现在会清掉上一轮的 `dueWarnHours` / `dueNudgeHours`，避免上一轮的动作被重复执行。

### 变更 (Changed)

- `/window` 的 `unknown` 提示改为「窗口状态只来自最近一次真实发送；`POST /probe` 不作数」。
- 网关与双语 README 的探针说明同步更正；实测边界补记「1h44m 后即被拒」的实例，强调真实窗口长度**未标定**。

### 单元测试

- `keepalive.mjs` 的 7 项测试改为锁定新契约（窗口只认真实发送结果、静默提醒每入站一次、`0` 关闭、关闭当轮不再重复提醒）；`window.mjs` 8 项不变。离线 mock iLink 集成测 10 项覆盖「探针不改写状态」「真实发送决定开/关」。

## [0.2.1] - 2026-09-19

把「会话窗口健康 + 保鲜提醒」从本机手写脚本收进插件本体，修复「完成任务却收不到通知」的根因。

### 背景

腾讯 iLink 只在用户「会话窗口」打开时接受主动推送；窗口只有用户能开（他从手机给机器人发一句话），机器人发出去的消息不给它续期。窗口关闭后一律 `ret=-2 prepare failed`，而网关 `/status` 的 `phase` 仍是 `logged_in`——**本地状态不反映出站可用性**。旧脚本因此静默降级成 macOS 横幅，用户对通道已坏完全无感。

### 新增 (Added)

- **网关侧入站时钟**：对**每条入站消息**落盘 `<stateDir>/last-inbound.json`（`at/ts/from/preview/count`）。不能用 `context-tokens.json` 的 `updatedAt`——`saveContextToken()` 在 token 未变化时跳过写入，连续消息会让时间冻住。
- **`GET /window` 窗口健康**：返回 `window`(open/closed/unknown)、`lastInboundAt`、`age`、最近一次发送/探测结果与 `hint`；`/status` 同步暴露 `window`/`lastInboundAt`。
- **`POST /probe` 无损探针**：往不存在的收件人发消息，腾讯走到参数校验即返回（`ret=-3` 窗口开 / `ret=-2` 窗口关），**不给用户发任何消息**。
- **发送失败的结构化原因**：`/send` 失败返回 `{ ok:false, reason, ret, window, hint, lastInboundAt, age }`，不再只有一句 `ret=-2 prepare failed`。
- **插件内置保鲜循环**（宿主插件）：每 30 分钟检查一次（`keepalive` / `keepaliveIntervalMinutes` / `keepaliveNudgeHours` / `keepaliveNotify` 可配）。窗口「开→关」跳变时弹**一次**桌面通知（macOS）提醒「回一句话即可恢复」；已关则停止空探，直到入站时钟变化（用户回话）才再探一次确认。全新机器安装插件即自带，**不依赖任何本机脚本或 launchd 定时器**。
- **`window/state` SSE 事件**：窗口状态变化时广播。
- **单元测试**：`npm test`（窗口错误分类 + 保鲜状态机，`node --test`，无需网络）。

### 修复 (Fixed)

- **存活探针缺少 `version` 字段**：`GET /api/dsh-wechat-bot/probe` 现在返回 `version`（读本包 `package.json`），兑现 CHANGELOG 一直以来的承诺，发布验收「重启后探针报版本」得以成立。

### 变更 (Changed)

- `wechat-gateway/gateway.mjs` 的 `sendMessage()` 把 iLink 的 `ret`/`errmsg` 挂到 Error 上，供统一分类；`ret=-3` 不再被误当成「通道坏了」。
- README 双语补充 `/window`、`/probe`、子命令与排障口径。

### 兼容性 (Compatibility)

- DSH：`>=0.1.5-rc.1`
- Node：`>=22.19`
- 旧调用方无需改动：`/send` 成功语义不变；新增字段只在失败响应里出现。旧网关（无 `/window`）上，通知/日报脚本会自动回落到原来的「发送后看结果」路径。

## [0.2.0] - 2026-09-17

本仓库（`zhengjy01/dsh-wechat-clawbot`）作为独立维护线接手上游 `lubaiUwU/DSH-WeChatClawBot` 后的首个版本（上游最后提交 `b817fc9`，2026-08-17；维护者自 2026-08-18 起无活动）。

### ⚠️ 迁移说明（从上游或从本地软链安装迁移过来，必读）

1. **包结构变了：从「monorepo + `file:` 子包」变成单一 npm 包。**
   上游的 `dsh-wechat-bot` 通过 `file:../dsh-wechat-bridge` 引用同仓子包，并带 `prepare` / `postinstall` 构建脚本 —— 在 **pnpm 10** 下 `dsh plugin add` 会**直接装不上**（解析不到 `file:` 子包，或 build scripts 被 `allowBuilds` 拦截）。本版把宿主入口改为根 `index.js` 转出、把 bridge 改为**相对导入**、去掉全部构建脚本，因此安装成功即进入 `dsh.profile.bundles`。
2. **安装方式变了：不再用「克隆 + 软链」挂载。**
   ```sh
   dsh plugin --profile <desktop|web> add github:zhengjy01/dsh-wechat-clawbot
   ```
   若你之前用上游的 `install-wechat.sh` 在 `profiles/<p>/node_modules/` 下建过 `dsh-wechat-bot` / `dsh-client-wechat-ui` / `dsh-wechat-bridge` **三个软链**，请删掉它们，并移除 profile `cordis.patch.yml` 里手工 `insert` 的 `wechat-bot` / `wechat-ui` 两行 —— 本包的 bundle 会**自带**这一行，重复会 `duplicate id`。
3. **必须重启 DSH。** 插件树（bundle 列表）只在启动时读取；不重启不会挂上新包。
4. **本包地址前缀不变**，仍是 `/api/dsh-wechat-bot/*`，配置文件名仍是 `~/.dsh-wechat/*` —— 按发布规范保留，避免丢既有登录凭证与配置。

### 新增 (Added)

- **`GET /api/dsh-wechat-bot/probe` 宿主存活探针**：返回 `{ok, plugin, version, gatewayPort, modelPort}`，供可移植性验证与外部健康检查使用（`ctx.inject` 了 `webServer`，headless 下也不受阻）。
- **端口与状态目录可用环境变量覆盖**：`DSH_WECHAT_GATEWAY_PORT`、`DSH_WECHAT_MODEL_PORT`、`DSH_WECHAT_STATE_DIR`（默认值不变）。隔离的可移植性验证依赖它们避开主实例占用的端口。
- **发布前门禁**：`scripts/portability.mjs` + `PORTABILITY-SOP.md` + `npm run verify` / `verify:full` / `verify:quick`。
- **双语 README**：`README.md`（英文）+ `README.zh.md`（中文），顶部互切。
- **主动推送上下文持久化**（见下方修复 ② 的落地文件）：`<stateDir>/context-tokens.json`。

### 修复 (Fixed)

- **登录循环覆盖已登录状态，导致回复发不出去（"没反应"）**（上游 `b817fc9` 之后的本地修复，提交 `6668793`）：
  重复/强制登录会启动新的登录循环但从不取消旧的；旧循环收到 `expired` 后会把已经 `logged_in` 的全局状态改回 `waiting_qrcode`，于是 `/send` 被自身状态守卫拒绝，DSH 已生成的回复被静默丢弃。修复：`state.loginGen` 轮次隔离（`bailIfSuperseded` 静默退出、`setPhaseCurrent` 只有当前轮次能写状态）、`/send` 放宽为「只要还持有 token 就允许发送」、`modelServer` 补 `error` 监听（端口占用不再终结 DSH 宿主）。
- **主动推送在距上次用户交互一段时间后一律 `502 ret=-2 prepare failed`**（提交 `273601d`）：
  iLink 的 `sendmessage` 需要「打开的会话上下文（`context_token`）」。入站消息带该 token，但原网关只在自动回复那条路径透传，其余地方直接丢弃，因此所有 fire-and-forget 主动推送（会话日报、微信通知、任务派发器通知）在上下文过期后必然失败 —— 表现为「微信通道突然坏了」，实际与 token 有效性、网络、monitor 长轮询统统无关。修复：把每个发送者**最近一次**的 `context_token` 落盘（`<stateDir>/context-tokens.json`，0600，最多保留 50 个发送者，token 未变化则跳过写入），`/send` 在调用方未显式提供 `contextToken` 时**自动复用**；调用方仍可显式覆盖。**一处修复，日报/通知/派发器全部受益，脚本侧无需改动。**

### 变更 (Changed)

- 宿主内引用 `dsh-wechat-bridge` 由 peer 子包改为**相对导入**，安装路径不再依赖配套软链垫片（`scripts/link-peer-shims.mjs` 仅本地软链开发模式需要）。
- 单一组合包：根 `index.js` 转出宿主插件，`dsh.client` + `exports["./client"]` 声明悬浮球 bundle（浏览器端从本包发现 `dsh-wechat-clawbot/client.js`）。

### 未改动（与上游一致）

扫码登录、悬浮球面板、联系人白名单、ClawBot 专用模型配置、独立对话区与 `/new` 切换等行为全部保持上游原样。

## [0.1.1] - 2026-09-10（上游）

- 上游修复：DSH Desktop（Windows/Electron）拉起网关时需 `ELECTRON_RUN_AS_NODE=1`。
- 上游修复：Windows 安装路径与状态目录适配；`925eb4a` 修 Windows DSH Desktop 安装后无法启动。

## [0.1.0] - 2026-09-09（上游首个可安装版本）

- 首次以可安装 bundle 形式发布：扫码登录 + 悬浮球面板 + 独立微信对话区 + ClawBot 专用模型。
