"use client";

import {
  type ChangeEvent,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  Brain,
  CaretRight,
  CheckCircle,
  ClockCounterClockwise,
  CursorClick,
  FilmStrip,
  FloppyDisk,
  FolderOpen,
  Gauge,
  Hand,
  MagnifyingGlass,
  Robot,
  SlidersHorizontal,
  Target,
  Trash,
} from "@phosphor-icons/react";
import apiPricingManifest from "../runtime/api-pricing.json";

const BRIDGE_URL = "http://127.0.0.1:43127";
const DEFAULT_DELIVERY_CONSTRAINTS = "最多两行、无多余句末句号、说话起止严格贴合、角色色描边发光、OCR 抽帧检查。";
const MAX_REVIEW_HISTORY = 100;
const REVIEW_EDIT_COALESCE_MS = 850;
const PROJECT_FILE_FORMAT = "gakuniku-project";
const PROJECT_FILE_VERSION = 1;
const MAX_PROJECT_FILE_BYTES = 12 * 1024 * 1024;

type Workspace = "prepare" | "running" | "review";
type EngineMode = "api" | "cli" | "gpu";
type StudioMode = "easy" | "advanced";
type PrepareStage = "engine" | "source" | "research" | "harness";
type TranscriptionMode = "local" | "api";
type DiarizationEngine = "sherpa_onnx" | "pyannote";
type AmbiguityReviewMode = "fast" | "pragmatic" | "strict";
type PhaseStatus = "pending" | "running" | "done" | "blocked" | "error" | "skipped";
type JobRunStatus = "idle" | "running" | "blocked" | "failed" | "cancelled" | "completed";
type HistoricalJob = { id: string; status: string; message: string; source: string; createdAt: string; updatedAt: string };
type SpeakerIdentity = "character" | "performer" | "unknown";
type ExternalProcessingConsent = {
  version: 1;
  granted: true;
  grantedAt: string;
  currentTaskOnly: true;
  fingerprint: string;
  services: Array<{ purpose: "translation_review" | "transcription"; provider: string; model: string; endpointOrigin: string }>;
  dataTypes: string[];
};

type Role = {
  id: string;
  name: string;
  color: string;
  characterName?: string;
  performerName?: string;
  speakingAs?: SpeakerIdentity;
};

type Cue = {
  id: number;
  start: number;
  end: number;
  speakerId: string;
  source: string;
  translation: string;
  confidence: number;
  flagged?: boolean;
};

type CueDragMode = "move" | "start" | "end";
type TimelineTool = "select" | "hand" | "delete";
type ReviewResizeKind = "preview-inspector" | "preview-timeline" | "timeline-cues" | "cue-editor";
type CueDragState = {
  cueId: number;
  mode: CueDragMode;
  pointerId: number;
  startX: number;
  originalStart: number;
  originalEnd: number;
  moved: boolean;
};

type ReviewSnapshot = {
  cues: Cue[];
  roles: Role[];
  selectedCueId: number;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  outline: number;
  glow: number;
  shadow: number;
};

type ReviewHistory = {
  past: ReviewSnapshot[];
  future: ReviewSnapshot[];
};

type GakuNikuProjectV1 = {
  format: "gakuniku-project";
  version: 1;
  appVersion: string;
  savedAt: string;
  workspace: Workspace;
  job: { id: string } | null;
  prepare: {
    studioMode: StudioMode;
    cameraFocus: PrepareStage;
    source: string;
    outputPath: string;
    formats: string[];
    engine: { mode: EngineMode; provider: string; model: string; baseUrl: string; cli: string; gpuModel: string; reasoning: string; proxyEnabled: boolean; proxyUrl: string };
    transcription: { mode: TranscriptionMode; provider: string; quality: string; model: string; baseUrl: string; language: string; diarization: boolean; diarizationEngine?: DiarizationEngine; wordTimestamps: boolean; environmentRoot: string };
    search: { provider: string; url: string };
    research: { keywords: string[]; sites: string[]; customSites: string; preview: string; knowledgeIds: string[]; title: string };
    harness: { text: string; confirmed: boolean; deliveryConstraints: string; ambiguityReviewMode: AmbiguityReviewMode };
    execution: { showTrace: boolean };
  };
  review: {
    roles: Role[];
    cues: Cue[];
    selectedCueId: number;
    currentTime: number;
    timelineZoom: number;
    style: { fontFamily: string; fontSize: number; fontWeight: number; outline: number; glow: number; shadow: number };
    layout: { inspectorWidth: number; previewWorkspaceHeight: number; timelineHeight: number; sentenceEditorWidth: number };
  };
};

type ReviewEditOptions = {
  historyKey?: string;
  coalesce?: boolean;
};

type ReviewResizeState = {
  kind: ReviewResizeKind;
  pointerId: number;
  startX: number;
  startY: number;
  startValue: number;
};

type TimelinePanState = {
  pointerId: number;
  startX: number;
  scrollLeft: number;
};

type Capability = {
  available: boolean;
  path?: string;
  detail?: string;
};

type ApiPriceRule = {
  currency: "CNY" | "USD";
  inputPerMillion: number;
  cachedInputPerMillion?: number;
  cacheWritePerMillion?: number;
  outputPerMillion: number;
  note?: string;
};

type ApiPricingManifest = {
  checkedAt: string;
  estimationPolicy: string;
  providers: Record<string, { docsUrl: string; models: Record<string, ApiPriceRule> }>;
};

type ApiPreset = {
  label: string;
  baseUrl: string;
  models: string[];
  multimodal: "native" | "unavailable" | "unknown";
  docsUrl?: string;
  checkedAt?: string;
  note?: string;
  pricing?: Record<string, ApiPriceRule>;
  pricingDocsUrl?: string;
};

type ModelCatalogCacheEntry = {
  version: 2;
  recommendedModels: string[];
  allModels: string[];
  pricing: Record<string, ApiPriceRule>;
  source: string;
  fetchedAt: string;
  warning?: string;
};

type SearchPreset = {
  label: string;
  url: string;
  keyOptional?: boolean;
  note?: string;
};

type ProxySuggestion = {
  detected: boolean;
  enabled: boolean;
  url: string;
  source: string;
  detail: string;
};

type ResearchTraceEvent = {
  kind: "setup" | "status" | "search" | "source" | "warning" | "done" | "error";
  text: string;
};

type KnowledgeEntry = {
  id: string;
  title: string;
  content: string;
  keywords: string[];
  updatedAt: string;
};

type TraceEvent = {
  kind: "action" | "summary" | "thinking" | "done" | "error";
  text: string;
};

type EngineTestStage = "idle" | "running" | "passed" | "failed";
type EngineTestResult = {
  stage: EngineTestStage;
  detail: string;
  reply?: string;
  previewUrl?: string;
};

type TokenUsage = {
  input: number;
  cachedInput: number;
  output: number;
  total: number;
  available: boolean;
  cacheAvailable: boolean;
};

type TranscriptionEnvironment = {
  ready: boolean;
  baseReady: boolean;
  requestedReady?: boolean;
  diarizationReady?: boolean;
  degraded?: boolean;
  diarizationEngine?: DiarizationEngine;
  installable?: boolean;
  installer?: string;
  installationCapabilities?: { base: boolean; diarization: boolean; mediaTools?: boolean; systemPython: string; basePython?: string; managedToolchain?: boolean };
  managedRuntime?: {
    platform: string;
    supported: boolean;
    uvVersion: string;
    uvReady: boolean;
    uvPath: string;
    pythonVersion: string;
    pythonReady: boolean;
    pythonPath: string;
    nativeToolsVersion?: string;
    nativeToolsReady?: boolean;
    ffmpegPath?: string;
    ffprobePath?: string;
    baseEnvironmentKey: string;
    diarizationEnvironmentKey: string;
    isolation: string;
  };
  environmentRoot: string;
  diarizationRuntimePath?: string;
  storageLayout?: {
    filesystem: string;
    runtimeCompatible: boolean;
    mode: "project" | "split";
    reason: string;
    dataPath: string;
    runtimePath: string;
    diarizationRuntimePath: string;
  };
  cachePath: string;
  runtimePath: string;
  recommendation: string;
  diagnostics?: {
    healthy: boolean;
    summary: string;
    issues: Array<{ id: string; label: string; detail: string; repair: string }>;
    repairComponents: { runtime: boolean; model: boolean; mediaTools?: boolean; diarization: boolean };
    lastInstall?: { status?: string; stage?: string; progress?: number; error?: string; finishedAt?: string } | null;
  };
  components: Array<{ id: string; label: string; status: "ready" | "missing" | "optional" | "degraded"; detail: string }>;
  resources: {
    downloadLabel: string;
    pendingDownloadLabel?: string;
    diarizationDownloadLabel?: string;
    nativeToolsDownloadLabel?: string;
    recommendedMemoryLabel: string;
    systemMemoryLabel: string;
    freeDiskLabel: string;
    diskSufficient: boolean;
    memorySufficient: boolean;
  };
};

type TranscriptionInstallEvent = { at: string; kind: "info" | "done" | "error" | "warning"; text: string };
type JobBlocker = { phase: string; label: string; detail: string; evidence: string[]; limitations: string[] };
type TranscriptionTestResult = {
  text: string;
  language: string;
  sampleStart: number;
  sampleDuration: number;
  elapsedMs: number;
  provider: string;
  model: string;
};
type PhaseDetail = { status: PhaseStatus; rawStatus: string; evidence: string[]; detail: string; startedAt: string | null; finishedAt: string | null; durationMs: number | null; riskSummary?: Record<string, number> | null };
type JobResources = {
  elapsedMs: number | null;
  diskBytes: number;
  diskLabel: string;
  attempt: number;
  process: null | { rssBytes: number; rssLabel: string; cpuPercent: number; memoryPercent: number; processCount?: number; elapsed: string };
  policy?: { memoryLimitBytes: number; memoryLimitLabel: string; idleTimeoutMs: number; hardTimeoutMs: number; maxConcurrentJobs: number; stdoutLogLimitLabel: string };
};

function endpointOrigin(value: string) {
  try { return new URL(value).origin; } catch { return String(value || "").trim().replace(/\/$/, ""); }
}

function externalProcessingPlan(input: {
  engineMode: EngineMode;
  provider: string;
  model: string;
  baseUrl: string;
  transcriptionMode: TranscriptionMode;
  transcriptionProvider: string;
  transcriptionModel: string;
  transcriptionBaseUrl: string;
}) {
  const services: ExternalProcessingConsent["services"] = [];
  const dataTypes = new Set<string>();
  if (input.engineMode === "api") {
    services.push({ purpose: "translation_review", provider: input.provider, model: input.model, endpointOrigin: endpointOrigin(input.baseUrl) });
    ["预习与检索上下文", "听写文本", "字幕译文", "必要的疑点画面裁切/OCR 信息"].forEach((item) => dataTypes.add(item));
  }
  if (input.transcriptionMode === "api") {
    services.push({ purpose: "transcription", provider: input.transcriptionProvider, model: input.transcriptionModel, endpointOrigin: endpointOrigin(input.transcriptionBaseUrl) });
    ["约 20 秒测试音频", "正式听写音频分块"].forEach((item) => dataTypes.add(item));
  }
  const fingerprint = services.map((item) => `${item.purpose}:${item.provider}:${item.model}:${item.endpointOrigin}`).join("|");
  return { required: services.length > 0, services, dataTypes: [...dataTypes], fingerprint };
}

const embeddedApiPricing = apiPricingManifest as ApiPricingManifest;
const providerPricing = (provider: string) => embeddedApiPricing.providers[provider]?.models ?? {};
const providerPricingDocs = (provider: string) => embeddedApiPricing.providers[provider]?.docsUrl;

