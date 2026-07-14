#!/usr/bin/env bash
# Webcoding 一键安装与服务管理脚本 (Linux / macOS)
#
# 交互安装：
#   bash <(curl -fsSL https://raw.githubusercontent.com/HsMirage/webcoding/main/install.sh)
# 指定安装目录：
#   bash <(curl -fsSL https://raw.githubusercontent.com/HsMirage/webcoding/main/install.sh) ~/my-webcoding
# 非交互安装：
#   curl -fsSL https://raw.githubusercontent.com/HsMirage/webcoding/main/install.sh | bash -s -- ~/my-webcoding

set -e

REPO="https://github.com/HsMirage/webcoding.git"
RAW_BASE="https://raw.githubusercontent.com/HsMirage/webcoding/main"
DEFAULT_INSTALL_DIR="$HOME/webcoding"

# ── 颜色与输出 ────────────────────────────────────────────────
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

ask_yn() {
  local prompt="$1" default="${2:-n}" yn=""
  if [ ! -t 0 ]; then
    [ "$default" = "y" ]
    return
  fi
  if [ "$default" = "y" ]; then
    printf "%b%s%b (Y/n) " "$BOLD" "$prompt" "$NC"
  else
    printf "%b%s%b (y/N) " "$BOLD" "$prompt" "$NC"
  fi
  read -r yn || yn=""
  yn="${yn:-$default}"
  case "$yn" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

expand_user_path() {
  local value="$1"
  case "$value" in
    "~") printf '%s\n' "$HOME" ;;
    \~/*) printf '%s/%s\n' "$HOME" "${value#\~/}" ;;
    *) printf '%s\n' "$value" ;;
  esac
}

REQUESTED_DIR="${1:-${WEBCODING_DIR:-}}"
if [ -z "$REQUESTED_DIR" ] && [ -t 0 ]; then
  printf "%b安装/运行目录%b [%s]: " "$BOLD" "$NC" "$DEFAULT_INSTALL_DIR"
  read -r REQUESTED_DIR || REQUESTED_DIR=""
fi
INSTALL_DIR=$(expand_user_path "${REQUESTED_DIR:-$DEFAULT_INSTALL_DIR}")
case "$INSTALL_DIR" in
  /*) ;;
  *) INSTALL_DIR="$(pwd)/$INSTALL_DIR" ;;
esac
INSTALL_DIR="${INSTALL_DIR%/}"
if [ -z "$INSTALL_DIR" ] || [ "$INSTALL_DIR" = "/" ]; then
  error "安装目录不能是文件系统根目录。"
fi

BIN_DIR="$HOME/.local/bin"
LAUNCHER="$BIN_DIR/webcoding"
RUNNER="$INSTALL_DIR/.webcoding-service.sh"
SERVICE_KIND_FILE="$INSTALL_DIR/.webcoding-service-kind"
SYSTEMD_UNIT="$HOME/.config/systemd/user/webcoding.service"
MAC_PLIST="$HOME/Library/LaunchAgents/com.webcoding.server.plist"
SERVICE_LABEL="com.webcoding.server"
NODE_BIN=""
SERVICE_KIND=""

# ── 通用工具 ──────────────────────────────────────────────────
extract_version() {
  if command -v node >/dev/null 2>&1; then
    node -e 'const fs=require("fs");try{const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(p.version||"")}catch{}' "$1"
  else
    grep '"version"' "$1" | head -1 | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/'
  fi
}

version_lt() {
  [ "$1" = "$2" ] && return 1
  local IFS=.
  # shellcheck disable=SC2206
  local a=($1) b=($2) i ai bi
  for i in 0 1 2; do
    ai=${a[$i]:-0}
    bi=${b[$i]:-0}
    [ "$ai" -lt "$bi" ] && return 0
    [ "$ai" -gt "$bi" ] && return 1
  done
  return 1
}

xml_escape() {
  local value="$1"
  value=${value//&/&amp;}
  value=${value//</&lt;}
  value=${value//>/&gt;}
  value=${value//\"/&quot;}
  value=${value//\'/&apos;}
  printf '%s' "$value"
}

check_dependencies() {
  info "检查依赖环境..."
  command -v git  >/dev/null 2>&1 || error "未找到 git。请先安装 git: https://git-scm.com/"
  command -v node >/dev/null 2>&1 || error "未找到 Node.js。请先安装 Node.js >= 22: https://nodejs.org/"
  command -v npm  >/dev/null 2>&1 || error "未找到 npm，请确认 Node.js 安装完整。"
  local node_major
  node_major=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
  [ "$node_major" -ge 22 ] || error "Node.js 版本过低 (当前: $(node -v))，需要 >= 22。请升级: https://nodejs.org/"
  NODE_BIN=$(command -v node)
  success "Node.js $(node -v)  npm $(npm -v)  git $(git --version | awk '{print $3}') — 全部就绪"
}

detect_agent_clis() {
  local found=()
  command -v claude >/dev/null 2>&1 && found+=(Claude)
  command -v codex  >/dev/null 2>&1 && found+=(Codex)
  command -v pi     >/dev/null 2>&1 && found+=(Pi)
  if [ "${#found[@]}" -gt 0 ]; then
    success "检测到 Agent CLI: ${found[*]}"
  else
    warn "未检测到 Claude、Codex 或 Pi CLI；安装完成后请至少配置其中一个。"
  fi
}

build_service_path() {
  local dirs=() command_name resolved candidate joined=""
  for command_name in node npm git claude codex pi; do
    resolved=$(command -v "$command_name" 2>/dev/null || true)
    [ -z "$resolved" ] || dirs+=("$(dirname "$resolved")")
  done
  dirs+=("$HOME/.local/bin" "$HOME/.volta/bin" "/opt/homebrew/bin" "/usr/local/bin" "/usr/bin" "/bin" "/usr/sbin" "/sbin")
  for candidate in "${dirs[@]}"; do
    [ -n "$candidate" ] || continue
    case ":$joined:" in
      *":$candidate:"*) ;;
      *) if [ -n "$joined" ]; then joined="$joined:$candidate"; else joined="$candidate"; fi ;;
    esac
  done
  printf '%s\n' "$joined"
}

configured_port() {
  if [ -n "${PORT:-}" ]; then
    printf '%s\n' "$PORT"
    return
  fi
  if [ -f "$INSTALL_DIR/.env" ]; then
    local value
    value=$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*//p' "$INSTALL_DIR/.env" | tail -1 | sed 's/[[:space:]]*#.*$//' | tr -d '\"\047[:space:]')
    [ -n "$value" ] && { printf '%s\n' "$value"; return; }
  fi
  printf '8001\n'
}

