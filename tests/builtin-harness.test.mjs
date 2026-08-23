import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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
  assert.match(skill, /source acquisition is deterministic infrastructure work/);
  assert.match(skill, /Only immediately adjacent failures with the same tool, arguments, and error count as consecutive/);
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
  await writeFile(path.join(job, "manifest.json"), JSON.stringify({
    source: { kind: "local", value: source, acquired_media: source },
    artifacts: { source_media: source },
    phases: Object.fromEntries(phases.map((id) => [id, { status: id === "acquire" ? "complete" : "pending", evidence: id === "acquire" ? ["mock source ready"] : [] }])),
  }));

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
  assert.ok(requestCount >= 1, "the controller should be consulted at least once");
  const manifest = JSON.parse(await readFile(path.join(job, "manifest.json"), "utf8"));
  assert.ok(phases.every((id) => manifest.phases[id].status === "complete"));
});

test("bundled harness safely repairs a provider that stringifies the calls array", async (t) => {
  let requestCount = 0;
  const api = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requestCount += 1;
      const patch = Object.fromEntries(phases.map((id) => [id, { status: "complete", evidence: [`repaired ${id}`] }]));
      const action = requestCount === 1
        ? { type: "tool", summary: "兼容二次序列化 calls", calls: JSON.stringify([{ tool: "update_manifest", input: { patch: { phases: patch } } }]) }
        : { type: "finish", summary: "完成" };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        model: "mimo-compatible",
        choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ type: "function", function: { name: "harness_action", arguments: JSON.stringify(action) } }] } }],
        usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
      }));
    });
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(() => api.close());

  const root = await mkdtemp(path.join(os.tmpdir(), "gakuniku-stringified-calls-"));
  const job = path.join(root, "job");
  await mkdir(path.join(job, "work"), { recursive: true });
  const source = path.join(root, "source.mp4");
  const prompt = path.join(job, "work", "prompt.md");
  await writeFile(source, "mock");
  await writeFile(prompt, "二次序列化 calls 兼容测试。", "utf8");
  await writeFile(path.join(job, "studio-job.json"), JSON.stringify({ source, outputPath: path.join(root, "output") }));
  await writeFile(path.join(job, "manifest.json"), JSON.stringify({
    source: { kind: "local", value: source, acquired_media: source }, artifacts: { source_media: source },
    phases: Object.fromEntries(phases.map((id) => [id, { status: id === "acquire" ? "complete" : "pending", evidence: id === "acquire" ? ["ready"] : [] }])),
  }));
  const child = spawn(process.execPath, [runnerPath, "--job-dir", job, "--prompt", prompt], {
    cwd: projectRoot,
    env: { ...process.env, PATH: "", PSS_API_PROVIDER: "mimo", PSS_API_BASE_URL: `http://127.0.0.1:${api.address().port}/v1`, PSS_API_KEY: "test", PSS_API_MODEL: "mimo-compatible" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  assert.equal(await new Promise((resolve) => child.on("close", resolve)), 0, stderr);
  assert.match(stdout, /兼容修复首页模型把 calls 数组二次序列化/);
  const manifest = JSON.parse(await readFile(path.join(job, "manifest.json"), "utf8"));
  assert.ok(phases.every((id) => manifest.phases[id].status === "complete"));
});

test("bundled harness has deterministic acquisition, strict tool arguments, and bounded controller context", async () => {
  const runner = await readFile(runnerPath, "utf8");
  assert.match(runner, /async function deterministicAcquire\(\)/);
  assert.match(runner, /获取素材：使用 .*不调用大模型决定命令/);
  assert.match(runner, /function normalizeRunArgs\(id, rawArgs\)/);
  assert.match(runner, /run\.\$\{id\}\.args 必须是非空字符串数组/);
  assert.doesNotMatch(runner, /Array\.isArray\(input\.args\) \? input\.args\.map\(String\) : \[\]/);
  assert.match(runner, /summarizeResult\(taskPrompt, 15_000\)/);
  assert.match(runner, /attemptsWithSameInput/);
  assert.match(runner, /MODEL_EMPTY_RESPONSE/);
  assert.match(runner, /responseFormat: "harness_action"/);
  assert.match(runner, /function parseLegacyXmlReply\(source\)/);
  assert.match(runner, /materialize_research_preview/);
  assert.match(runner, /async function deterministicSourceTranscript\(\)/);
  assert.match(runner, /async function deterministicTranslate\(\)/);
  assert.match(runner, /async function deterministicResolveAmbiguities\(\)/);
  assert.match(runner, /async function deterministicSubtitleQc\(\)/);
  assert.match(runner, /async function deterministicMux\(\)/);
  assert.match(runner, /async function deterministicFinalValidation\(\)/);
  assert.match(runner, /work", "translation-parts/);
  assert.match(runner, /const partSize = 20/);
  assert.match(runner, /async function requestTranslationItems/);
  assert.match(runner, /自动拆为 .* 条重试/);
  assert.match(runner, /translation\.includes\("\\uFFFD"\)/);
  assert.match(runner, /reasoningEffort: "low"/);
  assert.match(runner, /MODEL_EMPTY_RESPONSE.*MODEL_TIMEOUT.*MODEL_NETWORK_ERROR/);
  assert.match(runner, /PSS_API_PROVIDER === "mimo" \? 10 : 20/);
  assert.match(runner, /当前模型安全批量预拆/);
  assert.match(runner, /transcribe_media\.py/);
  assert.match(runner, /async function ensureMediaOutputParent\(commandArgs\)/);
  assert.match(runner, /previousToolFailure = \{ fingerprint: "", count: 0 \}/);
  assert.match(runner, /persistModelOutput\(result, input\.outputPath/);
  assert.match(runner, /totalProtocolFailures < 4/);
});

test("bundled harness deterministically translates stable transcript IDs and registers the merged artifact", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gakuniku-deterministic-translate-"));
  const job = path.join(root, "job");
  const work = path.join(job, "work");
  const research = path.join(job, "research");
  await mkdir(work, { recursive: true });
  await mkdir(research, { recursive: true });
  const source = path.join(root, "source.mp4");
  const prompt = path.join(work, "prompt.md");
  const transcript = path.join(work, "source-transcript.json");
  await writeFile(source, "mock media");
  await writeFile(prompt, "确定性翻译编排测试。", "utf8");
  await writeFile(path.join(research, "brief.md"), "MyGO!!!!! 活动语境", "utf8");
  await writeFile(path.join(research, "glossary.tsv"), "source_term\tcanonical_target\n迷子集会\t迷子集会\n", "utf8");
  await writeFile(path.join(research, "speakers.tsv"), "speaker_entity_id\tcharacter_name\tperformer_name\nP01\t高松灯\t羊宫妃那\n", "utf8");
  await writeFile(transcript, JSON.stringify({
    schema_version: 1, language: "ja", duration: 12, chunk_count: 2,
    provenance: { audio_chunks: ["a", "b"], transcript_chunks: ["a.json", "b.json"] },
    segments: [
      { id: 1, start: 1, end: 2, text: "こんにちは。", speaker: "speaker_00", chunk_index: 0, words: [{ probability: 0.99 }] },
      { id: 2, start: 7, end: 8, text: "迷子集会へようこそ。", speaker: "speaker_01", chunk_index: 1, words: [{ probability: 0.98 }] },
    ],
  }));
  await writeFile(path.join(job, "studio-job.json"), JSON.stringify({ source, outputPath: path.join(root, "output") }));
  await writeFile(path.join(job, "manifest.json"), JSON.stringify({
    source: { kind: "local", value: source, acquired_media: source },
    artifacts: { source_media: source, source_transcript: transcript },
    phases: Object.fromEntries(phases.map((id) => [id, { status: ["acquire", "research", "source_transcript"].includes(id) ? "complete" : "pending", evidence: [] }])),
  }));

  let translationRequests = 0;
  let controllerRequests = 0;
  const api = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const inputMessage = [...(body.messages || [])].reverse().find((message) => /INPUT_ITEMS_JSON:/.test(String(message.content || "")));
      let content;
      if (inputMessage) {
        translationRequests += 1;
        const items = JSON.parse(String(inputMessage.content).split("INPUT_ITEMS_JSON:\n").at(-1));
        content = JSON.stringify(items.map((item) => ({ id: item.id, translation: item.id === "1" ? "你好。" : "欢迎来到迷子集会。", confidence: 0.96, flagged: false, issue: "" })));
      } else {
        controllerRequests += 1;
        const translated = JSON.parse(await readFile(path.join(work, "translated-subtitles.json"), "utf8"));
        assert.equal(translated.cues.length, 2);
        const downstream = Object.fromEntries(phases.slice(4).map((id) => [id, { status: "complete", evidence: [`mock ${id}`] }]));
        content = controllerRequests === 1
          ? JSON.stringify({ type: "tool", summary: "完成下游模拟阶段", calls: [{ tool: "update_manifest", input: { patch: { phases: downstream } } }] })
          : JSON.stringify({ type: "finish", summary: "完成" });
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }], usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 } }));
    });
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(() => api.close());

  const child = spawn(process.execPath, [runnerPath, "--job-dir", job, "--prompt", prompt], {
    cwd: projectRoot,
    env: { ...process.env, PATH: "", PSS_API_PROVIDER: "compatible", PSS_API_BASE_URL: `http://127.0.0.1:${api.address().port}/v1`, PSS_API_KEY: "test", PSS_API_MODEL: "mock-translate" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  assert.equal(await new Promise((resolve) => child.on("close", resolve)), 0, stderr);
  assert.equal(translationRequests, 2);
  assert.ok(controllerRequests >= 1);
  const translated = JSON.parse(await readFile(path.join(work, "translated-subtitles.json"), "utf8"));
  assert.deepEqual(translated.cues.map((cue) => cue.id), [1, 2]);
  assert.deepEqual(translated.cues.map((cue) => cue.translation), ["你好", "欢迎来到迷子集会"]);
  assert.equal((await readFile(path.join(work, "translation-parts", "translated_chunk_000_part_000.json"), "utf8")).length > 0, true);
  assert.equal((await readFile(path.join(work, "translation-parts", "translated_chunk_001_part_000.json"), "utf8")).length > 0, true);
  const manifest = JSON.parse(await readFile(path.join(job, "manifest.json"), "utf8"));
  assert.equal(manifest.artifacts.translated_subtitles, path.join(work, "translated-subtitles.json"));
  assert.equal(manifest.phases.translate.status, "complete");
});

test("legacy allowlisted XML actions are translated without stopping the workflow", async (t) => {
  let requestCount = 0;
  const api = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requestCount += 1;
      const patch = Object.fromEntries(phases.map((id) => [id, { status: "complete", evidence: [`xml ${id}`] }]));
      const content = requestCount === 1
        ? `<tool_call>\n<tool_name>update_manifest</tool_name>\n${JSON.stringify({ patch: { phases: patch } })}\n</tool_call>`
        : JSON.stringify({ type: "finish", summary: "XML 兼容完成" });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }], usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 } }));
    });
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(() => api.close());
  const root = await mkdtemp(path.join(os.tmpdir(), "gakuniku-xml-compat-"));
  const job = path.join(root, "job");
  await mkdir(path.join(job, "work"), { recursive: true });
  const source = path.join(root, "source.mp4");
  const prompt = path.join(job, "work", "prompt.md");
  await writeFile(source, "mock");
  await writeFile(prompt, "XML 兼容测试。", "utf8");
  await writeFile(path.join(job, "studio-job.json"), JSON.stringify({ source, outputPath: path.join(root, "output") }));
  await writeFile(path.join(job, "manifest.json"), JSON.stringify({
    source: { kind: "local", value: source, acquired_media: source }, artifacts: { source_media: source },
    phases: Object.fromEntries(phases.map((id) => [id, { status: id === "acquire" ? "complete" : "pending", evidence: id === "acquire" ? ["ready"] : [] }])),
  }));
  const child = spawn(process.execPath, [runnerPath, "--job-dir", job, "--prompt", prompt], {
    cwd: projectRoot,
    env: { ...process.env, PATH: "", PSS_API_PROVIDER: "compatible", PSS_API_BASE_URL: `http://127.0.0.1:${api.address().port}/v1`, PSS_API_KEY: "test", PSS_API_MODEL: "mock" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  assert.equal(await new Promise((resolve) => child.on("close", resolve)), 0, stderr);
  assert.ok(requestCount >= 1, "the legacy action should be accepted on the first controller response");
});

test("approved research preview is deterministically materialized into four standard artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gakuniku-research-preview-"));
  const preview = path.join(root, "preview.md");
  await writeFile(preview, `# MyGO 预习

## 检索目标
- 核对角色与声优

## 角色—声优配对
| 人物实体 ID | 角色名 | 声优/出演者 | 当前素材中的发言身份 | 证据链接 | 置信度 |
| --- | --- | --- | --- | --- | --- |
| mygo-1 | 高松 燈 | 羊宮妃那 | 声优本人 | [官方](https://example.test/cast) | 高 |

## 角色与成员色
| 人物/成员 | 适用身份 | 色名 | HEX | 证据链接 | 置信度 |
| --- | --- | --- | --- | --- | --- |
| 高松 燈 | 角色 | 蓝色 | #77BBDD | [颜色](https://example.test/color) | 中 |

## 术语表
| 原文 | 读音 | 推荐译法 | 类型 | 证据链接 |
| --- | --- | --- | --- | --- |
| 迷子集会 | まいごせんたー | 迷子集会 | 节目名 | [官方](https://example.test/show) |
`, "utf8");
  const child = spawn(process.execPath, [path.join(projectRoot, "harness", "precision-video-subtitles", "scripts", "materialize_research_preview.mjs"), preview, root], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  assert.equal(await new Promise((resolve) => child.on("close", resolve)), 0, stderr);
  const result = JSON.parse(stdout);
  assert.deepEqual(result.counts, { sources: 3, glossary: 1, speakers: 1 });
  assert.match(await readFile(path.join(root, "research", "speakers.tsv"), "utf8"), /mygo-1\t高松 燈\t羊宮妃那\tperformer[\s\S]*#77BBDD[\s\S]*https:\/\/example\.test\/color/);
  assert.match(await readFile(path.join(root, "research", "glossary.tsv"), "utf8"), /迷子集会\tまいごせんたー\t迷子集会/);
  assert.match(await readFile(path.join(root, "research", "brief.md"), "utf8"), /核对角色与声优/);
  assert.match(await readFile(path.join(root, "research", "sources.md"), "utf8"), /https:\/\/example\.test\/show/);
});

