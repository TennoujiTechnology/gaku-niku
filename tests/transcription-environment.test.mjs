import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");

async function startBridge(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pss-transcription-test-"));
  const port = 45200 + Math.floor(Math.random() * 800);
  const environment = { ...process.env, PSS_BRIDGE_PORT: String(port), PSS_JOBS_PATH: path.join(root, "jobs"), PSS_ASR_ROOT: path.join(root, "default-asr"), PSS_ASR_LOCAL_RUNTIME_ROOT: path.join(root, "local-runtimes"), PSS_ASR_PYTHON: path.join(root, "missing-python"), PSS_CODEX_PATH: process.execPath };
  if (options.withoutMediaTools) environment.PATH = path.join(root, "empty-path");
  if (options.fakeMediaTools && process.platform !== "win32") {
    const fakeBin = path.join(root, "fake-media-tools");
    await mkdir(fakeBin, { recursive: true });
    const ffprobe = path.join(fakeBin, "ffprobe");
    const ffmpeg = path.join(fakeBin, "ffmpeg");
    await writeFile(ffprobe, "#!/bin/sh\nprintf '2\\n'\n", "utf8");
    await writeFile(ffmpeg, "#!/bin/sh\nfor last in \"$@\"; do :; done\nprintf 'fixture audio' > \"$last\"\n", "utf8");
    await Promise.all([chmod(ffprobe, 0o755), chmod(ffmpeg, 0o755)]);
    environment.PSS_FFPROBE_PATH = ffprobe;
    environment.PSS_FFMPEG_PATH = ffmpeg;
  }
  const child = spawn(process.execPath, [path.join(projectRoot, "local-agent-bridge", "server.mjs")], {
    cwd: projectRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return { child, port, root };
    } catch { /* bridge may still be starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill();
  throw new Error(`bridge did not start: ${stderr}`);
}

test("health endpoint exposes the bounded job resource policy", async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.child.kill());

  const response = await fetch(`http://127.0.0.1:${bridge.port}/api/health`);
  assert.equal(response.status, 200);
  const result = await response.json();

  assert.equal(result.version, 4);
  assert.equal(result.resourcePolicy.maxConcurrentJobs, 1);
  assert.ok(result.resourcePolicy.memoryLimitBytes >= 1024 ** 3);
  assert.equal(result.resourcePolicy.idleTimeoutMs, 10 * 60 * 1000);
  assert.equal(result.resourcePolicy.stdoutLogLimitBytes, 32 * 1024 ** 2);
  assert.equal(result.resourcePolicy.stderrLogLimitBytes, 8 * 1024 ** 2);
});

test("transcription check is read-only and reports missing local dependencies", async (t) => {
  const bridge = await startBridge({ withoutMediaTools: true });
  t.after(() => bridge.child.kill());
  const response = await fetch(`http://127.0.0.1:${bridge.port}/api/transcription/check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcription: { mode: "local", provider: "faster_whisper", model: "turbo", diarization: false, runtimeRoot: path.join(bridge.root, "default-asr", "runtimes") } }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ready, false);
  assert.equal(result.components.find((item) => item.id === "runtime")?.status, "missing");
  assert.equal(result.components.find((item) => item.id === "model")?.status, "missing");
  assert.equal(result.components.find((item) => item.id === "media-tools")?.status, "missing");
  assert.equal(result.components.find((item) => item.id === "diarization")?.status, "optional");
  assert.match(result.resources.downloadLabel, /GB|MB/);
  assert.equal(result.environmentRoot, path.join(bridge.root, "default-asr"));
  assert.equal(result.runtimePath, path.join(bridge.root, "default-asr", "runtimes", "base"));
  assert.equal(result.diarizationRuntimePath, path.join(bridge.root, "default-asr", "runtimes", "diarization-sherpa-onnx"));
  assert.equal(result.diarizationEngine, "sherpa_onnx");
  assert.equal(result.cachePath, path.join(bridge.root, "default-asr", "models"));
  assert.equal(result.storageLayout.mode, result.storageLayout.runtimeCompatible ? "project" : "split");
  assert.equal(result.diagnostics.healthy, false);
  assert.equal(result.diagnostics.repairComponents.runtime, true);
  assert.equal(result.diagnostics.repairComponents.mediaTools, true);
  assert.match(result.resources.nativeToolsDownloadLabel, /MB|当前平台未提供/);
});

test("transcription check respects a user-selected project environment folder", async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.child.kill());
  const environmentRoot = path.join(bridge.root, "project", ".precision-subtitle-studio", "asr");
  const response = await fetch(`http://127.0.0.1:${bridge.port}/api/transcription/check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcription: { mode: "local", provider: "faster_whisper", model: "tiny", diarization: false, environmentRoot } }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.environmentRoot, environmentRoot);
  if (result.storageLayout.runtimeCompatible) {
    assert.equal(result.runtimePath, path.join(environmentRoot, "runtimes", "base"));
    assert.equal(result.diarizationRuntimePath, path.join(environmentRoot, "runtimes", "diarization-sherpa-onnx"));
  } else {
    assert.match(result.runtimePath, new RegExp(`^${path.join(bridge.root, "local-runtimes").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(result.diarizationRuntimePath, new RegExp(`^${path.join(bridge.root, "local-runtimes").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }
  assert.equal(result.cachePath, path.join(environmentRoot, "models"));
});

test("incompatible project disks keep models on the selected disk and route runtimes locally", async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.child.kill());
  const environmentRoot = path.join(projectRoot, ".precision-subtitle-studio", "routing-check");
  const response = await fetch(`http://127.0.0.1:${bridge.port}/api/transcription/check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcription: { mode: "local", provider: "faster_whisper", model: "tiny", diarization: false, environmentRoot } }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.cachePath, path.join(environmentRoot, "models"));
  if (result.storageLayout.runtimeCompatible) {
    assert.equal(result.storageLayout.mode, "project");
    assert.equal(result.runtimePath, path.join(environmentRoot, "runtimes", "base"));
  } else {
    assert.equal(result.storageLayout.mode, "split");
    assert.match(result.runtimePath, new RegExp(`^${path.join(bridge.root, "local-runtimes").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.equal(result.storageLayout.dataPath, environmentRoot);
  }
});

test("installation refuses to run without explicit confirmation", async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.child.kill());
  const response = await fetch(`http://127.0.0.1:${bridge.port}/api/transcription/install`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcription: { mode: "local", provider: "faster_whisper", model: "tiny", confirmed: false, components: { runtime: true } } }),
  });
  assert.equal(response.status, 400);
  const result = await response.json();
  assert.match(result.error, /确认/);
});

test("model download cannot silently install an unconfirmed missing runtime", async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.child.kill());
  const response = await fetch(`http://127.0.0.1:${bridge.port}/api/transcription/install`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcription: { mode: "local", provider: "faster_whisper", model: "tiny", confirmed: true, environmentRoot: path.join(bridge.root, "asr"), components: { runtime: false, model: true, diarization: false } } }),
  });
  assert.equal(response.status, 202);
  const created = await response.json();
  let result;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    result = await fetch(`http://127.0.0.1:${bridge.port}/api/transcription/operations/${created.id}`).then((item) => item.json());
    if (result.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(result.status, "failed");
  assert.match(result.error, /基础听写运行库|同时勾选/);
});

test("requested diarization reports deep imports and authorization separately", async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.child.kill());
  const response = await fetch(`http://127.0.0.1:${bridge.port}/api/transcription/check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcription: { mode: "local", provider: "faster_whisper", model: "tiny", diarization: true, environmentRoot: path.join(bridge.root, "asr") } }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ready, false);
  assert.equal(result.requestedReady, false);
  assert.equal(result.diarizationReady, false);
  assert.equal(result.diagnostics.repairComponents.diarization, true);
  assert.ok(result.diagnostics.issues.some((item) => item.id === "diarization-import"));
  assert.equal(result.components.find((item) => item.id === "diarization")?.status, "degraded");
  assert.match(result.resources.diarizationDownloadLabel, /MB/);
  assert.match(result.recommendation, result.baseReady ? /下载并配置 Sherpa-ONNX|关闭说话人分离/ : /缺失项目|下载/);
});

test("online real-audio test refuses upload without explicit confirmation", async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.child.kill());
  const response = await fetch(`http://127.0.0.1:${bridge.port}/api/transcription/test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcription: { mode: "api", provider: "openai_audio", model: "gpt-4o-mini-transcribe", source: "/tmp/video.mp4", baseUrl: "https://api.example.test/v1", apiKey: "test", uploadConfirmed: false } }),
  });
  assert.equal(response.status, 400);
  const result = await response.json();
  assert.match(result.error, /上传|确认/);
});

test("online real-audio test extracts a bounded local sample and returns transcript", { skip: process.platform === "win32" }, async (t) => {
  const bridge = await startBridge({ fakeMediaTools: true });
  t.after(() => bridge.child.kill());
  const audioPath = path.join(bridge.root, "speech.wav");
  const sampleRate = 16_000;
  const samples = sampleRate * 2;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  await writeFile(audioPath, wav);
  const fakeApi = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ text: "これは実音声テストです", language: "ja", segments: [{ start: 0, end: 2, text: "これは実音声テストです" }] }));
    });
  });
  await new Promise((resolve) => fakeApi.listen(0, "127.0.0.1", resolve));
  t.after(() => fakeApi.close());
  const fakePort = fakeApi.address().port;
  const response = await fetch(`http://127.0.0.1:${bridge.port}/api/transcription/test`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcription: { mode: "api", provider: "openai_audio", model: "gpt-4o-mini-transcribe", source: audioPath, baseUrl: `http://127.0.0.1:${fakePort}/v1`, apiKey: "test", language: "ja", uploadConfirmed: true } }),
  });
  assert.equal(response.status, 202);
  const created = await response.json();
  let result;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    result = await fetch(`http://127.0.0.1:${bridge.port}/api/transcription/operations/${created.id}`).then((item) => item.json());
    if (result.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(result.status, "completed", result.error || "真实短音频测试未完成");
  assert.equal(result.result.text, "これは実音声テストです");
  assert.equal(result.result.sampleDuration, 2);
  assert.ok(result.result.elapsedMs > 0);
});

test("stale running task with a blocked phase is reconciled as blocked", async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.child.kill());
  const jobId = "1068d3a1-9e92-49f6-882b-5a4a56b9453a";
  const jobDirectory = path.join(bridge.root, "jobs", jobId);
  await mkdir(path.join(jobDirectory, "work"), { recursive: true });
  await writeFile(path.join(jobDirectory, "job-state.json"), JSON.stringify({ id: jobId, status: "running", pid: 999_999_999, message: "still running" }));
  await writeFile(path.join(jobDirectory, "manifest.json"), JSON.stringify({
    phases: {
      acquire: { status: "complete", evidence: ["source ready"] },
      research: { status: "complete", evidence: ["research ready"] },
      source_transcript: { status: "blocked", reason: "Faster-Whisper is missing", evidence: ["import failed"] },
    },
    artifacts: {},
    limitations: ["No transcript was produced"],
  }));
  await writeFile(path.join(jobDirectory, "studio-job.json"), JSON.stringify({ execution: { showTrace: false } }));
  const response = await fetch(`http://127.0.0.1:${bridge.port}/api/jobs/${jobId}`);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, "blocked");
  assert.equal(result.phases.source_transcript, "blocked");
  assert.equal(result.blocker.phase, "source_transcript");
});

test("stale running task with every manifest phase complete is reconciled as completed", async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.child.kill());
  const jobId = "1168d3a1-9e92-49f6-882b-5a4a56b9453a";
  const jobDirectory = path.join(bridge.root, "jobs", jobId);
  await mkdir(path.join(jobDirectory, "work"), { recursive: true });
  await writeFile(path.join(jobDirectory, "job-state.json"), JSON.stringify({ id: jobId, status: "running", pid: 999_999_999, message: "still running" }));
  await writeFile(path.join(jobDirectory, "manifest.json"), JSON.stringify({
    phases: Object.fromEntries(["acquire", "research", "source_transcript", "translate", "resolve_ambiguities", "subtitle_qc", "mux", "final_validation"].map((id) => [id, { status: "complete", evidence: [`${id} ready`] }])),
    artifacts: {},
    limitations: [],
  }));
  await writeFile(path.join(jobDirectory, "studio-job.json"), JSON.stringify({ execution: { showTrace: false } }));
  const response = await fetch(`http://127.0.0.1:${bridge.port}/api/jobs/${jobId}`);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, "completed");
  assert.equal(result.progress, 100);
  assert.equal(result.error, undefined);
});

test("completed task separates informational provenance from actionable limitations", async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.child.kill());
  const jobId = "1268d3a1-9e92-49f6-882b-5a4a56b9453b";
  const jobDirectory = path.join(bridge.root, "jobs", jobId);
  await mkdir(jobDirectory, { recursive: true });
  await writeFile(path.join(jobDirectory, "job-state.json"), JSON.stringify({ id: jobId, status: "completed", message: "done" }));
  await writeFile(path.join(jobDirectory, "manifest.json"), JSON.stringify({
    phases: Object.fromEntries(["acquire", "research", "source_transcript", "translate", "resolve_ambiguities", "subtitle_qc", "mux", "final_validation"].map((id) => [id, { status: "complete", evidence: [`${id} ready`] }])),
    artifacts: {},
    notices: ["字体已嵌入交付文件。"],
    limitations: [
      "Official role colour codes were not established; ASS styling uses the deterministic fallback palette.",
      "Cue 8 is resolved but remains flagged=true for optional refinement-workbench inspection.",
      "Output duration differs from the source by more than one second.",
      "Role colours use a fallback palette but are unreadable on bright frames.",
    ],
  }));
  await writeFile(path.join(jobDirectory, "studio-job.json"), JSON.stringify({ execution: { showTrace: false } }));

  const result = await fetch(`http://127.0.0.1:${bridge.port}/api/jobs/${jobId}`).then((item) => item.json());
  assert.deepEqual(result.manifest.limitations, [
    "Output duration differs from the source by more than one second.",
    "Role colours use a fallback palette but are unreadable on bright frames.",
  ]);
  assert.equal(result.manifest.notices.length, 3);
  assert.match(result.manifest.notices.join("\n"), /确定性回退色/);
  assert.match(result.manifest.notices.join("\n"), /可选人工复看/);
});

test("running task can be terminated without losing its resumable manifest", async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.child.kill());
  const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => { try { worker.kill("SIGKILL"); } catch { /* already stopped */ } });
  const jobId = "1268d3a1-9e92-49f6-882b-5a4a56b9453a";
  const jobDirectory = path.join(bridge.root, "jobs", jobId);
  await mkdir(path.join(jobDirectory, "work"), { recursive: true });
  await writeFile(path.join(jobDirectory, "job-state.json"), JSON.stringify({ id: jobId, status: "running", pid: worker.pid, createdAt: new Date().toISOString(), message: "still running" }));
  await writeFile(path.join(jobDirectory, "manifest.json"), JSON.stringify({
    phases: {
      acquire: { status: "complete", evidence: ["source ready"] },
      research: { status: "in_progress", evidence: ["research started"] },
      source_transcript: { status: "pending", evidence: [] }, translate: { status: "pending", evidence: [] }, resolve_ambiguities: { status: "pending", evidence: [] }, subtitle_qc: { status: "pending", evidence: [] }, mux: { status: "pending", evidence: [] }, final_validation: { status: "pending", evidence: [] },
    },
    artifacts: {}, limitations: [],
  }));
  await writeFile(path.join(jobDirectory, "studio-job.json"), JSON.stringify({ execution: { showTrace: false } }));

  const response = await fetch(`http://127.0.0.1:${bridge.port}/api/jobs/${jobId}/cancel`, { method: "POST" });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, "cancelled");
  assert.equal(result.resumable, true);
  assert.match(result.message, /保留|断点/);

  for (let attempt = 0; attempt < 40 && worker.exitCode == null && worker.signalCode == null; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(worker.exitCode != null || worker.signalCode != null, "worker process should be stopped");
  const saved = JSON.parse(await readFile(path.join(jobDirectory, "job-state.json"), "utf8"));
  assert.equal(saved.status, "cancelled");
  const status = await fetch(`http://127.0.0.1:${bridge.port}/api/jobs/${jobId}`).then((item) => item.json());
  assert.equal(status.status, "cancelled");
  assert.equal(status.phases.acquire, "done");
  assert.equal(status.phases.research, "running");
});

