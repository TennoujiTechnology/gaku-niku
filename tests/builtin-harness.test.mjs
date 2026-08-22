import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");
const runnerPath = path.join(projectRoot, "local-agent-bridge", "builtin-harness-runner.mjs");
const phases = ["acquire", "research", "source_transcript", "translate", "resolve_ambiguities", "subtitle_qc", "mux", "final_validation"];

test("API jobs select the bundled harness instead of probing Codex or Claude", async () => {
  const [server, runner, build, skill] = await Promise.all([
    readFile(path.join(projectRoot, "local-agent-bridge", "server.mjs"), "utf8"),
    readFile(runnerPath, "utf8"),
    readFile(path.join(projectRoot, "scripts", "build-portable-release.mjs"), "utf8"),
    readFile(path.join(projectRoot, "harness", "precision-video-subtitles", "SKILL.md"), "utf8"),
  ]);
  assert.match(server, /if \(mode === "api"\) name = "builtin-api"/);
  assert.match(server, /if \(mode === "gpu"\) name = "builtin-local"/);
  assert.match(server, /const command = builtinHarness \? process\.execPath/);
  assert.doesNotMatch(server, /if \(mode === "api"\) name = executable\("codex"\)/);
  assert.match(server, /if \(name === "builtin-api" \|\| name === "builtin-local"\) return \[builtinHarnessRunnerPath/);
  assert.match(server, /builtin-harness-export-prompt\.md/);
  assert.match(runner, /PSS_TRANSCRIPTION_MODEL_CACHE/);
  assert.match(runner, /PSS_TRANSCRIPTION_DIARIZATION_PYTHON/);
  assert.match(runner, /--segmentation-model/);
  assert.match(server, /\/api\/transcription\/auto-install/);
  assert.match(server, /Required repairs always win|Mandatory repairs always win/);
  assert.match(build, /builtin-harness-runner\.mjs/);
  assert.match(skill, /Never probe, launch, or depend on Codex, Claude Code/);
});

test("bundled API harness completes a mock job when no Agent CLI is on PATH", async (t) => {
  let requestCount = 0;
  const api = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requestCount += 1;
      const patch = Object.fromEntries(phases.map((id) => [id, { status: "complete", evidence: [`mock ${id}`] }]));
      const content = requestCount === 1
        ? JSON.stringify({ type: "tool", summary: "模拟完成八阶段", calls: [{ tool: "update_manifest", input: { patch: { phases: patch } } }] })
        : JSON.stringify({ type: "finish", summary: "模拟任务完成" });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ model: "mock-multimodal", choices: [{ finish_reason: "stop", message: { content } }], usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 } }));
    });
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(() => api.close());

  const root = await mkdtemp(path.join(os.tmpdir(), "gakuniku-builtin-"));
  const job = path.join(root, "job");
  await mkdir(path.join(job, "work"), { recursive: true });
  const source = path.join(root, "source.mp4");
  const prompt = path.join(job, "work", "prompt.md");
  await writeFile(source, "mock");
  await writeFile(prompt, "这是一个不需要真实媒体工具的 Harness 协议测试。", "utf8");
  await writeFile(path.join(job, "studio-job.json"), JSON.stringify({ source, outputPath: path.join(root, "output") }));
  await writeFile(path.join(job, "manifest.json"), JSON.stringify({ phases: Object.fromEntries(phases.map((id) => [id, { status: "pending", evidence: [] }])) }));

  const child = spawn(process.execPath, [runnerPath, "--job-dir", job, "--prompt", prompt], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PATH: "",
      PSS_API_PROVIDER: "compatible",
      PSS_API_BASE_URL: `http://127.0.0.1:${api.address().port}/v1`,
      PSS_API_KEY: "test",
      PSS_API_MODEL: "mock-multimodal",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(exitCode, 0, stderr);
  assert.ok(requestCount >= 2);
  const manifest = JSON.parse(await readFile(path.join(job, "manifest.json"), "utf8"));
  assert.ok(phases.every((id) => manifest.phases[id].status === "complete"));
});
