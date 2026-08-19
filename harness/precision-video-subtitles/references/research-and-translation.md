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
- One linked speaker entity per character–performer pair, with both names retained and the current media identity marked as character, performer, or unresolved. Never count the pair as two subtitle speakers.
- Character colours, group-member colours, or performer support colours for every principal person, with scope and provenance kept distinct.
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
- `"character or member name" メンバーカラー OR イメージカラー OR 応援色 公式`

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

Confidence is `high`, `medium`, or `low`. A low-confidence term needs a resolution entry, but a non-material uncertainty may use neutral wording and `accepted_risk` rather than blocking the full job.

### `research/speakers.tsv`

```text
speaker_entity_id	character_name	performer_name	speaking_as	voice_traits	evidence_url	member_color	color_hex	color_scope	color_source_url	color_confidence
```

`speaking_as` is `character`, `performer`, or `unknown`. Keep the character and performer names on the same row. Use `character` for in-story/animated dialogue and `performer` for interviews, radio, stage talk, live-event MC, or other verified本人 appearances; decide from the current media rather than the surrounding franchise page.

`color_scope` is `character`, `group_member`, `performer_support`, or `fallback`. Only record a hex value when the source states it explicitly; otherwise keep the verified colour name, leave `color_hex` empty, and let subtitle styling record a deterministic fallback. Do not treat costume colour, stage lighting, or an unverified screenshot sample as an official member colour.

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

## 6. Risk-based ambiguity and visual/OCR resolution

First classify candidates from the transcript, nearby cues, glossary, and confidence data. Do not open audio, frames, OCR, and search for every low-confidence cue. Deep timestamp review is most valuable when any of these occurs:

- ASR confidence is low or competing phrases sound plausible.
- A proper noun is absent from the glossary.
- The sentence contradicts canon, scene action, or the next reply.
- A sign, slide, prop, costume, name card, chat overlay, or credit may disambiguate it.
- The apparent speaker does not fit the camera or voice.

Route evidence by question:

1. For an auditory ambiguity, re-listen to a 5–10 second clip or run a batched second ASR pass. Keep absolute timestamps and adjacent dialogue.
2. View nearby frames only when a name card, sign, slide, prop, credit, lip cue, or visible speaker can resolve the issue.
3. OCR only the relevant visible crop; purely auditory ambiguity must not trigger mechanical three-frame OCR.
4. Search official context only for a reusable proper noun or material fact. Reuse confirmed glossary entries across the whole transcript.
5. Compare with grammar, response, canonical terminology, and scene action, then record `resolved`, `accepted_risk`, or `ignored_non_material`.

Image OCR is evidence, not authority. `review` and `minor` items should normally use neutral wording, an explicit disposition, and automatic release. Only an unresolved `critical` item in `strict` mode is a phase blocker.

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
