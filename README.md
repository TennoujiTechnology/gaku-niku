# Gaku-Niku｜自学型熟肉机

> 先学懂，再烤熟。

Gaku-Niku 是一台会做功课的本地熟肉机。给它一段 Bilibili、YouTube 或本地视频，它会先查作品背景、人物关系和专有名词，再开始听写、翻译、校时与封装。遇到拿不准的词，它会回到对应画面抽帧和 OCR，而不是顺手猜一个。

项目把 `precision-video-subtitles` skill 装进了可视化 harness：机器负责跑完整流程，人可以在时间轴上随时接管和精修。目标很简单——少一点生硬机翻，多一点真正看懂作品后的熟肉。

## 只要 Skill，不要前端？

纯 Skill 版本位于 [`skills/gaku-niku/`](./skills/gaku-niku/)，也可以[直接下载 `gaku-niku-skill.zip`](https://github.com/TennoujiTechnology/gaku-niku/releases/download/skill-v1.0.0/gaku-niku-skill.zip)。它把资料预习、听写判断、逐句翻译、时间点 OCR、字幕样式、封装和完整验收交给同一个模型连续完成；FFmpeg、下载器和校验脚本只负责确定性工具工作，不需要再拼多个 Agent。

把整个 `gaku-niku` 文件夹放进 Agent 的 skills 目录，然后这样调用：

```text
Use $gaku-niku to research this work and complete the entire subtitle localization workflow with one model.
```

## 它会做什么

- 省心模式会自动保留当前可用的翻译引擎，并套用 Faster-Whisper Turbo、中等思考、词级时间戳、常用检索来源、ASS/SRT/MKV 和内置已审计 Harness；不会修改视频位置、输出文件夹、密钥或代理。
- 视频来源智能识别、最高授权画质、输出路径与 SRT / ASS / MKV / MP4 选择。
- API 模式预设 GPT、Grok、DeepSeek、Kimi、MiMo、MiniMax、GLM 与兼容接口；内置模型 ID 均来自各家官方文档并显示核对日期，也可用当前 Key 从服务商 `/v1/models` 实时同步账户可用列表。
- API Key 默认只暂存在当前浏览器标签页；用户可选择保存在本机浏览器，关闭后继续使用，并可一键同时清除临时与持久副本。密钥不写入项目、任务清单或日志。
- 模型运行方式、服务商、模型 ID、Base URL、Agent CLI、本地部署模型、思考强度与代理可一键保存为本机默认设置，下次打开自动恢复；配置指纹未变化时会复用已经通过的能力测试状态。
- 网络代理提供独立开关，并会读取本机 Clash Verge Rev 的系统代理状态与混合端口作为默认地址；关闭开关时保留地址但请求保持直连。
- 本地 Agent 预设 Codex Agent CLI、Claude Code、OpenCode、Pi、Cline，也保留 DeepSeek CLI 与 Ollama / 本地 GPU。这里 GPT 是模型，Codex 是负责调用模型与工具的编程 Agent/CLI。
- API 连接可在启动前用独立对话框真实测试，不会保存密钥或测试对话。
- 准备页先测试翻译引擎；文字与图片都通过后，视频、预习检索和 harness 同时亮灯解锁。点击开始时再一次性检查所有必填项。
- 翻译引擎支持低、中、高、极高四档思考强度；修改引擎配置后旧绿灯自动失效。
- 预习文档是 Agent 已经查找、归纳并附上来源与置信度的结果，不是待填写的检索计划；用户可预览、修订并保存进本地知识库。
- 联网检索默认接入 Exa Search MCP（无 Key 可试用），也可选 Tavily、Agent 内置搜索或自定义远程 MCP；第一步选定的模型负责规划查询、判断证据和归纳文档，MCP 只执行搜索与正文读取，界面实时展示查询和来源状态。
- Precision harness 可以展开查看和修改；修改内容仅随当前任务保存，不覆盖项目内置版本。
- 可选显示 Agent 执行轨迹，包括阶段、工具动作与公开摘要；不展示或伪造模型隐藏思维链。
- 获取、研究、听写、翻译、疑点 OCR、字幕 QC、封装、验证八阶段进度。
- 视频字幕预览、时间轴、说话人/成员色、字体字号、描边发光、逐句精修，以及最多 100 步撤回/重做（`⌘/Ctrl+Z`、`⌘/Ctrl+Shift+Z`、`Ctrl+Y`）。
- 最多两行、无多余句末句号、横向安全区优先、首词出现/末词消失的时序规则。
- 低内存本地桥：视频不进入浏览器内存，Agent 输出直接流式落盘，API Key 不写入项目文件。
- 双模式工作台：省心模式以 API 为默认入口，高级模式保留完整设置；已有 Agent CLI 的用户可直接复用项目 Skill。
- 顶部计费横条明确展示结算方式、当前模型、用量口径和听写计费归属，不伪造服务商费率。
- 准备流程保持双列卡片画布，并随当前阶段自动平移聚焦；可暂停跟随或随时缩回查看全貌。
- 本地听写只要求用户选择“模型与项目数据”位置。程序会先识别文件系统：APFS、ext4、Windows NTFS 等本机原生磁盘可在项目数据目录保存运行库；exFAT、FAT、macOS/Linux 下的 NTFS 及网络盘只保存模型，Python 运行库自动转到当前用户的本机应用数据目录，不修改系统 Python。
- macOS 与 Windows 首次配置时由程序按固定清单准备 `uv 0.11.29 + Python 3.11`：优先使用发行包内工具，否则在用户确认后下载并核对 SHA256。Faster-Whisper、WhisperX、yutto 均固定版本并带环境指纹；安装先在临时目录深度验证，成功后再原子替换。
- Faster-Whisper 基础听写与 WhisperX 说话人分离使用两个独立环境；WhisperX 默认关闭，启用时先装入临时环境并深度导入验证，只有成功才替换正式环境，失败不会破坏已经可用的基础听写。
- 环境配置卡显示磁盘分流、基础运行库、说话人分离运行库、模型与最终验证的进度，并实际导入深层模块核验；失败诊断会持久保存，可让第一步已验证模型只读分析脱敏报告，但安装仍由固定白名单流程执行。
- Agent CLI 保持外部适配器模式，复用用户已有登录态而不复制凭据；FFmpeg、FFprobe 与 yt-dlp 优先使用发行包内对应平台程序，再回退到系统 `PATH`。CI 会在 macOS 与 Windows 同时执行清单、构建、静态检查和测试。

## 开机就烤（推荐）

项目带有编译好的轻量界面，不用先折腾前端环境。macOS 直接双击：

```text
启动 自学型熟肉机.command
```

它只启动一个 Node 进程，同时提供界面、视频流和本地 Agent 桥。浏览器会自动打开 `http://127.0.0.1:43127`。

如果准备让 AI Agent 代为配置新机器，请直接把 [AGENT_SETUP.md](./AGENT_SETUP.md) 交给它。文档包含依赖检查、Bilibili / YouTube / 本地视频配置、Agent 后端选择、低内存任务目录和最终验收清单；安装软件或登录账号前会要求 Agent 先取得用户同意。

## macOS / Windows 便携发行包

`v0.2.0` 发行包内置 Node.js 22.14.0 与校验过的 uv 0.11.29，不要求普通用户预装 Node 或 Python。Faster-Whisper、WhisperX 与模型权重仍按用户选择安装到项目数据目录，避免发行包膨胀到数 GB。

```bash
pnpm build:standalone
pnpm release:portable -- --output /path/to/release-test
```

当前生成 `macOS Apple Silicon` 与 `Windows x64` 两个 ZIP。解压后分别双击 `启动 GakuNiku.command` 或 `启动 GakuNiku.cmd`。测试包尚未做 Apple/微软代码签名，系统首次启动时可能显示来源确认；正式公开发布前应补充签名、公证与 Windows Authenticode。

## 开发模式

需要 Node.js 22.13 或更新版本。

```bash
npm install
npm run local
```

`npm run local` 会同时启动：

- 界面：终端中显示的本地网址（通常为 `http://localhost:3000`）
- 本地 Agent 桥：`http://127.0.0.1:43127`

如果希望分开启动：

```bash
npm run bridge
npm run dev
```

只想先逛逛界面，可以点右上方的“载入示例工程”，不用下载视频，也不用启动模型。

## 让谁来掌勺

| 模式 | 使用方式 | 密钥处理 |
| --- | --- | --- |
| API Key | GPT、Grok、DeepSeek、Kimi、MiMo、MiniMax、GLM 或兼容接口 | 只注入当前 Agent 子进程，不写入配置与日志 |
| Agent CLI | `codex`、`claude`、`opencode`、`pi`、`cline`、`deepseek` | 复用 CLI 的本地登录态 |
| 本地部署模型 | `ollama run <model>` | 媒体和文本均留在本机 |

本地桥只监听 `127.0.0.1`，且只接受来自 `localhost` / `127.0.0.1` 页面的请求。它不会执行网页传来的任意命令；只允许调用固定的 Agent 适配器。

检索服务的 API Key 只注入当前 Agent 进程。Claude Code 所需的任务级 MCP 配置会使用权限受限的临时文件，并在进程结束后删除；任务清单只记录已提供密钥，不保存明文。

## 熟肉放在哪里

运行任务默认保存在：

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

可以通过 `PSS_JOBS_PATH` 把任务数据放到外接硬盘。运行时目录已加入 `.gitignore`。

用户确认过的检索文档保存在 `.precision-subtitle-studio/knowledge/`。知识库只写入本机，不进入 Git，也不会被自动发给模型；只有在界面勾选后才会随当前任务调用。

Bilibili 默认使用固定版本的 yutto。若 `uvx` 没有加入 `PATH`，可在启动时提供其位置，例如：

```bash
PSS_UVX_PATH=/完整路径/uvx npm run local
```

## 出锅标准

内置 harness 位于 `harness/precision-video-subtitles/`。不管接的是云端 API 还是本地 Agent，每份字幕都要过这些规则：

1. 先研究作品、人物、官方译名、称呼与专有名词，并记录来源。
2. 对疑点跳到对应时间附近抽帧、OCR、重听，不猜专有名词。
3. 每个逻辑字幕最多两行，优先使用横向安全区。
4. 对话型中文字幕默认不加句末句号 `。`；保留句中句号以及问号、感叹号、省略号、破折号等必要语气标点。
5. 字幕从说话人的首词开始，到末词结束时消失。
6. 优先使用有证据的角色/成员应援色；未知时使用确定性备用色并记录。
7. ASS 用角色色做外圈描边、柔光和阴影，正文保持高对比。
8. 生成后执行结构检查、合成抽帧 OCR、媒体流核验和全文件读取。

## 开发与验证

```bash
npm test
npm run lint
```

构建仍兼容当前 Sites/vinext 工程结构；`.openai/hosting.json` 被保留，之后需要发布时可以继续使用 Sites 托管流程。
