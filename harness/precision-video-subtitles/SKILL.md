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
7. Never fabricate a proper noun or unclear line. Classify its semantic impact first, use only relevant evidence, and prefer a conservative translation plus an explicit review flag over an exhaustive investigation of low-impact uncertainty.
8. Preserve the original media and existing user files. Write into a new job directory and never overwrite without explicit approval.
9. Do not claim completion until subtitle structure, media streams, duration, and a full-read integrity scan pass.
10. Keep large model, search, transcript, and validation payloads on disk. Never print a complete result file back into the Agent transcript; terminal output for one inspection should stay under about 4 KB and contain only the fields or bounded excerpt needed for the next decision.
11. Treat word alignment and speaker diarization as independent capabilities. The default local diarization route is Sherpa-ONNX with verified on-disk models; WhisperX / pyannote is an optional gated route. A successful import, an FFmpeg executable, or a non-empty token is not proof of real-audio readiness.
12. Use the Studio-provided Manifest single-writer helper for every phase/artifact update. Submit a bounded JSON Merge Patch; never overwrite `manifest.json` directly. The helper must serialize writers and atomically replace the file.
13. Send translation/review work as stable-ID item batches through the adaptive batch protocol. Size the first call below the output ceiling; if a child batch still reaches the limit, bisect only that child. Never regenerate an already valid sibling batch or the full transcript.

## Start every job

Collect or infer these inputs: source URL/path, target language, output directory, scope (single video or collection), desired quality, subtitle formats, and whether to mux. Ask only for an input that cannot be safely inferred.

Resolve this skill directory from the loaded `SKILL.md`, then initialize a resumable job:

```bash
python3 {skill_dir}/scripts/init_job.py SOURCE OUTPUT_DIR --source-language ja --target-language zh-Hans
python3 {skill_dir}/scripts/check_environment.py SOURCE --strict
```

Use the generated `manifest.json` as the single progress record. Update each phase from `pending` to `in_progress` to `complete`, recording paths and evidence. A failed phase remains `blocked`; do not skip it silently.

Before launching the long-running Agent, complete the Studio transcription preflight and persist its structured result in `manifest.transcription_preflight`: execute FFmpeg/FFprobe on a bounded audio sample, run the selected Faster-Whisper model from the selected cache, and run the selected diarization engine on 16 kHz mono PCM audio. Prefer the Studio-managed Sherpa-ONNX runtime and verified local segmentation/embedding models; it requires no account. WhisperX / pyannote may be used only when explicitly selected and authorized. If either optional route fails, disable diarization for this task immediately and continue base ASR with `speaker_unknown`; do not enter an Agent retry loop.

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
- `research/speakers.tsv`: `speaker_entity_id`, `character_name`, `performer_name`, `speaking_as`, `voice_traits`, `evidence_url`, `member_color`, `color_hex`, `color_scope`, `color_source_url`, `color_confidence`.

Research gate passes only when the work, episode/event, principal speakers, recurring proper nouns, and the colour-research status for every principal speaker are recorded, and every glossary entry has evidence or is explicitly marked unresolved. Search role/member/support colours as a dedicated research item. Distinguish character colour, group-member colour, and performer support colour; record an explicit value with provenance or mark it unresolved for deterministic fallback. Prefer primary/official sources; use reputable databases or wikis only to fill gaps and cross-check.

Identity rule: a character and the actor/voice actor who performs that character are one linked speaker entity, not two independent people in the subtitle role list. Store both names on the same row and set `speaking_as` to `character`, `performer`, or `unknown` from the current media evidence. Character dialogue normally labels the character; interviews, radio, stage talk, and live-event MC normally label the performer. Never split the pair merely because both names appear in research.

When the job contains a user-approved research preview, treat it as the reusable research baseline instead of repeating the original broad search. Split it into the four required artifacts first, then perform only delta verification for entries explicitly marked uncertain, facts that conflict with the current clip, or new material facts that would change the translation. The default delta budget is at most three targeted queries and four opened source pages; record any remaining uncertainty instead of restarting general research.

### 3. Build the source transcript

Use this priority order:

1. Official human source-language subtitles.
2. Creator/uploaded transcript.
3. High-quality ASR aligned to the media.
4. Manual transcription for gaps and disputed lines.

Honor the job's explicit transcription configuration instead of silently choosing an ASR engine. Supported routes include local Faster-Whisper, local OpenAI Whisper, whisper.cpp, OpenAI-compatible Audio Transcription APIs, and Deepgram. Keep the transcription model/API separate from the translation model/API; never use a chat model to invent unheard source dialogue.

Map the user's quality preset to real behavior:

- `fast`: lightweight model, beam size 1, one pass; suitable only for preview and coarse timing.
- `balanced`: Turbo/current balanced model, beam size around 5, VAD and overlap reconciliation.
- `accurate`: strongest selected ASR model, word timestamps when supported, diarization when enabled, beam size around 8.
- `maximum`: accurate mode plus a second pass over low-confidence spans and disagreements; do not rerun already high-confidence audio unnecessarily.

For online ASR, extract audio and upload only bounded 5–10 minute chunks. Do not upload the video container unless the chosen transcription endpoint explicitly requires it. For local ASR, choose a compute type compatible with the detected hardware and quality request; fail with a clear dependency/model message rather than silently falling back to a lower-quality engine.

#### Local diarization readiness gate

For the default Sherpa-ONNX route, use only the Studio-provided `PSS_TRANSCRIPTION_DIARIZATION_*` runtime, script and model paths. Convert each bounded audio chunk to 16 kHz mono PCM16 WAV, run the script, and preserve its anonymous `speaker_XX` turns in `work/diarization.json`. Do not download packages or models from inside the Agent. The Studio must verify the runtime imports, both on-disk model assets, FFmpeg conversion, and a real-audio inference before launch. A failed smoke test degrades immediately to `speaker_unknown` without invalidating Faster-Whisper output.

Sherpa-ONNX clustering is not identity recognition. Never convert `speaker_00` into a character or performer solely from cluster order, voice embedding similarity, face appearance, subtitle colour, or a chat model guess. Bind a cluster only from a verified self-introduction, name card, stable known sample, or documented audiovisual evidence; otherwise retain `speaker_unknown`.

#### WhisperX and pyannote advanced readiness gate

When WhisperX speaker diarization is enabled, complete this gate before full-media transcription. Use the same Python runtime, model cache, native-library search path, proxy settings, and hardware backend that the real task will use:

1. Validate `alignment` and `diarization` separately. Load the exact alignment model for the selected language and the exact pyannote diarization model revision; do not infer readiness from module imports.
2. Verify required tokenizer/NLTK assets such as `punkt_tab` from the project runtime. Finish model and language-asset downloads before starting long transcription; do not install packages or fetch missing assets in the middle of a full-media pass.
3. Validate authorization against the exact gated model repository without printing or persisting the secret. A non-empty token is not sufficient. An HTTP `401` or `403` is a terminal authorization failure, not a transient download error.
4. Run a bounded 20–30 second real-audio smoke test through the requested alignment and diarization path. Import-only checks do not pass the gate. If the selected route depends on TorchCodec file decoding, verify it against the runtime's actual FFmpeg ABI. If the route intentionally passes a preloaded waveform and bypasses TorchCodec, record `torchcodec: bypassed`, not `ready`.

Record capability results independently in the manifest: `alignment.status`, `alignment.engine`, `alignment.model`, `diarization.status`, `diarization.engine`, `diarization.model`, the smoke-test clip and result, authorization state (`verified`, `missing`, or `denied`) without the token, and any fallback. Do not write a single ambiguous `whisperx_ready=true` flag.

Failure of optional diarization must not invalidate otherwise usable ASR. If the selected review policy permits continuation, keep the transcript, set uncertain and overlapping turns to `speaker_unknown`, record `diarization.status=degraded`, and send the affected cues to refinement. Report “alignment complete; diarization degraded”; never report “WhisperX complete” when pyannote did not run successfully.

MFCC similarity, voice embeddings without a validated clustering/threshold protocol, face appearance, subtitle colour, or a chat model's guess are not equivalent to verified pyannote diarization. A heuristic fallback must be labeled `heuristic`, preserve unknown/overlap states, and must not force every segment onto a known person. Map a cluster to a linked speaker entity only from verified anchors or documented evidence; otherwise retain `speaker_unknown`. Speaker-only style uncertainty may proceed, but identity-sensitive dialogue remains flagged.

Normalize to UTF-8 SRT while preserving the untouched original subtitle file. Split long media into 5–10 minute audio chunks; include overlap and reconcile duplicates by timestamp. Keep source transcription separate from translation.

Request word-level timestamps when the transcriber supports them. For multi-speaker material, label speakers with diarization anchored by known self-introductions or other verified clean clips; visually review low-confidence turns instead of treating an anonymous cluster ID as identity. Resolve each cluster to a single linked speaker entity and choose its current `speaking_as`; do not create separate role-list entries for the character name and the corresponding performer name.

For every uncertain source cue, add a row to `work/uncertainties.tsv` with `timestamp`, `source_guess`, `reason`, `next_check`, and `status`. Use `resolved`, `accepted_risk`, or `ignored_non_material` when a cue can safely proceed; reserve `pending` for an uncertainty that still needs evidence under the selected review policy. Do not present an unsupported guess as verified fact.

### 4. Translate in context-preserving chunks