listener_pid() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null | head -1 || true
  elif command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | sed -n "/:${port}[[:space:]]/s/.*pid=\([0-9][0-9]*\).*/\1/p" | head -1 || true
  fi
}

ensure_port_available() {
  local port pid command_line
  port=$(configured_port)
  pid=$(listener_pid "$port")
  [ -z "$pid" ] && return 0
  command_line=$(ps -p "$pid" -o args= 2>/dev/null || true)
  case "$command_line" in
    *"$INSTALL_DIR/server.js"*) return 0 ;;
  esac
  if [ "$SERVICE_KIND" = "systemd" ] && systemctl --user is-active --quiet webcoding.service 2>/dev/null; then
    return 0
  fi
  if [ "$SERVICE_KIND" = "launchd" ] && launchctl print "gui/$(id -u)/$SERVICE_LABEL" >/dev/null 2>&1; then
    return 0
  fi
  warn "端口 $port 已被其他进程占用 (PID: $pid)。"
  info "请先释放端口，或在 $INSTALL_DIR/.env 中设置其他 PORT。"
  return 1
}

# ── 服务文件与控制器 ──────────────────────────────────────────
write_service_runner() {
  mkdir -p "$INSTALL_DIR/logs"
  touch "$INSTALL_DIR/logs/server.log" "$INSTALL_DIR/logs/server.err.log"
  local install_q node_q server_q log_q err_q
  printf -v install_q '%q' "$INSTALL_DIR"
  printf -v node_q '%q' "$NODE_BIN"
  printf -v server_q '%q' "$INSTALL_DIR/server.js"
  printf -v log_q '%q' "$INSTALL_DIR/logs/server.log"
  printf -v err_q '%q' "$INSTALL_DIR/logs/server.err.log"
  cat > "$RUNNER" <<RUNNER_EOF
#!/usr/bin/env bash
set -e
cd $install_q
mkdir -p $install_q/logs
exec $node_q $server_q >> $log_q 2>> $err_q
RUNNER_EOF
  chmod +x "$RUNNER"
}

