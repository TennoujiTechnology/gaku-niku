import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("harness defaults to local Sherpa-ONNX and keeps pyannote gated and bounded", async () => {
  const skill = await readFile(
    new URL("../harness/precision-video-subtitles/SKILL.md", import.meta.url),
    "utf8",
  );

  for (const phrase of [
    "default local diarization route is Sherpa-ONNX",
    "16 kHz mono PCM16 WAV",
    "PSS_TRANSCRIPTION_DIARIZATION_*",
    "Sherpa-ONNX clustering is not identity recognition",
    "A non-empty token is not sufficient",
    "20–30 second real-audio smoke test",
    "torchcodec: bypassed",
    "alignment complete; diarization degraded",
    "MFCC similarity",
    "speaker_unknown",
    "HTTP `401`/`403` as terminal with zero blind retries",
    "Never rerun the complete alignment/diarization pipeline in a loop",
  ]) {
    assert.ok(skill.includes(phrase), `missing WhisperX guardrail: ${phrase}`);
  }
});