test("terminate endpoint is idempotent for an already completed task", async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.child.kill());
  const jobId = "1368d3a1-9e92-49f6-882b-5a4a56b9453a";
  const jobDirectory = path.join(bridge.root, "jobs", jobId);
  await mkdir(jobDirectory, { recursive: true });
  await writeFile(path.join(jobDirectory, "job-state.json"), JSON.stringify({ id: jobId, status: "completed", message: "done" }));

  const response = await fetch(`http://127.0.0.1:${bridge.port}/api/jobs/${jobId}/cancel`, { method: "POST" });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, "completed");
  assert.equal(result.alreadyStopped, true);
  const saved = JSON.parse(await readFile(path.join(jobDirectory, "job-state.json"), "utf8"));
  assert.equal(saved.status, "completed");
});

test("resume preserves completed phases and starts from the first blocked phase", async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.child.kill());
  const jobId = "2068d3a1-9e92-49f6-882b-5a4a56b9453a";
  const jobDirectory = path.join(bridge.root, "jobs", jobId);
  const mediaPath = path.join(jobDirectory, "source", "input.mp4");
  await mkdir(path.dirname(mediaPath), { recursive: true });
  await mkdir(path.join(jobDirectory, "research"), { recursive: true });
  await mkdir(path.join(jobDirectory, "logs"), { recursive: true });
  await mkdir(path.join(jobDirectory, "work"), { recursive: true });
  await writeFile(mediaPath, "fixture");
  const researchArtifacts = {
    research_brief: path.join(jobDirectory, "research", "brief.md"),
    research_sources: path.join(jobDirectory, "research", "sources.md"),
    research_glossary: path.join(jobDirectory, "research", "glossary.tsv"),
    research_speakers: path.join(jobDirectory, "research", "speakers.tsv"),
  };
  await Promise.all(Object.values(researchArtifacts).map((file) => writeFile(file, "fixture\n")));
  await writeFile(path.join(jobDirectory, "job-state.json"), JSON.stringify({ id: jobId, status: "blocked", pid: 999_999_999, attempt: 1, createdAt: new Date().toISOString() }));
  await writeFile(path.join(jobDirectory, "studio-job.json"), JSON.stringify({
    source: mediaPath, outputPath: path.join(jobDirectory, "deliverables"), formats: ["srt"],
    engine: { mode: "cli", cli: "codex", model: "" },
    transcription: { mode: "api", provider: "openai_audio", model: "gpt-4o-mini-transcribe", baseUrl: "https://api.example.test/v1", apiKey: "" },
    search: { provider: "builtin" }, research: { keywords: ["fixture"], sites: [] }, execution: { showTrace: false },
  }));
  await writeFile(path.join(jobDirectory, "manifest.json"), JSON.stringify({
    source: { kind: "local", value: mediaPath, acquired_media: mediaPath }, artifacts: { source_media: mediaPath, ...researchArtifacts }, limitations: [],
    phases: {
      acquire: { status: "complete", evidence: ["media validated"] },
      research: { status: "complete", evidence: ["research validated"] },
      source_transcript: { status: "blocked", reason: "runtime missing", evidence: [] },
      translate: { status: "pending", evidence: [] }, resolve_ambiguities: { status: "pending", evidence: [] }, subtitle_qc: { status: "pending", evidence: [] }, mux: { status: "pending", evidence: [] }, final_validation: { status: "pending", evidence: [] },
    },
  }));
  const response = await fetch(`http://127.0.0.1:${bridge.port}/api/jobs/${jobId}/resume`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      transcription: { apiKey: "transcription-test-key" },
      externalProcessingConsent: {
        version: 1,
        granted: true,
        grantedAt: new Date().toISOString(),
        currentTaskOnly: true,
        fingerprint: "transcription:openai_audio:gpt-4o-mini-transcribe:https://api.example.test",
      },
    }),
  });
  assert.equal(response.status, 202);
  const result = await response.json();
  assert.equal(result.resumeFrom, "source_transcript");
  assert.equal(result.attempt, 2);
  const status = await fetch(`http://127.0.0.1:${bridge.port}/api/jobs/${jobId}`).then((item) => item.json());
  assert.equal(status.phases.acquire, "done");
  assert.equal(status.phases.research, "done");
  assert.equal(status.externalProcessingConsent.granted, true);
  const resumedManifest = JSON.parse(await readFile(path.join(jobDirectory, "manifest.json"), "utf8"));
  assert.equal(resumedManifest.phases.source_transcript.reason, undefined);
  assert.equal(resumedManifest.phases.source_transcript.error, undefined);
});