write_systemd_unit() {
  mkdir -p "$(dirname "$SYSTEMD_UNIT")"
  local runner_escaped working_escaped path_value path_escaped
  runner_escaped=${RUNNER//\\/\\\\}
  runner_escaped=${runner_escaped//\"/\\\"}
  runner_escaped=${runner_escaped//%/%%}
  working_escaped=${INSTALL_DIR//\\/\\\\}
  working_escaped=${working_escaped//\"/\\\"}
  working_escaped=${working_escaped//%/%%}
  path_value=$(build_service_path)
  path_escaped=${path_value//\\/\\\\}
  path_escaped=${path_escaped//\"/\\\"}
  path_escaped=${path_escaped//%/%%}
  cat > "$SYSTEMD_UNIT" <<UNIT_EOF
[Unit]
Description=Webcoding browser workspace
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory="$working_escaped"
ExecStart="$runner_escaped"
Restart=on-failure
RestartSec=5
KillMode=control-group
Environment="PATH=$path_escaped"

[Install]
WantedBy=default.target
UNIT_EOF
}

write_launch_agent() {
  mkdir -p "$(dirname "$MAC_PLIST")"
  local runner_xml dir_xml out_xml err_xml path_xml
  runner_xml=$(xml_escape "$RUNNER")
  dir_xml=$(xml_escape "$INSTALL_DIR")
  out_xml=$(xml_escape "$INSTALL_DIR/logs/server.log")
  err_xml=$(xml_escape "$INSTALL_DIR/logs/server.err.log")
  path_xml=$(xml_escape "$(build_service_path)")
  cat > "$MAC_PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$SERVICE_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$runner_xml</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$dir_xml</string>
    <key>StandardOutPath</key>
    <string>$out_xml</string>
    <key>StandardErrorPath</key>
    <string>$err_xml</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$path_xml</string>
    </dict>
</dict>
</plist>
PLIST_EOF
}

write_launcher() {
  mkdir -p "$BIN_DIR"
  local install_q node_q runner_q kind_q unit_q plist_q label_q pid_q log_q err_q
  printf -v install_q '%q' "$INSTALL_DIR"
  printf -v node_q '%q' "$NODE_BIN"
  printf -v runner_q '%q' "$RUNNER"
  printf -v kind_q '%q' "$SERVICE_KIND"
  printf -v unit_q '%q' "$SYSTEMD_UNIT"
  printf -v plist_q '%q' "$MAC_PLIST"
  printf -v label_q '%q' "$SERVICE_LABEL"
  printf -v pid_q '%q' "$INSTALL_DIR/logs/server.pid"
  printf -v log_q '%q' "$INSTALL_DIR/logs/server.log"
  printf -v err_q '%q' "$INSTALL_DIR/logs/server.err.log"
  cat > "$LAUNCHER" <<LAUNCHER_EOF
#!/usr/bin/env bash
set -e
INSTALL_DIR=$install_q
NODE_BIN=$node_q
RUNNER=$runner_q
SERVICE_KIND=$kind_q
SYSTEMD_UNIT=$unit_q
MAC_PLIST=$plist_q
SERVICE_LABEL=$label_q
PID_FILE=$pid_q
LOG_FILE=$log_q
ERR_FILE=$err_q

fallback_running() {
  [ -f "\$PID_FILE" ] || return 1
  local pid command_line
  pid=\$(cat "\$PID_FILE" 2>/dev/null || true)
  [ -n "\$pid" ] && kill -0 "\$pid" 2>/dev/null || return 1
  command_line=\$(ps -p "\$pid" -o args= 2>/dev/null || true)
  case "\$command_line" in
    *"\$RUNNER"*|*"\$INSTALL_DIR/server.js"*) return 0 ;;
    *) return 1 ;;
  esac
}

fallback_start() {
  mkdir -p "\$INSTALL_DIR/logs"
  if fallback_running; then
    printf 'Webcoding 已在运行 (PID: %s)\n' "\$(cat "\$PID_FILE")"
    return
  fi
  nohup "\$RUNNER" </dev/null >/dev/null 2>&1 &
  printf '%s\n' "\$!" > "\$PID_FILE"
  printf 'Webcoding 已启动 (PID: %s)\n' "\$!"
}

fallback_stop() {
  if ! fallback_running; then
    rm -f "\$PID_FILE"
    printf 'Webcoding 当前未运行。\n'
    return
  fi
  local pid
  pid=\$(cat "\$PID_FILE")
  kill "\$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "\$pid" 2>/dev/null || break
    sleep 0.1
  done
  kill -9 "\$pid" 2>/dev/null || true
  rm -f "\$PID_FILE"
  printf 'Webcoding 已停止。\n'
}

command="\${1:-start}"
case "\$SERVICE_KIND:\$command" in
  systemd:start)
    systemctl --user daemon-reload
    systemctl --user enable webcoding.service >/dev/null
    systemctl --user restart webcoding.service
    ;;
  systemd:restart)
    systemctl --user daemon-reload
    systemctl --user enable webcoding.service >/dev/null
    systemctl --user restart webcoding.service
    ;;
  systemd:stop) systemctl --user stop webcoding.service 2>/dev/null || true ;;
  systemd:status) systemctl --user status webcoding.service --no-pager ;;
  launchd:start|launchd:restart)
    domain="gui/\$(id -u)"
    target="\$domain/\$SERVICE_LABEL"
    launchctl bootout "\$target" >/dev/null 2>&1 || launchctl unload "\$MAC_PLIST" >/dev/null 2>&1 || true
    launchctl bootstrap "\$domain" "\$MAC_PLIST" 2>/dev/null || launchctl load -w "\$MAC_PLIST"
    launchctl kickstart -k "\$target" 2>/dev/null || true
    ;;
  launchd:stop)
    domain="gui/\$(id -u)"
    launchctl bootout "\$domain/\$SERVICE_LABEL" 2>/dev/null || launchctl unload "\$MAC_PLIST" 2>/dev/null || true
    ;;
  launchd:status)
    launchctl print "gui/\$(id -u)/\$SERVICE_LABEL"
    ;;
  nohup:start) fallback_start ;;
  nohup:restart) fallback_stop; fallback_start ;;
  nohup:stop) fallback_stop ;;
  nohup:status)
    if fallback_running; then
      printf 'Webcoding 正在运行 (PID: %s)\n' "\$(cat "\$PID_FILE")"
    else
      printf 'Webcoding 当前未运行。\n'
      exit 1
    fi
    ;;
  *:logs) tail -n 100 -f "\$LOG_FILE" "\$ERR_FILE" ;;
  *:foreground) cd "\$INSTALL_DIR"; exec "\$NODE_BIN" "\$INSTALL_DIR/server.js" ;;
  *)
    printf '用法: webcoding {start|restart|stop|status|logs|foreground}\n' >&2
    exit 2
    ;;
