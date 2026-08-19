#!/usr/bin/env python3
"""Run one bounded WhisperX alignment + diarization inference without logging secrets."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys


def emit(output: Path, value: dict) -> None:
    output.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("output")
    parser.add_argument("--language", default="ja")
    parser.add_argument("--model-cache", required=True)
    parser.add_argument("--diarization-model", default="pyannote/speaker-diarization-community-1")
    args = parser.parse_args()
    output = Path(args.output).resolve()
    cache = Path(args.model_cache).expanduser().resolve()
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN") or ""
    result = {
        "alignment": {"status": "pending", "language": args.language},
        "diarization": {"status": "pending", "model": args.diarization_model},
        "torchcodec": {"status": "bypassed", "reason": "preloaded waveform"},
    }
    try:
        import nltk
        import whisperx
        from whisperx.diarize import DiarizationPipeline

        nltk_cache = cache / "nltk"
        nltk_cache.mkdir(parents=True, exist_ok=True)
        nltk.data.path.insert(0, str(nltk_cache))
        try:
            nltk.data.find("tokenizers/punkt_tab")
            result["language_assets"] = {"punkt_tab": "ready"}
        except LookupError:
            downloaded = nltk.download("punkt_tab", download_dir=str(nltk_cache), quiet=True, raise_on_error=False)
            if not downloaded:
                raise RuntimeError("NLTK punkt_tab could not be prepared before transcription")
            nltk.data.find("tokenizers/punkt_tab")
            result["language_assets"] = {"punkt_tab": "downloaded"}

        audio = whisperx.load_audio(str(Path(args.audio).resolve()))
        align_model, metadata = whisperx.load_align_model(
            language_code=args.language,
            device="cpu",
            model_dir=str(cache),
        )
        whisperx.align(
            [{"start": 0.0, "end": min(1.0, len(audio) / 16000), "text": "テスト"}],
            align_model,
            metadata,
            audio,
            "cpu",
            print_progress=False,
        )
        result["alignment"] = {"status": "ready", "language": args.language, "model": metadata.get("type", "whisperx-align")}
        if not token:
            result["diarization"] = {"status": "degraded", "model": args.diarization_model, "authorization": "missing"}
            emit(output, result)
            return 0
        pipeline = DiarizationPipeline(model_name=args.diarization_model, token=token, device="cpu", cache_dir=str(cache))
        turns = pipeline(audio)
        result["diarization"] = {
            "status": "ready",
            "model": args.diarization_model,
            "authorization": "verified",
            "turns": int(len(turns.index)) if hasattr(turns, "index") else 0,
        }
        emit(output, result)
        return 0
    except Exception as error:  # dependency exceptions vary across pinned releases
        text = f"{type(error).__name__}: {error}"
        lowered = text.lower()
        authorization = "denied" if any(marker in lowered for marker in ("401", "403", "gated", "restricted", "access to model")) else "unknown"
        if result["alignment"].get("status") != "ready":
            result["alignment"] = {"status": "failed", "language": args.language, "error": text[:1200]}
        else:
            result["diarization"] = {"status": "degraded", "model": args.diarization_model, "authorization": authorization, "error": text[:1200]}
        emit(output, result)
        return 3 if result["alignment"]["status"] == "failed" else 0


if __name__ == "__main__":
    sys.exit(main())
