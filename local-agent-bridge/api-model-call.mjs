import { readFile, writeFile } from "node:fs/promises";
import { ProxyAgent } from "undici";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) throw new Error("用法: node api-model-call.mjs 输入.json 输出.json");

const raw = await readFile(inputPath);
if (raw.byteLength > 2 * 1024 * 1024) throw new Error("单次模型输入不能超过 2 MB，请分段调用");
const input = JSON.parse(raw.toString("utf8"));
const provider = process.env.PSS_API_PROVIDER || "compatible";
const baseUrl = String(process.env.PSS_API_BASE_URL || "").replace(/\/$/, "");
const apiKey = process.env.PSS_API_KEY || "";
const model = process.env.PSS_API_MODEL || "";
const proxyUrl = String(process.env.PSS_PROXY_URL || "").trim();
if (!baseUrl || !apiKey || !model) throw new Error("缺少 PSS_API_BASE_URL / PSS_API_KEY / PSS_API_MODEL");

const endpoint = `${baseUrl}/chat/completions`;
const baseMessages = Array.isArray(input.messages)
  ? input.messages
  : [{ role: "user", content: String(input.prompt || "") }];
if (!["openai", "xai", "deepseek", "kimi", "kimi_intl", "mimo", "glm"].includes(provider) && process.env.PSS_REASONING_EFFORT) {
  baseMessages.unshift({ role: "system", content: `思考强度偏好：${process.env.PSS_REASONING_EFFORT}。疑难专名与语境必须充分核证后回答。` });
}
const effort = String(input.reasoningEffort || process.env.PSS_REASONING_EFFORT || "medium").toLowerCase();
function reasoningFields() {
  if (provider === "openai") return { reasoning_effort: effort };
  if (provider === "xai") return { reasoning_effort: ["xhigh", "max"].includes(effort) ? "high" : effort };
  if (provider === "deepseek") return { thinking: { type: "enabled" }, reasoning_effort: ["xhigh", "max"].includes(effort) ? "max" : "high" };
  if (["kimi", "kimi_intl"].includes(provider)) return model.startsWith("kimi-k3") ? { reasoning_effort: effort === "low" ? "low" : ["xhigh", "max"].includes(effort) ? "max" : "high" } : { thinking: { type: "enabled" } };
  if (provider === "mimo") return { thinking: { type: effort === "low" ? "disabled" : "enabled" } };
  if (provider === "glm") return { thinking: { type: "enabled" }, reasoning_effort: effort === "xhigh" ? "max" : effort };
  return {};
}
function tokenFields(maxTokens) {
  return ["openai", "kimi", "kimi_intl", "mimo"].includes(provider)
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
}

const harnessActionTool = {
  type: "function",
  function: {
    name: "harness_action",
    description: "Return the next bounded GakuNiku Harness action.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["type", "summary"],
      properties: {
        type: { type: "string", enum: ["tool", "finish"] },
        summary: { type: "string" },
        calls: {
          type: "array",
          maxItems: 4,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["tool", "input"],
            properties: {
              tool: { type: "string" },
              input: { type: "object", additionalProperties: true },
            },
          },
        },
      },
    },
  },
};

function structuredFields() {
  if (input.responseFormat === "harness_action") {
    return { tools: [harnessActionTool], tool_choice: { type: "function", function: { name: "harness_action" } } };
  }
  if (input.responseFormat === "json_object") return { response_format: { type: "json_object" } };
  return {};
}

function extract(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extract).filter(Boolean).join("\n");
  if (typeof value !== "object") return "";
  if (typeof value.output_text === "string") return value.output_text;
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) return extract(value.content);
  if (value.message) return extract(value.message);
  if (Array.isArray(value.choices)) return extract(value.choices.map((choice) => choice.message || choice.delta));
  if (Array.isArray(value.output)) return extract(value.output);
  return "";
}

function extractToolArguments(value) {
  const call = value?.choices?.[0]?.message?.tool_calls?.find((item) => item?.function?.name === "harness_action")
    || value?.choices?.[0]?.message?.tool_calls?.[0];
  const args = call?.function?.arguments;
  if (typeof args === "string") return args;
  if (args && typeof args === "object") return JSON.stringify(args);
  return "";
}

