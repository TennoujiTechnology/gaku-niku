#!/bin/zsh
set -e

PROJECT_DIR="${0:A:h}"
cd "$PROJECT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js。请先安装 Node.js 22.13 或更新版本。"
  echo "按回车关闭窗口。"
  read -r
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 22 )); then
  echo "当前 Node.js 版本过旧：$(node --version)"
  echo "请升级到 Node.js 22.13 或更新版本。"
  echo "按回车关闭窗口。"
  read -r
  exit 1
fi

echo "正在启动自学型熟肉机…"
echo "浏览器关闭后，本窗口仍负责本地 Agent 任务；按 Control-C 可停止。"
( sleep 1; if open -Ra "Google Chrome"; then open -a "Google Chrome" "http://127.0.0.1:43127"; else open "http://127.0.0.1:43127"; fi ) &
exec node local-agent-bridge/server.mjs
