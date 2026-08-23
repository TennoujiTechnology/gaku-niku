# GakuNiku（自学型熟肉机）

GakuNiku 是一个本地运行的视频字幕翻译工具，当前重点支持日语视频翻译为简体中文。输入可以是 Bilibili、YouTube 链接，也可以是本地视频文件。

项目把背景资料检索、原文听写、翻译、疑点复核、字幕质检和视频封装串成同一条工作流，并提供一个可视化工作台用于检查结果和逐句修改。

## 当前版本

当前版本为 `v0.2.2`，提供：

- macOS Apple Silicon 便携包
- Windows x64 便携包
- 可独立安装的 `gaku-niku` Agent Skill
- 浏览器界面与本地后端

便携包尚未进行 Apple 或 Microsoft 代码签名。首次运行时，系统可能要求用户确认来源。

## 主要功能

- 识别 Bilibili、YouTube、其他 yt-dlp 支持的链接以及本地视频。
- 使用本地 Faster-Whisper 或在线听写接口生成带时间信息的原文。
- 翻译前检索作品、人物、术语和官方写法，并允许用户检查和修改预习文档。
- 支持 API 模型、Agent Skill 和本地部署模型三种运行方式。
- 默认采用适度疑点复核：只深查可能改变含义的专名、数字、否定和上下文冲突；普通语气词、重复和背景碎语不会阻塞整条任务。
- 生成 SRT、ASS、MKV 或 MP4，并检查字幕行数、时序和媒体流。
- 在精修工作台中调整时间轴、逐句文本、角色颜色、字体和字幕样式。
- 支持撤回与重做：`⌘/Ctrl+Z`、`⌘/Ctrl+Shift+Z`、`Ctrl+Y`。
- 可保存和打开 `.gakuniku` 项目文件。项目文件不包含 API Key、访问令牌或视频本体。

## 两种使用方式

### 图形界面

适合希望直接填写 API Key、选择听写模型并查看进度的用户。界面包含四个准备步骤：

1. 设置并测试翻译引擎
2. 选择视频、听写方案和输出格式
3. 检索并检查预习结果
4. 确认执行规则

任务开始后会依次执行素材获取、背景预习、原文听写、翻译、疑点复核、字幕质检、视频封装和最终验证。

第一步不是单纯保存一个“翻译模型”。通过文字与图片测试的模型会成为本次任务的统一执行模型：第二步发现本地听写环境缺失时，它先读取程序生成的脱敏诊断，再通过内置 Harness 选择安全安装方案；开始任务后，同一个模型继续负责检索规划、翻译、疑点复核和质量判断。API 模式不需要 Codex、Claude Code 或其他 Agent CLI，项目自带的 Harness 负责白名单文件、媒体和检索工具调用。

### Agent Skill

如果本机已经安装 Codex、Claude Code 或其他能够加载 Skill 的 Agent，可以直接使用 [`skills/gaku-niku/`](./skills/gaku-niku/)。这种方式保留完整执行上下文，更适合需要 Agent 参与判断和修订的任务。

将 `skills/gaku-niku` 复制到 Agent 的 skills 目录后调用：

```text
Use $gaku-niku to research this work and complete the subtitle localization workflow.
```

Skill 负责组织工作流；FFmpeg、下载器和校验脚本负责确定性操作。

## 快速开始

### 使用便携包

解压对应平台的 ZIP：

- macOS：双击 `启动 GakuNiku.command`
- Windows：双击 `启动 GakuNiku.cmd`

程序会启动本地后端并打开 `http://127.0.0.1:43127`。便携包已经包含 Node.js、`uv` 和固定校验版本的 FFmpeg/FFprobe；Faster-Whisper、WhisperX 与模型权重会在用户确认后按需下载到项目环境。

### 从源码启动

需要 Node.js 22.13 或更新版本。

```bash
pnpm install
pnpm local
```

也可以分别启动后端和开发服务器：

```bash
pnpm bridge
pnpm dev
```

## 模型与听写

API 模式提供 GPT、Grok、DeepSeek、Kimi、MiMo、MiniMax、GLM 及 OpenAI 兼容接口的预设。模型列表可使用当前密钥从服务商接口同步。选中的 API 直接驱动项目自带 Harness，不会在后台寻找 Codex 或 Claude Code。

Agent Skill 模式提供 Codex、Claude Code、OpenCode、Pi、Cline 等适配器，并严格使用用户在第一步明确选择的 CLI 及其登录状态，不会静默换成另一种 CLI。

本地部署模型使用 Ollama 的 OpenAI 兼容接口直连同一套内置 Harness，同样不要求额外 Agent CLI。

原文听写和翻译使用两套独立配置：

- Faster-Whisper：默认的本地听写方案
- WhisperX：可选的说话人分离方案，使用独立环境
- 在线听写 API：适合不希望安装本地模型的用户

本地运行库由项目管理，不会修改系统 Python。模型可以存放在用户选择的项目数据目录；如果目标磁盘不适合运行 Python 环境，程序会把运行库放到本机应用数据目录，只把模型保存在目标磁盘。

## 字幕规则

默认执行规则位于 [`harness/precision-video-subtitles/`](./harness/precision-video-subtitles/)：

1. 翻译前记录作品、人物和术语来源。
2. 疑点先按影响分级；只有可能改变含义的项目才进行重听、二次听写、画面检查或检索。
3. 每条字幕最多两行，优先利用横向安全区。
4. 对话型中文字幕不自动添加句末句号 `。`。
5. 字幕时间尽量贴合说话开始和结束。
6. 有可靠资料时使用角色或成员颜色；没有资料时使用稳定的备用色。
7. 输出后检查字幕结构、可读性、媒体流和文件完整性。

执行前可以在界面中查看和修改 Harness。修改只作用于当前任务，不会覆盖项目内置版本。

## 数据与密钥

本地后端只监听 `127.0.0.1`，不接受远程页面调用。

- API Key 默认只保存在当前浏览器标签页。
- 用户可以选择把模型配置保存在浏览器本地存储中。
- 密钥不会写入 `.gakuniku` 项目文件、任务清单或日志。
- Agent CLI 适配器复用已有登录状态，不复制凭据。
- 检索服务密钥只传给当前任务进程。

任务数据默认位于：

```text
.precision-subtitle-studio/jobs/<job-id>/
├── manifest.json
├── studio-job.json
├── source/
├── research/
├── work/
├── frames/
├── subtitles/
├── deliverables/
└── logs/
```

可以通过 `PSS_JOBS_PATH` 将任务目录放到其他磁盘。用户确认的预习文档保存在 `.precision-subtitle-studio/knowledge/`，只有在界面中选择后才会加入新任务。

## 构建发行包

```bash
pnpm build:standalone
pnpm release:portable -- --output /path/to/release-test
```

发行包使用固定版本的运行时清单和 SHA256 校验。平台配置位于 [`release/release-manifest.json`](./release/release-manifest.json)，运行时配置位于 [`runtime/runtime-manifest.json`](./runtime/runtime-manifest.json)。

## 测试

```bash
pnpm test
pnpm lint
```

CI 会在 macOS 与 Windows 上检查运行时清单、前端构建和自动化测试。

新机器的完整安装与检查说明见 [AGENT_SETUP.md](./AGENT_SETUP.md)。
