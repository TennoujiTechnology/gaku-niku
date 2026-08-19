# Subtitle QC and muxing

## Contents

1. Cue and styling rules
2. Deterministic subtitle validation
3. MKV mux recipe
4. Mux validation
5. Acceptance checklist
6. Handoff

## 1. Cue and styling rules

- Encode SRT and ASS as UTF-8.
- Keep cues chronological. Start must be earlier than end. Avoid accidental overlaps; intentional simultaneous speakers must be styled or positioned deliberately.
- Enforce at most two visible lines. Measure line width using the actual target font and PlayRes. Use most of the safe horizontal width before wrapping, but avoid orphaned fragments on line two. If a cue exceeds the safe width by only a few percent, a documented `\fscx` reduction no lower than about 92% is preferable to a two-character second line.
- Cue start is the first spoken token and cue end is the final spoken token. Prefer word-level ASR timestamps or manual waveform alignment; never substitute a fixed display duration. For a long utterance split into successive panels, choose real word boundaries and keep the full envelope exact.
- Avoid very short flashes and excessive reading speed. Do not extend a cue past the speaker's real stop merely to improve reading speed; shorten the wording or split at a verified speech boundary.
- Use Chinese punctuation consistently. For conversational Chinese captions, omit the terminal full stop `。` at the end of each cue by default; keep internal full stops in multi-sentence cues and preserve meaningful question marks, exclamation marks, ellipses, dashes, and other intentional punctuation. Do not put speaker labels on every cue unless speaker identity is essential or the user requested SDH-style captions.
- Preserve useful sound cues such as `（掌声）`, `（门铃）`, or song markers; omit decorative noise that adds no comprehension.
- In ASS, define reusable styles in the header. Keep a safe lower margin and use top positioning for on-screen text conflicts or simultaneous speakers.
- When speaker colours are requested, research official character/member branding first. Use white or another high-contrast fill, canonical colour outline, dark shadow, and a subtle same-colour blurred outer layer. If the work has no established colours, generate a deterministic palette, record it, and keep it stable across reruns.
- A glow/shadow duplicate is a decorative paint layer, not another logical cue. Put `decorative-glow` (or another `decorative...` value) in the ASS Effect field so the bundled validator excludes it from cue-count and reading-speed checks.
- Keep SRT plain and portable; do not depend on ASS override tags in SRT.

## 2. Deterministic subtitle validation

Run both files against the media duration:

```bash
python3 SKILL_DIR/scripts/validate_subtitles.py \
  'translated.zh-Hans.srt' 'translated.zh-Hans.ass' \
  --strict --media-duration 5548.933
```

The validator checks UTF-8 decoding, cue presence, time syntax, positive duration, chronological order, overlaps, very long cues, reading speed, cue counts, media overrun, and unresolved markers.

Manually review warnings. Intentional overlaps must be documented. SRT and ASS generated from the same cue set should have identical cue counts.

Then render and inspect a targeted QA set:

- Widest one-line cue and widest two-line cue
- At least one cue for each speaker style/colour
- A bright frame, a dark frame, and a frame containing programme graphics or lower-thirds
- Any cue using horizontal scaling or unusual placement

Run OCR on an isolated or binarized render of the same subtitle layer, not blindly on the full programme frame. Keep the actual composited frame for visual QA. Compare normalized OCR output with the expected cue, investigate low scores, and record the samples and scores in the job report.

## 3. MKV mux recipe

Probe the media first and map streams intentionally. This baseline keeps the primary video/audio and adds precision ASS plus fallback SRT without re-encoding:

```bash
ffmpeg -i 'SOURCE_MEDIA' -i 'translated.zh-Hans.ass' -i 'translated.zh-Hans.srt' \
  -map 0:v:0 -map 0:a:0 -map 1:0 -map 2:0 -c copy \
  -metadata:s:a:0 language=jpn -metadata:s:a:0 title='日语原声' \
  -metadata:s:s:0 language=zho -metadata:s:s:0 title='简体中文（精校 ASS）' \
  -disposition:s:0 default \
  -metadata:s:s:1 language=zho -metadata:s:s:1 title='简体中文（纯文本 SRT）' \
  -disposition:s:1 0 \
  'deliverables/title.zh-Hans.quality.mkv'
```

Adapt audio language and titles to the actual source. If the source has meaningful chapters, attachments, cover art, or alternate audio, preserve them with explicit `-map` choices. Do not use `-map 0` blindly when it would duplicate thumbnail video or unwanted data streams.

MKV is the default. MP4 does not natively preserve ASS styling; use it only if the user prioritizes MP4 compatibility and accepts a compatible subtitle codec or hard subtitles.

Do not use `-y` unless the user explicitly authorized overwriting the exact target. If the target exists, choose a new filename or ask.

## 4. Mux validation

Run:

```bash
python3 SKILL_DIR/scripts/verify_mux.py 'FINAL.mkv' \
  --expect-subtitles 2 --subtitle-language zho --full-read
```

The full read uses stream copy to the null muxer; it detects truncated or corrupt packets without re-encoding.

For independent inspection:

```bash
ffprobe -v error -count_packets -show_streams -show_format -of json 'FINAL.mkv'
```

Confirm the translated ASS is the sole default subtitle. Confirm both subtitle streams contain packets and have correct language/title metadata.

## 5. Acceptance checklist

- [ ] Highest authorized source quality was selected and verified by `ffprobe`.
- [ ] Research gate passed before target translation began.
- [ ] Source transcript is preserved separately from target subtitles.
- [ ] Every dialogue cue is translated or intentionally marked non-dialogue.
- [ ] No unresolved marker or accidental untranslated line remains.
- [ ] Names and terminology match the evidence-backed glossary.
- [ ] Ambiguous material lines have timestamped audio/visual evidence.
- [ ] SRT and ASS pass deterministic validation.
- [ ] Every logical cue has no more than two lines and fits the measured safe width.
- [ ] Conversational Chinese cues have no redundant terminal full stop `。`; meaningful and internal punctuation is preserved.
- [ ] First/last subtitle times follow the speaker's actual first/last spoken tokens.
- [ ] Speaker colours, outline, shadow, and glow were checked on representative actual frames.
- [ ] OCR QA covers the widest cues, every colour, and bright/graphic-heavy backgrounds.
- [ ] Final duration differs from source by no more than 1 second.
- [ ] Video/audio/subtitle stream counts, codecs, language, and dispositions are correct.
- [ ] Full-read integrity scan passes with no error output.
- [ ] Original media and external subtitles remain available.

## 6. Handoff

Lead with the final result, using clickable absolute local paths. Report:

- Final muxed media
- External ASS and SRT
- Actual resolution, video/audio codecs, frame rate, duration, and size
- Subtitle cue count and default track
- Validation outcome
- Honest unresolved material limitations, separated from informational fallback provenance and optional refinement notes
- Authentication storage/logout note if a downloader login was used

Do not make the user read downloader logs to understand whether the task succeeded.
