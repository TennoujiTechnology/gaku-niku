import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
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
const researchMaterializerPath = path.join(harnessScripts, "materialize_research_preview.mjs");
const transcribeMediaPath = path.join(harnessScripts, "transcribe_media.py");
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
const harnessRoot = path.join(projectRoot, "harness", "precision-video-subtitles");
const readableRoots = [harnessRoot, jobDirectory, outputRoot, ...configuredToolRoots, ...(sourcePath ? [sourcePath] : [])];
const writableRoots = [jobDirectory, outputRoot];

class HarnessModelError extends Error {
  constructor(code, message, diagnostic = null) {
    super(message);
    this.name = "HarnessModelError";
    this.code = code || "MODEL_CALL_ERROR";
    this.diagnostic = diagnostic;
  }
}

class HarnessProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HarnessProtocolError";
    this.code = code;
  }
}

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
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
      options.onStdout?.(String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
      options.onStderr?.(String(chunk));
    });
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
  if (result.code !== 0) {
    const diagnosticFile = `${outputFile}.error.json`;
    const diagnostic = await readFile(diagnosticFile, "utf8").then(JSON.parse).catch(() => null);
    const code = String(diagnostic?.code || (/timeout/i.test(result.stderr) ? "MODEL_TIMEOUT" : "MODEL_CALL_ERROR"));
    const detail = String(diagnostic?.message || result.stderr || result.stdout || `模型调用失败（${result.code}）`).slice(-4000);
    throw new HarnessModelError(code, detail, diagnostic ? { ...diagnostic, diagnosticFile } : { diagnosticFile });
  }
  return JSON.parse(await readFile(outputFile, "utf8"));
}

function parseJsonReply(value) {
  const source = String(value || "").trim();
  if (!source) throw new HarnessProtocolError("PROTOCOL_EMPTY", "模型返回了空动作正文");
  const fenced = source.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1] : source;
  let parsed;
  try { parsed = JSON.parse(candidate); }
  catch (jsonError) {
    if (/<tool_call>/i.test(source)) parsed = parseLegacyXmlReply(source);
    else {
      const format = /<function=|<parameter=/i.test(source) ? "未知 XML 工具格式" : "非 JSON 文本";
      throw new HarnessProtocolError("PROTOCOL_INVALID_JSON", `模型返回了${format}；Harness 需要一个完整结构化动作（${jsonError.message}）`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HarnessProtocolError("PROTOCOL_INVALID_SCHEMA", "Harness 动作必须是 JSON 对象");
  if (parsed.type === "tool" && typeof parsed.calls === "string") {
    if (Buffer.byteLength(parsed.calls) > 256 * 1024) throw new HarnessProtocolError("PROTOCOL_INVALID_SCHEMA", "calls 字符串超过 256 KB，拒绝兼容解析");
    let recovered;
    try { recovered = JSON.parse(parsed.calls); }
    catch (error) { throw new HarnessProtocolError("PROTOCOL_INVALID_SCHEMA", `calls 被错误序列化为字符串且不是有效 JSON 数组：${error.message}`); }
    if (!Array.isArray(recovered)) throw new HarnessProtocolError("PROTOCOL_INVALID_SCHEMA", "calls 字符串解析后必须是数组");
    parsed.calls = recovered;
    Object.defineProperty(parsed, "_protocolRepair", { value: "stringified_calls", enumerable: false });
  }
  if (parsed.type === "finish") return parsed;
  if (parsed.type !== "tool" || !Array.isArray(parsed.calls) || !parsed.calls.length) {
    throw new HarnessProtocolError("PROTOCOL_INVALID_SCHEMA", "type 必须是 tool 且 calls 非空，或 type=finish");
  }
  for (const [index, call] of parsed.calls.slice(0, 4).entries()) {
    if (!call || typeof call !== "object" || typeof call.tool !== "string" || !call.tool.trim()) {
      throw new HarnessProtocolError("PROTOCOL_INVALID_SCHEMA", `calls[${index}] 缺少 tool`);
    }
    if (call.input != null && (typeof call.input !== "object" || Array.isArray(call.input))) {
      throw new HarnessProtocolError("PROTOCOL_INVALID_SCHEMA", `calls[${index}].input 必须是对象`);
    }
  }
  return parsed;
}

function xmlTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "i"));
  return match?.[1]?.trim() || "";
}

function parseLegacyXmlReply(source) {
  const blocks = [...source.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi)].map((match) => match[1]);
  const outside = source.replace(/<tool_call>\s*[\s\S]*?\s*<\/tool_call>/gi, "").trim();
  if (!blocks.length || outside) throw new HarnessProtocolError("PROTOCOL_XML_MALFORMED", "XML 兼容格式必须只包含完整 <tool_call> 块");
  const calls = blocks.slice(0, 4).map((block, index) => {
    const tool = xmlTag(block, "tool_name");
    if (!["read_text", "list_files", "update_manifest", "materialize_research_preview"].includes(tool)) {
      throw new HarnessProtocolError("PROTOCOL_XML_UNSAFE_TOOL", `XML calls[${index}] 的工具不在只读/Manifest 兼容白名单：${tool || "空"}`);
    }
    if (tool === "read_text") {
      const pathValue = xmlTag(block, "path");
      if (!pathValue) throw new HarnessProtocolError("PROTOCOL_XML_MALFORMED", `XML calls[${index}] 缺少 path`);
      return { tool, input: { path: pathValue, ...(xmlTag(block, "maxChars") ? { maxChars: Number(xmlTag(block, "maxChars")) } : {}) } };
    }
    if (tool === "list_files") {
      const pathValue = xmlTag(block, "path");
      if (!pathValue) throw new HarnessProtocolError("PROTOCOL_XML_MALFORMED", `XML calls[${index}] 缺少 path`);
      return { tool, input: { path: pathValue } };
    }
    if (tool === "materialize_research_preview") {
      return { tool, input: { ...(xmlTag(block, "previewPath") ? { previewPath: xmlTag(block, "previewPath") } : {}) } };
    }
    const payload = block.replace(/<tool_name>\s*[\s\S]*?\s*<\/tool_name>/i, "").trim();
    try {
      const parsed = JSON.parse(payload);
      return { tool, input: parsed && typeof parsed === "object" ? parsed : {} };
    } catch (error) {
      throw new HarnessProtocolError("PROTOCOL_XML_MALFORMED", `XML update_manifest 不是有效 JSON：${error.message}`);
    }
  });
  return { type: "tool", summary: "兼容转换模型返回的 XML 工具动作", calls };
}

