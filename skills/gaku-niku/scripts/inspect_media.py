#!/usr/bin/env python3
"""Return normalized media properties from ffprobe."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("media")
    args = parser.parse_args()

    media = Path(args.media).expanduser().resolve()
    if not media.is_file():
        parser.error(f"not a readable media file: {media}")
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        parser.error("ffprobe is required")

    command = [
        ffprobe,
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        str(media),
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode:
        raise SystemExit(result.stderr.strip() or f"ffprobe failed with code {result.returncode}")
    raw = json.loads(result.stdout)
    streams = []
    for stream in raw.get("streams", []):
        streams.append(
            {
                "index": stream.get("index"),
                "type": stream.get("codec_type"),
                "codec": stream.get("codec_name"),
                "profile": stream.get("profile"),
                "width": stream.get("width"),
                "height": stream.get("height"),
                "fps": stream.get("avg_frame_rate"),
                "sample_rate": stream.get("sample_rate"),
                "channels": stream.get("channels"),
                "bit_rate": stream.get("bit_rate"),
                "duration": stream.get("duration"),
                "language": stream.get("tags", {}).get("language"),
                "title": stream.get("tags", {}).get("title"),
                "default": stream.get("disposition", {}).get("default", 0),
                "attached_pic": stream.get("disposition", {}).get("attached_pic", 0),
            }
        )
    fmt = raw.get("format", {})
    report = {
        "path": str(media),
        "size_bytes": int(fmt.get("size", media.stat().st_size)),
        "duration_seconds": float(fmt["duration"]) if fmt.get("duration") else None,
        "bit_rate": int(fmt["bit_rate"]) if fmt.get("bit_rate") else None,
        "format": fmt.get("format_name"),
        "streams": streams,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
