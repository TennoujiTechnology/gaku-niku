import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the subtitle studio product", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>自学型熟肉机<\/title>/i);
  assert.match(html, /自学型熟肉机/);
  assert.match(html, /工作流概览/);
  assert.match(html, /适度放行（推荐）/);
  assert.match(html, /检索并检查预习结果/);
  assert.match(html, /设置并测试翻译引擎/);
  assert.match(html, /API 模式/);
  assert.match(html, /Agent Skill/);
  assert.match(html, /GakuNiku/);
  assert.match(html, /用量估算/);
  assert.match(html, /合计/);
  assert.match(html, /缓存命中/);
  assert.match(html, /费用/);
  assert.match(html, /后端(?:<!-- -->)?(?:已连接|检查中|未连接)/);
  assert.doesNotMatch(html, /aria-label="帮助"/);
  assert.doesNotMatch(html, />输入 Token</);
  assert.doesNotMatch(html, />输出 Token</);
  assert.match(html, /API 计费规则/);
  assert.match(html, /class="brand-mark"/);
  assert.match(html, /下一步行动/);
  assert.doesNotMatch(html, /Your site is taking shape|react-loading-skeleton/);
});

test("ships the real harness and low-memory local bridge", async () => {
  const [component, bridge, apiHelper, skill, packageJson] = await Promise.all([
    readFile(new URL("../app/SubtitleStudio.tsx", import.meta.url), "utf8"),
    readFile(new URL("../local-agent-bridge/server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../local-agent-bridge/api-model-call.mjs", import.meta.url), "utf8"),
    readFile(new URL("../harness/precision-video-subtitles/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  for (const phrase of ["Bilibili", "YouTube", "yt-dlp", "逐句精修", "最多两行", "角色色效果"]) {
    assert.match(component, new RegExp(phrase));
  }
  for (const phrase of ["选择工具", "手型平移工具", "删除工具", "Shift + 滚轮缩放", "调整视频预览与字幕样式面板宽度", "调整时间轴工作区高度", "调整逐句列表与单句编辑器宽度", "撤回（⌘/Ctrl+Z）", "重做（⌘/Ctrl+Shift+Z 或 Ctrl+Y）"]) {
    assert.match(component, new RegExp(phrase.replace(/[+]/g, "\\+")));
  }
  for (const phrase of [
    "检索并生成预习结果文档",
    "人物／成员色与应援色",
    "固定检索项",
    "默认直接采用，无需额外确认",
    "人物身份成对、只建一个元素",
    "当前任务的外部模型处理",
    "识别出的人物实体",
    "角色发言",
    "声优本人",
    "设置并测试翻译引擎",
    "测试文字与图片能力",
    "关闭代理并重新测试",
    "API 模式",
    "Agent Skill",
    "简单稳定 · 大多数用户推荐",
    "推荐配置",
    "采用推荐参数并检查",
    "开始翻译并统一检查",
    "工作流概览",
    "下一步行动",
    "原文听写引擎",
    "检查依赖，再决定是否下载",
    "检查当前环境",
    "模型与项目数据文件夹",
    "立即配置缺失环境",
    "已下载的模型不会重复下载",
    "安全配置本地环境",
    "Sherpa-ONNX 本地说话人分离（推荐）",
    "OPTIONAL ENHANCEMENT",
    "暂不使用说话人分离",
    "只补齐当前增强能力",
    "WhisperX / pyannote（高级 · 需 HF 权限）",
    "本次配置为什么没有完成",
    "让第一步模型辅助分析",
    "模型只读取脱敏检查结果",
    "可选：用当前视频测试约 20 秒",
    "真实短音频测试是可选的质量诊断",
    "Faster-Whisper",
    "OpenAI Audio API",
    "模型质量",
    "词级时间戳",
    "说话人分离",
    "思考强度",
    "本地知识库",
    "文字与图片能力测试",
    "本版推荐",
    "检查更新",
    "账户其他模型",
    "保存到本机浏览器",
    "官方文档核对",
    "给第一步模型配置联网检索",
    "Exa Search MCP",
    "测试搜索工具",
    "网络代理",
    "使用网络代理",
    "使用检测值",
    "Clash Verge",
    "保存到本机",
    "更新本地设置",
    "清除记录",
    "已沿用验证",
    "已沿用上次验证",
    "检索过程",
    "显示 Agent 执行轨迹",
    "查看与修改执行规范",
    "疑点复核强度",
    "适度放行（推荐）",
    "只深查可能改变意思的内容",
    "当前任务覆盖稿",
    "保存并关闭",
    "OpenCode",
    "Pi coding agent",
    "Cline CLI",
    "打开项目",
    "保存项目",
    "同步精修",
    "从断点继续",
    "允许当前任务使用外部模型",
    "允许上述服务仅为本次字幕任务处理这些数据",
    "成片说明",
  ]) {
    assert.match(component, new RegExp(phrase));
  }
  assert.match(component, /function returnHomeAfterTermination/);
  assert.match(component, /localStorage\.removeItem\(ACTIVE_JOB_STORE\)/);
  assert.match(component, /setWorkspace\("prepare"\)/);
  assert.match(component, /从历史任务中重新打开/);
  const projectSnapshotSource = component.slice(component.indexOf("function currentProjectSnapshot"), component.indexOf("function saveStudioProject"));
  assert.match(projectSnapshotSource, /gakuniku-project|PROJECT_FILE_FORMAT/);
  assert.doesNotMatch(projectSnapshotSource, /\bapiKey\b|\bhfToken\b|\bsearchApiKey\b|\btranscriptionApiKey\b/);
  assert.match(component, /parseProjectFile/);
  assert.match(component, /\.gakuniku/);
  assert.match(component, /本地部署模型/);
  assert.match(component, /后端\{bridgeStatus/);
  assert.doesNotMatch(component, /aria-label="帮助"/);
  assert.doesNotMatch(component, /本地显存/);
  assert.doesNotMatch(component, /验证文字指令、格式约束与图片 OCR/);
  assert.doesNotMatch(component, /密钥默认只暂存在当前标签页/);
  assert.doesNotMatch(component, /模型测试可以稍后完成/);
  assert.doesNotMatch(component, /听写引擎尚未通过当前视频的真实短音频测试/);
  assert.doesNotMatch(component, /请先让当前视频通过真实短音频听写测试/);
  assert.doesNotMatch(component, /自动读取最新模型目录/);
  assert.doesNotMatch(component, /syncProviderModels\(\{ automatic/);
  assert.doesNotMatch(component, /本地视频还需通过短音频测试/);
  assert.doesNotMatch(component, /requiresTranscriptionSampleTest|transcriptionTestFingerprint/i);
  assert.doesNotMatch(component, /尚未确认 Precision harness|允许本任务使用外部模型？|externalConsentOpen/);
  assert.match(component, /环境位置、依赖与下载选项/);
  assert.match(component, /transcriptionRequestedReady/);
  assert.match(component, /transcriptionDiarizationNeedsSetup/);
  assert.match(component, /prepareDiarizationEnvironment/);
  assert.match(component, /deliveryConstraints/);
  assert.match(component, /ENGINE_VERIFICATION_STORE/);
  assert.match(component, /SEARCH_VERIFICATION_STORE/);
  assert.match(component, /credentialSignature/);
  assert.match(component, /MAX_REVIEW_HISTORY = 100/);
  assert.match(component, /window\.addEventListener\("keydown", handleReviewHistoryShortcut\)/);
  assert.match(component, /rememberReviewState\(`cue:\$\{drag\.cueId\}:timeline-drag`\)/);
  assert.match(component, /const visibleCue = cues\.find\(\(cue\) => currentTime >= cue\.start && currentTime < cue\.end\);/);
  assert.doesNotMatch(component, /const currentCue = cues\.find[\s\S]{0,160}\?\? selectedCue/);
  assert.match(bridge, /用户确认的本次成片约束/);
  assert.match(bridge, /必须把主要人物的角色色、成员色或应援色作为独立检索项目/);
  assert.match(bridge, /角色与成员色/);
  assert.match(bridge, /角色名与对应声优必须写入同一 speaker_entity_id/);
  assert.match(bridge, /一个角色及其对应声优\/出演者只能生成一个人物实体/);
  assert.match(bridge, /function normalizeStudioReview/);
  assert.match(bridge, /manifest\.limitations 只记录尚未解决/);
  assert.match(skill, /informational style provenance, not a delivery limitation/);
  assert.match(bridge, /127\.0\.0\.1/);
  assert.doesNotMatch(component, /fieldset className="step-fields" disabled=\{!engineVerified\}/);
  assert.doesNotMatch(component, /模型测试通过后解锁|待解锁/);
  assert.match(bridge, /child\.stdout\.pipe\(outputLog\)/);
  assert.match(bridge, /apiKey: config\.engine\?\.apiKey \? "\[provided at launch only\]"/);
  assert.match(bridge, /\/api\/research\/preview/);
  assert.match(bridge, /\/api\/research\/search-test/);
  assert.match(bridge, /researchStatusMatch/);
  assert.match(bridge, /mcp\.exa\.ai\/mcp/);
  assert.match(bridge, /mcp\.tavily\.com\/mcp/);
  assert.match(bridge, /researchAgentConfig/);
  assert.match(bridge, /researchEvents/);
  assert.match(bridge, /\/api\/engine\/test/);
  assert.match(bridge, /\/api\/engine\/models/);
  for (const model of ["gpt-5.6", "grok-4.6", "kimi-k3", "mimo-v2.5", "glm-5v-turbo"]) {
    assert.match(bridge, new RegExp(model.replaceAll(".", "\\.")));
  }
  assert.match(bridge, /不能通过本项目必需的图片能力测试/);
  assert.match(component, /grok-4\.6/);
  assert.match(component, /MODEL_CATALOG_STORE/);
  assert.match(component, /readModelCatalog/);
  assert.match(bridge, /language-models/);
  assert.match(bridge, /fetchedAt/);
  assert.match(bridge, /\/api\/knowledge/);
  assert.match(bridge, /name === "opencode"/);
  assert.match(bridge, /name === "pi"/);
  assert.match(bridge, /name === "cline"/);
  assert.match(bridge, /generateResearchWithCli/);
  assert.match(bridge, /generateResearchWithSelectedEngine/);
  assert.match(bridge, /ProxyAgent/);
  assert.match(bridge, /clashVergeProxySuggestion/);
  assert.match(bridge, /verge_mixed_port/);
  assert.match(bridge, /proxySuggestion/);
  assert.match(bridge, /已跳过并继续/);
  assert.match(bridge, /Agent 编排通道响应较慢/);
  assert.match(bridge, /不得从零重复通用检索/);
  assert.match(bridge, /每次终端回显控制在 4 KB 内/);
  assert.match(bridge, /"--disable", "plugins"/);
  assert.match(bridge, /"--disable", "apps"/);
  assert.match(bridge, /"--disable", "tool_suggest"/);
  assert.match(bridge, /await startResearchRun\(body\.engine/);
  assert.doesNotMatch(bridge, /const researchEngine = body\.engine\?\.mode === "cli"/);
  assert.match(bridge, /researchKnowledgeContext/);
  assert.match(bridge, /testLocalEngine/);
  assert.match(bridge, /runMultimodalEngineTest/);
  assert.match(bridge, /createEngineChallenge/);
  assert.match(bridge, /data:image\/png;base64/);
  assert.match(bridge, /proxySuspected/);
  assert.match(bridge, /body\.multimodal !== true/);
  assert.match(bridge, /PSS_TRANSCRIPTION_PROVIDER/);
  assert.match(bridge, /PSS_TRANSCRIPTION_API_KEY/);
  assert.match(bridge, /PSS_TRANSCRIPTION_DIARIZATION_PYTHON/);
  assert.match(bridge, /hfToken: config\.transcription\?\.hfToken \? "\[provided at launch only\]"/);
  assert.match(bridge, /\.staging-\$\{operation\.id\}/);
  assert.match(bridge, /UV_LINK_MODE: "copy"/);
  assert.match(bridge, /modelFile\.size > 10_000_000/);
  assert.match(bridge, /需要 Python 3\.10–3\.13/);
  assert.match(bridge, /Sherpa-ONNX 本地说话人分离真实推理预检/);
  assert.match(bridge, /模块首次加载超过/);
  assert.match(bridge, /验证基础运行库/);
  assert.match(bridge, /\/api\/transcription\/check/);
  assert.match(bridge, /\/api\/transcription\/install/);
  assert.match(bridge, /\/api\/transcription\/test/);
  assert.match(bridge, /\/resume/);
  assert.match(bridge, /\/cancel/);
  assert.match(bridge, /terminateJob/);
  assert.match(bridge, /stopJobProcessTree/);
  assert.match(bridge, /status: "cancelled"/);
  assert.match(bridge, /validateResumeManifest/);
  assert.match(bridge, /jobDiagnostics/);
  assert.match(bridge, /jobResources/);
  assert.match(bridge, /gpt-4o-transcribe-diarize/);
  assert.match(bridge, /diarize_model=latest/);
  assert.match(bridge, /reasoning_effort/);
  assert.match(bridge, /ambiguityReviewPolicyPrompt/);
  assert.match(bridge, /workflowPhaseStatus/);
  assert.doesNotMatch(bridge, /疑点必须跳到附近时间抽帧\/OCR/);
  assert.match(bridge, /PSS_API_PROVIDER/);
  assert.match(bridge, /verifiedExternalProcessingConsent/);
  assert.match(bridge, /外部处理知情授权/);
  assert.match(bridge, /不得再次因为发送已授权的听写文本/);
  assert.match(apiHelper, /single|单次模型输入不能超过 2 MB/);
  assert.match(apiHelper, /PSS_API_KEY/);
  assert.match(apiHelper, /tokenUsage/);
  assert.match(skill, /Never load a full long video\/audio into memory/);
  assert.match(skill, /Honor the job's explicit transcription configuration/);
  assert.match(skill, /maximum.*second pass/);
  assert.match(skill, /accepted_risk/);
  assert.match(skill, /Low ASR confidence alone does not make a cue critical/);
  assert.match(skill, /Never print a complete result file back into the Agent transcript/);
  assert.match(skill, /user-approved research preview/);
  assert.match(skill, /member_color.*color_hex.*color_scope.*color_source_url.*color_confidence/);
  assert.match(skill, /one linked speaker entity, not two independent people/);
  assert.match(component, /终止任务/);
  assert.match(component, /确认终止当前任务/);
  assert.match(component, /\/cancel/);
  assert.match(component, /className="topbar-terminate-button"/);
  assert.match(component, /terminateConfirmOpen && jobId/);
  assert.doesNotMatch(component, /jobRunStatus === "running" && !terminateConfirmOpen/);
  assert.match(component, /本版推荐/);
  assert.match(component, /检查更新/);
  assert.match(component, /推荐多模态模型/);
  assert.match(component, /model-catalogs\.v2/);
  assert.doesNotMatch(component, /syncProviderModels\(\{ automatic:/);
  assert.match(component, /glm-5v-turbo/);
  assert.match(component, /mimo-v2\.5 是原生全模态模型/);
  assert.match(packageJson, /"bridge": "node local-agent-bridge\/server\.mjs"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
  await access(new URL("../.openai/hosting.json", import.meta.url));
});
