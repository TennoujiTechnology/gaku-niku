import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ProxyAgent } from "undici";

const bridgeDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(bridgeDirectory, "..");
const apiHelperPath = path.join(bridgeDirectory, "api-model-call.mjs");
const manifestHelperPath = path.join(bridgeDirectory, "manifest-update.mjs");
const harnessScripts = path.join(projectRoot, "harness", "precision-video-subtitles", "scripts");
const phaseIds = ["acquire", "research", "source_transcript", "translate", "resolve_ambiguities", "subtitle_qc", "mux", "final_validation"];
const args = process.argv.slice(2);
const valueAfter = (flag) => args[args.indexOf(flag) + 1] || "";
const jobDirectory = path.resolve(valueAfter("--job-dir"));
const promptPath = path.resolve(valueAfter("--prompt"));
if (!jobDirectory || !promptPath) throw new Error("用法: node builtin-harness-runner.mjs --job-dir JOB --prompt PROMPT.md");

const config = JSON.parse(await readFile(path.join(jobDirectory, "studio-job.json"), "utf8"));
const taskPrompt = await readFile(promptPath, "utf8");
const stateDirectory = path.join(jobDirectory, "work", "builtin-harness");
await mkdir(stateDirectory, { recursive: true });

function emit(text, extra = {}) {
  process.stdout.write(`${JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: String(text).slice(0, 4000) },
    harness: "gakuniku-builtin-v1",
    at: new Date().toISOString(),
    ...extra,
  })}\n`);
}

function expandHome(value) {
  const text = String(value || "");
  return text.startsWith("~/") ? path.join(os.homedir(), text.slice(2)) : text;
}

const sourcePath = /^file:\/\//i.test(String(config.source || ""))
  ? decodeURIComponent(new URL(config.source).pathname)
  : path.isAbsolute(expandHome(config.source)) ? expandHome(config.source) : "";
const outputRoot = path.resolve(expandHome(config.outputPath || path.join(jobDirectory, "deliverables")));
const configuredToolRoots = [
  process.env.PSS_TRANSCRIPTION_MODEL_CACHE,
  process.env.PSS_TRANSCRIPTION_DIARIZATION_SEGMENTATION_MODEL,
  process.env.PSS_TRANSCRIPTION_DIARIZATION_EMBEDDING_MODEL,
].map((value) => String(value || "").trim()).filter(Boolean).map(expandHome);
const readableRoots = [projectRoot, jobDirectory, outputRoot, ...configuredToolRoots, ...(sourcePath ? [sourcePath] : [])];
const writableRoots = [jobDirectory, outputRoot];

function within(candidate, root) {
  const target = path.resolve(candidate);
  const base = path.resolve(root);
  return target === base || target.startsWith(`${base}${path.sep}`);
}

function checkedPath(value, mode = "read") {
  const candidate = path.resolve(jobDirectory, expandHome(value));
  const roots = mode === "write" ? writableRoots : readableRoots;
  if (!roots.some((root) => within(candidate, root))) throw new Error(`Harness 拒绝访问未授权路径：${candidate}`);
  return candidate;
}

function executableOnPath(name) {
  const names = process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const directory of String(process.env.PATH || "").split(path.delimiter)) {
    for (const file of names) {
      const candidate = path.join(directory, file);
      if (existsSync(candidate)) return candidate;
    }
  }
  return "";
}

function validateProcessPaths(commandArgs) {
  for (const value of commandArgs) {
    const argument = String(value);
    if (/^https?:\/\//i.test(argument)) continue;
    const candidates = [];
    if (argument.startsWith("file://")) candidates.push(decodeURIComponent(new URL(argument).pathname));
    else if (path.isAbsolute(expandHome(argument)) || argument.startsWith("~/")) candidates.push(expandHome(argument));
    for (const match of argument.matchAll(/(?:^|[=,:])((?:\/[^,;\]]+)|(?:[A-Za-z]:\\[^,;\]]+))/g)) candidates.push(match[1]);
    for (const candidate of candidates) {
      const resolved = path.resolve(expandHome(candidate));
      if (![...readableRoots, ...writableRoots].some((root) => within(resolved, root))) throw new Error(`Harness 拒绝把未授权路径交给子进程：${resolved}`);
    }
  }
}

