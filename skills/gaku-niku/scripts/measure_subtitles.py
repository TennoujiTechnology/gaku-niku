#!/usr/bin/env python3
"""Measure actual libass-rendered subtitle bounds on a black PlayRes canvas."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
from pathlib import Path


def ass_filter_path(path: Path) -> str:
    return str(path).replace("\\", r"\\").replace(":", r"\:").replace("'", r"\'")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("cues_json")
    parser.add_argument("ass_file")
    parser.add_argument("--safe-width-ratio", type=float, default=0.90)
    parser.add_argument("--strict", action="store_true")
    parser.add_argument("--report")
    args = parser.parse_args()

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        parser.error("ffmpeg with libass subtitle support is required")
    cues_path = Path(args.cues_json).expanduser().resolve()
    ass_path = Path(args.ass_file).expanduser().resolve()
    data = json.loads(cues_path.read_text(encoding="utf-8"))
    width = int(data.get("play_res_x", 1920))
    height = int(data.get("play_res_y", 1080))
    safe_width = round(width * args.safe_width_ratio)
    results = []
    errors = []
    warnings = []

    for position, cue in enumerate(data.get("cues", []), 1):
        cue_id = cue.get("id", position)
        start, end = float(cue["start"]), float(cue["end"])
        midpoint = (start + end) / 2
        vf = f"setpts=PTS+{midpoint:.3f}/TB,subtitles='{ass_filter_path(ass_path)}',format=gray"
        run = subprocess.run(
            [ffmpeg, "-v", "error", "-f", "lavfi", "-i", f"color=c=black:s={width}x{height}:r=1:d=1", "-vf", vf, "-frames:v", "1", "-f", "rawvideo", "-"],
            capture_output=True,
            check=False,
        )
        if run.returncode != 0 or len(run.stdout) != width * height:
            errors.append(f"cue {cue_id}: FFmpeg/libass render failed: {run.stderr.decode(errors='replace')[:300]}")
            continue
        baseline = run.stdout[0]
        xs = []
        ys = []
        for index, value in enumerate(run.stdout):
            if abs(value - baseline) > 8:
                xs.append(index % width)
                ys.append(index // width)
        if not xs:
            errors.append(f"cue {cue_id}: rendered no visible pixels")
            continue
        bounds = {"x": min(xs), "y": min(ys), "width": max(xs) - min(xs) + 1, "height": max(ys) - min(ys) + 1}
        lines = str(cue.get("translation", "")).replace("\r", "").split("\n")
        orphan = len(lines) == 2 and len(re.sub(r"\s+", "", lines[1])) <= 2
        result = {"id": cue_id, "bounds": bounds, "safe_width": safe_width, "orphan_second_line": orphan}
        results.append(result)
        if bounds["width"] > safe_width:
            errors.append(f"cue {cue_id}: rendered width {bounds['width']} exceeds safe width {safe_width}")
        if orphan:
            errors.append(f"cue {cue_id}: one/two-character orphaned second line")

    report = {"play_res": [width, height], "safe_width_ratio": args.safe_width_ratio, "results": results, "errors": errors, "warnings": warnings}
    report_path = Path(args.report).expanduser().resolve() if args.report else ass_path.with_name(f"{ass_path.stem}.measure-report.json")
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({**report, "report": str(report_path)}, ensure_ascii=False, indent=2))
    return 1 if args.strict and errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
