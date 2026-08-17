# DSH-WeChatClawBot — 微信悬浮球扫码桥接

**安装（用户只需这一句）：** 对 DSH 说 `请帮我安装插件 https://github.com/lubaiUwU/DSH-WeChatClawBot`  
Windows / macOS / Linux、DSH Desktop 与 CLI 都适用。profile、`allowBuilds`、依赖垫片由安装方按下方「给安装 Agent 的步骤」自动处理，用户不用额外交代。

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）装一个插件后，GUI 右下角出现**微信绿色悬浮球**：点开 → 手机微信扫码登录 → 之后微信里发给你的消息**直接进入独立的微信对话区**（不会混进 GUI 会话），由 DSH 的 agent 处理，回复自动回传微信。

不需要 OpenClaw、不需要任何外部服务。微信接入使用腾讯官方渠道协议（iLink，与 `@tencent-weixin/openclaw-weixin` 同源，MIT 许可），本项目把协议核心抽成了独立网关服务。

```
微信 (手机)
   │ 扫码登录（悬浮球面板展示二维码）
   ▼
wechat-gateway      ← 独立 Node 服务（腾讯 iLink 协议：收/发消息，端口 51235）
   │  SSE message 事件
   ▼
dsh-wechat-bot      ← DSH 宿主插件（spawn/守护网关、注入会话、回复回传）
   │  createBridge（会话驱动核心，复用 dsh-wechat-bridge）
   ▼
DSH agent（独立微信对话区；上下文长期保留）
   ▲
dsh-client-wechat-ui ← 浏览器悬浮球（扫码/验证码/白名单/模型配置/新对话）
```

## ✨ 功能特性

- **扫码即用**：手机微信扫悬浮球二维码绑定；登录凭证存本机，**重启 DSH 自动恢复登录**（token 失效才需重扫）
- **独立对话区**：微信消息绝不进入 GUI 会话；对话区上下文连续，**重启后自动恢复历史**（持久化会话 + 会话映射）
- **按命令切换对话**：微信发 `/new`（或 `/新对话`、`/新会话`）、悬浮球点「新对话」才新建对话区；默认永远沿用同一对话
- **ClawBot 专用模型**：面板配置模型（快捷选择已配密钥的模型 / 自定义填写）+ 思考强度（off/high/max），重启后保留，只对微信回合生效
- **联系人白名单**：默认允许所有；可在面板批准/忽略新联系人

## 🖥️ 环境要求

| 依赖 | 要求 | 说明 |
|---|---|---|
| 操作系统 | **Windows / macOS / Linux** | 推荐 `dsh plugin add`；Windows 也可 `.\install-wechat.ps1` |
| DeepSeek Harness | 已安装 DSH Desktop 或能跑 `dsh` | 用户只需说「请帮我安装插件」+ 本仓库 URL；profile 由安装方自动检测 |
| Node.js | **>= 22.19**（建议 22.x 或 24.x LTS） | 与 DSH 引擎要求一致；网关与插件同标准 |
| npm | 任意较新版本 | 安装 wechat-gateway 的 `qrcode` 依赖 |
| 微信账号 | 一个可扫码的手机微信 | **建议小号**：个人微信自动化存在账号风控风险，请自行评估 |
| 模型密钥 | 可选 | 在 DSH 设置（Models 页）配置密钥即可；快捷选择模型时会自动检测密钥状态 |
| 可用端口 | 51234 / 51235 / 51236 | 均为本机回环 `127.0.0.1` 监听，一般不会冲突 |

### 端口与数据目录

| 项 | 值 | 用途 |
|---|---|---|
| `127.0.0.1:51234` | dsh-wechat-bridge HTTP 桥 | 调试 / OpenClaw 转发方案 |
| `127.0.0.1:51235` | wechat-gateway | 微信协议收/发、扫码登录、SSE 事件 |
| `127.0.0.1:51236` | dsh-wechat-bot 模型端点 | 悬浮球读写「ClawBot 使用模型」配置 |
| `~/.dsh-wechat/` | 状态目录 | 登录凭证、白名单、模型配置（`clawbot-model.json`）、会话映射（`bridge-sessions.json`）、对话区编号（`wechat-session.json`） |

`$DSH_HOME` 默认 **`~/.dsh`**（Windows：`C:\Users\<你>\.dsh`）；Mac 桌面 `.app` 可能是 `~/Library/Application Support/DeepSeekHarness`。可用环境变量 `DSH_HOME` 覆盖。DSH Desktop 的 profile 一般叫 `desktop`，CLI Web 一般叫 `web`（安装 Agent 会自动选，用户不用记）。

## 📦 目录结构

