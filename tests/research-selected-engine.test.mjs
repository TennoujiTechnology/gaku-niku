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

function jsonResponse(response, body, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

test("research preview uses the model selected in step one for planning and synthesis", async () => {
  const calls = [];
  const mock = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    if (request.url === "/v1/chat/completions") {
      const prompt = String(body.messages?.at(-1)?.content || "");
      calls.push(prompt.includes("设计 3–5 条") ? "selected-model:plan" : "selected-model:synthesis");
      const content = prompt.includes("设计 3–5 条")
        ? JSON.stringify({ queries: ["MyGO official character", "MyGO terminology"] })
        : "# 已核对的预习文档\n\n- 证据：https://official.example/mygo\n";
      return jsonResponse(response, {
        model: "first-step-model",
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 60 } },
      });
    }
    if (request.url === "/mcp") {
      if (body.method === "notifications/initialized") return jsonResponse(response, {});
      if (body.method === "initialize") return jsonResponse(response, { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mock-search", version: "1" } } });
      if (body.method === "tools/list") return jsonResponse(response, { jsonrpc: "2.0", id: body.id, result: { tools: [
        { name: "search_web", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
        { name: "fetch_web", inputSchema: { type: "object", properties: { url: { type: "string" } } } },
      ] } });
      if (body.method === "tools/call") {
        calls.push(`mcp:${body.params.name}`);
        if (body.params.name === "fetch_web" && String(body.params.arguments.url).includes("broken.example")) {
          return jsonResponse(response, { jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: "HTTP 404" }] } });
        }
        const text = body.params.name === "search_web"
          ? "候选结果 https://broken.example/page 与官方结果 https://official.example/mygo"
          : "MyGO 官方角色与术语证据正文";
        return jsonResponse(response, { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text }] } });
      }
    }
    return jsonResponse(response, { error: "not found" }, 404);
  });
  const mockPort = await listen(mock);
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pss-selected-engine-"));
  const bridgePort = mockPort + 1;
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  const bridge = spawn(process.execPath, [fileURLToPath(new URL("../local-agent-bridge/server.mjs", import.meta.url))], {
    cwd: projectRoot,
    env: { ...process.env, PSS_BRIDGE_PORT: String(bridgePort), PSS_JOBS_PATH: path.join(tempRoot, "jobs") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let bridgeOutput = "";
  bridge.stdout.on("data", (chunk) => { bridgeOutput += chunk; });
  bridge.stderr.on("data", (chunk) => { bridgeOutput += chunk; });
  try {
    for (let attempt = 0; attempt < 100 && !bridgeOutput.includes("自学型熟肉机"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(bridgeOutput, /自学型熟肉机/);
    const created = await fetch(`http://127.0.0.1:${bridgePort}/api/research/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "https://example.test/video",
        engine: { mode: "api", provider: "compatible", model: "first-step-model", apiKey: "test-key", baseUrl: `http://127.0.0.1:${mockPort}/v1`, reasoning: "medium" },
        search: { provider: "custom", url: `http://127.0.0.1:${mockPort}/mcp`, apiKey: "" },
        research: { keywords: ["MyGO!!!!!"], sites: ["official"], customSites: [], knowledgeIds: [] },
      }),
    }).then((response) => response.json());
    assert.ok(created.id);
    let result;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      result = await fetch(`http://127.0.0.1:${bridgePort}/api/research/runs/${created.id}`).then((response) => response.json());
      if (result.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(result.status, "completed", result.error);
    assert.match(result.generatedBy, /compatible\/first-step-model/);
    assert.match(result.document, /已核对的预习文档/);
    assert.deepEqual(result.tokenUsage, { input: 200, cachedInput: 120, output: 40, total: 240, available: true, cacheAvailable: true });
    assert.ok(result.events.some((event) => /网页打开失败.*继续/.test(event.text)));
    assert.deepEqual(calls, [
      "selected-model:plan",
      "mcp:search_web",
      "mcp:search_web",
      "mcp:fetch_web",
      "mcp:fetch_web",
      "selected-model:synthesis",
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