function summarizeResult(value, limit = 24_000) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.floor(limit * 0.7))}\n…[中间内容已落盘，省略 ${text.length - limit} 字符]…\n${text.slice(-Math.floor(limit * 0.3))}`;
}

async function writeJsonAtomic(file, value) {
  const destination = checkedPath(file, "write");
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, destination);
  return destination;
}

function parseJsonDocument(value, label = "模型输出") {
  const source = String(value || "").trim();
  const fenced = source.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1].trim() : source;
  const attempts = [candidate];
  const arrayStart = candidate.indexOf("[");
  const arrayEnd = candidate.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) attempts.push(candidate.slice(arrayStart, arrayEnd + 1));
  const objectStart = candidate.indexOf("{");
  const objectEnd = candidate.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) attempts.push(candidate.slice(objectStart, objectEnd + 1));
  for (const attempt of [...new Set(attempts)]) {
    try { return JSON.parse(attempt); } catch { /* try the next bounded JSON candidate */ }
  }
  throw new Error(`${label}不是有效 JSON`);
}

function translatedItems(value, label) {
  const parsed = parseJsonDocument(value, label);
  if (Array.isArray(parsed)) return parsed;
  for (const key of ["items", "results", "translations", "cues"]) {
    if (Array.isArray(parsed?.[key])) return parsed[key];
  }
  throw new Error(`${label}必须返回 JSON 数组，或包含 items/results/translations/cues 数组`);
}

function normalizeChineseSubtitle(value) {
  return String(value || "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/。+$/u, "");
}

function japaneseCharacterRatio(value) {
  const text = String(value || "");
  if (!text) return 0;
  const matches = text.match(/[ぁ-んァ-ン]/gu) || [];
  return matches.length / Math.max(1, [...text].length);
}

function translationFromItem(item) {
  for (const key of ["translation", "target", "zh", "zh_cn", "translated_text"]) {
    if (typeof item?.[key] === "string" && item[key].trim()) return normalizeChineseSubtitle(item[key]);
  }
  return "";
}

function validateTranslationChunk(document, sourceSegments) {
  if (!document || !Array.isArray(document.cues) || document.cues.length !== sourceSegments.length) return false;
  const expected = new Map(sourceSegments.map((segment) => [String(segment.id), segment]));
  const seen = new Set();
  for (const cue of document.cues) {
    const id = String(cue?.id ?? "");
    const source = expected.get(id);
    const translation = String(cue.translation || "").trim();
    if (!source || seen.has(id) || String(cue.source || "") !== String(source.text || "") || !translation || translation.includes("\uFFFD")) return false;
    seen.add(id);
  }
  return seen.size === expected.size;
}

function validatedTranslationResponses(result, expectedItems, label) {
  const responses = new Map();
  for (const [adaptiveIndex, part] of (result.parts || []).entries()) {
    for (const item of translatedItems(part.text, `${label}.${adaptiveIndex + 1}`)) {
      const id = String(item?.id ?? "");
      if (!id || responses.has(id)) throw new Error(`${label} 返回重复或空 id=${id || "<empty>"}`);
      const translation = translationFromItem(item);
      if (!translation) throw new Error(`${label} 的 id=${id} 缺少非空 translation`);
      if (translation.includes("\uFFFD")) throw new Error(`${label} 的 id=${id} 含有损坏字符 U+FFFD`);
      responses.set(id, item);
    }
  }
  const expectedIds = new Set(expectedItems.map((item) => String(item.id)));
  for (const id of responses.keys()) if (!expectedIds.has(id)) throw new Error(`${label} 返回未知 id=${id}`);
  if (responses.size !== expectedIds.size) {
    const missing = [...expectedIds].filter((id) => !responses.has(id)).slice(0, 12);
    throw new Error(`${label} 缺少 ${expectedIds.size - responses.size} 项：${missing.join(", ")}`);
  }
  return responses;
}

const translationSafeBatchSize = process.env.PSS_API_PROVIDER === "mimo" ? 10 : 20;

async function requestTranslationItems(itemPart, context, label, splitDepth = 0) {
  if (splitDepth === 0 && itemPart.length > translationSafeBatchSize) {
    const groups = [];
    for (let offset = 0; offset < itemPart.length; offset += translationSafeBatchSize) {
      groups.push(itemPart.slice(offset, offset + translationSafeBatchSize));
    }
    emit(`${label} 按当前模型安全批量预拆为 ${groups.map((group) => group.length).join("+")} 条，外层仍按 ${itemPart.length} 条原子落盘。`);
    const responses = new Map();
    const usages = [];
    let calls = 0;
    let model = "";
    for (const [index, group] of groups.entries()) {
      const result = await requestTranslationItems(group, context, `${label}s${index + 1}`, splitDepth + 1);
      for (const [id, item] of result.responses) responses.set(id, item);
      usages.push(result.tokenUsage);
      calls += result.calls;
      model = result.model || model;
    }
    return { responses, model, tokenUsage: mergeTokenUsage(...usages), calls };
  }
  let result;
  try {
    result = await modelCall({
      batchItems: itemPart,
      batchInstruction: "把 INPUT_ITEMS_JSON 中每个 source 翻译为简体中文。严格输出 JSON 数组，逐项保留相同 id；不要输出 Markdown 或解释。",
      batchSystem: translationBatchSystem(context),
      estimatedOutputTokensPerItem: 96,
      maxItemsPerCall: itemPart.length,
      maxTokens: Math.max(1200, Math.min(5000, itemPart.length * 220 + 600)),
      reasoningEffort: "low",
      timeoutMs: 180_000,
    }, `${label}-d${splitDepth}`);
    return {
      responses: validatedTranslationResponses(result, itemPart, label),
      model: result.model,
      tokenUsage: result.tokenUsage,
      calls: Number(result.adaptiveBatch?.calls || 1),
    };
  } catch (error) {
    const recoverableModelCodes = new Set(["MODEL_EMPTY_RESPONSE", "MODEL_TIMEOUT", "MODEL_NETWORK_ERROR"]);
    if (error instanceof HarnessModelError && !recoverableModelCodes.has(String(error.code))) throw error;
    if (itemPart.length > 1) {
      const middle = Math.ceil(itemPart.length / 2);
      const leftItems = itemPart.slice(0, middle);
      const rightItems = itemPart.slice(middle);
      emit(`${label} 结构校验失败（${error.message}），自动拆为 ${leftItems.length}+${rightItems.length} 条重试；已完成批次不重跑。`);
      const left = await requestTranslationItems(leftItems, context, `${label}a`, splitDepth + 1);
      const right = await requestTranslationItems(rightItems, context, `${label}b`, splitDepth + 1);
      return {
        responses: new Map([...left.responses, ...right.responses]),
        model: right.model || left.model || result?.model,
        tokenUsage: mergeTokenUsage(result?.tokenUsage, left.tokenUsage, right.tokenUsage),
        calls: Number(result?.adaptiveBatch?.calls || 1) + left.calls + right.calls,
      };
    }
    if (splitDepth < 2) {
      emit(`${label} 单条结构校验失败（${error.message}），自动重试。`);
      const retry = await requestTranslationItems(itemPart, context, `${label}r`, splitDepth + 1);
      return {
        ...retry,
        tokenUsage: mergeTokenUsage(result?.tokenUsage, retry.tokenUsage),
        calls: Number(result?.adaptiveBatch?.calls || 1) + retry.calls,
      };
    }
    throw error;
  }
}

function mergeTokenUsage(...usages) {
  const valid = usages.filter((item) => item && typeof item === "object");
  return {
    input: valid.reduce((sum, item) => sum + Number(item.input || 0), 0),
    cachedInput: valid.reduce((sum, item) => sum + Number(item.cachedInput || 0), 0),
    output: valid.reduce((sum, item) => sum + Number(item.output || 0), 0),
    total: valid.reduce((sum, item) => sum + Number(item.total || 0), 0),
    available: valid.some((item) => item.available),
    cacheAvailable: valid.some((item) => item.cacheAvailable),
  };
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

async function updateManifestPatch(patch) {
  const patchFile = path.join(stateDirectory, `manifest-patch-${randomUUID()}.json`);
  await writeFile(patchFile, `${JSON.stringify(patch || {})}\n`, "utf8");
  const result = await runProcess(process.execPath, [manifestHelperPath, path.join(jobDirectory, "manifest.json"), patchFile]);
  if (result.code !== 0) throw new Error((result.stderr || result.stdout || "Manifest 更新失败").slice(-3000));
  return { updated: true, output: result.stdout.slice(-2000) };
}

function firstString(object, keys) {
  for (const key of keys) {
    if (typeof object?.[key] === "string" && object[key].trim()) return object[key].trim();
  }
  return "";
}

function normalizeRunArgs(id, rawArgs) {
  if (Array.isArray(rawArgs)) return rawArgs.map(String);
  if (typeof rawArgs === "string" && rawArgs.trim()) {
    if (id === "inspect_media") return [rawArgs.trim()];
    throw new Error(`run.${id}.args 必须是字符串数组；不会把整段命令字符串交给子进程`);
  }
  if (!rawArgs || typeof rawArgs !== "object") throw new Error(`run.${id}.args 必须是非空字符串数组`);
  const nested = Array.isArray(rawArgs.args) ? rawArgs.args : Array.isArray(rawArgs.argv) ? rawArgs.argv : null;
  if (nested) return nested.map(String);
  const media = firstString(rawArgs, ["media", "path", "input", "source"]);
  if (id === "inspect_media" && media) return [media];
  if (id === "ffprobe" && media) return ["-v", "error", "-show_streams", "-show_format", "-of", "json", media];
  throw new Error(`run.${id}.args 对象无法安全转换；请使用 {"args":["逐个","参数"]}${id === "inspect_media" ? "，或 {\"args\":{\"media\":\"路径\"}}" : ""}`);
}

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
    const names = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (names === null) return { path: directory, exists: false, entries: [] };
    return { path: directory, entries: names.slice(0, 500).map((item) => ({ name: item.name, type: item.isDirectory() ? "directory" : "file" })) };
  }
  if (tool === "write_text") {
    const file = checkedPath(input.path, "write");
    const content = String(input.content || "");
    if (Buffer.byteLength(content) > 64 * 1024) throw new Error("单次内联写入超过 64 KB；请让 model_task/model_batch 使用 outputPath 直接落盘，或拆分文件");
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
    return updateManifestPatch(input.patch || {});
  }
  if (tool === "materialize_research_preview") {
    const preview = checkedPath(input.previewPath || path.join(jobDirectory, "research", "user-approved-preview.md"));
    const result = await runProcess(process.execPath, [researchMaterializerPath, preview, jobDirectory]);
    if (result.code !== 0) throw new Error(`预习文档整理失败：${(result.stderr || result.stdout).slice(-4000)}`);
    const summary = JSON.parse(result.stdout);
    await updateManifestPatch({
      artifacts: {
        research_brief: summary.artifacts.brief,
        research_sources: summary.artifacts.sources,
        research_glossary: summary.artifacts.glossary,
        research_speakers: summary.artifacts.speakers,
      },
      phases: { research: { status: "in_progress", evidence: Object.values(summary.artifacts) } },
    });
    return summary;
  }
  if (tool === "run") {
    const id = String(input.id || "");
    if (id === "update_manifest") throw new Error("update_manifest 不是 run 子命令；请使用顶层 tool=update_manifest 和 input.patch");
    const toolArgs = normalizeRunArgs(id, input.args);
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
    if (id === "ffmpeg") await ensureMediaOutputParent(commandArgs);
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
    const result = await modelCall({ messages: [{ role: "system", content: system }, { role: "user", content }], maxTokens: Math.min(12_000, Math.max(256, Number(input.maxTokens || 5000))), timeoutMs: 180_000 }, "task");
    return persistModelOutput(result, input.outputPath, "task");
  }
  if (tool === "model_batch") {
    const items = Array.isArray(input.items) ? input.items : [];
    if (!items.length || items.length > 500) throw new Error("model_batch 需要 1–500 个项目");
    const result = await modelCall({
      batchItems: items,
      batchInstruction: String(input.instruction || "逐项处理并保留 id"),
      batchSystem: String(input.system || "你是 GakuNiku 字幕工程的语义处理模型。"),
      estimatedOutputTokensPerItem: Math.max(32, Number(input.estimatedOutputTokensPerItem || 220)),
      maxItemsPerCall: Math.max(1, Number(input.maxItemsPerCall || 24)),
      maxTokens: Math.min(12_000, Math.max(512, Number(input.maxTokens || 6000))),
      timeoutMs: 180_000,
    }, "batch");
    return persistModelOutput(result, input.outputPath, "batch");
  }
  if (tool === "web_search") return searchWeb(String(input.query || "").slice(0, 1000));
  throw new Error(`未知 Harness 工具：${tool}`);
}

async function ensureMediaOutputParent(commandArgs) {
  const output = String(commandArgs.at(-1) || "");
  if (!output || output === "-" || output.startsWith("-") || /^[a-z]+:\/\//i.test(output)) return;
  const file = checkedPath(output, "write");
  await mkdir(path.dirname(file), { recursive: true });
}

async function persistModelOutput(result, outputPathValue, label) {
  if (!outputPathValue) {
    return {
      ...result,
      text: summarizeResult(result.text, 6000),
      ...(Array.isArray(result.parts) ? { parts: result.parts.map(({ text, ...part }) => ({ ...part, text: summarizeResult(text, 1200) })) } : {}),
    };
  }
  const output = checkedPath(outputPathValue, "write");
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, String(result.text || ""), "utf8");
  const metadataPath = `${output}.model.json`;
  const metadata = {
    label,
    model: result.model,
    tokenUsage: result.tokenUsage,
    finishReason: result.finishReason,
    adaptiveBatch: result.adaptiveBatch,
    parts: Array.isArray(result.parts) ? result.parts.map(({ text, ...part }) => ({ ...part, bytes: Buffer.byteLength(String(text || "")) })) : undefined,
  };
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return { path: output, metadataPath, bytes: Buffer.byteLength(String(result.text || "")), model: result.model, tokenUsage: result.tokenUsage, adaptiveBatch: result.adaptiveBatch };
}

const mediaExtensions = new Set([".mp4", ".mkv", ".webm", ".mov", ".m4v", ".ts", ".flv"]);

async function findMediaFiles(directory, depth = 0) {
  if (depth > 5) return [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.slice(0, 1000).map(async (entry) => {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) return findMediaFiles(candidate, depth + 1);
    if (!entry.isFile() || !mediaExtensions.has(path.extname(entry.name).toLowerCase())) return [];
    const info = await stat(candidate).catch(() => null);
    return info ? [{ path: candidate, size: info.size }] : [];
  }));
  return nested.flat();
}

async function inspectAcquiredMedia(media) {
  const python = executableOnPath("python3") || executableOnPath("python");
  if (!python) throw new Error("ACQUIRE_DEPENDENCY_MISSING: 缺少 Python，无法运行媒体探测脚本");
  const result = await runProcess(python, [path.join(harnessScripts, "inspect_media.py"), media]);
  if (result.code !== 0) throw new Error(`ACQUIRE_MEDIA_INVALID: ${(result.stderr || result.stdout || "媒体探测失败").slice(-4000)}`);
  let report;
  try { report = JSON.parse(result.stdout); }
  catch { throw new Error("ACQUIRE_MEDIA_INVALID: inspect_media 没有返回有效 JSON"); }
  const reportPath = path.join(jobDirectory, "work", "acquire-media.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, reportPath };
}

async function deterministicAcquire() {
  const manifestPath = path.join(jobDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const status = String(manifest.phases?.acquire?.status || "pending");
  const recorded = String(manifest.source?.acquired_media || manifest.artifacts?.source_media || "");
  if (["complete", "completed"].includes(status) && recorded && existsSync(recorded)) return { skipped: true, media: recorded };

  const kind = String(manifest.source?.kind || "");
  const source = String(manifest.source?.value || config.source || "").trim();
  let media = "";
  if (kind === "local" || sourcePath) {
    media = sourcePath || checkedPath(source);
    const info = await stat(media).catch(() => null);
    if (!info?.isFile()) throw new Error(`ACQUIRE_SOURCE_MISSING: 本地视频不存在或不可读：${media}`);
  } else {
    const sourceDirectory = path.join(jobDirectory, "source");
    await mkdir(sourceDirectory, { recursive: true });
    let command = "";
    let commandArgs = [];
    if (kind === "bilibili") {
      command = executableOnPath("yutto");
      if (command) commandArgs = [source, "-d", sourceDirectory];
      else {
        command = executableOnPath("uvx");
        if (command) commandArgs = ["--from", "yutto==2.2.0", "yutto", source, "-d", sourceDirectory];
      }
      if (!command) throw new Error("ACQUIRE_DEPENDENCY_MISSING: Bilibili 素材需要项目内 yutto/uvx；请回到第二步配置项目环境");
    } else {
      command = executableOnPath("yt-dlp");
      if (!command) throw new Error("ACQUIRE_DEPENDENCY_MISSING: 网页视频素材需要项目内 yt-dlp；请回到第二步配置项目环境");
      commandArgs = ["--no-playlist", "-f", "bv*+ba/b", "--merge-output-format", "mkv", "-o", path.join(sourceDirectory, "%(title).180B [%(id)s].%(ext)s"), source];
    }
    validateProcessPaths(commandArgs);
    emit(`获取素材：使用 ${path.basename(command)} 下载到任务目录，不调用大模型决定命令。`);
    const result = await runProcess(command, commandArgs);
    if (result.code !== 0) throw new Error(`ACQUIRE_DOWNLOAD_FAILED: ${(result.stderr || result.stdout || `下载器退出代码 ${result.code}`).slice(-5000)}`);
    const files = await findMediaFiles(sourceDirectory);
    files.sort((left, right) => right.size - left.size);
    media = files[0]?.path || "";
    if (!media) throw new Error("ACQUIRE_DOWNLOAD_EMPTY: 下载器结束后没有找到可用视频文件");
  }

  const { report, reportPath } = await inspectAcquiredMedia(media);
  const limitations = (Array.isArray(manifest.limitations) ? manifest.limitations : []).filter((item) => !/首页模型.*(?:Harness|动作协议)|无法遵循.*Harness/i.test(String(item)));
  await updateManifestPatch({
    source: { acquired_media: media },
    artifacts: { source_media: media, media_inspection: reportPath },
    phases: { acquire: { status: "complete", reason: null, error: null, blocking_reason: null, evidence: [reportPath, `${report.duration_seconds ?? "未知"} 秒；${report.streams?.length || 0} 个媒体流`] } },
    limitations,
  });
  emit(`获取素材完成：已验证 ${path.basename(media)}，后续阶段直接复用。`);
  return { skipped: false, media, reportPath };
}

function lastJsonLine(value) {
  for (const line of String(value || "").trim().split(/\r?\n/).reverse()) {
    try { return JSON.parse(line); } catch { /* progress or non-JSON diagnostic */ }
  }
  throw new Error("工具没有返回最终 JSON 摘要");
}

async function validSourceTranscript(file) {
  try {
    const payload = JSON.parse(await readFile(file, "utf8"));
    const chunks = Number(payload.chunk_count);
    const duration = Number(payload.duration);
    const audioChunks = payload.provenance?.audio_chunks;
    const transcriptChunks = payload.provenance?.transcript_chunks;
    if (!Number.isInteger(chunks) || chunks < 1 || !Number.isFinite(duration) || duration <= 0) return false;
    if (!Array.isArray(audioChunks) || audioChunks.length !== chunks || !Array.isArray(transcriptChunks) || transcriptChunks.length !== chunks) return false;
    if (!Array.isArray(payload.segments)) return false;
    let previousStart = -1;
    for (const [index, segment] of payload.segments.entries()) {
      const start = Number(segment?.start);
      const end = Number(segment?.end);
      if (segment?.id !== index + 1 || typeof segment?.text !== "string" || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start + 0.001 < previousStart) return false;
      previousStart = start;
    }
    return true;
  } catch {
    return false;
  }
}

function forwardTranscriptionProgress() {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item.type !== "progress") continue;
        if (item.stage === "transcribe_chunk") emit(`原文听写：正在处理 ${item.chunk}（${Number(item.completed || 0) + 1}/${item.total}）`);
        else if (item.stage === "reuse_transcript") emit(`原文听写：复用 ${item.chunk}（${item.completed}/${item.total}）`);
        else if (item.stage === "segment_audio") emit(`原文听写：正在生成 ${item.expected_chunks} 个磁盘音频分块`);
        else if (item.stage === "merge_complete") emit(`原文听写：已合并 ${item.chunks} 个分块、${item.segments} 条原文片段`);
      } catch { /* ignore bounded helper chatter */ }
    }
  };
}

async function applyDiarization(transcriptPath, turns, reportPath) {
  const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
  for (const segment of transcript.segments || []) {
    const start = Number(segment.start || 0);
    const end = Number(segment.end || start);
    let best = null;
    let bestOverlap = 0;
    for (const turn of turns) {
      const overlap = Math.max(0, Math.min(end, Number(turn.end)) - Math.max(start, Number(turn.start)));
      if (overlap > bestOverlap) {
        best = turn;
        bestOverlap = overlap;
      }
    }
    segment.speaker = best?.speaker || "speaker-unknown";
  }
  transcript.diarization = turns.length > 0;
  transcript.provenance = { ...(transcript.provenance || {}), diarization: reportPath };
  const temporary = `${transcriptPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
  await rename(temporary, transcriptPath);
}

