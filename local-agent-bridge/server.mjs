import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat, statfs, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { deflateSync } from "node:zlib";
import { ProxyAgent } from "undici";
import { ambiguityReviewModeFromConfig, ambiguityReviewPolicyPrompt, workflowPhaseStatus } from "./ambiguity-policy.mjs";
import { ensureManagedUv, findExecutable, managedInstallCapabilities, managedUvPath, managedUvxPath, readRuntimeManifest, runtimeEnvironmentKey, runtimePlatformKey } from "./runtime-manager.mjs";

const bridgeDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(bridgeDirectory, "..");
const staticRoot = path.join(projectRoot, "standalone");
const harnessPath = path.join(projectRoot, "harness", "precision-video-subtitles", "SKILL.md");
const apiHelperPath = path.join(bridgeDirectory, "api-model-call.mjs");
const runtimeManifestPath = path.join(projectRoot, "runtime", "runtime-manifest.json");
const apiPricingManifestPath = path.join(projectRoot, "runtime", "api-pricing.json");
const packagedToolchainRoot = path.join(projectRoot, "runtime", "toolchain");
const jobsRoot = process.env.PSS_JOBS_PATH
  ? path.resolve(process.env.PSS_JOBS_PATH)
  : path.join(projectRoot, ".precision-subtitle-studio", "jobs");
const dataRoot = path.dirname(jobsRoot);
const knowledgeRoot = path.join(dataRoot, "knowledge");
const previewRoot = path.join(dataRoot, "research-previews");
const defaultAsrRoot = process.env.PSS_ASR_ROOT
  ? path.resolve(process.env.PSS_ASR_ROOT)
  : path.join(projectRoot, ".precision-subtitle-studio", "asr");
const localRuntimeRoot = process.env.PSS_ASR_LOCAL_RUNTIME_ROOT
  ? path.resolve(process.env.PSS_ASR_LOCAL_RUNTIME_ROOT)
  : process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "SelfLearningSubtitleStudio", "runtimes")
    : process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA || os.homedir(), "SelfLearningSubtitleStudio", "runtimes")
      : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "self-learning-subtitle-studio", "runtimes");
const runtimeManifest = await readRuntimeManifest(runtimeManifestPath);
const currentRuntimePlatform = runtimePlatformKey();
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
  resolve_ambiguities: "正在分级复核关键疑点并自动放行低风险项",
  subtitle_qc: "正在检查两行限制、角色色与时序",
  mux: "正在封装视频与字幕轨",
  final_validation: "正在验证媒体流与成片完整性",
};
const phaseDisplayLabels = {
  acquire: "获取素材",
  research: "背景预习",
  source_transcript: "原文听写",
  translate: "精准翻译",
  resolve_ambiguities: "疑点复核",
  subtitle_qc: "字幕质检",
  mux: "视频封装",
  final_validation: "最终验证",
};
const localMediaTokens = new Map();
const engineChallengeImages = new Map();
const researchRuns = new Map();
const transcriptionOperations = new Map();
const activeTranscriptionInstallRoots = new Map();
const transcriptionInstallLockRoots = new Map();
const proxyDispatchers = new Map();
const jobResourceCache = new Map();
const jobPhaseStatusCache = new Map();
const activeJobProcesses = new Map();

await Promise.all([jobsRoot, knowledgeRoot, previewRoot].map((directory) => mkdir(directory, { recursive: true })));

const challengeColors = [
  { label: "RED", rgb: [222, 55, 75] },
  { label: "BLUE", rgb: [55, 104, 222] },
  { label: "GREEN", rgb: [35, 163, 99] },
  { label: "PURPLE", rgb: [139, 73, 204] },
  { label: "ORANGE", rgb: [234, 129, 35] },
];
const digitGlyphs = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
};

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return output;
}

