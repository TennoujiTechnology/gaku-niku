#!/usr/bin/env python3
"""Render canonical Gaku-Niku cue JSON to portable SRT and styled ASS."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path


FALLBACK_PALETTE = (
    "#FF7F9F", "#70B7FF", "#6DD6A8", "#C39BFF",
    "#FFD166", "#FF9F68", "#62D5E8", "#E88BCB",
)


def srt_time(seconds: float) -> str:
    milliseconds = round(seconds * 1000)
    hours, milliseconds = divmod(milliseconds, 3_600_000)
    minutes, milliseconds = divmod(milliseconds, 60_000)
    secs, milliseconds = divmod(milliseconds, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{milliseconds:03d}"


def ass_time(seconds: float) -> str:
    centiseconds = round(seconds * 100)
    hours, centiseconds = divmod(centiseconds, 360_000)
    minutes, centiseconds = divmod(centiseconds, 6_000)
    secs, centiseconds = divmod(centiseconds, 100)
    return f"{hours}:{minutes:02d}:{secs:02d}.{centiseconds:02d}"


def normalize_color(value: str) -> str:
    color = str(value or "").strip().upper()
    if not re.fullmatch(r"#[0-9A-F]{6}", color):
        raise ValueError(f"invalid role color: {value!r}")
    return color


def ass_color(rgb: str, alpha: str = "00") -> str:
    rgb = normalize_color(rgb)[1:]
    return f"&H{alpha}{rgb[4:6]}{rgb[2:4]}{rgb[0:2]}"


def style_token(role_id: str) -> str:
    digest = hashlib.sha256(role_id.encode("utf-8")).hexdigest()[:10]
    return f"Role_{digest}"


def fallback_color(role_id: str) -> str:
    index = int(hashlib.sha256(role_id.encode("utf-8")).hexdigest()[:8], 16)
    return FALLBACK_PALETTE[index % len(FALLBACK_PALETTE)]


def clean_translation(text: str, strip_full_stop: bool) -> str:
    value = str(text).replace("\r\n", "\n").replace("\r", "\n").strip()
    if strip_full_stop and value.endswith("。"):
        value = value[:-1].rstrip()
    return value


def ass_escape(text: str) -> str:
    return text.replace("\\", r"\\").replace("{", r"\{").replace("}", r"\}").replace("\n", r"\N")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_json", help="canonical work/cues.json")
    parser.add_argument("output_base", help="output path without .srt/.ass suffix")
    args = parser.parse_args()

    source = Path(args.input_json).expanduser().resolve()
    output = Path(args.output_base).expanduser().resolve()
    data = json.loads(source.read_text(encoding="utf-8"))

    play_x = int(data.get("play_res_x", 1920))
    play_y = int(data.get("play_res_y", 1080))
    font = str(data.get("font", "Heiti SC")).replace(",", " ")
    font_size = int(data.get("font_size", 58))
    strip_full_stop = bool(data.get("strip_terminal_full_stop", True))
    margin_lr = max(20, round(play_x * 0.04))
    margin_v = max(24, round(play_y * 0.055))
    srt_path = Path(f"{output}.srt")
    ass_path = Path(f"{output}.ass")
    report_path = Path(f"{output}.render-report.json")

    roles: dict[str, dict[str, str]] = {}
    fallback_report: dict[str, str] = {}
    for raw in data.get("roles", []):
        role_id = str(raw.get("id", "")).strip()
        if not role_id:
            raise ValueError("every role requires a non-empty id")
        color = raw.get("color")
        if color:
            color = normalize_color(color)
        else:
            color = fallback_color(role_id)
            fallback_report[role_id] = color
        roles[role_id] = {
            "name": str(raw.get("name", role_id)),
            "color": color,
            "evidence": str(raw.get("evidence", "")).strip(),
        }

    cues = []
    seen_ids = set()
    for position, raw in enumerate(data.get("cues", []), 1):
        cue_id = raw.get("id", position)
        if cue_id in seen_ids:
            raise ValueError(f"duplicate cue id: {cue_id!r}")
        seen_ids.add(cue_id)
        start, end = float(raw["start"]), float(raw["end"])
        if start < 0 or end <= start:
            raise ValueError(f"cue {cue_id}: invalid time envelope {start}–{end}")
        text = clean_translation(raw.get("translation", ""), strip_full_stop)
        if not text:
            raise ValueError(f"cue {cue_id}: empty translation")
        if len(text.splitlines()) > 2:
            raise ValueError(f"cue {cue_id}: more than two visible lines")
        kind = str(raw.get("type", "dialogue")).strip().lower()
        if kind not in {"dialogue", "song", "sign"}:
            raise ValueError(f"cue {cue_id}: type must be dialogue, song, or sign")
        alignment = int(raw.get("alignment", 8 if kind in {"song", "sign"} else 2))
        if alignment < 1 or alignment > 9:
            raise ValueError(f"cue {cue_id}: ASS alignment must be 1–9")
        scale_x = float(raw.get("scale_x", 100))
        if scale_x < 92 or scale_x > 100:
            raise ValueError(f"cue {cue_id}: scale_x must be between 92 and 100")
        position = raw.get("position")
        if position is not None:
            if not isinstance(position, dict) or "x" not in position or "y" not in position:
                raise ValueError(f"cue {cue_id}: position requires x and y")
            position = {"x": int(position["x"]), "y": int(position["y"])}
            if not 0 <= position["x"] <= play_x or not 0 <= position["y"] <= play_y:
                raise ValueError(f"cue {cue_id}: position is outside PlayRes")
        role_id = str(raw.get("speaker_id", "unknown")).strip() or "unknown"
        if role_id not in roles:
            color = fallback_color(role_id)
            roles[role_id] = {"name": role_id, "color": color, "evidence": ""}
            fallback_report[role_id] = color
        cues.append({
            "id": cue_id,
            "start": start,
            "end": end,
            "text": text,
            "role_id": role_id,
            "type": kind,
            "alignment": alignment,
            "position": position,
            "scale_x": scale_x,
            "overlap_reason": str(raw.get("overlap_reason", "")).strip(),
            "confidence": raw.get("confidence"),
            "flagged": bool(raw.get("flagged", False)),
        })

    if not cues:
        raise ValueError("cues.json contains no cues")
    cues.sort(key=lambda item: (item["start"], item["end"]))
    active = []
    for cue in cues:
        active = [other for other in active if other["end"] > cue["start"]]
        if active and not cue["overlap_reason"]:
            raise ValueError(f"cue {cue['id']}: overlap requires overlap_reason")
        if active and cue["position"] is None and all(other["alignment"] == cue["alignment"] and other["position"] is None for other in active):
            raise ValueError(f"cue {cue['id']}: overlapping cue requires distinct alignment or position")
        active.append(cue)
    output.parent.mkdir(parents=True, exist_ok=True)

    srt_blocks = []
    for index, cue in enumerate(cues, 1):
        srt_text = cue["text"]
        if cue["type"] == "song" and not srt_text.startswith("♪"):
            srt_text = f"♪ {srt_text} ♪"
        srt_blocks.append(
            f"{index}\n{srt_time(cue['start'])} --> {srt_time(cue['end'])}\n{srt_text}"
        )
    srt_path.write_text("\n\n".join(srt_blocks) + "\n", encoding="utf-8")

    ass_lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {play_x}",
        f"PlayResY: {play_y}",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "YCbCr Matrix: TV.709",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, "
        "Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ]
    for role_id, role in sorted(roles.items()):
        token = style_token(role_id)
        outline = ass_color(role["color"])
        glow = ass_color(role["color"], "28")
        ass_lines.append(
            f"Style: {token},{font},{font_size},&H00FFFFFF,&H00FFFFFF,{outline},&H90000000,-1,0,0,0,"
            f"100,100,0,0,1,3.2,1.8,2,{margin_lr},{margin_lr},{margin_v},1"
        )
        ass_lines.append(
            f"Style: {token}_Glow,{font},{font_size},&HFFFFFFFF,&HFFFFFFFF,{glow},&HFF000000,-1,0,0,0,"
            f"100,100,0,0,1,8.5,0,2,{margin_lr},{margin_lr},{margin_v},1"
        )
    ass_lines.extend([
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ])
    for cue in cues:
        token = style_token(cue["role_id"])
        role_name = roles[cue["role_id"]]["name"].replace(",", " ")
        display_text = cue["text"]
        if cue["type"] == "song" and not display_text.startswith("♪"):
            display_text = f"♪ {display_text} ♪"
        text = ass_escape(display_text)
        start, end = ass_time(cue["start"]), ass_time(cue["end"])
        overrides = [rf"\an{cue['alignment']}", rf"\fscx{cue['scale_x']:g}"]
        if cue["position"]:
            overrides.append(rf"\pos({cue['position']['x']},{cue['position']['y']})")
        if cue["type"] == "song":
            overrides.append(r"\i1")
        override_text = "".join(overrides)
        ass_lines.append(
            f"Dialogue: 0,{start},{end},{token}_Glow,{role_name},0,0,0,decorative-glow,"
            rf"{{{override_text}\blur7\bord8.5\1a&HFF&}}{text}"
        )
        ass_lines.append(
            f"Dialogue: {2 if cue['type'] == 'sign' else 1},{start},{end},{token},{role_name},0,0,0,,"
            rf"{{{override_text}\blur0.5}}{text}"
        )
    ass_path.write_text("\n".join(ass_lines) + "\n", encoding="utf-8")

    report = {
        "srt": str(srt_path),
        "ass": str(ass_path),
        "logical_cues": len(cues),
        "fallback_colors": fallback_report,
        "roles_missing_evidence": [role_id for role_id, role in roles.items() if not role["evidence"]],
        "flagged_cues": [cue["id"] for cue in cues if cue["flagged"]],
        "low_confidence_cues": [cue["id"] for cue in cues if isinstance(cue["confidence"], (int, float)) and cue["confidence"] < 0.85],
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    report["report"] = str(report_path)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