const fallbackApiPresets: Record<string, ApiPreset> = {
  openai: { label: "GPT / OpenAI API", baseUrl: "https://api.openai.com/v1", models: ["gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna"], multimodal: "native", docsUrl: "https://developers.openai.com/api/docs/models/compare", checkedAt: "2026-08-16", note: "仅推荐官方当前支持图像输入的 5.6 系列；默认使用稳定旗舰别名 gpt-5.6", pricing: providerPricing("openai"), pricingDocsUrl: providerPricingDocs("openai") },
  xai: { label: "Grok / xAI", baseUrl: "https://api.x.ai/v1", models: ["grok-4.6", "grok-4.6-latest"], multimodal: "native", docsUrl: "https://docs.x.ai/developers/models", checkedAt: "2026-08-16", note: "官方推荐 Grok 4.6 稳定别名；账户快照与内部版本不会抢占默认选择", pricing: providerPricing("xai"), pricingDocsUrl: providerPricingDocs("xai") },
  deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com", models: [], multimodal: "unavailable", docsUrl: "https://api-docs.deepseek.com/updates", checkedAt: "2026-08-16", note: "DeepSeek V4 官方 API 当前是文本模型，不能通过本项目必需的图片能力测试", pricing: providerPricing("deepseek"), pricingDocsUrl: providerPricingDocs("deepseek") },
  kimi: { label: "Kimi / Moonshot（中国站）", baseUrl: "https://api.moonshot.cn/v1", models: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6"], multimodal: "native", docsUrl: "https://platform.kimi.com/docs/guide/use-kimi-vision-model", checkedAt: "2026-08-16", note: "K3 为通用多模态旗舰；K2.7 Code 与 K2.6 同样支持图像/视频输入", pricing: providerPricing("kimi"), pricingDocsUrl: providerPricingDocs("kimi") },
  kimi_intl: { label: "Kimi / Moonshot（国际站）", baseUrl: "https://api.moonshot.ai/v1", models: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6"], multimodal: "native", docsUrl: "https://www.kimi.com/help/kimi-api/api-overview", checkedAt: "2026-08-16", note: "K3 为通用多模态旗舰；国际站 Key 与中国站 Key 不互通", pricing: providerPricing("kimi_intl"), pricingDocsUrl: providerPricingDocs("kimi_intl") },
  mimo: { label: "小米 MiMo", baseUrl: "https://api.xiaomimimo.com/v1", models: ["mimo-v2.5"], multimodal: "native", docsUrl: "https://mimo.mi.com/docs/zh-CN/quick-start/summary/model", checkedAt: "2026-08-16", note: "mimo-v2.5 是原生全模态模型；Pro 是文本/Agent 旗舰，不用于图像测试", pricing: providerPricing("mimo"), pricingDocsUrl: providerPricingDocs("mimo") },
  minimax: { label: "MiniMax", baseUrl: "https://api.minimaxi.com/v1", models: [], multimodal: "unavailable", docsUrl: "https://platform.minimaxi.com/docs/api-reference/api-overview", checkedAt: "2026-08-16", note: "M2.7 官方定位为文本模型；图片理解需额外 MCP，不能作为直连多模态翻译引擎", pricing: providerPricing("minimax"), pricingDocsUrl: providerPricingDocs("minimax") },
  glm: { label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", models: ["glm-5v-turbo", "glm-4.6v", "glm-4.6v-flashx", "glm-4.6v-flash"], multimodal: "native", docsUrl: "https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5v-turbo", checkedAt: "2026-08-16", note: "优先 GLM-5V-Turbo 多模态模型；不再把纯文本旗舰 GLM-5.2 作为图像测试默认项", pricing: providerPricing("glm"), pricingDocsUrl: providerPricingDocs("glm") },
  compatible: { label: "自定义兼容接口", baseUrl: "", models: [], multimodal: "unknown", note: "接口不提供统一能力元数据，必须通过文字与图片实测后才可使用" },
};

const fallbackSearchPresets: Record<string, SearchPreset> = {
  exa: { label: "Exa Search MCP", url: "https://mcp.exa.ai/mcp", keyOptional: true, note: "网页搜索与正文提取；不填 Key 也可使用免费限额" },
  tavily: { label: "Tavily Search MCP", url: "https://mcp.tavily.com/mcp/", keyOptional: false, note: "搜索、正文提取、站点地图与深度研究" },
  builtin: { label: "Agent 内置联网搜索", url: "", keyOptional: true, note: "使用当前 Agent 自带的联网搜索" },
  custom: { label: "自定义远程 MCP", url: "", keyOptional: true, note: "填写兼容 Streamable HTTP 的 MCP 地址" },
};

type ApiCredential = { apiKey: string; baseUrl: string; model: string };
type ApiCredentialStore = { lastProvider?: string; lastModelByProvider: Record<string, string>; credentials: Record<string, ApiCredential> };
type SavedEngineProfile = {
  version: 1;
  mode: EngineMode;
  provider: string;
  model: string;
  baseUrl: string;
  cli: string;
  gpuModel: string;
  reasoning: string;
  proxyEnabled?: boolean;
  proxyUrl: string;
  savedAt: string;
};
type SavedVerification = { version: 1; fingerprint: string; verifiedAt: string; detail: string };
type SavedSearchProfile = { version: 1; provider: string; url: string; hadApiKey: boolean; savedAt: string };
const API_CREDENTIAL_STORE = "precision-subtitle-studio.api-credentials.v1";
const MODEL_CATALOG_STORE = "precision-subtitle-studio.model-catalogs.v2";
const ENGINE_PROFILE_STORE = "precision-subtitle-studio.engine-profile.v1";
const ENGINE_VERIFICATION_STORE = "precision-subtitle-studio.engine-verification.v1";
const SEARCH_PROFILE_STORE = "precision-subtitle-studio.search-profile.v1";
const SEARCH_VERIFICATION_STORE = "precision-subtitle-studio.search-verification.v1";
const ACTIVE_JOB_STORE = "precision-subtitle-studio.active-job.v1";
const LAST_JOB_STORE = "precision-subtitle-studio.last-job.v1";
const TRANSCRIPTION_ENVIRONMENT_STORE = "precision-subtitle-studio.transcription-environment.v1";
const DEFAULT_ENGINE_TEST_MESSAGE = "你好，请用一句话说明你已经连接成功，并告诉我当前模型名称";

function readCredentialStore(storage: Storage): ApiCredentialStore {
  try {
    const parsed = JSON.parse(storage.getItem(API_CREDENTIAL_STORE) || "{}");
    return {
      lastProvider: typeof parsed.lastProvider === "string" ? parsed.lastProvider : undefined,
      lastModelByProvider: parsed.lastModelByProvider && typeof parsed.lastModelByProvider === "object" ? parsed.lastModelByProvider : {},
      credentials: parsed.credentials && typeof parsed.credentials === "object" ? parsed.credentials : {},
    };
  } catch {
    return { lastModelByProvider: {}, credentials: {} };
  }
}

function apiCredentialKey(provider: string, model: string) {
  return `${provider}::${model.trim()}`;
}

function credentialForModel(store: ApiCredentialStore, provider: string, model: string) {
  const exact = store.credentials[apiCredentialKey(provider, model)];
  if (exact) return exact;
  const legacy = store.credentials[provider];
  return legacy?.model === model ? legacy : undefined;
}

function preferredStoredModel(store: ApiCredentialStore, provider: string) {
  return store.lastModelByProvider[provider] || store.credentials[provider]?.model || "";
}

function preferredApiModel(provider: string, value: string | undefined, preset: ApiPreset) {
  if (provider === "openai" && value === "gpt-5.6-sol") return "gpt-5.6";
  if (provider === "xai" && (value === "grok-4.5" || value === "grok-latest" || /^grok-4\.20-.+/i.test(value || ""))) return "grok-4.6";
  if (provider === "mimo" && value === "mimo-v2.5-pro") return "mimo-v2.5";
  if (provider === "glm" && value === "glm-5.2") return "glm-5v-turbo";
  return value || preset.models[0] || "";
}

function modelCatalogKey(provider: string, baseUrl: string, apiKey: string) {
  return `${provider}|${baseUrl.trim().replace(/\/$/, "")}|${credentialSignature(apiKey)}`;
}

function readModelCatalog(storage: Storage, provider: string, baseUrl: string, apiKey: string): ModelCatalogCacheEntry | null {
  try {
    const store = JSON.parse(storage.getItem(MODEL_CATALOG_STORE) || "{}") as Record<string, ModelCatalogCacheEntry>;
    const entry = store[modelCatalogKey(provider, baseUrl, apiKey)];
    return entry?.version === 2 && Array.isArray(entry.recommendedModels) && Array.isArray(entry.allModels) ? entry : null;
  } catch {
    return null;
  }
}

function writeModelCatalog(storage: Storage, provider: string, baseUrl: string, apiKey: string, entry: ModelCatalogCacheEntry) {
  try {
    const store = JSON.parse(storage.getItem(MODEL_CATALOG_STORE) || "{}") as Record<string, ModelCatalogCacheEntry>;
    store[modelCatalogKey(provider, baseUrl, apiKey)] = entry;
    storage.setItem(MODEL_CATALOG_STORE, JSON.stringify(store));
  } catch {
    // A storage restriction should not invalidate a successfully fetched list.
  }
}

function initialApiCredential() {
  if (typeof window === "undefined") return { provider: "openai", apiKey: "", baseUrl: fallbackApiPresets.openai.baseUrl, model: fallbackApiPresets.openai.models[0], remembered: false };
  const temporary = readCredentialStore(window.sessionStorage);
  const persistent = readCredentialStore(window.localStorage);
  const provider = temporary.lastProvider || persistent.lastProvider || "openai";
  const preset = fallbackApiPresets[provider] || fallbackApiPresets.compatible;
  const model = preferredApiModel(provider, preferredStoredModel(temporary, provider) || preferredStoredModel(persistent, provider), preset);
  const restored = credentialForModel(temporary, provider, model) || credentialForModel(persistent, provider, model);
  return { provider, apiKey: restored?.apiKey || "", baseUrl: restored?.baseUrl || preset.baseUrl, model, remembered: Boolean(credentialForModel(persistent, provider, model)?.apiKey) };
}

function engineProfileFingerprint(value: Pick<SavedEngineProfile, "mode" | "provider" | "model" | "baseUrl" | "cli" | "gpuModel" | "reasoning" | "proxyEnabled" | "proxyUrl">) {
  return JSON.stringify({ mode: value.mode, provider: value.provider, model: value.model, baseUrl: value.baseUrl, cli: value.cli, gpuModel: value.gpuModel, reasoning: value.reasoning, proxyEnabled: Boolean(value.proxyEnabled), proxyUrl: value.proxyUrl });
}

function credentialSignature(value: string) {
  const normalized = value.trim();
  if (!normalized) return "none";
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${normalized.length}:${(hash >>> 0).toString(36)}`;
}

function engineVerificationFingerprint(value: Pick<SavedEngineProfile, "mode" | "provider" | "model" | "baseUrl" | "cli" | "gpuModel" | "reasoning" | "proxyEnabled" | "proxyUrl"> & { apiKey: string }) {
  return JSON.stringify({ ...JSON.parse(engineProfileFingerprint(value)), credential: value.mode === "api" ? credentialSignature(value.apiKey) : "local" });
}

function searchVerificationFingerprint(value: { provider: string; url: string; apiKey: string; proxyUrl: string }) {
  return JSON.stringify({ provider: value.provider, url: value.provider === "builtin" ? "" : value.url.trim(), credential: credentialSignature(value.apiKey), proxyUrl: value.proxyUrl.trim() });
}

function readSavedVerification(storage: Storage, key: string): SavedVerification | null {
  try {
    const value = JSON.parse(storage.getItem(key) || "null") as SavedVerification | null;
    return value?.version === 1 && typeof value.fingerprint === "string" ? value : null;
  } catch {
    return null;
  }
}

function rememberVerification(storage: Storage, key: string, fingerprint: string, detail: string) {
  try {
    storage.setItem(key, JSON.stringify({ version: 1, fingerprint, detail, verifiedAt: new Date().toISOString() } satisfies SavedVerification));
    return true;
  } catch {
    return false;
  }
}

function forgetMatchingVerification(storage: Storage, key: string, fingerprint: string) {
  try {
    if (readSavedVerification(storage, key)?.fingerprint === fingerprint) storage.removeItem(key);
  } catch {
    // Storage restrictions must not turn a valid model or search response into a failed test.
  }
}

const cliOptions = [
  { id: "codex", label: "Codex Agent CLI" },
  { id: "claude", label: "Claude Code" },
  { id: "opencode", label: "OpenCode" },
  { id: "pi", label: "Pi coding agent" },
  { id: "cline", label: "Cline CLI" },
];

const transcriptionPresets = {
  faster_whisper: {
    label: "Faster-Whisper（推荐）",
    location: "本地",
    models: ["turbo", "large-v3", "medium", "small", "base", "tiny"],
    note: "速度快、内存更省；首次使用模型时会下载权重",
  },
  openai_whisper: {
    label: "OpenAI Whisper 本地版",
    location: "本地",
    models: ["turbo", "large-v3", "medium", "small", "base", "tiny"],
    note: "官方开源实现；turbo 约需 6 GB 显存，large 约需 10 GB",
  },
  whisper_cpp: {
    label: "whisper.cpp",
    location: "本地",
    models: ["large-v3-turbo", "large-v3", "medium", "small", "base", "tiny"],
    note: "适合 Apple Silicon / CPU，可填写已下载的 GGML 模型路径",
  },
  openai_audio: {
    label: "OpenAI Audio API",
    location: "在线",
    models: ["gpt-4o-transcribe-diarize", "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"],
    note: "Diarize 型号可直接返回说话人分段；其他型号优先原文准确率或速度",
  },
  deepgram: {
    label: "Deepgram API",
    location: "在线",
    models: ["nova-3", "nova-2"],
    note: "Nova-3 支持术语增强；可启用说话人分离和语义分句",
  },
  compatible_audio: {
    label: "自定义音频转写 API",
    location: "在线",
    models: [],
    note: "适合 OpenAI 兼容的 /audio/transcriptions 接口",
  },
} as const;

const transcriptionQualityPresets = {
  fast: { label: "快速预览", hint: "优先速度与低占用；适合先跑一遍定位内容", localModel: "small", onlineModel: "gpt-4o-mini-transcribe", beamSize: 1 },
  balanced: { label: "推荐质量", hint: "准确率、时间与内存的平衡，默认用于普通视频", localModel: "turbo", onlineModel: "gpt-4o-transcribe", beamSize: 5 },
  accurate: { label: "高精听写", hint: "优先原文准确率、词级时间戳和说话人信息", localModel: "large-v3", onlineModel: "gpt-4o-transcribe-diarize", beamSize: 8 },
  maximum: { label: "极致复核", hint: "高质量模型 + 二次复核；最慢且资源消耗最高", localModel: "large-v3", onlineModel: "gpt-4o-transcribe-diarize", beamSize: 12 },
} as const;

const ambiguityReviewPresets: Record<AmbiguityReviewMode, { label: string; hint: string }> = {
  fast: { label: "快速放行", hint: "只深查最关键的少量疑点，其余采用保守译法并留给精修台" },
  pragmatic: { label: "适度放行（推荐）", hint: "只深查可能改变意思的内容；普通口癖、语气词和低影响差异自动放行" },
  strict: { label: "逐项严格复核", hint: "逐项取证实质疑点，关键内容无法确认时允许暂停任务" },
};

const phaseDefinitions = [
  ["acquire", "获取素材", "最高授权画质与音轨"],
  ["research", "背景预习", "角色、称呼与专有名词"],
  ["source_transcript", "原文听写", "词级时间戳与说话人"],
  ["translate", "精准翻译", "语境优先的逐句本地化"],
  ["resolve_ambiguities", "疑点复核", "按影响分级，只深查关键内容"],
  ["subtitle_qc", "字幕质检", "两行、时序与可读性"],
  ["mux", "视频封装", "SRT / ASS / MKV / MP4"],
  ["final_validation", "最终验证", "逐流核验与抽帧检查"],
] as const;

const initialRoles: Role[] = [
  { id: "tomori", name: "高松灯", characterName: "高松灯", performerName: "羊宫妃那", speakingAs: "character", color: "#77BBDD" },
  { id: "anon", name: "千早爱音", characterName: "千早爱音", performerName: "立石凛", speakingAs: "character", color: "#FF8899" },
  { id: "rana", name: "要乐奈", characterName: "要乐奈", performerName: "青木阳菜", speakingAs: "character", color: "#77DD77" },
  { id: "soyo", name: "长崎爽世", characterName: "长崎爽世", performerName: "小日向美香", speakingAs: "character", color: "#FFDD88" },
  { id: "taki", name: "椎名立希", characterName: "椎名立希", performerName: "林鼓子", speakingAs: "character", color: "#7777AA" },
];

const initialCues: Cue[] = [
  {
    id: 1,
    start: 0.8,
    end: 4.4,
    speakerId: "anon",
    source: "それでは、改めて自己紹介からいきましょうか。",
    translation: "那么，我们再从自我介绍开始吧",
    confidence: 0.98,
  },
  {
    id: 2,
    start: 4.7,
    end: 7.2,
    speakerId: "tomori",
    source: "高松燈役の羊宮妃那です。",
    translation: "我是饰演高松灯的羊宫妃那",
    confidence: 0.99,
  },
  {
    id: 3,
    start: 7.55,
    end: 10.6,
    speakerId: "taki",
    source: "椎名立希役の林鼓子です。",
    translation: "我是饰演椎名立希的林鼓子",
    confidence: 0.99,
  },
  {
    id: 4,
    start: 10.95,
    end: 14.85,
    speakerId: "soyo",
    source: "今日は最後まで一緒に楽しんでいきましょう。",
    translation: "今天就让我们一起尽兴到最后吧",
    confidence: 0.96,
  },
  {
    id: 5,
    start: 15.2,
    end: 18.7,
    speakerId: "rana",
    source: "抹茶パフェ、食べたい。",
    translation: "想吃抹茶芭菲",
    confidence: 0.93,
  },
  {
    id: 6,
    start: 19.1,
    end: 23.6,
    speakerId: "anon",
    source: "急に？ でも、埼玉にもおいしいお店ありそう。",
    translation: "这么突然？不过埼玉应该也有好吃的店",
    confidence: 0.84,
    flagged: true,
  },
  {
    id: 7,
    start: 24.1,
    end: 28.8,
    speakerId: "tomori",
    source: "迷子でも、前へ進みたい。",
    translation: "即使迷失方向，也想继续向前",
    confidence: 0.91,
  },
  {
    id: 8,
    start: 29.2,
    end: 33.4,
    speakerId: "taki",
    source: "ほら、次のコーナー始まるよ。",
    translation: "好了，下一个环节要开始了",
    confidence: 0.97,
  },
];

const researchSites = [
  { id: "official", label: "官方站点", hint: "作品官网、角色页、出演者资料" },
  { id: "wikipedia", label: "Wikipedia", hint: "基础人物与作品关系" },
  { id: "fandom", label: "Fandom / 萌娘百科", hint: "称呼、梗与粉丝语境" },
  { id: "video", label: "视频简介与评论", hint: "活动名、章节与现场信息" },
];

function detectSourceKind(source: string) {
  const value = source.trim();
  if (!value) return { label: "等待输入", tone: "neutral" };
  if (/bilibili\.com|b23\.tv/i.test(value))
    return { label: "Bilibili", tone: "pink" };
  if (/youtube\.com|youtu\.be/i.test(value))
    return { label: "YouTube", tone: "red" };
  if (/^https?:\/\//i.test(value))
    return { label: "yt-dlp 链接", tone: "violet" };
  return { label: "本地文件", tone: "green" };
}

function formatTime(value: number, compact = false) {
  if (!Number.isFinite(value)) return "00:00.000";
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const seconds = Math.floor(value % 60);
  const millis = Math.floor((value % 1) * 1000);
  const prefix = hours ? `${String(hours).padStart(2, "0")}:` : "";
  const base = `${prefix}${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return compact ? base : `${base}.${String(millis).padStart(3, "0")}`;
}

function parseTime(value: string) {
  const parts = value.trim().split(":");
  if (!parts.length || parts.some((part) => Number.isNaN(Number(part)))) return null;
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

function normalizeReviewCue(cue: Cue) {
  return {
    ...cue,
    // ASS line breaks are stored as \N while some agents use a literal \n.
    // The editor should always expose real editable line breaks to users.
    translation: String(cue.translation || "").replace(/\\N|\\n/g, "\n"),
  };
}

function normalizeReviewRole(role: Role, index = 0): Role {
  const characterName = String(role.characterName || "").trim();
  const performerName = String(role.performerName || "").trim();
  const rawName = String(role.name || "").trim();
  const speakingAs: SpeakerIdentity = role.speakingAs === "character" || role.speakingAs === "performer"
    ? role.speakingAs
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
  return {
    ...role,
    id: String(role.id || `speaker-${index + 1}`),
    name,
    color: /^#[0-9a-f]{6}$/i.test(String(role.color || "")) ? role.color : "#A78BFA",
    characterName: characterName || undefined,
    performerName: performerName || undefined,
    speakingAs,
  };
}

function speakerIdentityLabel(value?: SpeakerIdentity) {
  if (value === "character") return "角色发言";
  if (value === "performer") return "声优本人";
  return "身份待确认";
}

function statusLabel(status: PhaseStatus) {
  if (status === "done") return "完成";
  if (status === "running") return "处理中";
  if (status === "blocked") return "已阻塞";
  if (status === "skipped") return "已跳过";
  if (status === "error") return "需处理";
  return "等待";
}

function engineTestStageLabel(stage: EngineTestStage) {
  if (stage === "passed") return "已通过";
  if (stage === "failed") return "未通过";
  if (stage === "running") return "检查中";
  return "待检查";
}

function formatElapsed(milliseconds: number | null | undefined) {
  if (!Number.isFinite(milliseconds)) return "—";
  const seconds = Math.max(0, Math.round(Number(milliseconds) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  return hours ? `${hours}时 ${minutes}分` : minutes ? `${minutes}分 ${remaining}秒` : `${remaining}秒`;
}

const emptyTokenUsage = (): TokenUsage => ({ input: 0, cachedInput: 0, output: 0, total: 0, available: false, cacheAvailable: false });

function normalizedTokenUsage(value: unknown): TokenUsage {
  if (!value || typeof value !== "object") return emptyTokenUsage();
  const raw = value as Partial<TokenUsage>;
  const input = Number(raw.input || 0);
  const cachedInput = Number(raw.cachedInput || 0);
  const output = Number(raw.output || 0);
  const total = Number(raw.total || input + output);
  const available = raw.available === true || input > 0 || output > 0 || total > 0;
  return {
    input: Number.isFinite(input) ? Math.max(0, input) : 0,
    cachedInput: Number.isFinite(cachedInput) ? Math.max(0, Math.min(cachedInput, input)) : 0,
    output: Number.isFinite(output) ? Math.max(0, output) : 0,
    total: Number.isFinite(total) ? Math.max(0, total) : 0,
    available,
    cacheAvailable: raw.cacheAvailable === true,
  };
}

function addTokenUsage(...values: unknown[]): TokenUsage {
  return values.map(normalizedTokenUsage).reduce<TokenUsage>((sum, value) => ({
    input: sum.input + value.input,
    cachedInput: sum.cachedInput + value.cachedInput,
    output: sum.output + value.output,
    total: sum.total + value.total,
    available: sum.available || value.available,
    cacheAvailable: sum.cacheAvailable || value.cacheAvailable,
  }), emptyTokenUsage());
}

function formatTokenCount(value: number, available: boolean) {
  return available ? Math.round(value).toLocaleString("zh-CN") : "—";
}

function estimateTokenCost(usage: TokenUsage, rule?: ApiPriceRule) {
  if (!usage.available || !rule) return null;
  const cachedInput = usage.cacheAvailable ? Math.min(usage.cachedInput, usage.input) : 0;
  const uncachedInput = Math.max(0, usage.input - cachedInput);
  const cachedInputRate = rule.cachedInputPerMillion ?? rule.inputPerMillion;
  return (uncachedInput * rule.inputPerMillion + cachedInput * cachedInputRate + usage.output * rule.outputPerMillion) / 1_000_000;
}

function formatEstimatedCost(value: number | null, currency?: ApiPriceRule["currency"]) {
  if (value === null || !currency) return "—";
  const symbol = currency === "CNY" ? "¥" : "$";
  const digits = value > 0 && value < 0.01 ? 4 : 2;
  return `${symbol}${value.toFixed(digits)}`;
}

function formatPriceRate(value: number, currency: ApiPriceRule["currency"]) {
  return `${currency === "CNY" ? "¥" : "$"}${value.toLocaleString("zh-CN", { maximumFractionDigits: 6 })}`;
}

function parseProjectFile(value: unknown): GakuNikuProjectV1 {
  if (!value || typeof value !== "object") throw new Error("项目文件不是有效的 JSON 对象");
  const candidate = value as Partial<GakuNikuProjectV1>;
  if (candidate.format !== PROJECT_FILE_FORMAT) throw new Error("这不是 GakuNiku 项目文件");
  if (candidate.version !== PROJECT_FILE_VERSION) throw new Error(`暂不支持项目文件版本 ${String(candidate.version ?? "未知")}`);
  if (!candidate.prepare || !candidate.review) throw new Error("项目文件缺少准备阶段或精修数据");
  if (!Array.isArray(candidate.prepare.formats) || !Array.isArray(candidate.prepare.research?.keywords)) throw new Error("项目文件的准备阶段数据不完整");
  if (!Array.isArray(candidate.review.roles) || !Array.isArray(candidate.review.cues)) throw new Error("项目文件的字幕数据不完整");
  return candidate as GakuNikuProjectV1;
}

function projectDownloadName(source: string) {
  const raw = source.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "GakuNiku-project";
  const stem = raw.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "GakuNiku-project";
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `${stem}-${stamp}.gakuniku`;
}

function projectSafeUrl(value: string) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/key|token|secret|password|signature|credential|auth/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return raw.includes("@") ? "" : raw;
  }
}

export function SubtitleStudio() {
  const initialCredential = useMemo(() => initialApiCredential(), []);
  const [workspace, setWorkspace] = useState<Workspace>("prepare");
  const [studioMode, setStudioMode] = useState<StudioMode>("easy");
  const [cameraFocus, setCameraFocus] = useState<PrepareStage>("engine");
  const [source, setSource] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [outputPath, setOutputPath] = useState("~/Movies/Precision Subtitles");
  const [formats, setFormats] = useState(["ass", "srt", "mkv"]);
  const [transcriptionMode, setTranscriptionMode] = useState<TranscriptionMode>("local");
  const [transcriptionProvider, setTranscriptionProvider] = useState<keyof typeof transcriptionPresets>("faster_whisper");
  const [transcriptionQuality, setTranscriptionQuality] = useState<keyof typeof transcriptionQualityPresets>("balanced");
  const [transcriptionModel, setTranscriptionModel] = useState("turbo");
  const [transcriptionApiKey, setTranscriptionApiKey] = useState("");
  const [transcriptionBaseUrl, setTranscriptionBaseUrl] = useState("https://api.openai.com/v1");
  const [transcriptionLanguage, setTranscriptionLanguage] = useState("ja");
  const [transcriptionDiarization, setTranscriptionDiarization] = useState(false);
  const [transcriptionDiarizationEngine, setTranscriptionDiarizationEngine] = useState<DiarizationEngine>("sherpa_onnx");
  const [transcriptionHfToken, setTranscriptionHfToken] = useState("");
  const [transcriptionWordTimestamps, setTranscriptionWordTimestamps] = useState(true);
  const [transcriptionEnvironment, setTranscriptionEnvironment] = useState<TranscriptionEnvironment | null>(null);
  const [transcriptionCheckBusy, setTranscriptionCheckBusy] = useState(false);
  const [transcriptionCheckError, setTranscriptionCheckError] = useState("");
  const [transcriptionInstallOpen, setTranscriptionInstallOpen] = useState(false);
  const [transcriptionInstallRuntime, setTranscriptionInstallRuntime] = useState(true);
  const [transcriptionInstallModel, setTranscriptionInstallModel] = useState(true);
  const [transcriptionInstallMediaTools, setTranscriptionInstallMediaTools] = useState(true);
  const [transcriptionInstallDiarization, setTranscriptionInstallDiarization] = useState(false);
  const [transcriptionInstallConfirmed, setTranscriptionInstallConfirmed] = useState(false);
  const [transcriptionInstallBusy, setTranscriptionInstallBusy] = useState(false);
  const [transcriptionInstallStage, setTranscriptionInstallStage] = useState("");
  const [transcriptionInstallProgress, setTranscriptionInstallProgress] = useState(0);
  const [transcriptionInstallEvents, setTranscriptionInstallEvents] = useState<TranscriptionInstallEvent[]>([]);
  const [transcriptionDiagnosisBusy, setTranscriptionDiagnosisBusy] = useState(false);
  const [transcriptionDiagnosis, setTranscriptionDiagnosis] = useState("");
  const [transcriptionTestStage, setTranscriptionTestStage] = useState<EngineTestStage>("idle");
  const [transcriptionTestDetail, setTranscriptionTestDetail] = useState("尚未测试（可选，不影响后续）");
  const [transcriptionTestResult, setTranscriptionTestResult] = useState<TranscriptionTestResult | null>(null);
  const [transcriptionUploadConfirmed, setTranscriptionUploadConfirmed] = useState(false);
  const [transcriptionEnvironmentRoot, setTranscriptionEnvironmentRoot] = useState("");
  const [transcriptionEnvironmentSaved, setTranscriptionEnvironmentSaved] = useState(false);
  const [engineMode, setEngineMode] = useState<EngineMode>("api");
  const [provider, setProvider] = useState(initialCredential.provider);
  const [model, setModel] = useState(initialCredential.model);
  const [apiKey, setApiKey] = useState(initialCredential.apiKey);
  const [baseUrl, setBaseUrl] = useState(initialCredential.baseUrl);
  const [cli, setCli] = useState("codex");
  const [gpuModel, setGpuModel] = useState("deepseek-r1:14b");
  const [reasoning, setReasoning] = useState("medium");
  const [engineRevision, setEngineRevision] = useState(0);
  const [verifiedEngine, setVerifiedEngine] = useState("");
  const [engineVerificationRestored, setEngineVerificationRestored] = useState(false);
  const [keywords, setKeywords] = useState(["BanG Dream!", "MyGO!!!!!", "迷子集会"]);
  const [keywordDraft, setKeywordDraft] = useState("");
  const [selectedSites, setSelectedSites] = useState(["official", "wikipedia", "fandom", "video"]);
  const [customSites, setCustomSites] = useState("");
  const [bridgeStatus, setBridgeStatus] = useState<"checking" | "online" | "offline">("checking");
  const [capabilities, setCapabilities] = useState<Record<string, Capability>>({});
  const [apiPresets, setApiPresets] = useState<Record<string, ApiPreset>>(fallbackApiPresets);
  const [searchPresets, setSearchPresets] = useState<Record<string, SearchPreset>>(fallbackSearchPresets);
  const [searchProvider, setSearchProvider] = useState("exa");
  const [searchMcpUrl, setSearchMcpUrl] = useState(fallbackSearchPresets.exa.url);
  const [searchApiKey, setSearchApiKey] = useState("");
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyUrl, setProxyUrl] = useState("");
  const [proxySuggestion, setProxySuggestion] = useState<ProxySuggestion | null>(null);
  const [proxyDefaultApplied, setProxyDefaultApplied] = useState(false);
  const [savedProxyPreference, setSavedProxyPreference] = useState(false);
  const [searchTest, setSearchTest] = useState<EngineTestResult>({ stage: "idle", detail: "尚未测试" });
  const [searchProfileLoaded, setSearchProfileLoaded] = useState(false);
  const [rememberApiKey, setRememberApiKey] = useState(initialCredential.remembered);
  const [engineProfileLoaded, setEngineProfileLoaded] = useState(false);
  const [savedEngineFingerprint, setSavedEngineFingerprint] = useState("");
  const [engineProfileSavedAt, setEngineProfileSavedAt] = useState("");
  const [engineProfileMessage, setEngineProfileMessage] = useState("");
  const [easyModeActive, setEasyModeActive] = useState(false);
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [accountModels, setAccountModels] = useState<string[]>([]);
  const [discoveredModelPricing, setDiscoveredModelPricing] = useState<Record<string, ApiPriceRule>>({});
  const [modelSyncBusy, setModelSyncBusy] = useState(false);
  const [modelSyncMessage, setModelSyncMessage] = useState("");
  const [modelCatalogWarning, setModelCatalogWarning] = useState("");
  const [showAllAccountModels, setShowAllAccountModels] = useState(false);
  const [modelSelectionTouched, setModelSelectionTouched] = useState(false);
  const [researchPreview, setResearchPreview] = useState("");
  const [researchBusy, setResearchBusy] = useState(false);
  const [researchStage, setResearchStage] = useState("等待开始检索");
  const [researchEvents, setResearchEvents] = useState<ResearchTraceEvent[]>([]);
  const [researchOpen, setResearchOpen] = useState(false);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [knowledgeEntries, setKnowledgeEntries] = useState<KnowledgeEntry[]>([]);
  const [knowledgeIds, setKnowledgeIds] = useState<string[]>([]);
  const [knowledgeTitle, setKnowledgeTitle] = useState("");
  const [harnessOpen, setHarnessOpen] = useState(false);
  const [harnessText, setHarnessText] = useState("");
  const [harnessOriginal, setHarnessOriginal] = useState("");
  const [deliveryConstraints, setDeliveryConstraints] = useState(DEFAULT_DELIVERY_CONSTRAINTS);
  const [confirmedDeliveryConstraints, setConfirmedDeliveryConstraints] = useState(DEFAULT_DELIVERY_CONSTRAINTS);
  const [ambiguityReviewMode, setAmbiguityReviewMode] = useState<AmbiguityReviewMode>("pragmatic");
  const [testOpen, setTestOpen] = useState(false);
  const [testMessage, setTestMessage] = useState(DEFAULT_ENGINE_TEST_MESSAGE);
  const [testMessages, setTestMessages] = useState<Array<{ role: "user" | "assistant"; content: string }>>([]);
  const [testBusy, setTestBusy] = useState(false);
  const [cliInstallTest, setCliInstallTest] = useState<EngineTestResult>({ stage: "idle", detail: "等待检查 CLI" });
  const [cliAuthTest, setCliAuthTest] = useState<EngineTestResult>({ stage: "idle", detail: "等待检查登录" });
  const [cliNetworkTest, setCliNetworkTest] = useState<EngineTestResult>({ stage: "idle", detail: "等待检查上游网络" });
  const [textTest, setTextTest] = useState<EngineTestResult>({ stage: "idle", detail: "等待测试" });
  const [imageTest, setImageTest] = useState<EngineTestResult>({ stage: "idle", detail: "文字通过后自动测试" });
  const [engineTestProxySuspected, setEngineTestProxySuspected] = useState(false);
  const [sessionTokenUsage, setSessionTokenUsage] = useState<TokenUsage>(emptyTokenUsage);
  const [jobTokenUsage, setJobTokenUsage] = useState<TokenUsage>(emptyTokenUsage);
  const [showTrace, setShowTrace] = useState(true);
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const [phaseStates, setPhaseStates] = useState<Record<string, PhaseStatus>>(
    Object.fromEntries(phaseDefinitions.map(([id]) => [id, "pending"])),
  );
  const [phaseDetails, setPhaseDetails] = useState<Record<string, PhaseDetail>>({});
  const [selectedPhaseId, setSelectedPhaseId] = useState<string>("");
  const [manifestLimitations, setManifestLimitations] = useState<string[]>([]);
  const [manifestNotices, setManifestNotices] = useState<string[]>([]);
  const [jobDiagnostics, setJobDiagnostics] = useState<{ stderr: string[]; logPath: string } | null>(null);
  const [jobResources, setJobResources] = useState<JobResources | null>(null);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [terminateBusy, setTerminateBusy] = useState(false);
  const [terminateConfirmOpen, setTerminateConfirmOpen] = useState(false);
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [historyJobs, setHistoryJobs] = useState<HistoricalJob[]>([]);
  const [historyJobBusy, setHistoryJobBusy] = useState(false);
  const [historyJobError, setHistoryJobError] = useState("");
  const [externalConsentChecked, setExternalConsentChecked] = useState(false);
  const [activeJobConsentFingerprint, setActiveJobConsentFingerprint] = useState("");
  const [jobRunStatus, setJobRunStatus] = useState<JobRunStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [jobId, setJobId] = useState("");
  const [runMessage, setRunMessage] = useState("准备就绪");
  const [runError, setRunError] = useState("");
  const [jobBlocker, setJobBlocker] = useState<JobBlocker | null>(null);
  const [jobPollRevision, setJobPollRevision] = useState(0);
  const [jobConnectionFailures, setJobConnectionFailures] = useState(0);
  const [roles, setRoles] = useState(initialRoles);
  const [cues, setCues] = useState(initialCues);
  const [selectedCueId, setSelectedCueId] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [timelineZoom, setTimelineZoom] = useState(56);
  const [timelineTool, setTimelineTool] = useState<TimelineTool>("select");
  const [timelinePanning, setTimelinePanning] = useState(false);
  const [inspectorWidth, setInspectorWidth] = useState(305);
  const [previewWorkspaceHeight, setPreviewWorkspaceHeight] = useState(470);
  const [timelineHeight, setTimelineHeight] = useState(188);
  const [sentenceEditorWidth, setSentenceEditorWidth] = useState(345);
  const [search, setSearch] = useState("");
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [fontFamily, setFontFamily] = useState("Noto Sans CJK SC");
  const [fontSize, setFontSize] = useState(42);
  const [fontWeight, setFontWeight] = useState(700);
  const [outline, setOutline] = useState(3);
  const [glow, setGlow] = useState(8);
  const [shadow, setShadow] = useState(3);
  const [saved, setSaved] = useState(true);
  const [projectNotice, setProjectNotice] = useState("");
  const [projectFileName, setProjectFileName] = useState("");
  const [reviewHistory, setReviewHistory] = useState<ReviewHistory>({ past: [], future: [] });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineScrollerRef = useRef<HTMLDivElement>(null);
  const timelineScrubPointerRef = useRef<number | null>(null);
  const timelinePanRef = useRef<TimelinePanState | null>(null);
  const cueDragRef = useRef<CueDragState | null>(null);
  const reviewResizeRef = useRef<ReviewResizeState | null>(null);
  const suppressCueClickRef = useRef(false);
  const lastReviewEditRef = useRef<{ key: string; at: number } | null>(null);
  const reviewHistoryActionRef = useRef({ undo: () => undefined, redo: () => undefined });
  const workflowStepRefs = useRef<Record<PrepareStage, HTMLElement | null>>({ engine: null, source: null, research: null, harness: null });
  const completedJobHydratedRef = useRef("");
  const completedJobAutoOpenedRef = useRef("");

  const sourceKind = detectSourceKind(source);
  const selectedCue = cues.find((cue) => cue.id === selectedCueId) ?? cues[0];
  const visibleCue = cues.find((cue) => currentTime >= cue.start && currentTime < cue.end);
  const visibleRole = visibleCue ? roles.find((role) => role.id === visibleCue.speakerId) : undefined;
  const timelineDuration = Math.max(35, ...cues.map((cue) => cue.end));
  const timelinePixelsPerSecond = timelineZoom * 0.72;
  const timelineCanvasWidth = Math.max(720, Math.ceil(timelineDuration * timelinePixelsPerSecond));
  const rulerInterval = timelineZoom >= 150 ? 1 : timelineZoom >= 76 ? 5 : timelineZoom >= 40 ? 10 : 20;
  const rulerMarks = Array.from(
    { length: Math.floor(timelineDuration / rulerInterval) + 1 },
    (_, index) => index * rulerInterval,
  );
  const effectiveProxyUrl = proxyEnabled ? proxyUrl.trim() : "";
  const reusableEngineFingerprint = engineVerificationFingerprint({ mode: engineMode, provider, model, baseUrl, cli, gpuModel, reasoning, proxyEnabled, proxyUrl: proxyUrl.trim(), apiKey });
  const reusableSearchFingerprint = searchVerificationFingerprint({ provider: searchProvider, url: searchMcpUrl, apiKey: searchApiKey, proxyUrl: effectiveProxyUrl });
  const engineFingerprint = JSON.stringify({ reusableEngineFingerprint, engineRevision });
  const engineSettingsFingerprint = engineProfileFingerprint({ mode: engineMode, provider, model, baseUrl, cli, gpuModel, reasoning, proxyEnabled, proxyUrl: proxyUrl.trim() });
  const engineProfileDirty = Boolean(savedEngineFingerprint && savedEngineFingerprint !== engineSettingsFingerprint);
  const engineVerified = verifiedEngine === engineFingerprint;
  const activeEngineLabel = engineMode === "api"
    ? `${apiPresets[provider]?.label || provider} / ${model || "未选模型"}`
    : engineMode === "gpu"
      ? `Ollama / ${gpuModel || "未选模型"}`
      : cliOptions.find((option) => option.id === cli)?.label || cli;
  const currentExternalProcessingPlan = externalProcessingPlan({
    engineMode,
    provider,
    model,
    baseUrl,
    transcriptionMode,
    transcriptionProvider,
    transcriptionModel,
    transcriptionBaseUrl,
  });
  const videoReady = Boolean(source.trim() && outputPath.trim() && formats.length);
  const transcriptionReadyForCamera = Boolean(transcriptionEnvironment?.ready);
  const transcriptionRequestedReady = Boolean(transcriptionEnvironment && (transcriptionEnvironment.requestedReady ?? transcriptionEnvironment.ready));
  const transcriptionRuntimeReady = transcriptionEnvironment?.components.find((item) => item.id === "runtime")?.status === "ready";
  const transcriptionModelReady = transcriptionEnvironment?.components.find((item) => item.id === "model")?.status === "ready";
  const transcriptionMediaToolsReady = transcriptionEnvironment?.components.find((item) => item.id === "media-tools")?.status === "ready";
  const transcriptionDiarizationReady = transcriptionEnvironment?.components.find((item) => item.id === "diarization")?.status === "ready";
  const transcriptionEnvironmentIssueCount = transcriptionEnvironment?.components.filter((item) => item.status === "missing" || item.status === "degraded").length || 0;
  const transcriptionDiarizationNeedsSetup = Boolean(transcriptionEnvironment?.baseReady && transcriptionDiarization && !transcriptionDiarizationReady);
  const transcriptionNeedsEnvironmentSetup = Boolean(transcriptionEnvironment && (!transcriptionRuntimeReady || !transcriptionModelReady || !transcriptionMediaToolsReady || transcriptionDiarizationNeedsSetup));
  const transcriptionHasInstallSelection = transcriptionInstallRuntime || transcriptionInstallModel || transcriptionInstallMediaTools || transcriptionInstallDiarization;
  const transcriptionInstallSelectionSupported = Boolean(
    (!transcriptionInstallRuntime && !transcriptionInstallModel || transcriptionEnvironment?.installationCapabilities?.base !== false)
    && (!transcriptionInstallMediaTools || transcriptionEnvironment?.installationCapabilities?.mediaTools !== false)
    && (!transcriptionInstallDiarization || transcriptionEnvironment?.installationCapabilities?.diarization !== false),
  );
  const researchReady = Boolean(researchPreview.trim());
  const harnessReady = Boolean(harnessText.trim());
  const currentPrepareStage: PrepareStage = !engineVerified
    ? "engine"
    : !videoReady || !transcriptionReadyForCamera
      ? "source"
      : !researchReady
        ? "research"
        : "harness";
  const displayedTokenUsage = addTokenUsage(sessionTokenUsage, jobTokenUsage);
  const activePriceRule = engineMode === "api" ? discoveredModelPricing[model] || apiPresets[provider]?.pricing?.[model] : undefined;
  const estimatedTokenCost = estimateTokenCost(displayedTokenUsage, activePriceRule);
  const estimatedTokenCostLabel = engineMode === "api"
    ? activePriceRule
      ? formatEstimatedCost(estimatedTokenCost, activePriceRule.currency)
      : "暂不可估算"
    : "本地执行";
  const tokenUsageDetails = displayedTokenUsage.available
    ? `输入 ${formatTokenCount(displayedTokenUsage.input, true)} Token · 输出 ${formatTokenCount(displayedTokenUsage.output, true)} Token · 缓存命中 ${displayedTokenUsage.cacheAvailable ? formatTokenCount(displayedTokenUsage.cachedInput, true) : "未提供"} Token · 合计 ${formatTokenCount(displayedTokenUsage.total, true)} Token · 估算费用 ${estimatedTokenCostLabel} · ${activeEngineLabel}`
    : `本次尚无 Token 明细 · ${activeEngineLabel}`;
  const harnessLines = harnessText ? harnessText.split("\n").length : 0;
  const harnessChanged = harnessText !== harnessOriginal;
  const canTestEngine = bridgeStatus === "online"
    && (engineMode === "api" ? Boolean(apiKey.trim() && model.trim() && (baseUrl.trim() || apiPresets[provider]?.baseUrl)) : engineMode === "gpu" ? Boolean(gpuModel.trim() && capabilities.ollama?.available) : Boolean(capabilities[cli]?.available));
  const recommendedModelOptions = discoveredModels.length ? discoveredModels : apiPresets[provider]?.models ?? [];
  const availableModelOptions = [...new Set([model, ...discoveredModels, ...(apiPresets[provider]?.models ?? []), ...(showAllAccountModels ? accountModels : [])].filter(Boolean))];
  const transcriptionPreset = transcriptionPresets[transcriptionProvider];
  const transcriptionModelOptions = transcriptionPreset.models as readonly string[];
  const transcriptionQualityPreset = transcriptionQualityPresets[transcriptionQuality];
  const canTestTranscriptionSample = sourceKind.label === "本地文件";
  const filteredCues = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return cues.filter((cue) => {
      if (onlyFlagged && !cue.flagged) return false;
      if (!needle) return true;
      const speaker = roles.find((role) => role.id === cue.speakerId)?.name ?? "";
      return `${speaker} ${cue.source} ${cue.translation}`.toLowerCase().includes(needle);
    });
  }, [cues, onlyFlagged, roles, search]);

  useEffect(() => {
    let active = true;
    async function probeBridge() {
      try {
        const response = await fetch(`${BRIDGE_URL}/api/capabilities`);
        if (!response.ok) throw new Error("bridge unavailable");
        const data = await response.json();
        if (!active) return;
        setCapabilities(data.tools ?? {});
        setApiPresets(data.apiPresets ?? fallbackApiPresets);
        setSearchPresets(data.searchPresets ?? fallbackSearchPresets);
        setProxySuggestion(data.proxySuggestion ?? null);
        setTranscriptionEnvironmentRoot((current) => {
          if (current) return current;
          const saved = window.localStorage.getItem(TRANSCRIPTION_ENVIRONMENT_STORE) || "";
          setTranscriptionEnvironmentSaved(Boolean(saved));
          return saved || data.bridge?.defaultTranscriptionEnvironment || "";
        });
        setBridgeStatus("online");
      } catch {
        if (active) setBridgeStatus("offline");
      }
    }
    void probeBridge();
    const timer = window.setInterval(probeBridge, 8000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(ACTIVE_JOB_STORE) || "null") as { id?: string; source?: string; savedAt?: string } | null;
      if (saved?.id && /^[a-f0-9-]{36}$/i.test(saved.id)) {
        setJobId(saved.id);
        if (saved.source) setSource((current) => current || saved.source || "");
        setWorkspace("running");
        setRunMessage("正在恢复上次任务状态…");
        return;
      }
      const last = JSON.parse(window.localStorage.getItem(LAST_JOB_STORE) || "null") as { id?: string; source?: string; savedAt?: string } | null;
      if (last?.id && /^[a-f0-9-]{36}$/i.test(last.id)) {
        setJobId(last.id);
        if (last.source) setSource((current) => current || last.source || "");
        setRunMessage("可查看最近一次翻译记录");
      }
    } catch {
      window.localStorage.removeItem(ACTIVE_JOB_STORE);
      window.localStorage.removeItem(LAST_JOB_STORE);
    }
  }, []);

  useEffect(() => {
    if (!jobId) return;
    window.localStorage.setItem(ACTIVE_JOB_STORE, JSON.stringify({ id: jobId, source, savedAt: new Date().toISOString() }));
  }, [jobId, source]);

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(ENGINE_PROFILE_STORE) || "null") as SavedEngineProfile | null;
      if (saved?.version === 1 && ["api", "cli", "gpu"].includes(saved.mode)) {
        const temporary = readCredentialStore(window.sessionStorage);
        const persistent = readCredentialStore(window.localStorage);
        const credential = credentialForModel(temporary, saved.provider, saved.model) || credentialForModel(persistent, saved.provider, saved.model);
        setEngineMode(saved.mode);
        setStudioMode(saved.mode === "api" ? "easy" : "advanced");
        setProvider(saved.provider || "openai");
        const restoredPreset = fallbackApiPresets[saved.provider] || fallbackApiPresets.compatible;
        setModel(preferredApiModel(saved.provider, saved.model, restoredPreset));
        setBaseUrl(saved.baseUrl || fallbackApiPresets[saved.provider]?.baseUrl || "");
        setCli(saved.cli || "codex");
        setGpuModel(saved.gpuModel || "deepseek-r1:14b");
        setReasoning(saved.reasoning || "medium");
        setSavedProxyPreference(typeof saved.proxyEnabled === "boolean" || Boolean(saved.proxyUrl));
        setProxyEnabled(saved.proxyEnabled ?? Boolean(saved.proxyUrl));
        setProxyUrl(saved.proxyUrl || "");
        setApiKey(credential?.apiKey || "");
        setRememberApiKey(Boolean(credentialForModel(persistent, saved.provider, saved.model)?.apiKey));
        setSavedEngineFingerprint(engineProfileFingerprint(saved));
        setEngineProfileSavedAt(saved.savedAt || "");
        setEngineProfileMessage("已自动恢复上次保存的模型设置");
      }
    } catch {
      window.localStorage.removeItem(ENGINE_PROFILE_STORE);
      setEngineProfileMessage("本地模型设置无法读取，已忽略损坏记录");
    } finally {
      setEngineProfileLoaded(true);
    }
  }, []);

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(SEARCH_PROFILE_STORE) || "null") as SavedSearchProfile | null;
      if (saved?.version === 1 && fallbackSearchPresets[saved.provider]) {
        setSearchProvider(saved.provider);
        setSearchMcpUrl(saved.url || fallbackSearchPresets[saved.provider]?.url || "");
        if (saved.hadApiKey) setSearchTest({ stage: "idle", detail: "已恢复上次搜索配置；请重新填写搜索 API Key" });
      }
    } catch {
      window.localStorage.removeItem(SEARCH_PROFILE_STORE);
      window.localStorage.removeItem(SEARCH_VERIFICATION_STORE);
    } finally {
      setSearchProfileLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!engineProfileLoaded) return;
    const saved = readSavedVerification(window.localStorage, ENGINE_VERIFICATION_STORE);
    if (saved?.fingerprint !== reusableEngineFingerprint) return;
    setVerifiedEngine(engineFingerprint);
    setEngineVerificationRestored(true);
    setTextTest({ stage: "passed", detail: "已沿用上次文字能力验证" });
    setImageTest({ stage: "passed", detail: "已沿用上次图片理解与 OCR 验证" });
  }, [engineFingerprint, engineProfileLoaded, reusableEngineFingerprint]);

  useEffect(() => {
    if (!searchProfileLoaded) return;
    const saved = readSavedVerification(window.localStorage, SEARCH_VERIFICATION_STORE);
    if (saved?.fingerprint !== reusableSearchFingerprint) return;
    setSearchTest({ stage: "passed", detail: `已沿用上次连通验证 · ${saved.detail}` });
  }, [reusableSearchFingerprint, searchProfileLoaded]);

  useEffect(() => {
    if (!engineProfileLoaded || proxyDefaultApplied || !proxySuggestion) return;
    setProxyDefaultApplied(true);
    if ((savedEngineFingerprint && savedProxyPreference) || !proxySuggestion.detected) return;
    setProxyUrl(proxySuggestion.url);
    setProxyEnabled(proxySuggestion.enabled);
  }, [engineProfileLoaded, proxyDefaultApplied, proxySuggestion, savedEngineFingerprint, savedProxyPreference]);

  useEffect(() => {
    const credential = { apiKey, baseUrl, model };
    if (!engineProfileLoaded) return;
    const key = apiCredentialKey(provider, model);
    const temporary = readCredentialStore(window.sessionStorage);
    temporary.lastProvider = provider;
    temporary.lastModelByProvider[provider] = model;
    if (apiKey.trim()) temporary.credentials[key] = credential;
    else delete temporary.credentials[key];
    window.sessionStorage.setItem(API_CREDENTIAL_STORE, JSON.stringify(temporary));

    const persistent = readCredentialStore(window.localStorage);
    persistent.lastProvider = provider;
    persistent.lastModelByProvider[provider] = model;
    if (rememberApiKey && apiKey.trim()) persistent.credentials[key] = credential;
    else delete persistent.credentials[key];
    window.localStorage.setItem(API_CREDENTIAL_STORE, JSON.stringify(persistent));
  }, [apiKey, baseUrl, engineProfileLoaded, model, provider, rememberApiKey]);

  useEffect(() => {
    if (!engineProfileLoaded || engineMode !== "api" || !apiKey.trim() || !baseUrl.trim()) {
      setDiscoveredModels([]);
      setAccountModels([]);
      setDiscoveredModelPricing({});
      setModelCatalogWarning("");
      return;
    }
    const cached = readModelCatalog(window.localStorage, provider, baseUrl, apiKey);
    if (!cached) {
      setDiscoveredModels([]);
      setAccountModels([]);
      setDiscoveredModelPricing({});
      setModelCatalogWarning("");
      return;
    }
    setDiscoveredModels(cached.recommendedModels);
    setAccountModels(cached.allModels);
    setDiscoveredModelPricing(cached.pricing || {});
    setModelCatalogWarning(cached.warning || "");
    if (!modelSelectionTouched && cached.recommendedModels[0]) setModel(cached.recommendedModels[0]);
    setModelSyncMessage(`已载入本机缓存 · 推荐 ${cached.recommendedModels.length} 个多模态模型 · 账户共 ${cached.allModels.length} 个`);
  }, [apiKey, baseUrl, engineMode, engineProfileLoaded, modelSelectionTouched, provider]);

  useEffect(() => {
    if (bridgeStatus !== "online") return;
    void Promise.all([
      fetch(`${BRIDGE_URL}/api/knowledge`).then((response) => response.json()),
      fetch(`${BRIDGE_URL}/api/harness`).then((response) => response.json()),
    ]).then(([knowledge, harness]) => {
      setKnowledgeEntries(knowledge.entries ?? []);
      setHarnessOriginal(harness.text ?? "");
      setHarnessText((current) => current || harness.text || "");
    }).catch(() => undefined);
  }, [bridgeStatus]);

  useEffect(() => {
    if (!easyModeActive || !harnessOriginal) return;
    setHarnessText(harnessOriginal);
  }, [easyModeActive, harnessOriginal]);

  useEffect(() => {
    setExternalConsentChecked(false);
  }, [currentExternalProcessingPlan.fingerprint]);

  useEffect(() => {
    if (workspace === "prepare") setCameraFocus(currentPrepareStage);
  }, [currentPrepareStage, workspace]);

  useEffect(() => {
    if (workspace !== "review") return;
    function handleReviewHistoryShortcut(event: KeyboardEvent) {
      if (event.altKey || (!event.metaKey && !event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      const wantsUndo = key === "z" && !event.shiftKey;
      const wantsRedo = (key === "z" && event.shiftKey) || (key === "y" && event.ctrlKey && !event.metaKey);
      if (!wantsUndo && !wantsRedo) return;
      event.preventDefault();
      if (wantsRedo) reviewHistoryActionRef.current.redo();
      else reviewHistoryActionRef.current.undo();
    }
    window.addEventListener("keydown", handleReviewHistoryShortcut);
    return () => window.removeEventListener("keydown", handleReviewHistoryShortcut);
  }, [workspace]);

  useEffect(() => {
    if (!jobId || workspace !== "running") return;
    let active = true;
    let timer = 0;
    let failures = 0;
    async function pollJob() {
      try {
        const response = await fetch(`${BRIDGE_URL}/api/jobs/${jobId}`);
        if (!response.ok) throw new Error("无法读取任务状态");
        const data = await response.json();
        if (!active) return;
        failures = 0;
        setJobConnectionFailures(0);
        if (["running", "blocked", "failed", "cancelled", "completed"].includes(data.status)) setJobRunStatus(data.status as JobRunStatus);
        setProgress(data.progress ?? 0);
        setRunMessage(data.message ?? "处理中");
        if (data.phases) setPhaseStates(data.phases);
        if (data.phaseDetails) setPhaseDetails(data.phaseDetails);
        if (["fast", "pragmatic", "strict"].includes(data.reviewPolicy?.ambiguities)) setAmbiguityReviewMode(data.reviewPolicy.ambiguities as AmbiguityReviewMode);
        setActiveJobConsentFingerprint(data.externalProcessingConsent?.granted ? String(data.externalProcessingConsent.fingerprint || "") : "");
        if (data.resources) setJobResources(data.resources);
        setJobTokenUsage(normalizedTokenUsage(data.tokenUsage));
        setManifestLimitations(Array.isArray(data.manifest?.limitations) ? data.manifest.limitations.map(String) : []);
        setManifestNotices(Array.isArray(data.manifest?.notices) ? data.manifest.notices.map(String) : []);
        setJobDiagnostics(data.diagnostics || null);
        if (Array.isArray(data.trace)) setTrace(data.trace);
        if (data.status === "completed") {
          setProgress(100);
          const hasReviewCues = Array.isArray(data.review?.cues) && data.review.cues.length > 0;
          if (completedJobHydratedRef.current !== jobId) {
            resetReviewHistory();
            if (Array.isArray(data.review?.roles) && data.review.roles.length) setRoles(data.review.roles.map((role: Role, index: number) => normalizeReviewRole(role, index)));
            if (hasReviewCues) {
              setCues(data.review.cues.map((cue: Cue) => normalizeReviewCue(cue)));
              setSelectedCueId(data.review.cues[0].id);
            }
            if (data.mediaUrl) setPreviewUrl(`${BRIDGE_URL}${data.mediaUrl}`);
            completedJobHydratedRef.current = jobId;
          }
          window.localStorage.setItem(LAST_JOB_STORE, JSON.stringify({ id: jobId, source, savedAt: new Date().toISOString() }));
          if (hasReviewCues && completedJobAutoOpenedRef.current !== jobId) {
            completedJobAutoOpenedRef.current = jobId;
            setWorkspace("review");
          } else if (!hasReviewCues) setRunError("Agent 已结束，但没有生成可精修的真实字幕数据；不会载入示例字幕。请查看执行轨迹定位中断阶段。 ");
          window.localStorage.removeItem(ACTIVE_JOB_STORE);
          return;
        }
        if (data.status === "blocked") {
          setJobBlocker(data.blocker || null);
          setRunError(data.error ?? "任务已阻塞，请处理下方原因后重试。 ");
          return;
        }
        if (data.status === "failed") {
          setRunError(data.error ?? "任务执行失败，请查看本地日志。 ");
          return;
        }
        if (data.status === "cancelled") {
          returnHomeAfterTermination(data.message ?? "任务已终止，已有成果已保留，可从历史任务中重新打开");
          return;
        }
        timer = window.setTimeout(pollJob, 1500);
      } catch (error) {
        if (!active) return;
        failures += 1;
        setJobConnectionFailures(failures);
        setRunMessage(`本地服务暂时未响应，正在第 ${failures} 次重连…`);
        setRunError(`${error instanceof Error ? error.message : "本地桥连接中断"}。任务不会因此判定失败，页面将在 ${Math.min(8, failures + 1)} 秒后自动重试。`);
        timer = window.setTimeout(pollJob, Math.min(8000, (failures + 1) * 1000));
      }
    }
    void pollJob();
    return () => { active = false; window.clearTimeout(timer); };
  }, [jobId, jobPollRevision, workspace]);

  useEffect(() => {
    return () => {
      if (previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(file));
    setSource(file.name);
    setResearchPreview("");
    setTranscriptionTestStage("idle");
    setTranscriptionTestDetail("视频已变化；可按需测试真实音频");
    setTranscriptionTestResult(null);
  }

  async function chooseLocalFile() {
    if (bridgeStatus === "online") {
      try {
        const response = await fetch(`${BRIDGE_URL}/api/pick-file`, { method: "POST" });
        const data = await response.json();
        if (data.cancelled) return;
        if (response.ok && data.path) {
          if (previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
          setSource(data.path);
          setResearchPreview("");
          setTranscriptionTestStage("idle");
          setTranscriptionTestDetail("视频已变化；可按需测试真实音频");
          setTranscriptionTestResult(null);
          if (data.previewUrl) setPreviewUrl(`${BRIDGE_URL}${data.previewUrl}`);
          return;
        }
      } catch {
        // Fall back to the browser file control.
      }
    }
    fileInputRef.current?.click();
  }

  function toggleFormat(format: string) {
    setFormats((current) =>
      current.includes(format) ? current.filter((item) => item !== format) : [...current, format],
    );
  }

  function addKeyword() {
    const value = keywordDraft.trim();
    if (!value || keywords.includes(value)) return;
    setKeywords((current) => [...current, value]);
    setResearchPreview("");
    setKeywordDraft("");
  }

  function toggleSite(id: string) {
    setSelectedSites((current) =>
      current.includes(id) ? current.filter((site) => site !== id) : [...current, id],
    );
    setResearchPreview("");
  }

  function enginePayload() {
    return { mode: engineMode, provider, model: engineMode === "api" ? model : "", cli, gpuModel, apiKey, baseUrl, reasoning, proxyUrl: effectiveProxyUrl };
  }

  function searchPayload() {
    return { provider: searchProvider, url: searchProvider === "builtin" ? "" : searchMcpUrl, apiKey: searchApiKey, proxyUrl: effectiveProxyUrl };
  }

  function chooseSearchProvider(value: string) {
    const preset = searchPresets[value] ?? fallbackSearchPresets[value];
    setSearchProvider(value);
    setSearchMcpUrl(preset?.url || "");
    setSearchApiKey("");
    setSearchTest({ stage: "idle", detail: "尚未测试" });
    setResearchPreview("");
    setResearchEvents([]);
    setResearchStage("等待开始检索");
  }

  async function testSearchTool() {
    setSearchTest({ stage: "running", detail: "正在连接 MCP…" });
    try {
      const response = await fetch(`${BRIDGE_URL}/api/research/search-test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ search: searchPayload() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "搜索工具连接失败");
      const detail = data.detail || "搜索工具已连接";
      let profileSaved = false;
      try {
        window.localStorage.setItem(SEARCH_PROFILE_STORE, JSON.stringify({ version: 1, provider: searchProvider, url: searchProvider === "builtin" ? "" : searchMcpUrl.trim(), hadApiKey: Boolean(searchApiKey.trim()), savedAt: new Date().toISOString() } satisfies SavedSearchProfile));
        profileSaved = rememberVerification(window.localStorage, SEARCH_VERIFICATION_STORE, reusableSearchFingerprint, detail);
      } catch {
        profileSaved = false;
      }
      setSearchTest({ stage: "passed", detail: profileSaved ? searchApiKey.trim() ? `${detail} · 配置已记住，密钥仅当前会话` : `${detail} · 已自动记住` : `${detail} · 本次已通过，但浏览器未允许记住` });
    } catch (error) {
      forgetMatchingVerification(window.localStorage, SEARCH_VERIFICATION_STORE, reusableSearchFingerprint);
      setSearchTest({ stage: "failed", detail: error instanceof Error ? error.message : "搜索工具连接失败" });
    }
  }

  function transcriptionPayload() {
    return {
      mode: transcriptionMode,
      provider: transcriptionProvider,
      model: transcriptionModel,
      quality: transcriptionQuality,
      language: transcriptionLanguage,
      apiKey: transcriptionMode === "api" ? transcriptionApiKey : "",
      baseUrl: transcriptionMode === "api" ? transcriptionBaseUrl : "",
      diarization: transcriptionDiarization,
      diarizationEngine: transcriptionDiarizationEngine,
      hfToken: transcriptionDiarization && transcriptionDiarizationEngine === "pyannote" ? transcriptionHfToken : "",
      wordTimestamps: transcriptionWordTimestamps,
      beamSize: transcriptionQualityPreset.beamSize,
      secondPass: transcriptionQuality === "maximum",
      chunkMinutes: transcriptionQuality === "maximum" ? 5 : 10,
      environmentRoot: transcriptionMode === "local" ? transcriptionEnvironmentRoot.trim() : "",
      proxyUrl: effectiveProxyUrl,
    };
  }

  function updateTranscriptionEnvironmentRoot(value: string) {
    setTranscriptionEnvironmentRoot(value);
    setTranscriptionEnvironmentSaved(false);
    invalidateTranscriptionEnvironment();
  }

  function saveTranscriptionEnvironmentRoot() {
    const value = transcriptionEnvironmentRoot.trim();
    if (!value) return;
    window.localStorage.setItem(TRANSCRIPTION_ENVIRONMENT_STORE, value);
    setTranscriptionEnvironmentSaved(true);
  }

  async function chooseTranscriptionEnvironmentRoot() {
    try {
      const response = await fetch(`${BRIDGE_URL}/api/pick-transcription-environment`, { method: "POST" });
      const data = await response.json();
      if (data.cancelled) return;
      if (!response.ok || !data.path) throw new Error(data.error || "无法选择环境文件夹");
      updateTranscriptionEnvironmentRoot(data.path);
    } catch (error) {
      setTranscriptionCheckError(error instanceof Error ? error.message : "无法选择环境文件夹");
    }
  }

  function invalidateTranscriptionEnvironment() {
    setTranscriptionEnvironment(null);
    setTranscriptionCheckError("");
    setTranscriptionInstallOpen(false);
    setTranscriptionInstallConfirmed(false);
    setTranscriptionInstallEvents([]);
    setTranscriptionInstallStage("");
    setTranscriptionInstallProgress(0);
    setTranscriptionDiagnosis("");
    setTranscriptionTestStage("idle");
    setTranscriptionTestDetail("配置已变化；如需确认效果，可重新测试");
    setTranscriptionTestResult(null);
    setTranscriptionUploadConfirmed(false);
  }

  function applyTranscriptionEnvironmentResult(data: TranscriptionEnvironment | null | undefined) {
    setTranscriptionEnvironment(data || null);
    const repair = data?.diagnostics?.repairComponents || {};
    setTranscriptionInstallRuntime(Boolean(repair.runtime));
    setTranscriptionInstallModel(Boolean(repair.model));
    setTranscriptionInstallMediaTools(Boolean(repair.mediaTools));
    setTranscriptionInstallDiarization(Boolean(repair.diarization));
  }

  async function checkTranscriptionEnvironment(override?: Record<string, unknown>) {
    setTranscriptionCheckBusy(true);
    setTranscriptionCheckError("");
    try {
      const response = await fetch(`${BRIDGE_URL}/api/transcription/check`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcription: override || transcriptionPayload() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法检查听写环境");
      applyTranscriptionEnvironmentResult(data);
      if (!transcriptionEnvironmentRoot.trim() && data.environmentRoot) setTranscriptionEnvironmentRoot(String(data.environmentRoot));
      setTranscriptionTestStage("idle");
      setTranscriptionTestResult(null);
      setTranscriptionInstallOpen(false);
      setTranscriptionInstallConfirmed(false);
      setTranscriptionDiagnosis("");
    } catch (error) {
      setTranscriptionCheckError(error instanceof Error ? error.message : "无法检查听写环境");
    } finally {
      setTranscriptionCheckBusy(false);
    }
  }

  function applyRecommendedTranscriptionSetup() {
    setTranscriptionMode("local");
    setTranscriptionProvider("faster_whisper");
    setTranscriptionQuality("balanced");
    setTranscriptionModel("turbo");
    setTranscriptionLanguage("ja");
    setTranscriptionDiarization(false);
    setTranscriptionWordTimestamps(true);
    invalidateTranscriptionEnvironment();
  }

  async function prepareTranscriptionEnvironment(selection?: { runtime: boolean; model: boolean; mediaTools: boolean; diarization: boolean; confirmed?: boolean }) {
    const selectedRuntime = selection?.runtime ?? transcriptionInstallRuntime;
    const selectedModel = selection?.model ?? transcriptionInstallModel;
    const selectedMediaTools = selection?.mediaTools ?? transcriptionInstallMediaTools;
    const selectedDiarization = selection?.diarization ?? transcriptionInstallDiarization;
    const confirmed = selection?.confirmed ?? transcriptionInstallConfirmed;
    if (!confirmed) return;
    if (!transcriptionEnvironmentRoot.trim()) {
      setTranscriptionCheckError("请先确认模型与项目数据文件夹，再开始下载");
      return;
    }
    setTranscriptionInstallBusy(true);
    setTranscriptionCheckError("");
    setTranscriptionInstallEvents([]);
    setTranscriptionInstallStage("正在创建准备任务");
    setTranscriptionInstallProgress(2);
    try {
      const response = await fetch(`${BRIDGE_URL}/api/transcription/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          transcription: {
            ...transcriptionPayload(),
            confirmed: true,
            components: {
              runtime: selectedRuntime,
              model: selectedModel,
              mediaTools: selectedMediaTools,
              diarization: selectedDiarization,
            },
          },
        }),
      });
      const created = await response.json();
      if (!response.ok) throw new Error(created.error || "无法开始准备听写环境");
      let complete = false;
      while (!complete) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        const statusResponse = await fetch(`${BRIDGE_URL}/api/transcription/operations/${created.id}`);
        const status = await statusResponse.json();
        if (!statusResponse.ok) throw new Error(status.error || "无法读取准备进度");
        setTranscriptionInstallStage(status.stage || "正在准备");
        setTranscriptionInstallProgress(Number(status.progress || 0));
        setTranscriptionInstallEvents(Array.isArray(status.events) ? status.events : []);
        if (status.status === "completed") {
          complete = true;
          applyTranscriptionEnvironmentResult(status.result);
          setTranscriptionInstallProgress(100);
          setTranscriptionInstallConfirmed(false);
        } else if (status.status === "failed") {
          applyTranscriptionEnvironmentResult(status.result);
          throw new Error(status.error || "听写环境准备失败");
        }
      }
    } catch (error) {
      setTranscriptionCheckError(error instanceof Error ? error.message : "听写环境准备失败");
    } finally {
      setTranscriptionInstallBusy(false);
    }
  }

  async function prepareDiarizationEnvironment() {
    setTranscriptionInstallRuntime(false);
    setTranscriptionInstallModel(false);
    setTranscriptionInstallMediaTools(false);
    setTranscriptionInstallDiarization(true);
    setTranscriptionInstallConfirmed(false);
    setTranscriptionInstallOpen(true);
    window.setTimeout(() => document.querySelector(".transcription-download-panel")?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    await prepareTranscriptionEnvironment({ runtime: false, model: false, mediaTools: false, diarization: true, confirmed: true });
  }

  async function continueWithoutDiarization() {
    const withoutDiarization = { ...transcriptionPayload(), diarization: false, hfToken: "" };
    setTranscriptionDiarization(false);
    invalidateTranscriptionEnvironment();
    await checkTranscriptionEnvironment(withoutDiarization);
  }

  async function askModelToDiagnoseTranscription() {
    if (!transcriptionEnvironment?.diagnostics || !engineVerified) return;
    setTranscriptionDiagnosisBusy(true);
    setTranscriptionDiagnosis("");
    try {
      const response = await fetch(`${BRIDGE_URL}/api/transcription/diagnose`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          engine: enginePayload(),
          transcription: transcriptionPayload(),
          diagnostics: transcriptionEnvironment.diagnostics,
          components: transcriptionEnvironment.components,
          resources: transcriptionEnvironment.resources,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "模型诊断失败");
      setTranscriptionDiagnosis(data.advice || "模型没有返回建议");
    } catch (error) {
      setTranscriptionDiagnosis(error instanceof Error ? error.message : "模型诊断失败");
    } finally {
      setTranscriptionDiagnosisBusy(false);
    }
  }

  async function autoPrepareTranscriptionWithSelectedEngine() {
    if (!engineVerified || !transcriptionEnvironmentRoot.trim() || transcriptionInstallBusy) return;
    const pending = transcriptionEnvironment?.resources?.pendingDownloadLabel || transcriptionEnvironment?.resources?.downloadLabel || "所需依赖与模型";
    if (!window.confirm(`将由第一步已验证的 ${activeEngineLabel} 分析当前检查结果，并允许 GakuNiku 在所选项目数据文件夹中下载 ${pending}。程序只执行内置白名单安装动作，不执行模型生成的命令。是否继续？`)) return;
    setTranscriptionInstallBusy(true);
    setTranscriptionCheckError("");
    setTranscriptionDiagnosis("");
    setTranscriptionInstallEvents([]);
    setTranscriptionInstallStage("第一步模型正在分析环境");
    setTranscriptionInstallProgress(2);
    try {
      const response = await fetch(`${BRIDGE_URL}/api/transcription/auto-install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          engine: enginePayload(),
          transcription: { ...transcriptionPayload(), confirmed: true },
        }),
      });
      const created = await response.json();
      if (!response.ok) throw new Error(created.error || "无法启动模型自动配置");
      let complete = false;
      while (!complete) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        const statusResponse = await fetch(`${BRIDGE_URL}/api/transcription/operations/${created.id}`);
        const status = await statusResponse.json();
        if (!statusResponse.ok) throw new Error(status.error || "无法读取自动配置进度");
        setTranscriptionInstallStage(status.stage || "模型正在配置环境");
        setTranscriptionInstallProgress(Number(status.progress || 0));
        setTranscriptionInstallEvents(Array.isArray(status.events) ? status.events : []);
        if (status.status === "completed") {
          complete = true;
          const applied = status.result?.appliedTranscription;
          if (applied) {
            setTranscriptionDiarization(Boolean(applied.diarization));
            if (applied.diarizationEngine === "pyannote" || applied.diarizationEngine === "sherpa_onnx") setTranscriptionDiarizationEngine(applied.diarizationEngine);
          }
          applyTranscriptionEnvironmentResult(status.result);
          setTranscriptionInstallProgress(100);
          setTranscriptionDiagnosis(status.result?.modelPlan?.explanation || "第一步模型已完成最小环境配置并通过程序校验");
        } else if (status.status === "failed") {
          applyTranscriptionEnvironmentResult(status.result);
          if (status.modelPlan?.explanation) setTranscriptionDiagnosis(`${status.modelPlan.explanation}；执行过程中发现新的环境问题，页面已刷新为当前真实状态，可再次让模型按新诊断继续修复。`);
          throw new Error(status.error || "模型自动配置失败");
        }
      }
    } catch (error) {
      setTranscriptionCheckError(error instanceof Error ? error.message : "模型自动配置失败");
    } finally {
      setTranscriptionInstallBusy(false);
    }
  }

  async function testTranscriptionWithSample() {
    setTranscriptionTestStage("running");
    setTranscriptionTestDetail("正在准备约 20 秒的真实音频…");
    setTranscriptionTestResult(null);
    try {
      const response = await fetch(`${BRIDGE_URL}/api/transcription/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcription: { ...transcriptionPayload(), source, uploadConfirmed: transcriptionMode === "api" ? transcriptionUploadConfirmed : false } }),
      });
      const created = await response.json();
      if (!response.ok) throw new Error(created.error || "无法开始真实听写测试");
      let complete = false;
      while (!complete) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        const statusResponse = await fetch(`${BRIDGE_URL}/api/transcription/operations/${created.id}`);
        const status = await statusResponse.json();
        if (!statusResponse.ok) throw new Error(status.error || "无法读取听写测试进度");
        setTranscriptionTestDetail(status.stage || "正在听写短音频");
        if (status.status === "completed") {
          complete = true;
          setTranscriptionTestStage("passed");
          setTranscriptionTestResult(status.result);
          setTranscriptionTestDetail(`通过 · ${Math.round((status.result?.elapsedMs || 0) / 100) / 10} 秒`);
        } else if (status.status === "failed") {
          throw new Error(status.error || "真实听写测试失败");
        }
      }
    } catch (error) {
      setTranscriptionTestStage("failed");
      setTranscriptionTestDetail(error instanceof Error ? error.message : "真实听写测试失败");
    }
  }

  function chooseTranscriptionProvider(value: keyof typeof transcriptionPresets) {
    const preset = transcriptionPresets[value];
    const nextMode: TranscriptionMode = preset.location === "在线" ? "api" : "local";
    setTranscriptionMode(nextMode);
    setTranscriptionProvider(value);
    const quality = transcriptionQualityPresets[transcriptionQuality];
    const preferred = nextMode === "local" ? quality.localModel : quality.onlineModel;
    setTranscriptionModel(preset.models.includes(preferred as never) ? preferred : preset.models[0] || "");
    if (value === "openai_audio") setTranscriptionBaseUrl("https://api.openai.com/v1");
    if (value === "deepgram") setTranscriptionBaseUrl("https://api.deepgram.com/v1");
    invalidateTranscriptionEnvironment();
  }

  function chooseTranscriptionQuality(value: keyof typeof transcriptionQualityPresets) {
    setTranscriptionQuality(value);
    const quality = transcriptionQualityPresets[value];
    const preferred = transcriptionMode === "local" ? quality.localModel : quality.onlineModel;
    if (transcriptionPreset.models.includes(preferred as never)) setTranscriptionModel(preferred);
    invalidateTranscriptionEnvironment();
  }

  function invalidateEngineTest() {
    setEngineRevision((value) => value + 1);
    setEngineVerificationRestored(false);
    setTestMessages([]);
    setCliInstallTest({ stage: "idle", detail: "等待检查 CLI" });
    setCliAuthTest({ stage: "idle", detail: "等待检查登录" });
    setCliNetworkTest({ stage: "idle", detail: "等待检查上游网络" });
    setTextTest({ stage: "idle", detail: "等待测试" });
    setImageTest({ stage: "idle", detail: "文字通过后自动测试" });
    setEngineTestProxySuspected(false);
  }

  function openEngineTest() {
    setTestMessages([]);
    setTestMessage(DEFAULT_ENGINE_TEST_MESSAGE);
    setCliInstallTest({ stage: "idle", detail: "等待检查 CLI" });
    setCliAuthTest({ stage: "idle", detail: "等待检查登录" });
    setCliNetworkTest({ stage: "idle", detail: "等待检查上游网络" });
    setTextTest({ stage: "idle", detail: "等待测试" });
    setImageTest({ stage: "idle", detail: "文字通过后自动测试" });
    setEngineTestProxySuspected(false);
    setTestOpen(true);
  }

  function chooseStudioMode(mode: StudioMode) {
    setStudioMode(mode);
    if (mode === "advanced") setEasyModeActive(false);
    if (mode === "easy" && engineMode !== "api") {
      setEngineMode("api");
      if (searchProvider === "builtin") chooseSearchProvider("exa");
      invalidateEngineTest();
    }
  }

  function focusPrepareStage(stage: PrepareStage) {
    setCameraFocus(stage);
  }

  function applyEasyDefaults() {
    const canOpenTest = Boolean(apiKey.trim() && model.trim() && (baseUrl.trim() || apiPresets[provider]?.baseUrl));
    const currentSearchPreset = searchPresets[searchProvider] ?? fallbackSearchPresets[searchProvider];
    const currentSearchUsable = searchProvider !== "builtin"
      && Boolean(searchMcpUrl.trim() && (currentSearchPreset?.keyOptional || searchApiKey.trim()));

    setStudioMode("easy");
    setEngineMode("api");
    setReasoning("medium");
    invalidateEngineTest();

    setFormats(["ass", "srt", "mkv"]);
    setTranscriptionMode("local");
    setTranscriptionProvider("faster_whisper");
    setTranscriptionQuality("balanced");
    setTranscriptionModel("turbo");
    setTranscriptionLanguage("ja");
    setTranscriptionDiarization(false);
    setTranscriptionWordTimestamps(true);
    invalidateTranscriptionEnvironment();

    if (!currentSearchUsable) {
      setSearchProvider("exa");
      setSearchMcpUrl(searchPresets.exa?.url || fallbackSearchPresets.exa.url);
      setSearchTest({ stage: "idle", detail: "尚未测试" });
    }
    setSelectedSites(["official", "wikipedia", "fandom", "video"]);
    setResearchPreview("");
    setResearchEvents([]);
    setResearchStage("等待开始检索");
    setShowTrace(true);

    setFontFamily("Noto Sans CJK SC");
    setFontSize(42);
    setFontWeight(700);
    setOutline(3);
    setGlow(8);
    setShadow(3);
    setDeliveryConstraints(DEFAULT_DELIVERY_CONSTRAINTS);
    setConfirmedDeliveryConstraints(DEFAULT_DELIVERY_CONSTRAINTS);
    setAmbiguityReviewMode("pragmatic");

    const builtInHarness = harnessOriginal || harnessText;
    if (builtInHarness) {
      setHarnessText(builtInHarness);
    }

    setEasyModeActive(true);
    focusPrepareStage("engine");
    if (canOpenTest) openEngineTest();
    else window.setTimeout(() => document.querySelector(".engine-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  function chooseProvider(value: string) {
    const preset = apiPresets[value] ?? fallbackApiPresets[value];
    const temporary = readCredentialStore(window.sessionStorage);
    const persistent = readCredentialStore(window.localStorage);
    const nextModel = preferredApiModel(value, preferredStoredModel(temporary, value) || preferredStoredModel(persistent, value), preset || fallbackApiPresets.compatible);
    const stored = credentialForModel(temporary, value, nextModel) || credentialForModel(persistent, value, nextModel);
    setProvider(value);
    setApiKey(stored?.apiKey || "");
    setBaseUrl(stored?.baseUrl || preset?.baseUrl || "");
    setModel(nextModel);
    setRememberApiKey(Boolean(credentialForModel(persistent, value, nextModel)?.apiKey));
    setDiscoveredModels([]);
    setAccountModels([]);
    setDiscoveredModelPricing({});
    setModelCatalogWarning("");
    setShowAllAccountModels(false);
    setModelSelectionTouched(false);
    setModelSyncMessage("");
    invalidateEngineTest();
  }

  function chooseApiModel(value: string) {
    const temporary = readCredentialStore(window.sessionStorage);
    const persistent = readCredentialStore(window.localStorage);
    const stored = credentialForModel(temporary, provider, value) || credentialForModel(persistent, provider, value);
    setModel(value);
    setApiKey(stored?.apiKey || "");
    setBaseUrl(stored?.baseUrl || apiPresets[provider]?.baseUrl || fallbackApiPresets[provider]?.baseUrl || "");
    setRememberApiKey(Boolean(credentialForModel(persistent, provider, value)?.apiKey));
    setModelSelectionTouched(true);
    invalidateEngineTest();
  }

  function clearStoredApiKey() {
    for (const storage of [window.sessionStorage, window.localStorage]) {
      const stored = readCredentialStore(storage);
      delete stored.credentials[apiCredentialKey(provider, model)];
      if (stored.credentials[provider]?.model === model) delete stored.credentials[provider];
      storage.setItem(API_CREDENTIAL_STORE, JSON.stringify(stored));
    }
    setApiKey("");
    setRememberApiKey(false);
    setModelSyncMessage("已从当前标签页和本机持久存储中清除");
    invalidateEngineTest();
  }

  function setPersistentApiKey(enabled: boolean) {
    setRememberApiKey(enabled);
    if (!enabled) {
      const persistent = readCredentialStore(window.localStorage);
      delete persistent.credentials[apiCredentialKey(provider, model)];
      if (persistent.credentials[provider]?.model === model) delete persistent.credentials[provider];
      window.localStorage.setItem(API_CREDENTIAL_STORE, JSON.stringify(persistent));
    }
  }

  function saveEngineProfile(successMessage?: string) {
    const profile: SavedEngineProfile = {
      version: 1,
      mode: engineMode,
      provider,
      model,
      baseUrl,
      cli,
      gpuModel,
      reasoning,
      proxyEnabled,
      proxyUrl: proxyUrl.trim(),
      savedAt: new Date().toISOString(),
    };
    try {
      window.localStorage.setItem(ENGINE_PROFILE_STORE, JSON.stringify(profile));
      setSavedEngineFingerprint(engineProfileFingerprint(profile));
      setEngineProfileSavedAt(profile.savedAt);
      setEngineProfileMessage(successMessage || (rememberApiKey && apiKey.trim() ? "模型设置和 API Key 已保存到本机浏览器" : "模型设置已保存；API Key 仍按上方密钥选项处理"));
    } catch {
      setEngineProfileMessage("浏览器拒绝本地保存，请检查隐私模式或存储权限");
    }
  }

  function clearEngineProfile() {
    window.localStorage.removeItem(ENGINE_PROFILE_STORE);
    window.localStorage.removeItem(ENGINE_VERIFICATION_STORE);
    setSavedEngineFingerprint("");
    setEngineProfileSavedAt("");
    setVerifiedEngine("");
    setEngineVerificationRestored(false);
    setEngineProfileMessage("已清除模型设置记录；当前页面内容不受影响");
  }

  async function syncProviderModels() {
    if (!apiKey.trim()) return;
    setModelSyncBusy(true);
    setModelSyncMessage("正在检查当前账户的模型更新…");
    try {
      const response = await fetch(`${BRIDGE_URL}/api/engine/models`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ engine: enginePayload() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法同步模型列表");
      const models = Array.isArray(data.recommendedModels) ? data.recommendedModels.map(String) : Array.isArray(data.models) ? data.models.map(String) : [];
      const allModels = Array.isArray(data.allModels) ? data.allModels.map(String) : models;
      const pricing = data.pricing && typeof data.pricing === "object" ? data.pricing as Record<string, ApiPriceRule> : {};
      const fetchedAt = typeof data.fetchedAt === "string" ? data.fetchedAt : new Date().toISOString();
      const filteredOut = Number(data.filteredOut || 0);
      const warning = typeof data.warning === "string" ? data.warning : "";
      setDiscoveredModels(models);
      setAccountModels(allModels);
      setDiscoveredModelPricing(pricing);
      setModelCatalogWarning(warning);
      writeModelCatalog(window.localStorage, provider, baseUrl, apiKey, { version: 2, recommendedModels: models, allModels, pricing, source: String(data.source || ""), fetchedAt, warning });
      setModel((current) => {
        if (!models.length || modelSelectionTouched) return current;
        return models.includes(current) ? current : models[0];
      });
      setModelSyncMessage(`实时目录 · 推荐 ${models.length} 个多模态模型 · 账户共 ${allModels.length} 个${filteredOut > 0 ? ` · 已排除 ${filteredOut} 个语音/生成类模型` : ""} · ${new Date(fetchedAt).toLocaleString("zh-CN")}`);
      invalidateEngineTest();
    } catch (error) {
      const cached = readModelCatalog(window.localStorage, provider, baseUrl, apiKey);
      setModelSyncMessage(cached
        ? `实时刷新失败，继续使用 ${cached.recommendedModels.length} 个本机推荐模型 · ${error instanceof Error ? error.message : "连接失败"}`
        : error instanceof Error ? error.message : "无法同步模型列表");
    } finally {
      setModelSyncBusy(false);
    }
  }

  async function generateResearchPreview() {
    setResearchBusy(true);
    setRunError("");
    setResearchEvents([]);
    setResearchStage("正在创建联网检索任务");
    try {
      const response = await fetch(`${BRIDGE_URL}/api/research/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source,
          engine: enginePayload(),
          transcription: transcriptionPayload(),
          search: searchPayload(),
          research: { keywords, sites: selectedSites, customSites: customSites.split(/[\n,]/).map((item) => item.trim()).filter(Boolean), knowledgeIds },
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "预习文档生成失败");
      if (data.document) {
        setResearchPreview(data.document);
        if (data.tokenUsage) setSessionTokenUsage((current) => addTokenUsage(current, data.tokenUsage));
        setResearchEvents([{ kind: "done", text: "预习结果文档已生成" }]);
        setResearchStage("检索完成");
      } else {
        if (!data.id) throw new Error("服务没有返回检索任务 ID");
        let finished = false;
        for (let attempt = 0; attempt < 1200 && !finished; attempt += 1) {
          const statusResponse = await fetch(`${BRIDGE_URL}/api/research/runs/${data.id}`);
          const status = await statusResponse.json();
          if (!statusResponse.ok) throw new Error(status.error || "无法读取检索进度");
          setResearchStage(status.stage || "Agent 正在检索");
          setResearchEvents(Array.isArray(status.events) ? status.events : []);
          if (status.status === "completed") {
            setResearchPreview(status.document || "");
            if (status.tokenUsage) setSessionTokenUsage((current) => addTokenUsage(current, status.tokenUsage));
            finished = true;
          } else if (status.status === "failed") {
            throw new Error(status.error || "联网检索失败");
          } else {
            await new Promise((resolve) => window.setTimeout(resolve, 900));
          }
        }
        if (!finished) throw new Error("联网检索等待超时，请缩小关键词范围后重试");
      }
      setKnowledgeTitle(`${keywords.join(" · ") || "字幕项目"}预习`);
      setResearchOpen(true);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "预习文档生成失败");
      setResearchStage("检索中断");
    } finally { setResearchBusy(false); }
  }

  async function saveToKnowledge() {
    if (!researchPreview.trim()) return;
    const response = await fetch(`${BRIDGE_URL}/api/knowledge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: knowledgeTitle || `${keywords.join(" · ")}预习`, content: researchPreview, keywords }),
    });
    const data = await response.json();
    if (!response.ok) { setRunError(data.error ?? "保存知识库失败"); return; }
    setKnowledgeEntries((current) => [data, ...current.filter((entry) => entry.id !== data.id)]);
    setKnowledgeIds((current) => current.includes(data.id) ? current : [...current, data.id]);
    setResearchOpen(false);
  }

  async function sendTestMessage(proxyOverride?: string, previousMessages = testMessages) {
    const content = testMessage.trim();
    if (!content) return;
    const next = [...previousMessages, { role: "user" as const, content }];
    setTestMessages(next);
    setTestBusy(true);
    setVerifiedEngine("");
    setEngineVerificationRestored(false);
    if (engineMode === "cli") {
      setCliInstallTest({ stage: "running", detail: "正在确认可执行程序与版本" });
      setCliAuthTest({ stage: "running", detail: "正在读取本机登录状态" });
      setCliNetworkTest({ stage: "running", detail: "正在探测模型上游" });
      setTextTest({ stage: "idle", detail: "等待 CLI 预检" });
    } else {
      setTextTest({ stage: "running", detail: "正在验证文字指令遵循" });
    }
    setImageTest({ stage: "idle", detail: "等待文字测试" });
    setEngineTestProxySuspected(false);
    try {
      const response = await fetch(`${BRIDGE_URL}/api/engine/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ engine: { ...enginePayload(), ...(proxyOverride !== undefined ? { proxyUrl: proxyOverride } : {}) }, messages: next, multimodal: true }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "连接失败");
      if (data.tokenUsage) setSessionTokenUsage((current) => addTokenUsage(current, data.tokenUsage));
      if (engineMode === "cli") {
        const diagnostic = data.diagnostics;
        setCliInstallTest({ stage: diagnostic?.install?.passed ? "passed" : "failed", detail: diagnostic?.install?.detail || "没有收到安装检查结果" });
        setCliAuthTest({ stage: diagnostic?.auth?.passed ? "passed" : "failed", detail: diagnostic?.auth?.detail || "没有收到登录检查结果" });
        setCliNetworkTest({ stage: diagnostic?.network?.passed ? "passed" : "failed", detail: diagnostic?.network?.detail || "没有收到网络检查结果" });
      }
      setTextTest({ stage: data.checks?.text?.passed ? "passed" : "failed", detail: data.checks?.text?.detail || "文字校验无结果", reply: data.checks?.text?.reply });
      setImageTest({ stage: data.checks?.image?.passed ? "passed" : "failed", detail: data.checks?.image?.detail || "图片校验无结果", reply: data.checks?.image?.reply, previewUrl: data.challengeImageUrl ? `${BRIDGE_URL}${data.challengeImageUrl}` : undefined });
      setEngineTestProxySuspected(Boolean(data.proxySuspected));
      if (!data.passed) {
        forgetMatchingVerification(window.localStorage, ENGINE_VERIFICATION_STORE, reusableEngineFingerprint);
        setTestMessages([...next, { role: "assistant", content: `验证未通过：${data.error || "文字或图片能力未通过校验"}` }]);
        return;
      }
      setTestMessages([...next, { role: "assistant", content: data.text }]);
      setVerifiedEngine(engineFingerprint);
      rememberVerification(window.localStorage, ENGINE_VERIFICATION_STORE, reusableEngineFingerprint, "文字与图片能力均已通过");
      saveEngineProfile(engineMode !== "api" || rememberApiKey ? "双项验证已通过，配置与通过状态已自动记住" : "双项验证已通过；配置已记住，API Key 仅保留在当前标签页");
    } catch (error) {
      setVerifiedEngine("");
      forgetMatchingVerification(window.localStorage, ENGINE_VERIFICATION_STORE, reusableEngineFingerprint);
      if (engineMode === "cli") {
        const detail = error instanceof Error ? error.message : "诊断请求失败";
        setCliInstallTest((current) => current.stage === "running" ? { stage: "failed", detail } : current);
        setCliAuthTest((current) => current.stage === "running" ? { stage: "failed", detail: "未能完成登录检查" } : current);
        setCliNetworkTest((current) => current.stage === "running" ? { stage: "failed", detail: "未能完成网络检查" } : current);
      }
      setTextTest((current) => current.stage === "running" ? { stage: "failed", detail: error instanceof Error ? error.message : "文字测试失败" } : current);
      setImageTest((current) => current.stage === "idle" ? { stage: "failed", detail: "未能进入图片测试" } : current);
      setTestMessages([...next, { role: "assistant", content: `连接失败：${error instanceof Error ? error.message : "未知错误"}` }]);
    } finally { setTestBusy(false); }
  }

  async function retryEngineTestWithoutProxy() {
    setProxyEnabled(false);
    setSearchTest({ stage: "idle", detail: "代理已关闭，请重新测试搜索工具" });
    setResearchPreview("");
    setTestMessages([]);
    setCliInstallTest({ stage: "idle", detail: "等待检查 CLI" });
    setCliAuthTest({ stage: "idle", detail: "等待检查登录" });
    setCliNetworkTest({ stage: "idle", detail: "等待检查上游网络" });
    setTextTest({ stage: "idle", detail: "等待测试" });
    setImageTest({ stage: "idle", detail: "文字通过后自动测试" });
    setEngineTestProxySuspected(false);
    await sendTestMessage("", []);
  }

  function captureReviewSnapshot(): ReviewSnapshot {
    return {
      cues: cues.map((cue) => ({ ...cue })),
      roles: roles.map((role) => ({ ...role })),
      selectedCueId,
      fontFamily,
      fontSize,
      fontWeight,
      outline,
      glow,
      shadow,
    };
  }

  function restoreReviewSnapshot(snapshot: ReviewSnapshot) {
    const nextCues = snapshot.cues.map((cue) => ({ ...cue }));
    const nextRoles = snapshot.roles.map((role) => ({ ...role }));
    const nextSelectedCue = nextCues.find((cue) => cue.id === snapshot.selectedCueId) || nextCues[0];
    setCues(nextCues);
    setRoles(nextRoles);
    setSelectedCueId(nextSelectedCue?.id || 1);
    setFontFamily(snapshot.fontFamily);
    setFontSize(snapshot.fontSize);
    setFontWeight(snapshot.fontWeight);
    setOutline(snapshot.outline);
    setGlow(snapshot.glow);
    setShadow(snapshot.shadow);
    if (nextSelectedCue) {
      setCurrentTime(nextSelectedCue.start);
      if (videoRef.current) videoRef.current.currentTime = nextSelectedCue.start;
    }
    setSaved(false);
  }

  function rememberReviewState(historyKey: string, coalesce = false) {
    const now = Date.now();
    const lastEdit = lastReviewEditRef.current;
    if (coalesce && lastEdit?.key === historyKey && now - lastEdit.at <= REVIEW_EDIT_COALESCE_MS) {
      lastReviewEditRef.current = { key: historyKey, at: now };
      return;
    }
    const snapshot = captureReviewSnapshot();
    setReviewHistory((current) => ({
      past: [...current.past, snapshot].slice(-MAX_REVIEW_HISTORY),
      future: [],
    }));
    lastReviewEditRef.current = coalesce ? { key: historyKey, at: now } : null;
  }

  function undoReview() {
    const target = reviewHistory.past.at(-1);
    if (!target) return;
    const current = captureReviewSnapshot();
    setReviewHistory({
      past: reviewHistory.past.slice(0, -1),
      future: [current, ...reviewHistory.future].slice(0, MAX_REVIEW_HISTORY),
    });
    lastReviewEditRef.current = null;
    restoreReviewSnapshot(target);
  }

  function redoReview() {
    const target = reviewHistory.future[0];
    if (!target) return;
    const current = captureReviewSnapshot();
    setReviewHistory({
      past: [...reviewHistory.past, current].slice(-MAX_REVIEW_HISTORY),
      future: reviewHistory.future.slice(1),
    });
    lastReviewEditRef.current = null;
    restoreReviewSnapshot(target);
  }

  reviewHistoryActionRef.current = { undo: undoReview, redo: redoReview };

  function resetReviewHistory() {
    setReviewHistory({ past: [], future: [] });
    lastReviewEditRef.current = null;
  }

  function updateCue(patch: Partial<Cue>, options: ReviewEditOptions = {}) {
    const currentCue = cues.find((cue) => cue.id === selectedCueId);
    if (!currentCue || !Object.entries(patch).some(([key, value]) => currentCue[key as keyof Cue] !== value)) return;
    rememberReviewState(options.historyKey || `cue:${selectedCueId}:${Object.keys(patch).sort().join(",")}`, Boolean(options.coalesce));
    setCues((current) => current.map((cue) => (cue.id === selectedCueId ? { ...cue, ...patch } : cue)));
    setSaved(false);
  }

  function updateRole(id: string, patch: Partial<Role>, options: ReviewEditOptions = {}) {
    const currentRole = roles.find((role) => role.id === id);
    if (!currentRole || !Object.entries(patch).some(([key, value]) => currentRole[key as keyof Role] !== value)) return;
    rememberReviewState(options.historyKey || `role:${id}:${Object.keys(patch).sort().join(",")}`, Boolean(options.coalesce));
    setRoles((current) => current.map((role) => (role.id === id ? { ...role, ...patch } : role)));
    setSaved(false);
  }

  function resetSubtitleTypography() {
    if (fontFamily === "Noto Sans CJK SC" && fontSize === 42 && fontWeight === 700) return;
    rememberReviewState("style:typography-reset");
    setFontFamily("Noto Sans CJK SC");
    setFontSize(42);
    setFontWeight(700);
    setSaved(false);
  }

  function addReviewRole() {
    rememberReviewState("role:add");
    setRoles((current) => [...current, { id: `speaker-${Date.now()}`, name: "未确认人物", characterName: "", performerName: "", speakingAs: "unknown", color: "#A78BFA" }]);
    setSaved(false);
  }

  function selectAdjacentCue(direction: -1 | 1) {
    const index = cues.findIndex((cue) => cue.id === selectedCueId);
    const next = cues[Math.min(cues.length - 1, Math.max(0, index + direction))];
    if (next) seekTo(next.start, next.id);
  }

  function seekTo(value: number, cueId?: number) {
    const nextTime = Math.min(timelineDuration, Math.max(0, value));
    setCurrentTime(nextTime);
    if (cueId) setSelectedCueId(cueId);
    if (videoRef.current) videoRef.current.currentTime = nextTime;
  }

  function timeFromTimelinePointer(event: ReactPointerEvent<HTMLElement>) {
    const canvas = event.currentTarget.closest(".timeline-canvas") as HTMLElement | null;
    if (!canvas) return currentTime;
    const bounds = canvas.getBoundingClientRect();
    return ((event.clientX - bounds.left) / bounds.width) * timelineDuration;
  }

  function deleteCue(cueId: number) {
    if (cues.length <= 1) {
      setRunError("至少保留一句字幕，不能删除最后一句。 ");
      return;
    }
    const cueIndex = cues.findIndex((cue) => cue.id === cueId);
    const nextCue = cues[cueIndex + 1] || cues[cueIndex - 1];
    rememberReviewState(`cue:${cueId}:delete`);
    setCues((current) => current.filter((cue) => cue.id !== cueId));
    setSelectedCueId(nextCue.id);
    seekTo(nextCue.start, nextCue.id);
    setSaved(false);
  }

  function changeTimelineZoom(nextZoom: number, anchorClientX?: number) {
    const bounded = Math.min(200, Math.max(20, nextZoom));
    const scroller = timelineScrollerRef.current;
    const oldCanvasWidth = timelineCanvasWidth;
    const anchorOffset = scroller && anchorClientX !== undefined
      ? anchorClientX - scroller.getBoundingClientRect().left
      : scroller ? scroller.clientWidth / 2 : 0;
    const anchorTime = scroller
      ? ((scroller.scrollLeft + anchorOffset) / oldCanvasWidth) * timelineDuration
      : currentTime;
    setTimelineZoom(bounded);
    window.requestAnimationFrame(() => {
      if (!scroller) return;
      const newCanvasWidth = Math.max(720, Math.ceil(timelineDuration * bounded * 0.72));
      scroller.scrollLeft = Math.max(0, (anchorTime / timelineDuration) * newCanvasWidth - anchorOffset);
    });
  }

  function handleTimelineWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (!event.shiftKey) return;
    event.preventDefault();
    const wheelDelta = event.deltaY || event.deltaX;
    changeTimelineZoom(timelineZoom + (wheelDelta < 0 ? 10 : -10), event.clientX);
  }

  function beginTimelineScrub(event: ReactPointerEvent<HTMLDivElement>) {
    if (timelineTool === "hand") {
      const scroller = timelineScrollerRef.current;
      if (!scroller) return;
      timelinePanRef.current = { pointerId: event.pointerId, startX: event.clientX, scrollLeft: scroller.scrollLeft };
      event.currentTarget.setPointerCapture(event.pointerId);
      setTimelinePanning(true);
      return;
    }
    if ((event.target as HTMLElement).closest(".subtitle-cue")) return;
    if (timelineTool === "delete") return;
    timelineScrubPointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    seekTo(timeFromTimelinePointer(event));
  }

  function continueTimelineScrub(event: ReactPointerEvent<HTMLDivElement>) {
    const pan = timelinePanRef.current;
    if (pan?.pointerId === event.pointerId && timelineScrollerRef.current) {
      timelineScrollerRef.current.scrollLeft = pan.scrollLeft - (event.clientX - pan.startX);
      return;
    }
    if (timelineScrubPointerRef.current !== event.pointerId) return;
    seekTo(timeFromTimelinePointer(event));
  }

  function finishTimelineScrub(event: ReactPointerEvent<HTMLDivElement>) {
    if (timelinePanRef.current?.pointerId === event.pointerId) {
      timelinePanRef.current = null;
      setTimelinePanning(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    if (timelineScrubPointerRef.current !== event.pointerId) return;
    timelineScrubPointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function beginReviewResize(event: ReactPointerEvent<HTMLDivElement>, kind: ReviewResizeKind, startValue: number) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    reviewResizeRef.current = { kind, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startValue };
  }

  function continueReviewResize(event: ReactPointerEvent<HTMLDivElement>) {
    const resize = reviewResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    if (resize.kind === "preview-inspector") setInspectorWidth(Math.min(560, Math.max(260, resize.startValue - (event.clientX - resize.startX))));
    if (resize.kind === "preview-timeline") setPreviewWorkspaceHeight(Math.min(800, Math.max(300, resize.startValue + (event.clientY - resize.startY))));
    if (resize.kind === "timeline-cues") setTimelineHeight(Math.min(360, Math.max(150, resize.startValue + (event.clientY - resize.startY))));
    if (resize.kind === "cue-editor") setSentenceEditorWidth(Math.min(620, Math.max(300, resize.startValue - (event.clientX - resize.startX))));
  }

  function finishReviewResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (reviewResizeRef.current?.pointerId !== event.pointerId) return;
    reviewResizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function beginCueDrag(event: ReactPointerEvent<HTMLElement>, cue: Cue, mode: CueDragMode) {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    cueDragRef.current = {
      cueId: cue.id,
      mode,
      pointerId: event.pointerId,
      startX: event.clientX,
      originalStart: cue.start,
      originalEnd: cue.end,
      moved: false,
    };
    setSelectedCueId(cue.id);
  }

  function continueCueDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = cueDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const renderedCanvasWidth = timelineScrollerRef.current?.querySelector<HTMLElement>(".timeline-canvas")?.getBoundingClientRect().width;
    const renderedPixelsPerSecond = renderedCanvasWidth ? renderedCanvasWidth / timelineDuration : timelinePixelsPerSecond;
    const delta = (event.clientX - drag.startX) / renderedPixelsPerSecond;
    if (Math.abs(event.clientX - drag.startX) >= 2 && !drag.moved) {
      rememberReviewState(`cue:${drag.cueId}:timeline-drag`);
      drag.moved = true;
    }
    if (!drag.moved) return;
    const snap = (value: number) => Math.round(value * 20) / 20;
    const duration = drag.originalEnd - drag.originalStart;
    let start = drag.originalStart;
    let end = drag.originalEnd;
    if (drag.mode === "move") {
      start = Math.min(timelineDuration - duration, Math.max(0, snap(drag.originalStart + delta)));
      end = start + duration;
    } else if (drag.mode === "start") {
      start = Math.min(drag.originalEnd - 0.2, Math.max(0, snap(drag.originalStart + delta)));
    } else {
      end = Math.min(timelineDuration, Math.max(drag.originalStart + 0.2, snap(drag.originalEnd + delta)));
    }
    setCues((current) => current.map((cue) => cue.id === drag.cueId ? { ...cue, start, end } : cue));
    setCurrentTime(drag.mode === "end" ? end : start);
    setSaved(false);
  }

  function finishCueDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = cueDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    suppressCueClickRef.current = drag.moved;
    cueDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function fitTimeline() {
    changeTimelineZoom(20, timelineScrollerRef.current?.getBoundingClientRect().left);
    if (timelineScrollerRef.current) timelineScrollerRef.current.scrollLeft = 0;
  }

  function currentExternalProcessingConsent(): ExternalProcessingConsent {
    return {
      version: 1,
      granted: true,
      grantedAt: new Date().toISOString(),
      currentTaskOnly: true,
      fingerprint: currentExternalProcessingPlan.fingerprint,
      services: currentExternalProcessingPlan.services,
      dataTypes: currentExternalProcessingPlan.dataTypes,
    };
  }

  async function startTranslation(externalProcessingConsent: ExternalProcessingConsent | null = null) {
    setRunError("");
    setJobBlocker(null);
    setJobConnectionFailures(0);
    setJobTokenUsage(emptyTokenUsage());
    setJobRunStatus("idle");
    setTerminateConfirmOpen(false);
    const issues: Array<{ stage: PrepareStage; message: string }> = [];
    if (!engineVerified) issues.push({ stage: "engine", message: "翻译模型尚未通过文字与图片测试" });
    if (!source.trim()) issues.push({ stage: "source", message: "未填写视频链接或本地路径" });
    if (!outputPath.trim()) issues.push({ stage: "source", message: "未填写输出文件夹" });
    if (!formats.length) issues.push({ stage: "source", message: "未选择输出格式" });
    if (transcriptionMode === "api" && !transcriptionApiKey.trim()) issues.push({ stage: "source", message: "在线听写缺少 API Key" });
    if (!transcriptionEnvironment) issues.push({ stage: "source", message: "尚未检查听写依赖，可使用推荐参数一键检查" });
    else if (!transcriptionEnvironment.ready) issues.push({ stage: "source", message: `听写环境未就绪：${transcriptionEnvironment.recommendation}` });
    if (!keywords.length) issues.push({ stage: "research", message: "没有预习关键词" });
    if (searchProvider !== "builtin" && !searchMcpUrl.trim()) issues.push({ stage: "research", message: "联网检索缺少 MCP 地址" });
    if (!searchPresets[searchProvider]?.keyOptional && !searchApiKey.trim()) issues.push({ stage: "research", message: "联网检索缺少 API Key" });
    if (!researchPreview.trim()) issues.push({ stage: "research", message: "尚未生成并检查预习结果文档" });
    if (currentExternalProcessingPlan.required && !externalConsentChecked && !externalProcessingConsent) issues.push({ stage: "harness", message: "尚未勾选当前任务的外部模型处理授权" });
    if (bridgeStatus !== "online") issues.push({ stage: "engine", message: "本地服务未连接" });
    if (issues.length) {
      focusPrepareStage(issues[0].stage);
      setRunError(`开始前统一检查发现 ${issues.length} 项：${issues.map((item) => item.message).join("；")}。已带你到第一处需要处理的位置。`);
      return;
    }
    const taskExternalProcessingConsent = externalProcessingConsent || (currentExternalProcessingPlan.required ? currentExternalProcessingConsent() : null);
    setWorkspace("running");
    setRunMessage("正在创建任务…");
    try {
      const response = await fetch(`${BRIDGE_URL}/api/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source,
          outputPath,
          formats,
          sourceLanguage: "ja",
          targetLanguage: "zh-CN",
          engine: enginePayload(),
          transcription: transcriptionPayload(),
          search: searchPayload(),
          research: {
            keywords,
            sites: selectedSites,
            customSites: customSites.split(/[\n,]/).map((item) => item.trim()).filter(Boolean),
            preview: researchPreview,
            knowledgeIds,
          },
          harnessText: harnessText && harnessText !== harnessOriginal ? harnessText : "",
          deliveryConstraints,
          reviewPolicy: { version: 1, ambiguity: { mode: ambiguityReviewMode } },
          execution: { showTrace },
          ...(taskExternalProcessingConsent ? { externalProcessingConsent: taskExternalProcessingConsent } : {}),
          subtitleStyle: { fontFamily, fontSize, fontWeight, outline, glow, shadow, maxLines: 2 },
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "任务创建失败");
      completedJobHydratedRef.current = "";
      completedJobAutoOpenedRef.current = "";
      setJobId(data.id);
      setJobRunStatus("running");
      setActiveJobConsentFingerprint(taskExternalProcessingConsent?.fingerprint || "");
      window.localStorage.setItem(ACTIVE_JOB_STORE, JSON.stringify({ id: data.id, source, savedAt: new Date().toISOString() }));
      setRunMessage(engineMode === "api" ? "任务已交给首页模型与项目内置 Harness" : "任务已交给所选 Agent Skill");
    } catch (error) {
      setWorkspace("prepare");
      setRunError(error instanceof Error ? error.message : "任务创建失败");
    }
  }

  async function resumeBlockedJob(externalProcessingConsent: ExternalProcessingConsent | null = null) {
    if (!jobId) return;
    completedJobHydratedRef.current = "";
    completedJobAutoOpenedRef.current = "";
    if (currentExternalProcessingPlan.required && !externalProcessingConsent && activeJobConsentFingerprint !== currentExternalProcessingPlan.fingerprint) {
      setWorkspace("prepare");
      focusPrepareStage("harness");
      setRunError("模型配置已经变化，请在第四步重新勾选外部模型处理授权后再继续。");
      return;
    }
    setResumeBusy(true);
    setRunError("");
    try {
      if (transcriptionEnvironment && !transcriptionEnvironment.ready) throw new Error("请先检查并准备听写环境");
      const response = await fetch(`${BRIDGE_URL}/api/jobs/${jobId}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ engine: enginePayload(), transcription: transcriptionPayload(), search: searchPayload(), reviewPolicy: { version: 1, ambiguity: { mode: ambiguityReviewMode } }, execution: { showTrace }, ...(externalProcessingConsent ? { externalProcessingConsent } : {}) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法继续任务");
      setJobBlocker(null);
      setJobRunStatus("running");
      if (externalProcessingConsent) setActiveJobConsentFingerprint(externalProcessingConsent.fingerprint);
      setTerminateConfirmOpen(false);
      setPhaseStates((current) => ({ ...current, [data.resumeFrom]: "running" }));
      setRunMessage(`正在从“${phaseDefinitions.find(([id]) => id === data.resumeFrom)?.[1] || data.resumeFrom}”继续`);
      setWorkspace("running");
      setJobPollRevision((value) => value + 1);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "无法继续任务");
    } finally {
      setResumeBusy(false);
    }
  }

  async function showHistoryDialog() {
    setHistoryDialogOpen(true);
    setHistoryJobBusy(true);
    setHistoryJobError("");
    try {
      const response = await fetch(`${BRIDGE_URL}/api/jobs`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法读取历史任务");
      setHistoryJobs(Array.isArray(data.jobs) ? data.jobs : []);
    } catch (error) {
      setHistoryJobError(error instanceof Error ? error.message : "无法读取历史任务");
    } finally {
      setHistoryJobBusy(false);
    }
  }

  async function openHistoricalJob(id: string) {
    setHistoryJobBusy(true);
    setHistoryJobError("");
    try {
      const response = await fetch(`${BRIDGE_URL}/api/jobs/${id}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "没有找到这个历史任务");
      completedJobHydratedRef.current = "";
      completedJobAutoOpenedRef.current = data.status === "completed" ? id : "";
      setJobId(id);
      setJobRunStatus(["running", "blocked", "failed", "cancelled", "completed"].includes(data.status) ? data.status as JobRunStatus : "idle");
      setRunMessage(data.message || "正在载入历史任务记录");
      window.localStorage.setItem(LAST_JOB_STORE, JSON.stringify({ id, source, savedAt: new Date().toISOString() }));
      setHistoryDialogOpen(false);
      setWorkspace("running");
    } catch (error) {
      setHistoryJobError(error instanceof Error ? error.message : "无法打开历史任务");
    } finally {
      setHistoryJobBusy(false);
    }
  }

  function returnHomeAfterTermination(message: string) {
    window.localStorage.removeItem(ACTIVE_JOB_STORE);
    completedJobHydratedRef.current = "";
    completedJobAutoOpenedRef.current = "";
    setJobId("");
    setJobRunStatus("idle");
    setWorkspace("prepare");
    setTerminateConfirmOpen(false);
    setJobBlocker(null);
    setSelectedPhaseId("");
    setRunError("");
    setRunMessage("");
    setProgress(0);
    setPhaseStates(Object.fromEntries(phaseDefinitions.map(([id]) => [id, "pending"])));
    setPhaseDetails({});
    setTrace([]);
    setJobResources(null);
    setJobDiagnostics(null);
    setJobConnectionFailures(0);
    setJobTokenUsage(emptyTokenUsage());
    setManifestLimitations([]);
    setManifestNotices([]);
    setProjectNotice(message);
  }

  async function terminateCurrentJob() {
    if (!jobId || terminateBusy) return;
    setTerminateBusy(true);
    setRunError("");
    try {
      const response = await fetch(`${BRIDGE_URL}/api/jobs/${jobId}/cancel`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法终止任务");
      if (["running", "blocked", "failed", "cancelled", "completed"].includes(data.status)) setJobRunStatus(data.status as JobRunStatus);
      const message = data.message || "任务已终止，已有成果已保留，可从历史任务中重新打开";
      if (data.status === "cancelled") returnHomeAfterTermination(message);
      else {
        setRunMessage(message);
        setTerminateConfirmOpen(false);
        setJobPollRevision((value) => value + 1);
      }
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "无法终止任务");
    } finally {
      setTerminateBusy(false);
    }
  }

  async function saveRefinements() {
    if (jobId && bridgeStatus === "online") {
      try {
        const response = await fetch(`${BRIDGE_URL}/api/jobs/${jobId}/refine`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cues, roles, style: { fontFamily, fontSize, fontWeight, outline, glow, shadow } }),
        });
        if (!response.ok) throw new Error("本地桥未接受精修数据");
      } catch {
        setRunError("保存到本地任务失败；当前修改仍保留在浏览器中。 ");
        return false;
      }
    }
    setSaved(true);
    return true;
  }

  function currentProjectSnapshot(): GakuNikuProjectV1 {
    return {
      format: PROJECT_FILE_FORMAT,
      version: PROJECT_FILE_VERSION,
      appVersion: "0.2.1",
      savedAt: new Date().toISOString(),
      workspace,
      job: jobId ? { id: jobId } : null,
      prepare: {
        studioMode,
        cameraFocus,
        source,
        outputPath,
        formats,
        engine: { mode: engineMode, provider, model, baseUrl: projectSafeUrl(baseUrl), cli, gpuModel, reasoning, proxyEnabled, proxyUrl: projectSafeUrl(proxyUrl) },
        transcription: {
          mode: transcriptionMode,
          provider: transcriptionProvider,
          quality: transcriptionQuality,
          model: transcriptionModel,
          baseUrl: projectSafeUrl(transcriptionBaseUrl),
          language: transcriptionLanguage,
          diarization: transcriptionDiarization,
          diarizationEngine: transcriptionDiarizationEngine,
          wordTimestamps: transcriptionWordTimestamps,
          environmentRoot: transcriptionEnvironmentRoot,
        },
        search: { provider: searchProvider, url: projectSafeUrl(searchMcpUrl) },
        research: { keywords, sites: selectedSites, customSites, preview: researchPreview, knowledgeIds, title: knowledgeTitle },
        harness: { text: harnessText, confirmed: true, deliveryConstraints, ambiguityReviewMode },
        execution: { showTrace },
      },
      review: {
        roles,
        cues,
        selectedCueId,
        currentTime,
        timelineZoom,
        style: { fontFamily, fontSize, fontWeight, outline, glow, shadow },
        layout: { inspectorWidth, previewWorkspaceHeight, timelineHeight, sentenceEditorWidth },
      },
    };
  }

  function saveStudioProject() {
    try {
      const snapshot = currentProjectSnapshot();
      const blob = new Blob([`${JSON.stringify(snapshot, null, 2)}\n`], { type: "application/json;charset=utf-8" });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const downloadName = projectFileName.endsWith(".gakuniku") ? projectFileName : projectDownloadName(source);
      anchor.href = href;
      anchor.download = downloadName;
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 1000);
      setProjectFileName(downloadName);
      setProjectNotice(`项目已保存为 ${downloadName}；API Key 与访问令牌未写入文件`);
      setSaved(true);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "保存项目失败");
    }
  }

  function requestOpenStudioProject() {
    if (!saved && workspace === "review" && !window.confirm("当前精修内容尚未保存。仍要打开其他项目吗？")) return;
    projectInputRef.current?.click();
  }

  async function handleProjectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      if (file.size > MAX_PROJECT_FILE_BYTES) throw new Error("项目文件超过 12 MB，请确认没有误选视频或其他文件");
      const project = parseProjectFile(JSON.parse(await file.text()));
      const prepare = project.prepare;
      const review = project.review;
      const importedEngineMode = ["api", "cli", "gpu"].includes(prepare.engine.mode) ? prepare.engine.mode : "api";
      const importedStudioMode = ["easy", "advanced"].includes(prepare.studioMode) ? prepare.studioMode : importedEngineMode === "api" ? "easy" : "advanced";
      const importedCameraFocus = ["engine", "source", "research", "harness"].includes(prepare.cameraFocus) ? prepare.cameraFocus : "engine";
      const importedTranscriptionProvider = prepare.transcription.provider in transcriptionPresets ? prepare.transcription.provider as keyof typeof transcriptionPresets : "faster_whisper";
      const importedTranscriptionQuality = prepare.transcription.quality in transcriptionQualityPresets ? prepare.transcription.quality as keyof typeof transcriptionQualityPresets : "balanced";
      const importedAmbiguityMode = ["fast", "pragmatic", "strict"].includes(prepare.harness.ambiguityReviewMode) ? prepare.harness.ambiguityReviewMode : "pragmatic";
      const temporaryCredentials = readCredentialStore(window.sessionStorage);
      const persistentCredentials = readCredentialStore(window.localStorage);
      const localCredential = credentialForModel(temporaryCredentials, prepare.engine.provider, prepare.engine.model) || credentialForModel(persistentCredentials, prepare.engine.provider, prepare.engine.model);
      const clamp = (value: number, min: number, max: number, fallback: number) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
      const importedRoles = review.roles.filter((item) => item && typeof item.id === "string" && typeof item.name === "string" && /^#[0-9a-f]{6}$/i.test(item.color)).map((item, index) => normalizeReviewRole(item, index));
      const importedCues = review.cues.filter((item) => item && Number.isFinite(item.id) && Number.isFinite(item.start) && Number.isFinite(item.end)).map((item) => normalizeReviewCue(item));

      if (previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
      resetReviewHistory();
      setStudioMode(importedStudioMode);
      setCameraFocus(importedCameraFocus);
      setSource(String(prepare.source || ""));
      setPreviewUrl(project.job?.id ? `${BRIDGE_URL}/api/jobs/${project.job.id}/media` : "");
      setOutputPath(String(prepare.outputPath || "~/Movies/Precision Subtitles"));
      setFormats(prepare.formats.map(String).filter(Boolean));
      setEngineMode(importedEngineMode);
      setProvider(String(prepare.engine.provider || "openai"));
      setModel(String(prepare.engine.model || ""));
      setBaseUrl(String(prepare.engine.baseUrl || ""));
      setCli(String(prepare.engine.cli || "codex"));
      setGpuModel(String(prepare.engine.gpuModel || "deepseek-r1:14b"));
      setReasoning(String(prepare.engine.reasoning || "medium"));
      setProxyEnabled(Boolean(prepare.engine.proxyEnabled));
      setProxyUrl(String(prepare.engine.proxyUrl || ""));
      setApiKey(localCredential?.apiKey || "");
      setRememberApiKey(Boolean(credentialForModel(persistentCredentials, prepare.engine.provider, prepare.engine.model)?.apiKey));
      setVerifiedEngine("");
      setEngineVerificationRestored(false);
      setTranscriptionMode(prepare.transcription.mode === "api" ? "api" : "local");
      setTranscriptionProvider(importedTranscriptionProvider);
      setTranscriptionQuality(importedTranscriptionQuality);
      setTranscriptionModel(String(prepare.transcription.model || transcriptionPresets[importedTranscriptionProvider].models[0]));
      setTranscriptionBaseUrl(String(prepare.transcription.baseUrl || transcriptionPresets[importedTranscriptionProvider].baseUrl));
      setTranscriptionLanguage(String(prepare.transcription.language || "ja"));
      setTranscriptionDiarization(Boolean(prepare.transcription.diarization));
      setTranscriptionDiarizationEngine(prepare.transcription.diarizationEngine === "pyannote" ? "pyannote" : "sherpa_onnx");
      setTranscriptionWordTimestamps(prepare.transcription.wordTimestamps !== false);
      setTranscriptionApiKey("");
      setTranscriptionHfToken("");
      setTranscriptionEnvironmentRoot(String(prepare.transcription.environmentRoot || ""));
      setTranscriptionEnvironment(null);
      setSearchProvider(String(prepare.search.provider || "exa"));
      setSearchMcpUrl(String(prepare.search.url || ""));
      setSearchApiKey("");
      setSearchTest({ stage: "idle", detail: "项目已恢复；如本机没有有效验证，请重新测试搜索工具" });
      setKeywords(prepare.research.keywords.map(String).filter(Boolean));
      setSelectedSites(prepare.research.sites.map(String).filter(Boolean));
      setCustomSites(String(prepare.research.customSites || ""));
      setResearchPreview(String(prepare.research.preview || ""));
      setKnowledgeIds(prepare.research.knowledgeIds.map(String).filter(Boolean));
      setKnowledgeTitle(String(prepare.research.title || ""));
      setHarnessText(String(prepare.harness.text || harnessOriginal));
      setDeliveryConstraints(String(prepare.harness.deliveryConstraints || DEFAULT_DELIVERY_CONSTRAINTS));
      setConfirmedDeliveryConstraints(String(prepare.harness.deliveryConstraints || DEFAULT_DELIVERY_CONSTRAINTS));
      setAmbiguityReviewMode(importedAmbiguityMode);
      setShowTrace(prepare.execution.showTrace !== false);
      setRoles(importedRoles.length ? importedRoles : initialRoles);
      setCues(importedCues.length ? importedCues : initialCues);
      const selectedId = importedCues.some((cue) => cue.id === review.selectedCueId) ? review.selectedCueId : importedCues[0]?.id || 1;
      setSelectedCueId(selectedId);
      setCurrentTime(clamp(review.currentTime, 0, Math.max(0, ...importedCues.map((cue) => cue.end)), 0));
      setTimelineZoom(clamp(review.timelineZoom, 20, 200, 56));
      setFontFamily(String(review.style.fontFamily || "Noto Sans CJK SC"));
      setFontSize(clamp(review.style.fontSize, 18, 96, 42));
      setFontWeight(clamp(review.style.fontWeight, 100, 900, 700));
      setOutline(clamp(review.style.outline, 0, 8, 3));
      setGlow(clamp(review.style.glow, 0, 20, 8));
      setShadow(clamp(review.style.shadow, 0, 10, 3));
      setInspectorWidth(clamp(review.layout.inspectorWidth, 260, 560, 305));
      setPreviewWorkspaceHeight(clamp(review.layout.previewWorkspaceHeight, 300, 800, 470));
      setTimelineHeight(clamp(review.layout.timelineHeight, 150, 360, 188));
      setSentenceEditorWidth(clamp(review.layout.sentenceEditorWidth, 300, 620, 345));
      setJobId(project.job?.id && /^[a-f0-9-]{36}$/i.test(project.job.id) ? project.job.id : "");
      setPhaseStates(Object.fromEntries(phaseDefinitions.map(([id]) => [id, "pending"])));
      setPhaseDetails({});
      setRunError("");
      setJobBlocker(null);
      setProjectFileName(file.name);
      setProjectNotice(`已打开 ${file.name}；密钥未从项目文件读取`);
      setSaved(true);
      const nextWorkspace = project.workspace === "running" && project.job?.id ? "running" : project.workspace === "review" ? "review" : "prepare";
      const importedJobId = project.job?.id && /^[a-f0-9-]{36}$/i.test(project.job.id) ? project.job.id : "";
      completedJobHydratedRef.current = nextWorkspace === "review" ? importedJobId : "";
      completedJobAutoOpenedRef.current = nextWorkspace === "review" ? importedJobId : "";
      setWorkspace(nextWorkspace);
    } catch (error) {
      setRunError(error instanceof Error ? `打开项目失败：${error.message}` : "打开项目失败");
    }
  }

  async function exportProject() {
    if (!await saveRefinements()) return;
    if (!jobId || bridgeStatus !== "online") {
      setRunError("示例工程只能预览编辑；真实任务完成后可由本地 Agent 重新生成并封装。 ");
      return;
    }
    try {
      const response = await fetch(`${BRIDGE_URL}/api/jobs/${jobId}/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          outputPath,
          formats,
          engine: { mode: engineMode, provider, model: engineMode === "api" ? model : "", cli, gpuModel, apiKey, baseUrl, proxyUrl: effectiveProxyUrl },
          roles,
          cues,
          style: { fontFamily, fontSize, fontWeight, outline, glow, shadow, maxLines: 2 },
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "导出任务创建失败");
      completedJobHydratedRef.current = "";
      completedJobAutoOpenedRef.current = "";
      setRunMessage("正在根据精修结果重新生成并封装");
      setWorkspace("running");
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "导出任务创建失败");
    }
  }

  function loadDemo() {
    resetReviewHistory();
    setRoles(initialRoles);
    setCues(initialCues);
    setSelectedCueId(1);
    setWorkspace("review");
    setCurrentTime(1);
    setSaved(true);
  }

  function togglePlayback() {
    if (!videoRef.current) {
      setIsPlaying((value) => !value);
      return;
    }
    if (videoRef.current.paused) videoRef.current.play();
    else videoRef.current.pause();
  }

  const overlayStyle = {
    "--speaker-color": visibleRole?.color ?? "#ffffff",
    "--subtitle-size": `${fontSize}px`,
    "--subtitle-weight": fontWeight,
    "--subtitle-outline": `${outline}px`,
    "--subtitle-glow": `${glow}px`,
    "--subtitle-shadow": `${shadow}px`,
    "--subtitle-font": `"${fontFamily}", "PingFang SC", sans-serif`,
  } as CSSProperties;

  return (
    <div className="studio-shell">
      <header className="topbar">
        <div className="brand-lockup" aria-label="GakuNiku">
          <div className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32" focusable="false">
              <path d="M6.5 7.5h19v13h-9.2l-5.8 4.4v-4.4h-4z" />
              <path d="M11 12h10M11 16h7" />
            </svg>
          </div>
          <div className="brand-name">GakuNiku</div>
        </div>
        <nav className="workflow-nav" aria-label="工作流程">
          <button className={workspace === "prepare" ? "active" : ""} onClick={() => setWorkspace("prepare")}>
            <span>1</span> 准备
          </button>
          <div className="workflow-line" />
          <button className={workspace === "running" ? "active" : ""} title={jobId ? "查看翻译进度与执行记录" : "尚无翻译任务记录"} onClick={() => jobId && setWorkspace("running")}>
            <span>2</span> 翻译
          </button>
          <div className="workflow-line" />
          <button className={workspace === "review" ? "active" : ""} onClick={() => setWorkspace("review")}>
            <span>3</span> 精修
          </button>
        </nav>
        <div className="header-usage" aria-label="Token 使用统计" data-details={tokenUsageDetails} title={tokenUsageDetails}>
          <span className="header-usage-title"><i />用量估算</span>
          <div><span>合计</span><strong>{formatTokenCount(displayedTokenUsage.total, displayedTokenUsage.available)} Token</strong></div>
          <div className="billing-cache"><span>缓存命中</span><strong>{displayedTokenUsage.cacheAvailable ? `${formatTokenCount(displayedTokenUsage.cachedInput, true)} Token` : "未提供"}</strong></div>
          <div className="billing-cost"><span>费用</span><strong>{estimatedTokenCostLabel}</strong></div>
          <div><span>模型</span><strong>{activeEngineLabel}</strong></div>
        </div>
        <div className="header-actions">
          {jobId && <button type="button" className="topbar-terminate-button" disabled={terminateBusy} title={`终止当前任务（${jobRunStatus}）`} onClick={() => setTerminateConfirmOpen(true)}><i aria-hidden="true" /><span>{terminateBusy ? "终止中…" : "终止任务"}</span></button>}
          <button type="button" className="history-job-button" aria-label="打开历史任务" title="选择并打开历史任务记录" onClick={() => void showHistoryDialog()}><ClockCounterClockwise size={16} /></button>
          <div className="project-file-actions" role="group" aria-label="项目文件">
            <input ref={projectInputRef} className="visually-hidden" type="file" accept=".gakuniku,.json,application/json" onChange={(event) => void handleProjectFile(event)} />
            <button type="button" title="打开 GakuNiku 项目文件" onClick={requestOpenStudioProject}><FolderOpen size={15} /><span>打开项目</span></button>
            <button type="button" title="保存完整项目，不包含 API Key" onClick={saveStudioProject}><FloppyDisk size={15} /><span>保存项目</span></button>
          </div>
          <div className={`bridge-pill ${bridgeStatus}`}>
            <i /> 后端{bridgeStatus === "online" ? "已连接" : bridgeStatus === "checking" ? "检查中" : "未连接"}
          </div>
        </div>
      </header>

      {projectNotice && <div className="project-file-notice" role="status"><FloppyDisk size={15} /><span>{projectNotice}</span><button type="button" aria-label="关闭项目提示" onClick={() => setProjectNotice("")}>×</button></div>}

      {terminateConfirmOpen && jobId && <div className="terminate-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !terminateBusy) setTerminateConfirmOpen(false); }}><section className="terminate-confirm terminate-dialog" role="alertdialog" aria-modal="true" aria-labelledby="terminate-dialog-title"><div><strong id="terminate-dialog-title">确认终止当前任务？</strong><span>{jobRunStatus === "running" ? "会立即停止 Agent 与其子进程，但不会删除已完成阶段和文件，之后仍可断点继续。" : "无论当前处于阻塞、失败、精修或其他页面，都可以执行终止；已经完成或终止的任务只会安全确认状态。"}</span></div><button className="secondary-button" disabled={terminateBusy} onClick={() => setTerminateConfirmOpen(false)}>返回</button><button className="terminate-confirm-button" disabled={terminateBusy} onClick={terminateCurrentJob}>{terminateBusy ? "正在终止…" : "确认终止"}</button></section></div>}
      {historyDialogOpen && <div className="history-job-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !historyJobBusy) setHistoryDialogOpen(false); }}><section className="history-job-dialog" role="dialog" aria-modal="true" aria-labelledby="history-job-title"><header><span><ClockCounterClockwise size={19} /></span><div><strong id="history-job-title">历史任务</strong><small>选择一条记录，查看八个环节、执行轨迹与 Token 消耗</small></div><button type="button" aria-label="关闭" disabled={historyJobBusy} onClick={() => setHistoryDialogOpen(false)}>×</button></header>{historyJobBusy && !historyJobs.length ? <div className="history-job-empty">正在读取历史任务…</div> : historyJobError ? <p role="alert">{historyJobError}</p> : historyJobs.length ? <div className="history-job-list">{historyJobs.map((item) => <button type="button" key={item.id} className={item.id === jobId ? "current" : ""} onClick={() => void openHistoricalJob(item.id)} disabled={historyJobBusy}><span className={`history-job-status ${item.status}`}>{item.status === "completed" ? "已完成" : item.status === "running" ? "进行中" : item.status === "blocked" ? "已阻塞" : item.status === "failed" ? "失败" : item.status === "cancelled" ? "已终止" : item.status}</span><div><strong>{item.source ? item.source.split(/[\\/]/).at(-1) : "未命名任务"}</strong><small>{item.id}</small></div><time>{item.updatedAt ? new Date(item.updatedAt).toLocaleString("zh-CN") : "时间未知"}</time><CaretRight size={16} /></button>)}</div> : <div className="history-job-empty">还没有历史任务</div>}<footer><small>最多显示最近 60 条本机任务</small><button type="button" className="secondary-button" disabled={historyJobBusy} onClick={() => setHistoryDialogOpen(false)}>关闭</button></footer></section></div>}

      {workspace === "prepare" && (
        <main className="prepare-page">
          {runError && <div className="notice error"><strong>无法开始</strong><span>{runError}</span><button onClick={() => setRunError("")}>×</button></div>}

          <div className="prepare-workbench">
          <div className="workflow-stage">
          <div className="workflow-stack">
            <section ref={(node) => { workflowStepRefs.current.engine = node; }} className={`panel engine-panel workflow-step ${cameraFocus === "engine" ? "camera-focused" : ""}`}>
              <div className="panel-title-row">
                <div><span className="section-index">1</span><div><h2>设置并测试翻译引擎</h2><small>选择翻译能力，完成文字与图片双项测试</small></div></div>
                <span className={engineVerified ? "step-status verified" : "step-status pending"}><i />{engineVerified ? engineVerificationRestored ? "已沿用验证" : "测试通过" : "等待测试"}</span>
              </div>
              <p className="panel-intro">相同的已验证配置会自动沿用；只有模型、密钥或思考强度发生变化时才重新测试。</p>
              <div className="engine-mode-cards" aria-label="翻译引擎运行方式">
                <button className={engineMode === "api" ? "active" : ""} onClick={() => { chooseStudioMode("easy"); setEngineMode("api"); if (searchProvider === "builtin") chooseSearchProvider("exa"); invalidateEngineTest(); }}><span><Gauge size={21} /></span><div><strong>API 模式</strong><small>无需 Agent CLI · 模型直连内置 Harness</small></div>{engineMode === "api" && <CheckCircle size={19} weight="fill" />}</button>
                <button className={engineMode === "cli" ? "active" : ""} onClick={() => { chooseStudioMode("advanced"); setEngineMode("cli"); invalidateEngineTest(); }}><span><Robot size={22} /></span><div><strong>Agent Skill</strong><small>专业模式 · 调用本地 Agent</small></div>{engineMode === "cli" && <CheckCircle size={19} weight="fill" />}</button>
              </div>
              <div className="engine-advanced-row"><button className={studioMode === "advanced" ? "active" : ""} onClick={() => chooseStudioMode(studioMode === "advanced" ? "easy" : "advanced")}><SlidersHorizontal size={15} />{studioMode === "advanced" ? "收起高级设置" : "展开高级设置"}</button>{studioMode === "advanced" && <button className={engineMode === "gpu" ? "active" : ""} onClick={() => { setEngineMode("gpu"); invalidateEngineTest(); }}><Brain size={15} />本地部署模型</button>}</div>

              {engineMode === "api" && <div className="engine-fields engine-grid">
                <div><label className="field-label" htmlFor="provider">常用模型服务</label><select id="provider" value={provider} onChange={(event) => chooseProvider(event.target.value)}>{Object.entries(apiPresets).map(([id, preset]) => <option key={id} value={id}>{preset.label}</option>)}</select></div>
                <div className="model-picker">
                  <label className="field-label" htmlFor="api-model">模型</label>
                  <div className="model-picker-row">
                    <input id="api-model" list="api-model-options" value={model} onChange={(event) => chooseApiModel(event.target.value)} placeholder={apiPresets[provider]?.multimodal === "unavailable" ? "该厂商暂无原生多模态对话模型" : "选择推荐模型或填写模型 ID"} />
                    <datalist id="api-model-options">{availableModelOptions.map((item) => <option key={item} value={item} />)}</datalist>
                    <button type="button" title="主动检查当前 API 账户的模型更新" onClick={() => void syncProviderModels()} disabled={!apiKey.trim() || modelSyncBusy}><ArrowClockwise size={14} />{modelSyncBusy ? "检查中" : "检查更新"}</button>
                  </div>
                  {recommendedModelOptions.length > 0 && <div className="model-recommendations" aria-label="推荐多模态模型"><span>本版推荐</span>{recommendedModelOptions.slice(0, 4).map((item, index) => <button type="button" className={model === item ? "active" : ""} key={item} onClick={() => chooseApiModel(item)}>{index === 0 && <b>首选</b>}{item}</button>)}</div>}
                  <small className="model-catalog-hint">{apiKey.trim() ? discoveredModels.length ? `本机已保存检查结果 · ${discoveredModels.length} 个推荐 / ${accountModels.length} 个账户模型` : "当前使用本版内置的官方多模态推荐；需要时再点“检查更新”" : apiPresets[provider]?.multimodal === "unavailable" ? "该厂商当前直连对话模型不能完成图片理解；请换用带原生视觉能力的厂商" : "当前使用本版内置推荐；填写 API Key 后可主动检查账户模型更新"}</small>
                  {accountModels.length > discoveredModels.length && <button type="button" className="model-catalog-toggle" onClick={() => setShowAllAccountModels((current) => !current)}>{showAllAccountModels ? "收起账户其他模型" : `显示账户其他模型（${accountModels.length - discoveredModels.length}）`}</button>}
                </div>
                <div><label className="field-label" htmlFor="api-key">API Key <small>按当前模型独立记忆</small></label><div className="api-key-row"><input id="api-key" type="password" autoComplete="off" value={apiKey} onChange={(event) => { setApiKey(event.target.value); invalidateEngineTest(); }} placeholder="临时保存在当前模型与标签页" /><button type="button" onClick={clearStoredApiKey} disabled={!apiKey}>清除</button></div><label className="remember-key"><input type="checkbox" checked={rememberApiKey} onChange={(event) => setPersistentApiKey(event.target.checked)} /> 按当前模型保存到本机，切换回来自动恢复</label></div>
                {studioMode === "advanced" && <div><label className="field-label" htmlFor="base-url">Base URL</label><input id="base-url" value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); invalidateEngineTest(); }} placeholder="https://.../v1" /></div>}
                <section className={`api-pricing-card ${activePriceRule ? "available" : "unavailable"}`} aria-label="当前模型 API 计费规则" title={`价格核对于 ${embeddedApiPricing.checkedAt}${activePriceRule?.note ? ` · ${activePriceRule.note}` : ""}`}>
                  <div className="api-pricing-line">
                    <strong>API 计费规则 · {model || "未选模型"}</strong>
                    {activePriceRule ? <>
                      <span>输入 <b>{formatPriceRate(activePriceRule.inputPerMillion, activePriceRule.currency)}</b>/1M</span>
                      <span>缓存 <b>{activePriceRule.cachedInputPerMillion === undefined ? "未单列" : formatPriceRate(activePriceRule.cachedInputPerMillion, activePriceRule.currency)}</b>/1M</span>
                      <span>输出 <b>{formatPriceRate(activePriceRule.outputPerMillion, activePriceRule.currency)}</b>/1M</span>
                      <span>当前估算 <b>{estimatedTokenCostLabel}</b></span>
                    </> : <span>暂无内置单价，以服务商账单为准</span>}
                    {apiPresets[provider]?.pricingDocsUrl && <a href={apiPresets[provider].pricingDocsUrl} target="_blank" rel="noreferrer">价格页 ↗</a>}
                  </div>
                </section>
                {studioMode === "advanced" && <div className="provider-verification"><span>官方文档核对：{apiPresets[provider]?.checkedAt || "自定义"}</span>{apiPresets[provider]?.docsUrl && <a href={apiPresets[provider].docsUrl} target="_blank" rel="noreferrer">查看官方模型文档 ↗</a>}<small>{apiPresets[provider]?.note}</small></div>}
                {(modelCatalogWarning || apiPresets[provider]?.multimodal === "unavailable") && <div className="model-capability-warning"><strong>图文能力不满足</strong><span>{modelCatalogWarning || apiPresets[provider]?.note}</span></div>}
                {modelSyncMessage && <div className="model-sync-message">{modelSyncMessage}</div>}
              </div>}

              {engineMode === "cli" && <div className="engine-fields">
                <label className="field-label" htmlFor="agent-cli">本地 Agent</label>
                <select id="agent-cli" value={cli} onChange={(event) => { setCli(event.target.value); invalidateEngineTest(); }}>{cliOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select>
                <p className="field-help"><strong>怎么区分：</strong>GPT 是模型；Codex Agent CLI 是负责调用模型、文件与工具的本地执行器。</p>
                <div className="capability-list">{cliOptions.map((option) => <div key={option.id}><span className={capabilities[option.id]?.available ? "available" : "unavailable"} /> <strong>{option.label}</strong><small>{capabilities[option.id]?.available ? "已发现" : bridgeStatus === "online" ? "未发现" : "待连接"}</small></div>)}</div>
              </div>}

              {engineMode === "gpu" && <div className="engine-fields engine-grid">
                <div><label className="field-label" htmlFor="gpu-model">Ollama 模型</label><input id="gpu-model" value={gpuModel} onChange={(event) => { setGpuModel(event.target.value); invalidateEngineTest(); }} /></div>
                <div className="gpu-card"><span>GPU</span><strong>{capabilities.gpu?.detail ?? "连接本地桥后检测"}</strong><small>媒体和翻译保留在本机；联网预习由已安装的 Agent CLI 负责检索。</small></div>
              </div>}

              {studioMode === "advanced" && <div className={`proxy-setting engine-proxy ${proxyEnabled ? "enabled" : ""}`}>
                <label aria-label="使用网络代理" className="proxy-toggle" htmlFor="enable-network-proxy"><input id="enable-network-proxy" type="checkbox" checked={proxyEnabled} onChange={(event) => { setProxyEnabled(event.target.checked); setSearchTest({ stage: "idle", detail: "代理开关已修改，请重新测试搜索工具" }); setResearchPreview(""); invalidateEngineTest(); }} /><span><strong>使用网络代理</strong><small>{proxySuggestion?.detail || "正在检测本机 Clash Verge 设置"}</small></span></label>
                <div className="proxy-address"><label className="field-label" htmlFor="network-proxy">代理地址</label><div><input id="network-proxy" value={proxyUrl} disabled={!proxyEnabled} onChange={(event) => { setProxyUrl(event.target.value); setSearchTest({ stage: "idle", detail: "代理已修改，请重新测试搜索工具" }); setResearchPreview(""); invalidateEngineTest(); }} placeholder={proxySuggestion?.url || "例如 http://127.0.0.1:7897"} />{proxySuggestion?.detected && <button type="button" disabled={!proxyEnabled || proxyUrl === proxySuggestion.url} onClick={() => { setProxyUrl(proxySuggestion.url); setSearchTest({ stage: "idle", detail: "已恢复 Clash Verge 地址，请重新测试" }); setResearchPreview(""); invalidateEngineTest(); }}>使用检测值</button>}</div></div>
                <small>启用后同时用于模型 API、搜索 MCP 与 Agent CLI；关闭时保持地址但所有请求直连。地址只随当前运行传递，不写入任务文件或日志。</small>
              </div>}

              <div className={`engine-profile-save ${engineProfileDirty ? "dirty" : savedEngineFingerprint ? "saved" : ""}`}>
                <div><strong>{engineProfileDirty ? "当前设置有修改" : savedEngineFingerprint ? "已保存为本机默认设置" : "保存本次模型选择"}</strong><small>{engineProfileMessage || "下次打开页面自动恢复运行方式、模型、CLI、思考强度和代理"}{engineProfileSavedAt && !engineProfileDirty ? ` · ${new Date(engineProfileSavedAt).toLocaleString("zh-CN")}` : ""}</small></div>
                <button type="button" className="save-engine-profile" onClick={() => saveEngineProfile()}>{savedEngineFingerprint ? "更新本地设置" : "保存到本机"}</button>
                <button type="button" className="clear-engine-profile" onClick={clearEngineProfile} disabled={!savedEngineFingerprint}>清除记录</button>
              </div>

              <div className="engine-test-heading"><div><strong>文字与图片能力测试</strong></div><span><i className={textTest.stage} />文字测试</span><span><i className={imageTest.stage} />图片测试</span></div>
              <div className="engine-verification-row">
                <div><label className="field-label" htmlFor="reasoning-effort">思考强度</label><select id="reasoning-effort" value={reasoning} onChange={(event) => { setReasoning(event.target.value); invalidateEngineTest(); }}><option value="low">低 · 快速试跑</option><option value="medium">中 · 日常推荐</option><option value="high">高 · 专名与语境</option><option value="xhigh">极高 · 疑难精修</option></select></div>
                <button className={engineVerified ? "connection-test verified" : "connection-test"} onClick={openEngineTest} disabled={!canTestEngine}>{engineVerified ? engineVerificationRestored ? "✓ 已沿用上次验证 · 可重新测试" : "✓ 双项已通过 · 重新测试" : "测试文字与图片能力"}<span>↗</span></button>
              </div>
            </section>

            <section ref={(node) => { workflowStepRefs.current.source = node; }} className={`panel source-panel workflow-step ${cameraFocus === "source" ? "camera-focused" : ""}`}>
                <div className="panel-title-row">
                  <div><span className="section-index">02</span><h2>视频与输出</h2></div>
                  <span className={videoReady ? "step-status verified" : "step-status pending"}><i />{videoReady ? "基本设置完成" : "可直接设置"}</span>
                </div>
                <fieldset className="step-fields">
                <section className="source-setup-guide" aria-label="视频与听写配置顺序">
                  <header><div><span>SETUP ORDER</span><strong>按顺序完成这 3 项</strong></div><small>每一步都在下方对应区域完成</small></header>
                  <ol>
                    <li className={videoReady ? "complete" : "current"}><i>1</i><span><strong>素材与输出</strong><small>填写视频位置、输出文件夹和格式</small></span><em>{videoReady ? "已完成" : "从这里开始"}</em></li>
                    <li className="configured"><i>2</i><span><strong>听写方案</strong><small>{transcriptionPreset.label} · {transcriptionModel} · {transcriptionLanguage === "ja" ? "日语" : transcriptionLanguage}</small></span><button type="button" onClick={applyRecommendedTranscriptionSetup} disabled={transcriptionInstallBusy}>使用推荐方案</button></li>
                    <li className={transcriptionRequestedReady ? "complete" : transcriptionEnvironment ? "attention" : "pending"}><i>3</i><span><strong>项目环境</strong><small>{transcriptionRequestedReady ? "运行库、模型和媒体工具已就绪" : transcriptionEnvironment ? `发现 ${transcriptionEnvironmentIssueCount} 个待处理项` : "检查后由本地环境 Agent 处理缺项"}</small></span><em>{transcriptionRequestedReady ? "已完成" : transcriptionEnvironment ? "需要处理" : "待检查"}</em></li>
                  </ol>
                </section>
                <section className="source-setup-block source-media-block">
                <div className="source-setup-block-heading"><i>1</i><div><strong>填写素材与输出</strong><small>先确定输入和交付格式</small></div></div>
                <label className="field-label" htmlFor="video-source">视频位置</label><div className="source-input-row">
                  <input id="video-source" value={source} onChange={(event) => { setSource(event.target.value); setResearchPreview(""); setTranscriptionTestStage("idle"); setTranscriptionTestDetail("视频已变化；可按需测试真实音频"); setTranscriptionTestResult(null); }} placeholder="粘贴 Bilibili / YouTube / 其他链接，或输入本地路径" />
                  <input ref={fileInputRef} className="visually-hidden" type="file" accept="video/*,audio/*" onChange={handleFile} />
                  <button className="browse-button" onClick={chooseLocalFile}>选择文件</button>
                </div>
                <p className="field-help">自动识别来源；网页预览使用临时文件地址，Agent 处理本地文件时请填写完整路径。</p>
                <div className="source-requirements">
                  <span><i className={capabilities.ffmpeg?.available ? "ok" : ""} /> FFmpeg {capabilities.ffmpeg?.available ? "就绪" : "待检测"}</span>
                  {(sourceKind.label === "Bilibili") && <span><i className={capabilities.yutto?.available ? "ok" : "missing"} /> yutto {capabilities.yutto?.available ? capabilities.yutto.detail ?? "就绪" : "未发现"}</span>}
                  {(sourceKind.label === "YouTube" || sourceKind.label === "yt-dlp 链接") && <span><i className={capabilities["yt-dlp"]?.available ? "ok" : "missing"} /> yt-dlp {capabilities["yt-dlp"]?.available ? "就绪" : "未发现"}</span>}
                </div>
                <div className="field-grid">
                  <div>
                    <label className="field-label" htmlFor="output-path">输出文件夹</label>
                    <input id="output-path" value={outputPath} onChange={(event) => setOutputPath(event.target.value)} />
                  </div>
                  <div>
                    <label className="field-label" htmlFor="quality">下载画质</label>
                    <select id="quality" defaultValue="best"><option value="best">最高可用画质</option><option value="1080">1080P</option><option value="720">720P</option><option value="source">保留本地源文件</option></select>
                  </div>
                </div>
                <div className="format-row">
                  <span className="field-label">输出格式</span>
                  <div className="format-chips">
                    {["srt", "ass", "mkv", "mp4"].map((format) => (
                      <button key={format} className={formats.includes(format) ? "selected" : ""} onClick={() => toggleFormat(format)}>
                        <span className="check">{formats.includes(format) ? "✓" : ""}</span>{format.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>
                </section>
                <div className="transcription-config">
                  <div className="transcription-heading"><div><i>2</i><span>TRANSCRIPTION</span><h3>选择原文听写方案</h3><p>听写和翻译是两套模型。这里决定谁来听音频、时间戳做到多细，以及是否区分说话人。</p></div><strong>{transcriptionPreset.location} · {transcriptionQualityPreset.label}</strong></div>
                  <div className="transcription-mode-tabs" role="group" aria-label="听写运行位置">
                    <button className={transcriptionMode === "local" ? "active" : ""} onClick={() => chooseTranscriptionProvider("faster_whisper")}>本地模型</button>
                    <button className={transcriptionMode === "api" ? "active" : ""} onClick={() => chooseTranscriptionProvider("openai_audio")}>在线 API</button>
                  </div>
                  <div className="transcription-grid">
                    <div><label className="field-label" htmlFor="transcription-provider">听写服务</label><select id="transcription-provider" value={transcriptionProvider} onChange={(event) => chooseTranscriptionProvider(event.target.value as keyof typeof transcriptionPresets)}>{Object.entries(transcriptionPresets).filter(([, preset]) => preset.location === (transcriptionMode === "local" ? "本地" : "在线")).map(([id, preset]) => <option key={id} value={id}>{preset.label}</option>)}</select></div>
                    <div><label className="field-label" htmlFor="transcription-quality">模型质量</label><select id="transcription-quality" value={transcriptionQuality} onChange={(event) => chooseTranscriptionQuality(event.target.value as keyof typeof transcriptionQualityPresets)}>{Object.entries(transcriptionQualityPresets).map(([id, preset]) => <option key={id} value={id}>{preset.label}</option>)}</select><small>{transcriptionQualityPreset.hint}</small></div>
                    <div><label className="field-label" htmlFor="transcription-model">具体模型</label>{transcriptionModelOptions.length ? <select id="transcription-model" value={transcriptionModel} onChange={(event) => { setTranscriptionModel(event.target.value); invalidateTranscriptionEnvironment(); }}>{transcriptionModelOptions.map((item) => <option key={item} value={item}>{item}</option>)}</select> : <input id="transcription-model" value={transcriptionModel} onChange={(event) => { setTranscriptionModel(event.target.value); invalidateTranscriptionEnvironment(); }} placeholder="填写模型 ID" />}<small>{transcriptionPreset.note}</small></div>
                    <div><label className="field-label" htmlFor="transcription-language">原文语言</label><select id="transcription-language" value={transcriptionLanguage} onChange={(event) => setTranscriptionLanguage(event.target.value)}><option value="ja">日语</option><option value="zh">中文</option><option value="en">英语</option><option value="ko">韩语</option><option value="auto">自动识别</option></select><small>明确指定语言通常能提升准确率和速度</small></div>
                  </div>
                  {transcriptionMode === "api" && <div className="transcription-api-grid"><div><label className="field-label" htmlFor="transcription-key">听写 API Key</label><input id="transcription-key" type="password" autoComplete="off" value={transcriptionApiKey} onChange={(event) => { setTranscriptionApiKey(event.target.value); invalidateTranscriptionEnvironment(); }} placeholder="可与翻译 Key 不同；仅随任务启动传递" /></div><div><label className="field-label" htmlFor="transcription-base-url">听写 Base URL</label><input id="transcription-base-url" value={transcriptionBaseUrl} onChange={(event) => { setTranscriptionBaseUrl(event.target.value); invalidateTranscriptionEnvironment(); }} /></div></div>}
                  <div className="transcription-switches">
                    <label><input aria-label="启用词级时间戳" type="checkbox" checked={transcriptionWordTimestamps} onChange={(event) => setTranscriptionWordTimestamps(event.target.checked)} /><span><strong>词级时间戳</strong><small>用于让字幕从第一个词开始、最后一个词结束</small></span></label>
                    <label><input aria-label="启用说话人分离" type="checkbox" checked={transcriptionDiarization} onChange={(event) => { setTranscriptionDiarization(event.target.checked); invalidateTranscriptionEnvironment(); }} /><span><strong>说话人分离</strong><small>本地默认使用无需账号的 Sherpa-ONNX；失败只降级说话人标签，不影响基础听写</small></span></label>
                  </div>
                  {transcriptionMode === "local" && transcriptionDiarization && <div className="transcription-diarization-engine"><label className="field-label" htmlFor="diarization-engine">本地分离引擎</label><select id="diarization-engine" value={transcriptionDiarizationEngine} onChange={(event) => { setTranscriptionDiarizationEngine(event.target.value as DiarizationEngine); setTranscriptionInstallDiarization(false); invalidateTranscriptionEnvironment(); }}><option value="sherpa_onnx">Sherpa-ONNX（推荐 · 无需账号）</option><option value="pyannote">WhisperX / pyannote（高级 · 需 HF 权限）</option></select><small>{transcriptionDiarizationEngine === "sherpa_onnx" ? "约 47 MB 本地模型，Mac 与 Windows 均可使用；输出匿名 speaker_XX，身份仍需证据绑定" : "适合已有 Hugging Face gated 模型权限的用户；401/403 会立即降级，不进入长重试"}</small></div>}
                  {transcriptionMode === "local" && transcriptionDiarization && transcriptionDiarizationEngine === "pyannote" && <div className="transcription-hf-token"><label className="field-label" htmlFor="hf-token">Hugging Face Token</label><input id="hf-token" type="password" autoComplete="off" value={transcriptionHfToken} onChange={(event) => { setTranscriptionHfToken(event.target.value); invalidateTranscriptionEnvironment(); }} placeholder="用于 pyannote 模型授权；只随当前运行传递" /><small>还需在 Hugging Face 接受对应模型条款。Token 不写入项目文件或诊断日志。</small></div>}
                  {transcriptionMode === "api" && !transcriptionApiKey.trim() && <p className="transcription-warning">开始前需要填写听写 API Key；不会自动复用翻译模型的密钥，避免误传。</p>}
                  <section className="transcription-environment">
                    <div className="transcription-environment-heading">
                      <i>3</i><div><span>PROJECT ENVIRONMENT</span><strong>检查并配置项目环境</strong><small>先只读检查；确认下载后，本地环境 Agent 才会在项目目录中修复。</small></div>
                      <button className={`environment-check-button ${transcriptionEnvironment ? "checked" : "primary"}`} onClick={() => void checkTranscriptionEnvironment()} disabled={transcriptionCheckBusy || transcriptionInstallBusy}>{transcriptionCheckBusy ? "正在检查项目环境…" : transcriptionEnvironment ? "✓ 重新检查" : "检查项目环境 →"}</button>
                    </div>
                    <details className={`transcription-environment-details ${transcriptionCheckError ? "error" : transcriptionEnvironment ? transcriptionRequestedReady ? "ready" : "attention" : "idle"}`}>
                      <summary><i>{transcriptionCheckError || transcriptionEnvironment && !transcriptionRequestedReady ? "!" : transcriptionRequestedReady ? "✓" : "3"}</i><span><strong>{transcriptionCheckError ? "环境检查失败" : transcriptionEnvironment ? transcriptionRequestedReady ? "项目环境已经就绪" : `发现 ${transcriptionEnvironmentIssueCount} 个环境缺失项` : "尚未检查项目环境"}</strong><small>{transcriptionCheckError ? "展开查看错误并重试" : transcriptionEnvironment ? transcriptionRequestedReady ? "展开查看运行目录和版本" : `展开后让 ${engineVerified ? activeEngineLabel : "第一页 AI"} 在项目目录中处理` : "点击上方蓝色按钮开始只读检查"}</small></span><em>{transcriptionEnvironment && !transcriptionRequestedReady ? "立即处理 →" : "查看详情"}</em></summary>
                    {transcriptionMode === "local" && <div className="transcription-environment-location">
                      <div><span>PROJECT DATA</span><strong>模型与项目数据文件夹</strong><small>用户只需选择容量充足的位置；程序会自动判断 Python 运行库能否安全放在同一磁盘。</small></div>
                      <div className="transcription-environment-path-row"><input aria-label="听写模型与项目数据文件夹" value={transcriptionEnvironmentRoot} onChange={(event) => updateTranscriptionEnvironmentRoot(event.target.value)} placeholder="选择模型与项目数据文件夹" /><button type="button" onClick={chooseTranscriptionEnvironmentRoot}>选择文件夹</button><button type="button" className={transcriptionEnvironmentSaved ? "saved" : ""} onClick={saveTranscriptionEnvironmentRoot} disabled={!transcriptionEnvironmentRoot.trim()}>{transcriptionEnvironmentSaved ? "✓ 已记住" : "记住位置"}</button></div>
                      <p>路径修改后请重新检查。检测为不兼容的 exFAT、FAT、非本机原生 NTFS 或网络盘时只保存模型；运行库会自动放到本机兼容目录。</p>
                    </div>}
                    {!transcriptionEnvironment && !transcriptionCheckError && <div className="transcription-empty-check"><i />尚未检查。先选择听写服务、质量和模型，再检查这台电脑是否已经具备所需内容。</div>}
                    {transcriptionEnvironment && <>
                      {transcriptionEnvironment.diagnostics && !transcriptionEnvironment.diagnostics.healthy && <section className={`environment-agent-console ${transcriptionInstallBusy ? "running" : "idle"}`} aria-live="polite">
                        <header><div><span><i /> LOCAL ENV AGENT</span><strong>由第一页 AI 配置项目环境</strong></div><em>{engineVerified ? `${activeEngineLabel} · 已连接` : "等待第一页模型通过测试"}</em></header>
                        <div className="environment-agent-scope"><span>工作目录</span><code title={transcriptionEnvironment.environmentRoot}>{transcriptionEnvironment.environmentRoot}</code><b>仅项目目录</b></div>
                        <div className="environment-agent-terminal">
                          <p className="command"><b>$</b> gaku-env-agent inspect --harness transcription-environment-v1</p>
                          {transcriptionInstallEvents.length > 0
                            ? transcriptionInstallEvents.slice(-8).map((event, index) => <p className={event.kind} key={`${event.at}-${index}`}><i>{event.kind === "done" ? "✓" : event.kind === "error" ? "×" : "›"}</i><span>{event.text}</span></p>)
                            : transcriptionEnvironment.diagnostics.issues.filter((issue) => issue.id !== "last-install").map((issue) => <p className="pending" key={issue.id}><i>›</i><span><strong>{issue.label}</strong><small>{issue.repair}</small></span></p>)}
                          <p className="guard"><i>✓</i><span>Harness 已加载：模型只选择固定修复项，程序负责下载、校验、原子替换与最终复检</span></p>
                        </div>
                        <footer><div><strong>{transcriptionInstallBusy ? transcriptionInstallStage || "环境 Agent 正在工作" : `准备处理 ${transcriptionEnvironmentIssueCount} 个缺失项`}</strong><small>启动前仍会确认下载体积和目录；不执行模型生成的 Shell，不修改系统 Python。</small></div><div><button type="button" className="primary" onClick={() => void autoPrepareTranscriptionWithSelectedEngine()} disabled={!engineVerified || transcriptionInstallBusy || !transcriptionEnvironmentRoot.trim()}>{transcriptionInstallBusy ? `${Math.round(transcriptionInstallProgress)}% · 正在配置` : engineVerified ? "启动本地环境 Agent" : "先完成第一页模型测试"}</button><button type="button" onClick={askModelToDiagnoseTranscription} disabled={!engineVerified || transcriptionDiagnosisBusy}>{transcriptionDiagnosisBusy ? "分析中…" : "只分析原因"}</button></div></footer>
                        {transcriptionDiagnosis && <div className="environment-agent-advice"><span>AI PLAN</span><p>{transcriptionDiagnosis}</p></div>}
                        <details className="environment-technical-diagnostics"><summary>查看技术诊断与原始错误</summary><div>{transcriptionEnvironment.diagnostics.issues.map((issue) => <article key={issue.id}><strong>{issue.label}</strong><pre>{issue.detail}</pre><small>{issue.repair}</small></article>)}</div></details>
                      </section>}
                      <details className="environment-runtime-details"><summary>查看依赖清单、资源用量和运行目录</summary><div>
                      <div className="transcription-dependency-list">
                        {transcriptionEnvironment.components.map((component) => <div className={`transcription-dependency ${component.status}`} key={component.id}><i>{component.status === "ready" ? "✓" : component.status === "optional" ? "—" : "!"}</i><span><strong>{component.label}</strong><small>{component.detail}</small></span><em>{component.status === "ready" ? "已存在" : component.status === "optional" ? "未启用" : component.status === "degraded" ? "待配置" : "缺失"}</em></div>)}
                      </div>
                      <div className="transcription-resource-grid">
                        <span><small>本次待下载</small><strong>{transcriptionEnvironment.resources.pendingDownloadLabel || transcriptionEnvironment.resources.downloadLabel}</strong></span>
                        <span><small>建议可用内存</small><strong>{transcriptionEnvironment.resources.recommendedMemoryLabel}</strong></span>
                        <span className={transcriptionEnvironment.resources.memorySufficient ? "ok" : "warn"}><small>本机内存</small><strong>{transcriptionEnvironment.resources.systemMemoryLabel}</strong></span>
                        <span className={transcriptionEnvironment.resources.diskSufficient ? "ok" : "warn"}><small>缓存盘可用</small><strong>{transcriptionEnvironment.resources.freeDiskLabel}</strong></span>
                      </div>
                      {transcriptionEnvironment.managedRuntime && <div className={`transcription-managed-runtime ${transcriptionEnvironment.managedRuntime.supported ? "supported" : "fallback"}`}>
                        <div className="transcription-managed-runtime-title"><span>APP-MANAGED RUNTIME</span><strong>应用托管运行时</strong><em>{transcriptionEnvironment.managedRuntime.platform}</em></div>
                        <div className="transcription-managed-runtime-grid">
                          <span><i className={transcriptionEnvironment.managedRuntime.uvReady ? "ready" : "pending"} /><small>工具链</small><strong>uv {transcriptionEnvironment.managedRuntime.uvVersion}</strong><em>{transcriptionEnvironment.managedRuntime.uvReady ? "已就绪" : transcriptionEnvironment.managedRuntime.supported ? "首次配置自动下载" : "兼容回退"}</em></span>
                          <span><i className={transcriptionEnvironment.managedRuntime.pythonReady ? "ready" : "pending"} /><small>Python</small><strong>{transcriptionEnvironment.managedRuntime.pythonVersion}</strong><em>{transcriptionEnvironment.managedRuntime.pythonReady ? "独立环境已就绪" : "由程序自动准备"}</em></span>
                          <span><i className={transcriptionEnvironment.managedRuntime.nativeToolsReady ? "ready" : "pending"} /><small>媒体工具</small><strong>FFmpeg / FFprobe</strong><em>{transcriptionEnvironment.managedRuntime.nativeToolsReady ? "项目运行时已就绪" : `固定版本 ${transcriptionEnvironment.managedRuntime.nativeToolsVersion || "待准备"}`}</em></span>
                          <span><i className="ready" /><small>环境隔离</small><strong>ASR / 说话人分离独立</strong><em>失败不覆盖可用环境</em></span>
                        </div>
                        <p>{transcriptionEnvironment.managedRuntime.isolation}。版本指纹：ASR {transcriptionEnvironment.managedRuntime.baseEnvironmentKey} · 分离引擎 {transcriptionEnvironment.managedRuntime.diarizationEnvironmentKey}</p>
                      </div>}
                      {transcriptionEnvironment.storageLayout && <div className={`transcription-storage-layout ${transcriptionEnvironment.storageLayout.mode}`}><span>{transcriptionEnvironment.storageLayout.mode === "split" ? "已自动保护" : "项目内运行"}</span><div><strong>{transcriptionEnvironment.storageLayout.mode === "split" ? "外接盘保存模型，本机保存运行库" : "运行库和模型都可安全放在项目目录"}</strong><small>{transcriptionEnvironment.storageLayout.filesystem.toUpperCase()} · {transcriptionEnvironment.storageLayout.reason}</small></div></div>}
                      <p className={`transcription-recommendation ${transcriptionRequestedReady ? "ready" : "attention"}`}>{transcriptionRequestedReady ? "✓ " : ""}{transcriptionEnvironment.recommendation}</p>
                      {transcriptionDiarizationNeedsSetup && <section className="transcription-enhancement-action" aria-live="polite">
                        <div><span>OPTIONAL ENHANCEMENT</span><strong>{transcriptionDiarizationEngine === "sherpa_onnx" ? "Sherpa-ONNX 尚未准备" : "WhisperX / pyannote 尚未准备"}</strong><small>{transcriptionDiarizationEngine === "sherpa_onnx" ? `将下载 ${transcriptionEnvironment.resources.diarizationDownloadLabel || "约 47 MB"} 模型并创建独立本地环境，不修改系统 Python` : "需要 Hugging Face 模型权限；可打开配置填写 Token 并确认条款"}</small><code title={transcriptionEnvironment.diarizationRuntimePath}>{transcriptionEnvironment.diarizationRuntimePath}</code></div>
                        <div className="transcription-enhancement-actions">
                          {transcriptionDiarizationEngine === "sherpa_onnx" ? <button type="button" className="primary" onClick={() => void prepareDiarizationEnvironment()} disabled={transcriptionInstallBusy || transcriptionEnvironment.installationCapabilities?.diarization === false || !transcriptionEnvironmentRoot.trim()}>{transcriptionInstallBusy ? transcriptionInstallStage || "正在配置…" : `下载 ${transcriptionEnvironment.resources.diarizationDownloadLabel || "约 47 MB"} 并配置`}</button> : <button type="button" className="primary" onClick={() => { setTranscriptionInstallDiarization(true); setTranscriptionInstallOpen(true); window.setTimeout(() => document.querySelector(".transcription-download-panel")?.scrollIntoView({ behavior: "smooth", block: "center" }), 50); }}>打开配置与授权</button>}
                          <button type="button" onClick={() => void continueWithoutDiarization()} disabled={transcriptionInstallBusy}>暂不使用说话人分离</button>
                        </div>
                      </section>}
                      <div className="transcription-cache-path"><span>基础运行环境</span><code>{transcriptionEnvironment.runtimePath}</code></div>
                      <div className="transcription-cache-path"><span>说话人分离环境</span><code>{transcriptionEnvironment.diarizationRuntimePath || "启用后自动创建"}</code></div>
                      <div className="transcription-cache-path"><span>模型缓存</span><code>{transcriptionEnvironment.cachePath}</code></div>
                      </div></details>
                      {transcriptionMode === "local" && transcriptionProvider === "faster_whisper" && transcriptionNeedsEnvironmentSetup && <div className="transcription-download-panel">
                        <button className={`transcription-download-toggle ${transcriptionInstallOpen ? "open" : "manual"}`} aria-expanded={transcriptionInstallOpen} onClick={() => { setTranscriptionInstallOpen((value) => !value); setTranscriptionInstallConfirmed(false); }}>
                          <i aria-hidden="true">{transcriptionInstallOpen ? "✓" : "⚙"}</i>
                          <span><strong>{transcriptionInstallOpen ? "收起手动配置" : transcriptionDiarizationNeedsSetup ? "手动配置说话人分离" : "手动选择配置项"}</strong><small>{transcriptionInstallOpen ? "配置内容已展开，可在下方确认" : "本地环境 Agent 是推荐方式；熟悉依赖时也可以手动选择固定白名单项"}</small></span>
                          <em aria-hidden="true">{transcriptionInstallOpen ? "⌃" : "→"}</em>
                        </button>
                        {transcriptionInstallOpen && <div className="transcription-install-options">
                          <p>模型与项目数据保存到 <code>{transcriptionEnvironment.environmentRoot}</code>；Python 与 FFmpeg/FFprobe 由程序按文件系统放入项目运行目录，不修改系统环境。当前安装方式：{transcriptionEnvironment.installer || "自动选择"}。</p>
                          {(transcriptionInstallBusy || transcriptionInstallProgress > 0) && <div className={`transcription-install-progress ${transcriptionInstallProgress >= 100 ? "complete" : ""}`} aria-live="polite"><div><strong>{transcriptionInstallStage || "等待开始"}</strong><span>{Math.round(transcriptionInstallProgress)}%</span></div><progress max="100" value={transcriptionInstallProgress} /><ol><li className={transcriptionInstallProgress >= 6 ? "done" : "active"}>工具链</li><li className={transcriptionInstallProgress >= 10 ? "done" : ""}>独立 Python</li><li className={transcriptionInstallProgress >= 28 ? "done" : ""}>运行库</li><li className={transcriptionInstallProgress >= 55 ? "done" : ""}>模型</li><li className={transcriptionInstallProgress >= 92 ? "done" : ""}>验证</li></ol></div>}
                          <label aria-label="安装基础听写运行库" htmlFor="install-transcription-runtime"><input id="install-transcription-runtime" type="checkbox" checked={transcriptionInstallRuntime} disabled={transcriptionRuntimeReady || (transcriptionInstallModel && !transcriptionRuntimeReady)} onChange={(event) => { setTranscriptionInstallRuntime(event.target.checked); setTranscriptionInstallConfirmed(false); }} /><span><strong>基础听写运行库{transcriptionRuntimeReady ? " · 已就绪" : ""}</strong><small>{transcriptionRuntimeReady ? "已通过完整导入验证，不会重复安装" : "Faster-Whisper 与 CTranslate2，约 250 MB；缺失时是下载模型的必要项。若本机缺少 Python 3.11，首次还会准备约 80 MB 的独立运行环境"}</small></span></label>
                          <label aria-label={`下载 ${transcriptionModel} 模型`} htmlFor="install-transcription-model"><input id="install-transcription-model" type="checkbox" checked={transcriptionInstallModel} disabled={transcriptionModelReady} onChange={(event) => { const checked = event.target.checked; setTranscriptionInstallModel(checked); if (checked && !transcriptionRuntimeReady) setTranscriptionInstallRuntime(true); setTranscriptionInstallConfirmed(false); }} /><span><strong>下载 {transcriptionModel} 模型{transcriptionModelReady ? " · 已缓存" : ""}</strong><small>{transcriptionModelReady ? "模型快照已通过完整性检查，不会重复下载" : `约 ${transcriptionEnvironment.resources.downloadLabel}，保存到上方缓存位置`}</small></span></label>
                          <label aria-label="安装项目媒体工具链" htmlFor="install-transcription-media-tools"><input id="install-transcription-media-tools" type="checkbox" checked={transcriptionInstallMediaTools} disabled={transcriptionMediaToolsReady || transcriptionEnvironment.installationCapabilities?.mediaTools === false} onChange={(event) => { setTranscriptionInstallMediaTools(event.target.checked); setTranscriptionInstallConfirmed(false); }} /><span><strong>FFmpeg / FFprobe 项目工具链{transcriptionMediaToolsReady ? " · 已就绪" : ""}</strong><small>{transcriptionMediaToolsReady ? "项目运行目录中的两个工具均已通过检查，不依赖系统安装" : transcriptionEnvironment.installationCapabilities?.mediaTools === false ? "当前平台暂未提供项目托管资产" : `${transcriptionEnvironment.resources.nativeToolsDownloadLabel || "约 64 MB"}；下载后进行 SHA256 和启动校验，只写入上方项目运行目录`}</small></span></label>
                          <label aria-label="安装本地说话人分离" htmlFor="install-transcription-diarization"><input id="install-transcription-diarization" type="checkbox" checked={transcriptionInstallDiarization} disabled={transcriptionDiarizationReady || transcriptionEnvironment.installationCapabilities?.diarization === false} onChange={(event) => { setTranscriptionInstallDiarization(event.target.checked); setTranscriptionInstallConfirmed(false); }} /><span><strong>{transcriptionDiarizationEngine === "sherpa_onnx" ? "Sherpa-ONNX 本地说话人分离（推荐）" : "WhisperX / pyannote（高级）"}{transcriptionDiarizationReady ? " · 已就绪" : ""}</strong><small>{transcriptionDiarizationReady ? "运行库与模型均已通过检查，不会重复安装" : transcriptionEnvironment.installationCapabilities?.diarization === false ? `当前平台没有托管工具链，且 ${transcriptionEnvironment.installationCapabilities.systemPython} 不满足 Python 3.10–3.13` : transcriptionDiarizationEngine === "sherpa_onnx" ? `安装独立 CPU 运行库并下载 ${transcriptionEnvironment.resources.diarizationDownloadLabel || "约 47 MB"} 校验模型；无需账号或 Hugging Face Token` : "使用独立临时环境安装并深度验证；需要 Hugging Face gated 模型权限"}</small></span></label>
                          <label aria-label="确认听写环境下载" className="transcription-install-confirm" htmlFor="confirm-transcription-install"><input id="confirm-transcription-install" type="checkbox" checked={transcriptionInstallConfirmed} onChange={(event) => setTranscriptionInstallConfirmed(event.target.checked)} /><span><strong>我已确认下载内容、体积和保存位置</strong><small>只有勾选后才允许联网安装或下载；Python 与媒体工具均使用应用自己的运行目录，不修改系统环境</small></span></label>
                          <button className="primary-install-button" disabled={!transcriptionEnvironment.installable || !transcriptionInstallSelectionSupported || !transcriptionEnvironmentRoot.trim() || !transcriptionInstallConfirmed || transcriptionInstallBusy || !transcriptionHasInstallSelection} onClick={() => void prepareTranscriptionEnvironment()}>{transcriptionInstallBusy ? transcriptionInstallStage || "正在准备…" : "按所选项配置项目环境"}</button>
                          {transcriptionInstallEvents.length > 0 && <div className="transcription-install-log">{transcriptionInstallEvents.map((event, index) => <div className={event.kind} key={`${event.at}-${index}`}><i />{event.text}</div>)}</div>}
                        </div>}
                      </div>}
                    </>}
                    {transcriptionCheckError && <p className="transcription-check-error">{transcriptionCheckError}</p>}
                    </details>
                  </section>
                  {transcriptionEnvironment?.ready && canTestTranscriptionSample && <section className={`transcription-sample-test ${transcriptionTestStage}`}>
                    <div><span>OPTIONAL QUALITY TEST</span><strong>可选：用当前视频测试约 20 秒</strong><small>不影响开始翻译；想先确认听写内容、语言与时间信息时再运行。</small></div>
                    {transcriptionMode === "api" && <label aria-label="确认上传约二十秒音频进行可选听写测试" className="transcription-upload-confirm" htmlFor="confirm-transcription-upload"><input id="confirm-transcription-upload" type="checkbox" checked={transcriptionUploadConfirmed} onChange={(event) => { setTranscriptionUploadConfirmed(event.target.checked); setTranscriptionTestStage("idle"); setTranscriptionTestDetail("尚未测试（可选，不影响后续）"); }} /><span><strong>允许上传约 20 秒音频到所选服务</strong><small>只用于本次可选测试；本地听写不会上传。</small></span></label>}
                    <button className="secondary-button" onClick={testTranscriptionWithSample} disabled={!source.trim() || transcriptionTestStage === "running" || (transcriptionMode === "api" && !transcriptionUploadConfirmed)}>{transcriptionTestStage === "running" ? transcriptionTestDetail : transcriptionTestStage === "passed" ? "重新运行可选测试" : "运行可选音频测试"}</button>
                    <p className={`transcription-test-status ${transcriptionTestStage}`}>{transcriptionTestStage === "passed" ? "✓ " : transcriptionTestStage === "failed" ? "未通过：" : ""}{transcriptionTestDetail}</p>
                    {transcriptionTestResult && <div className="transcription-test-result"><header><span>{transcriptionTestResult.sampleStart.toFixed(1)}–{(transcriptionTestResult.sampleStart + transcriptionTestResult.sampleDuration).toFixed(1)} 秒</span><span>{transcriptionTestResult.language} · {transcriptionTestResult.model}</span></header><p>{transcriptionTestResult.text}</p></div>}
                  </section>}
                  {transcriptionEnvironment?.ready && !canTestTranscriptionSample && <p className="transcription-remote-test-note">网络视频会在任务中先获取到本地再进入正式听写；可选音频测试不会要求提前下载整段视频。</p>}
                </div>
                </fieldset>
            </section>

            <section ref={(node) => { workflowStepRefs.current.research = node; }} className={`panel research-panel workflow-step ${cameraFocus === "research" ? "camera-focused" : ""}`}>
                <div className="panel-title-row">
                  <div><span className="section-index">03</span><h2>检索并检查预习结果</h2></div>
                  <span className={researchReady ? "step-status verified" : "step-status pending"}><i />{researchReady ? "文档已生成" : engineVerified ? "可开始检索" : "可先填写关键词"}</span>
                </div>
                <fieldset className="step-fields">
                <p className="panel-intro"><strong>{activeEngineLabel}</strong> 会用下面的关键词决定查什么、核对证据并整理预习文档；搜索 MCP 只负责执行查询与打开网页，再交给你检查修正。</p>
                <div className="research-required-item"><span>固定检索项</span><strong>人物／成员色与应援色</strong><small>自动识别主要人物并查找角色色、成员色或出演者应援色；优先官方来源，找不到时在文档中标记待核实。</small></div>
                <label className="field-label" htmlFor="keyword">知识关键词</label>
                <div className="tag-editor">
                  {keywords.map((keyword) => (
                    <span key={keyword}>{keyword}<button aria-label={`移除 ${keyword}`} onClick={() => { setKeywords((items) => items.filter((item) => item !== keyword)); setResearchPreview(""); }}>×</button></span>
                  ))}
                  <input id="keyword" value={keywordDraft} onChange={(event) => setKeywordDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addKeyword(); } }} placeholder="输入作品、人物或活动名，回车添加" />
                </div>
                <div className="site-grid">
                  {researchSites.map((site) => (
                    <button key={site.id} className={`site-choice ${selectedSites.includes(site.id) ? "selected" : ""}`} onClick={() => toggleSite(site.id)}>
                      <span className="site-check">{selectedSites.includes(site.id) ? "✓" : ""}</span>
                      <span><strong>{site.label}</strong><small>{site.hint}</small></span>
                    </button>
                  ))}
                </div>
                <label className="field-label" htmlFor="custom-sites">自定义优先站点</label>
                <input id="custom-sites" value={customSites} onChange={(event) => { setCustomSites(event.target.value); setResearchPreview(""); }} placeholder="例如 bang-dream.com, mygo-movie.jp（逗号分隔）" />
                <div className="search-tool-card">
                  <div className="search-tool-heading">
                    <div><span>WEB SEARCH TOOL</span><strong>给第一步模型配置联网检索</strong><small>{activeEngineLabel} 负责规划查询、判断证据与归纳；搜索工具只负责找网页和打开正文。</small></div>
                    <span className={`search-test-state ${searchTest.stage}`}>{searchTest.stage === "passed" ? "● 已连通" : searchTest.stage === "running" ? "● 测试中" : searchTest.stage === "failed" ? "● 未通过" : "○ 待测试"}</span>
                  </div>
                  <div className="search-tool-grid">
                    <div><label className="field-label" htmlFor="search-provider">搜索工具</label><select id="search-provider" value={searchProvider} onChange={(event) => chooseSearchProvider(event.target.value)}>{Object.entries(searchPresets).filter(([id]) => engineMode === "cli" || id !== "builtin").map(([id, preset]) => <option key={id} value={id}>{preset.label}</option>)}</select></div>
                    {searchProvider !== "builtin" && <div><label className="field-label" htmlFor="search-mcp-url">MCP 地址</label><input id="search-mcp-url" value={searchMcpUrl} onChange={(event) => { setSearchMcpUrl(event.target.value); setSearchTest({ stage: "idle", detail: "地址已修改，请重新测试" }); setResearchPreview(""); }} placeholder="https://…/mcp" /></div>}
                    {searchProvider !== "builtin" && <div><label className="field-label" htmlFor="search-api-key">搜索 API Key {searchPresets[searchProvider]?.keyOptional && <em>可选</em>}</label><input id="search-api-key" type="password" autoComplete="off" value={searchApiKey} onChange={(event) => { setSearchApiKey(event.target.value); setSearchTest({ stage: "idle", detail: "密钥已修改，请重新测试" }); }} placeholder={searchPresets[searchProvider]?.keyOptional ? "可留空；仅随当前进程传递" : "填写搜索服务的 API Key"} /></div>}
                    <button className="search-test-button" onClick={testSearchTool} disabled={searchTest.stage === "running" || (searchProvider !== "builtin" && !searchMcpUrl.trim()) || (!searchPresets[searchProvider]?.keyOptional && !searchApiKey.trim())}>{searchTest.stage === "running" ? "正在连接…" : "测试搜索工具"}</button>
                  </div>
                  <p className={`search-test-detail ${searchTest.stage}`}>{searchTest.detail} · {searchPresets[searchProvider]?.note} · 验证通过后自动沿用相同配置</p>
                </div>
                {(researchBusy || researchEvents.length > 0) && <div className={`research-live ${researchBusy ? "running" : "finished"}`} aria-live="polite">
                  <div className="research-live-heading"><div><i /><strong>检索过程</strong></div><span>{researchStage}</span></div>
                  <div className="research-live-feed">{researchEvents.length ? researchEvents.map((event, index) => <div className={`research-live-event ${event.kind}`} key={`${event.text}-${index}`}><i /><span>{event.text}</span></div>) : <div className="research-live-empty"><i />{activeEngineLabel} 正在连接搜索工具，第一条查询出现后会显示在这里</div>}</div>
                  <p>这里只展示搜索词、工具动作、来源和整理状态，不展示或伪造模型的隐藏思维链。</p>
                </div>}
                <div className="research-actions">
                  <button className="research-primary" onClick={() => engineVerified ? void generateResearchPreview() : focusPrepareStage("engine")} disabled={researchBusy || !keywords.length}>{researchBusy ? `${activeEngineLabel} 正在检索与整理…` : !engineVerified ? "填写完成 · 去测试模型后检索" : researchPreview ? "重新检索并生成结果文档" : "检索并生成预习结果文档"}</button>
                  <button onClick={() => researchPreview ? setResearchOpen(true) : void generateResearchPreview()}>预览与修正</button>
                  <button onClick={() => setKnowledgeOpen(true)}>知识库 <span>{knowledgeIds.length || knowledgeEntries.length}</span></button>
                </div>
                <p className="field-help">这里输出的是 Agent 已经检索并归纳的信息，不是“准备去检索”的空模板。保存到知识库后可复用于其他视频。</p>
                </fieldset>
            </section>

            <section ref={(node) => { workflowStepRefs.current.harness = node; }} className={`panel harness-panel workflow-step ${cameraFocus === "harness" ? "camera-focused" : ""}`}>
                <div className="harness-heading"><div><span className="section-index">04</span><strong>Precision harness</strong></div><button onClick={() => setHarnessOpen(true)}>{harnessChanged ? "已修改 · 查看" : "查看 / 修改"}</button></div>
                <p>内置可审计的 8 阶段字幕流水线，默认直接采用，无需额外确认</p>
                <ol>
                  {phaseDefinitions.map(([, label], index) => <li key={label}><span>{index + 1}</span>{label}{index === 1 && <em>研究门槛</em>}</li>)}
                </ol>
                <label className="ambiguity-review-control">
                  <span><strong>第 5 步 · 疑点复核强度</strong><small>{ambiguityReviewPresets[ambiguityReviewMode].hint}</small></span>
                  <select aria-label="疑点复核强度" value={ambiguityReviewMode} onChange={(event) => setAmbiguityReviewMode(event.target.value as AmbiguityReviewMode)}>
                    {Object.entries(ambiguityReviewPresets).map(([value, preset]) => <option value={value} key={value}>{preset.label}</option>)}
                  </select>
                </label>
                <div className="harness-rule identity-pair-rule"><span>✓</span><p><strong>人物身份成对、只建一个元素</strong>角色名与对应声优写在同一人物实体中，不拆成两个人；同时判断当前素材中是“角色发言”还是“声优本人发言”。</p></div>
                <div className="harness-rule"><span>✓</span><label className="harness-rule-editor"><strong>成片约束 <em>{confirmedDeliveryConstraints === deliveryConstraints ? "已保存" : "待保存"}</em></strong><div><input aria-label="成片约束" value={deliveryConstraints} onChange={(event) => setDeliveryConstraints(event.target.value)} /><button type="button" disabled={!deliveryConstraints.trim() || confirmedDeliveryConstraints === deliveryConstraints} onClick={() => { const normalized = deliveryConstraints.trim(); setDeliveryConstraints(normalized); setConfirmedDeliveryConstraints(normalized); }}>{confirmedDeliveryConstraints === deliveryConstraints ? "已保存" : "保存"}</button></div></label></div>
                {currentExternalProcessingPlan.required && <section className={externalConsentChecked ? "inline-external-consent granted" : "inline-external-consent"}>
                  <div className="inline-external-consent-heading"><span>EXTERNAL PROCESSING</span><strong>当前任务的外部模型处理</strong><small>授权只适用于本次任务，不保存 API Key，也不授权公开或转发视频。</small></div>
                  <div className="inline-external-consent-summary"><span><b>接收服务</b>{currentExternalProcessingPlan.services.map((service) => `${service.provider} / ${service.model}`).join("、")}</span><span><b>发送范围</b>{currentExternalProcessingPlan.dataTypes.join("、")}</span></div>
                  <label><input aria-label="允许当前任务使用外部模型" type="checkbox" checked={externalConsentChecked} onChange={(event) => setExternalConsentChecked(event.target.checked)} /><span><strong>允许上述服务仅为本次字幕任务处理这些数据</strong><small>{transcriptionMode === "api" ? "在线听写会发送分块音频；媒体始终按磁盘分块处理。" : "本地听写不会上传整段音视频；只发送文本与必要的疑点画面裁切。"}</small></span></label>
                </section>}
            </section>

            {cameraFocus === "harness" && <div className="workflow-launch">
              <label className="trace-option"><input aria-label="显示 Agent 执行轨迹" type="checkbox" checked={showTrace} onChange={(event) => setShowTrace(event.target.checked)} /><span><strong>显示 Agent 执行轨迹</strong><small>查看工具动作与推理摘要，不展示隐藏思维链</small></span></label>
              <button className="primary-action" onClick={() => void startTranslation()}><span>▶</span><strong>开始翻译并统一检查</strong><small>{engineVerified && videoReady && transcriptionReadyForCamera && researchReady && (!currentExternalProcessingPlan.required || externalConsentChecked) ? "所有准备项已完成，点击后创建任务" : "缺项会准确定位回对应步骤；已经填写的内容不会丢失"}</small></button>
              <p className="resource-note">低内存模式：单任务串行执行、媒体按需解码、日志自动轮转；长时间无进度会保存断点并停止。</p>
            </div>}
          </div>
          </div>
          <aside className="workflow-overview" aria-label="准备阶段工作流">
            <header><div><span>准备阶段</span><strong>工作流概览</strong></div><div><button className="overview-defaults" onClick={applyEasyDefaults} disabled={bridgeStatus !== "online"}>推荐配置</button><small>当前第 {cameraFocus === "engine" ? 1 : cameraFocus === "source" ? 2 : cameraFocus === "research" ? 3 : 4} 步</small></div></header>
            <div className="workflow-overview-list">
              <button className={cameraFocus === "engine" ? "active" : ""} onClick={() => focusPrepareStage("engine")}><i>1</i><span><SlidersHorizontal size={26} /><span><span className="workflow-overview-title"><strong>设置并测试翻译引擎</strong><em className={engineVerified ? "done" : ""}>{engineVerified ? "已通过" : "进行中"}</em></span><small>选择模式与模型，完成能力测试</small></span></span><CaretRight size={18} /></button>
              <button className={cameraFocus === "source" ? "active" : ""} onClick={() => focusPrepareStage("source")}><i>2</i><span><FilmStrip size={26} /><span><span className="workflow-overview-title"><strong>视频与输出</strong><em className={videoReady ? "done" : ""}>{videoReady ? "已设置" : "待配置"}</em></span><small>视频来源、听写和输出格式</small></span></span><CaretRight size={18} /></button>
              <button className={cameraFocus === "research" ? "active" : ""} onClick={() => focusPrepareStage("research")}><i>3</i><span><MagnifyingGlass size={26} /><span><span className="workflow-overview-title"><strong>检索并检查预习结果</strong><em className={researchReady ? "done" : ""}>{researchReady ? "已生成" : "待执行"}</em></span><small>检索背景知识并核对证据</small></span></span><CaretRight size={18} /></button>
              <button className={cameraFocus === "harness" ? "active" : ""} onClick={() => focusPrepareStage("harness")}><i>4</i><span><Target size={26} /><span><span className="workflow-overview-title"><strong>Precision harness</strong><em className={harnessReady ? "done" : ""}>{harnessReady ? "已启用" : "加载中"}</em></span><small>默认采用，可按需修改执行规范</small></span></span><CaretRight size={18} /></button>
            </div>
            <section className="workflow-next-action"><span>下一步行动</span><strong>配置视频与听写</strong><button onClick={() => focusPrepareStage("source")}><FilmStrip size={17} />去配置视频与听写<CaretRight size={16} /></button></section>
          </aside>
          </div>
        </main>
      )}

      {workspace === "running" && (
        <main className="running-page">
          <section className="run-hero">
            <div className="run-orbit" style={{ "--progress": `${progress}%` } as CSSProperties}><span>{Math.round(progress)}%</span></div>
            <p className="eyebrow">TRANSLATION IN PROGRESS</p>
            <h1>{runMessage}</h1>
            <p>可以离开这个页面，本地 Agent 会继续执行并把进度写入任务清单。</p>
          </section>
          <section className="panel run-panel">
            <div className="progress-header"><strong>总进度</strong><span>{Math.round(progress)}%</span></div>
            <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
            {jobResources && <div className="run-metrics"><span><small>本轮</small><strong>第 {jobResources.attempt} 次</strong></span><span><small>已用时间</small><strong>{formatElapsed(jobResources.elapsedMs)}</strong></span><span><small>任务文件</small><strong>{jobResources.diskLabel}</strong></span><span title={jobResources.process ? `共 ${jobResources.process.processCount || 1} 个任务子进程；上限 ${jobResources.policy?.memoryLimitLabel || "自动"}` : "任务进程未运行"}><small>进程树内存</small><strong>{jobResources.process?.rssLabel || "未运行"}{jobResources.process && jobResources.policy?.memoryLimitLabel ? ` / ${jobResources.policy.memoryLimitLabel}` : ""}</strong></span><span><small>CPU</small><strong>{jobResources.process ? `${jobResources.process.cpuPercent.toFixed(1)}%` : "—"}</strong></span></div>}
            <div className="phase-list">
              {phaseDefinitions.map(([id, label, description], index) => {
                const status = phaseStates[id] ?? "pending";
                const detail = phaseDetails[id];
                return <button className={`phase-item ${status} ${selectedPhaseId === id ? "selected" : ""}`} key={id} title={detail?.detail || detail?.evidence?.at(-1) || ""} onClick={() => setSelectedPhaseId((current) => current === id ? "" : id)}>
                  <span className="phase-number">{status === "done" ? "✓" : index + 1}</span>
                  <div><strong>{label}</strong><small>{detail?.detail || detail?.evidence?.at(-1) || description}</small>{id === "resolve_ambiguities" && detail?.riskSummary && <em>自动放行 {detail.riskSummary.auto_released || 0} · 重点复核 {detail.riskSummary.deep_reviewed || 0} · 留待精修 {detail.riskSummary.needs_refine || 0}</em>}{detail?.durationMs != null && <em>{formatElapsed(detail.durationMs)}</em>}</div>
                  <span className="phase-status">{statusLabel(status)}</span>
                </button>;
              })}
            </div>
            {selectedPhaseId && phaseDetails[selectedPhaseId] && <section className="phase-detail-panel"><header><strong>{phaseDefinitions.find(([id]) => id === selectedPhaseId)?.[1]}详情</strong><button onClick={() => setSelectedPhaseId("")}>×</button></header>{phaseDetails[selectedPhaseId].detail && <p>{phaseDetails[selectedPhaseId].detail}</p>}{phaseDetails[selectedPhaseId].riskSummary && <div className="phase-risk-summary"><span>候选 {phaseDetails[selectedPhaseId].riskSummary?.total || 0}</span><span>重点复核 {phaseDetails[selectedPhaseId].riskSummary?.deep_reviewed || 0}</span><span>自动放行 {phaseDetails[selectedPhaseId].riskSummary?.auto_released || 0}</span><span>留待精修 {phaseDetails[selectedPhaseId].riskSummary?.needs_refine || 0}</span></div>}<div className="phase-detail-times"><span>开始：{phaseDetails[selectedPhaseId].startedAt ? new Date(phaseDetails[selectedPhaseId].startedAt!).toLocaleString() : "未记录"}</span><span>结束：{phaseDetails[selectedPhaseId].finishedAt ? new Date(phaseDetails[selectedPhaseId].finishedAt!).toLocaleString() : "未结束"}</span></div>{phaseDetails[selectedPhaseId].evidence.length > 0 && <div className="phase-evidence">{phaseDetails[selectedPhaseId].evidence.map((item, index) => <small key={`${index}-${item}`}>• {item}</small>)}</div>}</section>}
            {showTrace && <section className="trace-panel"><div className="trace-heading"><strong>Agent 执行轨迹</strong><span>{trace.length ? "实时更新" : "等待模型输出"}</span></div><div className="trace-feed">{trace.length ? trace.map((event, index) => <div className={`trace-event ${event.kind}`} key={`${index}-${event.text}`}><i /> <span>{event.text}</span></div>) : <div className="trace-empty">任务启动后，这里会显示检索、读取、媒体处理和阶段摘要。</div>}</div></section>}
            {manifestLimitations.length > 0 && <section className="run-limitations"><strong>当前限制</strong>{manifestLimitations.map((item, index) => <small key={`${index}-${item}`}>• {item}</small>)}</section>}
            {manifestNotices.length > 0 && <section className="run-notices"><strong>成片说明</strong>{manifestNotices.map((item, index) => <small key={`${index}-${item}`}>• {item}</small>)}</section>}
            {jobDiagnostics?.stderr?.length ? <details className="run-diagnostics"><summary>查看错误日志摘要</summary><pre>{jobDiagnostics.stderr.join("\n")}</pre><small>日志位置：{jobDiagnostics.logPath}</small></details> : null}
            {jobBlocker && <section className="job-blocker"><header><span>需要处理</span><strong>{jobBlocker.label}</strong></header><p>{jobBlocker.detail}</p>{jobBlocker.evidence.length > 0 && <div>{jobBlocker.evidence.slice(-3).map((item, index) => <small key={`${index}-${item}`}>• {item}</small>)}</div>}<div className="job-blocker-actions"><button className="secondary-button" onClick={() => { setWorkspace("prepare"); if (jobBlocker.phase === "source_transcript") window.setTimeout(() => document.querySelector(".transcription-config")?.scrollIntoView({ behavior: "smooth", block: "center" }), 50); }}>返回设置并处理</button><button className="resume-button" disabled={resumeBusy} onClick={() => void resumeBlockedJob()}>{resumeBusy ? "正在续跑…" : `从${phaseDefinitions.find(([id]) => id === jobBlocker.phase)?.[1] || "阻塞阶段"}继续`}</button></div>{(!engineVerified || (transcriptionEnvironment && !transcriptionEnvironment.ready)) && <small className="resume-hint">点击继续时会重新核对模型凭据与听写环境；真实短音频测试是可选诊断。</small>}</section>}
            {runError && <div className="notice error"><strong>{jobConnectionFailures ? "正在重新连接" : jobBlocker ? "任务已阻塞" : "任务中断"}</strong><span>{runError}</span>{jobConnectionFailures > 0 && <button className="notice-retry" onClick={() => { setRunError(""); setJobPollRevision((value) => value + 1); }}>立即重试</button>}{!jobConnectionFailures && !jobBlocker && jobId && <button className="notice-retry" disabled={resumeBusy} onClick={() => void resumeBlockedJob()}>{resumeBusy ? "正在续跑…" : "从断点继续"}</button>}</div>}
            {jobRunStatus === "cancelled" && <section className="job-cancelled"><div><strong>任务已终止</strong><span>{runMessage || "Agent 与子进程已经停止；已完成阶段和现有文件均已保留。"}</span></div><button className="resume-button" disabled={resumeBusy} onClick={() => void resumeBlockedJob()}>{resumeBusy ? "正在续跑…" : "从断点继续"}</button></section>}
            <div className="run-footer"><span>任务 ID：{jobId || "创建中"}</span><button className="secondary-button" onClick={() => setWorkspace("prepare")}>返回设置</button><button className="secondary-button" onClick={loadDemo}>打开示例精修台</button></div>
          </section>
        </main>
      )}

      {workspace === "review" && (
        <main className="review-page" style={{ "--inspector-width": `${inspectorWidth}px`, "--preview-workspace-height": `${previewWorkspaceHeight}px`, "--timeline-height": `${timelineHeight}px`, "--sentence-editor-width": `${sentenceEditorWidth}px` } as CSSProperties}>
          <div className="review-toolbar">
            <div className="project-title"><button className="back-button" onClick={() => setWorkspace("prepare")}>‹</button><div><strong>{source || "MyGO 迷子集会 · 示例工程"}</strong><span>{cues.length} 句 · 日语 → 简体中文</span></div></div>
            <div className="review-history-actions" role="group" aria-label="撤回与重做">
              <button aria-label="撤回" title="撤回（⌘/Ctrl+Z）" disabled={!reviewHistory.past.length} onClick={undoReview}><ArrowCounterClockwise size={15} /><span>撤回</span></button>
              <button aria-label="重做" title="重做（⌘/Ctrl+Shift+Z 或 Ctrl+Y）" disabled={!reviewHistory.future.length} onClick={redoReview}><ArrowClockwise size={15} /><span>重做</span></button>
            </div>
            <div className="review-actions"><span className={`save-state ${saved ? "saved" : "dirty"}`}>{saved ? "已保存" : "有未保存修改"}</span><button className="secondary-button" onClick={saveRefinements}>同步精修</button><button className="export-button" onClick={exportProject}>导出 / 封装 <span>⌄</span></button></div>
          </div>

          {runError && <div className="review-notice notice error"><strong>提示</strong><span>{runError}</span><button onClick={() => setRunError("")}>×</button></div>}

          <div className="review-workspace">
            <section className="preview-column">
              <div className="video-stage">
                {previewUrl ? <video ref={videoRef} src={previewUrl} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)}><track kind="captions" src="data:text/vtt,WEBVTT" srcLang="zh-CN" label="中文字幕预览" default /></video> : <div className="video-placeholder"><div className="stage-grid" /><span>视频预览</span><small>选择本地文件即可在此预览；示例仅展示字幕效果</small></div>}
                {visibleCue && <div className="subtitle-safe-area" style={overlayStyle}>
                  <div className="subtitle-overlay"><span className="speaker-label">{visibleRole?.name}</span>{visibleCue.translation}</div>
                </div>}
                <button className="center-play" onClick={togglePlayback}>{isPlaying ? "Ⅱ" : "▶"}</button>
              </div>
              <div className="transport">
                <button onClick={() => seekTo(Math.max(0, currentTime - 5))}>−5s</button>
                <button className="transport-play" onClick={togglePlayback}>{isPlaying ? "Ⅱ" : "▶"}</button>
                <button onClick={() => seekTo(Math.min(timelineDuration, currentTime + 5))}>+5s</button>
                <span className="timecode">{formatTime(currentTime)} <i>/</i> {formatTime(timelineDuration)}</span>
                <div className="transport-spacer" />
                <button>音量</button><button>适配</button>
              </div>
            </section>

            <button type="button" className="workspace-resizer vertical" aria-label="调整视频预览与字幕样式面板宽度" onPointerDown={(event) => beginReviewResize(event, "preview-inspector", inspectorWidth)} onPointerMove={continueReviewResize} onPointerUp={finishReviewResize} onPointerCancel={finishReviewResize} onDoubleClick={() => setInspectorWidth(305)} onKeyDown={(event) => { if (event.key === "ArrowLeft") setInspectorWidth((value) => Math.min(560, value + 10)); if (event.key === "ArrowRight") setInspectorWidth((value) => Math.max(260, value - 10)); }}><span /></button>

            <aside className="inspector">
              <div className="inspector-tabs"><button className="active">字幕样式</button><button>画面</button></div>
              <div className="inspector-scroll">
                <section className="control-section"><div className="control-heading"><strong>排版</strong><button onClick={resetSubtitleTypography}>重置</button></div>
                  <label className="field-label" htmlFor="font-family">字体</label>
                  <select id="font-family" value={fontFamily} onChange={(event) => { if (event.target.value === fontFamily) return; rememberReviewState("style:font-family"); setFontFamily(event.target.value); setSaved(false); }}><option>Noto Sans CJK SC</option><option>Source Han Sans SC</option><option>PingFang SC</option><option>思源黑体</option></select>
                  <div className="mini-grid"><div><label className="field-label" htmlFor="font-size">字号</label><div className="number-input"><input id="font-size" type="number" min="18" max="96" value={fontSize} onChange={(event) => { const value = Number(event.target.value); if (value === fontSize) return; rememberReviewState("style:font-size", true); setFontSize(value); setSaved(false); }} /><span>px</span></div></div><div><label className="field-label" htmlFor="font-weight">字重</label><select id="font-weight" value={fontWeight} onChange={(event) => { const value = Number(event.target.value); if (value === fontWeight) return; rememberReviewState("style:font-weight"); setFontWeight(value); setSaved(false); }}><option value="500">中等</option><option value="700">粗体</option><option value="900">特粗</option></select></div></div>
                  <div className="constraint-banner"><span>2</span><p><strong>最多两行</strong>自动利用横向安全区，禁止第三行。</p><i>锁定</i></div>
                </section>
                <section className="control-section"><div className="control-heading"><strong>角色色效果</strong><span className="auto-badge">自动</span></div>
                  {[{ label: "外圈描边", value: outline, set: setOutline, max: 8 }, { label: "柔光", value: glow, set: setGlow, max: 20 }, { label: "投影", value: shadow, set: setShadow, max: 10 }].map((control) => <label className="range-control" key={control.label}><span>{control.label}<b>{control.value}px</b></span><input type="range" min="0" max={control.max} value={control.value} onChange={(event) => { const value = Number(event.target.value); if (value === control.value) return; rememberReviewState(`style:${control.label}`, true); control.set(value); setSaved(false); }} /></label>)}
                </section>
                <section className="control-section roles-section"><div className="control-heading"><strong>识别出的人物实体</strong><span>{roles.length} 位</span></div>
                  <p className="roles-section-hint">每行同时保存角色与声优，只按当前发言身份显示一个字幕名。</p>
                  <div className="role-list">{roles.map((role) => <div className="role-row" key={role.id}>
                    <input className="color-input" type="color" value={role.color} aria-label={`${role.name}颜色`} onChange={(event) => updateRole(role.id, { color: event.target.value }, { historyKey: `role:${role.id}:color`, coalesce: true })} />
                    <div className="role-identity-editor">
                      <div className="role-pair-inputs"><label><span>角色</span><input value={role.characterName || ""} placeholder="角色名" onChange={(event) => { const characterName = event.target.value; updateRole(role.id, { characterName, ...(role.speakingAs === "character" || (role.speakingAs === "unknown" && !role.performerName) ? { name: characterName || role.performerName || "未确认人物" } : {}) }, { historyKey: `role:${role.id}:character`, coalesce: true }); }} /></label><label><span>声优</span><input value={role.performerName || ""} placeholder="声优名" onChange={(event) => { const performerName = event.target.value; updateRole(role.id, { performerName, ...(role.speakingAs === "performer" || (role.speakingAs === "unknown" && !role.characterName) ? { name: performerName || role.characterName || "未确认人物" } : {}) }, { historyKey: `role:${role.id}:performer`, coalesce: true }); }} /></label></div>
                      <div className="role-speaking-as"><select aria-label={`${role.name}当前发言身份`} value={role.speakingAs || "unknown"} onChange={(event) => { const speakingAs = event.target.value as SpeakerIdentity; const name = speakingAs === "character" ? role.characterName || role.name : speakingAs === "performer" ? role.performerName || role.name : role.name; updateRole(role.id, { speakingAs, name }); }}><option value="character">角色发言</option><option value="performer">声优本人</option><option value="unknown">待确认</option></select><small>字幕标注：{role.name} · {speakerIdentityLabel(role.speakingAs)}</small><i style={{ background: role.color }} /></div>
                    </div>
                  </div>)}</div>
                  <button className="add-role" onClick={addReviewRole}>＋ 添加人物实体</button>
                </section>
              </div>
            </aside>
          </div>

          <button type="button" className="workspace-resizer horizontal" aria-label="调整视频预览工作区高度" onPointerDown={(event) => beginReviewResize(event, "preview-timeline", previewWorkspaceHeight)} onPointerMove={continueReviewResize} onPointerUp={finishReviewResize} onPointerCancel={finishReviewResize} onDoubleClick={() => setPreviewWorkspaceHeight(470)} onKeyDown={(event) => { if (event.key === "ArrowUp") setPreviewWorkspaceHeight((value) => Math.max(300, value - 10)); if (event.key === "ArrowDown") setPreviewWorkspaceHeight((value) => Math.min(800, value + 10)); }}><span /></button>

          <section className="timeline-panel">
            <div className="timeline-toolbar"><div className="timeline-tabs"><button className="active">时间轴</button><button>波形</button></div><div className="timeline-toolbox" aria-label="时间轴编辑工具"><button className={timelineTool === "select" ? "active" : ""} aria-label="选择工具" title="选择工具 (V)" onClick={() => setTimelineTool("select")}><CursorClick size={14} /></button><button className={timelineTool === "hand" ? "active" : ""} aria-label="手型平移工具" title="手型平移工具 (H)" onClick={() => setTimelineTool("hand")}><Hand size={14} /></button><button className={timelineTool === "delete" ? "active danger" : "danger"} aria-label="删除工具" title="删除工具 (D)，点击字幕块删除" onClick={() => setTimelineTool("delete")}><Trash size={14} /></button></div><div className="timeline-tools"><span className="timeline-shortcut">Shift + 滚轮缩放</span><span className="zoom-readout">{timelineZoom}%</span><button aria-label="缩小时间轴" onClick={() => changeTimelineZoom(timelineZoom - 10)}>−</button><input aria-label="时间轴缩放" type="range" min="20" max="200" value={timelineZoom} onChange={(event) => changeTimelineZoom(Number(event.target.value))} /><button aria-label="放大时间轴" onClick={() => changeTimelineZoom(timelineZoom + 10)}>＋</button><button onClick={fitTimeline}>适配全部</button></div></div>
            <div className="timeline-body">
              <div className="track-labels"><div>视频</div><div>字幕</div></div>
              <div className="timeline-scroll" ref={timelineScrollerRef}>
                <div className={`timeline-canvas tool-${timelineTool} ${timelinePanning ? "panning" : ""}`} style={{ width: `${timelineCanvasWidth}px` }} role="slider" tabIndex={0} aria-label="视频时间轴，可拖动播放头" aria-valuemin={0} aria-valuemax={Math.round(timelineDuration)} aria-valuenow={Math.round(currentTime)} onWheel={handleTimelineWheel} onKeyDown={(event) => { if (event.key === "ArrowLeft") seekTo(currentTime - 1); if (event.key === "ArrowRight") seekTo(currentTime + 1); if (event.key.toLowerCase() === "v") setTimelineTool("select"); if (event.key.toLowerCase() === "h") setTimelineTool("hand"); if (event.key.toLowerCase() === "d") setTimelineTool("delete"); if ((event.key === "Delete" || event.key === "Backspace") && timelineTool !== "hand") deleteCue(selectedCueId); }} onPointerDown={beginTimelineScrub} onPointerMove={continueTimelineScrub} onPointerUp={finishTimelineScrub} onPointerCancel={finishTimelineScrub}>
                  <div className="ruler">{rulerMarks.map((second) => <span key={second} style={{ left: `${(second / timelineDuration) * 100}%` }}>{formatTime(second, true)}</span>)}</div>
                  <div className="video-track"><div className="filmstrip">{Array.from({ length: Math.max(16, Math.ceil(timelineCanvasWidth / 65)) }, (_, index) => <i key={index} />)}</div></div>
                  <div className="subtitle-track">{cues.map((cue) => { const role = roles.find((item) => item.id === cue.speakerId); return <button key={cue.id} className={`subtitle-cue ${cue.id === selectedCueId ? "selected" : ""}`} style={{ left: `${(cue.start / timelineDuration) * 100}%`, width: `${Math.max(0.8, ((cue.end - cue.start) / timelineDuration) * 100)}%`, borderColor: role?.color }} aria-label={`${cue.translation}，拖动移动；拖动两端调整起止时间`} onPointerDown={(event) => { if (timelineTool === "select") beginCueDrag(event, cue, "move"); }} onPointerMove={continueCueDrag} onPointerUp={finishCueDrag} onPointerCancel={finishCueDrag} onClick={(event) => { event.stopPropagation(); if (suppressCueClickRef.current) { suppressCueClickRef.current = false; return; } if (timelineTool === "delete") { deleteCue(cue.id); return; } if (timelineTool === "select") seekTo(cue.start, cue.id); }}><span className="cue-color" style={{ background: role?.color }} /><span className="cue-trim cue-trim-start" title="拖动调整开始时间" onPointerDown={(event) => { if (timelineTool === "select") beginCueDrag(event, cue, "start"); }} /><span className="cue-label">{cue.translation}</span><span className="cue-trim cue-trim-end" title="拖动调整结束时间" onPointerDown={(event) => { if (timelineTool === "select") beginCueDrag(event, cue, "end"); }} /></button>; })}</div>
                  <div className="playhead" style={{ left: `${(currentTime / timelineDuration) * 100}%` }}><span /></div>
                </div>
              </div>
            </div>
          </section>

          <button type="button" className="workspace-resizer horizontal" aria-label="调整时间轴工作区高度" onPointerDown={(event) => beginReviewResize(event, "timeline-cues", timelineHeight)} onPointerMove={continueReviewResize} onPointerUp={finishReviewResize} onPointerCancel={finishReviewResize} onDoubleClick={() => setTimelineHeight(188)} onKeyDown={(event) => { if (event.key === "ArrowUp") setTimelineHeight((value) => Math.max(150, value - 10)); if (event.key === "ArrowDown") setTimelineHeight((value) => Math.min(360, value + 10)); }}><span /></button>

          <section className="cue-editor-panel">
            <div className="cue-list-column">
              <div className="cue-list-toolbar"><strong>逐句精修</strong><div className="cue-search"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索台词或角色" /></div><button className={onlyFlagged ? "filter active" : "filter"} onClick={() => setOnlyFlagged((value) => !value)}>⚑ 低置信度</button></div>
              <div className="cue-table-head"><span>#</span><span>时间</span><span>角色</span><span>原文 / 译文</span><span>置信度</span></div>
              <div className="cue-list">{filteredCues.map((cue) => { const role = roles.find((item) => item.id === cue.speakerId); return <button key={cue.id} className={`cue-row ${cue.id === selectedCueId ? "selected" : ""}`} onClick={() => { setSelectedCueId(cue.id); seekTo(cue.start); }}><span className="cue-index">{String(cue.id).padStart(2, "0")}{cue.flagged && <i>!</i>}</span><span className="cue-time">{formatTime(cue.start)}<small>{formatTime(cue.end)}</small></span><span className="cue-speaker"><i style={{ background: role?.color }} />{role?.name}</span><span className="cue-copy"><small>{cue.source}</small><strong>{cue.translation}</strong></span><span className={`confidence ${cue.confidence < 0.9 ? "low" : ""}`}>{Math.round(cue.confidence * 100)}%</span></button>; })}</div>
            </div>

            <button type="button" className="workspace-resizer vertical" aria-label="调整逐句列表与单句编辑器宽度" onPointerDown={(event) => beginReviewResize(event, "cue-editor", sentenceEditorWidth)} onPointerMove={continueReviewResize} onPointerUp={finishReviewResize} onPointerCancel={finishReviewResize} onDoubleClick={() => setSentenceEditorWidth(345)} onKeyDown={(event) => { if (event.key === "ArrowLeft") setSentenceEditorWidth((value) => Math.min(620, value + 10)); if (event.key === "ArrowRight") setSentenceEditorWidth((value) => Math.max(300, value - 10)); }}><span /></button>

            <aside className="sentence-editor">
              <div className="sentence-heading"><div><span>句子 {selectedCue.id}</span>{selectedCue.flagged && <em>低置信度</em>}</div><div><button aria-label="上一句" onClick={() => selectAdjacentCue(-1)}>‹</button><button aria-label="下一句" onClick={() => selectAdjacentCue(1)}>›</button></div></div>
              <label className="field-label" htmlFor="speaker">说话人</label>
              <select id="speaker" value={selectedCue.speakerId} onChange={(event) => updateCue({ speakerId: event.target.value })}>{roles.map((role) => <option key={role.id} value={role.id}>{role.name} · {speakerIdentityLabel(role.speakingAs)}</option>)}</select>
              <div className="time-editor"><div><label className="field-label" htmlFor="start-time">开始</label><input key={`start-${selectedCue.id}-${selectedCue.start}`} id="start-time" defaultValue={formatTime(selectedCue.start)} onBlur={(event) => { const value = parseTime(event.target.value); if (value !== null) updateCue({ start: value }); else event.target.value = formatTime(selectedCue.start); }} /></div><span>→</span><div><label className="field-label" htmlFor="end-time">结束</label><input key={`end-${selectedCue.id}-${selectedCue.end}`} id="end-time" defaultValue={formatTime(selectedCue.end)} onBlur={(event) => { const value = parseTime(event.target.value); if (value !== null) updateCue({ end: value }); else event.target.value = formatTime(selectedCue.end); }} /></div></div>
              <label className="field-label" htmlFor="source-copy">日语原文</label><textarea id="source-copy" rows={3} value={selectedCue.source} onChange={(event) => updateCue({ source: event.target.value }, { historyKey: `cue:${selectedCue.id}:source`, coalesce: true })} />
              <div className="translation-label"><label className="field-label" htmlFor="translation-copy">中文译文</label><span>{selectedCue.translation.replace(/\s/g, "").length} 字 · 预计 {Math.min(2, selectedCue.translation.split("\n").length)} 行</span></div>
              <textarea id="translation-copy" className="translation-textarea" rows={4} value={selectedCue.translation} onChange={(event) => updateCue({ translation: event.target.value }, { historyKey: `cue:${selectedCue.id}:translation`, coalesce: true })} />
              <div className="quality-flags"><button className={selectedCue.flagged ? "active" : ""} onClick={() => updateCue({ flagged: !selectedCue.flagged })}>⚑ 标记待复核</button><button onClick={() => seekTo(selectedCue.start)}>◎ 跳到画面 / OCR</button></div>
              <div className="timing-status"><span>✓</span><p><strong>时序已贴合语音</strong>字幕从说话开始出现，并在话音结束时消失。</p></div>
              <button className="save-sentence" onClick={saveRefinements}>保存本句 <kbd>⌘ ↵</kbd></button>
            </aside>
          </section>
        </main>
      )}

      {researchOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setResearchOpen(false); }}>
        <section className="studio-modal document-modal" role="dialog" aria-modal="true" aria-labelledby="research-modal-title">
          <header><div><span>RESEARCH RESULTS</span><h2 id="research-modal-title">已检索的预习结果文档</h2><p>这是 Agent 查找并归纳后的资料；请检查来源、置信度、人物和术语并修正。</p></div><button aria-label="关闭预习文档" onClick={() => setResearchOpen(false)}>×</button></header>
          <div className="modal-field"><label htmlFor="knowledge-title">文档标题</label><input id="knowledge-title" value={knowledgeTitle} onChange={(event) => setKnowledgeTitle(event.target.value)} /></div>
          <textarea className="document-editor" aria-label="预习文档内容" value={researchPreview} onChange={(event) => setResearchPreview(event.target.value)} spellCheck={false} />
          <footer><span>Markdown · 你的修订会进入本次任务</span><button onClick={() => setResearchOpen(false)}>确认结果并用于本次任务</button><button className="primary" onClick={saveToKnowledge}>加入知识库并使用</button></footer>
        </section>
      </div>}

      {knowledgeOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setKnowledgeOpen(false); }}>
        <section className="studio-modal knowledge-modal" role="dialog" aria-modal="true" aria-labelledby="knowledge-modal-title">
          <header><div><span>LOCAL KNOWLEDGE</span><h2 id="knowledge-modal-title">本地知识库</h2><p>选择文档后，Agent 会在当前官方资料的基础上复核并使用。</p></div><button aria-label="关闭知识库" onClick={() => setKnowledgeOpen(false)}>×</button></header>
          <div className="knowledge-list">{knowledgeEntries.length ? knowledgeEntries.map((entry) => <label className={knowledgeIds.includes(entry.id) ? "selected" : ""} key={entry.id}><input aria-label={`选择知识文档：${entry.title}`} type="checkbox" checked={knowledgeIds.includes(entry.id)} onChange={(event) => setKnowledgeIds((current) => event.target.checked ? [...new Set([...current, entry.id])] : current.filter((id) => id !== entry.id))} /><span><strong>{entry.title}</strong><small>{entry.keywords?.join(" · ") || "无关键词"} · {new Date(entry.updatedAt).toLocaleDateString("zh-CN")}</small><p>{entry.content.slice(0, 150).replace(/[#|>*_`]/g, " ")}</p></span></label>) : <div className="empty-library">还没有知识文档。先生成预习文档，再点击“加入知识库”。</div>}</div>
          <footer><span>已选择 {knowledgeIds.length} 份</span><button className="primary" onClick={() => setKnowledgeOpen(false)}>确认调取</button></footer>
        </section>
      </div>}

      {harnessOpen && <div className="modal-backdrop harness-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setHarnessOpen(false); }}>
        <section className="studio-modal harness-modal" role="dialog" aria-modal="true" aria-labelledby="harness-modal-title">
          <header><div><span>PRECISION HARNESS</span><h2 id="harness-modal-title">查看与修改执行规范</h2><p>默认规则已启用；覆盖稿只随当前任务保存，不会改写项目内置 Harness</p></div><div className="harness-header-actions"><div className={harnessChanged ? "edit-state changed" : "edit-state"}><i />{harnessChanged ? "已修改" : "原始版本"}</div><button aria-label="关闭 harness" onClick={() => setHarnessOpen(false)}>×</button></div></header>
          <div className="harness-toolbar"><div><strong>SKILL.md</strong><span>当前任务覆盖稿</span></div><div className="harness-stats"><span>{harnessLines} 行</span><span>{harnessText.length.toLocaleString()} 字符</span><span>自动换行</span></div></div>
          <div className="harness-editor-shell"><textarea className="document-editor harness-editor" aria-label="Precision harness 内容" value={harnessText} onChange={(event) => setHarnessText(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); const normalized = deliveryConstraints.trim(); setDeliveryConstraints(normalized); setConfirmedDeliveryConstraints(normalized); setHarnessOpen(false); } }} wrap="soft" spellCheck={false} /></div>
          <footer><div className="harness-footer-copy"><strong>{harnessChanged ? "当前任务将使用覆盖稿" : "当前任务将使用项目原版"}</strong><span>无需额外确认；关闭后当前内容会自动用于本次任务</span></div><button onClick={() => { setHarnessText(harnessOriginal); setDeliveryConstraints(DEFAULT_DELIVERY_CONSTRAINTS); setConfirmedDeliveryConstraints(DEFAULT_DELIVERY_CONSTRAINTS); }}>恢复原版</button><button className="primary" onClick={() => { const normalized = deliveryConstraints.trim(); setDeliveryConstraints(normalized); setConfirmedDeliveryConstraints(normalized); setHarnessOpen(false); }}>保存并关闭 <kbd>⌘ ↵</kbd></button></footer>
        </section>
      </div>}

      {testOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setTestOpen(false); }}>
        <section className="studio-modal chat-modal" role="dialog" aria-modal="true" aria-labelledby="test-modal-title">
          <header><div><span>MULTIMODAL GATE</span><h2 id="test-modal-title">连接与图文能力测试</h2><p>{engineMode === "api" ? `${apiPresets[provider]?.label} · ${model || "未选择模型"}` : engineMode === "gpu" ? `Ollama · ${gpuModel}` : cliOptions.find((option) => option.id === cli)?.label} · {engineMode === "cli" ? "五段都通过" : "两项都通过"}才会亮灯 · 思考强度：{reasoning}</p></div><button aria-label="关闭连接测试" onClick={() => setTestOpen(false)}>×</button></header>
          <div className={`test-gates ${engineMode === "cli" ? "cli-diagnostics" : ""}`} aria-label={engineMode === "cli" ? "本地 CLI 五段测试结果" : "模型双项测试结果"}>
            {engineMode === "cli" && <>
              <article className={`test-gate compact ${cliInstallTest.stage}`}><div className="test-gate-title"><i /><strong>1 · CLI 与版本</strong><span>{engineTestStageLabel(cliInstallTest.stage)}</span></div><p>{cliInstallTest.detail}</p></article>
              <article className={`test-gate compact ${cliAuthTest.stage}`}><div className="test-gate-title"><i /><strong>2 · 登录状态</strong><span>{engineTestStageLabel(cliAuthTest.stage)}</span></div><p>{cliAuthTest.detail}</p></article>
              <article className={`test-gate compact ${cliNetworkTest.stage}`}><div className="test-gate-title"><i /><strong>3 · 上游网络</strong><span>{engineTestStageLabel(cliNetworkTest.stage)}</span></div><p>{cliNetworkTest.detail}</p></article>
            </>}
            <article className={`test-gate ${textTest.stage}`}><div className="test-gate-title"><i /><strong>{engineMode === "cli" ? "4" : "1"} · 文字合规</strong><span>{engineTestStageLabel(textTest.stage)}</span></div><p>{textTest.detail}</p>{textTest.reply && <small title={textTest.reply}>{textTest.reply}</small>}</article>
            <article className={`test-gate ${imageTest.stage}`}><div className="test-gate-title"><i /><strong>{engineMode === "cli" ? "5" : "2"} · 图片理解 / OCR</strong><span>{engineTestStageLabel(imageTest.stage)}</span></div><p>{imageTest.detail}</p>{imageTest.previewUrl && <picture><img src={imageTest.previewUrl} alt="本轮模型识图挑战" loading="lazy" /></picture>}{imageTest.reply && <small title={imageTest.reply}>{imageTest.reply}</small>}</article>
          </div>
          {engineTestProxySuspected && <aside className="engine-test-route-warning"><div><strong>代理链路疑似干扰了图像响应</strong><p>文字已返回而图片正文为空。关闭代理重测可区分模型能力与代理兼容性；程序不会自动绕过你选择的代理。</p></div><button type="button" onClick={retryEngineTestWithoutProxy} disabled={testBusy}>关闭代理并重新测试</button></aside>}
          <div className="chat-feed">{testMessages.length ? testMessages.map((message, index) => <div className={`chat-bubble ${message.role}`} key={`${index}-${message.content}`}><span>{message.role === "user" ? "你" : engineMode === "api" ? model : engineMode === "gpu" ? gpuModel : cliOptions.find((option) => option.id === cli)?.label}</span><p>{message.content}</p></div>) : <div className="chat-welcome"><i>AI</i><strong>先回答文字，再读取随机图片</strong><p>系统会核对随机令牌、回复格式与内容长度，再让同一模型识别图片中的 5 位数字和色块颜色；不是只检查“有没有返回字”。</p></div>}</div>
          <div className="chat-compose"><textarea aria-label="测试消息" rows={2} value={testMessage} onChange={(event) => setTestMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && canTestEngine) { event.preventDefault(); void sendTestMessage(); } }} placeholder="输入一条用于文字关的真实问题…" /><button onClick={() => void sendTestMessage()} disabled={testBusy || !canTestEngine}>{testBusy ? "正在完整测试" : engineVerified ? "重新完整测试" : "开始完整测试"}</button></div>
          {!canTestEngine && <p className="chat-hint">当前引擎还未配置完整或未在本机发现</p>}
        </section>
      </div>}
    </div>
  );
}
