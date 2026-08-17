#!/usr/bin/env bash
# install-wechat.sh — 把「微信悬浮球扫码桥接」装进当前 DSH 的 web profile。
#
# 用法:  bash install-wechat.sh
#
# 安装内容（全部幂等，可重复执行）:
#   1. wechat-gateway/ 依赖安装（qrcode）。
#   2. dsh-wechat-bot 宿主插件：node_modules 垫片 + 链接进 profile。
#   3. dsh-client-wechat-ui 悬浮球插件：链接进 profile。
#   4. 在 $DSH_HOME/profiles/web/cordis.patch.yml 注入 wechat-bot 与 wechat-ui 两行。
#
# 完成后需要重启 DeepSeek Harness 应用：重启后右下角出现微信绿色悬浮球，
# 点开 → 扫码登录 → 微信消息直达 DSH 会话。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATEWAY_DIR="$SCRIPT_DIR/wechat-gateway"
BOT_DIR="$SCRIPT_DIR/dsh-wechat-bot"
UI_DIR="$SCRIPT_DIR/dsh-client-wechat-ui"

if [[ -n "${DSH_HOME:-}" ]]; then
  DSH_HOME_DIR="$DSH_HOME"
else
  DSH_HOME_DIR="$HOME/Library/Application Support/DeepSeekHarness"
fi

PROFILE_DIR="$DSH_HOME_DIR/profiles/web"
FALLBACK_NM="$DSH_HOME_DIR/profiles/node_modules"
PROFILE_NM="$PROFILE_DIR/node_modules"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"

echo "==> 目标 profile: $PROFILE_DIR"
if [[ ! -d "$PROFILE_DIR" ]]; then
  echo "错误: 找不到 profile 目录 $PROFILE_DIR（请先运行一次 dsh web，或设置 DSH_HOME）" >&2
  exit 1
fi

# 1. gateway 依赖
if [[ ! -d "$GATEWAY_DIR/node_modules" ]]; then
  echo "==> 安装 wechat-gateway 依赖（qrcode）..."
  (cd "$GATEWAY_DIR" && npm install --no-audit --no-fund)
else
  echo "==> wechat-gateway 依赖已就绪"
fi

# 2. bot 插件垫片 + 链接
SHIM="$BOT_DIR/node_modules"
mkdir -p "$SHIM/@deepseek-ai"
for pkg in cordis schemastery dsh-agent dsh-llm dsh-session dsh-settings; do
  if [[ -e "$FALLBACK_NM/@deepseek-ai/$pkg" ]]; then
    ln -sfn "$FALLBACK_NM/@deepseek-ai/$pkg" "$SHIM/@deepseek-ai/$pkg"
  fi
done
ln -sfn "$SCRIPT_DIR/dsh-wechat-bridge" "$SHIM/dsh-wechat-bridge"
ln -sfn "$BOT_DIR" "$PROFILE_NM/dsh-wechat-bot"
echo "==> 已链接 dsh-wechat-bot（含依赖垫片）"

# 3. 悬浮球 client 插件
ln -sfn "$UI_DIR" "$PROFILE_NM/dsh-client-wechat-ui"
echo "==> 已链接 dsh-client-wechat-ui"

# 4. patch 注入（幂等）
if grep -q "wechat-bot" "$PATCH_FILE" 2>/dev/null; then
  echo "==> $PATCH_FILE 已包含 wechat-bot，跳过注入"
else
  cat >> "$PATCH_FILE" <<'EOF'

# 微信悬浮球桥接（dsh-wechat-bot + dsh-client-wechat-ui）
# 由 install-wechat.sh 添加；删除本段即可卸载。
- insert:
    - id: wechat-bot
      name: dsh-wechat-bot
      config:
        gatewayPort: 51235
        sessionMode: active
        timeoutMs: 300000
        maxMessageChars: 20000
        approval: reject
    - id: wechat-ui
      name: dsh-client-wechat-ui
EOF
  echo "==> 已注入 patch 行到 $PATCH_FILE"
fi

echo
echo "安装完成。下一步："
echo "  1. 重启 DeepSeek Harness 应用。"
echo "  2. 右下角出现微信绿色悬浮球 → 点击 → 用手机微信扫码登录。"
echo "  3. 微信消息直接进入 DSH 会话，回复自动回传微信。"
echo "  卸载：删除 cordis.patch.yml 中 wechat-bot/wechat-ui 段，并删除"
echo "       profiles/web/node_modules 下对应链接。"
