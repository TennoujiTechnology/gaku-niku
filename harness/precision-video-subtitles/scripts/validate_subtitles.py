#!/usr/bin/env python3
"""Validate UTF-8 SRT/ASS timing, cue counts, readability, and draft markers."""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path


SRT_TIME = re.compile(
    r"^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*"
    r"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})(?:\s+.*)?$"
)
ASS_TIME = re.compile(r"^(\d+):(\d{2}):(\d{2})[.](\d{2})$")
UNRESOLVED = re.compile(r"(?i)(\[待核(?:@|\])|\[不确定|\[听不清|\bTODO\b|\bTBD\b|\?\?\?)")
ASS_TAG = re.compile(r"\{[^}]*\}")


@dataclass
class Cue:
    start: float
    end: float
    text: str
    line: int


def srt_seconds(groups: tuple[str, ...]) -> float:
    h, m, s, ms = map(int, groups)
    return h * 3600 + m * 60 + s + ms / 1000


def ass_seconds(value: str) -> float:
    match = ASS_TIME.match(value.strip())
    if not match:
        raise ValueError(value)
    h, m, s, cs = map(int, match.groups())
    return h * 3600 + m * 60 + s + cs / 100


def parse_srt(text: str) -> tuple[list[Cue], list[str]]:
    cues: list[Cue] = []
    errors: list[str] = []
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    index = 0
    while index < len(lines):
        if not lines[index].strip():
            index += 1
            continue
        block_start = index + 1
        if lines[index].strip().isdigit():
            index += 1
        if index >= len(lines):
            errors.append(f"line {block_start}: incomplete SRT cue")
            break
        match = SRT_TIME.match(lines[index].strip())
        if not match:
            errors.append(f"line {index + 1}: invalid SRT timestamp")
            while index < len(lines) and lines[index].strip():
                index += 1
            continue
        start = srt_seconds(match.groups()[:4])
        end = srt_seconds(match.groups()[4:])
        index += 1
        body: list[str] = []
        while index < len(lines) and lines[index].strip():
            body.append(lines[index].strip())
            index += 1
        cues.append(Cue(start, end, "\n".join(body), block_start))
    return cues, errors


def parse_ass(text: str) -> tuple[list[Cue], list[str]]:
    cues: list[Cue] = []
    errors: list[str] = []
    in_events = False
    fields: list[str] | None = None
    for number, raw in enumerate(text.replace("\r\n", "\n").replace("\r", "\n").split("\n"), 1):
        line = raw.strip()
        if line.startswith("[") and line.endswith("]"):
            in_events = line.lower() == "[events]"
            continue
        if not in_events:
            continue
        if line.lower().startswith("format:"):
            fields = [part.strip().lower() for part in line.split(":", 1)[1].split(",")]
            continue
        if not line.lower().startswith("dialogue:"):
            continue
        if not fields or "start" not in fields or "end" not in fields or "text" not in fields:
            errors.append(f"line {number}: ASS Dialogue appears before a valid Events Format")
            continue
        values = line.split(":", 1)[1].lstrip().split(",", len(fields) - 1)
        if len(values) != len(fields):
            errors.append(f"line {number}: ASS Dialogue field count does not match Format")
            continue
        record = dict(zip(fields, values))
        # A styled ASS may duplicate a logical cue as a glow/shadow layer. Such
        # layers are visual decoration, not additional readable subtitles.
        effect = record.get("effect", "").strip().lower()
        style = record.get("style", "").strip().lower()
        if effect.startswith("decorative") or style.endswith("glow"):
            continue
        try:
            start = ass_seconds(record["start"])
            end = ass_seconds(record["end"])
        except ValueError:
            errors.append(f"line {number}: invalid ASS timestamp")
            continue
        cues.append(Cue(start, end, record["text"].replace("\\N", "\n").strip(), number))
    return cues, errors


def evaluate(
    path: Path,
    cues: list[Cue],
    parser_errors: list[str],
    media_duration: float | None,
    max_lines: int,
) -> dict:
    errors = list(parser_errors)
    warnings: list[str] = []
    if not cues:
        errors.append("no subtitle cues found")
    previous: Cue | None = None
    for position, cue in enumerate(cues, 1):
        label = f"cue {position} (line {cue.line})"
        plain = ASS_TAG.sub("", cue.text).replace("\\h", " ")
        if cue.end <= cue.start:
            errors.append(f"{label}: end must be after start")
        if not plain.strip():
            errors.append(f"{label}: empty text")
        if UNRESOLVED.search(plain):
            errors.append(f"{label}: unresolved draft marker")
        line_count = len(plain.splitlines())
        if line_count > max_lines:
            errors.append(f"{label}: {line_count} lines exceeds maximum {max_lines}")
        duration = max(cue.end - cue.start, 0.001)
        visible_chars = len(re.sub(r"\s+", "", plain))
        if duration > 15:
            warnings.append(f"{label}: long duration {duration:.2f}s")
        if visible_chars / duration > 25:
            warnings.append(f"{label}: high reading speed {visible_chars / duration:.1f} chars/s")
        if previous:
            if cue.start < previous.start:
                errors.append(f"{label}: starts before the previous cue")
            elif cue.start < previous.end - 0.5:
                warnings.append(f"{label}: overlaps previous cue by {previous.end - cue.start:.2f}s")
        previous = cue
    if media_duration is not None and cues and cues[-1].end > media_duration + 2:
        errors.append(f"last cue ends {cues[-1].end - media_duration:.2f}s after media duration")
    return {
        "path": str(path),
        "format": path.suffix.lower().lstrip("."),
        "cue_count": len(cues),
        "first_start": cues[0].start if cues else None,
        "last_end": cues[-1].end if cues else None,
        "errors": errors,
        "warnings": warnings,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("subtitles", nargs="+")
    parser.add_argument("--media-duration", type=float)
    parser.add_argument("--expect-count", type=int)
    parser.add_argument("--max-lines", type=int, default=2)
    parser.add_argument("--strict", action="store_true", help="exit non-zero on errors or mismatched cue counts")
    args = parser.parse_args()

    reports = []
    for value in args.subtitles:
        path = Path(value).expanduser().resolve()
        try:
            text = path.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeDecodeError) as exc:
            reports.append({"path": str(path), "cue_count": 0, "errors": [f"cannot read UTF-8 subtitle: {exc}"], "warnings": []})
            continue
        suffix = path.suffix.lower()
        if suffix == ".srt":
            cues, errors = parse_srt(text)
        elif suffix == ".ass":
            cues, errors = parse_ass(text)
        else:
            cues, errors = [], ["only .srt and .ass are supported"]
        reports.append(evaluate(path, cues, errors, args.media_duration, args.max_lines))

    counts = [report["cue_count"] for report in reports if not report["errors"]]
    global_errors: list[str] = []
    if len(counts) > 1 and len(set(counts)) != 1:
        global_errors.append(f"cue counts differ across subtitle files: {counts}")
    if args.expect_count is not None and any(count != args.expect_count for count in counts):
        global_errors.append(f"cue count does not match expected {args.expect_count}: {counts}")
    result = {"files": reports, "global_errors": global_errors}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    has_errors = bool(global_errors) or any(report["errors"] for report in reports)
    return 1 if args.strict and has_errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
