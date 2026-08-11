#!/usr/bin/env python3
"""Create a resumable, non-destructive video localization job layout."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse


PHASES = [
    "acquire",
    "research",
    "source_transcript",
    "translate",
    "resolve_ambiguities",
    "subtitle_qc",
    "mux",
    "final_validation",
]


def source_kind(value: str) -> str:
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()
    if host == "b23.tv" or host.endswith("bilibili.com"):
        return "bilibili"
    if host == "youtu.be" or host.endswith("youtube.com"):
        return "youtube"
    if Path(value).expanduser().is_file():
        return "local"
    return "unknown"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", help="Bilibili/YouTube URL or local media path")
    parser.add_argument("output_dir", help="New or resumable job directory")
    parser.add_argument("--source-language", default="ja")
    parser.add_argument("--target-language", default="zh-Hans")
    args = parser.parse_args()

    kind = source_kind(args.source)
    if kind == "unknown":
        parser.error("source is not a recognized Bilibili/YouTube URL or readable local file")

    job_dir = Path(args.output_dir).expanduser().resolve()
    job_dir.mkdir(parents=True, exist_ok=True)
    for name in ("source", "research", "work", "frames", "subtitles", "deliverables", "logs"):
        (job_dir / name).mkdir(exist_ok=True)

    manifest_path = job_dir / "manifest.json"
    if manifest_path.exists():
        try:
            existing = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            parser.error(f"existing manifest is unreadable: {exc}")
        print(json.dumps({"status": "resumed", "job_dir": str(job_dir), "manifest": existing}, ensure_ascii=False, indent=2))
        return 0

    normalized_source = args.source
    if kind == "local":
        normalized_source = str(Path(args.source).expanduser().resolve())

    manifest = {
        "schema_version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source": {"kind": kind, "value": normalized_source, "acquired_media": None},
        "languages": {"source": args.source_language, "target": args.target_language},
        "phases": {name: {"status": "pending", "evidence": []} for name in PHASES},
        "artifacts": {},
        "limitations": [],
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": "created", "job_dir": str(job_dir), "manifest": str(manifest_path)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
