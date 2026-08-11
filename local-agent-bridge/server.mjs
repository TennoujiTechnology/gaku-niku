import { randomUUID } from "node:crypto";
import { accessSync, constants, createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { Readable } from "node:stream";

const bridgeDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(bridgeDirectory, "..");
const staticRoot = path.join(projectRoot, "standalone");
const harnessPath = path.join(projectRoot, "harness", "precision-video-subtitles", "SKILL.md");
const jobsRoot = process.env.PSS_JOBS_PATH
  ? path.resolve(process.env.PSS_JOBS_PATH)
  : path.join(projectRoot, ".precision-subtitle-studio", "jobs");
const port = Number(process.env.PSS_BRIDGE_PORT || 43127);
const phaseIds = [
  "acquire",
  "research",
  "source_transcript",
  "translate",
  "resolve_ambiguities",
  "subtitle_qc",
  "mux",
  "final_validation",
];
const phaseLabels = {
  acquire: "正在获取与检查素材",
  research: "正在研究作品背景与专有名词",
  source_transcript: "正在制作带时间戳的原文听写",
  translate: "正在结合上下文逐句翻译",
  resolve_ambiguities: "正在跳转疑点画面并执行 OCR",
  subtitle_qc: "正在检查两行限制、角色色与时序",
  mux: "正在封装视频与字幕轨",
  final_validation: "正在验证媒体流与成片完整性",
};
const localMediaTokens = new Map();

await mkdir(jobsRoot, { recursive: true });

function localOrigin(origin = "") {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

function responseHeaders(request) {
  const origin = request.headers.origin ?? "";
  return {
    "access-control-allow-origin": localOrigin(origin) ? origin : "http://localhost:3000",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

function json(request, status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...responseHeaders(request), "content-type": "application/json; charset=utf-8" },
  });
}

async function readJson(request, maxBytes = 8 * 1024 * 1024) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new Error("请求内容过大");
  const text = await request.text();
  if (Buffer.byteLength(text) > maxBytes) throw new Error("请求内容过大");
  return text ? JSON.parse(text) : {};
}

async function pickLocalFile() {
  if (process.platform !== "darwin") return { supported: false };
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/osascript", ["-e", 'POSIX path of (choose file with prompt "选择要翻译的视频或音频")'], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk) => { if (output.length < 16_384) output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { if (error.length < 16_384) error += chunk.toString(); });
    child.on("error", reject);
    child.on("close", async (code) => {
      if (code !== 0 && /User canceled|-128/i.test(error)) return resolve({ cancelled: true });
      if (code !== 0) return reject(new Error(error.trim() || "系统文件选择器失败"));
      const selected = output.trim();
      try {
        const resolved = await realpath(selected);
        const info = await stat(resolved);
        if (!info.isFile()) throw new Error("选择的不是文件");
        const token = randomUUID();
        localMediaTokens.set(token, { path: resolved, size: info.size, expiresAt: Date.now() + 12 * 60 * 60 * 1000 });
        resolve({ path: resolved, previewUrl: `/api/local-media/${token}` });
      } catch (fileError) {
        reject(fileError);
      }
    });
  });
}

async function staticResponse(request, pathname) {
  const assets = {
    "/": [path.join(staticRoot, "index.html"), "text/html; charset=utf-8"],
    "/app.js": [path.join(staticRoot, "dist", "app.js"), "text/javascript; charset=utf-8"],
    "/app.css": [path.join(staticRoot, "dist", "app.css"), "text/css; charset=utf-8"],
    "/favicon.svg": [path.join(projectRoot, "public", "favicon.svg"), "image/svg+xml"],
  };
  const asset = assets[pathname];
  if (!asset) return null;
  try {
    const contents = await readFile(asset[0]);
    return new Response(contents, {
      status: 200,
      headers: {
        ...responseHeaders(request),
        "content-type": asset[1],
        "cache-control": pathname === "/" ? "no-cache" : "no-cache, must-revalidate",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' http://127.0.0.1:43127; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      },
    });
  } catch {
    return json(request, 503, { error: "轻量界面尚未编译，请使用开发模式或重新生成 standalone/dist。" });
  }
}

function executable(name) {
  const specialCandidates = name === "uvx"
    ? [
        process.env.PSS_UVX_PATH,
        path.join(projectRoot, ".tools", "uv", "uvx"),
        path.join(os.homedir(), ".local", "bin", "uvx"),
        path.join(os.homedir(), "Documents", "Claude_Project", ".tools", "uv", "uvx"),
      ].filter(Boolean)
    : [];
  for (const candidate of specialCandidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue with PATH.
    }
  }
  const pathEntries = (process.env.PATH || "").split(path.delimiter);
  for (const entry of pathEntries) {
    if (!entry) continue;
    const candidate = path.join(entry, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue looking through PATH.
    }
  }
  return null;
}

