# Gaku-Niku：AI Agent 环境配置指南

这份文档写给负责安装和启动 Gaku-Niku 的 AI Agent。目标是把一台新机器配置到“可以打开界面，并能完成至少一种视频源的字幕任务”。

## 执行原则

1. 先检查，后安装。不要重复安装已经存在的工具。
2. 安装软件、修改系统目录、登录第三方账号或下载大型模型前，先向用户说明影响并取得同意。
3. 不读取浏览器 Cookie，不把 Cookie、API Key、访问令牌写进项目、命令历史、截图或日志。
4. 不承诺绕过平台权限。只能获取用户有权访问的最高画质。
5. 全程避免把完整视频载入内存；任务目录优先放在空间充足的磁盘。

## 1. 找到项目并确认平台

进入包含 `package.json`、`local-agent-bridge/` 和 `harness/` 的项目根目录：

```bash
pwd
test -f package.json
test -f local-agent-bridge/server.mjs
test -f harness/precision-video-subtitles/SKILL.md
uname -s
```

若任一文件不存在，停止并让用户确认项目目录。不要在猜测的目录中安装依赖。

## 2. 检查基础环境

必需：

- Node.js `22.13` 或更新版本
- Python 3
- FFmpeg 与 FFprobe

检查命令：

```bash
node --version
python3 --version
ffmpeg -version
ffprobe -version
```

macOS 可在用户同意后使用 Homebrew：

```bash
brew install node ffmpeg python
```

Linux 应使用当前发行版的官方包管理器。Windows 建议使用 `winget`，并重新打开终端使 `PATH` 生效。不要静默安装或自行使用来源不明的二进制文件。

## 3. 按视频来源配置下载工具

只安装任务实际需要的工具。

### Bilibili

推荐通过 `uvx` 按需运行 yutto；也可以安装独立的 yutto。检查：

```bash
command -v uvx || command -v yutto
```

若 `uvx` 位于非标准目录，启动时设置：

```bash
export PSS_UVX_PATH="/uvx/的完整路径"
```

需要登录才能取得授权画质时，先取得用户同意，再执行：

```bash
yutto auth login --mode web
yutto auth status
```

如果使用 `uvx`，把上述 `yutto` 换成 `uvx yutto`。不得自动提取浏览器 Cookie。

### YouTube 和其他网页

检查官方 `yt-dlp`：

```bash
yt-dlp --version
```

缺失时，在用户同意后按官方方式安装。FFmpeg 必须可被 `yt-dlp` 从 `PATH` 找到，以便合并最高质量的视频和音频流。

### 本地视频

不需要下载器。确认文件存在且可被探测：

```bash
test -f "/视频/完整路径.mp4"
ffprobe -v error -show_streams -show_format "/视频/完整路径.mp4"
```

## 4. 选择一个 Agent 后端

至少配置以下一种，不要为了“全都支持”而一次安装全部后端。

| 模式 | 检查 | 备注 |
| --- | --- | --- |
| Codex CLI | `codex --version` | 复用 Codex 本地登录态 |
| Claude Code | `claude --version` | 复用 Claude 本地登录态 |
| DeepSeek CLI | `deepseek --version` | 需与项目适配器参数兼容 |
| Ollama | `ollama --version` | 本地运行；下载模型前先确认磁盘与内存 |
| API Key | 在网页面板中填写 | Key 只传给当前子进程，不写入项目 |

CLI 模式应先由用户完成对应工具的正常登录。不要代替用户读取、复制或持久化登录令牌。

Ollama 模式还要检查模型是否存在：

```bash
ollama list
```

默认模型可使用 `deepseek-r1:14b`，但拉取前必须向用户报告预计磁盘和内存需求。资源不足时选择更小模型或改用 API / Agent CLI。

## 5. 配置任务目录

默认任务位于 `.precision-subtitle-studio/jobs/`。长视频建议把任务放到空间充足的外接硬盘：

```bash
export PSS_JOBS_PATH="/外接硬盘/Gaku-Niku/jobs"
mkdir -p "$PSS_JOBS_PATH"
```

可选端口：

```bash
export PSS_BRIDGE_PORT=43127
```

检查目标磁盘至少能容纳源视频、音频分块、字幕和成片。保守估计应预留源文件大小的 2–3 倍。

## 6. 执行项目预检

对实际视频源运行内置检查器：

```bash
python3 harness/precision-video-subtitles/scripts/check_environment.py \
  "Bilibili、YouTube 链接或本地视频完整路径" --strict
```

退出码为 `0` 才表示该来源的必需媒体工具已齐备。若报告缺失项，只处理明确缺失的工具，然后重新运行一次。

再检查本地桥能够识别 Agent 与媒体工具：

```bash
node local-agent-bridge/server.mjs
```

在另一个终端检查：

```bash
curl -fsS "http://127.0.0.1:43127/api/capabilities"
```

完成后用 `Control-C` 停止测试服务器。不得把服务监听地址改成 `0.0.0.0`；本地桥应只供本机访问。

## 7. 启动

使用已编译的轻量界面时，不需要安装前端依赖：

```bash
node local-agent-bridge/server.mjs
```

然后打开：

```text
http://127.0.0.1:43127
```

macOS 也可以双击 `启动 自学型熟肉机.command`。

只有开发或重新构建界面时才安装前端依赖：

```bash
npm install
npm run local
```

## 8. 交付前验收

AI Agent 配置完成后，应向用户报告以下结果，而不是只说“安装好了”：

- 项目根目录
- Node、Python、FFmpeg 和 FFprobe 版本
- 已启用的视频来源及对应下载工具
- 已启用的 Agent 后端；不得显示密钥
- `PSS_JOBS_PATH` 与剩余磁盘空间
- `check_environment.py --strict` 的通过状态
- `/api/capabilities` 是否能看到预期工具
- 本地界面地址

以下任一情况应停止并请求用户处理：需要平台登录、需要新的 API Key、磁盘空间不足、安装来源不明确、系统权限被拒绝，或所选 Agent CLI 尚未登录。

## 可直接交给 Agent 的任务描述

```text
请阅读 AGENT_SETUP.md，先只做只读环境检查。列出缺失项和预计影响；任何安装、账号登录、模型下载或系统目录修改都先征得我的同意。配置完成后运行内置 strict 预检和 /api/capabilities 验收，并报告版本、任务目录、剩余磁盘和可用后端。不要读取浏览器 Cookie，不要显示或保存任何密钥。
```