esac
LAUNCHER_EOF
  chmod +x "$LAUNCHER"
}

prepare_service() {
  [ -f "$INSTALL_DIR/server.js" ] || error "未找到 $INSTALL_DIR/server.js，请先安装。"
  NODE_BIN=${NODE_BIN:-$(command -v node)}
  write_service_runner

  case "$(uname -s 2>/dev/null || true)" in
    Darwin)
      SERVICE_KIND="launchd"
      write_launch_agent
      ;;
    Linux)
      SERVICE_KIND="nohup"
      if command -v systemctl >/dev/null 2>&1; then
        write_systemd_unit
        if systemctl --user daemon-reload >/dev/null 2>&1; then
          SERVICE_KIND="systemd"
        else
          warn "当前会话无法使用用户级 systemd，已回退到 nohup 后台运行。"
        fi
      fi
      ;;
    *) SERVICE_KIND="nohup" ;;
  esac

  printf '%s\n' "$SERVICE_KIND" > "$SERVICE_KIND_FILE"
  write_launcher
}

show_initial_password() {
  local log_file="$INSTALL_DIR/logs/server.log" auth_file="$INSTALL_DIR/config/auth.json" initial=""
  [ -f "$log_file" ] || return 0
  if [ -f "$auth_file" ] && ! node -e 'const fs=require("fs");try{const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.exit(v.mustChange===true?0:1)}catch{process.exit(0)}' "$auth_file"; then
    return 0
  fi
  initial=$(grep '自动生成初始密码' "$log_file" 2>/dev/null | tail -1 | sed 's/.*自动生成初始密码:[[:space:]]*//' || true)
  [ -n "$initial" ] || return 0
  printf '\n'
  success "================================================"
  success "  初始登录密码: $initial"
  success "  首次登录后将要求修改密码"
  success "================================================"
  printf '\n'
}