function runProcess(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd || jobDirectory,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const append = (current, chunk) => `${current}${chunk}`.slice(-96 * 1024);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function modelCall(input, label = "model") {
  const id = `${String(label).replace(/[^a-z0-9-]+/gi, "-")}-${randomUUID()}`;
  const inputFile = path.join(stateDirectory, `${id}.input.json`);
  const outputFile = path.join(stateDirectory, `${id}.output.json`);
  await writeFile(inputFile, `${JSON.stringify(input)}\n`, "utf8");
  const result = await runProcess(process.execPath, [apiHelperPath, inputFile, outputFile], { cwd: jobDirectory });
  if (result.code !== 0) throw new Error((result.stderr || result.stdout || `模型调用失败（${result.code}）`).slice(-4000));
  return JSON.parse(await readFile(outputFile, "utf8"));
}

function parseJsonReply(value) {
  const source = String(value || "").trim();
  const unfenced = source.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try { return JSON.parse(unfenced); } catch { /* extract one object below */ }
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(unfenced.slice(start, end + 1));
  throw new Error("模型没有返回 Harness 要求的 JSON 动作");
}

function summarizeResult(value, limit = 24_000) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.floor(limit * 0.7))}\n…[中间内容已落盘，省略 ${text.length - limit} 字符]…\n${text.slice(-Math.floor(limit * 0.3))}`;
}

function imageContent(file) {
  const extension = path.extname(file).toLowerCase();
  const mime = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg";
  return readFile(file).then((bytes) => ({ type: "image_url", image_url: { url: `data:${mime};base64,${bytes.toString("base64")}` } }));
}

function mcpHeaders(sessionId = "") {
  const provider = process.env.PSS_SEARCH_PROVIDER || "exa";
  const key = process.env.PSS_SEARCH_MCP_KEY || "";
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    ...(provider === "exa" && key ? { "x-api-key": key } : {}),
    ...(["tavily", "custom"].includes(provider) && key ? { authorization: `Bearer ${key}` } : {}),
  };
}

function parseMcp(raw, requestId) {
  const candidates = [];
  try { candidates.push(JSON.parse(raw)); } catch { /* SSE response */ }
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try { candidates.push(JSON.parse(line.slice(5).trim())); } catch { /* keep-alive */ }
  }
  const message = candidates.find((item) => item?.id === requestId) || candidates.at(-1);
  if (message?.error) throw new Error(message.error.message || "MCP 调用失败");
  return message?.result || {};
}

async function mcpRequest(state, method, params = {}, notification = false) {
  const url = process.env.PSS_SEARCH_MCP_URL || "";
  if (!url) throw new Error("API 模式需要 Exa、Tavily 或自定义 MCP；不能使用 Agent 内置搜索");
  const id = notification ? undefined : state.nextId++;
  const proxy = String(process.env.PSS_SEARCH_PROXY_URL || process.env.PSS_PROXY_URL || "").trim();
  const response = await fetch(url, {
    method: "POST",
    headers: mcpHeaders(state.sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }),
    signal: AbortSignal.timeout(45_000),
    ...(proxy ? { dispatcher: new ProxyAgent(proxy) } : {}),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`搜索 MCP HTTP ${response.status}：${raw.slice(0, 500)}`);
  state.sessionId = response.headers.get("mcp-session-id") || state.sessionId;
  return id === undefined ? {} : parseMcp(raw, id);
}

let searchConnection = null;
async function searchWeb(query) {
  if (!searchConnection) {
    const state = { nextId: 1, sessionId: "" };
    await mcpRequest(state, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "gakuniku-builtin-harness", version: "1.0.0" } });
    await mcpRequest(state, "notifications/initialized", {}, true);
    const listed = await mcpRequest(state, "tools/list");
    searchConnection = { state, tools: Array.isArray(listed.tools) ? listed.tools : [] };
  }
  const tool = searchConnection.tools.find((item) => /search/i.test(item.name)) || searchConnection.tools[0];
  if (!tool) throw new Error("搜索 MCP 没有提供工具");
  const properties = tool.inputSchema?.properties || {};
  const toolArgs = properties.query ? { query } : properties.q ? { q: query } : properties.queries ? { queries: [query] } : { query };
  if (properties.numResults) toolArgs.numResults = 6;
  if (properties.max_results) toolArgs.max_results = 6;
  const response = await mcpRequest(searchConnection.state, "tools/call", { name: tool.name, arguments: toolArgs });
  if (response.isError) throw new Error("搜索 MCP 返回工具错误");
  return response;
}

const toolScripts = {
  inspect_media: "inspect_media.py",
  transcribe: "transcribe_faster_whisper.py",
  diarize: "diarize_sherpa_onnx.py",
  render_subtitles: "render_subtitles.py",
  measure_subtitles: "measure_subtitles.py",
  validate_subtitles: "validate_subtitles.py",
  verify_mux: "verify_mux.py",
};

async function runHarnessTool(call) {
  const tool = String(call?.tool || "");
  const input = call?.input && typeof call.input === "object" ? call.input : {};
  if (tool === "read_text") {
    const file = checkedPath(input.path);
    const text = await readFile(file, "utf8");
    return { path: file, text: summarizeResult(text, Math.min(80_000, Number(input.maxChars || 40_000))) };
  }
  if (tool === "list_files") {
    const directory = checkedPath(input.path || jobDirectory);
    const names = await readdir(directory, { withFileTypes: true });
    return { path: directory, entries: names.slice(0, 500).map((item) => ({ name: item.name, type: item.isDirectory() ? "directory" : "file" })) };
  }
  if (tool === "write_text") {
    const file = checkedPath(input.path, "write");
    const content = String(input.content || "");
    if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error("单次写入超过 2 MB，请分文件写入");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
    return { path: file, bytes: Buffer.byteLength(content) };
  }
  if (tool === "copy_file") {
    const source = checkedPath(input.source);
    const destination = checkedPath(input.destination, "write");
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    return { source, destination, bytes: (await stat(destination)).size };
  }
  if (tool === "update_manifest") {
    const patchFile = path.join(stateDirectory, `manifest-patch-${randomUUID()}.json`);
    await writeFile(patchFile, `${JSON.stringify(input.patch || {})}\n`, "utf8");
    const result = await runProcess(process.execPath, [manifestHelperPath, path.join(jobDirectory, "manifest.json"), patchFile]);
    if (result.code !== 0) throw new Error((result.stderr || result.stdout || "Manifest 更新失败").slice(-3000));
    return { updated: true, output: result.stdout.slice(-2000) };
  }
  if (tool === "run") {
    const id = String(input.id || "");
    const toolArgs = Array.isArray(input.args) ? input.args.map(String) : [];
    let command = "";
    let commandArgs = toolArgs;
    if (["ffmpeg", "ffprobe", "yt-dlp", "yutto"].includes(id)) command = executableOnPath(id);
    else if (toolScripts[id]) {
      command = id === "transcribe"
        ? process.env.PSS_TRANSCRIPTION_PYTHON || executableOnPath("python3") || executableOnPath("python")
        : id === "diarize"
          ? process.env.PSS_TRANSCRIPTION_DIARIZATION_PYTHON || executableOnPath("python3") || executableOnPath("python")
          : executableOnPath("python3") || executableOnPath("python");
      commandArgs = [path.join(harnessScripts, toolScripts[id]), ...toolArgs];
      if (id === "transcribe") {
        const cache = String(process.env.PSS_TRANSCRIPTION_MODEL_CACHE || "").trim();
        if (cache && !toolArgs.includes("--model-cache")) commandArgs.push("--model-cache", cache);
        const model = String(config.transcription?.model || "").trim();
        if (model && !toolArgs.includes("--model")) commandArgs.push("--model", model);
        const language = String(config.transcription?.language || "").trim();
        if (language && !toolArgs.includes("--language")) commandArgs.push("--language", language);
      }
      if (id === "diarize") {
        const segmentation = String(process.env.PSS_TRANSCRIPTION_DIARIZATION_SEGMENTATION_MODEL || "").trim();
        const embedding = String(process.env.PSS_TRANSCRIPTION_DIARIZATION_EMBEDDING_MODEL || "").trim();
        if (segmentation && !toolArgs.includes("--segmentation-model")) commandArgs.push("--segmentation-model", segmentation);
        if (embedding && !toolArgs.includes("--embedding-model")) commandArgs.push("--embedding-model", embedding);
      }
    }
    if (!command) throw new Error(`工具不可用或未获 Harness 授权：${id}`);
    validateProcessPaths(commandArgs);
    const result = await runProcess(command, commandArgs);
    if (result.code !== 0) throw new Error(`${id} 失败（${result.code}）：${(result.stderr || result.stdout).slice(-5000)}`);
    return { id, code: result.code, stdout: summarizeResult(result.stdout, 12_000), stderr: summarizeResult(result.stderr, 6000) };
  }
  if (tool === "model_task") {
    const prompt = String(input.prompt || "");
    const system = String(input.system || "你是 GakuNiku 字幕工程的语义处理模型。只根据给定证据完成任务，不得虚构。");
    const images = Array.isArray(input.images) ? input.images.slice(0, 4).map((item) => checkedPath(item)) : [];
    const content = images.length ? [{ type: "text", text: prompt }, ...(await Promise.all(images.map(imageContent)))] : prompt;
    return modelCall({ messages: [{ role: "system", content: system }, { role: "user", content }], maxTokens: Math.min(12_000, Math.max(256, Number(input.maxTokens || 5000))), timeoutMs: 180_000 }, "task");
  }
  if (tool === "model_batch") {
    const items = Array.isArray(input.items) ? input.items : [];
    if (!items.length || items.length > 500) throw new Error("model_batch 需要 1–500 个项目");
    return modelCall({
      batchItems: items,
      batchInstruction: String(input.instruction || "逐项处理并保留 id"),
      batchSystem: String(input.system || "你是 GakuNiku 字幕工程的语义处理模型。"),
      estimatedOutputTokensPerItem: Math.max(32, Number(input.estimatedOutputTokensPerItem || 220)),
      maxItemsPerCall: Math.max(1, Number(input.maxItemsPerCall || 24)),
      maxTokens: Math.min(12_000, Math.max(512, Number(input.maxTokens || 6000))),
      timeoutMs: 180_000,
    }, "batch");
  }
  if (tool === "web_search") return searchWeb(String(input.query || "").slice(0, 1000));
  throw new Error(`未知 Harness 工具：${tool}`);
}

const toolContract = `
你是用户在 GakuNiku 第一步选定并通过图文测试的模型，也是本任务唯一的规划与语义决策者。你不依赖 Codex、Claude 或其他 Agent CLI。项目自带的 Built-in Harness 只执行你发出的安全结构化动作。

