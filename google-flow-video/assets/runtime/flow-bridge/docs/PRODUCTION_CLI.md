# Production CLI

`scripts/production.py` turns an immutable creative brief and locked media stems into reproducible Flow request templates and local deliverables. It is independent of FlowBridge's browser/credit database: generated request JSON is subsequently submitted through the existing `flowctl` safety path.

The manifest uses `schema_version: 1` and requires:

- `creative.original_prompt` and `creative.audio_override`, each with a path and SHA-256. The original remains verbatim; the override is separately attributable.
- A non-empty `run_id` and contiguous `timeline` with any number of shots. Every shot names its `visual_scope`; a source/delivery duration difference is rejected unless that shot explicitly sets `allow_retime: true`.
- A single TTS provider/model/voice/parameter set and `single_take: true`.
- Hash-locked video, music and voice stems plus explicit non-overlapping line timings.
- Flow delivery fields (`aspect_ratio`, `resolution`) and per-shot model/provider duration.

Validate and derive templates:

```bash
python3 scripts/production.py validate --manifest /absolute/path/production.json
python3 scripts/production.py derive --manifest /absolute/path/production.json --out-dir /absolute/path/derived
```

The derived prompt contains the complete original text and a named `background_music_only` instruction prohibiting speech, narration, lyrics and recognizable voices. Each request adds its own global-time-to-clip-time mapping and visual/action scope. Every request shares `<run_id>-flow-parent` with a unique budget step; `derive` also validates every JSON through real `flowctl generate --no-run` parsing in an isolated temporary database. This is an instruction to Flow, not evidence that its output is clean.

TTS is one take and fail closed. `tts-prepare` freezes the text file and atomically binds an intent to its hash, provider, model, voice, parameters, output path and internally derived MMX argv. Arbitrary production `submit_argv` is not accepted. Real submission is disabled unless the agent creates a matching `current_run_tts_authorization` record from authorization already present in the current user task. Do not ask the user to write that record. It binds the production `run_id` and prepared `request_sha256`, records UTC `recorded_at`, sets `explicitly_authorized: true`, and expires after 24 hours. One authorization covers the planned take; it is separate from Flow Credits. `tts-submit` atomically creates a process claim directory before the provider call; an existing claim, including one left by a crash, is never deleted automatically. A pre-existing output is ambiguous and rejected. Success requires a newly created, probe-valid audio output and a receipt bound to the request, execution and intent. Provider responses without a charge keep `actual_cost: null` and `actual_cost_status: unknown`; this never means zero.

```bash
python3 scripts/production.py tts-prepare --manifest production.json --state-dir state
python3 scripts/production.py tts-submit --manifest production.json --state-dir state --dry-run
python3 scripts/production.py tts-recover --state-dir state
```

`--mock` is accepted only together with `--dry-run` and is labeled `MOCK`. Demucs is an optional external preprocessing step; this CLI neither downloads it nor assumes a machine-specific model path.

`prepare-video` deterministically builds a video master from hash-locked shot sources and their explicit trim ranges. Only shots marked `allow_retime` may change speed. `voice-place` cuts explicit source ranges from one hash-locked full TTS take and places them at target starts with one global gain; it refuses a source phrase longer than its target window and never changes phrase speed.

```bash
python3 scripts/production.py prepare-video --manifest production.json --out video-master.mp4
python3 scripts/production.py voice-place --manifest production.json --source full-take.wav --source-sha256 HASH --out voice-master.wav --gain-db -4
```

Assembly takes already prepared, timeline-length stems. It validates exact duration, target aspect ratio, resolution and frame rate, passes FFmpeg an argv array, stream-copies the locked video into all outputs, and does not alter line speed or invent timing. The outputs are `video-only.mp4`, `background-only.mp4`, and `redub.mp4`.

```bash
python3 scripts/production.py assemble --manifest production.json --out-dir delivery
python3 scripts/production.py qc --assembly delivery/ASSEMBLY.json --out delivery/QC.json
```

QC rejects an empty or partial output set, wrong duration and wrong audio-stream topology. It records probe data, complete `ffmpeg -xerror` decoding and required volume readback. It always leaves `human_audio_status: REQUIRED`: ASR spelling and decode success cannot establish Mandarin tones, consistent timbre, residual voice removal, music balance, or lip/action timing.

Demucs remains optional preprocessing outside this CLI. A generic invocation is `python3 -m demucs --name htdemucs --out /user-owned/stems /absolute/input.mp4`; explicitly select and hash the resulting non-vocal stems before assembly. Model installation/download, path discovery and the judgment that a separated stem is acceptably voice-free are external prerequisites.

Run regression tests without contacting providers:

```bash
python3 -m unittest discover -s tests/production -p 'test_*.py'
pnpm check
```
