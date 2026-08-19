import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

test("manual model discovery ranks stable multimodal aliases and hides non-translation models", async () => {
  const calls = [];
  const mock = createServer((request, response) => {
    calls.push({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "mimo-v2.5" }, { id: "mimo-v2.5-asr" }, { id: "mimo-v2.5-tts" }] }));
      return;
    }
    response.end(JSON.stringify({ models: [{
      id: "grok-4.6-20260815",
      aliases: ["grok-4.6", "grok-4.6-latest"],
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      prompt_text_token_price: 20000,
      cached_prompt_text_token_price: 3000,
      completion_text_token_price: 60000,
    }] }));
  });
  const mockPort = await listen(mock);
  const bridgePort = await freePort();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "gakuniku-model-catalog-"));
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  const bridge = spawn(process.execPath, [fileURLToPath(new URL("../local-agent-bridge/server.mjs", import.meta.url))], {
    cwd: projectRoot,
    env: { ...process.env, PSS_BRIDGE_PORT: String(bridgePort), PSS_JOBS_PATH: path.join(tempRoot, "jobs") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  bridge.stdout.on("data", (chunk) => { output += chunk; });
  bridge.stderr.on("data", (chunk) => { output += chunk; });
  try {
    for (let attempt = 0; attempt < 100 && !output.includes("自学型熟肉机"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(output, /自学型熟肉机/);
    const response = await fetch(`http://127.0.0.1:${bridgePort}/api/engine/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ engine: { provider: "xai", apiKey: "test-key", baseUrl: `http://127.0.0.1:${mockPort}/v1` } }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, result.error);
    assert.deepEqual(result.recommendedModels, ["grok-4.6", "grok-4.6-latest"]);
    assert.deepEqual(result.models, ["grok-4.6", "grok-4.6-latest"]);
    assert.deepEqual(result.allModels, ["grok-4.6-20260815", "grok-4.6", "grok-4.6-latest"]);
    assert.deepEqual(result.pricing["grok-4.6"], {
      currency: "USD",
      inputPerMillion: 2,
      cachedInputPerMillion: 0.3,
      outputPerMillion: 6,
      note: "由 xAI 当前账户模型目录实时返回",
    });
    assert.match(result.source, /\/v1\/language-models$/);
    assert.match(result.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
    const mimoResponse = await fetch(`http://127.0.0.1:${bridgePort}/api/engine/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ engine: { provider: "mimo", apiKey: "test-key", baseUrl: `http://127.0.0.1:${mockPort}/v1` } }),
    });
    const mimoResult = await mimoResponse.json();
    assert.equal(mimoResponse.status, 200, mimoResult.error);
    assert.deepEqual(mimoResult.models, ["mimo-v2.5"]);
    assert.deepEqual(mimoResult.allModels, ["mimo-v2.5"]);
    assert.equal(mimoResult.filteredOut, 2);
    const deepseekResponse = await fetch(`http://127.0.0.1:${bridgePort}/api/engine/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ engine: { provider: "deepseek", apiKey: "test-key", baseUrl: `http://127.0.0.1:${mockPort}/v1` } }),
    });
    const deepseekResult = await deepseekResponse.json();
    assert.equal(deepseekResponse.status, 200, deepseekResult.error);
    assert.deepEqual(deepseekResult.recommendedModels, []);
    assert.match(deepseekResult.warning, /文本模型|图片能力测试/);
    const missingConsentResponse = await fetch(`http://127.0.0.1:${bridgePort}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "/tmp/authorization-fixture.mp4",
        outputPath: "/tmp",
        formats: ["srt"],
        engine: { mode: "api", provider: "mimo", model: "mimo-v2.5", apiKey: "test-key", baseUrl: `http://127.0.0.1:${mockPort}/v1` },
        transcription: { mode: "local", provider: "faster_whisper", model: "turbo" },
      }),
    });
    const missingConsentResult = await missingConsentResponse.json();
    assert.equal(missingConsentResponse.status, 400);
    assert.match(missingConsentResult.error, /外部模型处理授权|授权框/);
    assert.deepEqual(calls, [
      { url: "/v1/language-models", authorization: "Bearer test-key" },
      { url: "/v1/models", authorization: "Bearer test-key" },
      { url: "/v1/models", authorization: "Bearer test-key" },
    ]);
  } finally {
    if (bridge.exitCode === null) {
      const bridgeClosed = new Promise((resolve) => bridge.once("close", resolve));
      bridge.kill("SIGTERM");
      await Promise.race([bridgeClosed, new Promise((resolve) => setTimeout(resolve, 1000))]);
    }
    mock.closeAllConnections();
    await close(mock);
    await rm(tempRoot, { recursive: true, force: true });
  }
});
