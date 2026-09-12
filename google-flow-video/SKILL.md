---
name: google-flow-video
description: Prepare, run, recover, and quality-check Google Flow video jobs with a local auditable bridge. Use for user-requested Flow generation; requires an existing authenticated Flow tab for live work.
metadata:
  version: 0.4.0
---

# Google Flow Video

Version 0.4.0 adds the immutable production workspace: versioned references, scene dependencies, edit branches, and a local panel/CLI view over the existing job engine.

Use this skill for a Google Flow video request that needs a durable local job record, a whole-run Credit ceiling, and safe recovery. The bundled runtime is a local TypeScript workspace; it does not contain credentials, browser profiles, media, or a connection to the user's browser.

## Start safely

1. Copy `templates/request.background_music_only.json` into the user's chosen project directory. Preserve the original creative master and any user override separately, with hashes.
2. For a new Chinese-localized video, keep Flow in `background_music_only`: picture and background music are allowed; spoken words, narration, lyrics, recognizable vocal sounds, and generated dialogue are prohibited. See [audio policy](references/audio-policy.md).
3. Before a live Flow action, use the user's existing, already authenticated Flow tab only through the supported Codex browser connection. One executor owns the browser work for a run; it claims the matching existing project tab from a fresh inventory and records its observed identity. Browser IDs are executor-local, so an agent handoff must rediscover and match the provider tab identity plus canonical project URL instead of requiring the numeric browser ID to match. It never creates or closes a Flow tab, window, profile, or session. On a stale handle, inventory once and match the existing project tab again; if it is absent, stop with `EXISTING_SESSION_REQUIRED` and preserve the UI. Read [executor session lifecycle](references/executor-session-lifecycle.md) before live browser work.
4. Use the bundled runtime only after a user asks to generate. First copy it to a new user-owned run workspace with `scripts/bootstrap_runtime.sh --workspace <new-directory>`; never run dependency installation, Flow commands, or production commands inside the Skill source or installed Skill directory. Follow [runtime operations](references/runtime-operations.md). New parent ledgers have a fixed 200-Credit cap. Existing 50-Credit ledgers remain immutable recovery records and are not upgraded. Unknown or over-cap cost stops before a provider effect.
5. New jobs request Omni by default; Veo requires explicit user selection. Neither route falls back to another model. A requested model is not proof of the visible Flow UI selection or result readback. A bare Omni label is not proof of Omni Flash 1.1.

## Submission and recovery

Use one immutable `idempotency_key` per job and one `budget_group` ledger for a multi-step job. Persist the source files and hashes before the one permitted Generate click. If a submission intent already exists, do not create a new request or click Generate again: observe, reconcile, resume, or download the original job only. A confirmed provider failure with explicit no-charge evidence, no output, and matching browser/tab/account/project/request lineage can use the guarded retry route; `budget confirm-no-charge` records `NOT_CHARGED` only when its evidence is sufficient.

Timeout, crash, uncertain submission, and ambiguous results are recovery-only by default. `user-resume-prepare` is a narrow exception for an explicit current-user authorization to pay again, accompanied by the required unresolved-job proof and a current authorization record. That record is structured, hash-bound to the immutable job/request, parent budget and controlled second attempt, recorded during the current task, and expires promptly. It also records the current execution context and an authorization-evidence hash; it never relies on a historical conversation, fixed user wording, or an embedded account/session identifier. Authorization records from earlier contract versions are incompatible and cannot be reused. The authorization itself does not replace unresolved/output-free and no-charge proof. Never infer that authorization from a normal “continue”, an attachment, or old task language. On handoff or agent completion, release browser control only; do not close the user's tab or open a replacement. Browser receipts are assertions from the connected trusted Codex executor; they are useful audit evidence, not a security boundary against a malicious executor.

The workspace can version a reference, plan a dependency graph, and derive an edit branch with a frozen `source_video` input. Those are local records and ticket inputs. They do not prove that Flow's Edit video control or upload slot is available. Browser execution requires the same supported existing-tab ticket and fresh visible readback as generation.

## Voice and delivery

Generate picture plus music first. Use the bundled runtime production CLI's `derive`, `tts-prepare`, `tts-submit`, `tts-recover`, `prepare-video`, `voice-place`, `assemble`, and `qc` stages. Produce all Chinese dialogue in one external TTS take, using the same provider, model, voice, and parameter set for the entire script. MMX is the verified external-voice backend in this workflow; its supported command arguments are derived and hash-bound by the CLI, rather than accepted as arbitrary manifest argv. CosyVoice is only an unverified adapter option and must be tested before claiming it works. Do not use Flow's native speech as final Chinese dialogue.

Keep `video_only`, `music_master`, `voice_master`, and `final_redub` separate. Preserve the original timeline/cut manifest and its SHA-256; a retime needs an explicit disclosure and a new timeline hash. Start with [the delivery manifest template](templates/delivery.manifest.template.json). The production CLI locks inputs, records TTS intent/receipt, creates `video-only.mp4`, `background-only.mp4`, and `redub.mp4`, then records `ffprobe`, full `ffmpeg -xerror` decode, and volume readback. Obtain ASR evidence separately and require human listening for Mandarin tones, timbre, residual voice, mix balance, and lip/action alignment. If the user asks for picture plus music only, deliver `background_only`; if they ask for Chinese localization, deliver `redub` after voice review.

## Verification

Run `scripts/quick_validate.py` after copying or editing this skill. It checks the portable package, rejects private paths and artifacts, and requires synthetic Flow fixtures plus fixture-only email addresses. Before a public-history rewrite or publication, run `scripts/release_privacy_check.py --git-worktree <public-repository>` as well; it verifies that every reachable author and committer email is a GitHub noreply address. `scripts/execute_fixture.sh` is the no-cost bootstrap check: it runs `flowctl generate --no-run` on a sanitized fixture and never contacts Flow or uses mock generation. `scripts/package_skill.sh` creates the allowlisted distribution archive. For a live downloaded asset, use the production CLI's `qc` command and inspect representative frames as well as audio.

Do not describe fixture or mock media as live Flow output. Current runtime evidence covers safety controls, mock/synthetic acceptance, and local media verification; a live Flow submission, result reconciliation, and browser download require fresh authorized evidence for the user's own session.