test("local media acquisition completes before the first controller model request", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gakuniku-acquire-first-"));
  const job = path.join(root, "job");
  const bin = path.join(root, "bin");
  await mkdir(path.join(job, "work"), { recursive: true });
  await mkdir(bin, { recursive: true });
  const source = path.join(root, "source.mp4");
  const prompt = path.join(job, "work", "prompt.md");
  await writeFile(source, "mock media bytes");
  await writeFile(prompt, "验证确定性获取素材。", "utf8");
  const pythonShim = path.join(bin, "python3");
  await writeFile(pythonShim, "#!/bin/sh\nprintf '%s\\n' '{\"path\":\"mock\",\"size_bytes\":16,\"duration_seconds\":20,\"format\":\"mp4\",\"streams\":[{\"type\":\"video\"},{\"type\":\"audio\"}]}'\n", "utf8");
  await chmod(pythonShim, 0o755);
  await writeFile(path.join(job, "studio-job.json"), JSON.stringify({ source, outputPath: path.join(root, "output") }));
  await writeFile(path.join(job, "manifest.json"), JSON.stringify({
    source: { kind: "local", value: source, acquired_media: null }, artifacts: {},
    phases: Object.fromEntries(phases.map((id) => [id, { status: "pending", evidence: [] }])),
  }));

  let requestCount = 0;
  let acquireCompleteBeforeFirstModel = false;
  const api = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      requestCount += 1;
      if (requestCount === 1) {
        const current = JSON.parse(await readFile(path.join(job, "manifest.json"), "utf8"));
        acquireCompleteBeforeFirstModel = current.phases.acquire.status === "complete" && current.source.acquired_media === source;
      }
      const patch = Object.fromEntries(phases.filter((id) => id !== "acquire").map((id) => [id, { status: "complete", evidence: [`mock ${id}`] }]));
      const content = requestCount === 1
        ? JSON.stringify({ type: "tool", summary: "完成其余阶段", calls: [{ tool: "update_manifest", input: { patch: { phases: patch } } }] })
        : JSON.stringify({ type: "finish", summary: "完成" });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }], usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 } }));
    });
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(() => api.close());
  const child = spawn(process.execPath, [runnerPath, "--job-dir", job, "--prompt", prompt], {
    cwd: projectRoot,
    env: { ...process.env, PATH: bin, PSS_API_PROVIDER: "compatible", PSS_API_BASE_URL: `http://127.0.0.1:${api.address().port}/v1`, PSS_API_KEY: "test", PSS_API_MODEL: "mock" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, stderr);
  assert.equal(acquireCompleteBeforeFirstModel, true);
  const report = JSON.parse(await readFile(path.join(job, "work", "acquire-media.json"), "utf8"));
  assert.equal(report.duration_seconds, 20);
});

