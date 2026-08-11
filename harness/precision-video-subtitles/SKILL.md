---
name: precision-video-subtitles
description: "Research-grounded, end-to-end video subtitle localization for Bilibili, YouTube, or local media: acquire the highest authorized quality, obtain or transcribe source dialogue, research canon/cast/terminology before translating, inspect ambiguous timestamps visually, produce accurate Chinese SRT and ASS closed captions, mux them into MKV, and validate every stream. Use whenever Codex is asked to download, translate, subtitle, create external CC, OCR scene text, or package translated subtitles for an online or local video, especially Japanese anime, games, live events, interviews, or fandom works where proper nouns and context must be precise."
---

# Precision Video Subtitles

Produce a research-backed translation and a verified playable deliverable. Default to Japanese-to-Simplified-Chinese unless the user specifies other languages.

## Non-negotiable rules

1. Use only media the user supplied or is authorized to access. Do not bypass DRM, paywalls, or access controls.
2. Never send media, cookies, tokens, or a full video through chat. Work with local paths. Never print authentication secrets.
3. Never load a full long video/audio into memory. Download and process on disk; transcribe in 5–10 minute chunks with 2–5 seconds of overlap.
4. Research the work before translating. Do not start the target-language draft until the research gate below passes.
5. Translate with the current model. Do not call Google Translate, DeepL, or another machine-translation API unless the user explicitly requests it.
6. Treat official human subtitles as source evidence, not as an unquestionable translation. Treat automatic captions and ASR as drafts.
7. Never guess a proper noun or unclear line. Re-listen, inspect frames near its timestamp, search the term, and record the decision.
8. Preserve the original media and existing user files. Write into a new job directory and never overwrite without explicit approval.
9. Do not claim completion until subtitle structure, media streams, duration, and a full-read integrity scan pass.

## Start every job

Collect or infer these inputs: source URL/path, target language, output directory, scope (single video or collection), desired quality, subtitle formats, and whether to mux. Ask only for an input that cannot be safely inferred.

Resolve this skill directory from the loaded `SKILL.md`, then initialize a resumable job:

```bash
python3 {skill_dir}/scripts/init_job.py SOURCE OUTPUT_DIR --source-language ja --target-language zh-Hans
python3 {skill_dir}/scripts/check_environment.py SOURCE --strict
```

Use the generated `manifest.json` as the single progress record. Update each phase from `pending` to `in_progress` to `complete`, recording paths and evidence. A failed phase remains `blocked`; do not skip it silently.

## Workflow

### 1. Acquire the source safely

Read [references/source-acquisition.md](references/source-acquisition.md) completely. Follow only the section matching Bilibili, YouTube, or local media.

- Verify available formats before choosing when the source exposes multiple streams.
- Interpret “highest quality” as the highest quality available to the user's authorized account, with video and best audio merged. Prefer broadly playable codecs when quality is otherwise equal.
- Obtain official/manual source-language subtitles and metadata when available. Keep auto-captions separate and labeled.
- Probe the acquired media:

```bash
python3 {skill_dir}/scripts/inspect_media.py PATH_TO_MEDIA
```

Record the exact selected resolution, codecs, duration, and size. Do not infer quality from a filename.

### 2. Pass the research gate

Read [references/research-and-translation.md](references/research-and-translation.md) completely.

Browse before translating. Create:

- `research/brief.md`: title, installment/event, premise, timeline, participants/characters, relationships, setting, running jokes, and relevant prior events.
- `research/sources.md`: direct links, access date, and what each source establishes.
- `research/glossary.tsv`: `source_term`, `reading`, `canonical_target`, `category`, `evidence_url`, `confidence`, `notes`.
- `research/speakers.tsv`: `speaker`, `role`, `voice_traits`, `canonical_name`, `evidence_url`.

Research gate passes only when the work, episode/event, principal speakers, and recurring proper nouns are identified, and every glossary entry has evidence or is explicitly marked unresolved. Prefer primary/official sources; use reputable databases or wikis only to fill gaps and cross-check.

### 3. Build the source transcript

Use this priority order:

1. Official human source-language subtitles.
2. Creator/uploaded transcript.
3. High-quality ASR aligned to the media.
4. Manual transcription for gaps and disputed lines.

Normalize to UTF-8 SRT while preserving the untouched original subtitle file. Split long media into 5–10 minute audio chunks; include overlap and reconcile duplicates by timestamp. Keep source transcription separate from translation.

Request word-level timestamps when the transcriber supports them. For multi-speaker material, label speakers with diarization anchored by known self-introductions or other verified clean clips; visually review low-confidence turns instead of treating an anonymous cluster ID as identity.

For every uncertain source cue, add a row to `work/uncertainties.tsv` with `timestamp`, `source_guess`, `reason`, `next_check`, and `status`. Do not translate an unresolved guess as fact.

### 4. Translate in context-preserving chunks

Translate sequential chunks with the global research brief, glossary, speaker table, and the previous/next 2–5 cues visible. Preserve cue times unless the source timing is demonstrably wrong.

For each cue:

- Convey intent, implication, politeness, character voice, and joke setup—not just dictionary meaning.
- Apply canonical names and franchise terminology consistently.
- Use natural concise Chinese that can be read within the cue duration.
- Preserve meaningful hesitations, interruptions, off-screen speech, songs, and sound cues when they affect comprehension.
- Never add information unsupported by audio, image, or researched context.