Translate sequential chunks with the global research brief, glossary, speaker table, and the previous/next 2–5 cues visible. Preserve cue times unless the source timing is demonstrably wrong.

For API-backed translation, submit cue objects with stable IDs through the Studio adaptive batch helper, including an estimated output-token cost per item. Merge returned `parts` by ID. A `length`/output-limit finish reason must shrink only the affected part; a single oversized cue is shortened manually and flagged instead of triggering a whole-batch retry.

For each cue:

- Convey intent, implication, politeness, character voice, and joke setup—not just dictionary meaning.
- Apply canonical names and franchise terminology consistently.
- Use natural concise Chinese that can be read within the cue duration.
- Preserve meaningful hesitations, interruptions, off-screen speech, songs, and sound cues when they affect comprehension.
- Never add information unsupported by audio, image, or researched context.

Record non-obvious choices in `work/translation-decisions.tsv`: `timestamp`, `source`, `translation`, `issue`, `evidence`, `confidence`.

### 5. Triage ambiguities and resolve the ones that matter

Honor the job's ambiguity review mode: `fast`, `pragmatic` (default), or `strict`. First classify every candidate without opening media:

- `critical`: a competing reading may change a name, number/date, negation, speaker/relationship, core action, causal claim, callback, or punchline.
- `review`: wording is uncertain but the main intent can be translated conservatively without adding facts.
- `minor`: filler, repetition, punctuation, irrelevant background chatter, or speaker identity that affects only styling.

Low ASR confidence alone does not make a cue critical. In `fast` and `pragmatic` modes, deep-review only the highest-impact candidates within the job's stated budget. Batch adjacent audio windows and second-pass ASR instead of loading a model per cue. Inspect frames/OCR only when visible text could actually decide the question, and search only reusable proper nouns or material facts.

Translate `review` cues conservatively and mark them `accepted_risk` plus `flagged=true` for the refinement workbench. Mark harmless `minor` cues `ignored_non_material`; omit unintelligible background chatter when it does not affect comprehension. These states do not block the phase. In `fast` and `pragmatic` modes, an unresolved critical cue also proceeds with the most neutral honest wording, `accepted_risk`, a manifest limitation, and a refinement flag; do not claim that semantic precision passed. Only `strict` mode may stop for an unresolved critical cue.

Do not leave `[待核]`, `TODO`, `???`, “听不清”, or equivalent markers in subtitle text. Record policy, counts, dispositions, and evidence in `work/ambiguity-report.json` and the TSV logs.

### 6. Create SRT and ASS

Read [references/subtitle-qc-and-mux.md](references/subtitle-qc-and-mux.md) completely.

- Produce a portable UTF-8 `.srt` and a styled UTF-8 `.ass` from the same approved cue set.
- For conversational Chinese subtitles, omit a terminal full stop `。` at the end of a cue by default. Keep full stops inside a multi-sentence cue and retain meaningful question marks, exclamation marks, ellipses, dashes, and other intentional punctuation.
- Enforce a hard maximum of two visible lines per logical cue. Measure rendered width at the target resolution/font, use the safe horizontal area before wrapping, and prevent orphaned one- or two-character second lines. A small documented horizontal scale (normally no lower than 92%) is preferable to a nearly empty second line.
- Time each logical cue from the first spoken word to the last spoken word. Do not use a fixed display duration. When a long utterance needs multiple panels, switch panels at real word boundaries while keeping the overall first-word/last-word envelope exact.
- Research canonical speaker/member colours. For every role, record the chosen hex value and provenance as `official`, `evidence`, `user`, or `fallback`, including a direct source URL or the named fallback rule. Use a deterministic, recorded fallback palette only when no reliable colour can be established. A successfully applied fallback is informational style provenance, not a delivery limitation. Keep the text fill high-contrast; apply the member colour to a reusable outline plus subtle glow/shadow layer.
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

Report the final media path, external subtitle paths, actual resolution/codecs, duration, size, and validation result. Keep unresolved material risks in `manifest.limitations`; put successful fallbacks and resolved cues retained for optional refinement in `manifest.notices`. Do not present informational provenance as a current limitation. Mention persistent login storage and logout steps if authentication was used.

## Recovery rules

- If a downloader fails, preserve partial files and logs; retry the same phase after checking direct versus configured proxy.
- Classify model and asset failures before retrying. Treat HTTP `401`/`403` as terminal with zero blind retries: ask the user to accept the gated model terms, replace the credential, or disable diarization. For `429`, honor `Retry-After`; for timeouts, incomplete downloads, and transient `5xx` responses, preserve the partial cache and allow at most two bounded automatic retries.
- Retry only the failed asset download, model load, or bounded smoke stage. Never rerun the complete alignment/diarization pipeline in a loop, and never retranscribe already valid chunks merely because diarization failed.
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
