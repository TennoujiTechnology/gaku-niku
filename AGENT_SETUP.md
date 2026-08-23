# GakuNiku：AI Agent 环境配置指南

这份文档写给负责安装、启动和验收 GakuNiku 的 AI Agent。目标不是“尽量多装工具”，而是把当前机器配置到：界面可以打开、第一步统一执行模型通过测试、所选听写方式可用，并且至少一种视频来源通过预检。

## 1. 最高优先级：先完成应用内 AI 配置流程

新机器应优先走 GakuNiku 界面内的配置流程，不要先在系统 Python 中手动安装 Faster-Whisper、WhisperX 或模型依赖。

1. 启动 GakuNiku，打开 `http://127.0.0.1:43127`。
2. 在第一步选择一个模型入口，并完成文字与图片能力测试。
3. 进入第二步，选择本地 Faster-Whisper 或在线听写 API。
4. 使用本地听写时，先确认“模型与项目数据文件夹”，再运行环境检查。
5. 点击“让第一步模型自动配置”。第一步已验证的模型读取脱敏诊断并选择最小配置方案；程序只执行内置 Harness 的固定白名单动作。
6. 用户确认下载内容、体积和保存位置后，程序准备隔离环境、固定版本依赖和模型。
7. 配置完成后重新检查环境，并执行真实短音频测试；通过后再开始视频任务。

第一步模型是本次任务的统一执行模型，不只是翻译模型。它还负责环境配置规划、检索规划、疑点判断和最终质检。模型不能生成并执行任意 Shell 命令；安装动作、目标目录和允许的依赖均由项目代码约束。

在线听写 API 不需要本地 Faster-Whisper 环境。只有选择本地听写时，才准备下述项目隔离环境。

## 2. Requirements 总表

先根据实际使用方式检查，不要一次安装全部可选组件。

| 类别 | 便携包 | 从源码运行 | 是否必需 |
| --- | --- | --- | --- |
| 应用运行时 | 已包含 Node.js `22.14.0` | Node.js `22.13` 或更新版本 | 必需 |
| 前端依赖 | 已编译，无需 npm 安装 | `npm install` | 仅源码开发必需 |
| Python 工具链 | 包含或按清单准备 `uv`，由项目管理 Python `3.11` | 优先使用项目托管 `uv`；兼容平台可自动准备 Python `3.11` | 本地听写必需 |
| FFmpeg / FFprobe | 优先使用包内工具，其次检查 `PATH` | 检查 `PATH` 或项目托管工具链 | 真实视频任务必需 |
| 下载器 | 按来源选择 yutto / yt-dlp | 按来源选择 yutto / yt-dlp | 仅网络视频必需 |
| 统一执行模型 | API、本地模型或明确选择的 Agent Skill | 同左 | 至少一种入口必需 |
| 磁盘空间 | 模型、源视频和交付文件 | 同左 | 必需 |

### 2.1 源码运行的最小检查

```bash
node --version
npm --version
ffmpeg -version
ffprobe -version
```

要求：

- Node.js 不低于 `22.13`。
- FFmpeg 与 FFprobe 必须同时可用，才能执行真实音频抽取、封装和媒体流验收。
- 不要求把听写依赖安装到系统 Python。项目应自行准备隔离 Python `3.11` 环境。
- 只有项目托管工具链不可用时，才把系统 Python 作为兼容回退；不要优先执行系统级 `pip install`。

### 2.2 统一执行模型只选一种

| 模式 | 检查方式 | 说明 |
| --- | --- | --- |
| API Key | 在第一步填写并完成文字、图片测试 | 直接驱动内置 Harness，不需要 Agent CLI |
| Ollama / 本地接口 | 测试 OpenAI 兼容地址和多模态能力 | 下载本地模型前先确认内存与磁盘 |
| Agent Skill | 检查用户明确选择的 CLI 及登录状态 | 只复用该 CLI，不静默切换 |