Record non-obvious choices in `work/translation-decisions.tsv`: `timestamp`, `source`, `translation`, `issue`, `evidence`, `confidence`.

### 5. Resolve every ambiguity at its timestamp

For low-confidence words, names, signs, slides, costumes, lip cues, or speaker identity:

1. Extract audio around the cue and re-listen at normal and reduced speed.
2. Extract frames at the cue and at nearby offsets; inspect them with the available image-viewing/OCR capability.
3. Search the exact visual text, phonetic candidates, official cast/character pages, event pages, credits, or prior episodes.
4. Update the glossary/decision log and retranslate affected cues.

Do not leave `[待核]`, `TODO`, `???`, “听不清”, or equivalent markers in a final subtitle. If evidence cannot resolve a material line, stop and ask the user rather than inventing it.

### 6. Create SRT and ASS

Read [references/subtitle-qc-and-mux.md](references/subtitle-qc-and-mux.md) completely.

- Produce a portable UTF-8 `.srt` and a styled UTF-8 `.ass` from the same approved cue set.
- For conversational Chinese subtitles, omit a terminal full stop `。` at the end of a cue by default. Keep full stops inside a multi-sentence cue and retain meaningful question marks, exclamation marks, ellipses, dashes, and other intentional punctuation.
- Enforce a hard maximum of two visible lines per logical cue. Measure rendered width at the target resolution/font, use the safe horizontal area before wrapping, and prevent orphaned one- or two-character second lines. A small documented horizontal scale (normally no lower than 92%) is preferable to a nearly empty second line.
- Time each logical cue from the first spoken word to the last spoken word. Do not use a fixed display duration. When a long utterance needs multiple panels, switch panels at real word boundaries while keeping the overall first-word/last-word envelope exact.
- Research canonical speaker/member colours. Use a deterministic, recorded fallback palette only when no reliable colour can be established. Keep the text fill high-contrast; apply the member colour to a reusable outline plus subtle glow/shadow layer.
- Use ASS styles for position or speaker differentiation, not hard-coded drawing hacks. Mark duplicate glow/shadow Dialogue rows with an `Effect` beginning `decorative` so validation counts logical cues rather than paint layers.
- Run deterministic checks:

```bash
python3 {skill_dir}/scripts/validate_subtitles.py TARGET.srt TARGET.ass --strict --media-duration SECONDS
```

Review all warnings manually. Structural errors and unresolved markers must be zero.

Render representative frames before muxing: the widest one-line cue, widest two-line cue, every speaker colour, and both bright and dark/graphic-heavy backgrounds. Visually inspect the actual composited frames, then OCR an isolated/binarized copy of the same subtitle layer to catch clipping, missing glyphs, and broken wrapping without confusing programme graphics for subtitle text. Record the OCR text and comparison score.

### 7. Mux without re-encoding

Default to MKV because it reliably carries H.264/AV1 video, AAC/Opus audio, ASS, and SRT. Stream-copy the chosen video/audio, make the precision ASS track default, retain SRT as a fallback, and assign ISO language/title metadata. Keep external subtitle files beside the muxed result.

Do not burn subtitles into the picture unless the user explicitly requests hard subtitles. Do not discard covers, chapters, alternate audio, or attachments without first deciding whether they are meaningful.

### 8. Validate and hand off

Run:

```bash
python3 {skill_dir}/scripts/verify_mux.py FINAL.mkv --expect-subtitles 2 --subtitle-language zho --full-read
```

Then verify:

- Output duration matches the acquired source within 1 second.
- Selected resolution/codecs match the probed source.
- Video and intended audio exist; subtitle packets are non-zero.
- Exactly one translated subtitle track is default.
- SRT and ASS cue counts match unless a documented format-specific reason exists.
- No unresolved markers or untranslated dialogue remain.
- Full-read scan reports no corruption.

Report the final media path, external subtitle paths, actual resolution/codecs, duration, size, validation result, and any honest limitations. Mention persistent login storage and logout steps if authentication was used.

## Recovery rules

- If a downloader fails, preserve partial files and logs; retry the same phase after checking direct versus configured proxy.
- If login is required, use the downloader's supported QR/browser flow and pause for user confirmation. Never paste raw cookies into commands.
- If disk space is insufficient, report the estimated requirement and stop before downloading.
- If the source has no usable audio or is DRM-protected, report the limitation; do not work around protection.
- If the job resumes, read `manifest.json`, validate existing artifacts, and continue from the first incomplete phase instead of restarting.

## Bundled resources

- [references/source-acquisition.md](references/source-acquisition.md): source-specific download, authentication, proxy, and low-memory recipes.
- [references/research-and-translation.md](references/research-and-translation.md): evidence hierarchy, glossary, Japanese translation, ambiguity, OCR, and chunking protocol.
- [references/subtitle-qc-and-mux.md](references/subtitle-qc-and-mux.md): subtitle authoring, mux commands, acceptance tests, and handoff format.
- `scripts/init_job.py`: create a resumable job layout and manifest.
- `scripts/check_environment.py`: check source-specific required tools.
- `scripts/inspect_media.py`: probe real media properties with `ffprobe`.
- `scripts/validate_subtitles.py`: validate SRT/ASS structure, timing, readability, and unresolved markers.
- `scripts/verify_mux.py`: verify streams, language/default metadata, subtitle packets, duration, and optional full-read integrity.
