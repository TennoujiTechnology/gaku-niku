---
name: gaku-niku
description: "Single-model, research-first video subtitle localization for Bilibili, YouTube, yt-dlp-compatible pages, or local media. Use for 熟肉、中文字幕、外挂 CC、字幕翻译、OCR 取证或视频封装 requests where one AI agent must independently acquire authorized media, study canon/cast/terminology, transcribe dialogue, translate accurately into Chinese, inspect ambiguous timestamps, create styled SRT/ASS captions, mux or burn them into video, and validate the deliverable without delegating research or translation to another model."
---

# Gaku-Niku

先学懂，再烤熟。用当前模型独立完成从资料预习到成片验收的整条工作流。默认执行日语到简体中文；用户指定其他语言时遵从用户要求。

## 单模型契约

- 由当前模型连续负责研究、听写判断、翻译、术语统一、歧义消解、字幕精修和最终验收。
- 不把任何阶段分派给子 Agent、其他大模型或机器翻译服务。除非用户明确要求，否则不调用 Google Translate、DeepL 或外部翻译 API。
- 可以使用下载器、FFmpeg、FFprobe、ASR、OCR、搜索和本 Skill 的脚本作为工具；工具产物是证据或草稿，当前模型必须复核并作最终决定。
- 若宿主强制并行/委派，要求由同一个主模型整合全部证据并逐句定稿；不得把子模型输出直接当成最终字幕。

## Studio 执行宿主契约

- 第一页通过图文能力测试的模型就是当前任务的统一执行模型，不只是“翻译 API”。它负责第二步环境诊断与方案选择，并持续负责后续八阶段的计划、研究、翻译、复核和验收判断。
- `API 模式` 必须由项目内置 Built-in Harness 直接调用所选 API；不得要求电脑另装 Codex、Claude Code、OpenCode、Cline 或其他 Agent CLI，也不得在后台偷偷选择其中任意一个做总控。
- `本地部署模型` 必须通过 Ollama 的兼容接口直连同一个 Built-in Harness；不得借用 Codex 或 Claude 做隐藏总控。
- `Agent Skill 模式` 只调用用户在第一页明确选择并通过测试的 CLI；不得因为方便而换成另一种 CLI。
- Built-in Harness 只暴露固定的文件、模型、搜索、ASR、OCR、FFmpeg、字幕生成与 manifest 原子更新工具。模型不得生成或执行任意 shell、任意脚本、删除动作或工作区外路径。
- 环境配置先由程序采集真实、脱敏的操作系统/磁盘/运行库/模型状态，再让第一页模型在 `复用、补齐基础运行库、下载模型、配置 Sherpa-ONNX、授权后配置 pyannote、关闭可选分离` 这些白名单动作中选择。缺失的基础听写依赖是强制项，不能被模型省略；可选增强失败不得破坏已可用环境。
- 每个模型决定、工具调用、失败、降级与验收结果都必须写入任务日志和 manifest。API 密钥、Token、Cookie 和完整媒体不得进入提示词或日志。

## 硬规则

1. 只处理用户提供或有权访问的媒体；不绕过 DRM、付费墙和访问控制。
2. 不发送完整媒体、Cookie、令牌或密钥；只传本地路径，不打印认证信息。
3. 长视频始终落盘处理。音频按 5–10 分钟分块，保留 2–5 秒重叠；不要将整片读入内存。
4. 先通过研究门槛再翻译。官方名称、人物关系和关键专有名词未确认前，不开始目标语言定稿。
5. 不编造听不清的台词或专有名词。先判断是否影响句意，只调用真正相关的证据工具；低影响疑点优先保守表达、标记并放行。
6. 保留原媒体和用户文件；在新任务目录输出，未获授权不得覆盖。
7. 中文字幕默认不在每条对话末尾加句号 `。`，但保留句中句号及必要语气标点。
8. 每个逻辑字幕最多两行，优先利用横向安全区；字幕从首词开始，到末词结束才消失。
9. 角色或成员色必须先查证；正文保持高对比，角色色用于外圈描边、柔光和阴影。查不到时使用确定性备用色并记录。
10. 字幕结构、媒体流、时长和全文件读取全部通过后，才能宣告完成。

## 开始任务

从用户信息中推断视频源、源/目标语言、输出目录、格式、是否需要软字幕/硬字幕和封装。只有无法安全推断且会改变结果时才提问。