不要为了“全都支持”而安装 Codex、Claude Code、OpenCode、Pi、Cline、DeepSeek CLI 和 Ollama。只有用户主动选择 Agent Skill 模式时，才检查对应 CLI；不得读取或复制登录令牌。

## 3. 项目虚拟环境目录契约

默认情况下，本地听写环境必须位于项目数据目录内，不得修改系统 Python：

```text
<项目根目录>/.precision-subtitle-studio/
├── asr/
│   ├── runtimes/
│   │   ├── base/                         # Faster-Whisper 基础虚拟环境
│   │   │   ├── bin/python                # macOS / Linux
│   │   │   └── Scripts/python.exe        # Windows
│   │   └── diarization-sherpa-onnx/      # 可选说话人分离独立虚拟环境
│   ├── models/                           # 听写与说话人分离模型缓存
│   └── install-state.json                # 最近一次配置状态
└── jobs/                                 # 字幕任务目录
```

默认基础环境的完整路径为：

```text
<项目根目录>/.precision-subtitle-studio/asr/runtimes/base/
```

确认方式：

```bash
test -x ".precision-subtitle-studio/asr/runtimes/base/bin/python"
".precision-subtitle-studio/asr/runtimes/base/bin/python" -c \
  "import sys; print(sys.executable); print(sys.prefix)"
```

Windows 使用：

```powershell
.\.precision-subtitle-studio\asr\runtimes\base\Scripts\python.exe -c "import sys; print(sys.executable); print(sys.prefix)"
```

输出路径必须指向项目的 `runtimes/base`，不能指向系统 Python、用户全局 site-packages 或其他项目的虚拟环境。

### 自定义数据目录与非原生磁盘

用户可以在界面中选择其他“模型与项目数据文件夹”。如果目标文件系统支持当前平台的 Python 虚拟环境语义，程序在该目录下继续使用相同的 `runtimes/base`、独立说话人分离环境和 `models` 布局。

如果目标磁盘不兼容虚拟环境所需的链接、权限或元数据语义，程序会把 Python 运行库安全分流到本机应用数据目录，只把模型和项目数据保留在用户选择的磁盘。验收时必须报告这种 `split` 布局，不能声称所有内容仍位于项目目录。

## 4. 执行只读预检

进入包含 `package.json`、`local-agent-bridge/` 和 `harness/` 的项目根目录：

```bash
pwd
test -f package.json
test -f local-agent-bridge/server.mjs
test -f harness/precision-video-subtitles/SKILL.md
uname -s
```

若任一文件不存在，停止并让用户确认项目目录。不要在猜测的目录中安装依赖。

启动本地桥：

```bash
node local-agent-bridge/server.mjs
```

在另一个终端检查：

```bash
curl -fsS "http://127.0.0.1:43127/api/health"
curl -fsS "http://127.0.0.1:43127/api/capabilities"
```

服务只能监听 `127.0.0.1`，不得改成 `0.0.0.0`。

## 5. 按视频来源补齐工具

只处理用户实际选择的视频来源。

### Bilibili

优先使用项目可发现的 `uvx yutto` 或独立 yutto：

```bash
command -v uvx || command -v yutto
```

若 `uvx` 位于非标准目录，可在启动时设置：

```bash
export PSS_UVX_PATH="/uvx/的完整路径"
```

需要登录才能取得用户有权访问的画质时，先取得明确同意，再执行 yutto 的正常登录流程。不得提取浏览器 Cookie，不得承诺绕过平台权限。

### YouTube 和其他网页

```bash
yt-dlp --version
ffmpeg -version
ffprobe -version
```

yt-dlp 与 FFmpeg 必须能够互相发现，才能合并视频与音频流。

### 本地视频

不需要下载器，但必须验证文件与媒体流：

```bash
test -f "/视频/完整路径.mp4"
ffprobe -v error -show_streams -show_format "/视频/完整路径.mp4"
```

## 6. 存储与资源要求