function challengePng(code, color) {
  const width = 640;
  const height = 320;
  const pixels = Buffer.alloc(width * height * 3, 255);
  const fillRect = (x, y, w, h, rgb) => {
    for (let row = Math.max(0, y); row < Math.min(height, y + h); row += 1) {
      for (let column = Math.max(0, x); column < Math.min(width, x + w); column += 1) {
        const offset = (row * width + column) * 3;
        pixels[offset] = rgb[0];
        pixels[offset + 1] = rgb[1];
        pixels[offset + 2] = rgb[2];
      }
    }
  };
  fillRect(0, 0, width, 8, [28, 40, 61]);
  fillRect(0, height - 8, width, 8, [28, 40, 61]);
  const scale = 16;
  const digitWidth = 5 * scale;
  const gap = scale;
  const totalWidth = code.length * digitWidth + (code.length - 1) * gap;
  let cursor = Math.floor((width - totalWidth) / 2);
  for (const digit of code) {
    const glyph = digitGlyphs[digit];
    glyph.forEach((row, rowIndex) => [...row].forEach((pixel, columnIndex) => {
      if (pixel === "1") fillRect(cursor + columnIndex * scale, 34 + rowIndex * scale, scale, scale, [25, 36, 54]);
    }));
    cursor += digitWidth + gap;
  }
  fillRect(54, 180, 532, 96, [25, 36, 54]);
  fillRect(62, 188, 516, 80, color.rgb);
  const rows = Buffer.alloc(height * (1 + width * 3));
  for (let row = 0; row < height; row += 1) {
    const destination = row * (1 + width * 3);
    rows[destination] = 0;
    pixels.copy(rows, destination + 1, row * width * 3, (row + 1) * width * 3);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function createEngineChallenge() {
  const id = randomUUID();
  const seed = Number.parseInt(id.replaceAll("-", "").slice(0, 8), 16);
  const code = String(10_000 + (seed % 90_000));
  const color = challengeColors[seed % challengeColors.length];
  const png = challengePng(code, color);
  const directory = path.join(previewRoot, `engine-challenge-${id}`);
  await mkdir(directory, { recursive: true });
  const imagePath = path.join(directory, "challenge.png");
  await writeFile(imagePath, png);
  for (const [key, value] of engineChallengeImages) {
    if (value.expiresAt < Date.now()) engineChallengeImages.delete(key);
  }
  engineChallengeImages.set(id, { png, expiresAt: Date.now() + 15 * 60 * 1000 });
  return { id, code, color: color.label, png, imagePath };
}

const apiPricingManifest = JSON.parse(readFileSync(apiPricingManifestPath, "utf8"));
const pricingFor = (provider) => apiPricingManifest.providers?.[provider]?.models || {};
const pricingDocsFor = (provider) => apiPricingManifest.providers?.[provider]?.docsUrl || "";

const apiPresets = {
  openai: { label: "GPT / OpenAI API", baseUrl: "https://api.openai.com/v1", models: ["gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna"], multimodal: "native", docsUrl: "https://developers.openai.com/api/docs/models/compare", checkedAt: "2026-08-16", note: "仅推荐官方当前支持图像输入的 5.6 系列；默认使用稳定旗舰别名 gpt-5.6", pricing: pricingFor("openai"), pricingDocsUrl: pricingDocsFor("openai") },
  xai: { label: "Grok / xAI", baseUrl: "https://api.x.ai/v1", models: ["grok-4.6", "grok-4.6-latest"], multimodal: "native", docsUrl: "https://docs.x.ai/developers/models", checkedAt: "2026-08-16", note: "官方推荐 Grok 4.6 稳定别名；账户快照与内部版本不会抢占默认选择", pricing: pricingFor("xai"), pricingDocsUrl: pricingDocsFor("xai") },
  deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com", models: [], multimodal: "unavailable", docsUrl: "https://api-docs.deepseek.com/updates", checkedAt: "2026-08-16", note: "DeepSeek V4 官方 API 当前是文本模型，不能通过本项目必需的图片能力测试", pricing: pricingFor("deepseek"), pricingDocsUrl: pricingDocsFor("deepseek") },
  kimi: { label: "Kimi / Moonshot（中国站）", baseUrl: "https://api.moonshot.cn/v1", models: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6"], multimodal: "native", docsUrl: "https://platform.kimi.com/docs/guide/use-kimi-vision-model", checkedAt: "2026-08-16", note: "K3 为通用多模态旗舰；K2.7 Code 与 K2.6 同样支持图像/视频输入", pricing: pricingFor("kimi"), pricingDocsUrl: pricingDocsFor("kimi") },
  kimi_intl: { label: "Kimi / Moonshot（国际站）", baseUrl: "https://api.moonshot.ai/v1", models: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6"], multimodal: "native", docsUrl: "https://www.kimi.com/help/kimi-api/api-overview", checkedAt: "2026-08-16", note: "K3 为通用多模态旗舰；国际站 Key 与中国站 Key 不互通", pricing: pricingFor("kimi_intl"), pricingDocsUrl: pricingDocsFor("kimi_intl") },
  mimo: { label: "小米 MiMo", baseUrl: "https://api.xiaomimimo.com/v1", models: ["mimo-v2.5"], multimodal: "native", docsUrl: "https://mimo.mi.com/docs/zh-CN/quick-start/summary/model", checkedAt: "2026-08-16", note: "mimo-v2.5 是原生全模态模型；Pro 是文本/Agent 旗舰，不用于图像测试", pricing: pricingFor("mimo"), pricingDocsUrl: pricingDocsFor("mimo") },
  minimax: { label: "MiniMax", baseUrl: "https://api.minimaxi.com/v1", models: [], multimodal: "unavailable", docsUrl: "https://platform.minimaxi.com/docs/api-reference/api-overview", checkedAt: "2026-08-16", note: "M2.7 官方定位为文本模型；图片理解需额外 MCP，不能作为直连多模态翻译引擎", pricing: pricingFor("minimax"), pricingDocsUrl: pricingDocsFor("minimax") },
  glm: { label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", models: ["glm-5v-turbo", "glm-4.6v", "glm-4.6v-flashx", "glm-4.6v-flash"], multimodal: "native", docsUrl: "https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5v-turbo", checkedAt: "2026-08-16", note: "优先 GLM-5V-Turbo 多模态模型；不再把纯文本旗舰 GLM-5.2 作为图像测试默认项", pricing: pricingFor("glm"), pricingDocsUrl: pricingDocsFor("glm") },
  compatible: { label: "自定义兼容接口", baseUrl: "", models: [], multimodal: "unknown", note: "接口不提供统一能力元数据，必须通过文字与图片实测后才可使用" },
};

const searchPresets = {
  exa: { label: "Exa Search MCP", url: "https://mcp.exa.ai/mcp", keyHeader: "x-api-key", keyOptional: true, note: "专业网页搜索与正文提取；无 Key 可使用免费限额" },
  tavily: { label: "Tavily Search MCP", url: "https://mcp.tavily.com/mcp/", keyHeader: "Authorization", keyOptional: false, note: "搜索、提取、网站地图与深度研究" },
  builtin: { label: "Agent 内置联网搜索", url: "", keyOptional: true, note: "使用 Codex Web Search 或 Claude WebSearch/WebFetch" },
  custom: { label: "自定义远程 MCP", url: "", keyHeader: "Authorization", keyOptional: true, note: "兼容 Streamable HTTP 的 MCP 服务" },
};

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

function normalizedProxyUrl(value) {
  const proxy = String(value || "").trim();
  if (!proxy) return "";
  let parsed;
  try { parsed = new URL(proxy); } catch { throw new Error("代理地址格式不正确"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("当前代理仅支持 http:// 或 https:// 地址");
  return parsed.toString();
}

function proxyFetchOptions(value) {
  const proxy = normalizedProxyUrl(value);
  if (!proxy) return {};
  if (!proxyDispatchers.has(proxy)) proxyDispatchers.set(proxy, new ProxyAgent(proxy));
  return { dispatcher: proxyDispatchers.get(proxy) };
}

function applyProxyEnv(env, value) {
  const proxy = normalizedProxyUrl(value);
  if (!proxy) return env;
  return {
    ...env,
    PSS_PROXY_URL: proxy,
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    all_proxy: proxy,
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
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

async function pickLocalFolder(prompt = "选择项目内的听写环境文件夹") {
  if (process.platform !== "darwin") return { supported: false };
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/osascript", ["-e", `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk) => { if (output.length < 16_384) output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { if (error.length < 16_384) error += chunk.toString(); });
    child.on("error", reject);
    child.on("close", async (code) => {
      if (code !== 0 && /User canceled|-128/i.test(error)) return resolve({ cancelled: true });
      if (code !== 0) return reject(new Error(error.trim() || "系统文件夹选择器失败"));
      try {
        const selected = await realpath(output.trim());
        const info = await stat(selected);
        if (!info.isDirectory()) throw new Error("选择的不是文件夹");
        resolve({ path: selected });
      } catch (folderError) {
        reject(folderError);
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
  const specialCandidates = name === "codex"
    ? [
        process.env.PSS_CODEX_PATH,
        process.env.CODEX_CLI_PATH,
        "/Applications/ChatGPT.app/Contents/Resources/codex",
        path.join(os.homedir(), ".local", "bin", "codex"),
      ].filter(Boolean)
    : name === "claude"
      ? [
          process.env.PSS_CLAUDE_PATH,
          path.join(os.homedir(), ".local", "bin", "claude"),
        ].filter(Boolean)
    : name === "uv" || name === "uvx"
        ? [
        name === "uv" ? process.env.PSS_UV_PATH : process.env.PSS_UVX_PATH,
        name === "uv" ? managedUvPath(localRuntimeRoot, runtimeManifest) : null,
        name === "uvx" ? managedUvxPath(localRuntimeRoot, runtimeManifest) : null,
        path.join(packagedToolchainRoot, currentRuntimePlatform, process.platform === "win32" ? `${name}.exe` : name),
        path.join(projectRoot, ".tools", "uv", name),
        path.join(os.homedir(), ".local", "bin", name),
        ].filter(Boolean)
        : [
          path.join(packagedToolchainRoot, currentRuntimePlatform, process.platform === "win32" ? `${name}.exe` : name),
        ];
  return findExecutable(name, { extraCandidates: specialCandidates });
}

async function settleOutputStreams(...streams) {
  await Promise.allSettled(streams.map((stream) => finished(stream, { cleanup: true })));
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

function yamlScalar(text, key) {
  const match = String(text || "").match(new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*:\\s*([^#\\r\\n]+)`, "m"));
  return match ? match[1].trim().replace(/^['"]|['"]$/g, "") : "";
}

function clashVergeProxySuggestion() {
  const roots = [
    path.join(os.homedir(), "Library", "Application Support", "io.github.clash-verge-rev.clash-verge-rev"),
    path.join(os.homedir(), ".config", "clash-verge-rev"),
    path.join(os.homedir(), ".config", "clash-verge"),
  ];
  for (const root of roots) {
    const vergePath = path.join(root, "verge.yaml");
    const configPath = path.join(root, "config.yaml");
    if (!existsSync(vergePath) && !existsSync(configPath)) continue;
    try {
      const verge = existsSync(vergePath) ? readFileSync(vergePath, "utf8") : "";
      const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
      const portValue = yamlScalar(verge, "verge_mixed_port") || yamlScalar(config, "mixed-port") || "7897";
      const portNumber = Number(portValue);
      const host = yamlScalar(verge, "proxy_host") || "127.0.0.1";
      const enabledValue = yamlScalar(verge, "enable_system_proxy").toLowerCase();
      const enabled = enabledValue === "true";
      if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) continue;
      return {
        detected: true,
        enabled,
        url: `http://${host}:${portNumber}`,
        source: "Clash Verge Rev",
        detail: enabled ? "已按 Clash Verge 当前系统代理设置启用" : "已读取 Clash Verge 地址，但它当前未启用系统代理",
      };
    } catch {
      // Ignore unreadable local preferences and leave proxy disabled.
    }
  }
  return { detected: false, enabled: false, url: "", source: "Clash Verge", detail: "未检测到 Clash Verge 本机配置" };
}

function capabilities() {
  const names = ["codex", "claude", "opencode", "pi", "cline", "deepseek", "ollama", "ffmpeg", "ffprobe", "yutto", "yt-dlp", "uv", "uvx"];
  const tools = Object.fromEntries(names.map((name) => {
    const location = executable(name);
    return [name, { available: Boolean(location), ...(location ? { path: location } : {}) }];
  }));
  if (!tools.yutto.available && tools.uvx.available) tools.yutto = { available: true, path: tools.uvx.path, detail: `通过 uvx 按需运行 yutto ${runtimeManifest.environments.yutto.packages[0].split("==")[1]}` };
  tools.gpu = { available: true, detail: gpuDetail() };
  const managedUv = managedUvPath(localRuntimeRoot, runtimeManifest);
  return {
    bridge: { available: true, version: 3, jobsRoot, projectRoot, defaultTranscriptionEnvironment: defaultAsrRoot },
    runtime: {
      platform: currentRuntimePlatform,
      supported: Boolean(runtimeManifest.uv.assets[currentRuntimePlatform]),
      uvVersion: runtimeManifest.uv.version,
      pythonVersion: runtimeManifest.python.version,
      managedUvReady: Boolean(findExecutable(managedUv, { extraCandidates: [managedUv] })),
      managedRoot: localRuntimeRoot,
      environmentKeys: Object.fromEntries(Object.entries(runtimeManifest.environments).map(([name, value]) => [name, runtimeEnvironmentKey(value.packages)])),
    },
    tools,
    apiPresets,
    searchPresets,
    proxySuggestion: clashVergeProxySuggestion(),
  };
}

const transcriptionModelProfiles = {
  tiny: { downloadBytes: 80_000_000, memoryBytes: 900_000_000, label: "Tiny（快速试用）" },
  base: { downloadBytes: 150_000_000, memoryBytes: 1_200_000_000, label: "Base（轻量）" },
  small: { downloadBytes: 500_000_000, memoryBytes: 2_000_000_000, label: "Small（均衡）" },
  medium: { downloadBytes: 1_600_000_000, memoryBytes: 4_000_000_000, label: "Medium（高精）" },
  "large-v3": { downloadBytes: 3_200_000_000, memoryBytes: 6_000_000_000, label: "Large v3（最高精度）" },
  turbo: { downloadBytes: 1_700_000_000, memoryBytes: 4_000_000_000, label: "Turbo（速度与精度平衡）" },
};

const fasterWhisperRepositories = {
  tiny: "models--Systran--faster-whisper-tiny",
  base: "models--Systran--faster-whisper-base",
  small: "models--Systran--faster-whisper-small",
  medium: "models--Systran--faster-whisper-medium",
  "large-v3": "models--Systran--faster-whisper-large-v3",
  turbo: "models--mobiuslabsgmbh--faster-whisper-large-v3-turbo",
};

function formatStorage(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "未知";
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(bytes >= 10_000_000_000 ? 0 : 1)} GB`;
  return `${Math.ceil(bytes / 1_000_000)} MB`;
}

function filesystemType(value) {
  const target = existingAncestor(value);
  if (process.platform === "darwin") {
    const mountProbe = spawnSync("/sbin/mount", [], { encoding: "utf8", timeout: 5000, maxBuffer: 512 * 1024 });
    const rows = mountProbe.status === 0 ? mountProbe.stdout.split("\n") : [];
    const mounts = rows.map((line) => {
      const match = line.match(/ on (.+?) \(([^,)]+)/);
      return match ? { mount: match[1], type: match[2].toLowerCase() } : null;
    }).filter(Boolean).sort((a, b) => b.mount.length - a.mount.length);
    return mounts.find((item) => item.mount === "/" || target === item.mount || target.startsWith(`${item.mount}/`))?.type || "unknown";
  }
  if (process.platform === "win32") {
    const drive = path.parse(target).root.slice(0, 1);
    const probe = spawnSync("powershell.exe", ["-NoProfile", "-Command", `(Get-Volume -DriveLetter '${drive}').FileSystem`], { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 });
    return probe.status === 0 ? probe.stdout.trim().toLowerCase() || "unknown" : "unknown";
  }
  const probe = spawnSync("df", ["-T", target], { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 });
  if (probe.status !== 0) return "unknown";
  return probe.stdout.trim().split("\n").at(-1)?.trim().split(/\s+/)[1]?.toLowerCase() || "unknown";
}

function venvPython(runtimePath) {
  return process.platform === "win32" ? path.join(runtimePath, "Scripts", "python.exe") : path.join(runtimePath, "bin", "python");
}

function runtimeCompatibility(value) {
  const type = filesystemType(value);
  const nativeTypes = process.platform === "win32"
    ? /^(ntfs|refs)$/i
    : process.platform === "darwin"
      ? /^(apfs|hfs|hfs\+)$/i
      : /^(ext[234]?|xfs|btrfs|zfs|tmpfs|overlay|aufs)$/i;
  const compatible = nativeTypes.test(type);
  return {
    type,
    compatible,
    reason: compatible
      ? "文件系统支持 Python 运行环境所需的链接与权限语义"
      : type === "unknown"
        ? "无法确认文件系统能力；为避免损坏，运行库将使用本机应用数据目录"
        : `${type.toUpperCase()} 不是当前系统可靠的原生运行盘，可能因链接、权限或元数据文件导致安装中断`,
  };
}

function environmentKey(value) {
  return createHash("sha256").update(path.resolve(value)).digest("hex").slice(0, 16);
}

function transcriptionPaths(input = {}) {
  const requested = String(input.environmentRoot || "").trim();
  const root = requested
    ? path.resolve(requested.replace(/^~\//, `${os.homedir()}/`))
    : defaultAsrRoot;
  const compatibility = runtimeCompatibility(root);
  const configuredRuntimeRoot = String(input.runtimeRoot || "").trim();
  const runtimeRoot = configuredRuntimeRoot
    ? path.resolve(configuredRuntimeRoot.replace(/^~\//, `${os.homedir()}/`))
    : compatibility.compatible
      ? path.join(root, "runtimes")
      : path.join(localRuntimeRoot, environmentKey(root));
  return {
    root,
    runtimeRoot,
    baseRuntimePath: path.join(runtimeRoot, "base"),
    diarizationRuntimePath: path.join(runtimeRoot, "diarization"),
    modelRoot: path.join(root, "models"),
    filesystem: compatibility,
  };
}

function asrPythonCandidates(paths) {
  return [...new Set([
    process.env.PSS_ASR_PYTHON,
    venvPython(paths.baseRuntimePath),
    executable("python3"),
    executable("python"),
  ].filter(Boolean))];
}

function pythonModuleState(python, modules, options = {}) {
  const empty = Object.fromEntries(modules.map((name) => [name, false]));
  if (!python || !existsSync(python)) return Promise.resolve(empty);
  const timeoutMs = Number(options.timeoutMs || 45_000);
  return new Promise((resolve) => {
    const probe = spawn(python, ["-c", `import importlib,json
state={}
errors={}
for name in ${JSON.stringify(modules)}:
    try:
        importlib.import_module(name)
        state[name]=True
    except Exception as exc:
        state[name]=False
        errors[name]=f"{type(exc).__name__}: {exc}"
state["_errors"]=errors
print(json.dumps(state))`], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONNOUSERSITE: "1" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const collect = (current, chunk) => `${current}${chunk}`.slice(-128 * 1024);
    probe.stdout.on("data", (chunk) => { stdout = collect(stdout, chunk); });
    probe.stderr.on("data", (chunk) => { stderr = collect(stderr, chunk); });
    probe.on("error", (error) => finish({ ...empty, _errors: { probe: `无法启动 Python 导入检查：${error.message}` } }));
    probe.on("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const reason = stderr.trim() || stdout.trim() || `Python 进程退出代码 ${code ?? "unknown"}${signal ? `（${signal}）` : ""}`;
        finish({ ...empty, _errors: { probe: reason } });
        return;
      }
      try {
        finish(JSON.parse(stdout.trim()));
      } catch {
        finish({ ...empty, _errors: { probe: `无法解析 Python 模块检查结果${stdout.trim() ? `：${stdout.trim().slice(-800)}` : ""}` } });
      }
    });
    const timer = setTimeout(() => {
      probe.kill("SIGKILL");
      finish({
        ...empty,
        _timedOut: true,
        _errors: { probe: `模块首次加载超过 ${Math.ceil(timeoutMs / 1000)} 秒：${modules.join("、")}。安装可能已经成功，可稍后重新检查；若持续超时再查看本机安全软件或磁盘状态。` },
      });
    }, timeoutMs);
  });
}

function pythonVersion(python) {
  if (!python || !existsSync(python)) return null;
  const probe = spawnSync(python, ["-c", "import json,sys; print(json.dumps(list(sys.version_info[:3])))"], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
  if (probe.status !== 0) return null;
  try {
    const parts = JSON.parse(probe.stdout.trim()).map(Number);
    return parts.length === 3 && parts.every(Number.isFinite) ? parts : null;
  } catch {
    return null;
  }
}

function pythonSupports(version, minimumMinor, maximumMinor = Infinity) {
  return Boolean(version && version[0] === 3 && version[1] >= minimumMinor && version[1] < maximumMinor);
}

async function fasterWhisperModelReady(modelRoot, repository, model) {
  const candidates = repository
    ? [repository]
    : (await readdir(modelRoot).catch(() => [])).filter((item) => item.toLowerCase().includes(String(model).toLowerCase().replaceAll("/", "--")));
  for (const candidate of candidates) {
    const snapshotsRoot = path.join(modelRoot, candidate, "snapshots");
    const snapshots = await readdir(snapshotsRoot).catch(() => []);
    for (const snapshot of snapshots.filter((item) => !item.startsWith("._"))) {
      const directory = path.join(snapshotsRoot, snapshot);
      const [modelFile, configFile, tokenizerFile, vocabularyFile] = await Promise.all([
        stat(path.join(directory, "model.bin")).catch(() => null),
        stat(path.join(directory, "config.json")).catch(() => null),
        stat(path.join(directory, "tokenizer.json")).catch(() => null),
        stat(path.join(directory, "vocabulary.json")).catch(() => null),
      ]);
      if (modelFile?.isFile() && modelFile.size > 10_000_000 && configFile?.size > 0 && (tokenizerFile?.size > 0 || vocabularyFile?.size > 0)) return true;
    }
  }
  return false;
}

function existingAncestor(value) {
  let current = path.resolve(value);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return projectRoot;
    current = parent;
  }
  return current;
}

async function transcriptionEnvironment(input = {}) {
  const mode = String(input.mode || "local");
  const provider = String(input.provider || "faster_whisper");
  const model = String(input.model || "turbo");
  const wantsDiarization = input.diarization !== false;
  const paths = transcriptionPaths(input);
  const profile = transcriptionModelProfiles[model] || { downloadBytes: 0, memoryBytes: 0, label: model };
  const fsInfo = await statfs(existingAncestor(paths.root)).catch(() => null);
  const freeDiskBytes = fsInfo ? Number(fsInfo.bavail) * Number(fsInfo.bsize) : 0;
  const memoryBytes = os.totalmem();
  const common = {
    mode,
    provider,
    model,
    environmentRoot: paths.root,
    cachePath: paths.modelRoot,
    runtimePath: paths.baseRuntimePath,
    diarizationRuntimePath: paths.diarizationRuntimePath,
    storageLayout: {
      filesystem: paths.filesystem.type,
      runtimeCompatible: paths.filesystem.compatible,
      mode: paths.filesystem.compatible ? "project" : "split",
      reason: paths.filesystem.reason,
      dataPath: paths.root,
      runtimePath: paths.baseRuntimePath,
      diarizationRuntimePath: paths.diarizationRuntimePath,
    },
    resources: {
      downloadBytes: profile.downloadBytes,
      downloadLabel: formatStorage(profile.downloadBytes),
      recommendedMemoryBytes: profile.memoryBytes,
      recommendedMemoryLabel: formatStorage(profile.memoryBytes),
      systemMemoryBytes: memoryBytes,
      systemMemoryLabel: formatStorage(memoryBytes),
      freeDiskBytes,
      freeDiskLabel: formatStorage(freeDiskBytes),
      diskSufficient: !profile.downloadBytes || freeDiskBytes >= profile.downloadBytes * 2.2,
      memorySufficient: !profile.memoryBytes || memoryBytes >= profile.memoryBytes,
    },
  };
  if (mode === "api") {
    const keyReady = Boolean(String(input.apiKey || "").trim());
    const endpointReady = Boolean(String(input.baseUrl || "").trim());
    return {
      ...common,
      ready: keyReady && endpointReady,
      baseReady: keyReady && endpointReady,
      components: [
        { id: "endpoint", label: "在线接口", status: endpointReady ? "ready" : "missing", detail: endpointReady ? String(input.baseUrl) : "尚未填写 Base URL" },
        { id: "credential", label: "访问密钥", status: keyReady ? "ready" : "missing", detail: keyReady ? "已填写，仅在启动任务时传递" : "尚未填写 API Key" },
        { id: "model", label: "听写模型", status: model ? "ready" : "missing", detail: model || "尚未选择模型" },
      ],
      recommendation: keyReady && endpointReady ? "在线听写配置已填写；开始任务时会再次做连通性检查。" : "请先补齐在线听写接口与密钥。",
    };
  }

  if (provider !== "faster_whisper") {
    const command = provider === "whisper_cpp" ? executable("whisper-cli") || executable("whisper.cpp") : executable("whisper");
    return {
      ...common,
      ready: Boolean(command),
      baseReady: Boolean(command),
      components: [
        { id: "runtime", label: provider === "whisper_cpp" ? "whisper.cpp" : "OpenAI Whisper CLI", status: command ? "ready" : "missing", detail: command || "当前版本暂不能自动安装此运行器，请改用 Faster-Whisper 或在线 API" },
      ],
      recommendation: command ? "已发现听写程序；开始时会继续核对模型文件。" : "推荐切换到 Faster-Whisper，使用内置环境检查与按需安装。",
    };
  }

  let python = "";
  let modules = { faster_whisper: false, ctranslate2: false };
  let importErrors = {};
  for (const candidate of asrPythonCandidates(paths)) {
    const result = await pythonModuleState(candidate, ["faster_whisper", "ctranslate2"]);
    if (result.faster_whisper && result.ctranslate2) {
      python = candidate;
      modules = result;
      importErrors = result._errors || {};
      break;
    }
    if (!python && existsSync(candidate)) { python = candidate; modules = result; importErrors = result._errors || {}; }
  }
  const repository = fasterWhisperRepositories[model];
  const modelReady = await fasterWhisperModelReady(paths.modelRoot, repository, model);
  const runtimeReady = Boolean(modules.faster_whisper && modules.ctranslate2);
  const diarizationPython = venvPython(paths.diarizationRuntimePath);
  const diarizationModules = wantsDiarization
    ? await pythonModuleState(diarizationPython, ["whisperx.asr", "whisperx.diarize", "transformers", "pandas", "torch", "sympy"], { timeoutMs: 120_000 })
    : {};
  const diarizationImportReady = wantsDiarization && ["whisperx.asr", "whisperx.diarize", "transformers", "pandas", "torch", "sympy"].every((name) => diarizationModules[name]);
  const hfTokenReady = Boolean(String(input.hfToken || "").trim() || process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN);
  const diarizationReady = Boolean(diarizationImportReady && hfTokenReady);
  const baseReady = runtimeReady && modelReady;
  const uv = executable("uv");
  const managedUv = managedUvPath(localRuntimeRoot, runtimeManifest);
  const toolchainSupported = Boolean(runtimeManifest.uv.assets[currentRuntimePlatform]);
  const baseEnvironmentPython = venvPython(paths.baseRuntimePath);
  const baseEnvironmentPythonVersion = pythonVersion(baseEnvironmentPython);
  const systemPython = executable("python3") || executable("python");
  const systemPythonVersion = pythonVersion(systemPython);
  const installCapabilities = managedInstallCapabilities({
    uvAvailable: Boolean(uv),
    toolchainSupported,
    basePythonVersion: baseEnvironmentPythonVersion,
    systemPythonVersion,
  });
  const baseInstallable = installCapabilities.base;
  const diarizationInstallable = installCapabilities.diarization;
  const previousInstall = await readJsonFile(path.join(paths.root, "install-state.json"));
  const issues = [];
  if (!runtimeReady) issues.push({
    id: "runtime-import",
    label: "基础听写库无法完整导入",
    detail: Object.values(importErrors).filter(Boolean).join("；") || "运行库不完整或依赖缺失",
    repair: "重新配置基础听写运行库；程序会补齐 tokenizers 等依赖，不必重复下载完整模型。",
  });
  if (!modelReady) issues.push({ id: "model-cache", label: "模型缓存不完整", detail: `未发现 ${profile.label} 的完整快照`, repair: "继续下载模型；已存在文件会被复用。" });
  if (wantsDiarization && !diarizationImportReady) issues.push({
    id: "diarization-import",
    label: "说话人分离环境未通过深度检查",
    detail: Object.values(diarizationModules._errors || {}).filter(Boolean).join("；") || "WhisperX 或其深层依赖尚未完整安装",
    repair: "单独配置说话人分离；程序会先在临时环境安装并验证，失败不会影响基础听写。",
  });
  if (wantsDiarization && diarizationImportReady && !hfTokenReady) issues.push({
    id: "diarization-token",
    label: "说话人分离缺少授权",
    detail: "WhisperX 已可导入，但尚未提供 Hugging Face Token，或尚未接受相关模型条款。",
    repair: "在界面临时填写 Hugging Face Token，并先在 Hugging Face 接受所用说话人模型的条款。",
  });
  const currentEnvironmentHealthy = baseReady && (!wantsDiarization || diarizationReady);
  if (previousInstall?.status === "failed" && !currentEnvironmentHealthy) issues.push({ id: "last-install", label: "上次配置中断", detail: previousInstall.error || "上次配置未完成", repair: "按上方缺失项重试；不需要删除整个环境。" });
  return {
    ...common,
    python,
    ready: baseReady && (!wantsDiarization || diarizationReady),
    baseReady,
    components: [
      { id: "runtime", label: "基础听写运行库", status: runtimeReady ? "ready" : "missing", detail: runtimeReady ? `Faster-Whisper 与 CTranslate2 已存在 · ${python}` : "尚未安装到项目独立环境" },
      { id: "model", label: `${profile.label} 模型`, status: modelReady ? "ready" : "missing", detail: modelReady ? `已缓存在 ${paths.modelRoot}` : `预计下载 ${formatStorage(profile.downloadBytes)}` },
      { id: "diarization", label: "说话人分离（可选）", status: !wantsDiarization ? "optional" : diarizationReady ? "ready" : "missing", detail: !wantsDiarization ? "当前未启用，不影响基础听写" : diarizationImportReady ? "WhisperX 独立环境已验证，但还需要 Hugging Face Token 与模型条款授权" : `需要单独配置 WhisperX；不会修改基础听写环境${paths.filesystem.compatible ? "" : "，运行库会自动放到本机兼容磁盘"}` },
      { id: "ffmpeg", label: "音频抽取", status: executable("ffmpeg") ? "ready" : "missing", detail: executable("ffmpeg") || "未发现 FFmpeg" },
    ],
    installable: baseInstallable,
    installationCapabilities: {
      base: baseInstallable,
      diarization: diarizationInstallable,
      systemPython: systemPythonVersion ? `Python ${systemPythonVersion.join(".")}` : "未发现 Python 3",
      basePython: baseEnvironmentPythonVersion ? `Python ${baseEnvironmentPythonVersion.join(".")}` : "基础环境尚未创建",
      managedToolchain: toolchainSupported,
    },
    installer: uv
      ? `应用托管 uv ${runtimeManifest.uv.version}（自动准备 Python ${runtimeManifest.python.version}）`
      : toolchainSupported
        ? `首次配置时下载并校验 uv ${runtimeManifest.uv.version} + Python ${runtimeManifest.python.version}`
        : baseInstallable
          ? `${systemPythonVersion ? `Python ${systemPythonVersion.join(".")}` : "现有 Python"} venv（兼容回退）`
          : "不可用",
    managedRuntime: {
      platform: currentRuntimePlatform,
      supported: toolchainSupported,
      uvVersion: runtimeManifest.uv.version,
      uvReady: Boolean(uv),
      uvPath: uv || managedUv,
      pythonVersion: runtimeManifest.python.version,
      pythonReady: pythonSupports(baseEnvironmentPythonVersion, 10, 14),
      pythonPath: existsSync(baseEnvironmentPython) ? baseEnvironmentPython : "",
      baseEnvironmentKey: runtimeEnvironmentKey(runtimeManifest.environments["asr-base"].packages),
      diarizationEnvironmentKey: runtimeEnvironmentKey(runtimeManifest.environments.diarization.packages),
      isolation: "基础听写与说话人分离使用两个独立环境；模型缓存与运行库分开保存",
    },
    diagnostics: {
      healthy: baseReady && (!wantsDiarization || diarizationReady),
      summary: issues[0]?.detail || "本地听写环境已通过检查",
      issues,
      repairComponents: { runtime: !runtimeReady, model: !modelReady, diarization: wantsDiarization && !diarizationImportReady },
      lastInstall: previousInstall || null,
    },
    recommendation: baseReady
      ? wantsDiarization && !diarizationReady ? "基础听写已可用；若不需要区分说话人，可关闭说话人分离后开始。" : "本地听写环境已准备完成。"
      : paths.filesystem.compatible
        ? "勾选缺失项目并确认后下载；运行库与模型会保存在所选项目数据目录。"
        : "勾选缺失项目并确认后下载；模型留在所选磁盘，运行库会自动放到本机兼容目录。",
  };
}

function appendTranscriptionEvent(operation, stage, text, kind = "info") {
  operation.stage = stage;
  operation.events.push({ at: new Date().toISOString(), kind, text: String(text).slice(0, 1200) });
  if (operation.events.length > 80) operation.events.splice(0, operation.events.length - 80);
}

function runInstallerStep(operation, command, args, label, options = {}) {
  return new Promise((resolve, reject) => {
    appendTranscriptionEvent(operation, label, `${label}…`);
    const child = spawn(command, args, { cwd: projectRoot, env: { ...process.env, ...(options.env || {}) }, stdio: ["ignore", "pipe", "pipe"] });
    operation.pid = child.pid;
    let tail = "";
    const collect = (chunk) => { tail = `${tail}${chunk}`.slice(-12_000); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", reject);
    child.on("close", (code) => {
      delete operation.pid;
      if (code === 0) {
        appendTranscriptionEvent(operation, label, `${label}完成`, "done");
        resolve();
      } else reject(new Error(`${label}失败（代码 ${code ?? "unknown"}）${tail.trim() ? `：${tail.trim().slice(-1800)}` : ""}`));
    });
  });
}

function localSourcePath(value) {
  const source = String(value || "").trim().replace(/^file:\/\//, "");
  if (sourceKind(source) !== "local") return "";
  return source.startsWith("~/") ? path.join(os.homedir(), source.slice(2)) : path.resolve(source);
}

function operationStep(operation, stage, progress, text) {
  operation.stage = stage;
  operation.progress = progress;
  appendTranscriptionEvent(operation, stage, text || `${stage}…`);
}

async function persistTranscriptionInstall(operation, input) {
  const paths = transcriptionPaths(input);
  await mkdir(paths.root, { recursive: true });
  await writeJsonFile(path.join(paths.root, "install-state.json"), {
    id: operation.id,
    status: operation.status,
    stage: operation.stage,
    progress: operation.progress,
    error: operation.error || "",
    components: input.components || {},
    model: input.model || "",
    events: operation.events.slice(-30),
    createdAt: operation.createdAt,
    finishedAt: operation.finishedAt || null,
  });
}

async function extractTranscriptionSample(operation, source, output) {
  const ffmpeg = executable("ffmpeg");
  const ffprobe = executable("ffprobe");
  if (!ffmpeg || !ffprobe) throw new Error("短音频测试需要 FFmpeg 与 FFprobe");
  const sourcePath = localSourcePath(source);
  if (!sourcePath || !existsSync(sourcePath)) throw new Error("短音频测试目前需要可读取的本地视频；网络视频请先下载或选择本地文件");
  const probe = spawnSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", sourcePath], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
  const duration = Number(probe.stdout.trim());
  if (probe.status !== 0 || !Number.isFinite(duration) || duration <= 0) throw new Error("无法读取媒体时长，不能创建短音频测试片段");
  const sampleDuration = Math.min(20, duration);
  const sampleStart = duration > 25 ? Math.min(10, Math.max(0, duration - sampleDuration)) : 0;
  operationStep(operation, "抽取短音频", 18, `从 ${sampleStart.toFixed(1)} 秒开始抽取 ${sampleDuration.toFixed(1)} 秒单声道音频`);
  await runInstallerStep(operation, ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(sampleStart), "-t", String(sampleDuration), "-i", sourcePath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "flac", output], "抽取短音频");
  return { sourcePath, duration, sampleStart, sampleDuration };
}

async function onlineTranscriptionSample(input, audioPath) {
  const provider = String(input.provider || "compatible_audio");
  const baseUrl = String(input.baseUrl || "").replace(/\/$/, "");
  const key = String(input.apiKey || "").trim();
  if (!baseUrl || !key) throw new Error("在线短音频测试需要 Base URL 与 API Key");
  const audio = await readFile(audioPath);
  if (provider === "deepgram") {
    const endpoint = new URL(`${baseUrl}/listen`);
    endpoint.searchParams.set("model", String(input.model || "nova-3"));
    endpoint.searchParams.set("language", input.language === "auto" ? "multi" : String(input.language || "ja"));
    endpoint.searchParams.set("smart_format", "true");
    if (input.diarization) endpoint.searchParams.set("diarize", "true");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Token ${key}`, "content-type": "audio/flac" },
      body: audio,
      signal: AbortSignal.timeout(120_000),
      ...proxyFetchOptions(input.proxyUrl),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`听写接口返回 HTTP ${response.status}：${JSON.stringify(result).slice(0, 600)}`);
    const alternative = result.results?.channels?.[0]?.alternatives?.[0] || {};
    return { text: String(alternative.transcript || "").trim(), language: input.language || "auto", segments: alternative.words || [], rawSummary: { confidence: alternative.confidence } };
  }
  const form = new FormData();
  form.set("file", new Blob([audio], { type: "audio/flac" }), "studio-test.flac");
  form.set("model", String(input.model || "gpt-4o-mini-transcribe"));
  if (input.language && input.language !== "auto") form.set("language", String(input.language));
  if (String(input.model).includes("diarize")) {
    form.set("response_format", "diarized_json");
    form.set("chunking_strategy", "auto");
  } else {
    form.set("response_format", "verbose_json");
    form.set("timestamp_granularities[]", "segment");
  }
  const response = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
    ...proxyFetchOptions(input.proxyUrl),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`听写接口返回 HTTP ${response.status}：${JSON.stringify(result).slice(0, 600)}`);
  return { text: String(result.text || "").trim(), language: result.language || input.language || "auto", segments: result.segments || [], rawSummary: { duration: result.duration } };
}

async function runTranscriptionTest(operation, input) {
  const started = Date.now();
  const directory = path.join(dataRoot, "asr-tests", operation.id);
  const audioPath = path.join(directory, "sample.flac");
  const outputPath = path.join(directory, "transcript.json");
  try {
    await mkdir(directory, { recursive: true });
    const environment = await transcriptionEnvironment(input);
    if (!environment.ready) throw new Error(`听写环境未就绪：${environment.recommendation}`);
    const sample = await extractTranscriptionSample(operation, input.source, audioPath);
    operationStep(operation, "执行真实听写", 52, input.mode === "api" ? "正在把确认的短音频发送给所选听写服务" : "正在本机加载模型并听写短音频");
    let result;
    if (input.mode === "api") {
      result = await onlineTranscriptionSample(input, audioPath);
    } else if (input.provider === "faster_whisper") {
      const paths = transcriptionPaths(input);
      await runInstallerStep(operation, environment.python, [
        path.join(projectRoot, "harness", "precision-video-subtitles", "scripts", "transcribe_faster_whisper.py"),
        audioPath,
        outputPath,
        "--model", String(input.model || "turbo"),
        "--language", String(input.language || "ja"),
        "--beam-size", String(Math.max(1, Number(input.beamSize) || 5)),
        "--model-cache", paths.modelRoot,
      ], "执行本地听写");
      result = await readJsonFile(outputPath);
    } else {
      throw new Error("当前真实短音频测试支持 Faster-Whisper、OpenAI Audio API、Deepgram 与兼容接口");
    }
    const text = String(result?.text || result?.segments?.map((segment) => segment.text).join("") || "").trim();
    if (!text) throw new Error("听写服务正常结束，但没有识别出任何文字；请换一段有人声的位置或提高模型质量");
    operation.status = "completed";
    operation.progress = 100;
    operation.result = {
      text,
      language: result.language || input.language || "auto",
      segments: Array.isArray(result.segments) ? result.segments.slice(0, 80) : [],
      sampleStart: sample.sampleStart,
      sampleDuration: sample.sampleDuration,
      elapsedMs: Date.now() - started,
      mode: input.mode,
      provider: input.provider,
      model: input.model,
    };
    appendTranscriptionEvent(operation, "完成", `真实听写测试通过，识别出 ${text.length} 个字符`, "done");
  } catch (error) {
    operation.status = "failed";
    operation.error = error instanceof Error ? error.message : String(error);
    appendTranscriptionEvent(operation, "失败", operation.error, "error");
  } finally {
    operation.finishedAt = new Date().toISOString();
    delete operation.pid;
  }
}

function startTranscriptionTest(input) {
  if (!String(input.source || "").trim()) throw new Error("请先选择一个本地视频，再测试短音频听写");
  if (input.mode === "api" && input.uploadConfirmed !== true) throw new Error("在线测试会上传约 20 秒音频，请先明确确认");
  const id = randomUUID();
  const operation = { id, type: "test", status: "running", stage: "排队", progress: 2, events: [], createdAt: new Date().toISOString() };
  transcriptionOperations.set(id, operation);
  void runTranscriptionTest(operation, input);
  return operation;
}

async function runTranscriptionInstall(operation, input) {
  try {
    const paths = transcriptionPaths(input);
    await Promise.all([paths.runtimeRoot, paths.modelRoot].map((directory) => mkdir(directory, { recursive: true })));
    const python = venvPython(paths.baseRuntimePath);
    const components = input.components || {};
    const uvCopyArgs = ["--link-mode=copy"];
    const uvEnv = applyProxyEnv({
      UV_LINK_MODE: "copy",
      UV_CACHE_DIR: path.join(paths.runtimeRoot, "uv-cache"),
      UV_PYTHON_INSTALL_DIR: path.join(localRuntimeRoot, "python"),
      UV_PYTHON_PREFERENCE: runtimeManifest.python.preference,
      UV_PYTHON_DOWNLOADS: "automatic",
    }, input.proxyUrl);
    let uv = executable("uv");
    const systemPython = executable("python3") || executable("python");
    const systemPythonVersion = pythonVersion(systemPython);
    let modelPython = python;
    let existingBase = await pythonModuleState(modelPython, ["faster_whisper", "ctranslate2", "tokenizers"]);
    if (components.model && !components.runtime && (!existingBase.faster_whisper || !existingBase.ctranslate2 || !existingBase.tokenizers)) {
      for (const candidate of asrPythonCandidates(paths)) {
        const candidateState = await pythonModuleState(candidate, ["faster_whisper", "ctranslate2", "tokenizers"]);
        if (candidateState.faster_whisper && candidateState.ctranslate2 && candidateState.tokenizers) {
          modelPython = candidate;
          existingBase = candidateState;
          break;
        }
      }
    }
    if (components.model && !components.runtime && (!existingBase.faster_whisper || !existingBase.ctranslate2 || !existingBase.tokenizers)) {
      throw new Error("下载模型需要基础听写运行库；请同时勾选“基础听写运行库”并确认下载内容");
    }
    if ((components.runtime || components.diarization) && !uv && runtimeManifest.uv.assets[currentRuntimePlatform]) {
      operationStep(operation, "准备托管工具链", 6, `正在准备应用托管 uv ${runtimeManifest.uv.version}`);
      await persistTranscriptionInstall(operation, input);
      const prepared = await ensureManagedUv({
        runtimeRoot: localRuntimeRoot,
        manifestPath: runtimeManifestPath,
        packagedRoot: packagedToolchainRoot,
        fetchOptions: proxyFetchOptions(input.proxyUrl),
        onProgress: (message) => appendTranscriptionEvent(operation, "准备托管工具链", message),
      });
      uv = prepared.path;
      appendTranscriptionEvent(operation, "准备托管工具链", `uv ${prepared.version} 已通过校验并启用（${prepared.source}）`, "done");
    }
    if (components.runtime && !uv && !pythonSupports(systemPythonVersion, 9)) throw new Error(`当前平台 ${currentRuntimePlatform} 没有可用的托管工具链，也未发现 Python 3.9+`);
    if (components.runtime) {
      const stagingPath = `${paths.baseRuntimePath}.staging-${operation.id}`;
      const stagingPython = venvPython(stagingPath);
      const backupPath = `${paths.baseRuntimePath}.previous`;
      try {
        await rm(stagingPath, { recursive: true, force: true });
        operationStep(operation, "准备项目环境", 10, `正在创建隔离的 Python ${runtimeManifest.python.version} 基础听写环境`);
        await persistTranscriptionInstall(operation, input);
        if (uv) await runInstallerStep(operation, uv, ["venv", "--python", runtimeManifest.python.version, stagingPath], "准备项目独立 Python 环境", { env: uvEnv });
        else await runInstallerStep(operation, systemPython, ["-m", "venv", stagingPath], "准备项目独立 Python 环境");

        operationStep(operation, "安装基础运行库", 28, "正在按版本清单安装并核对 Faster-Whisper 的完整依赖");
        await persistTranscriptionInstall(operation, input);
        const runtimePackages = runtimeManifest.environments["asr-base"].packages;
        if (uv) await runInstallerStep(operation, uv, ["pip", "install", ...uvCopyArgs, "--python", stagingPython, ...runtimePackages], "安装基础听写运行库", { env: uvEnv });
        else await runInstallerStep(operation, stagingPython, ["-m", "pip", "install", ...runtimePackages], "安装基础听写运行库", { env: applyProxyEnv({}, input.proxyUrl) });

        operationStep(operation, "验证基础运行库", 44, "正在首次加载 Faster-Whisper；验证通过后才会替换旧环境");
        await persistTranscriptionInstall(operation, input);
        const verified = await pythonModuleState(stagingPython, ["faster_whisper", "ctranslate2", "tokenizers", "huggingface_hub"], { timeoutMs: 120_000 });
        const missing = ["faster_whisper", "ctranslate2", "tokenizers", "huggingface_hub"].filter((name) => !verified[name]);
        if (missing.length) throw new Error(`基础运行库深度验证失败：${missing.join("、")} 无法导入；${Object.values(verified._errors || {}).join("；") || "依赖不完整"}`);
        await writeFile(path.join(stagingPath, "precision-runtime.json"), `${JSON.stringify({
          environment: "asr-base",
          key: runtimeEnvironmentKey(runtimePackages),
          python: runtimeManifest.python.version,
          packages: runtimePackages,
          installedAt: new Date().toISOString(),
        }, null, 2)}\n`, "utf8");
        await rm(backupPath, { recursive: true, force: true });
        if (existsSync(paths.baseRuntimePath)) await rename(paths.baseRuntimePath, backupPath);
        try {
          await rename(stagingPath, paths.baseRuntimePath);
        } catch (error) {
          if (existsSync(backupPath) && !existsSync(paths.baseRuntimePath)) await rename(backupPath, paths.baseRuntimePath);
          throw error;
        }
        await rm(backupPath, { recursive: true, force: true }).catch(() => appendTranscriptionEvent(operation, "清理旧环境", "新基础环境已启用；旧环境备份暂未清理", "warning"));
        modelPython = python;
      } catch (error) {
        await rm(stagingPath, { recursive: true, force: true });
        if (existsSync(backupPath) && !existsSync(paths.baseRuntimePath)) await rename(backupPath, paths.baseRuntimePath);
        throw error;
      }
    }
    if (components.model) {
      operationStep(operation, "下载听写模型", 55, `正在准备 ${input.model || "turbo"} 模型；已下载文件会继续复用`);
      await persistTranscriptionInstall(operation, input);
      await runInstallerStep(operation, modelPython, [path.join(projectRoot, "harness", "precision-video-subtitles", "scripts", "prepare_faster_whisper.py"), "--model", String(input.model || "turbo"), "--model-cache", paths.modelRoot], `下载 ${input.model || "turbo"} 模型`);
    }
    if (components.diarization) {
      operationStep(operation, "安装说话人分离", 78, "正在独立临时环境中安装 WhisperX，不会修改基础听写");
      await persistTranscriptionInstall(operation, input);
      const stagingPath = `${paths.diarizationRuntimePath}.staging-${operation.id}`;
      const stagingPython = venvPython(stagingPath);
      const backupPath = `${paths.diarizationRuntimePath}.previous`;
      try {
        await rm(stagingPath, { recursive: true, force: true });
        if (uv) {
          await runInstallerStep(operation, uv, ["venv", "--python", runtimeManifest.python.version, stagingPath], "准备 WhisperX 临时环境", { env: uvEnv });
          await runInstallerStep(operation, uv, ["pip", "install", ...uvCopyArgs, "--python", stagingPython, ...runtimeManifest.environments.diarization.packages], "安装 WhisperX 说话人分离", { env: uvEnv });
        } else {
          const basePythonVersion = pythonVersion(python);
          const diarizationBootstrap = pythonSupports(basePythonVersion, 10, 14) ? python : systemPython;
          if (!pythonSupports(pythonVersion(diarizationBootstrap), 10, 14)) throw new Error("WhisperX 需要 Python 3.10–3.13；当前平台无法准备兼容环境");
          await runInstallerStep(operation, diarizationBootstrap, ["-m", "venv", stagingPath], "准备 WhisperX 临时环境");
          await runInstallerStep(operation, stagingPython, ["-m", "pip", "install", ...runtimeManifest.environments.diarization.packages], "安装 WhisperX 说话人分离", { env: applyProxyEnv({}, input.proxyUrl) });
        }
        const deepProbe = await pythonModuleState(stagingPython, ["whisperx.asr", "whisperx.diarize", "transformers", "pandas", "torch", "sympy"], { timeoutMs: 180_000 });
        const missing = ["whisperx.asr", "whisperx.diarize", "transformers", "pandas", "torch", "sympy"].filter((name) => !deepProbe[name]);
        if (missing.length) throw new Error(`WhisperX 深度验证失败：${missing.join("、")} 无法导入；${Object.values(deepProbe._errors || {}).join("；")}`);
        await writeFile(path.join(stagingPath, "precision-runtime.json"), `${JSON.stringify({
          environment: "diarization",
          key: runtimeEnvironmentKey(runtimeManifest.environments.diarization.packages),
          python: runtimeManifest.python.version,
          packages: runtimeManifest.environments.diarization.packages,
          installedAt: new Date().toISOString(),
        }, null, 2)}\n`, "utf8");
        await rm(backupPath, { recursive: true, force: true });
        if (existsSync(paths.diarizationRuntimePath)) await rename(paths.diarizationRuntimePath, backupPath);
        try {
          await rename(stagingPath, paths.diarizationRuntimePath);
        } catch (error) {
          if (existsSync(backupPath) && !existsSync(paths.diarizationRuntimePath)) await rename(backupPath, paths.diarizationRuntimePath);
          throw error;
        }
        await rm(backupPath, { recursive: true, force: true }).catch(() => appendTranscriptionEvent(operation, "清理旧环境", "新环境已启用；旧环境备份暂未清理，可稍后重试", "warning"));
      } catch (error) {
        await rm(stagingPath, { recursive: true, force: true });
        if (existsSync(backupPath) && !existsSync(paths.diarizationRuntimePath)) await rename(backupPath, paths.diarizationRuntimePath);
        throw error;
      }
    }
    operationStep(operation, "最终验证", 92, "正在实际导入运行库并检查模型快照");
    operation.status = "completed";
    operation.result = await transcriptionEnvironment(input);
    const resultComponents = Object.fromEntries(operation.result.components.map((item) => [item.id, item]));
    if (components.runtime && resultComponents.runtime?.status !== "ready") throw new Error(`基础运行库配置完成但仍未通过：${operation.result.diagnostics?.summary || operation.result.recommendation}`);
    if (components.model && resultComponents.model?.status !== "ready") throw new Error(`模型下载完成但仍未通过：${operation.result.diagnostics?.summary || operation.result.recommendation}`);
    operation.progress = 100;
    appendTranscriptionEvent(operation, "完成", "所选项目已处理，请检查最终状态。", "done");
  } catch (error) {
    operation.status = "failed";
    operation.error = error instanceof Error ? error.message : String(error);
    appendTranscriptionEvent(operation, "失败", operation.error, "error");
  } finally {
    operation.finishedAt = new Date().toISOString();
    delete operation.pid;
    await persistTranscriptionInstall(operation, input).catch(() => undefined);
    const lockRoot = transcriptionInstallLockRoots.get(operation.id);
    if (lockRoot && activeTranscriptionInstallRoots.get(lockRoot) === operation.id) activeTranscriptionInstallRoots.delete(lockRoot);
    transcriptionInstallLockRoots.delete(operation.id);
  }
}

function startTranscriptionInstall(input) {
  if (input.provider !== "faster_whisper" || input.mode !== "local") throw new Error("当前自动准备仅支持本地 Faster-Whisper");
  if (input.confirmed !== true) throw new Error("请先查看下载量与缓存位置，并勾选确认");
  if (!String(input.environmentRoot || "").trim()) throw new Error("请先确认模型与项目数据文件夹");
  const components = input.components || {};
  if (!components.runtime && !components.model && !components.diarization) throw new Error("请至少选择一个需要准备的项目");
  const lockRoot = transcriptionPaths(input).runtimeRoot;
  if (activeTranscriptionInstallRoots.has(lockRoot)) throw new Error("这个项目环境已经在配置中，请等待当前进度完成，不要重复启动");
  const id = randomUUID();
  const operation = { id, status: "running", stage: "排队", progress: 2, events: [], createdAt: new Date().toISOString() };
  activeTranscriptionInstallRoots.set(lockRoot, id);
  transcriptionInstallLockRoots.set(id, lockRoot);
  transcriptionOperations.set(id, operation);
  void runTranscriptionInstall(operation, input);
  return operation;
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

function safeKnowledgeId(value) {
  const id = String(value || "");
  if (!/^[a-z0-9-]{8,80}$/i.test(id)) throw new Error("无效知识库条目 ID");
  return id;
}

async function knowledgeEntries() {
  const files = await readdir(knowledgeRoot).catch(() => []);
  const entries = await Promise.all(files.filter((file) => file.endsWith(".json") && !file.startsWith("._")).map((file) => readJsonFile(path.join(knowledgeRoot, file))));
  return entries.filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

async function saveKnowledge(body) {
  const content = String(body.content || "").trim();
  if (!content) throw new Error("知识文档不能为空");
  const id = body.id ? safeKnowledgeId(body.id) : `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const previous = await readJsonFile(path.join(knowledgeRoot, `${id}.json`), {});
  const entry = {
    id,
    title: String(body.title || "未命名预习文档").trim().slice(0, 120),
    content: content.slice(0, 500_000),
    keywords: Array.isArray(body.keywords) ? body.keywords.map(String).slice(0, 50) : [],
    sources: Array.isArray(body.sources) ? body.sources.map(String).slice(0, 100) : [],
    createdAt: previous.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeJsonFile(path.join(knowledgeRoot, `${id}.json`), entry);
  return entry;
}

function presetFor(engine = {}) {
  const preset = apiPresets[engine.provider] || apiPresets.compatible;
  return { ...preset, baseUrl: String(engine.baseUrl || preset.baseUrl || "").replace(/\/$/, "") };
}

function providerRequestFields(provider, model, reasoning = "medium") {
  if (provider === "openai") return { reasoning_effort: reasoning };
  if (provider === "xai") return { reasoning_effort: reasoning === "xhigh" || reasoning === "max" ? "high" : reasoning };
  if (provider === "deepseek") return { thinking: { type: "enabled" }, reasoning_effort: ["xhigh", "max"].includes(reasoning) ? "max" : "high" };
  if (["kimi", "kimi_intl"].includes(provider)) {
    if (String(model).startsWith("kimi-k3")) return { reasoning_effort: reasoning === "low" ? "low" : ["xhigh", "max"].includes(reasoning) ? "max" : "high" };
    return { thinking: { type: "enabled" } };
  }
  if (provider === "mimo") return { thinking: { type: "enabled" } };
  if (provider === "glm") return { thinking: { type: "enabled" }, reasoning_effort: reasoning === "xhigh" ? "max" : reasoning };
  return {};
}

function providerTokenField(provider, value) {
  return ["openai", "kimi", "kimi_intl", "mimo"].includes(provider)
    ? { max_completion_tokens: value }
    : { max_tokens: value };
}

function providerHeaders(provider, key) {
  return {
    authorization: `Bearer ${key}`,
    ...(provider === "mimo" ? { "api-key": key } : {}),
    "content-type": "application/json",
  };
}

function normalizedTokenUsage(value) {
  const input = Number(value?.input ?? value?.prompt_tokens ?? value?.input_tokens ?? 0);
  const explicitCacheAvailable = typeof value?.cacheAvailable === "boolean" ? value.cacheAvailable : null;
  const cachedInputValue = explicitCacheAvailable === false ? undefined : value?.cachedInput
    ?? value?.cached_input_tokens
    ?? value?.input_cached_tokens
    ?? value?.prompt_cache_hit_tokens
    ?? value?.prompt_tokens_details?.cached_tokens
    ?? value?.input_tokens_details?.cached_tokens
    ?? value?.cache_read_input_tokens;
  const cachedInput = Number(cachedInputValue ?? 0);
  const output = Number(value?.output ?? value?.completion_tokens ?? value?.output_tokens ?? 0);
  const total = Number(value?.total ?? value?.total_tokens ?? input + output);
  return {
    input: Number.isFinite(input) ? Math.max(0, input) : 0,
    cachedInput: Number.isFinite(cachedInput) ? Math.max(0, Math.min(cachedInput, input)) : 0,
    output: Number.isFinite(output) ? Math.max(0, output) : 0,
    total: Number.isFinite(total) ? Math.max(0, total) : 0,
    available: Boolean(value) && typeof value === "object" && ["input", "output", "total", "prompt_tokens", "completion_tokens", "total_tokens", "input_tokens", "output_tokens"].some((key) => key in value),
    cacheAvailable: explicitCacheAvailable ?? (cachedInputValue !== undefined && cachedInputValue !== null),
  };
}

function mergeTokenUsage(...values) {
  return values.map(normalizedTokenUsage).reduce((sum, value) => ({
    input: sum.input + value.input,
    cachedInput: sum.cachedInput + value.cachedInput,
    output: sum.output + value.output,
    total: sum.total + value.total,
    available: sum.available || value.available,
    cacheAvailable: sum.cacheAvailable || value.cacheAvailable,
  }), { input: 0, cachedInput: 0, output: 0, total: 0, available: false, cacheAvailable: false });
}

const multimodalModelPatterns = {
  openai: [/^gpt-5\.(?:4|5|6)(?:$|-)/i, /^gpt-4o(?:$|-)/i],
  xai: [/^grok-4\.6(?:$|-latest$)/i],
  deepseek: [],
  kimi: [/^kimi-(?:k3|k2\.(?:5|6|7))(?:$|-)/i],
  kimi_intl: [/^kimi-(?:k3|k2\.(?:5|6|7))(?:$|-)/i],
  mimo: [/^mimo-v2\.5$/i],
  minimax: [],
  glm: [/^glm-(?:5v|4\.(?:5|6)v)(?:$|-)/i],
};

function catalogItemIds(item) {
  if (typeof item === "string") return [item];
  return [item?.id || item?.name, ...(Array.isArray(item?.aliases) ? item.aliases : [])].filter((value) => typeof value === "string");
}

function catalogInputModalities(item) {
  if (!item || typeof item !== "object") return [];
  const values = item.input_modalities || item.inputModalities || item.capabilities?.input_modalities || item.capabilities?.inputModalities || item.modalities?.input;
  return Array.isArray(values) ? values.map((value) => String(value).toLowerCase()) : [];
}

function isMultimodalCatalogModel(provider, id, metadata) {
  if (provider === "compatible") return true;
  const advertised = catalogInputModalities(metadata);
  if (advertised.length) return advertised.some((value) => value === "image" || value === "video" || value === "vision");
  return (multimodalModelPatterns[provider] || []).some((pattern) => pattern.test(id));
}

function stableModelAlias(id) {
  return !/(?:^|[-_.])(preview|beta|experimental|non-reasoning|reasoning)(?:$|[-_.])/i.test(id)
    && !/(?:19|20)\d{2}[-_.]?\d{2}[-_.]?\d{2}/.test(id)
    && !/(?:^|[-_.])\d{8}(?:$|[-_.])/.test(id);
}

async function listApiModels(engine) {
  const key = String(engine.apiKey || "").trim();
  if (!key) throw new Error("请先填写 API Key");
  const preset = presetFor(engine);
  if (!preset.baseUrl) throw new Error("请先填写 Base URL");
  let modelsUrl;
  // xAI exposes a language-only catalog with modality and live pricing data.
  // Other OpenAI-compatible providers conventionally expose /models.
  const catalogPath = engine.provider === "xai" ? "language-models" : "models";
  try { modelsUrl = new URL(`${preset.baseUrl.replace(/\/$/, "")}/${catalogPath}`); } catch { throw new Error("Base URL 格式不正确"); }
  if (!/^https?:$/.test(modelsUrl.protocol)) throw new Error("Base URL 只支持 HTTP 或 HTTPS");
  const response = await fetch(modelsUrl, {
    headers: providerHeaders(engine.provider, key),
    signal: AbortSignal.timeout(30_000),
    ...proxyFetchOptions(engine.proxyUrl),
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = { raw: raw.slice(0, 1000) }; }
  if (!response.ok) throw new Error(data?.error?.message || data?.message || `模型列表接口返回 HTTP ${response.status}`);
  const candidates = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  const allModels = [...new Set(candidates.flatMap(catalogItemIds).filter((item) => typeof item === "string" && item.length <= 160))].slice(0, 500);
  const nonTranslationModel = /(^|[-_.])(embedding|embed|rerank|moderation|asr|tts|speech|voice|whisper|transcribe|image|video)([-_.]|$)/i;
  const models = engine.provider === "compatible" ? allModels : allModels.filter((id) => !nonTranslationModel.test(id));
  if (!models.length) throw new Error("接口已连接，但没有返回可识别的模型 ID");
  const metadataById = new Map();
  for (const item of candidates) for (const id of catalogItemIds(item)) metadataById.set(id, item);
  const multimodalModels = models.filter((id) => isMultimodalCatalogModel(engine.provider, id, metadataById.get(id)));
  const preferred = apiPresets[engine.provider]?.models || [];
  const preferredAvailable = preferred.filter((id) => multimodalModels.includes(id));
  const recommendedModels = [...new Set([
    ...preferredAvailable,
    ...multimodalModels.filter((id) => stableModelAlias(id)),
  ])].slice(0, 8);
  const warning = recommendedModels.length
    ? ""
    : apiPresets[engine.provider]?.multimodal === "unavailable"
      ? apiPresets[engine.provider].note
      : engine.provider === "compatible"
        ? "自定义接口没有统一的能力元数据；下列模型只是账户候选，仍须通过图片实测"
        : "账户模型目录中没有发现可确认支持图像输入的通用模型；请检查账户权限或更换厂商";
  const pricing = {};
  if (engine.provider === "xai") {
    for (const item of candidates) {
      if (!item || typeof item !== "object") continue;
      const ids = [item.id || item.name, ...(Array.isArray(item.aliases) ? item.aliases : [])].filter(Boolean);
      const input = Number(item.prompt_text_token_price);
      const cached = Number(item.cached_prompt_text_token_price);
      const output = Number(item.completion_text_token_price);
      if (![input, output].every(Number.isFinite)) continue;
      for (const id of ids) pricing[id] = {
        currency: "USD",
        inputPerMillion: input / 10_000,
        ...(Number.isFinite(cached) ? { cachedInputPerMillion: cached / 10_000 } : {}),
        outputPerMillion: output / 10_000,
        note: "由 xAI 当前账户模型目录实时返回",
      };
    }
  }
  return {
    models: recommendedModels,
    recommendedModels,
    allModels: models,
    multimodalCount: multimodalModels.length,
    pricing,
    warning,
    filteredOut: allModels.length - models.length,
    source: modelsUrl.origin + modelsUrl.pathname,
    fetchedAt: new Date().toISOString(),
  };
}

function extractText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("\n");
  if (typeof value !== "object") return "";
  if (typeof value.result === "string") return value.result;
  if (typeof value.output_text === "string") return value.output_text;
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) return extractText(value.content);
  if (value.message) return extractText(value.message);
  if (Array.isArray(value.choices)) return extractText(value.choices.map((choice) => choice.message || choice.delta));
  if (Array.isArray(value.output)) return extractText(value.output);
  return "";
}

function redactLocalDiagnostic(value) {
  if (Array.isArray(value)) return value.map(redactLocalDiagnostic);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/(path|root|cache|apiKey|credential)/i.test(key))
      .map(([key, item]) => [key, redactLocalDiagnostic(item)]));
  }
  if (typeof value !== "string") return value;
  return value
    .replaceAll(projectRoot, "[PROJECT]")
    .replaceAll(os.homedir(), "[HOME]")
    .replace(/\/(?:Volumes|Users|private|tmp|opt|Library)\/[^\s；，。)]+/g, "[LOCAL_PATH]");
}

async function apiChat(engine, messages, options = {}) {
  const key = String(engine.apiKey || "").trim();
  if (!key) throw new Error("请先填写 API Key");
  const preset = presetFor(engine);
  if (!preset.baseUrl) throw new Error("自定义接口需要填写 Base URL");
  const preparedMessages = messages.map((message) => ({
    role: message.role,
    content: Array.isArray(message.content) ? message.content : String(message.content || ""),
  }));
  if (!["openai", "xai", "deepseek", "kimi", "kimi_intl", "mimo", "glm"].includes(engine.provider) && engine.reasoning) {
    preparedMessages.unshift({ role: "system", content: `思考强度偏好：${engine.reasoning}。疑难专名与语境必须充分核证后回答。` });
  }
  const endpoint = `${preset.baseUrl}/chat/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: providerHeaders(engine.provider, key),
    body: JSON.stringify({
      model: engine.model || preset.models[0],
      messages: preparedMessages,
      stream: false,
      ...(options.disableThinking && engine.provider === "mimo"
        ? { thinking: { type: "disabled" } }
        : providerRequestFields(engine.provider, engine.model || preset.models[0], engine.reasoning)),
      ...providerTokenField(engine.provider, options.maxTokens || 1400),
    }),
    signal: AbortSignal.timeout(options.timeoutMs || 60_000),
    ...proxyFetchOptions(engine.proxyUrl),
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = { raw: raw.slice(0, 1000) }; }
  if (!response.ok) throw new Error(data?.error?.message || data?.base_resp?.status_msg || `接口返回 HTTP ${response.status}`);
  const text = extractText(data).trim();
  const tokenUsage = normalizedTokenUsage(data?.usage);
  if (!text && engine.provider === "mimo" && !options.disableThinking) {
    const retry = await apiChat(engine, messages, { ...options, disableThinking: true });
    return { ...retry, tokenUsage: mergeTokenUsage(tokenUsage, retry.tokenUsage) };
  }
  if (!text) throw new Error("接口已连接，但没有返回可显示文本");
  return { text, model: data.model || engine.model || preset.models[0], tokenUsage };
}

function researchTemplate(body) {
  const keywords = (body.keywords || []).join("、") || "待填写作品关键词";
  const sites = [...(body.sites || []), ...(body.customSites || [])].join("、") || "官方站点";
  return `# ${keywords} · 翻译前预习\n\n> 状态：待用户核对。没有来源支持的内容不得直接进入最终译稿。\n\n## 检索目标\n\n- 确认作品、活动/集数、时间与媒体类型\n- 确认主要角色、出演者、关系与称呼\n- 搜索主要人物的角色色、成员色或应援色，并记录来源与可信度\n- 确认专有名词、歌曲、组织与固定译名\n- 记录容易误听、误译的语境和梗\n\n## 关键词\n\n${(body.keywords || []).map((item) => `- ${item}`).join("\n") || "- 待填写"}\n\n## 优先来源\n\n- ${sites}\n\n## 人物与关系\n\n| 原名 | 官方中文名 | 身份/关系 | 证据链接 | 置信度 |\n| --- | --- | --- | --- | --- |\n| 待检索 | 待核对 | 待填写 |  | 低 |\n\n## 角色与成员色\n\n| 人物/成员 | 适用身份 | 色名 | HEX | 来源类型 | 证据链接 | 置信度 | 备注 |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| 待检索 | 角色/成员/出演者 | 待核实 |  | 待核实 |  | 低 | 找不到可靠资料时后续使用确定性回退色 |\n\n## 术语表\n\n| 原文 | 读音 | 推荐译法 | 类型 | 证据链接 |\n| --- | --- | --- | --- | --- |\n| 待检索 |  | 待核对 | 专有名词 |  |\n\n## 时间线与语境\n\n- 待补充\n\n## 翻译决定\n\n- 对话型字幕默认去掉句末句号\n- 未核实的专有名词必须回到对应时间抽帧/OCR/重听\n`;
}

function researchTemplateWithSpeakerIdentity(body) {
  return researchTemplate(body)
    .replace("## 人物与关系\n\n", "## 人物与关系\n\n> 角色名与对应声优必须归入同一个人物实体，不得拆成两个说话人。\n\n")
    .replace("## 角色与成员色", "## 角色—声优配对\n\n| 人物实体 ID | 角色名 | 声优/出演者 | 当前素材中的发言身份 | 证据链接 | 置信度 |\n| --- | --- | --- | --- | --- | --- |\n| 待检索 | 待核实 | 待核实 | 角色 / 声优本人 / 待核实 |  | 低 |\n\n## 角色与成员色");
}

function researchPrompt(body, template) {
  const sourceHint = /^https?:\/\//i.test(String(body.source || ""))
    ? String(body.source)
    : body.source ? "本地媒体（路径不提供；禁止访问本地文件）" : "尚未填写";
  return `这是一个独立的背景资料联网检索任务，不是字幕制作或媒体分析任务。生成一份可供用户检查和修改的中文 Markdown 预习文档。
先检索作品、角色/出演者、关系、称呼、专有名词、活动或集数语境，优先使用用户指定站点与官方来源。
必须把每个角色与其对应声优/出演者记录为同一个人物实体：同时保留 character_name 与 performer_name，不得因为两个名字都在资料中出现就拆成两个说话人。判断当前素材是在呈现角色对白，还是声优/出演者本人发言，并写为 speaking_as=character、performer 或 unknown；动画正片通常是角色，访谈、舞台、广播与活动现场通常是声优本人，但必须以当前素材证据为准。
必须把主要人物的角色色、成员色或应援色作为独立检索项目：先找官方角色资料、艺人/组合页面、活动物料、官方应援或商品说明，再用可靠资料交叉核对。区分角色色、团体成员色与出演者个人应援色，不得混为一谈。
只有来源明确给出 HEX 时才写 HEX；只有色名时保留色名并将 HEX 留空。不得把服装颜色、舞台灯光或随手从截图取样的颜色冒充官方色。查不到时写“待核实”，并说明后续使用确定性回退色。
每条事实都附来源 URL 和置信度；搜索不到就明确写“待核实”，禁止凭印象补全。
保留人物关系表、角色—声优配对表、角色与成员色表、术语表、时间线与翻译决定，并记录后续应在视频哪个位置抽帧/OCR 的疑点。
本次只允许使用配置好的联网搜索与网页正文工具。不要读取任何字幕 Skill/Harness，不要运行 Shell，不要检查、打开、探测或转码本地视频，不要抽帧、OCR、听写、创建任务目录或制作字幕。
只输出完成后的 Markdown 文档，不输出执行说明。

视频来源线索：${sourceHint}
关键词：${(body.research?.keywords || []).join("、") || "待填写"}
优先站点：${[...(body.research?.sites || []), ...(body.research?.customSites || [])].join("、") || "官方来源"}
思考强度：${body.engine?.reasoning || "medium"}

参考结构：
${template}`;
}

async function researchKnowledgeContext(ids = []) {
  const documents = [];
  for (const rawId of ids.slice(0, 12)) {
    const id = safeKnowledgeId(rawId);
    const entry = await readJsonFile(path.join(knowledgeRoot, `${id}.json`));
    if (entry) documents.push(`## 知识库线索：${entry.title}\n\n${String(entry.content || "").slice(0, 80_000)}`);
  }
  return documents.join("\n\n");
}

function safeResearchRunId(value) {
  const id = String(value || "");
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("无效检索任务 ID");
  return id;
}

function searchConfig(value = {}) {
  const provider = searchPresets[value.provider] ? value.provider : "exa";
  const preset = searchPresets[provider];
  const url = String(value.url || preset.url || "").trim();
  return { provider, preset, url, apiKey: String(value.apiKey || "").trim(), proxyUrl: normalizedProxyUrl(value.proxyUrl) };
}

function codexTomlString(value) {
  return JSON.stringify(String(value));
}

async function researchAgentConfig(directory, engine, search) {
  const config = searchConfig(search);
  const env = applyProxyEnv({ ...process.env }, config.proxyUrl || engine.proxyUrl);
  if (config.provider === "builtin") return { env, codexArgs: ["--search"], claudeArgs: [], description: "Agent 内置联网搜索" };
  if (!config.url) throw new Error("请填写检索 MCP URL");
  const mcpName = "pss-research";
  const bearerToken = config.apiKey && ["tavily", "custom"].includes(config.provider);
  if (config.apiKey) env.PSS_SEARCH_MCP_KEY = config.apiKey;
  const codexArgs = [
    "-c", `mcp_servers.${mcpName}.url=${codexTomlString(config.url)}`,
    ...(bearerToken ? ["-c", `mcp_servers.${mcpName}.bearer_token_env_var="PSS_SEARCH_MCP_KEY"`] : []),
    ...(config.provider === "exa" && config.apiKey ? ["-c", `mcp_servers.${mcpName}.env_http_headers={"x-api-key"="PSS_SEARCH_MCP_KEY"}`] : []),
  ];
  const headers = {};
  if (config.provider === "exa" && config.apiKey) headers["x-api-key"] = config.apiKey;
  if (["tavily", "custom"].includes(config.provider) && config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const claudeMcp = { mcpServers: { [mcpName]: { type: "http", url: config.url, ...(Object.keys(headers).length ? { headers } : {}) } } };
  const claudeMcpPath = path.join(directory, "research-mcp.json");
  await writeFile(claudeMcpPath, JSON.stringify(claudeMcp), { encoding: "utf8", mode: 0o600 });
  return {
    env,
    codexArgs,
    claudeArgs: ["--mcp-config", claudeMcpPath, "--strict-mcp-config"],
    ephemeralConfigPath: claudeMcpPath,
    description: config.preset.label,
  };
}

function mcpHeaders(config, sessionId = "") {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    ...(config.provider === "exa" && config.apiKey ? { "x-api-key": config.apiKey } : {}),
    ...(["tavily", "custom"].includes(config.provider) && config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
  };
}

function parseMcpResponse(raw, requestId) {
  const candidates = [];
  try { candidates.push(JSON.parse(raw)); } catch { /* SSE or empty response */ }
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try { candidates.push(JSON.parse(line.slice(5).trim())); } catch { /* Ignore keep-alive data. */ }
  }
  const message = candidates.find((item) => item?.id === requestId) || candidates.at(-1);
  if (!message) return {};
  if (message.error) throw new Error(message.error.message || "MCP 工具返回错误");
  return message.result || {};
}

async function mcpRpc(config, state, method, params = {}, notification = false) {
  const id = notification ? undefined : state.nextId++;
  const response = await fetch(config.url, {
    method: "POST",
    headers: mcpHeaders(config, state.sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }),
    signal: AbortSignal.timeout(30_000),
    ...proxyFetchOptions(config.proxyUrl),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${config.preset.label} 返回 HTTP ${response.status}：${raw.slice(0, 300)}`);
  state.sessionId = response.headers.get("mcp-session-id") || state.sessionId;
  return id === undefined ? {} : parseMcpResponse(raw, id);
}

async function openSearchMcp(search) {
  const config = searchConfig(search);
  if (config.provider === "builtin") throw new Error("API 或本地模型没有 Agent 内置搜索，请选择 Exa、Tavily 或自定义 MCP");
  if (!config.url) throw new Error("请填写检索 MCP URL");
  const state = { nextId: 1, sessionId: "" };
  await mcpRpc(config, state, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "precision-subtitle-studio", version: "0.1.0" } });
  await mcpRpc(config, state, "notifications/initialized", {}, true);
  const listed = await mcpRpc(config, state, "tools/list");
  const tools = Array.isArray(listed.tools) ? listed.tools : [];
  if (!tools.length) throw new Error(`${config.preset.label} 已连接，但没有返回可调用工具`);
  return { config, state, tools };
}

function mcpToolArguments(tool, value, kind) {
  const properties = tool.inputSchema?.properties || {};
  const args = {};
  if (kind === "search") {
    if (properties.query) args.query = value;
    else if (properties.q) args.q = value;
    else if (properties.queries) args.queries = [value];
    else args.query = value;
    if (properties.numResults) args.numResults = 6;
    if (properties.max_results) args.max_results = 6;
    if (properties.search_depth) args.search_depth = "advanced";
    if (properties.type) args.type = "auto";
  } else {
    const urls = Array.isArray(value) ? value : [value];
    if (properties.urls) args.urls = urls;
    else if (properties.url) args.url = urls[0];
    else args.url = urls[0];
  }
  return args;
}

async function callMcpTool(connection, tool, args) {
  const result = await mcpRpc(connection.config, connection.state, "tools/call", { name: tool.name, arguments: args });
  if (result.isError) throw new Error(extractText(result.content) || `${tool.name} 调用失败`);
  return extractText(result.content || result).trim();
}

async function selectedEngineText(engine, prompt, options = {}) {
  if (engine.mode === "api") {
    const result = await apiChat(engine, [{ role: "user", content: prompt }], { maxTokens: options.maxTokens || 1800, timeoutMs: options.timeoutMs || 120_000 });
    return { text: result.text, label: `${engine.provider}/${result.model}`, tokenUsage: result.tokenUsage };
  }
  const result = await testLocalEngine(engine, [{ role: "user", content: prompt }], { taskPrompt: "这是字幕项目的联网研究任务。只按用户提示规划检索或整理证据，不读取文件，不启动子任务。", timeoutMs: options.timeoutMs || 180_000 });
  return { text: result.text, label: engine.mode === "gpu" ? `Ollama/${engine.gpuModel}` : String(engine.cli) };
}

function plannedQueries(text) {
  try {
    const parsed = parseStructuredReply(text);
    const values = Array.isArray(parsed) ? parsed : parsed.queries;
    if (Array.isArray(values)) return [...new Set(values.map(String).map((item) => item.trim()).filter(Boolean))].slice(0, 5);
  } catch { /* Try a line-oriented fallback. */ }
  return [...new Set(String(text).split("\n").map((line) => line.replace(/^[-*\d.)\s]+/, "").trim()).filter((line) => line.length > 3))].slice(0, 5);
}

async function generateResearchWithSelectedEngine(engine, prompt, search, run) {
  run.stage = "所选模型正在制定检索词";
  run.events.push({ kind: "status", text: "第一步所选模型正在制定检索计划" });
  const plan = await selectedEngineText(engine, `根据下面的字幕预习目标，设计 3–5 条高质量网页搜索词，兼顾日文官方来源和中文官方译名核对。其中至少一条必须专门检索主要人物的角色色、成员色或应援色；多人时优先用一条组合查询覆盖，不得省略该项目。只返回 JSON：{"queries":["…"]}\n\n${prompt.slice(0, 24_000)}`, { maxTokens: 1200 });
  const queries = plannedQueries(plan.text);
  if (!queries.length) throw new Error(`${plan.label} 没有返回可执行的检索词`);
  run.events.push(...queries.map((query) => ({ kind: "search", text: `${plan.label} 决定搜索：${query}` })));

  run.stage = `正在用 ${searchConfig(search).preset.label} 执行所选模型的查询`;
  const connection = await openSearchMcp(search);
  const searchTool = connection.tools.find((tool) => /web_search_exa/i.test(tool.name)) || connection.tools.find((tool) => /search/i.test(tool.name));
  const fetchTool = connection.tools.find((tool) => /web_fetch_exa/i.test(tool.name)) || connection.tools.find((tool) => /fetch|extract|crawl/i.test(tool.name));
  if (!searchTool) throw new Error(`${connection.config.preset.label} 没有可识别的搜索工具`);
  const evidence = [];
  for (const query of queries) {
    try {
      const text = await callMcpTool(connection, searchTool, mcpToolArguments(searchTool, query, "search"));
      if (text) evidence.push(`## 查询：${query}\n\n${text.slice(0, 30_000)}`);
      run.events.push({ kind: "source", text: `搜索结果已返回：${query}` });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "未知错误";
      run.events.push({ kind: "warning", text: `这条查询失败，已跳过并继续：${query}（${detail.slice(0, 140)}）` });
    }
  }
  if (!evidence.length) throw new Error("所有搜索查询均失败，无法获得可供所选模型核对的证据");
  const urls = [...new Set(evidence.join("\n").match(/https?:\/\/[^\s<>"'\])}]+/g) || [])].slice(0, 6);
  if (fetchTool && urls.length) {
    for (const url of urls.slice(0, 4)) {
      try {
        const text = await callMcpTool(connection, fetchTool, mcpToolArguments(fetchTool, url, "fetch"));
        if (text) evidence.push(`## 来源正文：${url}\n\n${text.slice(0, 30_000)}`);
        run.events.push({ kind: "source", text: `已打开来源正文：${url.slice(0, 160)}` });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "未知错误";
        run.events.push({ kind: "warning", text: `该网页打开失败，已保留搜索摘要并继续：${url.slice(0, 120)}（${detail.slice(0, 120)}）` });
      }
    }
  }
  run.stage = "所选模型正在核对来源并撰写预习文档";
  run.events.push({ kind: "status", text: `${plan.label} 正在根据检索证据整理文档` });
  const synthesis = await selectedEngineText(engine, `${prompt}\n\n下面是搜索 MCP 返回的证据。只使用这些证据撰写最终 Markdown；保留直接 URL，证据不足处明确标为待核实。\n\n${evidence.join("\n\n").slice(0, 110_000)}`, { maxTokens: 7000, timeoutMs: 180_000 });
  if (!synthesis.text.trim()) throw new Error(`${synthesis.label} 没有返回预习文档`);
  return {
    document: synthesis.text.slice(0, 500_000),
    generatedBy: `${synthesis.label} + ${connection.config.preset.label}`,
    tokenUsage: mergeTokenUsage(plan.tokenUsage, synthesis.tokenUsage),
  };
}

function researchEvents(raw, agent) {
  const events = [];
  for (const line of raw.split("\n")) {
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    const transportMessage = String(item.message || item.item?.message || "");
    if (/reconnecting|request timed out|connection refused|falling back.*http/i.test(transportMessage)) {
      const text = /falling back.*http/i.test(transportMessage)
        ? "Agent 编排通道响应较慢，已自动切换到 HTTPS 继续；这不代表翻译模型 API 失败"
        : "Agent 编排通道响应较慢，正在自动重试；已完成的模型结果不会丢失";
      events.push({ kind: "status", text });
    }
    const pushTool = (name, input = {}) => {
      if (typeof input === "string") {
        try { input = JSON.parse(input); } catch { input = { query: input }; }
      }
      const query = String(input.query || input.search_query || input.queries?.join("；") || input.url || input.urls?.[0] || "").trim();
      events.push({ kind: /fetch|open|extract/i.test(name) ? "source" : "search", text: query ? `${traceLabel(name)}：${query.slice(0, 180)}` : traceLabel(name) });
    };
    if (agent === "claude" && item.type === "assistant") {
      for (const content of item.message?.content || []) if (content.type === "tool_use") pushTool(content.name, content.input);
    }
    if (agent === "codex") {
      const candidate = item.item || item;
      if (["web_search", "tool_call", "mcp_tool_call"].includes(candidate.type)) {
        const actionName = String(candidate.action?.type || "");
        const toolName = /open|fetch|extract/i.test(actionName) ? actionName : candidate.name || candidate.tool_name || candidate.tool || candidate.type;
        pushTool(toolName, { ...(candidate.action && typeof candidate.action === "object" ? candidate.action : {}), ...(candidate.arguments && typeof candidate.arguments === "object" ? candidate.arguments : {}), ...(candidate.input && typeof candidate.input === "object" ? candidate.input : {}), query: candidate.query, raw: typeof candidate.arguments === "string" ? candidate.arguments : undefined });
      }
    }
  }
  const deduped = [];
  for (const event of events) if (deduped.at(-1)?.text !== event.text) deduped.push(event);
  return deduped.slice(-40);
}

async function researchRunStatus(id) {
  const run = researchRuns.get(safeResearchRunId(id));
  if (!run) throw new Error("检索任务不存在或服务已重启");
  const raw = await readTail(run.stdoutPath, 500 * 1024);
  const parsedEvents = researchEvents(raw, run.agent);
  const transportEvent = [...parsedEvents].reverse().find((event) => event.kind === "status");
  const allEvents = [
    { kind: "setup", text: `已连接 ${run.tool}` },
    ...(run.events || []),
    ...parsedEvents,
    ...(run.status === "completed" ? [{ kind: "done", text: "来源整理完成，正在打开预习文档" }] : run.status === "failed" ? [{ kind: "error", text: run.error || "检索失败" }] : []),
  ];
  const dedupedEvents = [];
  for (const event of allEvents) if (dedupedEvents.at(-1)?.text !== event.text) dedupedEvents.push(event);
  return {
    id,
    status: run.status,
    stage: run.status === "running" && transportEvent ? transportEvent.text : run.stage,
    tool: run.tool,
    events: dedupedEvents.slice(-48),
    ...(run.status === "completed" ? {
      document: run.document,
      generatedBy: run.generatedBy || `${run.agent} + ${run.tool}`,
      ...(run.tokenUsage ? { tokenUsage: run.tokenUsage } : {}),
    } : {}),
    ...(run.status === "failed" ? { error: run.error } : {}),
  };
}

async function generateResearchWithCli(engine, prompt, options = {}) {
  const name = String(engine.cli || "codex");
  const command = executable(name);
  if (!command) throw new Error(`本机没有发现 ${name}，请改选已安装的 Agent。`);
  const directory = path.join(previewRoot, randomUUID());
  await mkdir(directory, { recursive: true });
  const resultPath = path.join(directory, "research-preview.md");
  const stdoutPath = path.join(directory, "agent.ndjson");
  const stderrPath = path.join(directory, "agent.stderr.log");
  if (options.run) options.run.stdoutPath = stdoutPath;
  const agentConfig = await researchAgentConfig(directory, engine, options.search || { provider: "builtin" });
  let args;
  if (name === "codex") args = [...agentConfig.codexArgs, "exec", "--ephemeral", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "--output-last-message", resultPath, ...(engine.reasoning ? ["-c", `model_reasoning_effort="${engine.reasoning}"`] : []), ...(engine.model ? ["--model", engine.model] : []), prompt];
  else if (name === "claude") args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--permission-mode", "dontAsk", ...agentConfig.claudeArgs, ...(engine.reasoning ? ["--effort", engine.reasoning] : []), ...(engine.model ? ["--model", engine.model] : [])];
  else if (name === "opencode") args = ["run", "--format", "json", ...(engine.model ? ["--model", engine.model] : []), prompt];
  else if (name === "pi") args = ["-p", "--mode", "json", prompt];
  else if (name === "cline") args = ["--json", "--auto-approve", "true", ...(engine.model ? ["--model", engine.model] : []), prompt];
  else throw new Error(`暂不支持用 ${name} 生成预习文档。`);

  const stdout = createWriteStream(stdoutPath);
  const stderr = createWriteStream(stderrPath);
  const child = spawn(command, args, { cwd: directory, env: agentConfig.env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  let lastOutputAt = Date.now();
  child.stdout.on("data", () => {
    lastOutputAt = Date.now();
    if (options.run) options.run.lastActivityAt = new Date(lastOutputAt).toISOString();
  });
  const exit = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearInterval(idleWatch);
      clearTimeout(hardLimit);
      callback();
    };
    const idleWatch = setInterval(() => {
      if (Date.now() - lastOutputAt < 4 * 60 * 1000) return;
      child.kill("SIGTERM");
      finish(() => reject(new Error("联网检索已连续 4 分钟没有任何新进度，已停止。请先测试模型连接和搜索工具后重试。")));
    }, 15_000);
    const hardLimit = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new Error("联网检索运行超过 15 分钟，已停止。日志已保留，可减少检索范围后重试。")));
    }, 15 * 60 * 1000);
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => resolve(code)));
  }).finally(async () => {
    stdout.end();
    stderr.end();
    await settleOutputStreams(stdout, stderr);
    if (agentConfig.ephemeralConfigPath) await unlink(agentConfig.ephemeralConfigPath).catch(() => {});
  });
  if (exit !== 0) {
    const detail = (await readTail(stderrPath, 24 * 1024)).trim();
    throw new Error(detail.slice(-1200) || `${name} 生成预习文档失败（退出码 ${exit}）`);
  }
  let text = await readFile(resultPath, "utf8").catch(() => "");
  if (!text.trim()) {
    const raw = await readTail(stdoutPath, 500 * 1024);
    const extracted = [];
    const plain = [];
    for (const line of raw.split("\n")) {
      try {
        const item = JSON.parse(line);
        const value = extractText(item);
        if (value.trim()) extracted.push(value.trim());
        else if (line.trim()) plain.push(line.trim());
      } catch {
        if (line.trim()) plain.push(line);
      }
    }
    text = extracted.at(-1) || plain.join("\n");
  }
  if (!text.trim()) throw new Error(`${name} 已结束，但没有返回预习文档。`);
  return { document: text.slice(0, 500_000), generatedBy: `${name} + ${agentConfig.description}` };
}

async function startResearchRun(engine, prompt, search) {
  const id = randomUUID();
  const agent = engine.mode === "api"
    ? `${engine.provider || "API"}/${engine.model || "未指定模型"}`
    : engine.mode === "gpu"
      ? `Ollama/${engine.gpuModel || engine.model || "未指定模型"}`
      : String(engine.cli || "codex");
  const run = { id, status: "running", stage: "正在连接检索工具", tool: searchConfig(search).preset.label, agent, stdoutPath: "", error: "", document: "", generatedBy: "", events: [] };
  researchRuns.set(id, run);
  void (async () => {
    try {
      const selectedSearch = searchConfig(search);
      let result;
      if ((engine.mode || "cli") === "cli") {
        run.stage = `${agent} 正在搜索和打开来源`;
        const exactToolRule = selectedSearch.provider === "exa"
          ? "必须调用 pss-research MCP 的 web_search_exa 和 web_fetch_exa；不要改用 Agent 内置 web_search。"
          : selectedSearch.provider === "tavily"
            ? "必须调用 pss-research MCP 中名称含 search / extract 的 Tavily 工具；不要改用 Agent 内置 web_search。"
            : selectedSearch.provider === "custom"
              ? "必须调用 pss-research MCP 提供的搜索与正文读取工具；不要改用 Agent 内置 web_search。"
              : "使用当前 Agent 的内置联网搜索，并打开关键来源正文。";
        result = await generateResearchWithCli(engine, `${prompt}\n\n检索要求：${exactToolRule} 执行多次搜索并打开关键来源正文；先官方来源，再交叉核对。单个搜索词或网页返回错误、拒绝访问、404、超时或正文提取失败时，记录该来源失败并继续其他查询，不得因此结束整个任务；只有搜索工具整体不可用或所有查询都没有证据时才停止。最终文档列出每个使用过的直接 URL。`, { search, run });
      } else {
        result = await generateResearchWithSelectedEngine(engine, prompt, search, run);
      }
      run.document = result.document;
      run.tokenUsage = result.tokenUsage;
      run.status = "completed";
      run.stage = "预习结果文档已生成";
      run.generatedBy = result.generatedBy;
    } catch (error) {
      run.status = "failed";
      run.stage = "检索中断";
      run.error = error instanceof Error ? error.message : "检索失败";
    }
  })();
  return { id, status: run.status, stage: run.stage, tool: run.tool };
}

async function testLocalEngine(engine, messages, options = {}) {
  const mode = engine.mode || "cli";
  const name = mode === "gpu" ? "ollama" : String(engine.cli || "codex");
  const command = executable(name);
  if (!command) throw new Error(`本机没有发现 ${name}，请安装后重试或改选其他引擎。`);
  const directory = path.join(previewRoot, `engine-test-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const resultPath = path.join(directory, "reply.txt");
  const prompt = [
    options.taskPrompt || "这是一次本地翻译引擎能力测试。严格遵守用户要求，不要修改文件，不要启动子任务。",
    `思考强度：${engine.reasoning || "medium"}。`,
    ...(options.imagePath ? [`必须读取并理解这张本地图片：${options.imagePath}`] : []),
    ...messages.slice(-6).map((message) => `${message.role === "assistant" ? "助手" : "用户"}：${String(message.content || "").slice(0, 4000)}`),
  ].join("\n");
  if (name === "ollama" && options.imagePath) {
    const image = await readFile(options.imagePath);
    const response = await fetch("http://127.0.0.1:11434/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: engine.gpuModel || "deepseek-r1:14b",
        stream: false,
        messages: [{ role: "user", content: prompt, images: [image.toString("base64")] }],
      }),
      signal: AbortSignal.timeout(options.timeoutMs || 90_000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || `Ollama 图片测试返回 HTTP ${response.status}`);
    const text = extractText(data).trim();
    if (!text) throw new Error("Ollama 已连接，但图片测试没有返回文字");
    return { text: text.slice(0, 20_000), model: data.model || engine.gpuModel || "ollama" };
  }
  let args;
  if (name === "codex") args = ["exec", ...(options.imagePath ? ["--image", options.imagePath] : []), "--ephemeral", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "--output-last-message", resultPath, ...(engine.reasoning ? ["-c", `model_reasoning_effort="${engine.reasoning}"`] : []), prompt];
  else if (name === "claude") args = ["-p", prompt, "--output-format", "text", "--no-session-persistence", "--permission-mode", "dontAsk", ...(options.imagePath ? ["--add-dir", path.dirname(options.imagePath)] : []), ...(engine.reasoning ? ["--effort", engine.reasoning] : [])];
  else if (name === "opencode") args = ["run", "--format", "json", prompt];
  else if (name === "pi") args = ["-p", "--mode", "json", prompt];
  else if (name === "cline") args = ["--json", "--auto-approve", "true", prompt];
  else if (name === "ollama") args = ["run", engine.gpuModel || "deepseek-r1:14b", prompt];
  else throw new Error(`不支持测试 ${name}`);
  const stdoutPath = path.join(directory, "stdout.log");
  const stderrPath = path.join(directory, "stderr.log");
  const stdout = createWriteStream(stdoutPath);
  const stderr = createWriteStream(stderrPath);
  const child = spawn(command, args, { cwd: directory, env: applyProxyEnv({ ...process.env }, engine.proxyUrl), stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  const exit = await new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs || 90_000;
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`模型调用超过 ${Math.round(timeoutMs / 1000)} 秒，已停止`)); }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code); });
  }).finally(async () => {
    stdout.end();
    stderr.end();
    await settleOutputStreams(stdout, stderr);
  });
  if (exit !== 0) {
    const detail = (await readTail(stderrPath, 20 * 1024)).trim();
    throw new Error(detail.slice(-1000) || `${name} 测试失败（退出码 ${exit}）`);
  }
  let text = await readFile(resultPath, "utf8").catch(() => "");
  if (!text.trim()) {
    const raw = await readTail(stdoutPath, 300 * 1024);
    const candidates = [];
    const plain = [];
    for (const line of raw.split("\n")) {
      try {
        const value = extractText(JSON.parse(line));
        if (value.trim()) candidates.push(value.trim());
        else if (line.trim()) plain.push(line.trim());
      } catch {
        if (line.trim()) plain.push(line);
      }
    }
    text = candidates.at(-1) || plain.join("\n");
  }
  if (!text.trim()) throw new Error(`${name} 已连接，但没有返回测试消息`);
  return { text: text.trim().slice(0, 20_000), model: name };
}

function parseStructuredReply(text) {
  const cleaned = String(text || "").replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("没有返回要求的 JSON 对象");
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new Error("返回内容不是有效 JSON");
  }
}

function compliantTextAnswer(value) {
  const answer = String(value || "").trim();
  const hasUnsafeControl = [...answer].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 && code !== 9 && code !== 10 && code !== 13;
  });
  return answer.length > 0 && answer.length <= 2000 && !hasUnsafeControl && !/<script\b|javascript:/i.test(answer);
}

function commandProbe(command, args, timeout = 8000) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 256 * 1024,
    env: { ...process.env },
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  return { passed: result.status === 0 && !result.error, output, error: result.error };
}

async function reachabilityProbe(url, proxyUrl, timeoutMs = 6000) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error("连接超时");
      error.name = "TimeoutError";
      reject(error);
    }, timeoutMs);
  });
  const request = fetch(url, {
    method: "HEAD",
    redirect: "manual",
    signal: controller.signal,
    ...proxyFetchOptions(proxyUrl),
  });
  request.catch(() => {});
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function diagnoseLocalCli(engine) {
  const name = String(engine.cli || "codex");
  const command = executable(name);
  if (!command) {
    const missing = { passed: false, detail: `本机没有发现 ${name} 可执行程序` };
    return {
      passed: false,
      install: missing,
      auth: { passed: false, detail: "未安装，无法检查登录" },
      network: { passed: false, detail: "未安装，无法检查上游网络" },
    };
  }

  const versionProbe = commandProbe(command, ["--version"], 3000);
  const version = versionProbe.output.split("\n").find(Boolean) || path.basename(command);
  const install = {
    passed: versionProbe.passed,
    detail: versionProbe.passed ? `${version} · ${command}` : `程序存在，但无法启动：${versionProbe.error?.message || versionProbe.output || "未知错误"}`,
  };
  if (!install.passed) {
    return {
      passed: false,
      install,
      auth: { passed: false, detail: "CLI 无法启动，未检查登录" },
      network: { passed: false, detail: "CLI 无法启动，未检查网络" },
    };
  }

  let auth = { passed: true, detail: "该 CLI 没有标准登录探针，将由真实文字调用确认权限" };
  let networkTarget = "";
  let networkLabel = "CLI 上游";
  if (name === "codex") {
    const probe = commandProbe(command, ["login", "status"], 5000);
    auth = {
      passed: probe.passed && /logged in/i.test(probe.output),
      detail: probe.passed ? (probe.output.split("\n").find((line) => /logged in/i.test(line)) || "Codex 登录态有效") : (probe.output || "Codex 尚未登录，请先在终端运行 codex login"),
    };
    networkTarget = /chatgpt/i.test(probe.output) ? "https://chatgpt.com" : "https://api.openai.com";
    networkLabel = new URL(networkTarget).hostname;
  } else if (name === "claude") {
    const probe = commandProbe(command, ["auth", "status"], 5000);
    let status = null;
    try { status = JSON.parse(probe.output); } catch { /* Use the textual fallback below. */ }
    auth = {
      passed: probe.passed && (status?.loggedIn === true || /logged.?in|oauth|api.?key/i.test(probe.output)),
      detail: status?.loggedIn === true ? `Claude Code 已登录（${status.authMethod || "凭证有效"}）` : (probe.output || "Claude Code 尚未登录，请先完成 claude auth login"),
    };
    networkTarget = String(process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
    try { networkLabel = new URL(networkTarget).hostname; } catch { networkLabel = networkTarget; }
  }

  let network = { passed: true, detail: "上游由该 CLI 自己管理，将由真实文字调用继续确认" };
  if (networkTarget) {
    try {
      const response = await reachabilityProbe(networkTarget, engine.proxyUrl, 6000);
      network = { passed: true, detail: `${networkLabel} 可达（HTTP ${response.status}${engine.proxyUrl ? " · 已使用代理" : " · 当前为直连"}）` };
    } catch (error) {
      const causeCode = error && typeof error === "object" && "cause" in error && error.cause && typeof error.cause === "object" && "code" in error.cause ? String(error.cause.code) : "";
      const reason = error instanceof Error && (error.name === "TimeoutError" || /TIMEOUT/i.test(causeCode)) ? "连接超时" : "连接失败";
      network = {
        passed: false,
        detail: `${networkLabel} ${reason}。${engine.proxyUrl ? "请检查代理是否正在运行、地址与端口是否正确" : "本机没有可继承的系统代理；请在主界面的“网络代理”填写可用的 http(s) 代理后重试"}`,
      };
    }
  }
  return { passed: install.passed && auth.passed && network.passed, install, auth, network };
}

async function engineReply(engine, messages, options = {}) {
  return engine.mode === "api" ? apiChat(engine, messages) : testLocalEngine(engine, messages, options);
}

async function runMultimodalEngineTest(engine, messages) {
  const diagnostics = engine.mode === "cli" ? await diagnoseLocalCli(engine) : null;
  if (diagnostics && !diagnostics.passed) {
    const firstFailure = [diagnostics.install, diagnostics.auth, diagnostics.network].find((item) => !item.passed);
    return {
      passed: false,
      text: `本地 CLI 预检未通过：${firstFailure?.detail || "请检查安装、登录和网络"}`,
      error: firstFailure?.detail || "本地 CLI 预检未通过",
      diagnostics,
      checks: {
        text: { passed: false, detail: "本地 CLI 预检未通过，未发起模型调用" },
        image: { passed: false, detail: "文字测试未通过，未进入图片测试" },
      },
    };
  }
  const userMessage = String(messages.filter((message) => message?.role === "user").at(-1)?.content || "请说明你已连接成功").trim().slice(0, 2000);
  const token = randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
  const textPrompt = `完成一次文字指令遵循测试，并用中文简短回答用户问题。只返回一行严格 JSON，不要 Markdown，不要附加解释：\n{"status":"PASS","token":"${token}","answer":"你的中文回答"}\nstatus 和 token 必须原样保留；answer 必须是 1 到 2000 字的安全纯文本。\n用户问题：${userMessage}`;
  let textReply;
  let textData;
  try {
    textReply = await engineReply(engine, [{ role: "user", content: textPrompt }]);
    textData = parseStructuredReply(textReply.text);
    if (textData.status !== "PASS" || textData.token !== token || !compliantTextAnswer(textData.answer)) {
      throw new Error("文字回复未按约定返回 status、随机令牌和合规 answer");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "文字测试失败";
    return {
      passed: false,
      text: `文字测试未通过：${detail}`,
      error: `文字测试未通过：${detail}`,
      tokenUsage: mergeTokenUsage(textReply?.tokenUsage),
      ...(diagnostics ? { diagnostics } : {}),
      checks: {
        text: { passed: false, detail, reply: textReply?.text?.slice(0, 1200) },
        image: { passed: false, detail: "文字测试未通过，未进入图片测试" },
      },
    };
  }

  const challenge = await createEngineChallenge();
  const imagePrompt = "读取附图：上方是 5 位数字，下方是纯色色块。只返回一行严格 JSON，不要 Markdown，不要解释：{\"code\":\"你看到的5位数字\",\"color\":\"色块颜色\"}。color 只能从 RED、BLUE、GREEN、PURPLE、ORANGE 中选择。数字与颜色答案只存在于图片中。";
  let imageReply;
  try {
    if (engine.mode === "api") {
      imageReply = await engineReply(engine, [{
        role: "user",
        content: [
          { type: "text", text: imagePrompt },
          { type: "image_url", image_url: { url: `data:image/png;base64,${challenge.png.toString("base64")}` } },
        ],
      }]);
    } else {
      imageReply = await engineReply(engine, [{ role: "user", content: imagePrompt }], { imagePath: challenge.imagePath });
    }
    const imageData = parseStructuredReply(imageReply.text);
    if (String(imageData.code) !== challenge.code || String(imageData.color).toUpperCase() !== challenge.color) {
      throw new Error("图片中的随机数字或色块颜色识别错误");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "图片测试失败";
    const proxySuspected = Boolean(String(engine.proxyUrl || "").trim() && /没有返回可显示文本|fetch failed|连接超时|连接失败|socket|reset/i.test(detail));
    const displayDetail = proxySuspected
      ? `${detail}；当前请求经过代理，代理链路可能截断了多模态响应，可关闭代理后重新测试`
      : detail;
    return {
      passed: false,
      text: String(textData.answer),
      error: `图片理解测试未通过：${displayDetail}`,
      tokenUsage: mergeTokenUsage(textReply?.tokenUsage, imageReply?.tokenUsage),
      proxySuspected,
      challengeImageUrl: `/api/engine/challenge/${challenge.id}`,
      ...(diagnostics ? { diagnostics } : {}),
      checks: {
        text: { passed: true, detail: "文字指令、随机令牌、格式与内容长度均合规", reply: String(textData.answer) },
        image: { passed: false, detail: displayDetail, reply: imageReply?.text?.slice(0, 1200) },
      },
    };
  }
  return {
    passed: true,
    text: String(textData.answer),
    tokenUsage: mergeTokenUsage(textReply?.tokenUsage, imageReply?.tokenUsage),
    challengeImageUrl: `/api/engine/challenge/${challenge.id}`,
    ...(diagnostics ? { diagnostics } : {}),
    checks: {
      text: { passed: true, detail: "文字指令、随机令牌、格式与内容长度均合规", reply: String(textData.answer) },
      image: { passed: true, detail: "真实图片已返回，随机数字与色块颜色均识别正确", reply: imageReply.text.slice(0, 1200) },
    },
  };
}

function endpointOrigin(value) {
  try { return new URL(String(value || "")).origin; } catch { return String(value || "").trim().replace(/\/$/, ""); }
}

function externalProcessingPlan(config) {
  const services = [];
  const dataTypes = new Set();
  if (config.engine?.mode === "api") {
    const preset = presetFor(config.engine);
    services.push({ purpose: "translation_review", provider: String(config.engine.provider || "compatible"), model: String(config.engine.model || preset.models[0] || ""), endpointOrigin: endpointOrigin(preset.baseUrl) });
    ["预习与检索上下文", "听写文本", "字幕译文", "必要的疑点画面裁切/OCR 信息"].forEach((item) => dataTypes.add(item));
  }
  if (config.transcription?.mode === "api") {
    services.push({ purpose: "transcription", provider: String(config.transcription.provider || "compatible_audio"), model: String(config.transcription.model || ""), endpointOrigin: endpointOrigin(config.transcription.baseUrl) });
    ["约 20 秒测试音频", "正式听写音频分块"].forEach((item) => dataTypes.add(item));
  }
  return {
    required: services.length > 0,
    services,
    dataTypes: [...dataTypes],
    fingerprint: services.map((item) => `${item.purpose}:${item.provider}:${item.model}:${item.endpointOrigin}`).join("|"),
  };
}

function externalProcessingConsentStatus(config) {
  const plan = externalProcessingPlan(config);
  if (!plan.required) return { ...plan, granted: true, grantedAt: null, currentTaskOnly: true };
  const consent = config.externalProcessingConsent;
  const grantedAt = Date.parse(String(consent?.grantedAt || ""));
  const valid = consent?.version === 1
    && consent?.granted === true
    && consent?.currentTaskOnly === true
    && consent?.fingerprint === plan.fingerprint
    && Number.isFinite(grantedAt);
  return { ...plan, granted: valid, grantedAt: valid ? new Date(grantedAt).toISOString() : null, currentTaskOnly: true, version: 1 };
}

function verifiedExternalProcessingConsent(config) {
  const status = externalProcessingConsentStatus(config);
  if (!status.required) return status;
  const valid = status.granted;
  if (!valid) {
    throw new Error("需要先确认外部模型处理授权：当前任务会把听写文本、翻译上下文及必要的疑点证据发送给所选 API；请回到 GakuNiku 第四步勾选内联授权项后再开始或续跑。");
  }
  return status;
}

function initialManifest(config) {
  return {
    schema_version: 1,
    created_at: new Date().toISOString(),
    source: { kind: sourceKind(config.source), value: config.source, acquired_media: null },
    languages: { source: config.sourceLanguage || "ja", target: config.targetLanguage || "zh-Hans" },
    phases: Object.fromEntries(phaseIds.map((id) => [id, { status: "pending", evidence: [] }])),
    artifacts: {},
    review_policy: { ambiguities: ambiguityReviewModeFromConfig(config) },
    external_processing: verifiedExternalProcessingConsent(config),
    limitations: [],
    notices: [],
  };
}

function sanitizedConfig(config) {
  return {
    ...config,
    engine: { ...(config.engine ?? {}), apiKey: config.engine?.apiKey ? "[provided at launch only]" : "", proxyUrl: config.engine?.proxyUrl ? "[provided at launch only]" : "" },
    transcription: { ...(config.transcription ?? {}), apiKey: config.transcription?.apiKey ? "[provided at launch only]" : "", hfToken: config.transcription?.hfToken ? "[provided at launch only]" : "" },
    search: { ...(config.search ?? {}), apiKey: config.search?.apiKey ? "[provided at launch only]" : "", proxyUrl: config.search?.proxyUrl ? "[provided at launch only]" : "" },
  };
}

function buildPrompt(config, jobDirectory, context = {}) {
  const externalConsent = verifiedExternalProcessingConsent(config);
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
    `原始 SKILL.md: ${harnessPath}`,
    ...(context.harnessOverride ? [`用户核对后的 harness 覆盖稿: ${context.harnessOverride}。覆盖稿优先于原始 skill，但仍需读取原始 skill 引用的三个 reference。`] : []),
    `任务目录: ${jobDirectory}`,
    `进度清单: ${path.join(jobDirectory, "manifest.json")}`,
    ...(context.resumeFrom ? [
      `这是一次断点续跑。先读取现有 manifest 与所有已登记产物，已完成且产物校验通过的阶段不得重做；从 ${context.resumeFrom} 开始继续。把该阶段原有 blocked/error 状态改为 in_progress 后再工作。`,
    ] : []),
    `视频源: ${config.source}`,
    `输出目录: ${config.outputPath}`,
    `源语言: ${config.sourceLanguage || "ja"}`,
    `目标语言: ${config.targetLanguage || "zh-CN"}`,
    `输出格式: ${(config.formats ?? []).join(", ")}`,
    ...(externalConsent.required ? [
      `外部处理知情授权（已由用户在 GakuNiku 界面为当前任务明确确认）: 授权时间 ${externalConsent.grantedAt}；授权服务 ${externalConsent.services.map((item) => `${item.provider}/${item.model} (${item.endpointOrigin})`).join("、")}；授权数据 ${externalConsent.dataTypes.join("、")}。`,
      "这是本任务可审计的明确用户授权。只在完成当前字幕任务所必需的范围内调用上述服务；不得再次因为发送已授权的听写文本、翻译上下文或必要疑点证据而阻塞或索要授权。不得公开素材、转交未列出的服务，且本地听写模式不得上传整段视频或音频。",
    ] : ["本任务未使用外部 API，不需要发送媒体衍生数据。"]),
    `用户确认的本次成片约束: ${String(config.deliveryConstraints || "最多两行、无多余句末句号、说话起止严格贴合、角色色描边发光、OCR 抽帧检查。").trim()}。把它作为本任务的明确验收要求执行并写入最终验证报告。`,
    `听写引擎: ${config.transcription?.mode || "local"}/${config.transcription?.provider || "faster_whisper"}/${config.transcription?.model || "turbo"}`,
    `听写质量: ${config.transcription?.quality || "balanced"}；原文语言 ${config.transcription?.language || config.sourceLanguage || "ja"}；beam size ${config.transcription?.beamSize || 5}；分块 ${config.transcription?.chunkMinutes || 10} 分钟；词级时间戳 ${config.transcription?.wordTimestamps === false ? "关闭" : "开启"}；说话人分离 ${config.transcription?.diarization === false ? "关闭" : "开启"}；二次复核 ${config.transcription?.secondPass ? "开启" : "关闭"}。`,
    ...(config.transcription?.mode === "api" ? [
      `在线听写接口: ${config.transcription.baseUrl}；模型 ${config.transcription.model}。把媒体先抽取为磁盘音频分块，再调用音频转写接口，不得把整段视频一次性上传或载入内存。`,
      ...(config.transcription.provider === "openai_audio" ? [
        "OpenAI 听写使用 POST /audio/transcriptions。gpt-4o-transcribe-diarize 必须使用 diarized_json，并对超过 30 秒的输入设置 chunking_strategy=auto；该型号不支持 word timestamp granularities，需将说话人分段边界与本地词级对齐结合。",
      ] : []),
      ...(config.transcription.provider === "deepgram" ? [
        "Deepgram 使用 /listen；Nova-3 启用 keyterm 增强预习术语，分离说话人时使用 diarize_model=latest，不要同时发送已弃用的 diarize=true。",
      ] : []),
      "获取到本地媒体后，先抽取约 20 秒有人声的单声道音频做真实接口测试；确认所选模型返回非空原文与时间信息后，才允许继续整段听写。测试失败时将 source_transcript 标为 blocked，并保留已完成的获取与预习成果。",
    ] : [
      `本地听写要求: ${config.transcription?.provider === "whisper_cpp" ? "使用 whisper.cpp 与已下载 GGML 模型" : config.transcription?.provider === "openai_whisper" ? "使用 OpenAI Whisper 本地 CLI" : "优先使用 faster-whisper/CTranslate2"}；选择 ${config.transcription?.model || "turbo"}；启用 VAD、磁盘分块、重叠去重和 ${config.transcription?.beamSize || 5} 路束搜索。缺少运行库时明确阻塞并给出安装说明，不得悄悄改用翻译模型猜听写。`,
      ...(config.transcription?.provider === "faster_whisper" ? [
        `Faster-Whisper 已由 Studio 预检。必须用 ${path.join(projectRoot, "harness", "precision-video-subtitles", "scripts", "transcribe_faster_whisper.py")} 执行真实听写，Python 路径从 PSS_TRANSCRIPTION_PYTHON 读取，模型缓存从 PSS_TRANSCRIPTION_MODEL_CACHE 读取；禁止重新安装、联网下载或用翻译模型编造原文。先用 FFmpeg 把媒体抽取成 16 kHz 单声道 FLAC 分块，再逐块调用脚本并合并到 ${path.join(jobDirectory, "work", "source-transcript.json")}。`,
      ] : []),
      ...(config.transcription?.diarization ? ["WhisperX 位于独立环境。必须只使用 PSS_TRANSCRIPTION_DIARIZATION_PYTHON 调用对齐/聚类，不得在基础听写环境安装或修改依赖；匿名 speaker ID 必须结合已知声线、画面与自我介绍复核后才能映射角色名。"] : []),
    ]),
    `预习关键词: ${(config.research?.keywords ?? []).join(", ")}`,
    `优先研究站点: ${sites.join(", ") || "官方资料优先"}`,
    `联网检索工具: ${searchConfig(config.search || { provider: "exa" }).preset.label}。研究阶段必须实际执行多次检索、打开关键来源正文并保存直接 URL；优先官方来源，粉丝站只作语境补充。单个搜索词或网页发生 404、拒绝访问、超时或提取失败时，记录为来源警告并继续其他查询，不得结束整个任务；只有工具整体不可用或全部查询都无证据时才阻塞。工具调用会展示给用户，请让查询词和来源选择清晰可审计。`,
    `思考强度: ${config.engine?.reasoning || "medium"}。在疑点复核和专有名词判定中按此强度投入推理，但仍须以证据为准。`,
    ambiguityReviewPolicyPrompt(ambiguityReviewModeFromConfig(config)),
    ...(context.researchPreview ? [
      `用户已经核对并确认了预习文档: ${context.researchPreview}。它是本任务可直接复用的研究基线，不得从零重复通用检索。`,
      "先从该文档提取 brief、sources、glossary 与 speakers。角色名与对应声优必须写入同一 speaker_entity_id 的一行，分别保存 character_name、performer_name 与 speaking_as，绝不能因为两个名字都出现就拆成两个说话人；再把“角色与成员色”表中的色名、HEX、适用身份、来源类型、URL 与置信度写入同一行。只对文档明确标为待核/低置信度、与当前片段身份冲突、或片段新增且会改变译意的事实做差量核验；默认最多 3 条定向查询、打开最多 4 个高价值正文来源。若没有这些缺口，直接落盘四份研究产物并完成研究阶段。",
    ] : []),
    ...(context.knowledgePaths?.length ? [`用户调取的本地知识库文档: ${context.knowledgePaths.join(", ")}。知识库是线索，冲突时以当前官方来源为准。`] : []),
    ...(config.engine?.mode === "api" ? [
      `用户在第一步指定并验证的研究/翻译模型: ${config.engine.provider}/${config.engine.model}。本地 Agent 只负责工具编排；检索词规划、结果筛选、证据归纳、语义判断与每批翻译必须调用用户所选模型，不得用 Codex、Claude 或其他编排模型替代。`,
      `调用方法: 先写 JSON 输入文件 {"messages":[{"role":"system","content":"..."},{"role":"user","content":"..."}]}，再运行 node ${apiHelperPath} 输入文件 输出文件；读取输出 JSON 的 text 字段。按段调用，单次输入不超过 2 MB。`,
      "稳定性约束: 模型与检索的完整输入/输出必须留在磁盘文件，禁止在命令后追加 cat、完整 jq -r .text 或循环打印整份结果。每次终端回显控制在 4 KB 内，只查看必要字段、计数或分段摘要；需要转换大 JSON 时直接由脚本读写文件。不得把大段工具输出回灌给编排 Agent。",
    ] : []),
    ...(config.engine?.mode === "gpu" ? [
      `用户在第一步指定并验证的研究/翻译模型: Ollama/${config.engine.gpuModel || config.engine.model}。本地 Agent 只负责工具编排；检索词规划、结果筛选、证据归纳、语义判断与每批翻译必须通过 Ollama 调用该模型，不得用 Codex、Claude 或其他编排模型替代。`,
      "调用本地模型时使用磁盘分批输入，控制上下文大小，避免一次载入整份转写或视频。",
    ] : []),
    "字幕硬约束: 每个逻辑字幕最多两行；充分利用横向安全区；对话型中文字幕默认不在每条末尾添加句号‘。’，但保留句中的句号以及必要的问号、感叹号、省略号和破折号；从该人开口的第一个词出现，到最后一个词结束时消失；可靠角色色用于外圈描边、柔光和投影；不可靠时使用确定性随机色并记录；疑点先分级，只有画面文字确实可能解疑时才抽帧/OCR。",
    "人物实体硬约束: 一个角色及其对应声优/出演者只能生成一个人物实体。roles 中同时保存 characterName、performerName 与 speakingAs；动画/剧情角色对白使用 speakingAs=character，访谈、舞台、广播或活动中本人发言使用 speakingAs=performer，证据不足用 unknown。name 必须等于当前发言身份对应的名字。不得把角色名和声优名拆成两个 role，也不得把作品名、组合名、活动名或匿名聚类标签当成人物。",
    "资源约束: 不得把完整视频读入内存；音频以 5–10 分钟分块并保留 2–5 秒重叠；子进程与转写结果直接落盘。",
    `精修数据: 完成字幕后额外写出 ${path.join(jobDirectory, "work", "studio-review.json")}，JSON 结构为 {"roles":[{"id":"同一角色—声优对的稳定实体 ID","name":"当前字幕显示名","characterName":"角色名或空串","performerName":"声优/出演者名或空串","speakingAs":"character|performer|unknown","color":"#RRGGBB","colorSource":{"kind":"official|evidence|user|fallback","reference":"直接来源 URL、用户确认或回退规则"}}],"cues":[{"id":1,"start":0.0,"end":1.0,"speakerId":"...","source":"...","translation":"...","confidence":0.95,"flagged":false}]}。同一角色—声优对只能有一条 role；该文件只含文本和时间码，不嵌入媒体。`,
    "清单语义: manifest.limitations 只记录尚未解决且会实质影响字幕语义、可读性、媒体完整性或交付验收的问题。已经按约定成功使用的确定性角色色回退、已解决但为可选人工复看而保留 flagged=true 的句子，都写入 manifest.notices 与相应报告/精修数据，不得列为 limitation。",
    "开始前读取 SKILL.md 及其直接引用的三个 reference。每开始一个阶段将 manifest 对应 status 写为 in_progress，每完成则写为 complete 并记录 evidence；无法继续写 blocked 和原因。完成后保留 SRT、ASS、封装视频和验证报告。",
  ].join("\n");
}

function adapter(config) {
  const mode = config.engine?.mode || "cli";
  let name = config.engine?.cli || "codex";
  if (mode === "gpu") name = executable("codex") ? "codex" : "claude";
  if (mode === "api") name = executable("codex") ? "codex" : "claude";
  const command = executable(name);
  if (!command) throw new Error(`本机没有发现 ${name}，请先安装或改用其他 Agent。`);
  const extraToolDirectories = [executable("uvx"), executable("yutto")].filter(Boolean).map((value) => path.dirname(value));
  const env = { ...process.env, PATH: [...new Set(extraToolDirectories), process.env.PATH || ""].filter(Boolean).join(path.delimiter) };
  Object.assign(env, applyProxyEnv(env, config.engine?.proxyUrl || config.search?.proxyUrl));
  const key = String(config.engine?.apiKey || "").trim();
  if (mode === "api") {
    if (!key) throw new Error("API 模式需要填写 API Key。 ");
    const preset = presetFor(config.engine);
    env.PSS_API_KEY = key;
    env.PSS_API_PROVIDER = String(config.engine.provider || "compatible");
    env.PSS_API_MODEL = String(config.engine.model || preset.models[0] || "");
    env.PSS_API_BASE_URL = preset.baseUrl;
    env.PSS_REASONING_EFFORT = String(config.engine.reasoning || "medium");
    if (config.engine.provider === "openai") {
      env.OPENAI_API_KEY = key;
      env.OPENAI_BASE_URL = preset.baseUrl;
    }
  }
  if (mode === "gpu") {
    env.PSS_LOCAL_MODEL_PROVIDER = "ollama";
    env.PSS_LOCAL_MODEL = String(config.engine.gpuModel || config.engine.model || "deepseek-r1:14b");
    env.PSS_REASONING_EFFORT = String(config.engine.reasoning || "medium");
  }
  if (config.transcription?.mode === "api") {
    const transcriptionKey = String(config.transcription.apiKey || "").trim();
    if (!transcriptionKey) throw new Error("在线听写模式需要填写听写 API Key。 ");
    env.PSS_TRANSCRIPTION_PROVIDER = String(config.transcription.provider || "compatible_audio");
    env.PSS_TRANSCRIPTION_MODEL = String(config.transcription.model || "");
    env.PSS_TRANSCRIPTION_BASE_URL = String(config.transcription.baseUrl || "");
    env.PSS_TRANSCRIPTION_API_KEY = transcriptionKey;
  }
  return { name, command, env };
}

function adapterArguments(name, config, prompt, searchAgentConfig = { codexArgs: [], claudeArgs: [] }) {
  const modelArgs = config.engine?.mode !== "api" && config.engine?.model ? ["--model", config.engine.model] : [];
  const reasoning = config.engine?.reasoning || "medium";
  if (name === "codex") return [...searchAgentConfig.codexArgs, "exec", "--ephemeral", "--json", "--skip-git-repo-check", "--disable", "plugins", "--disable", "apps", "--disable", "tool_suggest", "-c", `model_reasoning_effort="${reasoning}"`, ...modelArgs, prompt];
  if (name === "claude") return ["-p", prompt, ...modelArgs, "--effort", reasoning, "--output-format", "stream-json", "--verbose", ...searchAgentConfig.claudeArgs];
  if (name === "opencode") return ["run", "--format", "json", ...(config.engine?.model ? ["--model", config.engine.model] : []), prompt];
  if (name === "pi") return ["-p", "--mode", "json", prompt];
  if (name === "cline") return ["--json", "--auto-approve", "true", ...(config.engine?.model ? ["--model", config.engine.model] : []), prompt];
  if (name === "deepseek") return ["-p", prompt];
  if (name === "ollama") return ["run", config.engine?.gpuModel || config.engine?.model || "deepseek-r1:14b", prompt];
  throw new Error(`不支持的 Agent: ${name}`);
}

async function launchJob(config) {
  const kind = sourceKind(config.source);
  if (kind === "unknown") throw new Error("无法识别视频位置，请使用本地完整路径或 yt-dlp 支持的网页链接。 ");
  if (!String(config.outputPath || "").trim()) throw new Error("输出路径不能为空。 ");
  if (!Array.isArray(config.formats) || !config.formats.length) throw new Error("至少选择一种输出格式。 ");
  verifiedExternalProcessingConsent(config);
  const transcriptionCheck = await transcriptionEnvironment(config.transcription || {});
  if (!transcriptionCheck.ready) {
    const missing = transcriptionCheck.components.filter((item) => item.status === "missing").map((item) => item.label).join("、");
    throw new Error(`听写环境尚未准备：${missing || transcriptionCheck.recommendation}。请先在“原文听写引擎”中检查环境，按需下载或关闭未准备的增强项。`);
  }
  const id = randomUUID();
  const jobDirectory = safeJobDirectory(id);
  await Promise.all(["source", "research", "work", "frames", "subtitles", "deliverables", "logs"].map((name) => mkdir(path.join(jobDirectory, name), { recursive: true })));
  const context = { knowledgePaths: [] };
  if (String(config.harnessText || "").trim()) {
    context.harnessOverride = path.join(jobDirectory, "work", "harness-user-override.md");
    await writeFile(context.harnessOverride, String(config.harnessText).slice(0, 500_000), "utf8");
  }
  if (String(config.research?.preview || "").trim()) {
    context.researchPreview = path.join(jobDirectory, "research", "user-approved-preview.md");
    await writeFile(context.researchPreview, String(config.research.preview).slice(0, 500_000), "utf8");
  }
  for (const rawId of config.research?.knowledgeIds || []) {
    const id = safeKnowledgeId(rawId);
    const entry = await readJsonFile(path.join(knowledgeRoot, `${id}.json`));
    if (!entry) continue;
    const destination = path.join(jobDirectory, "research", `knowledge-${id}.md`);
    await writeFile(destination, `# ${entry.title}\n\n${entry.content}\n`, "utf8");
    context.knowledgePaths.push(destination);
  }
  const prompt = buildPrompt(config, jobDirectory, context);
  const selected = adapter(config);
  const searchAgentConfig = ["codex", "claude"].includes(selected.name)
    ? await researchAgentConfig(jobDirectory, config.engine || {}, config.search || { provider: "exa" })
    : { env: selected.env, codexArgs: [], claudeArgs: [], description: "当前 Agent 自带检索" };
  selected.env = { ...selected.env, ...searchAgentConfig.env };
  if (config.transcription?.mode === "local" && config.transcription?.provider === "faster_whisper") {
    const paths = transcriptionPaths(config.transcription);
    selected.env.PSS_TRANSCRIPTION_PYTHON = transcriptionCheck.python;
    selected.env.PSS_TRANSCRIPTION_SCRIPT = path.join(projectRoot, "harness", "precision-video-subtitles", "scripts", "transcribe_faster_whisper.py");
    selected.env.PSS_TRANSCRIPTION_MODEL_CACHE = paths.modelRoot;
    if (config.transcription?.diarization) selected.env.PSS_TRANSCRIPTION_DIARIZATION_PYTHON = venvPython(paths.diarizationRuntimePath);
    if (config.transcription?.diarization && String(config.transcription?.hfToken || "").trim()) selected.env.HF_TOKEN = String(config.transcription.hfToken).trim();
  }
  const args = adapterArguments(selected.name, config, prompt, searchAgentConfig);
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
  activeJobProcesses.set(id, child);
  child.stdout.pipe(outputLog);
  child.stderr.pipe(errorLog);
  state.pid = child.pid;
  await writeJsonFile(stateFile, state);
  child.on("error", async (error) => {
    if (searchAgentConfig.ephemeralConfigPath) await unlink(searchAgentConfig.ephemeralConfigPath).catch(() => {});
    activeJobProcesses.delete(id);
    const latest = await readJsonFile(stateFile, state);
    if (latest.status === "cancelled") return;
    await writeJsonFile(stateFile, { ...latest, status: "failed", error: error.message, finishedAt: new Date().toISOString() });
  });
  child.on("close", async (code, signal) => {
    activeJobProcesses.delete(id);
    outputLog.end();
    errorLog.end();
    await Promise.all([finished(outputLog).catch(() => {}), finished(errorLog).catch(() => {})]);
    if (searchAgentConfig.ephemeralConfigPath) await unlink(searchAgentConfig.ephemeralConfigPath).catch(() => {});
    const latest = await readJsonFile(stateFile, state);
    if (latest.status === "cancelled") {
      await writeJsonFile(stateFile, { ...latest, exitCode: code, signal, finishedAt: latest.finishedAt || new Date().toISOString() });
      return;
    }
    const manifest = await readJsonFile(path.join(jobDirectory, "manifest.json"), {});
    const blocked = phaseIds.find((id) => ["blocked", "error"].includes(workflowPhaseStatus(id, manifest.phases?.[id])));
    const incomplete = phaseIds.find((id) => !["complete", "completed", "skipped"].includes(workflowPhaseStatus(id, manifest.phases?.[id])));
    // The manifest is the durable source of truth. An orchestrator may be
    // terminated after it has already written and validated every artifact;
    // in that case a signal/non-zero exit must not turn a completed job into
    // a false failure.
    const terminalStatus = blocked ? "blocked" : !incomplete ? "completed" : "failed";
    const blockedDetail = blocked ? phaseBlocker(manifest, blocked) : null;
    await writeJsonFile(stateFile, {
      ...latest,
      status: terminalStatus,
      exitCode: code,
      signal,
      ...(terminalStatus === "completed"
        ? { message: "任务已完成，等待精修" }
        : terminalStatus === "blocked"
          ? { message: `${phaseLabels[blocked]}：需要处理`, error: blockedDetail.detail, blocker: blockedDetail }
          : { error: code === 0 ? `Agent 已退出，但阶段 ${incomplete || "unknown"} 尚未完成` : `Agent 退出，代码 ${code ?? "unknown"}` }),
      finishedAt: new Date().toISOString(),
    });
  });
  return { id, status: "running", jobDirectory, agent: selected.name };
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function processTreePids(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return [];
  if (process.platform === "win32") return [pid];
  const listed = spawnSync("ps", ["-Ao", "pid=,ppid="], { encoding: "utf8", timeout: 2_000 });
  if (listed.status !== 0 || !listed.stdout) return [pid];
  const children = new Map();
  for (const line of String(listed.stdout).split("\n")) {
    const [childText, parentText] = line.trim().split(/\s+/);
    const child = Number(childText);
    const parent = Number(parentText);
    if (!Number.isInteger(child) || !Number.isInteger(parent)) continue;
    const siblings = children.get(parent) || [];
    siblings.push(child);
    children.set(parent, siblings);
  }
  const ordered = [];
  const visit = (current) => {
    for (const child of children.get(current) || []) visit(child);
    ordered.push(current);
  };
  visit(pid);
  return [...new Set(ordered)];
}

function stopJobProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 });
    return;
  }
  const targets = processTreePids(pid);
  for (const target of targets) {
    try { process.kill(target, "SIGTERM"); } catch { /* process may already have exited */ }
  }
  const forceTimer = setTimeout(() => {
    for (const target of targets) {
      if (!processAlive(target)) continue;
      try { process.kill(target, "SIGKILL"); } catch { /* process may already have exited */ }
    }
  }, 2_500);
  forceTimer.unref?.();
}

const informationalLimitationRules = [
  {
    test: (value) => /role colou?rs?|角色色|应援色/i.test(value)
      && /fallback|回退|presentation metadata|did not establish|not established|未建立|未确认/i.test(value)
      && !/unreadable|illegible|failed|incorrect|wrong|clipp|low contrast|无法辨认|不可读|失败|错误|不正确|遮挡|对比度不足/i.test(value),
    message: "角色色：研究资料未提供可核验的官方色值，已按项目规则使用确定性回退色；这属于样式来源说明，不影响字幕内容或成片验收。",
  },
  {
    test: (value) => /resolved|已解决/i.test(value)
      && /flagged\s*=\s*true|复看标记/i.test(value)
      && /optional|可选|refinement|精修/i.test(value)
      && !/failed|incorrect|wrong|unresolved|失败|错误|未解决/i.test(value),
    message: "精修提示：已解决的疑点仍保留可选人工复看标记，可在精修台检查；该标记不阻塞成片。",
  },
];

function manifestPresentationNotes(manifest = {}) {
  const limitations = [];
  const notices = [];
  for (const item of Array.isArray(manifest.notices) ? manifest.notices : []) {
    const value = typeof item === "string" ? item : String(item?.message || item?.detail || item?.label || "").trim();
    if (value && !notices.includes(value)) notices.push(value);
  }
  for (const item of Array.isArray(manifest.limitations) ? manifest.limitations : []) {
    const value = String(item || "").trim();
    if (!value) continue;
    const informational = informationalLimitationRules.find((rule) => rule.test(value));
    if (informational) {
      if (!notices.includes(informational.message)) notices.push(informational.message);
    } else {
      limitations.push(value);
    }
  }
  return { limitations, notices };
}

async function terminateJob(id) {
  const jobDirectory = safeJobDirectory(id);
  const stateFile = path.join(jobDirectory, "job-state.json");
  const state = await readJsonFile(stateFile);
  if (!state) throw new Error("任务不存在");
  const child = activeJobProcesses.get(id);
  if (state.status === "completed" || state.status === "cancelled") {
    if (child?.pid) stopJobProcessTree(Number(child.pid));
    activeJobProcesses.delete(id);
    const alreadyCompleted = state.status === "completed";
    return {
      id,
      status: state.status,
      message: alreadyCompleted ? "任务已经完成，无需再次终止" : "任务已经处于终止状态，已有成果仍然保留",
      resumable: !alreadyCompleted,
      alreadyStopped: true,
    };
  }
  const stoppedAt = new Date().toISOString();
  const cancelled = {
    ...state,
    status: "cancelled",
    message: "任务已终止，已有成果已保留，可从断点继续",
    cancelledAt: stoppedAt,
    finishedAt: stoppedAt,
  };
  delete cancelled.error;
  delete cancelled.blocker;
  await writeJsonFile(stateFile, cancelled);
  const pid = Number(child?.pid || (state.status === "running" ? state.pid : 0));
  stopJobProcessTree(pid);
  activeJobProcesses.delete(id);
  return { id, status: "cancelled", message: cancelled.message, resumable: true };
}

function phaseBlocker(manifest, id) {
  const phase = manifest.phases?.[id] || {};
  const evidence = Array.isArray(phase.evidence) ? phase.evidence.map(String) : [];
  const { limitations } = manifestPresentationNotes(manifest);
  let detail = String(phase.error || phase.reason || phase.detail || phase.message || limitations[0] || evidence.at(-1) || `阶段 ${id} 无法继续`);
  if (id === "source_transcript" && /faster-whisper|ctranslate2|whisperx/i.test(detail) && /not installed|missing|blocked/i.test(detail)) {
    detail = "原文听写所需的 Faster-Whisper / CTranslate2 尚未安装；若启用了说话人分离，还需要 WhisperX。获取素材与背景预习成果已经保留，准备好听写环境后可从本阶段继续。";
  }
  return {
    phase: id,
    label: phaseDisplayLabels[id] || id,
    detail,
    evidence,
    limitations,
  };
}

const phaseArtifactKeys = {
  acquire: ["source_media", "media"],
  research: ["research_brief", "research_sources", "research_glossary", "research_speakers"],
  source_transcript: ["source_transcript", "transcript", "source_transcript_json"],
  translate: ["translated_subtitles", "translation"],
  resolve_ambiguities: ["ambiguity_report"],
  subtitle_qc: ["srt", "ass", "subtitle_validation"],
  mux: ["mkv", "mp4", "muxed_media"],
  final_validation: ["validation_report", "final_report"],
};

async function recordedArtifactExists(directory, value, originalSource = "") {
  const candidate = mediaCandidate(value);
  if (!candidate) return false;
  const expanded = candidate.startsWith("~/") ? path.join(os.homedir(), candidate.slice(2)) : candidate;
  const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(directory, expanded);
  try {
    const resolved = await realpath(absolute);
    const realDirectory = await realpath(directory);
    let allowed = resolved.startsWith(`${realDirectory}${path.sep}`);
    if (originalSource) {
      try { allowed ||= resolved === await realpath(localSourcePath(originalSource)); } catch { /* original source may no longer exist */ }
    }
    return allowed && (await stat(resolved)).isFile();
  } catch { return false; }
}

async function validateResumeManifest(directory, manifest, config) {
  const updated = structuredClone(manifest);
  const warnings = [];
  for (const id of phaseIds) {
    const phase = updated.phases?.[id];
    if (!["complete", "completed"].includes(workflowPhaseStatus(id, phase))) continue;
    const keys = phaseArtifactKeys[id] || [];
    const recorded = keys.filter((key) => updated.artifacts?.[key] != null);
    if (id === "acquire" && !recorded.length && updated.source?.acquired_media) recorded.push("__source");
    if (!recorded.length) continue;
    const checks = await Promise.all(recorded.map((key) => recordedArtifactExists(directory, key === "__source" ? updated.source.acquired_media : updated.artifacts[key], config.source)));
    if (checks.every(Boolean)) continue;
    phase.status = "pending";
    phase.evidence = [...(Array.isArray(phase.evidence) ? phase.evidence : []), "断点续跑校验发现已登记产物缺失，本阶段将重新执行。"];
    warnings.push(`${id} 的已登记产物缺失`);
    const phaseIndex = phaseIds.indexOf(id);
    for (const later of phaseIds.slice(phaseIndex + 1)) {
      updated.phases[later] = { ...(updated.phases[later] || {}), status: "pending", evidence: [] };
    }
    break;
  }
  const resumeFrom = phaseIds.find((id) => !["complete", "completed", "skipped"].includes(workflowPhaseStatus(id, updated.phases?.[id])));
  if (resumeFrom) {
    const start = phaseIds.indexOf(resumeFrom);
    for (const id of phaseIds.slice(start)) {
      const current = updated.phases?.[id] || { evidence: [] };
      if (["blocked", "error", "in_progress", "running"].includes(String(current.status))) current.status = "pending";
      updated.phases[id] = current;
    }
  }
  updated.resume = { at: new Date().toISOString(), from: resumeFrom || null, warnings };
  return { manifest: updated, resumeFrom, warnings };
}

async function resumeJob(id, body) {
  const jobDirectory = safeJobDirectory(id);
  const stateFile = path.join(jobDirectory, "job-state.json");
  const [stored, state, existingManifest] = await Promise.all([
    readJsonFile(path.join(jobDirectory, "studio-job.json")),
    readJsonFile(stateFile),
    readJsonFile(path.join(jobDirectory, "manifest.json")),
  ]);
  if (!stored || !state || !existingManifest) throw new Error("任务不存在");
  if (state.status === "running" && processAlive(Number(state.pid))) throw new Error("任务仍在运行，无需重复续跑");
  const config = {
    ...stored,
    ...body,
    engine: { ...(stored.engine || {}), ...(body.engine || {}) },
    transcription: { ...(stored.transcription || {}), ...(body.transcription || {}) },
    search: { ...(stored.search || {}), ...(body.search || {}) },
  };
  const externalConsent = verifiedExternalProcessingConsent(config);
  const transcriptionCheck = await transcriptionEnvironment(config.transcription || {});
  if (!transcriptionCheck.ready) throw new Error(`听写环境尚未准备：${transcriptionCheck.recommendation}`);
  const validated = await validateResumeManifest(jobDirectory, existingManifest, config);
  if (!validated.resumeFrom) throw new Error("所有阶段均已完成，无需续跑");
  validated.manifest.external_processing = externalConsent;
  if (externalConsent.required && externalConsent.granted) {
    const resolvedAuthorization = /authoriz|consent|授权|media-derived|external model service/i;
    validated.manifest.limitations = (Array.isArray(validated.manifest.limitations) ? validated.manifest.limitations : []).filter((item) => !resolvedAuthorization.test(String(item)));
    for (const phase of Object.values(validated.manifest.phases || {})) {
      if (resolvedAuthorization.test(String(phase?.blocking_reason || ""))) delete phase.blocking_reason;
      if (resolvedAuthorization.test(String(phase?.reason || ""))) delete phase.reason;
    }
  }
  await writeJsonFile(path.join(jobDirectory, "manifest.json"), validated.manifest);
  const context = {
    resumeFrom: validated.resumeFrom,
    ...(existsSync(path.join(jobDirectory, "work", "harness-user-override.md")) ? { harnessOverride: path.join(jobDirectory, "work", "harness-user-override.md") } : {}),
    ...(existsSync(path.join(jobDirectory, "research", "user-approved-preview.md")) ? { researchPreview: path.join(jobDirectory, "research", "user-approved-preview.md") } : {}),
    knowledgePaths: (await readdir(path.join(jobDirectory, "research")).catch(() => [])).filter((name) => name.startsWith("knowledge-") && name.endsWith(".md")).map((name) => path.join(jobDirectory, "research", name)),
  };
  const prompt = buildPrompt(config, jobDirectory, context);
  const selected = adapter(config);
  const searchAgentConfig = ["codex", "claude"].includes(selected.name)
    ? await researchAgentConfig(jobDirectory, config.engine || {}, config.search || { provider: "exa" })
    : { env: selected.env, codexArgs: [], claudeArgs: [], description: "当前 Agent 自带检索" };
  selected.env = { ...selected.env, ...searchAgentConfig.env };
  if (config.transcription?.mode === "local" && config.transcription?.provider === "faster_whisper") {
    const paths = transcriptionPaths(config.transcription);
    selected.env.PSS_TRANSCRIPTION_PYTHON = transcriptionCheck.python;
    selected.env.PSS_TRANSCRIPTION_SCRIPT = path.join(projectRoot, "harness", "precision-video-subtitles", "scripts", "transcribe_faster_whisper.py");
    selected.env.PSS_TRANSCRIPTION_MODEL_CACHE = paths.modelRoot;
    if (config.transcription?.diarization) selected.env.PSS_TRANSCRIPTION_DIARIZATION_PYTHON = venvPython(paths.diarizationRuntimePath);
    if (config.transcription?.diarization && String(config.transcription?.hfToken || "").trim()) selected.env.HF_TOKEN = String(config.transcription.hfToken).trim();
  }
  const args = adapterArguments(selected.name, config, prompt, searchAgentConfig);
  await writeJsonFile(path.join(jobDirectory, "studio-job.json"), sanitizedConfig(config));
  const attempt = Number(state.attempt || 1) + 1;
  const nextState = { ...state, status: "running", agent: selected.name, attempt, resumedAt: new Date().toISOString(), message: `从“${phaseLabels[validated.resumeFrom]}”继续`, resumeFrom: validated.resumeFrom, warnings: validated.warnings };
  delete nextState.error;
  delete nextState.blocker;
  delete nextState.finishedAt;
  const outputLog = createWriteStream(path.join(jobDirectory, "logs", "agent.ndjson"), { flags: "a" });
  const errorLog = createWriteStream(path.join(jobDirectory, "logs", "agent.stderr.log"), { flags: "a" });
  const child = spawn(selected.command, args, { cwd: jobDirectory, env: selected.env, stdio: ["ignore", "pipe", "pipe"] });
  activeJobProcesses.set(id, child);
  child.stdout.pipe(outputLog);
  child.stderr.pipe(errorLog);
  nextState.pid = child.pid;
  await writeJsonFile(stateFile, nextState);
  child.on("error", async (error) => {
    if (searchAgentConfig.ephemeralConfigPath) await unlink(searchAgentConfig.ephemeralConfigPath).catch(() => {});
    activeJobProcesses.delete(id);
    const latest = await readJsonFile(stateFile, nextState);
    if (latest.status === "cancelled") return;
    await writeJsonFile(stateFile, { ...latest, status: "failed", error: error.message, finishedAt: new Date().toISOString() });
  });
  child.on("close", async (code, signal) => {
    activeJobProcesses.delete(id);
    outputLog.end(); errorLog.end();
    await Promise.all([finished(outputLog).catch(() => {}), finished(errorLog).catch(() => {})]);
    if (searchAgentConfig.ephemeralConfigPath) await unlink(searchAgentConfig.ephemeralConfigPath).catch(() => {});
    const latestState = await readJsonFile(stateFile, nextState);
    if (latestState.status === "cancelled") {
      await writeJsonFile(stateFile, { ...latestState, exitCode: code, signal, finishedAt: latestState.finishedAt || new Date().toISOString() });
      return;
    }
    const latestManifest = await readJsonFile(path.join(jobDirectory, "manifest.json"), {});
    const blocked = phaseIds.find((phaseId) => ["blocked", "error"].includes(workflowPhaseStatus(phaseId, latestManifest.phases?.[phaseId])));
    const incomplete = phaseIds.find((phaseId) => !["complete", "completed", "skipped"].includes(workflowPhaseStatus(phaseId, latestManifest.phases?.[phaseId])));
    const terminal = blocked ? "blocked" : !incomplete ? "completed" : "failed";
    const blocker = blocked ? phaseBlocker(latestManifest, blocked) : null;
    await writeJsonFile(stateFile, { ...latestState, status: terminal, exitCode: code, signal, ...(terminal === "completed" ? { message: "任务已完成，等待精修" } : terminal === "blocked" ? { blocker, error: blocker.detail, message: `${blocker.label}：需要处理` } : { error: `Agent 退出，代码 ${code ?? "unknown"}` }), finishedAt: new Date().toISOString() });
  });
  return { id, status: "running", resumeFrom: validated.resumeFrom, warnings: validated.warnings, attempt };
}

function normalizeStudioReview(review) {
  if (!review || typeof review !== "object" || !Array.isArray(review.roles)) return review;
  const roles = [];
  const entityIndex = new Map();
  const idRemap = new Map();
  for (const [index, rawRole] of review.roles.entries()) {
    if (!rawRole || typeof rawRole !== "object") continue;
    const originalId = String(rawRole.id || `speaker-${index + 1}`);
    const characterName = String(rawRole.characterName || "").trim();
    const performerName = String(rawRole.performerName || "").trim();
    const rawName = String(rawRole.name || "").trim();
    const speakingAs = ["character", "performer"].includes(String(rawRole.speakingAs))
      ? String(rawRole.speakingAs)
      : rawName && performerName && rawName === performerName
        ? "performer"
        : rawName && characterName && rawName === characterName
          ? "character"
          : "unknown";
    const name = speakingAs === "performer"
      ? performerName || rawName || characterName
      : speakingAs === "character"
        ? characterName || rawName || performerName
        : rawName || characterName || performerName || `未确认人物 ${index + 1}`;
    const pairKey = characterName && performerName ? `pair:${characterName.toLocaleLowerCase()}\u0000${performerName.toLocaleLowerCase()}` : `id:${originalId}`;
    const normalized = {
      ...rawRole,
      id: originalId,
      name,
      characterName,
      performerName,
      speakingAs,
      color: /^#[0-9a-f]{6}$/i.test(String(rawRole.color || "")) ? rawRole.color : "#A78BFA",
    };
    if (entityIndex.has(pairKey)) {
      const targetIndex = entityIndex.get(pairKey);
      const existing = roles[targetIndex];
      roles[targetIndex] = {
        ...existing,
        ...normalized,
        id: existing.id,
        characterName: existing.characterName || normalized.characterName,
        performerName: existing.performerName || normalized.performerName,
        speakingAs: existing.speakingAs !== "unknown" ? existing.speakingAs : normalized.speakingAs,
        name: existing.speakingAs !== "unknown" ? existing.name : normalized.name,
      };
      idRemap.set(originalId, existing.id);
    } else {
      entityIndex.set(pairKey, roles.length);
      roles.push(normalized);
      idRemap.set(originalId, originalId);
    }
  }
  const cues = Array.isArray(review.cues)
    ? review.cues.map((cue) => cue && typeof cue === "object" ? { ...cue, speakerId: idRemap.get(String(cue.speakerId || "")) || cue.speakerId } : cue)
    : review.cues;
  return { ...review, roles, cues };
}

async function jobStatus(id) {
  const directory = safeJobDirectory(id);
  const [state, manifest, rawReview] = await Promise.all([
    readJsonFile(path.join(directory, "job-state.json")),
    readJsonFile(path.join(directory, "manifest.json")),
    readJsonFile(path.join(directory, "work", "studio-review.json")),
  ]);
  const review = normalizeStudioReview(rawReview);
  if (!state || !manifest) throw new Error("任务不存在");
  let effectiveState = state;
  const blockedPhase = phaseIds.find((phaseId) => ["blocked", "error"].includes(workflowPhaseStatus(phaseId, manifest.phases?.[phaseId])));
  const incompletePhase = phaseIds.find((phaseId) => !["complete", "completed", "skipped"].includes(workflowPhaseStatus(phaseId, manifest.phases?.[phaseId])));
  if (state.status === "running" && !processAlive(Number(state.pid))) {
    const blocker = blockedPhase ? phaseBlocker(manifest, blockedPhase) : null;
    if (!blocker && !incompletePhase) {
      effectiveState = { ...state, status: "completed", message: "任务已完成，等待精修", reconciledAt: new Date().toISOString(), finishedAt: state.finishedAt || new Date().toISOString() };
      delete effectiveState.error;
      delete effectiveState.blocker;
    } else {
      effectiveState = {
        ...state,
        status: blocker ? "blocked" : "failed",
        ...(blocker
          ? { blocker, message: `${blocker.label}：需要处理`, error: blocker.detail }
          : { error: "本地 Agent 进程已经退出；服务已保留现有产物，可检查后恢复。" }),
        reconciledAt: new Date().toISOString(),
      };
    }
    await writeJsonFile(path.join(directory, "job-state.json"), effectiveState);
  } else if (state.status !== "cancelled" && blockedPhase) {
    const blocker = phaseBlocker(manifest, blockedPhase);
    effectiveState = { ...state, status: "blocked", blocker, message: `${blocker.label}：需要处理`, error: blocker.detail };
    if (JSON.stringify(state.blocker) !== JSON.stringify(blocker) || state.error !== blocker.detail) {
      await writeJsonFile(path.join(directory, "job-state.json"), effectiveState);
    }
  }
  const phases = {};
  const phaseDetails = {};
  let score = 0;
  let currentPhase = "";
  let manifestChanged = false;
  const observedAt = new Date().toISOString();
  const previousStatuses = jobPhaseStatusCache.get(directory) || {};
  const observedStatuses = {};
  for (const id of phaseIds) {
    const phase = manifest.phases?.[id] || { status: "pending", evidence: [] };
    manifest.phases ||= {};
    manifest.phases[id] = phase;
    const raw = workflowPhaseStatus(id, phase);
    if (raw !== String(phase.status ?? "pending")) {
      phase.status = raw;
      phase.evidence = [...(Array.isArray(phase.evidence) ? phase.evidence : []), "按当前疑点复核策略自动放行低风险项，任务继续进入字幕质检。"];
      manifestChanged = true;
    }
    observedStatuses[id] = raw;
    const running = raw === "in_progress" || raw === "running";
    const terminal = ["complete", "completed", "blocked", "error", "skipped"].includes(String(raw));
    if (running && !phase.started_at && !phase.startedAt) { phase.started_at = observedAt; phase.timing_source = "studio-observed"; manifestChanged = true; }
    const wasRunning = ["in_progress", "running"].includes(String(previousStatuses[id] || ""));
    if (terminal && wasRunning && !phase.finished_at && !phase.finishedAt && !phase.completed_at) { phase.finished_at = observedAt; phase.timing_source = "studio-observed"; manifestChanged = true; }
    const mapped = raw === "complete" || raw === "completed" ? "done" : raw === "in_progress" || raw === "running" ? "running" : raw === "blocked" ? "blocked" : raw === "error" ? "error" : raw === "skipped" ? "skipped" : "pending";
    phases[id] = mapped;
    const startedAt = phase.started_at || phase.startedAt || null;
    const finishedAt = phase.finished_at || phase.finishedAt || phase.completed_at || null;
    phaseDetails[id] = {
      status: mapped,
      rawStatus: raw,
      evidence: Array.isArray(phase.evidence) ? phase.evidence.map(String).slice(-6) : [],
      detail: phase.detail || phase.reason || phase.error || phase.message || "",
      startedAt,
      finishedAt,
      durationMs: startedAt && finishedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : null,
      riskSummary: phase.risk_summary && typeof phase.risk_summary === "object" ? phase.risk_summary : null,
    };
    if (mapped === "done") score += 1;
    if (mapped === "running") { score += 0.35; currentPhase = id; }
    if (mapped === "error" || mapped === "blocked") currentPhase = id;
  }
  jobPhaseStatusCache.set(directory, observedStatuses);
  if (manifestChanged) await writeJsonFile(path.join(directory, "manifest.json"), manifest);
  const progress = effectiveState.status === "completed" ? 100 : Math.max(1, Math.round((score / phaseIds.length) * 100));
  const media = await resolveMedia(id);
  const resources = await jobResources(directory, effectiveState);
  const tokenUsage = await jobTokenUsage(directory);
  const diagnostics = ["blocked", "failed"].includes(effectiveState.status) ? await jobDiagnostics(directory) : null;
  const storedConfig = await readJsonFile(path.join(directory, "studio-job.json"), {});
  const manifestNotes = manifestPresentationNotes(manifest);
  return {
    ...effectiveState,
    phases,
    phaseDetails,
    reviewPolicy: manifest.review_policy || { ambiguities: "pragmatic" },
    externalProcessingConsent: externalProcessingConsentStatus(storedConfig),
    progress,
    message: currentPhase ? phaseLabels[currentPhase] : effectiveState.message,
    manifest: { artifacts: manifest.artifacts, limitations: manifestNotes.limitations, notices: manifestNotes.notices },
    resources,
    tokenUsage,
    diagnostics,
    review,
    mediaUrl: media ? `/api/jobs/${id}/media` : null,
    trace: configTraceEnabled(storedConfig) ? await jobTrace(directory) : [],
  };
}

async function jobHistory() {
  const entries = await readdir(jobsRoot, { withFileTypes: true }).catch(() => []);
  const jobs = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && /^[a-f0-9-]{36}$/i.test(entry.name))
    .map(async (entry) => {
      const directory = path.join(jobsRoot, entry.name);
      const [state, config, info] = await Promise.all([
        readJsonFile(path.join(directory, "job-state.json"), {}),
        readJsonFile(path.join(directory, "studio-job.json"), {}),
        stat(directory).catch(() => null),
      ]);
      const createdAt = state.createdAt || state.startedAt || config.createdAt || info?.birthtime?.toISOString?.() || info?.mtime?.toISOString?.() || "";
      const updatedAt = state.finishedAt || state.updatedAt || state.reconciledAt || info?.mtime?.toISOString?.() || createdAt;
      return {
        id: entry.name,
        status: String(state.status || "unknown"),
        message: String(state.message || ""),
        source: String(config.source || ""),
        createdAt,
        updatedAt,
      };
    }));
  return jobs.sort((left, right) => Date.parse(right.updatedAt || right.createdAt) - Date.parse(left.updatedAt || left.createdAt)).slice(0, 60);
}

async function jobTokenUsage(directory) {
  const workRoot = path.join(directory, "work");
  const files = await readdir(workRoot, { recursive: true }).catch(() => []);
  let total = mergeTokenUsage();
  for (const relative of files.filter((item) => String(item).endsWith(".json")).slice(0, 500)) {
    const file = path.resolve(workRoot, String(relative));
    if (!file.startsWith(`${workRoot}${path.sep}`)) continue;
    const info = await stat(file).catch(() => null);
    if (!info?.isFile() || info.size > 2 * 1024 * 1024) continue;
    const data = await readJsonFile(file);
    if (data?.tokenUsage) total = mergeTokenUsage(total, data.tokenUsage);
  }
  return total;
}

function redactDiagnosticText(value) {
  return String(value || "")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[已隐藏]")
    .replace(/((?:api[_-]?key|authorization|token)\s*[=:]\s*)[^\s,;]+/gi, "$1[已隐藏]")
    .replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, "$1…[已隐藏]")
    .slice(-5000);
}

async function jobDiagnostics(directory) {
  const stderr = redactDiagnosticText(await readTail(path.join(directory, "logs", "agent.stderr.log"), 64 * 1024));
  const lines = stderr.split("\n").map((line) => line.trim()).filter(Boolean).slice(-18);
  return { stderr: lines, logPath: path.join(directory, "logs", "agent.stderr.log") };
}

async function directoryBytes(directory, depth = 0) {
  if (depth > 5) return 0;
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (entry.name.startsWith("._")) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(target, depth + 1);
    else if (entry.isFile()) total += Number((await stat(target).catch(() => ({ size: 0 }))).size || 0);
  }
  return total;
}

async function jobResources(directory, state) {
  const cached = jobResourceCache.get(directory);
  if (cached && cached.expiresAt > Date.now() && cached.pid === state.pid && cached.status === state.status) return cached.value;
  const createdAt = Date.parse(state.createdAt || state.resumedAt || "");
  const terminalAt = state.finishedAt || state.reconciledAt;
  const endAt = terminalAt ? Date.parse(terminalAt) : state.status === "running" ? Date.now() : createdAt;
  const elapsedMs = Number.isFinite(createdAt) ? Math.max(0, endAt - createdAt) : null;
  const diskBytes = await directoryBytes(directory);
  let processInfo = null;
  if (state.status === "running" && processAlive(Number(state.pid))) {
    const probe = spawnSync("/bin/ps", ["-o", "rss=,%cpu=,%mem=,etime=", "-p", String(state.pid)], { encoding: "utf8", timeout: 3000, maxBuffer: 64 * 1024 });
    const match = probe.status === 0 ? probe.stdout.trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/) : null;
    if (match) processInfo = { rssBytes: Number(match[1]) * 1024, rssLabel: formatStorage(Number(match[1]) * 1024), cpuPercent: Number(match[2]), memoryPercent: Number(match[3]), elapsed: match[4].trim() };
  }
  const value = { elapsedMs, diskBytes, diskLabel: formatStorage(diskBytes), process: processInfo, attempt: Number(state.attempt || 1) };
  jobResourceCache.set(directory, { expiresAt: Date.now() + 5000, pid: state.pid, status: state.status, value });
  return value;
}

function configTraceEnabled(config) {
  return Boolean(config?.execution?.showTrace);
}

async function readTail(file, maxBytes = 320 * 1024) {
  try {
    const info = await stat(file);
    const start = Math.max(0, info.size - maxBytes);
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(info.size - start);
      await handle.read(buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally { await handle.close(); }
  } catch { return ""; }
}

function traceLabel(name) {
  const known = ({ Read: "读取规则或素材", Bash: "运行本地媒体检查", WebSearch: "检索资料", WebFetch: "核对网页来源", Write: "写入阶段产物", Edit: "更新工作文档", TaskCreate: "规划执行阶段", TaskUpdate: "更新执行进度" })[name];
  if (known) return known;
  if (/search/i.test(name)) return "联网搜索";
  if (/fetch|open|extract/i.test(name)) return "打开来源正文";
  return `调用 ${name}`;
}

async function jobTrace(directory) {
  const raw = await readTail(path.join(directory, "logs", "agent.ndjson"));
  const events = [];
  for (const line of raw.split("\n")) {
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    if (item.type === "assistant") {
      for (const content of item.message?.content || []) {
        if (content.type === "tool_use") events.push({ kind: "action", text: traceLabel(content.name) });
        if (content.type === "text" && content.text?.trim()) events.push({ kind: "summary", text: content.text.trim().slice(0, 220) });
      }
    } else if (item.type === "system" && item.subtype === "thinking_tokens") {
      if (events.at(-1)?.text !== "模型正在整理下一步") events.push({ kind: "thinking", text: "模型正在整理下一步" });
    } else if (item.type === "result") {
      events.push({ kind: item.is_error ? "error" : "done", text: item.is_error ? "模型执行中断" : "Agent 已完成本轮执行" });
    }
    const candidate = item.item || item;
    if (candidate.type === "agent_message" && candidate.text?.trim()) events.push({ kind: "summary", text: candidate.text.trim().slice(0, 220) });
  }
  for (const event of researchEvents(raw, "codex")) events.push({ kind: "action", text: event.text });
  return events.slice(-24);
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
  if (request.method === "GET" && url.pathname === "/api/health") return json(request, 200, { ok: true, version: 3 });
  if (request.method === "GET" && url.pathname === "/api/capabilities") return json(request, 200, capabilities());
  if (request.method === "GET" && url.pathname === "/api/harness") return json(request, 200, { text: await readFile(harnessPath, "utf8"), path: harnessPath });
  if (request.method === "POST" && url.pathname === "/api/pick-transcription-environment") {
    const result = await pickLocalFolder("选择模型与项目数据文件夹（可放外接盘）");
    if (result.supported === false) return json(request, 501, { error: "当前系统请直接填写项目内的完整文件夹路径。" });
    return json(request, 200, result);
  }
  if (request.method === "POST" && url.pathname === "/api/transcription/check") {
    const body = await readJson(request, 128 * 1024);
    return json(request, 200, await transcriptionEnvironment(body.transcription || body));
  }
  if (request.method === "POST" && url.pathname === "/api/transcription/diagnose") {
    const body = await readJson(request, 256 * 1024);
    if (!body.engine?.mode) throw new Error("请先通过第一步的模型测试");
    const safeReport = redactLocalDiagnostic({
      transcription: {
        provider: body.transcription?.provider,
        model: body.transcription?.model,
        quality: body.transcription?.quality,
        diarization: Boolean(body.transcription?.diarization),
      },
      diagnostics: body.diagnostics,
      components: body.components,
      resources: body.resources,
    });
    const prompt = `你是本地字幕项目的环境诊断助手。根据以下已经由程序采集并脱敏的检查报告，用中文给普通用户解释：1. 最可能的失败原因；2. 哪些文件已经可复用；3. 最小修复方案；4. 是否应暂时关闭可选的说话人分离。不要生成或要求执行 shell 命令，不要建议删除整个项目，不要声称你亲自检查过未提供的信息。控制在 350 字以内。\n\n${JSON.stringify(safeReport, null, 2)}`;
    const result = await selectedEngineText(body.engine, prompt, { maxTokens: 900, timeoutMs: 120_000 });
    return json(request, 200, { advice: result.text, model: result.label, readOnly: true });
  }
  if (request.method === "POST" && url.pathname === "/api/transcription/install") {
    const body = await readJson(request, 128 * 1024);
    return json(request, 202, startTranscriptionInstall(body.transcription || body));
  }
  if (request.method === "POST" && url.pathname === "/api/transcription/test") {
    const body = await readJson(request, 128 * 1024);
    return json(request, 202, startTranscriptionTest(body.transcription || body));
  }
  const transcriptionOperationMatch = url.pathname.match(/^\/api\/transcription\/operations\/([a-f0-9-]{36})$/i);
  if (request.method === "GET" && transcriptionOperationMatch) {
    const operation = transcriptionOperations.get(transcriptionOperationMatch[1]);
    return operation ? json(request, 200, operation) : json(request, 404, { error: "准备任务不存在或服务已重启，请重新检查环境" });
  }
  const challengeMatch = url.pathname.match(/^\/api\/engine\/challenge\/([a-f0-9-]{36})$/i);
  if (request.method === "GET" && challengeMatch) {
    const challenge = engineChallengeImages.get(challengeMatch[1]);
    if (!challenge || challenge.expiresAt < Date.now()) {
      engineChallengeImages.delete(challengeMatch[1]);
      return json(request, 404, { error: "测试图片已过期，请重新测试" });
    }
    return new Response(challenge.png, {
      status: 200,
      headers: { ...responseHeaders(request), "content-type": "image/png", "cache-control": "private, max-age=600", "x-content-type-options": "nosniff" },
    });
  }
  if (request.method === "GET" && url.pathname === "/api/knowledge") return json(request, 200, { entries: await knowledgeEntries() });
  if (request.method === "POST" && url.pathname === "/api/knowledge") return json(request, 201, await saveKnowledge(await readJson(request)));
  const knowledgeMatch = url.pathname.match(/^\/api\/knowledge\/([^/]+)$/);
  if (request.method === "GET" && knowledgeMatch) {
    const entry = await readJsonFile(path.join(knowledgeRoot, `${safeKnowledgeId(knowledgeMatch[1])}.json`));
    return entry ? json(request, 200, entry) : json(request, 404, { error: "知识文档不存在" });
  }
  if (request.method === "POST" && url.pathname === "/api/engine/test") {
    const body = await readJson(request);
    const engine = body.engine || {};
    const messages = body.messages || [{ role: "user", content: "请回复：连接成功" }];
    if (body.multimodal !== true) return json(request, 400, { error: "模型测试必须同时启用文字和图片验证" });
    return json(request, 200, await runMultimodalEngineTest(engine, messages));
  }
  if (request.method === "POST" && url.pathname === "/api/engine/models") {
    const body = await readJson(request, 64 * 1024);
    return json(request, 200, await listApiModels(body.engine || {}));
  }
  if (request.method === "POST" && url.pathname === "/api/research/search-test") {
    const body = await readJson(request, 64 * 1024);
    const config = searchConfig(body.search || {});
    if (config.provider === "builtin") return json(request, 200, { ok: true, detail: "将使用当前 Agent 的内置联网搜索" });
    if (!config.url) return json(request, 400, { error: "请填写 MCP URL" });
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(config.provider === "exa" && config.apiKey ? { "x-api-key": config.apiKey } : {}),
        ...(["tavily", "custom"].includes(config.provider) && config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "precision-subtitle-studio", version: "0.1.0" } } }),
      signal: AbortSignal.timeout(15_000),
      ...proxyFetchOptions(config.proxyUrl),
    });
    const raw = await response.text();
    if (!response.ok) return json(request, 400, { error: `MCP 返回 HTTP ${response.status}：${raw.slice(0, 300)}` });
    return json(request, 200, { ok: true, detail: `${config.preset.label} 已响应 MCP 初始化请求` });
  }
  const researchStatusMatch = url.pathname.match(/^\/api\/research\/runs\/([a-f0-9-]{36})$/i);
  if (request.method === "GET" && researchStatusMatch) return json(request, 200, await researchRunStatus(researchStatusMatch[1]));
  if (request.method === "POST" && url.pathname === "/api/research/preview") {
    const body = await readJson(request);
    const template = researchTemplateWithSpeakerIdentity(body.research || {});
    const knowledgeContext = await researchKnowledgeContext(body.research?.knowledgeIds || []);
    const prompt = `${researchPrompt(body, template)}${knowledgeContext ? `\n\n以下是用户主动调取的本地知识库线索。必须重新联网核对；与当前官方来源冲突时以官方来源为准：\n\n${knowledgeContext}` : ""}`;
    if (!body.engine?.mode) throw new Error("请先在第一步设置并测试翻译模型");
    return json(request, 202, await startResearchRun(body.engine, prompt, body.search || { provider: "exa" }));
  }
  if (request.method === "POST" && url.pathname === "/api/pick-file") {
    const result = await pickLocalFile();
    if (result.supported === false) return json(request, 501, { error: "当前系统请使用浏览器文件选择器，并在视频位置填写完整路径。" });
    return json(request, 200, result);
  }
  if (request.method === "POST" && url.pathname === "/api/detect-source") {
    const body = await readJson(request);
    return json(request, 200, { kind: sourceKind(body.source) });
  }
  if (request.method === "GET" && url.pathname === "/api/jobs") return json(request, 200, { jobs: await jobHistory() });
  if (request.method === "POST" && url.pathname === "/api/jobs") {
    const body = await readJson(request);
    return json(request, 201, await launchJob(body));
  }
  const resumeMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/resume$/);
  if (request.method === "POST" && resumeMatch) {
    const body = await readJson(request);
    return json(request, 202, await resumeJob(resumeMatch[1], body));
  }
  const cancelMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
  if (request.method === "POST" && cancelMatch) return json(request, 200, await terminateJob(cancelMatch[1]));
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