解析当前 `SKILL.md` 所在目录为 `{skill_dir}`，然后初始化可恢复任务：

```bash
python3 {skill_dir}/scripts/init_job.py SOURCE OUTPUT_DIR \
  --source-language ja --target-language zh-Hans
python3 {skill_dir}/scripts/check_environment.py SOURCE --strict
```

以 `manifest.json` 为唯一进度记录。每个阶段按 `pending → in_progress → complete` 更新，并写入证据路径；真正无法继续时标为 `blocked`，不要静默跳过。

## 工作流

弱模型或首次执行时，先完整阅读 [references/execution-contract.md](references/execution-contract.md)。它定义 ASR/OCR 路由、统一 cue JSON、角色色生成、困难内容和量化验收门槛。

### 1. 获取与探测

完整阅读 [references/source-acquisition.md](references/source-acquisition.md)，只执行与 Bilibili、YouTube/其他网页或本地媒体匹配的章节。

- 选择用户账号授权范围内的最高画质与最佳音频。
- 优先取得官方/上传者原文字幕；自动字幕单独标记为草稿。
- 不根据文件名判断画质。运行：

```bash
python3 {skill_dir}/scripts/inspect_media.py PATH_TO_MEDIA
```

把实际分辨率、帧率、编码、时长和大小写入 manifest 证据。

### 2. 资料预习门槛

完整阅读 [references/research-and-translation.md](references/research-and-translation.md)。翻译前搜索并创建：

- `research/brief.md`：作品/活动、时间线、人物、关系、背景、梗和相关前情
- `research/sources.md`：直接链接、访问日期、每个来源证明的事实
- `research/glossary.tsv`：`source_term, reading, canonical_target, category, evidence_url, confidence, notes`
- `research/speakers.tsv`：`speaker, role, voice_traits, canonical_name, evidence_url`

只有当作品/场次、主要说话人、称呼和反复出现的专名均已识别，且词表项有证据或明确标为 unresolved 时，研究门槛才通过。优先官方与一手来源；百科和粉丝资料只用于补缺与交叉验证。

### 3. 原文听写

依次优先使用：官方人工原文字幕、上传者稿件、高质量 ASR、人工补录。保存未改动原文件，并另建 UTF-8 时间轴原文稿。

让 ASR 提供词级时间戳（若支持）。多说话人材料需要说话人分离，但匿名 cluster 不等于真实身份；用自我介绍、镜头和声线证据锚定。

所有疑点写入 `work/uncertainties.tsv`：`timestamp, source_guess, reason, next_check, status`。可结束状态为 `resolved`、`accepted_risk`、`ignored_non_material`；只有所选复核策略仍要求继续取证的项目保留 `pending`。不得把无证据猜测伪装成已确认事实。

### 4. 当前模型逐句翻译

按时间顺序分块翻译，每块都携带全局 brief、词表、说话人表，以及前后 2–5 条语境。当前模型必须逐句定稿：

- 传达意图、潜台词、礼貌度、角色语气和笑点关系，而非逐词替换。
- 统一官方名称、称呼和作品术语。
- 中文自然、简洁，并能在字幕时长内读完。
- 不添加声音、画面或研究证据没有的信息。

非显然选择写入 `work/translation-decisions.tsv`：`timestamp, source, translation, issue, evidence, confidence`。

### 5. 疑点分级与必要取证

遵从任务选择的 `fast`、`pragmatic`（默认）或 `strict` 复核策略。先不打开媒体，依据源文、上下文、词表和置信信息把全部候选分为：

- `critical`：不同读法可能改变专名、数字/日期、否定、人物关系、核心动作、因果、回调或笑点。
- `review`：原词不完全确定，但可以在不增加事实的前提下保守翻译主要意思。
- `minor`：口癖、重复、标点、无关背景碎语，或仅影响样式的说话人身份。

低 ASR 置信度本身不等于 `critical`。`fast`/`pragmatic` 只在预算内深查最高风险项：相邻疑点合并为音频窗口并批量二次听写；画面确实可能提供姓名卡、标牌或字幕证据时才抽帧/OCR；只有可复用专名或关键事实才搜索。

`review` 使用保守译法并标为 `accepted_risk`、`flagged=true`，留给精修台；`minor` 可合并、省略或标为 `ignored_non_material`。两者都不得阻塞。`fast`/`pragmatic` 中仍未完全解决的 `critical` 使用不虚构细节的中性译法，记录 limitations 并继续；只有 `strict` 模式允许因为未解决的关键内容暂停。

