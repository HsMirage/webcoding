#!/usr/bin/env bash
# Webcoding 一键安装脚本 (Linux / macOS)
# 用法:
#   curl -fsSL https://raw.githubusercontent.com/HsMirage/webcoding/main/install.sh | bash
# 或指定安装目录:
#   curl -fsSL https://raw.githubusercontent.com/HsMirage/webcoding/main/install.sh | bash -s -- ~/mydir

set -e

REPO="https://github.com/HsMirage/webcoding.git"
RAW_BASE="https://raw.githubusercontent.com/HsMirage/webcoding/main"

# 支持 --uninstall 参数
UNINSTALL_MODE=false
for arg in "$@"; do
  case "$arg" in --uninstall|-u) UNINSTALL_MODE=true ;; esac
done
INSTALL_DIR="${1:-$HOME/webcoding}"
# 若第一个参数是 --uninstall，使用默认目录
[ "$INSTALL_DIR" = "--uninstall" ] || [ "$INSTALL_DIR" = "-u" ] && INSTALL_DIR="$HOME/webcoding"

# ── 颜色 ──────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'
info()    { printf "%b[Webcoding]%b %s\n" "$CYAN" "$NC" "$*"; }
success() { printf "%b[Webcoding]%b %s\n" "$GREEN" "$NC" "$*"; }
warn()    { printf "%b[Webcoding]%b %s\n" "$YELLOW" "$NC" "$*"; }
error()   { printf "%b[Webcoding] ERROR:%b %s\n" "$RED" "$NC" "$*" >&2; exit 1; }

# ── 工具函数 ──────────────────────────────────────────────────
# 从 package.json 内容中提取版本号
extract_version() {
  # 用 node 或 grep+sed 提取，兼容无 jq 环境
  if command -v node >/dev/null 2>&1; then
    node -e "var fs=require('fs');try{var p=JSON.parse(fs.readFileSync('$1','utf8'));process.stdout.write(p.version||'')}catch(e){}"
  else
    grep '"version"' "$1" | head -1 | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/'
  fi
}

# 比较版本号，若 $1 < $2 返回 0（有更新）
version_lt() {
  [ "$1" = "$2" ] && return 1
  local IFS=.
  # shellcheck disable=SC2206
  local a=($1) b=($2)
  for i in 0 1 2; do
    local ai=${a[$i]:-0} bi=${b[$i]:-0}
    [ "$ai" -lt "$bi" ] && return 0
    [ "$ai" -gt "$bi" ] && return 1
  done
  return 1
}

# 交互式 yes/no，$1=提示语 $2=默认(y/n)
ask_yn() {
  local prompt="$1" default="${2:-n}"
  local yn
  if [ "$default" = "y" ]; then
    printf "%b%s%b (Y/n) " "$BOLD" "$prompt" "$NC"
  else
    printf "%b%s%b (y/N) " "$BOLD" "$prompt" "$NC"
  fi
  read -r yn
  yn="${yn:-$default}"
  case $yn in [Yy]*) return 0;; *) return 1;; esac
}

# ── 卸载函数 ──────────────────────────────────────────────────
do_uninstall() {
  if [ ! -d "$INSTALL_DIR" ]; then
    error "未找到安装目录: $INSTALL_DIR，无法卸载。"
  fi

  warn "即将卸载 Webcoding:"
  warn "  安装目录 : $INSTALL_DIR"
  warn "  启动脚本 : $HOME/.local/bin/webcoding"
  echo ""

  if [ -t 0 ]; then
    ask_yn "确认卸载? 此操作不可撤销" "n" || { info "已取消卸载。"; exit 0; }
  fi

  # 终止运行中的 Webcoding 进程
  if [ -f "$INSTALL_DIR/sessions" ] || true; then
    PIDS=$(pgrep -f "node.*$INSTALL_DIR/server.js" 2>/dev/null || true)
    if [ -n "$PIDS" ]; then
      info "终止运行中的 Webcoding 进程 (PID: $PIDS)..."
      kill $PIDS 2>/dev/null || true
      sleep 1
    fi
  fi

  # 删除安装目录
  info "删除安装目录..."
  rm -rf "$INSTALL_DIR"

  # 删除启动脚本
  local launcher="$HOME/.local/bin/webcoding"
  if [ -f "$launcher" ]; then
    info "删除启动脚本 $launcher ..."
    rm -f "$launcher"
  fi

  # 清理 rc 文件中写入的 PATH 条目
  for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
    if [ -f "$rc" ] && grep -q '# Webcoding' "$rc" 2>/dev/null; then
      info "清理 $rc 中的 PATH 条目..."
      # 删除 '# Webcoding' 及其后一行
      sed -i.bak '/# Webcoding/{N;d;}' "$rc" && rm -f "${rc}.bak"
    fi
  done

  # 清理 fish
  local fish_conf="$HOME/.config/fish/conf.d/webcoding.fish"
  if [ -f "$fish_conf" ]; then
    info "删除 fish 配置 $fish_conf ..."
    rm -f "$fish_conf"
  fi

  echo ""
  success "================================================"
  success " Webcoding 已成功卸载！"
  success "================================================"
  exit 0
}

