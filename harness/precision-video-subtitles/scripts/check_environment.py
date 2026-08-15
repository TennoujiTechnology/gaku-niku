#!/usr/bin/env python3
"""Check source-specific command dependencies without installing anything."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from pathlib import Path
from urllib.parse import urlparse


def classify(value: str) -> str:
    host = (urlparse(value).hostname or "").lower()
    if host == "b23.tv" or host.endswith("bilibili.com"):
        return "bilibili"
    if host == "youtu.be" or host.endswith("youtube.com"):
        return "youtube"
    if Path(value).expanduser().is_file():
        return "local"
    return "unknown"


def version(binary: str) -> str | None:
    path = shutil.which(binary)
    if not path:
        return None
    for flag in ("--version", "-version"):
        try:
            result = subprocess.run([path, flag], capture_output=True, text=True, timeout=8, check=False)
        except (OSError, subprocess.TimeoutExpired):
            continue
        text = (result.stdout or result.stderr).strip().splitlines()
        if text:
            return text[0][:300]
    return "present"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", help="Bilibili/YouTube URL or local media path")
    parser.add_argument("--strict", action="store_true", help="exit non-zero when required tools are missing")
    args = parser.parse_args()

    kind = classify(args.source)
    tools = {name: {"path": shutil.which(name), "version": version(name)} for name in ("ffmpeg", "ffprobe", "yutto", "uvx", "yt-dlp")}
    missing = [name for name in ("ffmpeg", "ffprobe") if not tools[name]["path"]]
    alternatives: list[str] = []
    if kind == "bilibili" and not (tools["yutto"]["path"] or tools["uvx"]["path"]):
        missing.append("yutto-or-uvx")
        alternatives.append("Install yutto or use uvx --from yutto==2.2.0 yutto after user approval")
    elif kind == "youtube" and not tools["yt-dlp"]["path"]:
        missing.append("yt-dlp")
        alternatives.append("Install the official yt-dlp build after user approval")
    elif kind == "unknown":
        missing.append("recognized-source")

    report = {"source_kind": kind, "tools": tools, "missing": missing, "remediation": alternatives}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if args.strict and missing else 0


if __name__ == "__main__":
    raise SystemExit(main())
