#!/usr/bin/env python3
"""Deterministic, resumable full-media transcription for the Built-in Harness."""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path
from typing import Any


def progress(stage: str, **details: Any) -> None:
    print(json.dumps({"type": "progress", "stage": stage, **details}, ensure_ascii=False), flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract, chunk, transcribe, validate, and merge one media source")
    parser.add_argument("media", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--ffmpeg", type=Path, required=True)
    parser.add_argument("--ffprobe", type=Path, required=True)
    parser.add_argument("--transcriber-script", type=Path, required=True)
    parser.add_argument("--chunk-seconds", type=int, default=600)
    parser.add_argument("--model", default="turbo")
    parser.add_argument("--language", default="ja")
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--model-cache", default="")
    return parser.parse_args()


def run(command: list[str], label: str) -> str:
    result = subprocess.run(command, text=True, capture_output=True, check=False)
    if result.returncode:
        detail = (result.stderr or result.stdout or f"exit {result.returncode}")[-6000:]
        raise RuntimeError(f"{label} failed ({result.returncode}): {detail}")
    return result.stdout


def write_json_atomic(target: Path, payload: Any) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(target)


def read_transcript(target: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or not isinstance(payload.get("segments"), list):
        return None
    if not all(isinstance(item, dict) and isinstance(item.get("text"), str) for item in payload["segments"]):
        return None
    try:
        float(payload.get("duration", 0))
    except (TypeError, ValueError):
        return None
    return payload


def duration_seconds(ffprobe: Path, media: Path) -> float:
    raw = run([
        str(ffprobe), "-v", "error", "-show_entries", "format=duration", "-of", "json", str(media)
    ], "ffprobe duration")
    try:
        value = float(json.loads(raw)["format"]["duration"])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise RuntimeError("ffprobe did not return a valid duration") from error
    if not math.isfinite(value) or value <= 0:
        raise RuntimeError(f"invalid media duration: {value}")
    return value


def find_reusable_audio(work_dir: Path) -> Path | None:
    for name in ("source-audio-16k-mono.flac", "full-16k.flac", "full-audio-16k-mono.flac"):
        candidate = work_dir / name
        if candidate.is_file() and candidate.stat().st_size > 0:
            return candidate
    return None


def prepare_chunks(args: argparse.Namespace, audio: Path, expected_count: int) -> list[Path]:
    legacy = sorted(args.work_dir.glob("chunk_*.flac"))
    if len(legacy) == expected_count and all(item.stat().st_size > 0 for item in legacy):
        progress("reuse_audio_chunks", chunks=len(legacy))
        return legacy

    chunk_dir = args.work_dir / "audio-chunks"
    chunk_dir.mkdir(parents=True, exist_ok=True)
    chunks = sorted(chunk_dir.glob("chunk_*.flac"))
    if len(chunks) != expected_count or not all(item.stat().st_size > 0 for item in chunks):
        for stale in chunks:
            stale.unlink()
        progress("segment_audio", expected_chunks=expected_count, chunk_seconds=args.chunk_seconds)
        run([
            str(args.ffmpeg), "-y", "-v", "error", "-i", str(audio),
            "-map", "0:a:0", "-f", "segment", "-segment_time", str(args.chunk_seconds),
            "-reset_timestamps", "1", "-c:a", "flac", str(chunk_dir / "chunk_%03d.flac"),
        ], "audio segmentation")
        chunks = sorted(chunk_dir.glob("chunk_*.flac"))
    if len(chunks) != expected_count:
        raise RuntimeError(f"audio segmentation produced {len(chunks)} chunks; expected {expected_count}")
    if not all(item.stat().st_size > 0 for item in chunks):
        raise RuntimeError("audio segmentation produced an empty chunk")
    return chunks


def transcript_path(work_dir: Path, chunk: Path) -> Path:
    suffix = chunk.stem.removeprefix("chunk_")
    legacy = work_dir / f"transcript_chunk_{suffix}.json"
    if read_transcript(legacy) is not None:
        return legacy
    return work_dir / "transcript-chunks" / f"transcript_chunk_{suffix}.json"


def transcribe_chunk(args: argparse.Namespace, chunk: Path, target: Path) -> dict[str, Any]:
    existing = read_transcript(target)
    if existing is not None:
        return existing
    target.parent.mkdir(parents=True, exist_ok=True)
    command = [
        sys.executable, str(args.transcriber_script), str(chunk), str(target),
        "--model", args.model, "--language", args.language,
        "--beam-size", str(max(1, args.beam_size)),
        "--compute-type", args.compute_type, "--device", args.device,
    ]
    if args.model_cache:
        command.extend(["--model-cache", args.model_cache])
    run(command, f"transcription {chunk.name}")
    payload = read_transcript(target)
    if payload is None:
        raise RuntimeError(f"transcriber produced invalid JSON: {target}")
    return payload


def adjusted_segment(segment: dict[str, Any], offset: float, identifier: int, chunk_index: int) -> dict[str, Any]:
    result = dict(segment)
    result["id"] = identifier
    result["chunk_index"] = chunk_index
    for key in ("start", "end"):
        result[key] = round(float(segment.get(key, 0)) + offset, 3)
    words = []
    for word in segment.get("words") or []:
        current = dict(word)
        for key in ("start", "end"):
            current[key] = round(float(word.get(key, 0)) + offset, 3)
        words.append(current)
    result["words"] = words
    return result


def validate_merged(payload: dict[str, Any], expected_count: int) -> None:
    if payload.get("chunk_count") != expected_count or not isinstance(payload.get("segments"), list):
        raise RuntimeError("merged transcript has an invalid chunk count or segments array")
    previous = -1.0
    for index, segment in enumerate(payload["segments"], start=1):
        if segment.get("id") != index:
            raise RuntimeError(f"merged transcript id discontinuity at {index}")
        start = float(segment.get("start", -1))
        end = float(segment.get("end", -1))
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end < start:
            raise RuntimeError(f"merged transcript has invalid timing at id {index}")
        if start + 0.001 < previous:
            raise RuntimeError(f"merged transcript is not time ordered at id {index}")
        previous = start


def main() -> int:
    args = parse_args()
    args.media = args.media.expanduser().resolve()
    args.output = args.output.expanduser().resolve()
    args.work_dir = args.work_dir.expanduser().resolve()
    for required in (args.media, args.ffmpeg, args.ffprobe, args.transcriber_script):
        if not required.is_file():
            raise SystemExit(f"required file does not exist: {required}")
    args.work_dir.mkdir(parents=True, exist_ok=True)

    audio = find_reusable_audio(args.work_dir)
    if audio is None:
        audio = args.work_dir / "source-audio-16k-mono.flac"
        progress("extract_audio", output=str(audio))
        run([
            str(args.ffmpeg), "-y", "-v", "error", "-i", str(args.media), "-vn",
            "-ar", "16000", "-ac", "1", "-c:a", "flac", str(audio),
        ], "audio extraction")
    source_duration = duration_seconds(args.ffprobe, audio)
    expected_count = max(1, math.ceil(source_duration / max(30, args.chunk_seconds)))
    chunks = prepare_chunks(args, audio, expected_count)

    payloads: list[dict[str, Any]] = []
    transcript_files: list[Path] = []
    reused = 0
    for chunk in chunks:
        target = transcript_path(args.work_dir, chunk)
        if read_transcript(target) is not None:
            reused += 1
            progress("reuse_transcript", chunk=chunk.name, completed=len(payloads) + 1, total=len(chunks))
        else:
            progress("transcribe_chunk", chunk=chunk.name, completed=len(payloads), total=len(chunks))
        payloads.append(transcribe_chunk(args, chunk, target))
        transcript_files.append(target)

    first = payloads[0]
    segments: list[dict[str, Any]] = []
    for chunk_index, payload in enumerate(payloads):
        offset = float(chunk_index * args.chunk_seconds)
        for segment in payload["segments"]:
            segments.append(adjusted_segment(segment, offset, len(segments) + 1, chunk_index))
    merged = {
        "schema_version": 1,
        "engine": first.get("engine", "faster-whisper"),
        "model": first.get("model", args.model),
        "language": first.get("language", args.language),
        "language_probability": first.get("language_probability", 0),
        "duration": round(source_duration, 3),
        "word_timestamps": True,
        "diarization": False,
        "chunk_seconds": args.chunk_seconds,
        "chunk_count": len(chunks),
        "segments": segments,
        "runtime": first.get("runtime", {}),
        "provenance": {
            "source_media": str(args.media),
            "source_audio": str(audio),
            "audio_chunks": [str(item) for item in chunks],
            "transcript_chunks": [str(item) for item in transcript_files],
        },
    }
    validate_merged(merged, expected_count)
    write_json_atomic(args.output, merged)
    progress("merge_complete", chunks=len(chunks), segments=len(segments), output=str(args.output))
    print(json.dumps({
        "ok": True,
        "output": str(args.output),
        "duration": merged["duration"],
        "chunks": len(chunks),
        "reused_transcripts": reused,
        "new_transcripts": len(chunks) - reused,
        "segments": len(segments),
        "audio": str(audio),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
