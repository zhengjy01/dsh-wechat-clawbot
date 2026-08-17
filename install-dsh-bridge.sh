#!/usr/bin/env bash
# install-dsh-bridge.sh — 把 dsh-wechat-bridge 安装进当前 DSH 的 web profile。
#
# 用法:  bash install-dsh-bridge.sh
# Windows 也可用 Git Bash 运行本脚本。
#
# 做的事（全部幂等，可重复执行）:
#   1. 在插件目录里创建 node_modules 垫片，把 @deepseek-ai/* 软链到
#      $DSH_HOME/profiles/node_modules（插件通过真实路径被加载，需要自包含解析）。
#   2. 把插件软链进 $DSH_HOME/profiles/web/node_modules/。
#   3. 在 $DSH_HOME/profiles/web/cordis.patch.yml 里注入 wechat-bridge 行。
#
# 完成后需要重启 DeepSeek Harness 应用（桥接随宿主进程一起启动）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib.sh
source "$SCRIPT_DIR/scripts/lib.sh"

PLUGIN_DIR="$SCRIPT_DIR/dsh-wechat-bridge"

DSH_HOME_DIR="$(resolve_dsh_home)"
PROFILE_DIR="$DSH_HOME_DIR/profiles/web"
FALLBACK_NM="$DSH_HOME_DIR/profiles/node_modules"
PROFILE_NM="$PROFILE_DIR/node_modules"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"

echo "==> 目标 profile: $PROFILE_DIR"
if [[ ! -d "$PROFILE_DIR" ]]; then
  echo "错误: 找不到 profile 目录 $PROFILE_DIR（请先运行一次 dsh web，或设置 DSH_HOME）" >&2
  exit 1
fi

# 1. 插件目录内 node_modules 垫片（保证从真实路径解析 @deepseek-ai/*）
SHIM="$PLUGIN_DIR/node_modules/@deepseek-ai"
mkdir -p "$SHIM"
for pkg in cordis dsh-agent dsh-llm dsh-session schemastery; do
  if [[ -e "$FALLBACK_NM/@deepseek-ai/$pkg" ]]; then
    link_dir "$FALLBACK_NM/@deepseek-ai/$pkg" "$SHIM/$pkg"
  else
    echo "警告: $FALLBACK_NM/@deepseek-ai/$pkg 不存在，跳过 $pkg" >&2
  fi
done
echo "==> 已就绪插件依赖垫片 $SHIM"

# 2. 把插件链接进 profile 的 node_modules
mkdir -p "$PROFILE_NM"
link_dir "$PLUGIN_DIR" "$PROFILE_NM/dsh-wechat-bridge"
echo "==> 已链接 $PROFILE_NM/dsh-wechat-bridge"

# 3. 注入 patch 行（幂等）
if grep -q "dsh-wechat-bridge" "$PATCH_FILE" 2>/dev/null; then
  echo "==> $PATCH_FILE 已包含 wechat-bridge，跳过注入"
else
  cat >> "$PATCH_FILE" <<'EOF'

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
  echo "==> 已注入 patch 行到 $PATCH_FILE"
fi

echo
echo "安装完成。下一步："
echo "  1. 重启 DeepSeek Harness 应用（桥接随宿主进程启动）。"
echo "  2. 验证: curl http://127.0.0.1:51234/health"
echo "  3. 在 OpenClaw 侧安装 openclaw-dsh-bridge 插件（见 README.md）。"
