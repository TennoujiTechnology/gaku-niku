import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (relative) => readFile(new URL(relative, import.meta.url), "utf8");

test("Sherpa-ONNX is the ungated local default and its assets stay checksum-pinned", async () => {
  const [manifestText, prepareScript, diarizeScript, server, studio] = await Promise.all([
    read("../runtime/runtime-manifest.json"),
    read("../harness/precision-video-subtitles/scripts/prepare_sherpa_diarization.py"),
    read("../harness/precision-video-subtitles/scripts/diarize_sherpa_onnx.py"),
    read("../local-agent-bridge/server.mjs"),
    read("../app/SubtitleStudio.tsx"),
  ]);
  const manifest = JSON.parse(manifestText);
  const environment = manifest.environments["diarization-sherpa"];
  assert.ok(environment.packages.includes("sherpa-onnx==1.13.4"));
  for (const asset of Object.values(environment.models)) {
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert.ok(prepareScript.includes(asset.url));
    assert.ok(prepareScript.includes(asset.sha256));
  }
  for (const phrase of ["OfflineSpeakerDiarizationConfig", "FastClusteringConfig", "speaker_", "16 kHz mono PCM16 WAV"]) assert.ok(diarizeScript.includes(phrase));
  assert.match(server, /input\.diarizationEngine \|\| "sherpa_onnx"/);
  assert.match(server, /authorization: "not_required"/);
  assert.match(studio, /useState<DiarizationEngine>\("sherpa_onnx"\)/);
  assert.match(studio, /Sherpa-ONNX（推荐 · 无需账号）/);
});
