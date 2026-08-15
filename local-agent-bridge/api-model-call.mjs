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
const messages = Array.isArray(input.messages)
  ? input.messages
  : [{ role: "user", content: String(input.prompt || "") }];
if (!["openai", "xai", "deepseek", "kimi", "kimi_intl", "mimo", "glm"].includes(provider) && process.env.PSS_REASONING_EFFORT) {
  messages.unshift({ role: "system", content: `思考强度偏好：${process.env.PSS_REASONING_EFFORT}。疑难专名与语境必须充分核证后回答。` });
}
const effort = process.env.PSS_REASONING_EFFORT || "medium";
function reasoningFields() {
  if (provider === "openai") return { reasoning_effort: effort };
  if (provider === "xai") return { reasoning_effort: ["xhigh", "max"].includes(effort) ? "high" : effort };
  if (provider === "deepseek") return { thinking: { type: "enabled" }, reasoning_effort: ["xhigh", "max"].includes(effort) ? "max" : "high" };
  if (["kimi", "kimi_intl"].includes(provider)) return model.startsWith("kimi-k3") ? { reasoning_effort: effort === "low" ? "low" : ["xhigh", "max"].includes(effort) ? "max" : "high" } : { thinking: { type: "enabled" } };
  if (provider === "mimo") return { thinking: { type: "enabled" } };
  if (provider === "glm") return { thinking: { type: "enabled" }, reasoning_effort: effort === "xhigh" ? "max" : effort };
  return {};
}
const tokenField = ["openai", "kimi", "kimi_intl", "mimo"].includes(provider)
  ? { max_completion_tokens: Number(input.maxTokens || 6000) }
  : { max_tokens: Number(input.maxTokens || 6000) };
const response = await fetch(endpoint, {
  method: "POST",
  headers: { authorization: `Bearer ${apiKey}`, ...(provider === "mimo" ? { "api-key": apiKey } : {}), "content-type": "application/json" },
  body: JSON.stringify({
    model,
    messages,
    stream: false,
    ...reasoningFields(),
    ...tokenField,
  }),
  signal: AbortSignal.timeout(120_000),
  ...(proxyUrl ? { dispatcher: new ProxyAgent(proxyUrl) } : {}),
});
const responseText = await response.text();
let data;
try { data = JSON.parse(responseText); } catch { data = { raw: responseText.slice(0, 4000) }; }
if (!response.ok) throw new Error(data?.error?.message || data?.base_resp?.status_msg || `API HTTP ${response.status}`);

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

function tokenUsage(value) {
  const input = Number(value?.prompt_tokens ?? value?.input_tokens ?? 0);
  const output = Number(value?.completion_tokens ?? value?.output_tokens ?? 0);
  const total = Number(value?.total_tokens ?? input + output);
  return {
    input: Number.isFinite(input) ? Math.max(0, input) : 0,
    output: Number.isFinite(output) ? Math.max(0, output) : 0,
    total: Number.isFinite(total) ? Math.max(0, total) : 0,
    available: Boolean(value) && typeof value === "object" && ["prompt_tokens", "completion_tokens", "total_tokens", "input_tokens", "output_tokens"].some((key) => key in value),
  };
}

const text = extract(data).trim();
if (!text) throw new Error("模型没有返回文本");
await writeFile(outputPath, `${JSON.stringify({ text, model: data.model || model, tokenUsage: tokenUsage(data?.usage) }, null, 2)}\n`, "utf8");