function responseDiagnostic(data, responseText, response = null) {
  const choice = data?.choices?.[0] || {};
  const message = choice?.message || {};
  const reasoning = extract(message?.reasoning_content || message?.reasoning || data?.reasoning_content).trim();
  return {
    at: new Date().toISOString(),
    provider,
    model: data?.model || model,
    httpStatus: response?.status || null,
    finishReason: String(choice?.finish_reason || data?.stop_reason || data?.finish_reason || "unknown"),
    usage: data?.usage || null,
    responseKeys: data && typeof data === "object" ? Object.keys(data).slice(0, 30) : [],
    messageKeys: message && typeof message === "object" ? Object.keys(message).slice(0, 30) : [],
    reasoningExcerpt: reasoning.slice(0, 1200),
    rawExcerpt: String(responseText || "").slice(0, 2000),
  };
}

async function persistFailure(code, message, diagnostic = {}) {
  const payload = { ok: false, code, message: String(message || code).slice(0, 4000), ...diagnostic };
  await writeFile(`${outputPath}.error.json`, `${JSON.stringify(payload, null, 2)}\n`, "utf8").catch(() => {});
  const error = new Error(`${code}: ${payload.message}`);
  error.code = code;
  throw error;
}

function tokenUsage(value) {
  const input = Number(value?.prompt_tokens ?? value?.input_tokens ?? 0);
  const cachedInputValue = value?.cached_input_tokens
    ?? value?.input_cached_tokens
    ?? value?.prompt_cache_hit_tokens
    ?? value?.prompt_tokens_details?.cached_tokens
    ?? value?.input_tokens_details?.cached_tokens
    ?? value?.cache_read_input_tokens;
  const cachedInput = Number(cachedInputValue ?? 0);
  const output = Number(value?.completion_tokens ?? value?.output_tokens ?? 0);
  const total = Number(value?.total_tokens ?? input + output);
  return {
    input: Number.isFinite(input) ? Math.max(0, input) : 0,
    cachedInput: Number.isFinite(cachedInput) ? Math.max(0, Math.min(cachedInput, input)) : 0,
    output: Number.isFinite(output) ? Math.max(0, output) : 0,
    total: Number.isFinite(total) ? Math.max(0, total) : 0,
    available: Boolean(value) && typeof value === "object" && ["prompt_tokens", "completion_tokens", "total_tokens", "input_tokens", "output_tokens"].some((key) => key in value),
    cacheAvailable: cachedInputValue !== undefined && cachedInputValue !== null,
  };
}

function mergeUsage(...values) {
  const valid = values.filter(Boolean);
  return {
    input: valid.reduce((sum, value) => sum + Number(value.input || 0), 0),
    cachedInput: valid.reduce((sum, value) => sum + Number(value.cachedInput || 0), 0),
    output: valid.reduce((sum, value) => sum + Number(value.output || 0), 0),
    total: valid.reduce((sum, value) => sum + Number(value.total || 0), 0),
    available: valid.some((value) => value.available),
    cacheAvailable: valid.some((value) => value.cacheAvailable),
  };
}

async function requestModel(messages, maxTokens) {
  async function send(includeStructured) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, ...(provider === "mimo" ? { "api-key": apiKey } : {}), "content-type": "application/json" },
        body: JSON.stringify({ model, messages, stream: false, ...reasoningFields(), ...tokenFields(maxTokens), ...(includeStructured ? structuredFields() : {}) }),
        signal: AbortSignal.timeout(Number(input.timeoutMs || 120_000)),
        ...(proxyUrl ? { dispatcher: new ProxyAgent(proxyUrl) } : {}),
      });
      const responseText = await response.text();
      let data;
      try { data = JSON.parse(responseText); } catch { data = { raw: responseText.slice(0, 4000) }; }
      return { response, responseText, data };
    } catch (error) {
      const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError" || /timeout/i.test(String(error?.message || error));
      return persistFailure(timedOut ? "MODEL_TIMEOUT" : "MODEL_NETWORK_ERROR", error?.message || String(error), {
        at: new Date().toISOString(), provider, model,
      });
    }
  }

  let attempt = await send(true);
  const structuredError = String(attempt.data?.error?.message || attempt.data?.base_resp?.status_msg || attempt.responseText || "");
  const canFallback = Boolean(input.responseFormat)
    && [400, 404, 422].includes(attempt.response.status)
    && /tool|function|schema|response.?format|unsupported|unknown (?:field|parameter)/i.test(structuredError);
  if (canFallback) attempt = await send(false);
  const { response, responseText, data } = attempt;
  const diagnostic = { ...responseDiagnostic(data, responseText, response), structuredFallback: canFallback };
  if (!response.ok) return persistFailure("MODEL_HTTP_ERROR", data?.error?.message || data?.base_resp?.status_msg || `API HTTP ${response.status}`, diagnostic);
  const text = (extractToolArguments(data) || extract(data)).trim();
  if (!text) return persistFailure("MODEL_EMPTY_RESPONSE", "模型请求成功，但没有返回可执行的正文内容", diagnostic);
  return {
    text,
    model: data.model || model,
    tokenUsage: tokenUsage(data?.usage),
    finishReason: String(data?.choices?.[0]?.finish_reason || data?.stop_reason || data?.finish_reason || "unknown"),
  };
}

