# Single-model execution contract

Use this protocol when the host model needs concrete defaults for ASR, OCR, cue data, styling, and acceptance thresholds.

## 1. Tool routing

The current model remains the only reasoning and translation authority. ASR, diarization, OCR, search, FFmpeg, and the bundled scripts are tools, not additional translators.

For source transcription:

1. Prefer official or uploader-provided source-language subtitles.
2. Otherwise use one already-available Japanese ASR that can emit segment or word timestamps, such as Whisper-compatible local tooling or a user-approved speech API.
3. Record the engine, model, language, timestamp mode, and command/API mode in `work/asr-provenance.json`.
4. Do not install an ASR runtime, upload audio, or download a large model without user approval.
5. If no transcription path is available, stop and ask the user to select local installation or an approved API. Do not invent a transcript.

For diarization, anonymous clusters remain `speaker_01`, `speaker_02`, and so on until camera, self-introduction, name card, address, or verified voice evidence establishes identity. Record the identity evidence in `research/speakers.tsv`.

### Ambiguity budget

The default policy is `pragmatic`: classify every candidate, but deeply investigate no more than 24 highest-impact timestamps. `fast` limits deep review to 8; `strict` has no automatic cap. A low ASR score alone is not material risk. Batch adjacent audio checks, use OCR only when visible text can decide the issue, and search only reusable terms or facts. Non-material items use `accepted_risk` or `ignored_non_material`, remain visible in review metadata when useful, and do not block delivery.

## 2. Canonical cue data

Keep one canonical UTF-8 JSON file at `work/cues.json`. SRT and ASS must be generated from it rather than edited independently:

```json
{
  "play_res_x": 1920,
  "play_res_y": 1080,
  "font": "Heiti SC",
  "font_size": 58,
  "strip_terminal_full_stop": true,
  "roles": [
    {"id": "anon", "name": "千早爱音", "color": "#FF8899", "evidence": "https://official.example/character"}
  ],
  "cues": [
    {
      "id": 1,
      "start": 204.72,
      "end": 208.06,
      "speaker_id": "anon",
      "source": "昼の部で…",
      "translation": "感觉日场时，我们把‘迷子’的心意好好传达出去了",
      "confidence": 0.97,
      "flagged": false,
      "type": "dialogue",
      "alignment": 2,
      "position": null,
      "scale_x": 100,
      "overlap_reason": ""
    }
  ]
}
```

Use seconds as numbers. Use a literal newline inside `translation` only for an intentional line break. Each cue must have a stable unique `id`, `start < end`, no more than two lines, and a `speaker_id`. `type` is `dialogue`, `song`, or `sign`; songs receive `♪` and italic styling. `alignment` uses ASS values 1–9, optional `position` is `{"x": ..., "y": ...}`, and `scale_x` is 92–100. Every intentional overlap requires `overlap_reason` plus a distinct alignment or position. Keep uncertainty and evidence in the TSV logs; do not put TODO text in `translation`.

Generate both formats deterministically:

```bash
python3 SKILL_DIR/scripts/render_subtitles.py \
  JOB_DIR/work/cues.json JOB_DIR/subtitles/title.zh-Hans
```

The script writes `.srt`, `.ass`, and `.render-report.json`, removes only a terminal Chinese full stop when enabled, creates stable fallback colours for missing roles, and marks ASS glow layers as `decorative-glow`. The report lists fallback colours, roles without evidence, flagged cues, and confidence below 0.85. Replace fallback colours whenever official evidence exists.

## 3. Timing and readability defaults

- Align start/end to the first and final spoken token. Correct ASR word boundaries manually when waveform/audio evidence disagrees.
- Flag cues shorter than 0.50 s for manual review. Do not lengthen beyond real speech merely to hide the warning.
- Warn above 25 visible Chinese characters per second. Prefer concise translation or a split at a verified speech boundary.
- Warn above 15 s duration; long continuous speech should normally be split at true word boundaries.
- Treat overlaps as errors unless simultaneous speakers or deliberate carry-over are documented.
- Use at most two lines. Target about 80–90% of PlayRes width as the safe text area and keep normal margins at least 4% of width.
- Do not leave a one- or two-character orphaned second line. A documented horizontal scale down to 92% is preferable when the cue only slightly exceeds the safe width.

Measure actual FFmpeg/libass output after generation:

```bash
python3 SKILL_DIR/scripts/measure_subtitles.py \
  JOB_DIR/work/cues.json JOB_DIR/subtitles/title.zh-Hans.ass --strict
```

The measurement report uses actual rendered pixels at each cue midpoint, rejects width above 90% of PlayRes, and rejects one/two-character orphaned second lines. Adjust wording, natural line breaks, placement, or `scale_x` and repeat until it passes. This script requires an FFmpeg build with the `subtitles`/libass filter.

## 4. OCR protocol

Use OCR only when visible text can resolve the question; purely auditory ambiguity still requires listening and linguistic evidence.

1. Preserve the full exact frame.
2. Make a separate lossless crop around the relevant sign/card/subtitle.
3. Upscale the crop 2×–4× with a non-destructive filter; try grayscale/contrast or threshold only on a derived copy.
4. Use the host model's image vision first. If an installed OCR engine has Japanese language data, use it as a second reading.
5. Compare normalized OCR with the visually expected text. Require exact agreement for names and numbers. For ordinary text, investigate similarity below 0.85 rather than accepting it automatically.
6. Record timestamp, frame/crop path, OCR output, visual reading, chosen reading, and evidence in `work/translation-decisions.tsv`.

OCR never overrides a clearly contradictory frame, audio, grammar, or official spelling.

## 5. Difficult content

- **Songs:** translate lyrics only when requested or necessary for comprehension. Prefer lyrics audible in the user-authorized media or an official supplied lyric source; do not copy full lyrics from unrelated web pages. Use `♪` markers or a dedicated ASS style consistently.
- **Crowd/overlap:** retain meaningful overlapping speech as separately positioned ASS cues; do not invent a combined sentence. Omit unintelligible background chatter unless it affects the scene.
- **Off-screen speech:** keep it as dialogue; identify the speaker only with evidence.
- **On-screen text:** translate material signs/cards separately from spoken dialogue and position them away from the source graphic.
- **Many roles:** render at least one QA frame for every colour actually used; group identical styles only when the canonical colour is truly shared.

## 6. Quantified gate

The research gate passes only when:

- exact title/event/edition/date is identified;
- every principal speaker visible or audible in the requested scope has a row in `speakers.tsv` or is explicitly unresolved;
- every repeated proper noun and every proper noun in a flagged cue has a glossary row;
- at least one official/primary source supports the identity/context, and disputed terms have a second source;
- all low-confidence glossary rows have a recorded disposition; `accepted_risk` must use neutral wording and remain visible to the refinement workbench rather than being reported as verified.

Final acceptance requires zero structural errors, zero unresolved markers, equal logical SRT/ASS cue counts, zero undocumented overlaps, duration within one second, successful stream/full-read validation, and visual QA of widest one-line/two-line cues, all used colours, bright/dark backgrounds, and special placements.
