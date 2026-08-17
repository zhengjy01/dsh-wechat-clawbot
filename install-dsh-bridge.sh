#!/usr/bin/env bash
# install-dsh-bridge.sh — 把 dsh-wechat-bridge 安装进当前 DSH 的 web 或 desktop profile。
#
# 用法:  bash install-dsh-bridge.sh
#        DSH_PROFILE=desktop bash install-dsh-bridge.sh
# Windows 也可用 Git Bash 运行本脚本。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib.sh
source "$SCRIPT_DIR/scripts/lib.sh"

PLUGIN_DIR="$SCRIPT_DIR/dsh-wechat-bridge"

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

link_peer_shims "$SCRIPT_DIR"
mkdir -p "$PROFILE_NM"
link_dir "$PLUGIN_DIR" "$PROFILE_NM/dsh-wechat-bridge"
echo "==> 已链接 $PROFILE_NM/dsh-wechat-bridge"

inject_patch_block "$PATCH_FILE" "dsh-wechat-bridge" "$(cat <<'EOF'
# 微信 ClawBot ↔ DSH 桥接插件（dsh-wechat-bridge）
# 由 install-dsh-bridge.sh 添加；删除本段即可卸载。
- insert:
    - id: wechat-bridge
      name: dsh-wechat-bridge
      config:
        host: 127.0.0.1
        port: 51234
        sessionMode: active
        timeoutMs: 300000
        maxMessageChars: 20000
        approval: reject
EOF
)"

echo
echo "安装完成。下一步："
echo "  1. 重启 DeepSeek Harness 应用（桥接随宿主进程启动）。"
echo "  2. 验证: curl http://127.0.0.1:51234/health"
echo "  3. 在 OpenClaw 侧安装 openclaw-dsh-bridge 插件（见 README.md）。"
