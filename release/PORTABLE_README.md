# GakuNiku 便携版

解压整个文件夹后，运行根目录里的启动文件：

- macOS Apple Silicon：双击 `启动 GakuNiku.command`
- Windows x64：双击 `启动 GakuNiku.cmd`

应用会启动只监听 `127.0.0.1` 的本地后端，并打开 `http://127.0.0.1:43127/`。关闭启动窗口即可停止后端。

## 包内已有

- 编译后的 GakuNiku 前端与本地后端
- Node.js 22.14.0 运行时
- 对应平台的 uv 0.11.29 工具链
- Precision harness、可独立安装的 GakuNiku Skill、固定依赖清单和 API 计费清单

Python 3.11、Faster-Whisper、可选说话人分离组件与模型权重由界面在用户确认后安装到所选目录；这样可以按需选择质量，并避免首次下载前就占用数 GB。第二步可以点击“让第一步模型自动配置”：程序先做真实环境检查，把脱敏结果交给第一步已验证的模型，再由项目内置 Harness 执行固定白名单内的安装动作。

使用 API 或本地部署模型时不需要安装 Codex、Claude Code 等 Agent CLI；所选模型会直接驱动包内 Harness 完成后续流程。只有主动选择“Agent Skill”模式时，才会复用用户自己安装并登录的 Codex、Claude Code、OpenCode、Pi 或 Cline，且不会复制账号凭据。

## 测试版提醒

当前测试包未做 Apple Developer 或 Microsoft 代码签名。macOS 首次运行可右键启动文件并选择“打开”；Windows 若出现 SmartScreen，请先核对压缩包 SHA256，再决定是否运行。

任务与模型默认写入发行文件夹的 `data/`，该目录不会被打入后续发行包。请不要只复制启动文件，必须保留整个解压目录。
