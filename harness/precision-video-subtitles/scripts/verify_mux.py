#!/usr/bin/env python3
"""Verify muxed media streams, subtitle metadata/packets, and integrity."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("media")
    parser.add_argument("--expect-subtitles", type=int, default=2)
    parser.add_argument("--subtitle-language", default="zho")
    parser.add_argument("--min-width", type=int, default=1)
    parser.add_argument("--min-height", type=int, default=1)
    parser.add_argument("--full-read", action="store_true")
    args = parser.parse_args()

    media = Path(args.media).expanduser().resolve()
    if not media.is_file():
        parser.error(f"not a readable media file: {media}")
    ffprobe = shutil.which("ffprobe")
    ffmpeg = shutil.which("ffmpeg")
    if not ffprobe:
        parser.error("ffprobe is required")
    if args.full_read and not ffmpeg:
        parser.error("ffmpeg is required for --full-read")

    probe = subprocess.run(
        [ffprobe, "-v", "error", "-count_packets", "-show_streams", "-show_format", "-of", "json", str(media)],
        capture_output=True,
        text=True,
        check=False,
    )
    if probe.returncode:
        raise SystemExit(probe.stderr.strip() or f"ffprobe failed with code {probe.returncode}")
    payload = json.loads(probe.stdout)
    streams = payload.get("streams", [])
    videos = [s for s in streams if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")]
    audios = [s for s in streams if s.get("codec_type") == "audio"]
    subtitles = [s for s in streams if s.get("codec_type") == "subtitle"]
    errors: list[str] = []
    warnings: list[str] = []

    if not videos:
        errors.append("no primary video stream")
    if not audios:
        errors.append("no audio stream")
    if len(subtitles) != args.expect_subtitles:
        errors.append(f"expected {args.expect_subtitles} subtitle streams, found {len(subtitles)}")
    if videos:
        width = int(videos[0].get("width") or 0)
        height = int(videos[0].get("height") or 0)
        if width < args.min_width or height < args.min_height:
            errors.append(f"primary video resolution {width}x{height} is below expectation")
    default_subs = [s for s in subtitles if s.get("disposition", {}).get("default") == 1]
    if subtitles and len(default_subs) != 1:
        errors.append(f"expected exactly one default subtitle, found {len(default_subs)}")

    allowed_languages = {item.strip() for item in args.subtitle_language.split(",") if item.strip()}
    for stream in subtitles:
        index = stream.get("index")
        language = stream.get("tags", {}).get("language")
        packets = stream.get("nb_read_packets")
        if allowed_languages and language not in allowed_languages:
            errors.append(f"subtitle stream {index} language is {language!r}, expected one of {sorted(allowed_languages)}")
        if packets in (None, "N/A"):
            warnings.append(f"subtitle stream {index} packet count unavailable")
        elif int(packets) <= 0:
            errors.append(f"subtitle stream {index} has no packets")

    full_read = {"run": False, "ok": None, "stderr": ""}
    if args.full_read and ffmpeg:
        scan = subprocess.run(
            [ffmpeg, "-v", "error", "-i", str(media), "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-f", "null", "-"],
            capture_output=True,
            text=True,
            check=False,
        )
        full_read = {"run": True, "ok": scan.returncode == 0 and not scan.stderr.strip(), "stderr": scan.stderr.strip()[:4000]}
        if not full_read["ok"]:
            errors.append("full-read integrity scan failed")

    fmt = payload.get("format", {})
    report = {
        "path": str(media),
        "size_bytes": int(fmt.get("size", media.stat().st_size)),
        "duration_seconds": float(fmt["duration"]) if fmt.get("duration") else None,
        "video_streams": len(videos),
        "audio_streams": len(audios),
        "subtitle_streams": [
            {
                "index": s.get("index"),
                "codec": s.get("codec_name"),
                "language": s.get("tags", {}).get("language"),
                "title": s.get("tags", {}).get("title"),
                "default": s.get("disposition", {}).get("default", 0),
                "packets": s.get("nb_read_packets"),
            }
            for s in subtitles
        ],
        "full_read": full_read,
        "errors": errors,
        "warnings": warnings,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
