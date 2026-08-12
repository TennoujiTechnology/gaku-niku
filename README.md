# Gaku-Niku｜自学型熟肉机

> 先学懂，再烤熟。

Gaku-Niku 是一台会做功课的本地熟肉机。给它一段 Bilibili、YouTube 或本地视频，它会先查作品背景、人物关系和专有名词，再开始听写、翻译、校时与封装。遇到拿不准的词，它会回到对应画面抽帧和 OCR，而不是顺手猜一个。

项目把 `precision-video-subtitles` skill 装进了可视化 harness：机器负责跑完整流程，人可以在时间轴上随时接管和精修。目标很简单——少一点生硬机翻，多一点真正看懂作品后的熟肉。

## 它会做什么

- 自动识别视频来源，获取最高授权画质，并输出 SRT / ASS / MKV / MP4。
- API Key、Codex CLI、Claude Code、DeepSeek CLI、Ollama / 本地 GPU 五类入口。
- 翻译前先按关键词和指定站点做功课；研究清单没过，就不开烤。
- 获取、研究、听写、翻译、疑点 OCR、字幕 QC、封装、验证八阶段进度。
- 提供视频预览、时间轴、说话人/成员色、字体字号、描边发光和逐句精修。
- 最多两行、无多余句末句号、横向安全区优先、首词出现/末词消失的时序规则。
- 低内存本地桥：视频不进入浏览器内存，Agent 输出直接流式落盘，API Key 不写入项目文件。

## 开机就烤（推荐）

项目带有编译好的轻量界面，不用先折腾前端环境。macOS 直接双击：

```text
启动 自学型熟肉机.command
```

它只启动一个 Node 进程，同时提供界面、视频流和本地 Agent 桥。浏览器会自动打开 `http://127.0.0.1:43127`。

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
| API Key | OpenAI、Anthropic 或 OpenAI 兼容接口 | 只注入当前 Agent 子进程，不写入配置与日志 |
| Agent CLI | `codex`、`claude`、`deepseek` | 复用 CLI 的本地登录态 |
| 本地显存 | `ollama run <model>` | 媒体和文本均留在本机 |

本地桥只监听 `127.0.0.1`，且只接受来自 `localhost` / `127.0.0.1` 页面的请求。它不会执行网页传来的任意命令；只允许调用固定的 Agent 适配器。

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

Bilibili 默认使用 yutto。若 `uvx` 没有加入 `PATH`，可在启动时提供其位置，例如：

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
