# 自学型熟肉机 v0.1.0

首个可双击运行的 macOS 本地版本。

## 主要能力

- 自动识别 Bilibili、YouTube、本地媒体和其他 yt-dlp 支持的视频页面。
- 可选 API Key、Codex CLI、Claude Code、DeepSeek CLI 或 Ollama / 本地显存。
- 翻译前强制研究作品、角色、称呼、专有名词和预设站点。
- 获取、研究、听写、翻译、疑点 OCR、字幕 QC、封装、验证八阶段 harness。
- 视频分段流式预览、时间轴、角色色、最多两行与逐句精修。
- 对话型中文字幕默认不添加句末句号，保留句中和语气标点。
- 精修后重新执行字幕 QC、OCR、无重编码封装和媒体流验证。

## 启动条件

- macOS
- Node.js 22.13 或更新版本
- 所选 Agent CLI 已安装，或在面板中提供 API Key
- 下载/封装需要的 yutto/uvx、yt-dlp 与 FFmpeg 会在面板中检测

双击 `启动 自学型熟肉机.command`。程序只监听本机 `127.0.0.1`，API Key 只传入当前 Agent 子进程，不写入项目配置。

## Release 内容

精简包只包含运行时界面、本地桥、字幕 harness、图标、启动器和说明；不包含视频、翻译任务、登录信息、Git 历史、开发依赖或缓存。
