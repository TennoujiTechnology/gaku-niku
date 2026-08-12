# Research and translation protocol

## Contents

1. Research gate
2. Evidence hierarchy and search plan
3. Working files
4. Source transcription
5. Japanese-to-Chinese translation rules
6. Ambiguity and visual/OCR resolution
7. Chunking and consistency
8. Final linguistic pass

## 1. Research gate

Do not translate target-language cues until all gate items are present:

- Exact official title, installment/episode/event, release or event date, and media type.
- Principal speakers/characters and their relationships or roles.
- Official spellings for names, units, locations, songs, organizations, attacks/skills, products, and recurring phrases.
- A short timeline or premise sufficient to understand references in the video.
- At least one primary/official source and a cross-check source for disputed proper nouns.

If the uploader title is ambiguous, identify the exact edition from video metadata, title cards, credits, description, and event schedule.

## 2. Evidence hierarchy and search plan

Use sources in this order:

1. Official franchise, publisher, production, event, artist, cast, game, or creator pages.
2. On-screen credits, official video description, official subtitles, booklets, and licensed localized releases.
3. Reputable databases, interviews, press coverage, and established reference wikis.
4. Fan wikis, community glossaries, posts, and comments only as leads or cross-checks.

Browse using Japanese and target-language queries. Useful query patterns:

- `"exact Japanese title" 公式`
- `"event title" 出演者`
- `site:official-domain.jp "suspected term"`
- `"phonetic candidate" character OR cast OR episode`
- `"official Japanese term" 中文 官方`
- `"visible sign text" location OR franchise`

Open the supporting page; do not cite search snippets as evidence. Record the exact page URL and what it proves. For current cast, schedules, product names, or platform behavior, verify at execution time.

## 3. Working files

### `research/brief.md`

Keep it short enough to include with every translation chunk:

- Canon and immediate context
- Episode/event placement
- Speaker relationships
- Tone, running jokes, and callback notes
- Known official Chinese localization style

### `research/glossary.tsv`

Use one row per canonical term:

```text
source_term	reading	canonical_target	category	evidence_url	confidence	notes
```

Confidence is `high`, `medium`, or `low`. No low-confidence term may enter the final subtitle without a resolution entry.

### `research/speakers.tsv`

```text
speaker	role	voice_traits	canonical_name	evidence_url
```

### `work/uncertainties.tsv`

```text
timestamp	source_guess	reason	next_check	status
```

### `work/translation-decisions.tsv`

```text
timestamp	source	translation	issue	evidence	confidence
```

Use the decision log for puns, ellipsis, honorifics, dialect, implied subjects, unusual readings, or terminology choices that future chunks must preserve.

## 4. Source transcription

- Keep the untouched official/creator subtitle.
- Normalize a separate working source SRT to UTF-8.
- Preserve audible wording before improving grammar. Mark non-speech only when meaningful.
- Verify ASR names, numbers, sentence boundaries, and homophones against the glossary and audio.
- Sync-test at the first minute, midpoint, and final five minutes. Correct drift before translation.
- When overlapping speakers matter, use distinct cues or ASS positioning rather than merging their words into one invented sentence.

## 5. Japanese-to-Chinese translation rules

- Translate meaning in scene context, including omitted subjects and pragmatic implication.
- Preserve the speaker's register: formal, blunt, childish, theatrical, awkward, sarcastic, or dialectal.
- Render names and franchise terminology using official Chinese localization when documented. Otherwise choose one evidence-backed form and record it.
- Do not mechanically preserve Japanese word order, filler, sentence-final particles, or honorifics. Recreate their function in natural Chinese.
- Preserve meaningful hesitation, self-correction, interruption, and callback structure.
- Keep jokes understandable without adding an essay. If a pun cannot be reproduced, translate the immediate joke naturally and record the tradeoff.
- Distinguish a title, group, character, performer, voice actor, and in-story speaker. Stage events frequently switch between performer talk and character references.
- Do not infer a speaker solely from ASR text; use voice, camera, lip movement, seating, name cards, and dialogue address.
- Never use an automatic target-language caption as final copy. Translate with the current model from verified source text and context.

## 6. Ambiguity and visual/OCR resolution

Trigger timestamp review when any of these occurs:

- ASR confidence is low or competing phrases sound plausible.
- A proper noun is absent from the glossary.
- The sentence contradicts canon, scene action, or the next reply.
- A sign, slide, prop, costume, name card, chat overlay, or credit may disambiguate it.
- The apparent speaker does not fit the camera or voice.

Resolution loop:

1. Re-listen to a 5–10 second clip at 1.0x and 0.75x.
2. View frames at approximately `t-0.5`, `t`, and `t+0.5` seconds.
3. Read/OCR visible Japanese exactly; distinguish similar kana/kanji and stylized fonts.
4. Search the visible or phonetic candidates with official title/cast context.
5. Compare with grammar, mouth timing, response, and canonical terminology.
6. Record the evidence and confidence; update all affected cues consistently.

Image OCR is evidence, not authority. Verify OCR text visually and by context. If the frame is unclear, inspect nearby frames or a lossless crop rather than hallucinating characters.

## 7. Chunking and consistency

- Translate 5–10 minutes or roughly 80–150 cues at a time.
- Include the research brief, glossary, speaker table, previous 2–5 cues, and next 2–5 source cues.
- Keep a rolling list of unresolved callbacks and update it after each chunk.
- After each chunk, validate terminology against the glossary and search for name variants.
- Do not combine independently translated chunks until overlap and discourse continuity are reconciled.
- Do not place the entire media or a very long full transcript into one prompt; use files and targeted reads.

## 8. Final linguistic pass

Run three separate reviews:

1. **Accuracy pass:** source meaning, negation, numbers, speaker, names, references, joke logic.
2. **Consistency pass:** glossary, names, pronouns, register, repeated phrases, punctuation.
3. **Readability pass:** natural Chinese, line length, reading speed, segmentation, screen obstruction.

Search the final files for unresolved markers and untranslated Japanese dialogue. Japanese proper nouns intentionally retained must appear in the glossary or decision log.
