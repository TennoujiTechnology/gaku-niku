#!/usr/bin/env python3
"""Download one Faster-Whisper model into the Studio-owned cache."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


MODEL_ALIASES = {
    "turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True)
    parser.add_argument("--model-cache", required=True)
    args = parser.parse_args()

    from faster_whisper import WhisperModel

    cache = Path(args.model_cache).expanduser().resolve()
    cache.mkdir(parents=True, exist_ok=True)
    WhisperModel(
        MODEL_ALIASES.get(args.model, args.model),
        device="cpu",
        compute_type="int8",
        download_root=str(cache),
        local_files_only=False,
    )
    print(json.dumps({"ok": True, "model": args.model, "model_cache": str(cache)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
