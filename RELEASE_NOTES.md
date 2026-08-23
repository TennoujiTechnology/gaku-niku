# GakuNiku · 自学型熟肉机 v0.2.2

面向 macOS Apple Silicon 与 Windows x64 的项目内听写环境更新。

## v0.2.2 更新

- 本地 Faster-Whisper、模型缓存和媒体工具统一由项目环境检查与配置，不再要求用户预装系统 Python 或 FFmpeg。
- 便携包内置固定版本、SHA256 校验的 FFmpeg/FFprobe；程序只使用项目托管工具链，不修改系统目录。
- 补齐代理场景所需的 `socksio` 运行依赖，模型下载可直接沿用用户在第一页配置的网络代理。
- 视频与听写页重构为“素材与输出 → 听写方案 → 项目环境”三步顺序，环境检查和缺失项提醒更醒目。
- 新增本地环境 Agent 面板：第一页已验证的 AI 只读取脱敏报告，并从 Harness 白名单中选择修复项。
- 原始依赖错误默认折叠到技术诊断；常规用户只看到缺失项、项目目录、下载确认和实时配置进度。
- 修复 v0.2.1 Portable release workflow 的版本路径硬编码问题，并在标签构建通过后自动创建或更新 GitHub Release。

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