默认任务目录：

```text
.precision-subtitle-studio/jobs/
```

模型、源视频、音频分块、字幕和成片可能同时存在。保守估计应预留源文件大小的 2–3 倍，并额外计入所选模型体积。长视频可以通过 `PSS_JOBS_PATH` 使用其他磁盘：

```bash
export PSS_JOBS_PATH="/外接硬盘/GakuNiku/jobs"
mkdir -p "$PSS_JOBS_PATH"
```

改变任务目录不会自动改变听写虚拟环境目录；听写环境位置应在界面“模型与项目数据文件夹”中单独确认。

## 7. 对实际来源执行严格预检

```bash
python3 harness/precision-video-subtitles/scripts/check_environment.py \
  "Bilibili、YouTube 链接或本地视频完整路径" --strict
```

退出码为 `0` 才表示该来源的必需媒体工具已齐备。若报告缺失项，只处理明确缺失的工具，然后重新运行一次。

本地 Faster-Whisper 还必须在界面中通过：

1. 运行库深度导入检查；
2. 模型快照完整性检查；
3. FFmpeg 音频链路检查；
4. 真实短音频听写测试；
5. 启用说话人分离时的独立环境和模型检查。

不要把“Python 可启动”当作听写环境已经完成。

## 8. 启动方式

### 便携包

- macOS Apple Silicon：双击 `启动 GakuNiku.command`
- Windows x64：双击 `启动 GakuNiku.cmd`

### 源码

首次安装前端依赖：

```bash
npm install
npm run local
```

使用仓库内已编译的轻量界面时，也可以只启动后端：

```bash
node local-agent-bridge/server.mjs
```

然后打开 `http://127.0.0.1:43127`。

## 9. 权限与安全边界

以下操作必须先说明影响并取得用户同意：

- 安装系统软件或修改系统目录；
- 下载模型、Python 运行时或大型依赖；
- 登录第三方平台；
- 把任务、模型或运行库写入新的外部磁盘位置。

始终遵守：

- 不读取浏览器 Cookie；
- 不把 API Key、Cookie、访问令牌写入项目、命令历史、截图或日志；
- 不自动下载未选择的后端或模型；
- 不删除整个听写环境来处理单个失败；优先复用缓存并只修复失败组件；
- 不把完整视频一次性载入内存。

## 10. 交付前验收

AI Agent 必须报告具体结果，而不是只说“安装好了”：

- 项目根目录和启动方式；
- Node.js、FFmpeg、FFprobe 版本；
- 第一步已验证的统一执行模型；
- 听写模式：本地 Faster-Whisper 或在线 API；
- 本地听写虚拟环境的实际 Python 路径；
- 环境布局为 `project` 还是 `split`；
- 模型缓存路径和剩余磁盘空间；
- 已启用的视频来源及下载工具；
- `check_environment.py --strict` 结果；
- 真实短音频测试结果；
- `/api/capabilities` 与本地界面地址。

以下情况应停止并请求用户处理：需要平台登录、新的 API Key 或模型下载确认，磁盘空间不足，安装来源不明确，系统权限被拒绝，或用户选择的 Agent CLI 尚未登录。

## 可直接交给 Agent 的任务描述

```text
请完整阅读 AGENT_SETUP.md，并按文档优先级配置 GakuNiku。先做只读检查，再启动界面并让我完成第一步统一执行模型测试。使用本地 Faster-Whisper 时，优先通过“让第一步模型自动配置”处理脱敏诊断和白名单安装，不要向系统 Python 安装听写依赖。默认虚拟环境必须位于项目的 .precision-subtitle-studio/asr/runtimes/base；若磁盘不兼容而使用 split 布局，明确报告实际运行库与模型路径。任何系统软件安装、账号登录、模型下载或新磁盘写入都先征得我的同意。最后执行严格来源预检、真实短音频测试和 /api/capabilities 验收，不要读取 Cookie，不要显示或保存密钥。
```