function gpuDetail() {
  if (process.platform === "darwin") {
    const probe = spawnSync("system_profiler", ["SPDisplaysDataType", "-json"], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 512 * 1024,
    });
    if (probe.status === 0) {
      try {
        const displays = JSON.parse(probe.stdout).SPDisplaysDataType ?? [];
        const names = displays.map((item) => item.sppci_model || item._name).filter(Boolean);
        const memory = displays.map((item) => item.sppci_vram || item.spdisplays_vram).filter(Boolean);
        return [...names, ...memory].join(" · ") || "Apple Silicon 统一内存";
      } catch {
        return "macOS GPU（详情不可用）";
      }
    }
  }
  const nvidia = executable("nvidia-smi");
  if (nvidia) {
    const probe = spawnSync(nvidia, ["--query-gpu=name,memory.total", "--format=csv,noheader"], {
      encoding: "utf8",
      timeout: 4000,
      maxBuffer: 64 * 1024,
    });
    if (probe.status === 0) return probe.stdout.trim().replace(/\n/g, " · ");
  }
  return "未检测到独立 GPU 信息";
}

function capabilities() {
  const names = ["codex", "claude", "deepseek", "ollama", "ffmpeg", "ffprobe", "yutto", "yt-dlp", "uvx"];
  const tools = Object.fromEntries(names.map((name) => {
    const location = executable(name);
    return [name, { available: Boolean(location), ...(location ? { path: location } : {}) }];
  }));
  if (!tools.yutto.available && tools.uvx.available) tools.yutto = { available: true, path: tools.uvx.path, detail: "通过 uvx 按需运行" };
  tools.gpu = { available: true, detail: gpuDetail() };
  return { bridge: { available: true, version: 1, jobsRoot }, tools };
}

function sourceKind(value) {
  const source = String(value || "").trim();
  if (/bilibili\.com|b23\.tv/i.test(source)) return "bilibili";
  if (/youtube\.com|youtu\.be/i.test(source)) return "youtube";
  if (/^https?:\/\//i.test(source)) return "yt-dlp";
  if (source.startsWith("file://") || path.isAbsolute(source) || existsSync(path.resolve(source))) return "local";
  return "unknown";
}

function safeJobDirectory(id) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("无效任务 ID");
  return path.join(jobsRoot, id);
}