async function deterministicDiarization(transcriptPath) {
  if (!config.transcription?.diarization || String(process.env.PSS_TRANSCRIPTION_DIARIZATION_ENGINE || "") !== "sherpa_onnx") {
    return { status: "disabled", turns: 0, reportPath: "" };
  }
  const python = String(process.env.PSS_TRANSCRIPTION_DIARIZATION_PYTHON || "");
  const script = String(process.env.PSS_TRANSCRIPTION_DIARIZATION_SCRIPT || "");
  const segmentation = String(process.env.PSS_TRANSCRIPTION_DIARIZATION_SEGMENTATION_MODEL || "");
  const embedding = String(process.env.PSS_TRANSCRIPTION_DIARIZATION_EMBEDDING_MODEL || "");
  if (![python, script, segmentation, embedding].every((item) => item && existsSync(item))) {
    return { status: "degraded", turns: 0, reportPath: "", reason: "Sherpa-ONNX 运行时或模型路径缺失" };
  }
  const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
  const audioChunks = Array.isArray(transcript.provenance?.audio_chunks) ? transcript.provenance.audio_chunks : [];
  if (!audioChunks.length) return { status: "degraded", turns: 0, reportPath: "", reason: "转写结果没有登记音频分块" };
  const ffmpeg = String(process.env.PSS_FFMPEG_PATH || executableOnPath("ffmpeg"));
  if (!ffmpeg) return { status: "degraded", turns: 0, reportPath: "", reason: "FFmpeg 不可用" };
  const outputDirectory = path.join(jobDirectory, "work", "diarization-chunks");
  await mkdir(outputDirectory, { recursive: true });
  const allTurns = [];
  for (const [index, audio] of audioChunks.entries()) {
    const wav = path.join(outputDirectory, `chunk_${String(index).padStart(3, "0")}.wav`);
    const resultPath = path.join(outputDirectory, `chunk_${String(index).padStart(3, "0")}.json`);
    let report = await readFile(resultPath, "utf8").then(JSON.parse).catch(() => null);
    if (report?.status !== "ready") {
      emit(`说话人分离：正在处理分块 ${index + 1}/${audioChunks.length}`);
      const conversion = await runProcess(ffmpeg, ["-y", "-v", "error", "-i", audio, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
      if (conversion.code !== 0) return { status: "degraded", turns: 0, reportPath: "", reason: `分块 ${index + 1} PCM 转换失败：${(conversion.stderr || conversion.stdout).slice(-1200)}` };
      const diarization = await runProcess(python, [script, wav, resultPath, "--segmentation-model", segmentation, "--embedding-model", embedding]);
      if (diarization.code !== 0) return { status: "degraded", turns: 0, reportPath: "", reason: `分块 ${index + 1} 说话人分离失败：${(diarization.stderr || diarization.stdout).slice(-1200)}` };
      report = JSON.parse(await readFile(resultPath, "utf8"));
    }
    const offset = index * Number(transcript.chunk_seconds || 600);
    for (const turn of report.turns || []) allTurns.push({ ...turn, start: Number(turn.start) + offset, end: Number(turn.end) + offset, chunk_index: index });
  }
  const reportPath = path.join(jobDirectory, "work", "diarization.json");
  await writeFile(reportPath, `${JSON.stringify({ schema_version: 1, engine: "sherpa-onnx", status: "ready", turns: allTurns }, null, 2)}\n`, "utf8");
  await applyDiarization(transcriptPath, allTurns, reportPath);
  return { status: "ready", turns: allTurns.length, reportPath };
}

async function deterministicSourceTranscript() {
  if (config.transcription?.mode !== "local" || config.transcription?.provider !== "faster_whisper") return "not_applicable";
  const manifest = JSON.parse(await readFile(path.join(jobDirectory, "manifest.json"), "utf8"));
  if (!["complete", "completed"].includes(String(manifest.phases?.research?.status))) return "not_ready";
  const output = path.join(jobDirectory, "work", "source-transcript.json");
  if (["complete", "completed"].includes(String(manifest.phases?.source_transcript?.status))) {
    if (await validSourceTranscript(output)) return "already_complete";
    emit("原文听写：既有 source-transcript.json 未通过结构、分块或时间轴校验，将从有效分块恢复并重新合并。 ");
  }
  const python = String(process.env.PSS_TRANSCRIPTION_PYTHON || executableOnPath("python3") || executableOnPath("python"));
  const ffmpeg = String(process.env.PSS_FFMPEG_PATH || executableOnPath("ffmpeg"));
  const ffprobe = String(process.env.PSS_FFPROBE_PATH || executableOnPath("ffprobe"));
  const media = String(manifest.source?.acquired_media || manifest.artifacts?.source_media || "");
  if (![python, ffmpeg, ffprobe, media].every((item) => item && existsSync(item))) {
    const reason = "TRANSCRIPT_DEPENDENCY_MISSING: 本地听写缺少 Python、FFmpeg、FFprobe 或已获取媒体";
    await blockPhase("source_transcript", reason, "确定性听写预检失败；不会让翻译模型猜测原文。 ");
    emit(`原文听写已阻塞：${reason}`);
    process.exitCode = 2;
    return "blocked";
  }
  await updateManifestPatch({ phases: { source_transcript: { status: "in_progress", reason: null, error: null, blocking_reason: null, evidence: [] } } });
  emit("原文听写：Harness 将自动切分、断点续跑并合并，不再让模型编排 FFmpeg。 ");
  const args = [
    transcribeMediaPath, media, output,
    "--work-dir", path.join(jobDirectory, "work"),
    "--ffmpeg", ffmpeg, "--ffprobe", ffprobe,
    "--transcriber-script", path.join(harnessScripts, "transcribe_faster_whisper.py"),
    "--chunk-seconds", String(Math.max(1, Number(config.transcription?.chunkMinutes || 10)) * 60),
    "--model", String(config.transcription?.model || "turbo"),
    "--language", String(config.transcription?.language || config.sourceLanguage || "ja"),
    "--beam-size", String(Math.max(1, Number(config.transcription?.beamSize || 5))),
    "--model-cache", String(process.env.PSS_TRANSCRIPTION_MODEL_CACHE || ""),
  ];
  const result = await runProcess(python, args, { onStdout: forwardTranscriptionProgress() });
  if (result.code !== 0) {
    const reason = `TRANSCRIPT_PIPELINE_FAILED: ${(result.stderr || result.stdout || `退出代码 ${result.code}`).slice(-4000)}`;
    await blockPhase("source_transcript", reason, "确定性分块听写失败；已完成的音频块和听写块可在恢复时复用。 ");
    emit(`原文听写已阻塞：${reason}`);
    process.exitCode = 2;
    return "blocked";
  }
  const summary = lastJsonLine(result.stdout);
  const diarization = await deterministicDiarization(output);
  const latest = JSON.parse(await readFile(path.join(jobDirectory, "manifest.json"), "utf8"));
  const notices = Array.isArray(latest.notices) ? latest.notices : [];
  const diarizationNotice = diarization.status === "degraded" ? `说话人分离已降级：${diarization.reason}；基础听写保留 speaker-unknown。` : "";
  await updateManifestPatch({
    artifacts: { source_transcript: output, ...(diarization.reportPath ? { diarization: diarization.reportPath } : {}) },
    phases: { source_transcript: { status: "complete", reason: null, error: null, blocking_reason: null, evidence: [output, `${summary.chunks} 个分块；${summary.segments} 条原文；复用 ${summary.reused_transcripts} 块`, ...(diarization.reportPath ? [diarization.reportPath] : [])] } },
    ...(diarizationNotice ? { notices: [...notices.filter((item) => !/说话人分离已降级/.test(String(item))), diarizationNotice] } : {}),
  });
  emit(`原文听写完成：${summary.chunks} 个分块、${summary.segments} 条原文；说话人分离 ${diarization.status}。`);
  return "completed";
}

async function readContextFile(file, limit) {
  return readFile(file, "utf8").then((value) => summarizeResult(value, limit)).catch(() => "");
}

function translationBatchSystem(context) {
  return [
    "你是 GakuNiku 的日语到简体中文字幕翻译器。只翻译提供的真实听写条目，不补写未听见的内容。",
    "严格逐项返回 JSON 数组；每项只允许包含 id、translation、confidence、flagged、issue。id 必须原样保留，不得遗漏、合并、重排或新增。",
    "translation 使用自然、准确、符合当前活动语境的简体中文；对话字幕末尾不添加句号‘。’，但保留问号、感叹号、省略号等必要标点。",
    "上下文只能用于消歧，不得把相邻句内容并入当前句。无法可靠确定专有名词时采用不增加事实的保守译法，并设置 flagged=true、降低 confidence、用 issue 简述疑点。",
    context,
  ].filter(Boolean).join("\n\n");
}

function translatedCue(source, item) {
  const translation = translationFromItem(item);
  if (!translation) throw new Error(`翻译结果 id=${source.id} 缺少非空 translation`);
  const confidenceValue = Number(item?.confidence);
  const confidence = Number.isFinite(confidenceValue) ? Math.min(1, Math.max(0, confidenceValue)) : 0.75;
  const sourceConfidence = Array.isArray(source.words) && source.words.length
    ? source.words.reduce((sum, word) => sum + Number(word?.probability || 0), 0) / source.words.length
    : 1;
  const flagged = Boolean(item?.flagged)
    || confidence < 0.72
    || sourceConfidence < 0.62
    || japaneseCharacterRatio(translation) > 0.18
    || translation === String(source.text || "").trim();
  return {
    id: source.id,
    start: Number(source.start),
    end: Number(source.end),
    speakerId: String(source.speaker || "speaker_unknown"),
    source: String(source.text || "").trim(),
    translation,
    confidence,
    sourceConfidence: Number(sourceConfidence.toFixed(4)),
    flagged,
    issue: String(item?.issue || (flagged ? "需要在疑点复核阶段结合上下文确认" : "")).slice(0, 500),
    chunkIndex: Number(source.chunk_index || 0),
  };
}

async function translateSegmentGroup(sourceSegments, context, chunkIndex) {
  const items = sourceSegments.map((segment, index) => ({
    id: String(segment.id),
    source: String(segment.text || "").trim(),
    speaker: String(segment.speaker || "speaker_unknown"),
    previous: index > 0 ? String(sourceSegments[index - 1]?.text || "") : "",
    next: index + 1 < sourceSegments.length ? String(sourceSegments[index + 1]?.text || "") : "",
  }));
  const partSize = 20;
  const partDirectory = path.join(jobDirectory, "work", "translation-parts");
  await mkdir(partDirectory, { recursive: true });
  const partDocuments = [];
  for (let offset = 0; offset < items.length; offset += partSize) {
    const partIndex = Math.floor(offset / partSize);
    const sourcePart = sourceSegments.slice(offset, offset + partSize);
    const itemPart = items.slice(offset, offset + partSize);
    const partFile = path.join(partDirectory, `translated_chunk_${String(chunkIndex).padStart(3, "0")}_part_${String(partIndex).padStart(3, "0")}.json`);
    let partDocument = await readFile(partFile, "utf8").then(JSON.parse).catch(() => null);
    if (!validateTranslationChunk(partDocument, sourcePart)) {
      emit(`精准翻译：分块 ${chunkIndex + 1} 子批次 ${partIndex + 1}/${Math.ceil(items.length / partSize)}（${itemPart.length} 条）`);
      const result = await requestTranslationItems(
        itemPart,
        context,
        `翻译分块 ${chunkIndex + 1} 子批次 ${partIndex + 1}`,
      );
      const responses = result.responses;
      partDocument = {
        schema_version: 1,
        chunk_index: chunkIndex,
        part_index: partIndex,
        source_ids: sourcePart.map((segment) => segment.id),
        model: result.model || process.env.PSS_API_MODEL || "model",
        token_usage: result.tokenUsage,
        adaptive_batch: { enabled: true, itemCount: itemPart.length, calls: result.calls },
        cues: sourcePart.map((segment) => translatedCue(segment, responses.get(String(segment.id)))),
      };
      await writeJsonAtomic(partFile, partDocument);
      emit(`精准翻译：分块 ${chunkIndex + 1} 子批次 ${partIndex + 1} 已校验并落盘`);
    } else {
      emit(`精准翻译：复用分块 ${chunkIndex + 1} 子批次 ${partIndex + 1}`);
    }
    partDocuments.push(partDocument);
  }
  return {
    schema_version: 1,
    chunk_index: chunkIndex,
    source_ids: sourceSegments.map((segment) => segment.id),
    model: process.env.PSS_API_MODEL || partDocuments[0]?.model || "model",
    token_usage: mergeTokenUsage(...partDocuments.map((document) => document.token_usage)),
    adaptive_batch: {
      enabled: true,
      itemCount: sourceSegments.length,
      completedParts: partDocuments.length,
      calls: partDocuments.reduce((sum, document) => sum + Number(document.adaptive_batch?.calls || 0), 0),
    },
    cues: partDocuments.flatMap((document) => document.cues),
  };
}

async function deterministicTranslate() {
  const manifestPath = path.join(jobDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const sourceReady = ["complete", "completed", "skipped"].includes(String(manifest.phases?.source_transcript?.status));
  const researchReady = ["complete", "completed", "skipped"].includes(String(manifest.phases?.research?.status));
  if (!sourceReady || !researchReady) return "waiting";

  const recordedTranscript = String(manifest.artifacts?.source_transcript || "");
  const defaultTranscript = path.join(jobDirectory, "work", "source-transcript.json");
  if (!recordedTranscript && !existsSync(defaultTranscript)) return "not_applicable";
  const transcriptPath = checkedPath(recordedTranscript || defaultTranscript);
  const output = path.join(jobDirectory, "work", "translated-subtitles.json");
  const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
  const segments = Array.isArray(transcript.segments) ? transcript.segments : [];
  if (!segments.length) throw new Error("TRANSLATE_SOURCE_EMPTY: source-transcript.json 没有可翻译条目");

  if (["complete", "completed"].includes(String(manifest.phases?.translate?.status))) {
    const existing = await readFile(output, "utf8").then(JSON.parse).catch(() => null);
    if (validateTranslationChunk(existing, segments)) return "skipped";
    emit("精准翻译：manifest 标记完成但译文产物不完整，将从有效翻译分块恢复。 ");
  }

  await updateManifestPatch({ phases: { translate: { status: "in_progress", reason: null, error: null, blocking_reason: null, evidence: [] } } });
  const [brief, glossary, speakers] = await Promise.all([
    readContextFile(path.join(jobDirectory, "research", "brief.md"), 5000),
    readContextFile(path.join(jobDirectory, "research", "glossary.tsv"), 5000),
    readContextFile(path.join(jobDirectory, "research", "speakers.tsv"), 4000),
  ]);
  const context = `研究摘要：\n${brief}\n\n术语表：\n${glossary}\n\n人物实体：\n${speakers}`;
  const groups = new Map();
  for (const segment of segments) {
    const chunkIndex = Number.isInteger(Number(segment.chunk_index)) ? Number(segment.chunk_index) : Math.floor(Number(segment.start || 0) / 600);
    if (!groups.has(chunkIndex)) groups.set(chunkIndex, []);
    groups.get(chunkIndex).push(segment);
  }
  const translationDirectory = path.join(jobDirectory, "work", "translation-chunks");
  await mkdir(translationDirectory, { recursive: true });
  const documents = [];
  const orderedGroups = [...groups.entries()].sort((left, right) => left[0] - right[0]);
  for (const [position, [chunkIndex, sourceSegments]] of orderedGroups.entries()) {
    const file = path.join(translationDirectory, `translated_chunk_${String(chunkIndex).padStart(3, "0")}.json`);
    let document = await readFile(file, "utf8").then(JSON.parse).catch(() => null);
    if (!validateTranslationChunk(document, sourceSegments)) {
      emit(`精准翻译：正在处理磁盘分块 ${position + 1}/${orderedGroups.length}（${sourceSegments.length} 条）`);
      document = await translateSegmentGroup(sourceSegments, context, chunkIndex);
      await writeJsonAtomic(file, document);
    } else {
      emit(`精准翻译：复用已验证分块 ${position + 1}/${orderedGroups.length}`);
    }
    documents.push(document);
  }
  const cues = documents.flatMap((document) => document.cues).sort((left, right) => Number(left.id) - Number(right.id));
  const merged = {
    schema_version: 1,
    source_language: String(transcript.language || "ja"),
    target_language: "zh-CN",
    model: process.env.PSS_API_MODEL || documents[0]?.model || "model",
    source_transcript: transcriptPath,
    cue_count: cues.length,
    token_usage: mergeTokenUsage(...documents.map((document) => document.token_usage)),
    cues,
  };
  if (!validateTranslationChunk(merged, segments)) throw new Error("TRANSLATE_MERGE_INVALID: 翻译分块合并后与真实听写 ID/原文不一致");
  await writeJsonAtomic(output, merged);
  const current = JSON.parse(await readFile(manifestPath, "utf8"));
  const limitations = (Array.isArray(current.limitations) ? current.limitations : []).filter((item) => !/Harness.*(?:动作协议|协议)|首页模型.*(?:JSON|结构化动作)|确定性翻译分块失败|translation-error\.json/i.test(String(item)));
  const notices = [...new Set([...(Array.isArray(current.notices) ? current.notices : []), "精准翻译由 Harness 按真实听写稳定 ID 分块执行；已完成批次可断点复用。"] )];
  await updateManifestPatch({
    artifacts: { translated_subtitles: output },
    phases: { translate: { status: "complete", reason: null, error: null, blocking_reason: null, evidence: [output, `${cues.length} 条稳定 ID 译文；${documents.length} 个可复用分块`] } },
    limitations,
    notices,
  });
  emit(`精准翻译完成：${cues.length} 条译文、${documents.length} 个磁盘分块均已校验并登记。`);
  return "completed";
}

async function writeTextAtomic(file, value) {
  const destination = checkedPath(file, "write");
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, String(value), "utf8");
  await rename(temporary, destination);
  return destination;
}

function parseTsvRows(value) {
  const lines = String(value || "").replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const headers = lines[0].split("\t");
  return lines.slice(1).map((line) => Object.fromEntries(headers.map((header, index) => [header, line.split("\t")[index] || ""])));
}

function ambiguityRisk(cue) {
  const confidence = Number(cue?.confidence ?? 0.75);
  const sourceConfidence = Number(cue?.sourceConfidence ?? 1);
  const japaneseRatio = japaneseCharacterRatio(cue?.translation);
  if (confidence < 0.5 || japaneseRatio > 0.3) return "critical";
  if (confidence < 0.72 || sourceConfidence < 0.5 || japaneseRatio > 0.18) return "review";
  return "minor";
}

function fallbackRoleColor(index) {
  const colors = ["#55C2FF", "#FF6B81", "#FFC857", "#45C486", "#7A77B9", "#8BD3FF", "#FF8FA3", "#FFD166", "#6ED7A5", "#9B8AFB", "#5BC0EB", "#F28482"];
  return colors[index % colors.length];
}

async function deterministicResolveAmbiguities() {
  if (!Array.isArray(config.formats) || !config.formats.length) return "not_applicable";
  const manifestPath = path.join(jobDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!['complete', 'completed'].includes(String(manifest.phases?.translate?.status))) return "waiting";
  const reportPath = path.join(jobDirectory, "work", "ambiguity-report.json");
  const reviewPath = path.join(jobDirectory, "work", "studio-review.json");
  if (['complete', 'completed'].includes(String(manifest.phases?.resolve_ambiguities?.status)) && existsSync(reportPath) && existsSync(reviewPath)) return "skipped";
  const translatedPath = checkedPath(String(manifest.artifacts?.translated_subtitles || path.join(jobDirectory, "work", "translated-subtitles.json")));
  const translated = JSON.parse(await readFile(translatedPath, "utf8"));
  const cues = Array.isArray(translated.cues) ? translated.cues : [];
  if (!cues.length) throw new Error("AMBIGUITY_SOURCE_EMPTY: translated-subtitles.json 没有字幕条目");
  await updateManifestPatch({ phases: { resolve_ambiguities: { status: "in_progress", policy: "pragmatic", blocking: false, evidence: [] } } });
  const candidates = cues.filter((cue) => Boolean(cue.flagged)).map((cue) => {
    const riskLevel = ambiguityRisk(cue);
    return {
      id: cue.id,
      start: Number(cue.start),
      end: Number(cue.end),
      source: String(cue.source || ""),
      translation: String(cue.translation || ""),
      risk_level: riskLevel,
      disposition: riskLevel === "minor" ? "ignored_non_material" : "accepted_risk",
      issue: String(cue.issue || "模型或听写置信度需要人工按需复核"),
      evidence: [{ kind: "translation_metadata", translation_confidence: Number(cue.confidence ?? 0.75), source_confidence: Number(cue.sourceConfidence ?? 1) }],
    };
  });
  const count = (risk) => candidates.filter((item) => item.risk_level === risk).length;
  const critical = count("critical");
  const review = count("review");
  const minor = count("minor");
  const report = {
    schema_version: 1,
    policy: "pragmatic",
    blocking: false,
    candidate_count: candidates.length,
    deep_reviewed_count: 0,
    auto_accepted_count: candidates.length,
    critical_remaining_count: critical,
    summary: { total: candidates.length, critical, review, minor, deep_reviewed: 0, auto_released: minor, needs_refine: critical + review },
    items: candidates,
  };
  const speakerRows = parseTsvRows(await readFile(path.join(jobDirectory, "research", "speakers.tsv"), "utf8").catch(() => ""));
  const roles = speakerRows.map((row, index) => {
    const characterName = String(row.character_name || "").trim();
    const performerName = String(row.performer_name || "").trim();
    const speakingAs = ["character", "performer"].includes(row.speaking_as) ? row.speaking_as : "unknown";
    const color = /^#[0-9a-f]{6}$/i.test(String(row.color_hex || "")) ? row.color_hex : fallbackRoleColor(index);
    return {
      id: String(row.speaker_entity_id || `P${String(index + 1).padStart(2, "0")}`),
      name: speakingAs === "performer" ? performerName || characterName : characterName || performerName || `人物 ${index + 1}`,
      characterName,
      performerName,
      speakingAs,
      color,
      colorSource: { kind: row.color_source_url ? "evidence" : "fallback", reference: row.color_source_url || "GakuNiku deterministic fallback palette" },
    };
  });
  const knownRoleIds = new Set(roles.map((role) => role.id));
  const unknownRole = { id: "speaker_unknown", name: "未确认发言者", characterName: "", performerName: "", speakingAs: "unknown", color: fallbackRoleColor(roles.length), colorSource: { kind: "fallback", reference: "说话人标签未与研究人物可靠对应，不从外观或序号猜测身份" } };
  roles.push(unknownRole);
  const candidateById = new Map(candidates.map((item) => [String(item.id), item]));
  const reviewDocument = {
    schema_version: 1,
    source_media: manifest.source?.acquired_media || manifest.artifacts?.source_media || "",
    roles,
    cues: cues.map((cue) => ({
      id: cue.id,
      start: Number(cue.start),
      end: Number(cue.end),
      speakerId: knownRoleIds.has(String(cue.speakerId || "")) ? String(cue.speakerId) : unknownRole.id,
      source: String(cue.source || ""),
      translation: normalizeChineseSubtitle(cue.translation),
      confidence: Number(cue.confidence ?? 0.75),
      flagged: Boolean(cue.flagged),
      issue: String(cue.issue || ""),
      riskLevel: candidateById.get(String(cue.id))?.risk_level || "none",
      disposition: candidateById.get(String(cue.id))?.disposition || "resolved",
    })),
  };
  await writeJsonAtomic(reportPath, report);
  await writeJsonAtomic(reviewPath, reviewDocument);
  const current = JSON.parse(await readFile(manifestPath, "utf8"));
  const limitations = (Array.isArray(current.limitations) ? current.limitations : []).filter((item) => !/确定性翻译分块失败|translation-error\.json|疑点复核/i.test(String(item)));
  if (critical + review > 0) limitations.push(`${critical + review} 条关键/复核级疑点已按 pragmatic 策略采用保守译法并保留 flagged，供精修台按需检查；不阻塞成片。`);
  await updateManifestPatch({
    artifacts: { ambiguity_report: reportPath, studio_review: reviewPath },
    phases: { resolve_ambiguities: { status: "complete", policy: "pragmatic", blocking: false, risk_summary: report.summary, reason: null, error: null, evidence: [reportPath, reviewPath, `${candidates.length} 条候选；自动放行 ${minor}；留待精修 ${critical + review}`] } },
    limitations,
  });
  emit(`疑点复核完成：从真实译文筛选 ${candidates.length} 条，自动放行 ${minor} 条，${critical + review} 条保守保留到精修台；没有把文件路径交给模型猜测。`);
  return "completed";
}

function srtTimestamp(seconds) {
  const milliseconds = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor((milliseconds % 3600000) / 60000);
  const secs = Math.floor((milliseconds % 60000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function assTimestamp(seconds) {
  const centiseconds = Math.max(0, Math.round(Number(seconds || 0) * 100));
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor((centiseconds % 360000) / 6000);
  const secs = Math.floor((centiseconds % 6000) / 100);
  const cs = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function subtitleLines(value) {
  const text = normalizeChineseSubtitle(value);
  const chars = [...text];
  if (chars.length <= 26) return [text];
  const center = Math.ceil(chars.length / 2);
  let split = center;
  for (let distance = 0; distance <= Math.min(12, center); distance += 1) {
    for (const candidate of [center + distance, center - distance]) {
      if (candidate > 0 && candidate < chars.length && /[，、；：！？…\s]/u.test(chars[candidate - 1])) { split = candidate; distance = 99; break; }
    }
  }
  return [chars.slice(0, split).join("").trim(), chars.slice(split).join("").trim()].filter(Boolean).slice(0, 2);
}

function assColor(value) {
  const match = String(value || "").match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return match ? `&H00${match[3]}${match[2]}${match[1]}`.toUpperCase() : "&H00FFFFFF";
}

function assEscape(value) {
  return subtitleLines(value).join("\\N").replace(/\\(?!N)/g, "＼").replace(/\{/g, "｛").replace(/\}/g, "｝");
}

async function deterministicSubtitleQc() {
  if (!Array.isArray(config.formats) || !config.formats.length) return "not_applicable";
  const manifestPath = path.join(jobDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!['complete', 'completed'].includes(String(manifest.phases?.resolve_ambiguities?.status))) return "waiting";
  const deliverables = path.join(jobDirectory, "deliverables");
  await mkdir(deliverables, { recursive: true });
  const baseName = `${path.basename(String(manifest.source?.acquired_media || "video"), path.extname(String(manifest.source?.acquired_media || "video")))}_zh-CN`;
  const srtPath = path.join(deliverables, `${baseName}.srt`);
  const assPath = path.join(deliverables, `${baseName}.ass`);
  const reportPath = path.join(jobDirectory, "work", "subtitle-validation.json");
  if (['complete', 'completed'].includes(String(manifest.phases?.subtitle_qc?.status)) && [srtPath, assPath, reportPath].every(existsSync)) return "skipped";
  const review = JSON.parse(await readFile(path.join(jobDirectory, "work", "studio-review.json"), "utf8"));
  const cues = Array.isArray(review.cues) ? review.cues : [];
  const roles = Array.isArray(review.roles) ? review.roles : [];
  if (!cues.length) throw new Error("SUBTITLE_REVIEW_EMPTY: studio-review.json 没有字幕条目");
  await updateManifestPatch({ phases: { subtitle_qc: { status: "in_progress", evidence: [] } } });
  const srt = cues.map((cue, index) => `${index + 1}\n${srtTimestamp(cue.start)} --> ${srtTimestamp(cue.end)}\n${subtitleLines(cue.translation).join("\n")}\n`).join("\n");
  const font = String(config.subtitleStyle?.fontFamily || "Noto Sans CJK SC").replace(/,/g, " ");
  const fontSize = Math.max(16, Number(config.subtitleStyle?.fontSize || 42));
  const outline = Math.max(1, Number(config.subtitleStyle?.outline || 3));
  const shadow = Math.max(0, Number(config.subtitleStyle?.shadow || 3));
  const styleName = (id) => `Role_${String(id || "unknown").replace(/[^a-z0-9_]+/gi, "_")}`;
  const styles = roles.map((role) => `Style: ${styleName(role.id)},${font},${fontSize},&H00FFFFFF,&H00FFFFFF,${assColor(role.color)},&H90000000,-1,0,0,0,100,100,0,0,1,${outline},${shadow},2,45,45,54,1`).join("\n");
  const roleIds = new Set(roles.map((role) => String(role.id)));
  const dialogues = cues.map((cue) => {
    const roleId = roleIds.has(String(cue.speakerId || "")) ? String(cue.speakerId) : "speaker_unknown";
    const actor = String(roles.find((role) => String(role.id) === roleId)?.name || "").replace(/,/g, " ");
    return `Dialogue: 0,${assTimestamp(cue.start)},${assTimestamp(cue.end)},${styleName(roleId)},${actor},0,0,0,,{\\blur1.2}${assEscape(cue.translation)}`;
  }).join("\n");
  const ass = `[Script Info]\n; Generated by GakuNiku deterministic subtitle harness\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\n${styles}\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n${dialogues}\n`;
  await writeTextAtomic(srtPath, srt);
  await writeTextAtomic(assPath, ass);
  const python = String(process.env.PSS_TRANSCRIPTION_PYTHON || executableOnPath("python3") || executableOnPath("python"));
  const validator = await runProcess(python, [path.join(harnessScripts, "validate_subtitles.py"), srtPath, assPath, "--media-duration", String(cues.at(-1)?.end || 0), "--expect-count", String(cues.length), "--max-lines", "2", "--strict"]);
  const validation = JSON.parse(validator.stdout || "{}");
  await writeJsonAtomic(reportPath, validation);
  if (validator.code !== 0) throw new Error(`SUBTITLE_VALIDATION_FAILED: ${(validator.stderr || validator.stdout).slice(-4000)}`);
  await mkdir(outputRoot, { recursive: true });
  await Promise.all([copyFile(srtPath, path.join(outputRoot, path.basename(srtPath))), copyFile(assPath, path.join(outputRoot, path.basename(assPath)))]);
  await updateManifestPatch({ artifacts: { srt: srtPath, ass: assPath, subtitle_validation: reportPath }, phases: { subtitle_qc: { status: "complete", reason: null, error: null, evidence: [srtPath, assPath, reportPath, `${cues.length} 条；SRT/ASS 数量一致；最多两行`] } } });
  emit(`字幕质检完成：生成并严格校验 ${cues.length} 条 SRT/ASS，最多两行，时间码与草稿标记检查通过。`);
  return "completed";
}

async function deterministicMux() {
  if (!Array.isArray(config.formats) || !config.formats.includes("mkv")) return "not_applicable";
  const manifestPath = path.join(jobDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!['complete', 'completed'].includes(String(manifest.phases?.subtitle_qc?.status))) return "waiting";
  const source = String(manifest.source?.acquired_media || manifest.artifacts?.source_media || "");
  const deliverables = path.join(jobDirectory, "deliverables");
  const baseName = `${path.basename(source, path.extname(source))}_zh-CN`;
  const output = path.join(deliverables, `${baseName}.mkv`);
  if (['complete', 'completed'].includes(String(manifest.phases?.mux?.status)) && existsSync(output)) return "skipped";
  const ffmpeg = String(process.env.PSS_FFMPEG_PATH || executableOnPath("ffmpeg"));
  if (!ffmpeg || !existsSync(source)) throw new Error("MUX_DEPENDENCY_MISSING: 缺少 FFmpeg 或源媒体");
  await updateManifestPatch({ phases: { mux: { status: "in_progress", evidence: [] } } });
  const result = await runProcess(ffmpeg, ["-y", "-i", source, "-i", String(manifest.artifacts.srt), "-i", String(manifest.artifacts.ass), "-map", "0:v:0", "-map", "0:a?", "-map", "1:0", "-map", "2:0", "-c:v", "copy", "-c:a", "copy", "-c:s:0", "srt", "-c:s:1", "ass", "-metadata:s:s:0", "language=zho", "-metadata:s:s:0", "title=简体中文 SRT", "-metadata:s:s:1", "language=zho", "-metadata:s:s:1", "title=简体中文 ASS", "-disposition:s:0", "default", "-disposition:s:1", "0", output]);
  if (result.code !== 0) throw new Error(`MUX_FAILED: ${(result.stderr || result.stdout).slice(-4000)}`);
  await mkdir(outputRoot, { recursive: true });
  await copyFile(output, path.join(outputRoot, path.basename(output)));
  await updateManifestPatch({ artifacts: { mkv: output, muxed_media: output }, phases: { mux: { status: "complete", reason: null, error: null, evidence: [output, "视频/音频无重编码；内封 SRT+ASS；SRT 默认"] } } });
  emit(`视频封装完成：${output}`);
  return "completed";
}

async function deterministicFinalValidation() {
  if (!Array.isArray(config.formats) || !config.formats.includes("mkv")) return "not_applicable";
  const manifestPath = path.join(jobDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!['complete', 'completed'].includes(String(manifest.phases?.mux?.status))) return "waiting";
  const validationPath = path.join(jobDirectory, "work", "validation-report.json");
  const finalPath = path.join(jobDirectory, "work", "final-report.json");
  if (['complete', 'completed'].includes(String(manifest.phases?.final_validation?.status)) && existsSync(validationPath) && existsSync(finalPath)) return "skipped";
  await updateManifestPatch({ phases: { final_validation: { status: "in_progress", evidence: [] } } });
  const python = String(process.env.PSS_TRANSCRIPTION_PYTHON || executableOnPath("python3") || executableOnPath("python"));
  const result = await runProcess(python, [path.join(harnessScripts, "verify_mux.py"), String(manifest.artifacts.muxed_media || manifest.artifacts.mkv), "--expect-subtitles", "2", "--subtitle-language", "zho", "--full-read"]);
  const validation = JSON.parse(result.stdout || "{}");
  await writeJsonAtomic(validationPath, validation);
  if (result.code !== 0) throw new Error(`FINAL_VALIDATION_FAILED: ${(result.stderr || result.stdout).slice(-4000)}`);
  const subtitleValidation = JSON.parse(await readFile(String(manifest.artifacts.subtitle_validation), "utf8"));
  const finalReport = { schema_version: 1, status: "complete", media: validation, subtitles: subtitleValidation, checks: { video_stream: validation.video_streams === 1, audio_present: validation.audio_streams >= 1, subtitle_streams: validation.subtitle_streams?.length === 2, full_read: validation.full_read?.ok === true, max_two_lines: true, cue_counts_match: true } };
  await writeJsonAtomic(finalPath, finalReport);
  await updateManifestPatch({ artifacts: { validation_report: validationPath, final_report: finalPath }, phases: { final_validation: { status: "complete", reason: null, error: null, evidence: [validationPath, finalPath, "视频/音频/两条中文字幕流/包计数/整流读取均通过"] } } });
  emit("最终验证完成：视频、音频、两条中文字幕流及整文件读取全部通过。 ");
  return "completed";
}

async function blockPhase(phase, reason, limitation = "") {
  const patch = {
    phases: { [phase]: { status: "blocked", reason: String(reason).slice(0, 4000), evidence: [] } },
    ...(limitation ? { limitations: [String(limitation).slice(0, 4000)] } : {}),
  };
  return updateManifestPatch(patch);
}

const toolContract = `
你是用户在 GakuNiku 第一步选定并通过图文测试的模型，也是本任务唯一的规划与语义决策者。你不依赖 Codex、Claude 或其他 Agent CLI。项目自带的 Built-in Harness 只执行你发出的安全结构化动作。

每一轮只能返回一个 JSON 对象，不要 Markdown：
1. 调工具：{"type":"tool","summary":"给用户看的当前动作","calls":[{"tool":"工具名","input":{}}]}
2. 完成：{"type":"finish","summary":"完成摘要"}
允许的工具：
- read_text {path,maxChars}；list_files {path}；write_text {path,content}（只用于小文件）；copy_file {source,destination}
- update_manifest {patch}：唯一允许的 manifest 更新方式
- materialize_research_preview {previewPath?}：把用户核准预习确定性整理成 brief.md、sources.md、glossary.tsv、speakers.tsv。只要存在预习文件，先调用一次；不要让模型重写这四个文件
- run {id,args}，其中 args 必须是逐项分开的 JSON 字符串数组，例如 {"id":"ffmpeg","args":["-i","/path/input.mp4","-vn","/path/audio.flac"]}；inspect_media 也兼容 {"id":"inspect_media","args":{"media":"/path/video.mp4"}}。id 仅限 ffmpeg、ffprobe、yt-dlp、yutto、inspect_media、transcribe、diarize、render_subtitles、measure_subtitles、validate_subtitles、verify_mux
- web_search {query}：调用首页配置的搜索 MCP；单个网站失败时换来源继续
- model_task {system,prompt,images,maxTokens,outputPath?}：让同一个首页模型处理有界语义任务或图片 OCR；大输出必须提供 outputPath
- model_batch {system,instruction,items,maxTokens,estimatedOutputTokensPerItem,maxItemsPerCall,outputPath?}：用同一模型自适应分批处理字幕；大输出必须提供 outputPath

约束：acquire 由 Harness 在进入控制循环前确定性完成；本地 Faster-Whisper 的音频提取、分块、缺失块听写、JSON 合并与说话人分离也由 Harness 在 research 完成后确定性执行；research 与 source_transcript 完成后，translate 同样由 Harness 从真实 source-transcript.json 读取稳定 ID、分块调用首页模型、校验合并并登记 translated-subtitles.json。resolve_ambiguities、subtitle_qc、mux、final_validation 也由 Harness 直接读取真实译文、生成报告/精修数据、渲染并校验字幕、无重编码封装和逐流验证；控制器不得把本地文件路径当作文件内容交给 model_task，也不得为这些阶段伪造示例。控制器不得为确定性阶段调用 FFmpeg、ffprobe、transcribe、diarize、model_task/model_batch，不得自行寻找 chunks、手抄听写内容、制作翻译计划或生成/合并 source-transcript.json 与 translated-subtitles.json。先读取 Skill 与直接引用的 reference，但不得读取 Harness 执行器、服务端源码或依赖源码；每轮最多 4 个相互独立的调用；不得要求 shell、删除工具、任意 Python/Node 代码或未列出的程序；不得读取工作区外文件；所有大结果通过 outputPath 落盘，控制动作不得内嵌整份研究/字幕文件。存在 user-approved-preview.md 时先 materialize，再只对标为不确定或与当前素材冲突的事实做最多三次增量检索。update_manifest 必须使用顶层工具，不能放进 run.id；phase 名只能是八阶段之一，evidence 必须是字符串数组。遇到工具失败先根据返回信息修正参数，只有紧邻的同参数同因失败才累计；两次后把当前阶段标 blocked 并 finish。只有 manifest 八阶段全部完成或已明确 blocked 后才能 finish。`;

let transcript = [];
let lastProtocolFailure = { code: "", count: 0 };
let totalProtocolFailures = 0;
let previousToolFailure = { fingerprint: "", count: 0 };
emit(`内置 Harness 已启动：${process.env.PSS_API_PROVIDER || "API"}/${process.env.PSS_API_MODEL || "model"} 将直接负责规划与语义工作，不调用外部 Agent CLI。`);

function controllerMessages(turn, retryNote = "") {
  const recent = [];
  let budget = 9000;
  for (const message of [...transcript].reverse()) {
    if (budget <= 0 || recent.length >= 8) break;
    const content = summarizeResult(message.content, Math.min(3000, budget));
    budget -= content.length;
    recent.unshift({ role: message.role, content });
  }
  return [
    { role: "system", content: summarizeResult(toolContract, 6000) },
    { role: "user", content: summarizeResult(taskPrompt, 15_000) },
    ...recent,
    { role: "user", content: `这是 Harness 第 ${turn} 轮。检查 manifest 后选择下一组最小动作。${retryNote}` },
  ];
}

function retryableModelError(error) {
  if (!(error instanceof HarnessModelError)) return false;
  if (["MODEL_EMPTY_RESPONSE", "MODEL_TIMEOUT", "MODEL_NETWORK_ERROR"].includes(error.code)) return true;
  const status = Number(error.diagnostic?.httpStatus || 0);
  return error.code === "MODEL_HTTP_ERROR" && (status === 429 || status >= 500);
}

function modelFailureReason(error) {
  const diagnostic = error?.diagnostic || {};
  if (error?.code === "MODEL_EMPTY_RESPONSE") {
    const output = Number(diagnostic.usage?.completion_tokens ?? diagnostic.usage?.output_tokens ?? 0);
    return `首页模型 API 请求成功但返回空正文（finishReason=${diagnostic.finishReason || "unknown"}，输出 Token=${output}）；Harness 已用精简上下文并关闭思考重试，仍无可执行动作。`;
  }
  if (error?.code === "MODEL_TIMEOUT") return "首页模型调用超时；Harness 已自动重试一次，仍未得到动作。";
  if (error?.code === "MODEL_NETWORK_ERROR") return `首页模型网络请求失败：${error.message}`;
  if (error?.code === "MODEL_HTTP_ERROR") return `首页模型接口返回 HTTP ${diagnostic.httpStatus || "错误"}：${error.message}`;
  return `首页模型调用失败：${error?.message || String(error)}`;
}

async function callController(turn) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const retryNote = attempt === 2 ? " 上一次调用未产生正文；本次必须关闭长思考，直接返回一个简洁 JSON 动作。" : "";
      return await modelCall({
        messages: controllerMessages(turn, retryNote),
        maxTokens: attempt === 1 ? 2200 : 2800,
        timeoutMs: 180_000,
        reasoningEffort: "low",
        responseFormat: "harness_action",
      }, "controller");
    } catch (error) {
      lastError = error;
      if (attempt === 1 && retryableModelError(error)) {
        emit(`首页模型调用异常（${error.code}），正在用精简上下文安全重试 1 次。`);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

let acquisitionReady = false;
try {
  await deterministicAcquire();
  acquisitionReady = true;
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  const diagnosticPath = path.join(jobDirectory, "work", "acquire-error.json");
  await writeFile(diagnosticPath, `${JSON.stringify({ at: new Date().toISOString(), phase: "acquire", reason }, null, 2)}\n`, "utf8");
  await blockPhase("acquire", reason, `获取素材由 Harness 确定性执行并已停止；详细诊断：${diagnosticPath}`);
  emit(`获取素材已阻塞：${reason}`);
  process.exitCode = 2;
}

if (acquisitionReady) for (let turn = 1; turn <= 160; turn += 1) {
  const transcriptState = await deterministicSourceTranscript();
  if (transcriptState === "blocked") break;
  if (transcriptState === "completed") continue;
  try {
    const translationState = await deterministicTranslate();
    if (translationState === "completed") continue;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const diagnosticPath = path.join(jobDirectory, "work", "translation-error.json");
    await writeJsonAtomic(diagnosticPath, { at: new Date().toISOString(), phase: "translate", reason });
    await blockPhase("translate", reason, `确定性翻译分块失败；已完成分块仍可复用。详细诊断：${diagnosticPath}`);
    emit(`精准翻译已阻塞：${reason}`);
    process.exitCode = 2;
    break;
  }
  let deterministicStageAdvanced = false;
  for (const [phase, handler] of [
    ["resolve_ambiguities", deterministicResolveAmbiguities],
    ["subtitle_qc", deterministicSubtitleQc],
    ["mux", deterministicMux],
    ["final_validation", deterministicFinalValidation],
  ]) {
    try {
      const stageState = await handler();
      if (stageState === "completed") {
        deterministicStageAdvanced = true;
        break;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const diagnosticPath = path.join(jobDirectory, "work", `${phase}-error.json`);
      await writeJsonAtomic(diagnosticPath, { at: new Date().toISOString(), phase, reason });
      await blockPhase(phase, reason, `确定性 ${phase} 阶段失败；上游成果均已保留。详细诊断：${diagnosticPath}`);
      emit(`${phase} 已阻塞：${reason}`);
      process.exitCode = 2;
      break;
    }
  }
  if (process.exitCode) break;
  if (deterministicStageAdvanced) continue;
  const deterministicManifest = JSON.parse(await readFile(path.join(jobDirectory, "manifest.json"), "utf8"));
  if (phaseIds.every((id) => ["complete", "completed", "skipped"].includes(String(deterministicManifest.phases?.[id]?.status)))) {
    emit("八阶段确定性流水线全部完成，交付物与验证报告已登记。 ");
    break;
  }
  let reply;
  try {
    reply = await callController(turn);
  } catch (error) {
    const manifest = JSON.parse(await readFile(path.join(jobDirectory, "manifest.json"), "utf8"));
    const phase = phaseIds.find((id) => !["complete", "completed", "skipped"].includes(String(manifest.phases?.[id]?.status))) || "research";
    const reason = modelFailureReason(error);
    const diagnosticFile = error?.diagnostic?.diagnosticFile || "";
    await blockPhase(phase, reason, diagnosticFile ? `模型失败诊断已保存：${diagnosticFile}` : "模型失败发生在 Harness 控制器调用中，已停止无效重试。 ");
    emit(`${phase} 已阻塞：${reason}`);
    process.exitCode = 2;
    break;
  }

  let decision;
  try {
    decision = parseJsonReply(reply.text);
    if (decision._protocolRepair === "stringified_calls") emit("Harness 已兼容修复首页模型把 calls 数组二次序列化为字符串的问题；原始响应仍保存在任务日志。 ");
    transcript.push({ role: "assistant", content: summarizeResult(reply.text, 4000) });
    lastProtocolFailure = { code: "", count: 0 };
  } catch (error) {
    const code = error?.code || "PROTOCOL_UNKNOWN";
    lastProtocolFailure = lastProtocolFailure.code === code
      ? { code, count: lastProtocolFailure.count + 1 }
      : { code, count: 1 };
    totalProtocolFailures += 1;
    const detail = error instanceof Error ? error.message : String(error);
    transcript.push({ role: "user", content: `动作协议错误 ${code}：${detail}。请通过 harness_action 函数返回规定结构，不要解释文字。` });
    emit(`Harness 动作协议不合规，正在分类纠正（${code} 同类 ${lastProtocolFailure.count}/2，总计 ${totalProtocolFailures}/4）：${detail}`);
    if (lastProtocolFailure.count < 2 && totalProtocolFailures < 4) continue;
    const manifest = JSON.parse(await readFile(path.join(jobDirectory, "manifest.json"), "utf8"));
    const phase = phaseIds.find((id) => !["complete", "completed", "skipped"].includes(String(manifest.phases?.[id]?.status))) || "research";
    await blockPhase(phase, `首页模型动作协议无法恢复（${code}）：${detail}`, "Harness 已按错误代码分别纠正；同类连续两次或不同类累计四次仍不合规。原始控制器输入/输出已保存在 work/builtin-harness。 ");
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

  const calls = decision.calls.slice(0, 4);
  const results = [];
  let repeatedFailure = null;
  for (const call of calls) {
    try {
      emit(`执行：${call.tool}`);
      const result = await runHarnessTool(call);
      results.push({ tool: call.tool, ok: true, result });
      previousToolFailure = { fingerprint: "", count: 0 };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fingerprint = `${call.tool}|${JSON.stringify(call.input || {}).slice(0, 2000)}|${message.slice(0, 1000)}`;
      const attempts = previousToolFailure.fingerprint === fingerprint ? previousToolFailure.count + 1 : 1;
      previousToolFailure = { fingerprint, count: attempts };
      results.push({ tool: call.tool, ok: false, error: message, attemptsWithSameInput: attempts });
      if (attempts >= 2 && !repeatedFailure) repeatedFailure = { call, message, attempts };
    }
  }
  const recordPath = path.join(stateDirectory, `turn-${String(turn).padStart(3, "0")}.json`);
  await writeFile(recordPath, `${JSON.stringify({ turn, calls, results }, null, 2)}\n`, "utf8");
  if (repeatedFailure) {
    const manifest = JSON.parse(await readFile(path.join(jobDirectory, "manifest.json"), "utf8"));
    const phase = phaseIds.find((id) => !["complete", "completed", "skipped"].includes(String(manifest.phases?.[id]?.status))) || "research";
    const reason = `${repeatedFailure.call.tool} 使用相同参数连续失败 ${repeatedFailure.attempts} 次：${repeatedFailure.message}`;
    await blockPhase(phase, reason, `工具失败记录：${recordPath}。Harness 已停止相同参数的长重试。`);
    emit(`${phase} 已阻塞：${reason}`);
    process.exitCode = 2;
    break;
  }
  transcript.push({ role: "user", content: `Harness 工具结果：\n${summarizeResult(results, 12_000)}\n完整记录：${recordPath}` });
}

const finalManifest = JSON.parse(await readFile(path.join(jobDirectory, "manifest.json"), "utf8"));
const unfinished = phaseIds.filter((id) => !["complete", "completed", "skipped"].includes(String(finalManifest.phases?.[id]?.status)));
if (unfinished.length && !unfinished.some((id) => ["blocked", "error"].includes(String(finalManifest.phases?.[id]?.status)))) {
  emit(`Harness 达到轮次上限，仍未完成：${unfinished.join("、")}`);
  process.exitCode = 2;
}
