#!/usr/bin/env bash
# Webcoding 一键安装脚本 (Linux / macOS)
# 用法:
#   curl -fsSL https://raw.githubusercontent.com/HsMirage/webcoding/main/install.sh | bash
# 或指定安装目录:
#   curl -fsSL https://raw.githubusercontent.com/HsMirage/webcoding/main/install.sh | bash -s -- ~/mydir

set -e

REPO="https://github.com/HsMirage/webcoding.git"
RAW_BASE="https://raw.githubusercontent.com/HsMirage/webcoding/main"
INSTALL_DIR="${1:-$HOME/webcoding}"

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
extract_version() {
  if command -v node >/dev/null 2>&1; then
    node -e "var fs=require('fs');try{var p=JSON.parse(fs.readFileSync('$1','utf8'));process.stdout.write(p.version||'')}catch(e){}"
  else
    grep '"version"' "$1" | head -1 | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/'
  fi
}

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
  ask_yn "确认卸载? 此操作不可撤销" "n" || { info "已取消卸载。"; exit 0; }
  PIDS=$(pgrep -f "node.*$INSTALL_DIR/server.js" 2>/dev/null || true)
  if [ -n "$PIDS" ]; then
    info "终止运行中的 Webcoding 进程 (PID: $PIDS)..."
    kill $PIDS 2>/dev/null || true
    sleep 1
  fi
  info "删除安装目录..."
  rm -rf "$INSTALL_DIR"
  local launcher="$HOME/.local/bin/webcoding"
  [ -f "$launcher" ] && { info "删除启动脚本..."; rm -f "$launcher"; }
  for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
    if [ -f "$rc" ] && grep -q '# Webcoding' "$rc" 2>/dev/null; then
      info "清理 $rc 中的 PATH 条目..."
      sed -i.bak '/# Webcoding/{N;d;}' "$rc" && rm -f "${rc}.bak"
    fi
  done
  local fish_conf="$HOME/.config/fish/conf.d/webcoding.fish"
  [ -f "$fish_conf" ] && { info "删除 fish 配置..."; rm -f "$fish_conf"; }
  echo ""
  success "================================================"
  success " Webcoding 已成功卸载！"
  success "================================================"
  exit 0
}

# ── 检查依赖 ──────────────────────────────────────────────────
info "检查依赖环境..."
command -v git  >/dev/null 2>&1 || error "未找到 git。请先安装 git: https://git-scm.com/"
command -v node >/dev/null 2>&1 || error "未找到 Node.js。请先安装 Node.js >= 18: https://nodejs.org/"
command -v npm  >/dev/null 2>&1 || error "未找到 npm，请确认 Node.js 安装完整。"
NODE_MAJOR=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 18 ]; then
  error "Node.js 版本过低 (当前: $(node -v))，需要 >= 18。请升级: https://nodejs.org/"
fi
success "Node.js $(node -v)  npm $(npm -v)  git $(git --version | awk '{print $3}') — 全部就绪"

# ── 检测 AI CLI ────────────────────────────────────────────────
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

# ── 获取版本信息 ───────────────────────────────────────────────
LOCAL_VER=""
REMOTE_VER=""
IS_INSTALLED=false

if [ -d "$INSTALL_DIR/.git" ] && [ -f "$INSTALL_DIR/package.json" ]; then
  IS_INSTALLED=true
  LOCAL_VER=$(extract_version "$INSTALL_DIR/package.json")
fi