最终字幕文本不得残留 `TODO`、`???`、`待核`、`听不清`。在 `work/ambiguity-report.json` 和 TSV 中记录策略、数量、放行方式与证据，不得把自动放行写成“已高置信确认”。

### 6. 生成并检查字幕

完整阅读 [references/subtitle-qc-and-mux.md](references/subtitle-qc-and-mux.md)。按 execution contract 维护 `work/cues.json`，并用 `scripts/render_subtitles.py` 从同一份已批准 cue 数据生成 UTF-8 SRT 和 ASS。

- 强制最多两行；测量目标分辨率和字体下的实际渲染宽度，避免一两个字孤悬第二行。
- 使用真实说话包络定时，不套固定显示时长；长句只在自然词界切换面板。
- 用 ASS 样式实现位置和角色色。装饰性 glow/shadow Dialogue 行的 `Effect` 必须以 `decorative` 开头，避免被重复计数。

运行：

```bash
python3 {skill_dir}/scripts/validate_subtitles.py TARGET.srt TARGET.ass \
  --strict --media-duration SECONDS
```

合成检查最宽单行、最宽双行、每种角色色、亮背景和暗背景。对合成帧做视觉检查，并对字幕层做 OCR，确认无裁切、缺字和错误换行。

### 7. 封装或烧录

默认输出 MKV：流复制视频/音频，ASS 设为默认字幕轨，同时保留 SRT fallback 和外置字幕。除非用户要求硬字幕或 MP4 必须保留 ASS 样式，否则不要重编码。

若用户要求 MP4 并保留角色色/发光，用 FFmpeg 流式烧录 ASS；先制作短样片检查字体和转场，再完整编码。禁止为求方便把长视频一次载入内存。

### 8. 最终验收与交付

对于 MKV 运行：

```bash
python3 {skill_dir}/scripts/verify_mux.py FINAL.mkv \
  --expect-subtitles 2 --subtitle-language zho --full-read
```

对于烧录 MP4，至少执行 `ffprobe` 流检查、时长对比、拼接/字幕抽帧与完整音视频解码读取。

确认：

- 输出时长与源文件误差不超过 1 秒
- 分辨率/编码符合选定源或明确记录了转码
- 视频与目标音频存在，字幕轨有非零 packet（软字幕时）
- 只有一个翻译字幕轨为默认
- SRT 与 ASS 逻辑 cue 数一致，或差异有书面理由
- 无未翻译台词、未解决标记和损坏

向用户报告成片、外置字幕、真实规格、时长、大小、验证结果和诚实限制。若使用了持久登录，说明存储位置与退出方法。

## 恢复与资源控制

- 任务恢复时先读 manifest，验证现有产物，从第一个未完成阶段继续。
- 下载失败时保留 partial 与日志，检查直连/代理后只重试当前阶段。
- 磁盘空间不足时先报告预计需求并停止；不要边下载边赌空间。
- 源没有可用音频或受 DRM 保护时说明限制，不绕过保护。
- 长任务持续向用户报告阶段、媒体时间进度、输出大小和磁盘余量。

## 内置资源

- [references/source-acquisition.md](references/source-acquisition.md)：下载、授权登录、代理和低内存处理
- [references/research-and-translation.md](references/research-and-translation.md)：证据层级、日语翻译、词表、OCR 与分块协议
- [references/subtitle-qc-and-mux.md](references/subtitle-qc-and-mux.md)：字幕样式、封装命令、验收测试和交付格式
- [references/execution-contract.md](references/execution-contract.md)：单模型工具路由、cue JSON、OCR、难点内容和量化门槛
- `scripts/init_job.py`：创建任务目录与 manifest
- `scripts/check_environment.py`：检查视频源所需工具
- `scripts/inspect_media.py`：使用 FFprobe 读取真实媒体规格
- `scripts/validate_subtitles.py`：检查 SRT/ASS 结构、时间、可读性和未解决标记
- `scripts/verify_mux.py`：检查媒体流、语言/默认轨、时长与完整读取
- `scripts/render_subtitles.py`：从统一 cue JSON 生成 SRT 与成员色/发光 ASS
- `scripts/measure_subtitles.py`：用 FFmpeg/libass 测量实际渲染宽度和孤行