```
DSH-WeChatClawBot/
├── package.json          # 组合包 manifest（dsh.bundle → cordis.patch.yml）
├── cordis.patch.yml      # 注入 wechat-bot + wechat-ui 两行
├── wechat-gateway/       # 微信网关（gateway.mjs，Node 内置 fetch，依赖 qrcode）
├── dsh-wechat-bot/       # DSH 宿主插件（管理网关进程、会话注入、模型端点）
├── dsh-client-wechat-ui/ # 浏览器悬浮球插件（零依赖 bundle）
├── dsh-wechat-bridge/    # 会话驱动核心（createBridge + 可选 HTTP 桥 + 单元测试）
├── install-wechat.sh     # 一键安装（软链方案，macOS/Linux/Git Bash）
├── install-wechat.ps1    # 一键安装（PowerShell，Windows 原生）
├── install-dsh-bridge.sh # 安装 HTTP 桥（可选，OpenClaw 转发方案用）
├── scripts/              # prepare + peer 垫片（dsh plugin add 也会跑）
└── README.md
```

## 🚀 安装

用户只需对 DSH 说这一句（不必提 Windows、desktop、allowBuilds）：

```
请帮我安装插件 https://github.com/lubaiUwU/DSH-WeChatClawBot
```

下面整节是给**正在执行安装的 AI / Agent**看的。用户不用说这些；你读完后自己做完，不要再追问用户选 profile。

### 给安装 Agent 的步骤（必须按顺序做完）

1. **自动选定 profile，不要默认 web。**  
   `$DSH_HOME` 一般为 `~/.dsh`（Windows：`%USERPROFILE%\.dsh`）。按下面优先级选一个已存在的目录名：
   - `$DSH_HOME/profiles/desktop` 存在 → 用 **`desktop`**（DSH Desktop / Windows 官方桌面版几乎都是这个）
   - 否则 `$DSH_HOME/profiles/web` 存在 → 用 **`web`**
   - 否则看 `$DSH_HOME/profiles/` 下实际有哪个，用那个  
   记作 `<profile>`。

2. **安装组合包：**

   ```sh
   dsh plugin --profile <profile> add github:lubaiUwU/DSH-WeChatClawBot
   ```

3. **pnpm ≥10 若失败并提示 `allowBuilds`：** 不要停下来问用户。编辑  
   `$DSH_HOME/profiles/<profile>/pnpm-workspace.yaml`  
   在文件中加入（没有该键就新建）：

   ```yaml
   allowBuilds:
     dsh-wechat-clawbot: true
   ```

   然后**再执行一次**第 2 步的 `dsh plugin add`。本仓库的 `prepare` / `postinstall` 会给 `dsh-wechat-bot` **和** `dsh-wechat-bridge` 链接 `@deepseek-ai/*` 垫片；不跑 prepare 时，DSH Desktop 会因找不到 `schemastery` 而启动闪退。

4. **告诉用户重启 DSH / DSH Desktop。** 重启后右下角应出现微信绿色悬浮球 → 扫码登录。不要假设不重启也能用。

5. **不要**只改 `cordis.patch.yml` 却不装包；**不要**假设 profile 一定是 `web`；**不要**用 `spawn` 网关时去掉 `ELECTRON_RUN_AS_NODE`（Windows Desktop 的 `process.execPath` 是 exe 不是 node）。

### 手动安装（脚本）

**macOS / Linux / Git Bash：**

```sh
git clone https://github.com/lubaiUwU/DSH-WeChatClawBot
cd DSH-WeChatClawBot
bash install-wechat.sh
```

**Windows PowerShell：**

```powershell
git clone https://github.com/lubaiUwU/DSH-WeChatClawBot
cd DSH-WeChatClawBot
.\install-wechat.ps1                  # 自动选择 desktop 或 web
.\install-wechat.ps1 -Profile desktop # 强制装进 DSH Desktop
```

### 手动安装（DSH 插件命令）

若你自己跑命令：先看 `$DSH_HOME/profiles/` 里是 `desktop` 还是 `web`，再用那个名字：

```sh
dsh plugin --profile desktop add github:lubaiUwU/DSH-WeChatClawBot
# 或
dsh plugin --profile web add github:lubaiUwU/DSH-WeChatClawBot
```

### 一键脚本（本地 checkout）

```sh
# 1. 安装（幂等，可重复执行；脚本会：装网关依赖 → 建插件依赖垫片 →
#    把三个包链接进 DSH profile 的 node_modules → 写入 cordis.patch.yml）
bash install-wechat.sh

# 2. 重启 DeepSeek Harness 应用（让宿主插件与悬浮球插件加载）

# 3. 扫码
#    GUI 右下角绿色微信悬浮球 → 点击 → 手机微信「扫一扫」
#    （部分账号首次登录需在面板输入手机显示的验证码）
```

验证网关：

```sh
curl http://127.0.0.1:51235/status
# {"phase":"logged_in","message":"已恢复登录（使用已保存的凭证）",...} 或 {"phase":"waiting_qrcode",...}
```

### 安装脚本做了什么