async function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonFile(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function initialManifest(config) {
  return {
    schema_version: 1,
    created_at: new Date().toISOString(),
    source: { kind: sourceKind(config.source), value: config.source, acquired_media: null },
    languages: { source: config.sourceLanguage || "ja", target: config.targetLanguage || "zh-Hans" },
    phases: Object.fromEntries(phaseIds.map((id) => [id, { status: "pending", evidence: [] }])),
    artifacts: {},
    limitations: [],
  };
}

function sanitizedConfig(config) {
  return {
    ...config,
    engine: { ...(config.engine ?? {}), apiKey: config.engine?.apiKey ? "[provided at launch only]" : "" },
  };
}

function buildPrompt(config, jobDirectory) {
  const sitePolicies = {
    official: "作品、活动、出演者的官方网站与官方社交账号",
    wikipedia: "ja.wikipedia.org 与 zh.wikipedia.org（只作交叉核对）",
    fandom: "fandom.com 与 moegirl.org.cn（只作粉丝语境补充）",
    video: "视频简介、章节、上传者置顶信息与可用评论语境",
  };
  const sites = [
    ...(config.research?.sites ?? []).map((site) => sitePolicies[site] || site),
    ...(config.research?.customSites ?? []),
  ];
  return [
    "你正在执行一个本地视频字幕工程。必须完整遵守下方 skill，不得跳过研究门槛，也不得调用 Google Translate/DeepL。",
    `SKILL.md: ${harnessPath}`,
    `任务目录: ${jobDirectory}`,
    `进度清单: ${path.join(jobDirectory, "manifest.json")}`,
    `视频源: ${config.source}`,
    `输出目录: ${config.outputPath}`,
    `源语言: ${config.sourceLanguage || "ja"}`,
    `目标语言: ${config.targetLanguage || "zh-CN"}`,
    `输出格式: ${(config.formats ?? []).join(", ")}`,
    `预习关键词: ${(config.research?.keywords ?? []).join(", ")}`,
    `优先研究站点: ${sites.join(", ") || "官方资料优先"}`,
    "字幕硬约束: 每个逻辑字幕最多两行；充分利用横向安全区；对话型中文字幕默认不在每条末尾添加句号‘。’，但保留句中的句号以及必要的问号、感叹号、省略号和破折号；从该人开口的第一个词出现，到最后一个词结束时消失；可靠角色色用于外圈描边、柔光和投影；不可靠时使用确定性随机色并记录；疑点必须跳到附近时间抽帧/OCR。",
    "资源约束: 不得把完整视频读入内存；音频以 5–10 分钟分块并保留 2–5 秒重叠；子进程与转写结果直接落盘。",
    `精修数据: 完成字幕后额外写出 ${path.join(jobDirectory, "work", "studio-review.json")}，JSON 结构为 {"roles":[{"id":"...","name":"...","color":"#RRGGBB"}],"cues":[{"id":1,"start":0.0,"end":1.0,"speakerId":"...","source":"...","translation":"...","confidence":0.95,"flagged":false}]}。该文件只含文本和时间码，不嵌入媒体。`,
    "开始前读取 SKILL.md 及其直接引用的三个 reference。每开始一个阶段将 manifest 对应 status 写为 in_progress，每完成则写为 complete 并记录 evidence；无法继续写 blocked 和原因。完成后保留 SRT、ASS、封装视频和验证报告。",
  ].join("\n");
}

function adapter(config) {
  const mode = config.engine?.mode || "cli";
  let name = config.engine?.cli || "codex";
  if (mode === "gpu") name = "ollama";
  if (mode === "api") name = config.engine?.provider === "anthropic" ? "claude" : "codex";
  const command = executable(name);
  if (!command) throw new Error(`本机没有发现 ${name}，请先安装或改用其他 Agent。`);
  const extraToolDirectories = [executable("uvx"), executable("yutto")].filter(Boolean).map((value) => path.dirname(value));
  const env = { ...process.env, PATH: [...new Set(extraToolDirectories), process.env.PATH || ""].filter(Boolean).join(path.delimiter) };
  const key = String(config.engine?.apiKey || "").trim();
  if (mode === "api") {
    if (!key) throw new Error("API 模式需要填写 API Key。 ");
    if (name === "claude") env.ANTHROPIC_API_KEY = key;
    else env.OPENAI_API_KEY = key;
    if (config.engine?.baseUrl) env.OPENAI_BASE_URL = config.engine.baseUrl;
  }
  return { name, command, env };
}

function adapterArguments(name, config, prompt) {
  const modelArgs = config.engine?.model ? ["--model", config.engine.model] : [];
  if (name === "codex") return ["exec", "--json", "--skip-git-repo-check", ...modelArgs, prompt];
  if (name === "claude") return ["-p", prompt, ...modelArgs, "--output-format", "stream-json", "--verbose"];
  if (name === "deepseek") return ["-p", prompt];
  if (name === "ollama") return ["run", config.engine?.gpuModel || config.engine?.model || "deepseek-r1:14b", prompt];
  throw new Error(`不支持的 Agent: ${name}`);
}

async function launchJob(config) {
  const kind = sourceKind(config.source);
  if (kind === "unknown") throw new Error("无法识别视频位置，请使用本地完整路径或 yt-dlp 支持的网页链接。 ");
  if (!String(config.outputPath || "").trim()) throw new Error("输出路径不能为空。 ");
  if (!Array.isArray(config.formats) || !config.formats.length) throw new Error("至少选择一种输出格式。 ");
  const id = randomUUID();
  const jobDirectory = safeJobDirectory(id);
  await Promise.all(["source", "research", "work", "frames", "subtitles", "deliverables", "logs"].map((name) => mkdir(path.join(jobDirectory, name), { recursive: true })));
  const prompt = buildPrompt(config, jobDirectory);
  const selected = adapter(config);
  const args = adapterArguments(selected.name, config, prompt);
  await writeJsonFile(path.join(jobDirectory, "studio-job.json"), sanitizedConfig(config));
  await writeJsonFile(path.join(jobDirectory, "manifest.json"), initialManifest(config));
  const stateFile = path.join(jobDirectory, "job-state.json");
  const state = { id, status: "running", agent: selected.name, createdAt: new Date().toISOString(), message: "本地 Agent 已启动" };
  const outputLog = createWriteStream(path.join(jobDirectory, "logs", "agent.ndjson"), { flags: "a" });
  const errorLog = createWriteStream(path.join(jobDirectory, "logs", "agent.stderr.log"), { flags: "a" });
  const child = spawn(selected.command, args, {
    cwd: jobDirectory,
    env: selected.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(outputLog);
  child.stderr.pipe(errorLog);
  state.pid = child.pid;
  await writeJsonFile(stateFile, state);
  child.on("error", async (error) => {
    await writeJsonFile(stateFile, { ...state, status: "failed", error: error.message, finishedAt: new Date().toISOString() });
  });
  child.on("close", async (code, signal) => {
    outputLog.end();
    errorLog.end();
    const latest = await readJsonFile(stateFile, state);
    await writeJsonFile(stateFile, {
      ...latest,
      status: code === 0 ? "completed" : "failed",
      exitCode: code,
      signal,
      ...(code === 0 ? { message: "任务已完成，等待精修" } : { error: `Agent 退出，代码 ${code ?? "unknown"}` }),
      finishedAt: new Date().toISOString(),
    });
  });
  return { id, status: "running", jobDirectory, agent: selected.name };
}

async function jobStatus(id) {
  const directory = safeJobDirectory(id);
  const [state, manifest, review] = await Promise.all([
    readJsonFile(path.join(directory, "job-state.json")),
    readJsonFile(path.join(directory, "manifest.json")),
    readJsonFile(path.join(directory, "work", "studio-review.json")),
  ]);
  if (!state || !manifest) throw new Error("任务不存在");
  const phases = {};
  let score = 0;
  let currentPhase = "";
  for (const id of phaseIds) {
    const raw = manifest.phases?.[id]?.status ?? "pending";
    const mapped = raw === "complete" || raw === "completed" ? "done" : raw === "in_progress" || raw === "running" ? "running" : raw === "blocked" || raw === "error" ? "error" : "pending";
    phases[id] = mapped;
    if (mapped === "done") score += 1;
    if (mapped === "running") { score += 0.35; currentPhase = id; }
    if (mapped === "error") currentPhase = id;
  }
  const progress = state.status === "completed" ? 100 : Math.max(1, Math.round((score / phaseIds.length) * 100));
  const media = await resolveMedia(id);
  return {
    ...state,
    phases,
    progress,
    message: currentPhase ? phaseLabels[currentPhase] : state.message,
    manifest: { artifacts: manifest.artifacts, limitations: manifest.limitations },
    review,
    mediaUrl: media ? `/api/jobs/${id}/media` : null,
  };
}

function mediaCandidate(value) {
  if (typeof value === "string") return value;
  if (value && typeof value.path === "string") return value.path;
  return null;
}

async function resolveMedia(id) {
  const directory = safeJobDirectory(id);
  const [manifest, config] = await Promise.all([
    readJsonFile(path.join(directory, "manifest.json")),
    readJsonFile(path.join(directory, "studio-job.json")),
  ]);
  if (!manifest || !config) return null;
  const candidates = [
    mediaCandidate(manifest.source?.acquired_media),
    mediaCandidate(manifest.artifacts?.source_media),
    mediaCandidate(manifest.artifacts?.media),
    sourceKind(config.source) === "local" ? config.source : null,
  ].filter(Boolean);
  const realJobDirectory = await realpath(directory);
  let realOriginal = null;
  if (sourceKind(config.source) === "local") {
    try { realOriginal = await realpath(path.resolve(String(config.source).replace(/^file:\/\//, ""))); } catch { /* unavailable */ }
  }
  for (const candidate of candidates) {
    const expanded = candidate.startsWith("~/") ? path.join(os.homedir(), candidate.slice(2)) : candidate;
    const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(directory, expanded);
    try {
      const resolved = await realpath(absolute);
      const allowed = resolved === realOriginal || resolved.startsWith(`${realJobDirectory}${path.sep}`);
      if (!allowed) continue;
      const info = await stat(resolved);
      if (info.isFile()) return { path: resolved, size: info.size };
    } catch {
      // Try the next recorded artifact.
    }
  }
  return null;
}

async function mediaResponse(request, id) {
  const media = await resolveMedia(id);
  if (!media) return json(request, 404, { error: "没有可预览的本地媒体" });
  return streamMediaResponse(request, media);
}

function streamMediaResponse(request, media) {
  const range = request.headers.get("range");
  let start = 0;
  let end = media.size - 1;
  let status = 200;
  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match) return new Response(null, { status: 416, headers: responseHeaders(request) });
    if (match[1]) start = Number(match[1]);
    if (match[2]) end = Math.min(Number(match[2]), end);
    if (start > end || start >= media.size) return new Response(null, { status: 416, headers: { ...responseHeaders(request), "content-range": `bytes */${media.size}` } });
    status = 206;
  }
  const extension = path.extname(media.path).toLowerCase();
  const contentType = { ".mp4": "video/mp4", ".mkv": "video/x-matroska", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/x-m4v" }[extension] || "application/octet-stream";
  const stream = createReadStream(media.path, { start, end });
  return new Response(Readable.toWeb(stream), {
    status,
    headers: {
      ...responseHeaders(request),
      "accept-ranges": "bytes",
      "content-type": contentType,
      "content-length": String(end - start + 1),
      ...(status === 206 ? { "content-range": `bytes ${start}-${end}/${media.size}` } : {}),
    },
  });
}

function selectedMediaResponse(request, token) {
  const media = localMediaTokens.get(token);
  if (!media || media.expiresAt < Date.now()) {
    localMediaTokens.delete(token);
    return json(request, 404, { error: "本地预览授权已过期，请重新选择文件" });
  }
  return streamMediaResponse(request, media);
}

async function launchExport(id, body) {
  const directory = safeJobDirectory(id);
  const [stored, manifest] = await Promise.all([
    readJsonFile(path.join(directory, "studio-job.json")),
    readJsonFile(path.join(directory, "manifest.json")),
  ]);
  if (!stored || !manifest) throw new Error("任务不存在");
  const config = { ...stored, ...body, engine: { ...(stored.engine ?? {}), ...(body.engine ?? {}) } };
  const selected = adapter(config);
  const refinementPath = path.join(directory, "work", "studio-refinements.json");
  const exportPath = path.join(directory, "work", "studio-export.json");
  await writeJsonFile(exportPath, sanitizedConfig(body));
  for (const phase of ["subtitle_qc", "mux", "final_validation"]) {
    manifest.phases[phase] = { ...(manifest.phases[phase] ?? {}), status: phase === "subtitle_qc" ? "in_progress" : "pending", evidence: [] };
  }
  await writeJsonFile(path.join(directory, "manifest.json"), manifest);
  const prompt = [
    `严格遵守 ${harnessPath}，继续任务 ${directory}。`,
    `读取已人工精修的数据 ${refinementPath} 和导出设置 ${exportPath}。`,
    "把精修后的角色、译文、起止时间和样式真正落实到 SRT/ASS；最多两行，对话型中文字幕去掉多余的句末句号‘。’但保留其他有语气意义的标点，使用角色色外圈描边、柔光和投影。重新执行字幕 QC、代表帧 OCR、无重编码封装与最终媒体流验证。不要重新下载或重新转写视频，不要覆盖原始媒体。",
    `交付文件写入 ${config.outputPath || path.join(directory, "deliverables")}，并更新 manifest 的 subtitle_qc、mux、final_validation 证据。`,
  ].join("\n");
  const args = adapterArguments(selected.name, config, prompt);
  const outputLog = createWriteStream(path.join(directory, "logs", "export-agent.ndjson"), { flags: "a" });
  const errorLog = createWriteStream(path.join(directory, "logs", "export-agent.stderr.log"), { flags: "a" });
  const child = spawn(selected.command, args, { cwd: directory, env: selected.env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(outputLog);
  child.stderr.pipe(errorLog);
  const stateFile = path.join(directory, "job-state.json");
  const state = { id, status: "running", agent: selected.name, pid: child.pid, createdAt: new Date().toISOString(), message: "正在根据精修结果重新导出" };
  await writeJsonFile(stateFile, state);
  child.on("error", async (error) => {
    await writeJsonFile(stateFile, { ...state, status: "failed", error: error.message, finishedAt: new Date().toISOString() });
  });
  child.on("close", async (code, signal) => {
    outputLog.end();
    errorLog.end();
    const latest = await readJsonFile(stateFile, state);
    await writeJsonFile(stateFile, { ...latest, status: code === 0 ? "completed" : "failed", exitCode: code, signal, ...(code === 0 ? { message: "精修版已导出并验证" } : { error: `导出 Agent 退出，代码 ${code ?? "unknown"}` }), finishedAt: new Date().toISOString() });
  });
  return { id, status: "running", agent: selected.name };
}

async function route(request) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders(request) });
  const origin = request.headers.origin;
  if (origin && !localOrigin(origin)) return json(request, 403, { error: "本地桥只接受 localhost 页面。" });
  const url = new URL(request.url);
  const asset = request.method === "GET" ? await staticResponse(request, url.pathname) : null;
  if (asset) return asset;
  if (request.method === "GET" && url.pathname === "/api/health") return json(request, 200, { ok: true, version: 1 });
  if (request.method === "GET" && url.pathname === "/api/capabilities") return json(request, 200, capabilities());
  if (request.method === "POST" && url.pathname === "/api/pick-file") {
    const result = await pickLocalFile();
    if (result.supported === false) return json(request, 501, { error: "当前系统请使用浏览器文件选择器，并在视频位置填写完整路径。" });
    return json(request, 200, result);
  }
  if (request.method === "POST" && url.pathname === "/api/detect-source") {
    const body = await readJson(request);
    return json(request, 200, { kind: sourceKind(body.source) });
  }
  if (request.method === "POST" && url.pathname === "/api/jobs") {
    const body = await readJson(request);
    return json(request, 201, await launchJob(body));
  }
  const mediaMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/media$/);
  if (request.method === "GET" && mediaMatch) return mediaResponse(request, mediaMatch[1]);
  const localMediaMatch = url.pathname.match(/^\/api\/local-media\/([^/]+)$/);
  if (request.method === "GET" && localMediaMatch) return selectedMediaResponse(request, localMediaMatch[1]);
  const statusMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (request.method === "GET" && statusMatch) return json(request, 200, await jobStatus(statusMatch[1]));
  const actionMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/(refine|export)$/);
  if (request.method === "POST" && actionMatch) {
    const body = await readJson(request);
    const directory = safeJobDirectory(actionMatch[1]);
    if (actionMatch[2] === "export") return json(request, 202, await launchExport(actionMatch[1], body));
    const file = "studio-refinements.json";
    await writeJsonFile(path.join(directory, "work", file), body);
    return json(request, 200, { ok: true, path: path.join(directory, "work", file) });
  }
  return json(request, 404, { error: "Not found" });
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const request = new Request(`http://127.0.0.1:${port}${incoming.url}`, {
      method: incoming.method,
      headers: incoming.headers,
      body: incoming.method === "GET" || incoming.method === "HEAD" ? undefined : incoming,
      duplex: "half",
    });
    const response = await route(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        outgoing.write(value);
      }
    }
    outgoing.end();
  } catch (error) {
    const response = json(new Request(`http://127.0.0.1:${port}`), 400, { error: error instanceof Error ? error.message : "未知错误" });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(await response.text());
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`自学型熟肉机: http://127.0.0.1:${port}\nJobs: ${jobsRoot}\n`);
});