if command -v curl >/dev/null 2>&1; then
  REMOTE_VER=$(curl -fsSL "$RAW_BASE/package.json" 2>/dev/null \
    | grep '"version"' | head -1 \
    | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/') || true
elif command -v wget >/dev/null 2>&1; then
  REMOTE_VER=$(wget -qO- "$RAW_BASE/package.json" 2>/dev/null \
    | grep '"version"' | head -1 \
    | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/') || true
fi

# ── 显示状态 ───────────────────────────────────────────────────
echo ""
if [ "$IS_INSTALLED" = true ]; then
  printf "  已安装目录 : %s\n" "$INSTALL_DIR"
  [ -n "$LOCAL_VER" ]  && printf "  本地版本   : %bv%s%b\n" "$CYAN" "$LOCAL_VER" "$NC"
else
  printf "  安装目录   : %s（尚未安装）\n" "$INSTALL_DIR"
fi
[ -n "$REMOTE_VER" ] && printf "  最新版本   : %bv%s%b\n" "$CYAN" "$REMOTE_VER" "$NC"
echo ""

# ── 交互菜单（管道模式下直接安装）────────────────────────────
if [ ! -t 0 ]; then
  # 管道模式：执行安装或更新
  if [ "$IS_INSTALLED" = true ]; then
    if [ -n "$LOCAL_VER" ] && [ -n "$REMOTE_VER" ] && version_lt "$LOCAL_VER" "$REMOTE_VER"; then
      warn "管道模式检测到新版本 v$REMOTE_VER，自动更新..."
      git -C "$INSTALL_DIR" fetch --depth=1 origin main
      git -C "$INSTALL_DIR" reset --hard origin/main
    else
      warn "管道模式，版本已是最新，跳过更新。"
    fi
  else
    info "管道模式，开始安装..."
    git clone --depth 1 "$REPO" "$INSTALL_DIR"
  fi
else
  # TTY 模式：显示菜单
  UPDATE_LABEL="更新到最新版"
  [ -n "$REMOTE_VER" ] && UPDATE_LABEL="更新到最新版 v$REMOTE_VER"
  [ -n "$LOCAL_VER" ] && [ -n "$REMOTE_VER" ] && ! version_lt "$LOCAL_VER" "$REMOTE_VER" \
    && UPDATE_LABEL="重新拉取最新代码（已是最新版）"

  printf "%b请选择操作:%b\n" "$BOLD" "$NC"
  echo "  1) 安装"
  echo "  2) 启动"
  echo "  3) $UPDATE_LABEL"
  echo "  4) 安装依赖"
  echo "  5) 卸载 Webcoding"
  echo "  6) 退出"
  echo ""
  printf "%b请输入选项 [1-6]:%b " "$BOLD" "$NC"
  read -r choice

  case "${choice:-1}" in
    1)
      if [ "$IS_INSTALLED" = true ]; then
        warn "已安装，如需重装请先卸载（选项 5）或删除目录: rm -rf $INSTALL_DIR"
        exit 0
      fi
      info "克隆仓库到 $INSTALL_DIR ..."
      git clone --depth 1 "$REPO" "$INSTALL_DIR"
      ;;
    2)
      if [ ! -f "$INSTALL_DIR/server.js" ]; then
        error "未找到 server.js，请先安装（选项 1）。"
      fi
      info "启动 Webcoding..."
      mkdir -p "$INSTALL_DIR/logs"
      nohup node "$INSTALL_DIR/server.js" >> "$INSTALL_DIR/logs/server.log" 2>&1 &
      success "Webcoding 已在后台启动 (PID: $!)，访问 http://localhost:${PORT:-8001}"
      info "停止服务: kill $!"
      exit 0
      ;;
    3)
      if [ ! -d "$INSTALL_DIR/.git" ]; then
        error "未找到安装目录，请先安装（选项 1）。"
      fi
      info "拉取最新代码..."
      git -C "$INSTALL_DIR" fetch --depth=1 origin main
      git -C "$INSTALL_DIR" reset --hard origin/main
      ;;
    4)
      if [ ! -d "$INSTALL_DIR" ]; then
        error "未找到安装目录，请先安装（选项 1）。"
      fi
      info "安装 Node.js 依赖..."
      cd "$INSTALL_DIR" && npm install --omit=dev
      success "依赖安装完成。"
      exit 0
      ;;
    5)
      do_uninstall
      ;;
    6)
      info "已退出。"
      exit 0
      ;;
    *)
      warn "无效选项，退出。"
      exit 1
      ;;
  esac
fi

# 选项 1/3 后继续：安装依赖 + 写入 launcher
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
if [ "$IS_INSTALLED" = true ]; then
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

if ask_yn "现在立即启动 Webcoding?" "y"; then
  # 检测端口是否已被占用
  _PORT="${PORT:-8001}"
  _OCCUPIED_PID=""
  if command -v lsof >/dev/null 2>&1; then
    _OCCUPIED_PID=$(lsof -ti tcp:"$_PORT" 2>/dev/null | head -1 || true)
  elif command -v ss >/dev/null 2>&1; then
    _OCCUPIED_PID=$(ss -tlnp 2>/dev/null | awk -v p=":$_PORT" '$4 ~ p {match($0,/pid=([0-9]+)/,a); print a[1]; exit}' || true)
  fi
  if [ -n "$_OCCUPIED_PID" ]; then
    # 判断占用进程是否是 Webcoding 自身
    _OCCUPIED_CMD=$(ps -p "$_OCCUPIED_PID" -o args= 2>/dev/null || true)
    if echo "$_OCCUPIED_CMD" | grep -q "server.js"; then
      warn "Webcoding 已在运行 (PID: $_OCCUPIED_PID，端口 $_PORT)。"
      if ask_yn "是否重启 Webcoding?" "y"; then
        kill "$_OCCUPIED_PID" 2>/dev/null || true
        sleep 1
        mkdir -p "$INSTALL_DIR/logs"
        nohup node "$INSTALL_DIR/server.js" >> "$INSTALL_DIR/logs/server.log" 2>&1 &
        success "Webcoding 已在后台启动 (PID: $!)，访问 http://localhost:$_PORT"
      else
        info "已跳过启动，现有实例继续运行。"
      fi
    else
      warn "端口 $_PORT 已被其他进程占用 (PID: $_OCCUPIED_PID)，无法启动。"
      info "请先释放端口，或使用其他端口: PORT=<端口号> node $INSTALL_DIR/server.js"
    fi
  else
    mkdir -p "$INSTALL_DIR/logs"
    nohup node "$INSTALL_DIR/server.js" >> "$INSTALL_DIR/logs/server.log" 2>&1 &
    success "Webcoding 已在后台启动 (PID: $!)，访问 http://localhost:$_PORT"
    info "停止服务: kill $!"
  fi
else
  info "稍后运行 'webcoding' 启动。"
fi
