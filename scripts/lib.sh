#!/usr/bin/env bash
# Shared helpers for install-wechat.sh / install-dsh-bridge.sh (macOS, Linux, Git Bash on Windows).

# Resolve DSH home: $DSH_HOME > first profile dir that exists > official default ~/.dsh
resolve_dsh_home() {
  if [[ -n "${DSH_HOME:-}" ]]; then
    printf '%s\n' "$DSH_HOME"
    return 0
  fi

  local candidates=()
  candidates+=("$HOME/.dsh")
  if [[ "$(uname -s)" == "Darwin" ]]; then
    candidates+=("$HOME/Library/Application Support/DeepSeekHarness")
  fi
  if [[ -n "${APPDATA:-}" ]]; then
    candidates+=("$APPDATA/DeepSeekHarness")
  fi
  if [[ -n "${LOCALAPPDATA:-}" ]]; then
    candidates+=("$LOCALAPPDATA/DeepSeekHarness")
  fi

  local dir
  for dir in "${candidates[@]}"; do
    if [[ -d "$dir/profiles/web" ]]; then
      printf '%s\n' "$dir"
      return 0
    fi
  done

  printf '%s\n' "$HOME/.dsh"
}

# Create a directory symlink or junction (Windows fallback).
link_dir() {
  local target="$1"
  local link="$2"
  local parent

  parent="$(dirname "$link")"
  mkdir -p "$parent"
  rm -rf "$link" 2>/dev/null || true

  if ln -sfn "$target" "$link" 2>/dev/null; then
    return 0
  fi

  # Git Bash / MSYS: junction does not require Developer Mode.
  if command -v cmd.exe >/dev/null 2>&1; then
    local win_target win_parent win_link
    win_target="$(cd "$target" && pwd -W 2>/dev/null || true)"
    win_parent="$(cd "$parent" && pwd -W 2>/dev/null || true)"
    if [[ -n "$win_target" && -n "$win_parent" ]]; then
      win_link="$win_parent\\$(basename "$link")"
      if cmd //c "mklink /J \"$win_link\" \"$win_target\"" >/dev/null 2>&1; then
        return 0
      fi
    fi
  fi

  echo "错误: 无法创建链接 $link -> $target" >&2
  echo "  macOS/Linux: 确认有写权限。" >&2
  echo "  Windows: 开启「开发者模式」，或改用: dsh plugin --profile web add github:lubaiUwU/DSH-WeChatClawBot" >&2
  return 1
}