# 若传入 --uninstall 参数，直接执行卸载
[ "$UNINSTALL_MODE" = true ] && do_uninstall

# ── 检查依赖 ──────────────────────────────────────────────────
info "检查依赖环境..."

command -v git  >/dev/null 2>&1 || error "未找到 git。请先安装 git: https://git-scm.com/"
command -v node >/dev/null 2>&1 || error "未找到 Node.js。请先安装 Node.js >= 18: https://nodejs.org/"
command -v npm  >/dev/null 2>&1 || error "未找到 npm，请确认 Node.js 安装完整。"

# 检查 Node.js 版本 >= 18
NODE_MAJOR=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 18 ]; then
  error "Node.js 版本过低 (当前: $(node -v))，需要 >= 18。请升级: https://nodejs.org/"
fi

success "Node.js $(node -v)  npm $(npm -v)  git $(git --version | awk '{print $3}') — 全部就绪"

# ── 检测 AI CLI（非必须，至少需要一个）────────────────────────
HAS_CLAUDE=false; HAS_CODEX=false
command -v claude >/dev/null 2>&1 && HAS_CLAUDE=true
command -v codex  >/dev/null 2>&1 && HAS_CODEX=true
if [ "$HAS_CLAUDE" = true ] && [ "$HAS_CODEX" = true ]; then
  success "检测到 Claude CLI 和 Codex CLI"
elif [ "$HAS_CLAUDE" = true ]; then
  warn "仅检测到 Claude CLI（未找到 codex），Codex 功能将不可用"
elif [ "$HAS_CODEX" = true ]; then
  warn "仅检测到 Codex CLI（未找到 claude），Claude 功能将不可用"
else
  warn "未检测到 Claude CLI 或 Codex CLI"
  warn "请至少安装其中一个后再使用:"
  warn "  Claude CLI : https://docs.anthropic.com/en/docs/claude-code"
  warn "  Codex CLI  : https://github.com/openai/codex"
fi

# ── 安装 / 更新 ────────────────────────────────────────────────
IS_UPDATE=false