test("deterministic full-media transcription reuses every valid chunk and merges real JSON", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gakuniku-transcribe-media-"));
  const work = path.join(root, "work");
  const bin = path.join(root, "bin");
  await mkdir(work, { recursive: true });
  await mkdir(bin, { recursive: true });
  const media = path.join(root, "source.mp4");
  const audio = path.join(work, "full-16k.flac");
  const output = path.join(work, "source-transcript.json");
  await writeFile(media, "mock media");
  await writeFile(audio, "mock audio");

  const fakeProbe = path.join(bin, "ffprobe");
  const mustNotRun = path.join(bin, "must-not-run");
  await writeFile(fakeProbe, "#!/bin/sh\nprintf '%s\\n' '{\"format\":{\"duration\":\"1250.0\"}}'\n", "utf8");
  await writeFile(mustNotRun, "#!/bin/sh\nexit 99\n", "utf8");
  await chmod(fakeProbe, 0o755);
  await chmod(mustNotRun, 0o755);

  const chunkDurations = [600, 600, 50];
  for (let index = 0; index < chunkDurations.length; index += 1) {
    const suffix = String(index).padStart(2, "0");
    await writeFile(path.join(work, `chunk_${suffix}.flac`), `chunk ${index}`);
    await writeFile(path.join(work, `transcript_chunk_${suffix}.json`), JSON.stringify({
      engine: "faster-whisper",
      model: "turbo",
      language: "ja",
      language_probability: 0.99,
      duration: chunkDurations[index],
      segments: [{ id: 1, start: 1, end: 2, text: `chunk-${index}`, words: [{ start: 1, end: 2, word: `chunk-${index}` }] }],
      runtime: { mock: true },
    }));
  }
  await writeFile(output, "This Markdown must never be accepted as transcript JSON.", "utf8");

  const script = path.join(projectRoot, "harness", "precision-video-subtitles", "scripts", "transcribe_media.py");
  const child = spawn(process.env.PSS_TRANSCRIPTION_PYTHON || "python3", [
    script, media, output,
    "--work-dir", work,
    "--ffmpeg", mustNotRun,
    "--ffprobe", fakeProbe,
    "--transcriber-script", mustNotRun,
    "--chunk-seconds", "600",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  assert.equal(await new Promise((resolve) => child.on("close", resolve)), 0, stderr);

  const summary = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.equal(summary.reused_transcripts, 3);
  assert.equal(summary.new_transcripts, 0);
  const merged = JSON.parse(await readFile(output, "utf8"));
  assert.equal(merged.duration, 1250);
  assert.equal(merged.chunk_count, 3);
  assert.deepEqual(merged.segments.map((segment) => segment.id), [1, 2, 3]);
  assert.deepEqual(merged.segments.map((segment) => segment.start), [1, 601, 1201]);
  assert.deepEqual(merged.segments.map((segment) => segment.text), ["chunk-0", "chunk-1", "chunk-2"]);
  assert.equal(merged.provenance.audio_chunks.length, 3);
  assert.match(stdout, /"stage": "reuse_audio_chunks"/);
  assert.match(stdout, /"stage": "merge_complete"/);
});

test("a successful tool call breaks the consecutive-failure counter", async (t) => {
  let requestCount = 0;
  const root = await mkdtemp(path.join(os.tmpdir(), "gakuniku-adjacent-failure-"));
  const job = path.join(root, "job");
  await mkdir(path.join(job, "work"), { recursive: true });
  const source = path.join(root, "source.mp4");
  const prompt = path.join(job, "work", "prompt.md");
  await writeFile(source, "mock");
  await writeFile(prompt, "相邻失败计数测试。", "utf8");
  await writeFile(path.join(job, "studio-job.json"), JSON.stringify({ source, outputPath: path.join(root, "output") }));
  await writeFile(path.join(job, "manifest.json"), JSON.stringify({
    source: { kind: "local", value: source, acquired_media: source }, artifacts: { source_media: source },
    phases: Object.fromEntries(phases.map((id) => [id, { status: id === "acquire" ? "complete" : "pending", evidence: id === "acquire" ? ["ready"] : [] }])),
  }));
  const missing = path.join(job, "work", "missing.txt");
  const api = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requestCount += 1;
      const complete = Object.fromEntries(phases.map((id) => [id, { status: "complete", evidence: [`mock ${id}`] }]));
      const decisions = [
        { type: "tool", summary: "第一次预期失败", calls: [{ tool: "read_text", input: { path: missing } }] },
        { type: "tool", summary: "成功调用打断失败序列", calls: [{ tool: "read_text", input: { path: path.join(job, "manifest.json") } }] },
        { type: "tool", summary: "同参数再次失败但不连续", calls: [{ tool: "read_text", input: { path: missing } }] },
        { type: "tool", summary: "完成测试", calls: [{ tool: "update_manifest", input: { patch: { phases: complete } } }] },
        { type: "finish", summary: "完成" },
      ];
      const content = JSON.stringify(decisions[Math.min(requestCount - 1, decisions.length - 1)]);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }], usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 } }));
    });
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(() => api.close());

  const child = spawn(process.execPath, [runnerPath, "--job-dir", job, "--prompt", prompt], {
    cwd: projectRoot,
    env: { ...process.env, PATH: "", PSS_API_PROVIDER: "compatible", PSS_API_BASE_URL: `http://127.0.0.1:${api.address().port}/v1`, PSS_API_KEY: "test", PSS_API_MODEL: "mock" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  assert.equal(await new Promise((resolve) => child.on("close", resolve)), 0, stderr);
  const first = JSON.parse(await readFile(path.join(job, "work", "builtin-harness", "turn-001.json"), "utf8"));
  const third = JSON.parse(await readFile(path.join(job, "work", "builtin-harness", "turn-003.json"), "utf8"));
  assert.equal(first.results[0].attemptsWithSameInput, 1);
  assert.equal(third.results[0].attemptsWithSameInput, 1);
});
