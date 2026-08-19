#!/usr/bin/env python3
"""Run bounded, offline speaker diarization with Sherpa-ONNX."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import wave


def read_wave(path: Path):
    import numpy as np

    with wave.open(str(path), "rb") as audio:
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2 or audio.getframerate() != 16000:
            raise RuntimeError("input must be 16 kHz mono PCM16 WAV")
        samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    return samples


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--segmentation-model", type=Path, required=True)
    parser.add_argument("--embedding-model", type=Path, required=True)
    parser.add_argument("--num-speakers", type=int, default=-1)
    parser.add_argument("--cluster-threshold", type=float, default=0.5)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    result = {"schema_version": 1, "engine": "sherpa-onnx", "status": "failed", "turns": []}
    try:
        import sherpa_onnx

        for model in (args.segmentation_model, args.embedding_model):
            if not model.is_file() or model.stat().st_size < 1_000_000:
                raise RuntimeError(f"diarization model is missing or incomplete: {model}")
        samples = read_wave(args.audio)
        config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
            segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(args.segmentation_model.resolve())),
            ),
            embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(args.embedding_model.resolve())),
            clustering=sherpa_onnx.FastClusteringConfig(
                num_clusters=args.num_speakers,
                threshold=max(0.01, min(0.99, args.cluster_threshold)),
            ),
            min_duration_on=0.3,
            min_duration_off=0.5,
        )
        if not config.validate():
            raise RuntimeError("Sherpa-ONNX diarization configuration is invalid")
        diarizer = sherpa_onnx.OfflineSpeakerDiarization(config)
        turns = diarizer.process(samples).sort_by_start_time()
        result.update({
            "status": "ready",
            "sample_rate": int(diarizer.sample_rate),
            "duration": round(len(samples) / 16000.0, 3),
            "turns": [
                {"start": round(float(turn.start), 3), "end": round(float(turn.end), 3), "speaker": f"speaker_{int(turn.speaker):02d}"}
                for turn in turns
            ],
        })
    except Exception as error:  # native/runtime exceptions vary by platform
        result["error"] = f"{type(error).__name__}: {error}"[:1400]
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(args.output)
    if result["status"] != "ready":
        print(result.get("error", "Sherpa-ONNX diarization failed"), file=sys.stderr)
        return 3
    print(json.dumps({"ok": True, "turns": len(result["turns"]), "output": str(args.output)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
