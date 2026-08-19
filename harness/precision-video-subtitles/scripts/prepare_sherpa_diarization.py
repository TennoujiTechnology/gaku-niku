#!/usr/bin/env python3
"""Download and verify the ungated Sherpa-ONNX diarization assets."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
import urllib.request


SEGMENTATION_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
SEGMENTATION_SHA256 = "24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488"
EMBEDDING_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"
EMBEDDING_SHA256 = "1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_verified(url: str, destination: Path, expected: str) -> None:
    if destination.is_file() and sha256(destination) == expected:
        return
    partial = destination.with_suffix(destination.suffix + ".part")
    partial.unlink(missing_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "GakuNiku/0.2"})
    with urllib.request.urlopen(request, timeout=180) as response, partial.open("wb") as output:
        shutil.copyfileobj(response, output, length=1024 * 1024)
    actual = sha256(partial)
    if actual != expected:
        partial.unlink(missing_ok=True)
        raise RuntimeError(f"model checksum mismatch: expected {expected[:12]}, got {actual[:12]}")
    partial.replace(destination)


def safe_model_member(archive: tarfile.TarFile) -> tarfile.TarInfo:
    matches = [member for member in archive.getmembers() if member.isfile() and member.name.endswith("/model.onnx")]
    if len(matches) != 1:
        raise RuntimeError("segmentation archive does not contain exactly one model.onnx")
    return matches[0]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-cache", required=True)
    args = parser.parse_args()
    root = Path(args.model_cache).expanduser().resolve() / "diarization" / "sherpa-onnx"
    root.mkdir(parents=True, exist_ok=True)
    archive_path = root / "segmentation.tar.bz2"
    segmentation_path = root / "segmentation.onnx"
    embedding_path = root / "embedding.onnx"

    download_verified(SEGMENTATION_URL, archive_path, SEGMENTATION_SHA256)
    download_verified(EMBEDDING_URL, embedding_path, EMBEDDING_SHA256)
    if not segmentation_path.is_file() or segmentation_path.stat().st_size < 1_000_000:
        with tarfile.open(archive_path, "r:bz2") as archive:
            member = safe_model_member(archive)
            with archive.extractfile(member) as source, tempfile.NamedTemporaryFile(dir=root, delete=False) as temporary:
                if source is None:
                    raise RuntimeError("unable to read segmentation model from archive")
                shutil.copyfileobj(source, temporary, length=1024 * 1024)
                temporary_path = Path(temporary.name)
        temporary_path.replace(segmentation_path)

    state = {
        "schema_version": 1,
        "engine": "sherpa-onnx",
        "segmentation": {"path": str(segmentation_path), "sha256": sha256(segmentation_path), "source_archive_sha256": SEGMENTATION_SHA256},
        "embedding": {"path": str(embedding_path), "sha256": EMBEDDING_SHA256},
    }
    state_path = root / "models.json"
    temporary_state = state_path.with_suffix(".json.tmp")
    temporary_state.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary_state.replace(state_path)
    print(json.dumps({"ok": True, "root": str(root)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