start_webcoding() {
  local action="${1:-start}" port
  prepare_service
  ensure_port_available || return 1
  "$LAUNCHER" "$action"
  port=$(configured_port)
  sleep 2
  if ! "$LAUNCHER" status >/dev/null 2>&1; then
    error "后台服务未能保持运行，请查看 $INSTALL_DIR/logs/server.err.log。"
  fi
  success "Webcoding 已由 $SERVICE_KIND 持久化运行，关闭终端不会停止。"
  success "访问地址: http://localhost:$port"
  info "管理命令: webcoding status | webcoding restart | webcoding stop | webcoding logs"
  show_initial_password
}

stop_installed_service() {
  if [ -x "$LAUNCHER" ]; then
    "$LAUNCHER" stop >/dev/null 2>&1 || true
  fi
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now webcoding.service >/dev/null 2>&1 || true
    rm -f "$SYSTEMD_UNIT"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
  if command -v launchctl >/dev/null 2>&1; then
    launchctl bootout "gui/$(id -u)/$SERVICE_LABEL" >/dev/null 2>&1 || launchctl unload "$MAC_PLIST" >/dev/null 2>&1 || true
    rm -f "$MAC_PLIST"
  fi
  local pid
  pid=$(ps -eo pid=,args= 2>/dev/null | awk -v target="$INSTALL_DIR/server.js" 'index($0,target){print $1; exit}' || true)
  [ -z "$pid" ] || kill "$pid" 2>/dev/null || true
  rm -f "$INSTALL_DIR/logs/server.pid" "$RUNNER" "$SERVICE_KIND_FILE"
}

add_to_path() {
  local rc="$1"
  if [ -f "$rc" ] && ! grep -q '.local/bin' "$rc" 2>/dev/null; then
    # shellcheck disable=SC2016
    printf '\n# Webcoding\n%s\n' 'export PATH="$HOME/.local/bin:$PATH"' >> "$rc"
    warn "已将 ~/.local/bin 写入 $rc，请重开终端或运行: source $rc"
  fi
}

install_launcher_path() {
  local shell_name
  shell_name=$(basename "${SHELL:-bash}")
  case "$shell_name" in
    zsh) add_to_path "$HOME/.zshrc" ;;
    bash) add_to_path "$HOME/.bashrc" ;;
    fish)
      mkdir -p "$HOME/.config/fish/conf.d"
      printf 'fish_add_path %s\n' "$BIN_DIR" > "$HOME/.config/fish/conf.d/webcoding.fish"
      ;;
  esac
}

do_uninstall() {
  [ -d "$INSTALL_DIR" ] || error "未找到安装目录: $INSTALL_DIR，无法卸载。"
  warn "即将卸载 Webcoding:"
  warn "  安装目录 : $INSTALL_DIR"
  warn "  服务配置 : $SYSTEMD_UNIT 或 $MAC_PLIST"
  ask_yn "确认卸载? 此操作不可撤销" "n" || { info "已取消卸载。"; exit 0; }
  info "停止并移除后台服务..."
  stop_installed_service
  rm -rf "$INSTALL_DIR"
  rm -f "$LAUNCHER"
  for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
    if [ -f "$rc" ] && grep -q '# Webcoding' "$rc" 2>/dev/null; then
      sed -i.bak '/# Webcoding/{N;d;}' "$rc" && rm -f "${rc}.bak"
    fi
  done
  rm -f "$HOME/.config/fish/conf.d/webcoding.fish"
  success "Webcoding 已成功卸载。"
  exit 0
}

# ── 安装状态与菜单 ────────────────────────────────────────────
LOCAL_VER=""
REMOTE_VER=""
IS_INSTALLED=false
if [ -d "$INSTALL_DIR/.git" ] && [ -f "$INSTALL_DIR/package.json" ]; then
  IS_INSTALLED=true
  LOCAL_VER=$(extract_version "$INSTALL_DIR/package.json")
fi