1. `wechat-gateway/` 内 `npm install`（安装 `qrcode` 依赖）。
2. 为 **`dsh-wechat-bot` 和 `dsh-wechat-bridge`** 建立 `node_modules/@deepseek-ai/*` 依赖垫片（软链/junction 到 `$DSH_HOME/profiles/node_modules`）——DSH 按真实路径解析插件，两个包都需要垫片才能找到 `@deepseek-ai/{cordis,schemastery,...}`。`dsh plugin add` 会在 `prepare` / `postinstall` 里自动做这一步。
3. 把插件软链进 `$DSH_HOME/profiles/<desktop|web>/node_modules/`。
4. 在该 profile 的 `cordis.patch.yml` 注入 `wechat-bot` / `wechat-ui` 两行（若文件是空的 `[]` 则整文件替换，避免无效 YAML）。

卸载：删掉 `cordis.patch.yml` 中对应段与 `profiles/<name>/node_modules/` 下对应链接，重启即可；`~/.dsh-wechat/` 删除即退出登录。

## 📱 使用

- **收消息**：微信消息进入**独立的微信对话区**（GUI 侧边栏可见，不会混入你的 GUI 聊天）；同对话区上下文连续，**重启 DSH 自动恢复历史记忆**。
- **切换对话**：微信发 `/new`、`/新对话`、`/新会话`，或悬浮球面板点「新对话」→ 新建对话区（旧对话保留）；其余时间一直沿用当前对话。
- **ClawBot 使用模型**：面板「快捷选择」列出已配密钥的模型（自动检测密钥状态），或「自定义填写」Provider/模型，选思考强度（off/high/max），保存后**只对微信回合生效**、重启保留；选「跟随 DSH 默认」再保存即清除配置。
- **新联系人**：白名单为空 = 允许所有；陌生人消息会先收到提示，并在面板出现「批准/忽略」。

## ⚙️ 配置

`$DSH_HOME/profiles/<desktop|web>/cordis.patch.yml`：

```yaml
- insert:
    - id: wechat-bot
      name: dsh-wechat-bot
      config:
        gatewayPort: 51235        # 微信网关端口
        modelPort: 51236          # 模型配置端点端口
        timeoutMs: 300000         # 单回合超时
        maxMessageChars: 20000
        approval: reject          # 回合内审批：自动拒绝并注明（可在 GUI 重跑）
    - id: wechat-ui
      name: dsh-client-wechat-ui
```

网关环境变量（`wechat-gateway/gateway.mjs`）：`PORT`（默认 51235）、`STATE_DIR`（默认 `~/.dsh-wechat`）、`UNAPPROVED_REPLY`（未授权自动回复文案）、`LOG_LEVEL`（debug/info）。

## 🧪 开发与测试

- 语法：`node --check <file>`；网关/插件零构建（纯 JS ESM）。
- 会话结算单元测试：`node dsh-wechat-bridge/settle.test.mjs`（覆盖 turn/end 结算、超时、报错、丢弃兜底、模型覆盖等场景，共 7 项）。
- 网关可独立运行调试：`cd wechat-gateway && npm install && node gateway.mjs`。
- 修改宿主插件或网关后需**重启 DSH** 生效；修改 `client.js`（悬浮球）同样重启生效（boot 图缓存）。

## 🛠️ 排障

| 现象 | 处理 |
|---|---|
| 没有悬浮球 | 确认已装进正在运行的那个 profile（Desktop 用 `desktop`，CLI 用 `web`）并重启过应用 |
| **DSH Desktop 双击闪退** | 多为 `dsh-wechat-bridge` 找不到 `@deepseek-ai/schemastery`。更新到本仓库最新版后重装：`dsh plugin --profile desktop add github:lubaiUwU/DSH-WeChatClawBot`。临时：给 `dsh-wechat-bridge/node_modules/@deepseek-ai/` 建与 bot 相同的 junction 垫片 |
| 面板「无法连接网关」 | 网关没起来。DSH Desktop（Electron）必须用 `ELECTRON_RUN_AS_NODE=1` 拉起网关（0.1.1 已内置）。检查 `netstat -ano \| findstr 51235` 是否 LISTENING；看日志 `wechat-gateway:` 行 |
| 登录后重启又要扫码 | 正常情况会自动恢复；若出现「登录已失效」说明 token 被微信侧吊销，需重扫 |
| 微信发消息没反应 | 面板确认状态为「已连接」；新联系人需先批准；日志看 `dsh-wechat-bot:` 行 |
| 回复失败提示 | 登录态失效：面板解绑后重新扫码，或删 `~/.dsh-wechat/accounts/` |
| 模型配置不生效 | 确认面板保存成功；配置只对**微信发起的回合**生效（GUI 手动回合不受影响） |
| 想清空所有状态 | 删除 `~/.dsh-wechat/`（凭证/模型/会话映射一并清除） |

## 📄 许可证

MIT。协议核心（iLink 客户端）源自 [`@tencent-weixin/openclaw-weixin`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)（腾讯官方渠道插件，MIT）。

> ⚠️ 免责声明：本项目仅供学习与个人自动化研究。使用个人微信账号自动化存在**账号风控/封号风险**，请使用小号并自行承担后果。本项目与腾讯、DeepSeek 无官方关联。