if [ -d "$INSTALL_DIR/.git" ]; then
  IS_UPDATE=true

  # 读取本地版本
  LOCAL_VER=""
  if [ -f "$INSTALL_DIR/package.json" ]; then
    LOCAL_VER=$(extract_version "$INSTALL_DIR/package.json")
  fi

  # 拉取远端版本（不依赖 jq，直接 curl raw package.json）
  REMOTE_VER=""
  if command -v curl >/dev/null 2>&1; then
    REMOTE_VER=$(curl -fsSL "$RAW_BASE/package.json" 2>/dev/null \
      | grep '"version"' | head -1 \
      | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
  elif command -v wget >/dev/null 2>&1; then
    REMOTE_VER=$(wget -qO- "$RAW_BASE/package.json" 2>/dev/null \
      | grep '"version"' | head -1 \
      | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
  fi

  echo ""
  printf "%b已检测到现有安装%b  目录: %s\n" "$BOLD" "$NC" "$INSTALL_DIR"
  if [ -n "$LOCAL_VER" ]; then
    printf "  本地版本 : %bv%s%b\n" "$CYAN" "$LOCAL_VER" "$NC"
  fi
  if [ -n "$REMOTE_VER" ]; then
    printf "  远端版本 : %bv%s%b\n" "$CYAN" "$REMOTE_VER" "$NC"
  fi
  echo ""

  # 判断是否有新版本
  NEEDS_UPDATE=false
  if [ -n "$LOCAL_VER" ] && [ -n "$REMOTE_VER" ]; then
    if version_lt "$LOCAL_VER" "$REMOTE_VER"; then
      NEEDS_UPDATE=true
      printf "%b发现新版本 v%s，当前为 v%s%b\n" "$GREEN" "$REMOTE_VER" "$LOCAL_VER" "$NC"
    else
      success "已是最新版本 (v$LOCAL_VER)"
    fi
  fi

  # 交互决策
  if [ -t 0 ]; then
    echo ""
    printf "%b请选择操作:%b\n" "$BOLD" "$NC"
    if [ "$NEEDS_UPDATE" = true ]; then
      echo "  1) 更新到最新版本 v$REMOTE_VER  [推荐]"
    else
      echo "  1) 强制重新拉取最新代码"
    fi
    echo "  2) 跳过更新，仅重新安装依赖"
    echo "  3) 跳过更新，直接启动"
    echo "  4) 退出"
    echo "  5) 卸载 Webcoding"
    echo ""
    printf "%b请输入选项 [1-5]:%b " "$BOLD" "$NC"
    read -r choice
    case "${choice:-1}" in
      1)
        info "拉取最新代码..."
        git -C "$INSTALL_DIR" fetch --depth=1 origin main
        git -C "$INSTALL_DIR" reset --hard origin/main
        ;;
      2)
        info "跳过代码更新，重新安装依赖..."
        ;;
      3)
        info "跳过更新，直接启动..."
        exec node "$INSTALL_DIR/server.js"
        ;;
      4)
        info "已退出。"
        exit 0
        ;;
      5)
        do_uninstall
        ;;
      *)
        warn "无效选项，跳过更新。"
        ;;
    esac
  else
    # 管道模式：有新版本则自动更新，否则跳过
    if [ "$NEEDS_UPDATE" = true ]; then
      warn "管道模式检测到新版本，自动更新..."
      git -C "$INSTALL_DIR" fetch --depth=1 origin main
      git -C "$INSTALL_DIR" reset --hard origin/main
    else
      warn "管道模式，版本已是最新，跳过更新。"
    fi
  fi

elif [ -d "$INSTALL_DIR" ]; then
  error "目录已存在但不是 git 仓库: $INSTALL_DIR — 请手动删除后重试: rm -rf $INSTALL_DIR"
else
  info "克隆仓库到 $INSTALL_DIR ..."
  git clone --depth 1 "$REPO" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

info "安装 Node.js 依赖..."
npm install --omit=dev

# ── 写入快捷启动脚本 ───────────────────────────────────────────
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
LAUNCHER="$BIN_DIR/webcoding"
cat > "$LAUNCHER" << LAUNCHER_EOF
#!/usr/bin/env bash
exec node "$INSTALL_DIR/server.js" "\$@"
LAUNCHER_EOF
chmod +x "$LAUNCHER"

# 确保 ~/.local/bin 在 PATH 里
add_to_path() {
  local rc="$1"
  if [ -f "$rc" ] && ! grep -q '.local/bin' "$rc" 2>/dev/null; then
    echo '' >> "$rc"
    echo '# Webcoding' >> "$rc"
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$rc"
    warn "已将 ~/.local/bin 写入 $rc，请重开终端或运行: source $rc"
  fi
}

SHELL_NAME=$(basename "${SHELL:-bash}")
case "$SHELL_NAME" in
  zsh)  add_to_path "$HOME/.zshrc" ;;
  bash) add_to_path "$HOME/.bashrc" ;;
  fish)
    mkdir -p "$HOME/.config/fish/conf.d"
    echo "fish_add_path $BIN_DIR" > "$HOME/.config/fish/conf.d/webcoding.fish"
    ;;
esac

# ── 完成提示 ───────────────────────────────────────────────────
echo ""
success "================================================"
if [ "$IS_UPDATE" = true ]; then
  success " Webcoding 更新完成！"
else
  success " Webcoding 安装完成！"
fi
success "================================================"
echo ""
echo "  启动命令 : webcoding"
echo "  或直接   : node $INSTALL_DIR/server.js"
echo "  访问地址 : http://localhost:8001"
echo ""
info "首次启动时会自动生成登录密码并打印在控制台。"
echo ""

# ── 询问是否立即启动 ───────────────────────────────────────────
if [ -t 0 ]; then
  if ask_yn "现在立即启动 Webcoding?" "y"; then
    exec node "$INSTALL_DIR/server.js"
  else
    info "安装完成，稍后运行 'webcoding' 启动。"
  fi
else
  info "通过管道运行，跳过交互。稍后运行 'webcoding' 启动。"
fi
