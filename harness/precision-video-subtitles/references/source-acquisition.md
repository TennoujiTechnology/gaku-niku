# Source acquisition

## Contents

1. Shared safety and storage rules
2. Bilibili
3. YouTube
4. Local media
5. Low-memory audio and frame extraction
6. Network recovery

## 1. Shared safety and storage rules

- Confirm that the user supplied the media or is authorized to access it. Do not bypass DRM, paywalls, geographic controls, or account permissions.
- Estimate free space before download. Reserve at least twice the estimated source size plus 1 GiB for temporary streams, subtitles, and the final mux.
- Write into the job's `source/` directory. Never overwrite a source or user file.
- Prefer a downloader's current official instructions over stale copied commands. Inspect available formats and subtitles first.
- Keep credentials out of command arguments and logs. Use supported QR/login stores. Browser-cookie access requires explicit user approval.
- Download to disk. Do not return media bytes, data URLs, or full binary output through chat.

## 2. Bilibili

If the `bilibili-video-download` skill is available, read and follow it before acting. Its authentication and yutto rules take precedence.

Preferred tool: `yutto`. If `yutto` is absent but `uvx` exists, replace `yutto` below with `uvx --from yutto==2.2.0 yutto` so every machine uses the reviewed version from `runtime/runtime-manifest.json`.

Check login:

```bash
yutto auth status
```

For quality restricted to logged-in users, use the supported QR flow:

```bash
yutto auth login --mode web
yutto auth status
```

Never put Bilibili cookies on the command line and never extract them from a browser automatically. Tell the user where yutto stores persistent authentication and offer `yutto auth logout` after delivery.

For highest available quality, do not pass `-q`; yutto selects the highest authorized stream:

```bash
yutto 'BILIBILI_URL' -d 'JOB_DIR/source'
```

Read the stream list yutto prints and record selected resolution, codec, and nominal audio tier. Verify the merged file with `inspect_media.py`; do not trust the label alone.

For a single video, do not enable batch mode. For collections/playlists, confirm scope before downloading multiple items.

## 3. YouTube

Preferred tool: a current official `yt-dlp` build plus FFmpeg.

List formats and subtitles before download:

```bash
yt-dlp --no-playlist --list-formats --list-subs 'YOUTUBE_URL'
```

Prefer creator-uploaded source-language subtitles. Download human Japanese subtitles and metadata with the highest video/audio:

```bash
yt-dlp --no-playlist -f 'bv*+ba/b' --merge-output-format mkv \
  --write-subs --sub-langs 'ja.*,ja' --sub-format 'vtt/srt/best' \
  --write-info-json \
  -o 'JOB_DIR/source/%(title).180B [%(id)s].%(ext)s' \
  'YOUTUBE_URL'
```

If no human subtitles exist, run a separate fallback with `--write-auto-subs`; label those files as automatic and use them only as an ASR draft. Do not request auto-translated target-language subtitles as the final translation.

The selector `bv*+ba/b` requests the best video-containing stream plus best audio, falling back to the best combined format. Verify the result because extractor availability and account permissions can change.

Do not download an entire playlist unless the user explicitly requested it. If authentication is required for media the user may access, stop and ask before using browser-cookie access. Never print or archive cookies in the job directory.

## 4. Local media

- Resolve the absolute path and verify it is a regular readable file.
- Treat it as read-only. Store derived audio, frames, subtitles, and muxed output in the job directory.
- Probe before work:

```bash
python3 SKILL_DIR/scripts/inspect_media.py '/absolute/path/to/input'
```

- If multiple video/audio tracks exist, inspect titles, languages, dispositions, and durations. Select intentionally; do not assume stream 0 is correct.
- Prefer an accompanying source-language subtitle with matching duration and edition. Validate sync at the beginning, middle, and end.

## 5. Low-memory audio and frame extraction

Never decode the full media into RAM. FFmpeg streams to disk.

Extract a 10-minute mono 16 kHz FLAC chunk with a short overlap:

```bash
ffmpeg -ss 00:20:00 -t 00:10:05 -i 'INPUT' -vn -ac 1 -ar 16000 \
  -c:a flac 'JOB_DIR/work/audio_0020_0030.flac'
```

Use 5–10 minute chunks. Start the next chunk 2–5 seconds before the prior endpoint, then remove duplicate cues by timestamp.

Extract exact nearby frames for visual/OCR review:

```bash
ffmpeg -ss 00:12:34.000 -i 'INPUT' -frames:v 1 'JOB_DIR/frames/001234_before.png'
ffmpeg -ss 00:12:34.500 -i 'INPUT' -frames:v 1 'JOB_DIR/frames/001234_exact.png'
ffmpeg -ss 00:12:35.000 -i 'INPUT' -frames:v 1 'JOB_DIR/frames/001234_after.png'
```

Inspect the local PNG files with the available image-viewing tool. Crop or upscale only when needed for small text; retain the uncropped reference frame.

Extract a short audio dispute clip:

```bash
ffmpeg -ss 00:12:29.500 -t 10 -i 'INPUT' -vn -ac 1 -ar 48000 \
  'JOB_DIR/work/001234_review.wav'
```

## 6. Network recovery

1. Capture the downloader's concise error, not verbose credential-bearing logs.
2. Check whether the tool is using environment/system proxy settings.
3. Retry once using the alternate supported path: configured proxy versus direct.
4. Preserve partial files; use the downloader's resume behavior.
5. If repeated failures are authentication, restriction, or DRM related, stop and report the exact blocker.

For yutto, `--proxy no` disables environment proxy use; default/`--proxy auto` follows the environment. Do not hard-code a user's proxy address into the skill.