function itemId(item, index) {
  if (item && typeof item === "object" && item.id != null) return String(item.id);
  return String(index);
}

async function adaptiveBatch(items, maxTokens) {
  const instruction = String(input.batchInstruction || "逐项处理输入，并返回包含相同 id 的 JSON 结果。不得遗漏、合并或重排条目。");
  const system = String(input.batchSystem || "你正在处理视频字幕的一个有界批次。输出必须简洁、结构完整并保留每项 id。");
  const estimatedPerItem = Math.max(32, Number(input.estimatedOutputTokensPerItem || 220));
  const safeBudget = Math.max(256, Math.floor(maxTokens * 0.72));
  const estimatedSize = Math.max(1, Math.floor(safeBudget / estimatedPerItem));
  const maxItemsPerCall = Math.max(1, Number(input.maxItemsPerCall || 40));
  const initialSize = Math.max(1, Math.min(items.length, maxItemsPerCall, estimatedSize));
  const parts = [];
  const allUsage = [];
  let requestCount = 0;

  async function processPart(part, offset, depth = 0) {
    const messages = [
      ...baseMessages,
      { role: "system", content: system },
      { role: "user", content: `${instruction}\n\nINPUT_ITEMS_JSON:\n${JSON.stringify(part)}` },
    ];
    requestCount += 1;
    const result = await requestModel(messages, maxTokens);
    allUsage.push(result.tokenUsage);
    const nearLimit = /length|max_tokens|max_output_tokens/i.test(result.finishReason)
      || (result.tokenUsage.available && result.tokenUsage.output >= maxTokens * 0.88);
    if (nearLimit) {
      if (part.length <= 1) throw new Error(`单条模型输出已达到上限（id=${itemId(part[0], offset)}）；请缩短该条上下文，而不是重试整批`);
      const middle = Math.ceil(part.length / 2);
      await processPart(part.slice(0, middle), offset, depth + 1);
      await processPart(part.slice(middle), offset + middle, depth + 1);
      return;
    }
    parts.push({
      index: parts.length,
      offset,
      count: part.length,
      itemIds: part.map((item, index) => itemId(item, offset + index)),
      text: result.text,
      finishReason: result.finishReason,
      tokenUsage: result.tokenUsage,
      splitDepth: depth,
    });
  }

  for (let offset = 0; offset < items.length; offset += initialSize) {
    await processPart(items.slice(offset, offset + initialSize), offset);
  }
  parts.sort((left, right) => left.offset - right.offset);
  return {
    text: parts.map((part) => part.text).join("\n"),
    model: model,
    tokenUsage: mergeUsage(...allUsage),
    parts,
    adaptiveBatch: {
      enabled: true,
      itemCount: items.length,
      initialBatchSize: initialSize,
      safeOutputBudget: safeBudget,
      estimatedOutputTokensPerItem: estimatedPerItem,
      calls: requestCount,
      completedParts: parts.length,
    },
  };
}

const maxTokens = Math.max(256, Number(input.maxTokens || 6000));
const output = Array.isArray(input.batchItems) && input.batchItems.length
  ? await adaptiveBatch(input.batchItems, maxTokens)
  : await requestModel(baseMessages, maxTokens);
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