if command -v curl >/dev/null 2>&1; then
  REMOTE_VER=$(curl -fsSL "$RAW_BASE/package.json" 2>/dev/null | grep '"version"' | head -1 | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
elif command -v wget >/dev/null 2>&1; then
  REMOTE_VER=$(wget -qO- "$RAW_BASE/package.json" 2>/dev/null | grep '"version"' | head -1 | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
fi

printf '\n'
if [ "$IS_INSTALLED" = true ]; then
  printf '  已安装目录 : %s\n' "$INSTALL_DIR"
  [ -n "$LOCAL_VER" ] && printf '  本地版本   : %bv%s%b\n' "$CYAN" "$LOCAL_VER" "$NC"
else
  printf '  安装目录   : %s（尚未安装）\n' "$INSTALL_DIR"
fi
[ -n "$REMOTE_VER" ] && printf '  最新版本   : %bv%s%b\n' "$CYAN" "$REMOTE_VER" "$NC"
printf '\n'

ACTION=""
AUTO_START=false
START_ACTION="start"

if [ ! -t 0 ]; then
  AUTO_START=true
  if [ "$IS_INSTALLED" = true ]; then ACTION="update"; START_ACTION="restart"; else ACTION="install"; fi
else
  UPDATE_LABEL="更新到最新版"
  [ -n "$REMOTE_VER" ] && UPDATE_LABEL="更新到最新版 v$REMOTE_VER"
  [ -n "$LOCAL_VER" ] && [ -n "$REMOTE_VER" ] && ! version_lt "$LOCAL_VER" "$REMOTE_VER" && UPDATE_LABEL="重新拉取最新代码（已是最新版）"
  printf "%b请选择操作:%b\n" "$BOLD" "$NC"
  printf '  1) 安装\n'
  printf '  2) 启动或重启后台服务\n'
  printf '  3) %s\n' "$UPDATE_LABEL"
  printf '  4) 重装依赖\n'
  printf '  5) 停止后台服务\n'
  printf '  6) 查看服务状态\n'
  printf '  7) 卸载 Webcoding\n'
  printf '  8) 退出\n\n'
  printf "%b请输入选项 [1-8]:%b " "$BOLD" "$NC"
  read -r choice
  case "${choice:-1}" in
    1) ACTION="install" ;;
    2) ACTION="start"; START_ACTION="restart" ;;
    3) ACTION="update"; START_ACTION="restart" ;;
    4) ACTION="deps" ;;
    5) ACTION="stop" ;;
    6) ACTION="status" ;;
    7) do_uninstall ;;
    8) info "已退出。"; exit 0 ;;
    *) error "无效选项。" ;;
  esac
fi

case "$ACTION" in
  stop)
    stop_installed_service
    success "Webcoding 后台服务已停止。"
    exit 0
    ;;
  status)
    if [ -x "$LAUNCHER" ]; then "$LAUNCHER" status || true; else warn "尚未生成服务配置，请先安装或启动。"; fi
    info "日志目录: $INSTALL_DIR/logs"
    exit 0
    ;;
esac

check_dependencies
detect_agent_clis

case "$ACTION" in
  install)
    [ "$IS_INSTALLED" = false ] || error "已安装。如需覆盖，请选择更新或先卸载。"
    info "克隆仓库到 $INSTALL_DIR ..."
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone --depth 1 "$REPO" "$INSTALL_DIR"
    ;;
  update)
    [ -d "$INSTALL_DIR/.git" ] || error "未找到安装目录，请先安装。"
    if [ -n "$LOCAL_VER" ] && [ -n "$REMOTE_VER" ] && ! version_lt "$LOCAL_VER" "$REMOTE_VER"; then
      warn "当前已是最新版，仍会校准代码、依赖和服务配置。"
    fi
    info "拉取最新代码..."
    git -C "$INSTALL_DIR" fetch --depth=1 origin main
    git -C "$INSTALL_DIR" reset --hard origin/main
    ;;
  deps)
    [ -f "$INSTALL_DIR/package.json" ] || error "未找到安装目录，请先安装。"
    ;;
  start)
    [ -f "$INSTALL_DIR/server.js" ] || error "未找到 server.js，请先安装。"
    start_webcoding "$START_ACTION"
    exit 0
    ;;
esac

info "安装 Node.js 依赖..."
(cd "$INSTALL_DIR" && npm install --omit=dev)
prepare_service
install_launcher_path

printf '\n'
success "================================================"
if [ "$ACTION" = "install" ]; then
  success " Webcoding 安装完成！"
elif [ "$ACTION" = "deps" ]; then
  success " Webcoding 依赖与服务配置完成！"
else
  success " Webcoding 更新完成！"
fi
success "================================================"
printf '\n'
printf '  安装目录 : %s\n' "$INSTALL_DIR"
printf '  管理命令 : webcoding start | restart | stop | status | logs\n'
printf '  前台调试 : webcoding foreground\n'
printf '  访问地址 : http://localhost:%s\n\n' "$(configured_port)"

if [ "$AUTO_START" = true ] || ask_yn "现在立即启动持久化后台服务?" "y"; then
  start_webcoding "$START_ACTION"
else
  info "稍后运行 'webcoding start' 即可启动。"
fi