test("resume resets a completed phase that has no registered artifact", async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.child.kill());
  const jobId = "2168d3a1-9e92-49f6-882b-5a4a56b9453a";
  const jobDirectory = path.join(bridge.root, "jobs", jobId);
  const mediaPath = path.join(jobDirectory, "source", "input.mp4");
  const researchDirectory = path.join(jobDirectory, "research");
  const workDirectory = path.join(jobDirectory, "work");
  await mkdir(path.dirname(mediaPath), { recursive: true });
  await mkdir(researchDirectory, { recursive: true });
  await mkdir(path.join(jobDirectory, "logs"), { recursive: true });
  await mkdir(workDirectory, { recursive: true });
  await writeFile(mediaPath, "fixture");
  const artifacts = {
    source_media: mediaPath,
    research_brief: path.join(researchDirectory, "brief.md"),
    research_sources: path.join(researchDirectory, "sources.md"),
    research_glossary: path.join(researchDirectory, "glossary.tsv"),
    research_speakers: path.join(researchDirectory, "speakers.tsv"),
    source_transcript: path.join(workDirectory, "source-transcript.json"),
  };
  await Promise.all(Object.values(artifacts).filter((file) => file !== mediaPath).map((file) => writeFile(file, "fixture\n")));
  await writeFile(path.join(jobDirectory, "job-state.json"), JSON.stringify({ id: jobId, status: "blocked", pid: 999_999_999, attempt: 1, createdAt: new Date().toISOString() }));
  await writeFile(path.join(jobDirectory, "studio-job.json"), JSON.stringify({
    source: mediaPath, outputPath: path.join(jobDirectory, "deliverables"), formats: ["srt"],
    engine: { mode: "cli", cli: "codex", model: "" },
    transcription: { mode: "api", provider: "openai_audio", model: "gpt-4o-mini-transcribe", baseUrl: "https://api.example.test/v1", apiKey: "" },
    search: { provider: "builtin" }, research: { keywords: ["fixture"], sites: [] }, execution: { showTrace: false },
  }));
  await writeFile(path.join(jobDirectory, "manifest.json"), JSON.stringify({
    source: { kind: "local", value: mediaPath, acquired_media: mediaPath }, artifacts, limitations: [],
    phases: {
      acquire: { status: "complete", evidence: ["media"] }, research: { status: "complete", evidence: ["research"] }, source_transcript: { status: "complete", evidence: ["transcript"] },
      translate: { status: "complete", evidence: ["claimed without output"] }, resolve_ambiguities: { status: "in_progress", evidence: [] },
      subtitle_qc: { status: "pending", evidence: [] }, mux: { status: "pending", evidence: [] }, final_validation: { status: "pending", evidence: [] },
    },
  }));
  const response = await fetch(`http://127.0.0.1:${bridge.port}/api/jobs/${jobId}/resume`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      transcription: { apiKey: "transcription-test-key" },
      externalProcessingConsent: { version: 1, granted: true, grantedAt: new Date().toISOString(), currentTaskOnly: true, fingerprint: "transcription:openai_audio:gpt-4o-mini-transcribe:https://api.example.test" },
    }),
  });
  assert.equal(response.status, 202);
  const result = await response.json();
  assert.equal(result.resumeFrom, "translate");
  assert.ok(result.warnings.some((item) => /translate.*没有登记必要产物/.test(item)));
  const resumed = JSON.parse(await readFile(path.join(jobDirectory, "manifest.json"), "utf8"));
  assert.equal(resumed.phases.translate.status, "pending");
  assert.equal(resumed.phases.resolve_ambiguities.status, "pending");
  await fetch(`http://127.0.0.1:${bridge.port}/api/jobs/${jobId}/cancel`, { method: "POST" });
});
