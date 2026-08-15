import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");

async function startBridge() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pss-transcription-test-"));
  const port = 45200 + Math.floor(Math.random() * 800);
  const child = spawn(process.execPath, [path.join(projectRoot, "local-agent-bridge", "server.mjs")], {
    cwd: projectRoot,
    env: { ...process.env, PSS_BRIDGE_PORT: String(port), PSS_JOBS_PATH: path.join(root, "jobs"), PSS_ASR_ROOT: path.join(root, "default-asr"), PSS_ASR_LOCAL_RUNTIME_ROOT: path.join(root, "local-runtimes"), PSS_ASR_PYTHON: path.join(root, "missing-python"), PSS_CODEX_PATH: "/usr/bin/true" },
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

test("transcription check is read-only and reports missing local dependencies", async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.child.kill());
  const response = await fetch(`http://127.0.0.1:${bridge.port}/api/transcription/check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcription: { mode: "local", provider: "faster_whisper", model: "turbo", diarization: false } }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ready, false);
  assert.equal(result.components.find((item) => item.id === "runtime")?.status, "missing");
  assert.equal(result.components.find((item) => item.id === "model")?.status, "missing");
  assert.equal(result.components.find((item) => item.id === "diarization")?.status, "optional");
  assert.match(result.resources.downloadLabel, /GB|MB/);
  assert.equal(result.environmentRoot, path.join(bridge.root, "default-asr"));
  assert.equal(result.runtimePath, path.join(bridge.root, "default-asr", "runtimes", "base"));
  assert.equal(result.diarizationRuntimePath, path.join(bridge.root, "default-asr", "runtimes", "diarization"));
  assert.equal(result.cachePath, path.join(bridge.root, "default-asr", "models"));
  assert.equal(result.storageLayout.mode, "project");
  assert.equal(result.diagnostics.healthy, false);
  assert.equal(result.diagnostics.repairComponents.runtime, true);
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
  assert.equal(result.runtimePath, path.join(environmentRoot, "runtimes", "base"));
  assert.equal(result.diarizationRuntimePath, path.join(environmentRoot, "runtimes", "diarization"));
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
  assert.equal(result.diagnostics.repairComponents.diarization, true);
  assert.ok(result.diagnostics.issues.some((item) => item.id === "diarization-import"));
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

test("online real-audio test extracts a bounded local sample and returns transcript", async (t) => {
  const bridge = await startBridge();
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
  assert.equal(result.status, "completed");
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
  await writeFile(path.join(jobDirectory, "job-state.json"), JSON.stringify({ id: jobId, status: "blocked", pid: 999_999_999, attempt: 1, createdAt: new Date().toISOString() }));
  await writeFile(path.join(jobDirectory, "studio-job.json"), JSON.stringify({
    source: mediaPath, outputPath: path.join(jobDirectory, "deliverables"), formats: ["srt"],
    engine: { mode: "cli", cli: "codex", model: "" },
    transcription: { mode: "api", provider: "openai_audio", model: "gpt-4o-mini-transcribe", baseUrl: "https://api.example.test/v1", apiKey: "" },
    search: { provider: "builtin" }, research: { keywords: ["fixture"], sites: [] }, execution: { showTrace: false },
  }));
  await writeFile(path.join(jobDirectory, "manifest.json"), JSON.stringify({
    source: { kind: "local", value: mediaPath, acquired_media: mediaPath }, artifacts: { source_media: mediaPath }, limitations: [],
    phases: {
      acquire: { status: "complete", evidence: ["media validated"] },
      research: { status: "complete", evidence: ["research validated"] },
      source_transcript: { status: "blocked", reason: "runtime missing", evidence: [] },
      translate: { status: "pending", evidence: [] }, resolve_ambiguities: { status: "pending", evidence: [] }, subtitle_qc: { status: "pending", evidence: [] }, mux: { status: "pending", evidence: [] }, final_validation: { status: "pending", evidence: [] },
    },
  }));
  const response = await fetch(`http://127.0.0.1:${bridge.port}/api/jobs/${jobId}/resume`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcription: { apiKey: "transcription-test-key" } }),
  });
  assert.equal(response.status, 202);
  const result = await response.json();
  assert.equal(result.resumeFrom, "source_transcript");
  assert.equal(result.attempt, 2);
  const status = await fetch(`http://127.0.0.1:${bridge.port}/api/jobs/${jobId}`).then((item) => item.json());
  assert.equal(status.phases.acquire, "done");
  assert.equal(status.phases.research, "done");
});
