#!/usr/bin/env python3
"""Bounded, disk-backed Faster-Whisper transcription for subtitle jobs."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


MODEL_ALIASES = {
    "turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Transcribe one bounded audio chunk with Faster-Whisper")
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--model", default="turbo")
    parser.add_argument("--language", default="ja")
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--prompt", default="")
    parser.add_argument("--model-cache", default="")
    parser.add_argument("--allow-download", action="store_true")
    parser.add_argument("--no-vad", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.input.is_file():
        raise SystemExit(f"audio input does not exist: {args.input}")
    args.output.parent.mkdir(parents=True, exist_ok=True)

    try:
        from faster_whisper import WhisperModel
    except ImportError as error:
        raise SystemExit("faster_whisper is not installed in this Python environment") from error

    cache_dir = Path(args.model_cache).expanduser().resolve() if args.model_cache else None
    if cache_dir:
        cache_dir.mkdir(parents=True, exist_ok=True)
    model_options = {
        "device": args.device,
        "compute_type": args.compute_type,
        "download_root": str(cache_dir) if cache_dir else None,
        "local_files_only": not args.allow_download,
    }
    model_options = {key: value for key, value in model_options.items() if value is not None}
    try:
        model = WhisperModel(MODEL_ALIASES.get(args.model, args.model), **model_options)
    except Exception as error:  # library errors vary by model source and runtime
        hint = "；模型尚未缓存，请在界面确认下载后重试" if not args.allow_download else ""
        raise SystemExit(f"unable to load Faster-Whisper model {args.model}: {error}{hint}") from error

    segments_iter, info = model.transcribe(
        str(args.input),
        language=None if args.language == "auto" else args.language,
        beam_size=max(1, args.beam_size),
        vad_filter=not args.no_vad,
        word_timestamps=True,
        initial_prompt=args.prompt or None,
        condition_on_previous_text=False,
    )
    segments = []
    for index, segment in enumerate(segments_iter, start=1):
        words = [
            {
                "start": round(float(word.start), 3),
                "end": round(float(word.end), 3),
                "word": str(word.word),
                "probability": round(float(word.probability), 5),
            }
            for word in (segment.words or [])
            if word.start is not None and word.end is not None
        ]
        start = words[0]["start"] if words else round(float(segment.start), 3)
        end = words[-1]["end"] if words else round(float(segment.end), 3)
        segments.append({
            "id": index,
            "start": start,
            "end": end,
            "text": str(segment.text).strip(),
            "words": words,
            "speaker": "speaker-unknown",
        })

    payload = {
        "schema_version": 1,
        "engine": "faster-whisper",
        "model": args.model,
        "language": getattr(info, "language", args.language),
        "language_probability": round(float(getattr(info, "language_probability", 0.0)), 5),
        "duration": round(float(getattr(info, "duration", 0.0)), 3),
        "word_timestamps": True,
        "diarization": False,
        "segments": segments,
        "runtime": {
            "device": args.device,
            "compute_type": args.compute_type,
            "pid": os.getpid(),
        },
    }
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(args.output)
    print(json.dumps({"ok": True, "segments": len(segments), "output": str(args.output)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
