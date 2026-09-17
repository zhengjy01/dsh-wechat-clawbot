#!/usr/bin/env bash
# Shared helpers for install-wechat.sh / install-dsh-bridge.sh (macOS, Linux, Git Bash on Windows).

# Resolve DSH home: $DSH_HOME > first home that already has a profile > ~/.dsh
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
    if [[ -d "$dir/profiles/desktop" || -d "$dir/profiles/web" || -d "$dir/profiles/node_modules" ]]; then
      printf '%s\n' "$dir"
      return 0
    fi
  done

  printf '%s\n' "$HOME/.dsh"
}

# Prefer DSH_PROFILE, else desktop (DSH Desktop), else web (dsh web).
resolve_profile_name() {
  local home="$1"
  if [[ -n "${DSH_PROFILE:-}" ]]; then
    printf '%s\n' "$DSH_PROFILE"
    return 0
  fi
  if [[ -d "$home/profiles/desktop" ]]; then
    printf '%s\n' "desktop"
    return 0
  fi
  if [[ -d "$home/profiles/web" ]]; then
    printf '%s\n' "web"
    return 0
  fi
  printf '%s\n' "web"
}

# Remove a symlink or Windows junction without following it.
unlink_dir() {
  local link="$1"
  if [[ ! -e "$link" && ! -L "$link" ]]; then
    return 0
  fi
  if command -v cmd.exe >/dev/null 2>&1; then
    local win_link parent
    parent="$(dirname "$link")"
    if [[ -d "$parent" ]]; then
      win_link="$(cd "$parent" && pwd -W 2>/dev/null)\\$(basename "$link")"
      if [[ "$win_link" != "\\" ]]; then
        cmd //c "rmdir \"$win_link\"" >/dev/null 2>&1 || true
      fi
    fi
  fi
  rm -rf "$link" 2>/dev/null || true
}

# Create a directory symlink or junction (Windows fallback).
link_dir() {
  local target="$1"
  local link="$2"
  local parent

  parent="$(dirname "$link")"
  mkdir -p "$parent"
  unlink_dir "$link"

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
  echo "  Windows: 开启「开发者模式」，或改用: dsh plugin --profile desktop add github:zhengjy01/dsh-wechat-clawbot" >&2
  return 1
}

link_peer_shims() {
  local script_dir="$1"
  if command -v node >/dev/null 2>&1; then
    (cd "$script_dir" && node scripts/link-peer-shims.mjs)
    return $?
  fi
  echo "警告: 未找到 node，跳过 peer 垫片（请改用 dsh plugin add，或安装 Node.js）" >&2
  return 1
}

# Inject a YAML patch block. Replaces a lone [] file instead of appending after it.
inject_patch_block() {
  local patch_file="$1"
  local marker="$2"
  local block="$3"

  if [[ -f "$patch_file" ]] && grep -q "$marker" "$patch_file" 2>/dev/null; then
    echo "==> $patch_file 已包含 $marker，跳过注入"
    return 0
  fi

  mkdir -p "$(dirname "$patch_file")"
  if [[ ! -f "$patch_file" ]]; then
    printf '%s\n' "$block" > "$patch_file"
  else
    local trimmed
    trimmed="$(tr -d '[:space:]' < "$patch_file")"
    if [[ -z "$trimmed" || "$trimmed" == "[]" ]]; then
      printf '%s\n' "$block" > "$patch_file"
    else
      printf '\n%s\n' "$block" >> "$patch_file"
    fi
  fi
  echo "==> 已注入 patch 行到 $patch_file"
}