每一轮只能返回一个 JSON 对象，不要 Markdown：
1. 调工具：{"type":"tool","summary":"给用户看的当前动作","calls":[{"tool":"工具名","input":{}}]}
2. 完成：{"type":"finish","summary":"完成摘要"}
允许的工具：
- read_text {path,maxChars}；list_files {path}；write_text {path,content}；copy_file {source,destination}
- update_manifest {patch}：唯一允许的 manifest 更新方式
- run {id,args}，id 仅限 ffmpeg、ffprobe、yt-dlp、yutto、inspect_media、transcribe、diarize、render_subtitles、measure_subtitles、validate_subtitles、verify_mux
- web_search {query}：调用首页配置的搜索 MCP；单个网站失败时换来源继续
- model_task {system,prompt,images,maxTokens}：让同一个首页模型处理有界语义任务或图片 OCR
- model_batch {system,instruction,items,maxTokens,estimatedOutputTokensPerItem,maxItemsPerCall}：用同一模型自适应分批处理字幕

约束：先读取 Skill 与直接引用的 reference；每轮最多 4 个相互独立的调用；不得要求 shell、删除工具、任意 Python/Node 代码或未列出的程序；不得读取工作区外文件；所有大结果落盘。遇到工具失败先根据返回信息修正参数，连续两次同因失败则把当前阶段标 blocked 并 finish。只有 manifest 八阶段全部完成或已明确 blocked 后才能 finish。`;

let transcript = [];
let invalidReplies = 0;
emit(`内置 Harness 已启动：${process.env.PSS_API_PROVIDER || "API"}/${process.env.PSS_API_MODEL || "model"} 将直接负责规划与语义工作，不调用外部 Agent CLI。`);

for (let turn = 1; turn <= 160; turn += 1) {
  const messages = [
    { role: "system", content: toolContract },
    { role: "user", content: taskPrompt },
    ...transcript.slice(-18),
    { role: "user", content: `这是 Harness 第 ${turn} 轮。检查任务目录与 manifest 后选择下一组最小动作。` },
  ];
  let decision;
  try {
    const reply = await modelCall({ messages, maxTokens: 2200, timeoutMs: 180_000 }, "controller");
    decision = parseJsonReply(reply.text);
    transcript.push({ role: "assistant", content: summarizeResult(reply.text, 8000) });
    invalidReplies = 0;
  } catch (error) {
    invalidReplies += 1;
    transcript.push({ role: "user", content: `上一轮无法执行：${error instanceof Error ? error.message : String(error)}。只返回规定 JSON。` });
    emit(`Harness 无法解析模型动作，正在要求同一模型纠正（${invalidReplies}/3）`);
    if (invalidReplies < 3) continue;
    const manifest = JSON.parse(await readFile(path.join(jobDirectory, "manifest.json"), "utf8"));
    const phase = phaseIds.find((id) => !["complete", "completed", "skipped"].includes(String(manifest.phases?.[id]?.status))) || "acquire";
    await runHarnessTool({ tool: "update_manifest", input: { patch: { phases: { [phase]: { status: "blocked", reason: "首页模型连续三次没有返回可执行的 Harness JSON 动作", evidence: [] } }, limitations: ["首页模型无法遵循内置 Harness 动作协议；请降低思考强度、换用支持结构化输出的多模态模型，或改用 Agent Skill。"] } } });
    process.exitCode = 2;
    break;
  }

  emit(String(decision.summary || `Harness 第 ${turn} 轮`));
  if (decision.type === "finish") {
    const manifest = JSON.parse(await readFile(path.join(jobDirectory, "manifest.json"), "utf8"));
    const incomplete = phaseIds.find((id) => !["complete", "completed", "skipped", "blocked", "error"].includes(String(manifest.phases?.[id]?.status)));
    if (incomplete) {
      transcript.push({ role: "user", content: `不能完成：manifest 的 ${incomplete} 仍未结束。继续执行或明确标为 blocked。` });
      continue;
    }
    break;
  }
  const calls = Array.isArray(decision.calls) ? decision.calls.slice(0, 4) : [];
  if (decision.type !== "tool" || !calls.length) {
    transcript.push({ role: "user", content: "动作无效：type 必须是 tool 且 calls 非空，或 type=finish。" });
    continue;
  }
  const results = [];
  for (const call of calls) {
    try {
      emit(`执行：${call.tool}`);
      const result = await runHarnessTool(call);
      results.push({ tool: call.tool, ok: true, result });
    } catch (error) {
      results.push({ tool: call.tool, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const record = { turn, calls, results };
  await writeFile(path.join(stateDirectory, `turn-${String(turn).padStart(3, "0")}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  transcript.push({ role: "user", content: `Harness 工具结果：\n${summarizeResult(results, 50_000)}\n完整记录已保存到 work/builtin-harness/turn-${String(turn).padStart(3, "0")}.json` });
}

const finalManifest = JSON.parse(await readFile(path.join(jobDirectory, "manifest.json"), "utf8"));
const unfinished = phaseIds.filter((id) => !["complete", "completed", "skipped"].includes(String(finalManifest.phases?.[id]?.status)));
if (unfinished.length && !unfinished.some((id) => ["blocked", "error"].includes(String(finalManifest.phases?.[id]?.status)))) {
  emit(`Harness 达到轮次上限，仍未完成：${unfinished.join("、")}`);
  process.exitCode = 2;
}
