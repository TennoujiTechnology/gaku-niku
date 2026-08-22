# GakuNiku · 自学型熟肉机 v0.2.1

面向 macOS Apple Silicon 与 Windows x64 的低内存稳定性更新。

## v0.2.1 更新

- 默认只运行一个完整字幕任务，并监控 Agent、ASR、FFmpeg 与模型子进程组成的整个进程树。
- 默认任务内存上限为 6 GiB；超限、连续 10 分钟无进度或单轮达到 8 小时时保存断点并停止。
- Agent 标准日志限制为 32 MB、错误日志限制为 8 MB，保留两份轮转备份，避免长任务无限增长。
- GakuNiku 关闭时会终止任务和媒体子进程，并限时关闭本地连接，避免 Vinext、Workerd 或模型进程残留。
- WhisperX / pyannote 未获 Hugging Face 权限时立即降级；默认提供无需 gated 权限的本地 Sherpa-ONNX 说话人分离。
- 大模型结构化批次接近输出上限时自动缩小失败子批次，避免整批重做。
- 终止任务后自动返回准备首页；任务文件和断点保留，可从右上角“历史任务”重新打开。
- 便携包包含完整内存管理模块、字幕 Harness 与可独立使用的 GakuNiku Skill。

## 主要能力

- 自动识别 Bilibili、YouTube、本地媒体和其他 yt-dlp 支持的视频页面。
- 可选 API Key、Codex CLI、Claude Code、DeepSeek CLI 或 Ollama / 本地显存。
- 翻译前强制研究作品、角色、称呼、专有名词和预设站点。
- 获取、研究、听写、翻译、疑点 OCR、字幕 QC、封装、验证八阶段 harness。
- 视频分段流式预览、时间轴、角色色、最多两行与逐句精修。
- 对话型中文字幕默认不添加句末句号，保留句中和语气标点。
- 精修后重新执行字幕 QC、OCR、无重编码封装和媒体流验证。
- 精修工作台支持撤回、重做、快捷键和最多 100 步编辑历史。
- 第一、三步会按配置指纹复用已经验证通过的状态；真实音频测试改为可选。
- 疑点复核默认采用适度放行策略，只深查可能改变意思的内容，并把低影响疑点留给精修台。
- 顶部新增 `.gakuniku` 项目的打开与保存功能，可恢复预习、Harness、字幕、角色、样式和时间轴布局，且不会写入 API Key 或访问令牌。
- Token 统计区分缓存命中输入，并按服务商缓存费率估算费用。

## 便携版启动条件

- macOS 13+ Apple Silicon，或 Windows 10/11 x64
- 所选 Agent CLI 已安装，或在面板中提供 API Key
- Node.js 22.14.0 与 uv 0.11.29 已随包提供
- Faster-Whisper、WhisperX、模型权重与 FFmpeg 等大体积依赖会在面板中检测并按需配置

macOS 双击 `启动 GakuNiku.command`，Windows 双击 `启动 GakuNiku.cmd`。程序只监听本机 `127.0.0.1`，API Key 只传入当前 Agent 子进程，不写入项目配置。

## Release 内容

精简包只包含运行时界面、本地桥、字幕 Harness、可独立安装的 GakuNiku Skill、内置 Node/uv、图标、启动器和说明；不包含视频、翻译任务、模型权重、登录信息、Git 历史、开发依赖或缓存。当前测试包未做代码签名。
