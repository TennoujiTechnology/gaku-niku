import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { updateJsonAtomic, writeJsonAtomic } from "../local-agent-bridge/manifest-store.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");

test("manifest single-writer serializes concurrent updates and leaves valid atomic JSON", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gakuniku-manifest-"));
  const manifestPath = path.join(directory, "manifest.json");
  await writeJsonAtomic(manifestPath, { schema_version: 2, count: 0, phases: {} });
  await Promise.all(Array.from({ length: 40 }, () => updateJsonAtomic(manifestPath, (current) => ({ ...current, count: current.count + 1 }))));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.count, 40);
  assert.deepEqual((await readdir(directory)).filter((name) => name.includes(".tmp") || name.includes("writer-lock")), []);
});

test("adaptive API batches shrink only the child that reaches the output limit", async (t) => {
  const callSizes = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const content = String(body.messages.at(-1)?.content || "");
      const items = JSON.parse(content.split("INPUT_ITEMS_JSON:\n").at(-1));
      callSizes.push(items.length);
      const limited = items.length > 2;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        model: "mock-model",
        choices: [{ finish_reason: limited ? "length" : "stop", message: { content: JSON.stringify({ items: items.map((item) => ({ id: item.id, translated: `ok-${item.id}` })) }) } }],
        usage: { prompt_tokens: 100, completion_tokens: limited ? 900 : 120, total_tokens: limited ? 1000 : 220 },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const directory = await mkdtemp(path.join(os.tmpdir(), "gakuniku-batch-"));
  const inputPath = path.join(directory, "input.json");
  const outputPath = path.join(directory, "output.json");
  await writeFile(inputPath, JSON.stringify({
    batchItems: Array.from({ length: 5 }, (_, index) => ({ id: index + 1, source: `line-${index + 1}` })),
    batchInstruction: "translate",
    maxTokens: 1000,
    estimatedOutputTokensPerItem: 100,
  }));
  const child = spawn(process.execPath, [path.join(projectRoot, "local-agent-bridge", "api-model-call.mjs"), inputPath, outputPath], {
    cwd: projectRoot,
    env: { ...process.env, PSS_API_PROVIDER: "compatible", PSS_API_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, PSS_API_KEY: "test", PSS_API_MODEL: "mock-model" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, stderr);
  const output = JSON.parse(await readFile(outputPath, "utf8"));
  assert.deepEqual(callSizes, [5, 3, 2, 1, 2]);
  assert.deepEqual(output.parts.flatMap((part) => part.itemIds), ["1", "2", "3", "4", "5"]);
  assert.equal(output.adaptiveBatch.itemCount, 5);
  assert.equal(output.adaptiveBatch.calls, 5);
  assert.equal(output.adaptiveBatch.completedParts, 3);
  assert.equal(output.tokenUsage.output, 2 * 900 + 3 * 120);
});

test("job launch source contains real preflight, immediate diarization downgrade, and manifest helper enforcement", async () => {
  const [server, skill, launcher] = await Promise.all([
    readFile(new URL("../local-agent-bridge/server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../harness/precision-video-subtitles/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../local-agent-bridge/launch.mjs", import.meta.url), "utf8"),
  ]);
  for (const phrase of [
    "runTaskTranscriptionPreflight",
    "FFmpeg 动态库与音频链路预检",
    "Faster-Whisper 模型缓存与真实推理预检",
    "Sherpa-ONNX 本地说话人分离真实推理预检",
    "Hugging Face 返回 HTTP",
    "diarization: false",
    "Manifest 单写入器",
    "batchItems、batchInstruction",
  ]) assert.ok(server.includes(phrase), `server missing P0 guard: ${phrase}`);
  for (const phrase of [
    "manifest.transcription_preflight",
    "Prefer the Studio-managed Sherpa-ONNX runtime",
    "adaptive batch protocol",
  ]) assert.ok(skill.includes(phrase), `harness missing P0 guard: ${phrase}`);
  for (const phrase of ["mkdtempSync", ".precision-subtitle-studio", "inheritedEnvironment.TMPDIR"]) {
    assert.ok(launcher.includes(phrase), `launcher missing writable temp fallback: ${phrase}`);
  }
});
