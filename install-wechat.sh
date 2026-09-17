#!/usr/bin/env bash
# install-wechat.sh — 把「微信悬浮球扫码桥接」装进当前 DSH 的 web 或 desktop profile。
#
# 用法:  bash install-wechat.sh
#        DSH_PROFILE=desktop bash install-wechat.sh
# Windows 也可用 Git Bash 运行本脚本，或执行: .\install-wechat.ps1
#
# 推荐（公开发布路径，也是本机切换后的挂载方式）：
#   dsh plugin --profile <web|desktop> add github:zhengjy01/dsh-wechat-clawbot
# 本脚本是「本地 checkout 开发模式」的替代方案（软链整个仓库，改代码即时生效）。
#
# 安装内容（全部幂等，可重复执行）:
#   1. wechat-gateway/ 依赖安装（qrcode）。
#   2. dsh-wechat-bot / dsh-wechat-bridge 的 @deepseek-ai peer 垫片。
#   3. 把整个仓库作为一个包软链进 profile（dsh-wechat-clawbot）。
#   4. 在 profile 的 cordis.patch.yml 注入 wechat-bot 一行
#      （悬浮球由同一包的 dsh.client 声明自动注册）。
#
# 完成后需要重启 DeepSeek Harness 应用：重启后右下角出现微信绿色悬浮球，
# 点开 → 扫码登录 → 微信消息直达 DSH 会话。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib.sh
source "$SCRIPT_DIR/scripts/lib.sh"

GATEWAY_DIR="$SCRIPT_DIR/wechat-gateway"

DSH_HOME_DIR="$(resolve_dsh_home)"
PROFILE_NAME="$(resolve_profile_name "$DSH_HOME_DIR")"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE_NAME"
PROFILE_NM="$PROFILE_DIR/node_modules"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"

echo "==> DSH home: $DSH_HOME_DIR"
echo "==> 目标 profile: $PROFILE_DIR"
if [[ ! -d "$PROFILE_DIR" ]]; then
  echo "错误: 找不到 profile 目录 $PROFILE_DIR（请先运行一次 DSH Desktop 或 dsh web，或设置 DSH_HOME / DSH_PROFILE）" >&2
  exit 1
fi

# 1. gateway 依赖
if [[ ! -d "$GATEWAY_DIR/node_modules" ]]; then
  echo "==> 安装 wechat-gateway 依赖（qrcode）..."
  (cd "$GATEWAY_DIR" && npm install --no-audit --no-fund)
else
  echo "==> wechat-gateway 依赖已就绪"
fi

# 2. bot + bridge peer 垫片（DSH 按真实路径加载，软链模式下两个包都需要）
link_peer_shims "$SCRIPT_DIR"
echo "==> 已链接 dsh-wechat-bot / dsh-wechat-bridge peer 垫片"

# 3. 把整个仓库作为一个包链接进 profile（宿主 + 悬浮球同一包）
mkdir -p "$PROFILE_NM"
link_dir "$SCRIPT_DIR" "$PROFILE_NM/dsh-wechat-clawbot"
echo "==> 已链接 profile node_modules/dsh-wechat-clawbot"

# 4. patch 注入（幂等；空文件或 [] 则整文件替换）
inject_patch_block "$PATCH_FILE" "wechat-bot" "$(cat <<'EOF'
# 微信悬浮球桥接（dsh-wechat-clawbot bundle：宿主 + 悬浮球同包）
# 由 install-wechat.sh 添加；删除本段即可卸载。
- insert:
    - id: wechat-bot
      name: dsh-wechat-clawbot
      config:
        sessionMode: active
        timeoutMs: 300000
        maxMessageChars: 20000
        approval: reject
EOF
)"

echo
echo "安装完成。下一步："
echo "  1. 重启 DeepSeek Harness / DSH Desktop。"
echo "  2. 右下角出现微信绿色悬浮球 → 点击 → 用手机微信扫码登录。"
echo "  3. 微信消息直接进入 DSH 会话，回复自动回传微信。"
echo "  卸载：删除 cordis.patch.yml 中 wechat-bot 段，并删除"
echo "       profiles/$PROFILE_NAME/node_modules/dsh-wechat-clawbot 链接。"
