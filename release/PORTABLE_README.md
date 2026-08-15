# GakuNiku 便携版

解压整个文件夹后，运行根目录里的启动文件：

- macOS Apple Silicon：双击 `启动 GakuNiku.command`
- Windows x64：双击 `启动 GakuNiku.cmd`

应用会启动只监听 `127.0.0.1` 的本地后端，并打开 `http://127.0.0.1:43127/`。关闭启动窗口即可停止后端。

## 包内已有

- 编译后的 GakuNiku 前端与本地后端
- Node.js 22.14.0 运行时
- 对应平台的 uv 0.11.29 工具链
- Precision harness、固定依赖清单和 API 计费清单

Python 3.11、Faster-Whisper、WhisperX 与模型权重仍由界面在用户确认后安装到所选目录；这样可以按需选择质量，并避免首次下载前就占用数 GB。Agent CLI 继续复用用户自己安装和登录的 Codex、Claude Code、OpenCode、Pi、Cline 等工具，不会复制账号凭据。

## 测试版提醒

当前测试包未做 Apple Developer 或 Microsoft 代码签名。macOS 首次运行可右键启动文件并选择“打开”；Windows 若出现 SmartScreen，请先核对压缩包 SHA256，再决定是否运行。

任务与模型默认写入发行文件夹的 `data/`，该目录不会被打入后续发行包。请不要只复制启动文件，必须保留整个解压目录。
