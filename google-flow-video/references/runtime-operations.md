# Bundled runtime operations

The runtime source is at `assets/runtime/flow-bridge`. It has no dependencies installed in the archive. Never execute it in place: doing so would put dependency caches and state beside a distributable Skill.

Requirements: Node.js 22, pnpm 11, `ffprobe`, and `ffmpeg`. Create a new user-owned run workspace, then run all commands from its copied runtime. The bootstrap restores the packaged test resources as runnable tests inside that workspace:

```bash
<skill>/scripts/bootstrap_runtime.sh --workspace /user-owned/flowbridge-run
cd /user-owned/flowbridge-run
pnpm check
```

For the independent picture/music/voice delivery chain, read the copied runtime's `docs/PRODUCTION_CLI.md` and run it from the copied runtime directory:

```bash
python3 scripts/production.py validate --manifest /user-owned/production.json
python3 scripts/production.py derive --manifest /user-owned/production.json --out-dir /user-owned/derived
python3 scripts/production.py tts-prepare --manifest /user-owned/production.json --state-dir /user-owned/tts-state
python3 scripts/production.py tts-submit --manifest /user-owned/production.json --state-dir /user-owned/tts-state --dry-run
python3 scripts/production.py prepare-video --manifest /user-owned/production.json --out /user-owned/video-master.mp4
SOURCE_SHA256="replace-with-source-sha256"
python3 scripts/production.py voice-place --manifest /user-owned/production.json --source /user-owned/full-take.wav --source-sha256 "$SOURCE_SHA256" --out /user-owned/voice-master.wav --gain-db -4
python3 scripts/production.py assemble --manifest /user-owned/production.json --out-dir /user-owned/delivery
python3 scripts/production.py qc --assembly /user-owned/delivery/ASSEMBLY.json --out /user-owned/delivery/QC.json
```

`tts-submit` without `--dry-run` needs a matching current-run authorization record created from authorization already present in the user task. It creates an atomic process claim before calling the hash-bound MMX command; a crash, nonzero exit, or missing/probe-invalid output becomes unknown and can only be recovered from a completed receipt and hash-locked output. A provider response without charge data remains `actual_cost: null` and `unknown`, never zero. A pre-existing output and arbitrary provider argv are refused.

For a new live request, choose a user-owned writable directory outside this skill and set `FLOWBRIDGE_DB_PATH` there. Create the job with `generate --no-run`; this is local persistence only. A live click requires a fresh sanitized observation from the current connected Flow tab, then `browser prepare`, `browser claim`, an executor final readback and the single authorized click, followed by a receipt. The CLI cannot attach to a browser by itself. Read [executor session lifecycle](executor-session-lifecycle.md) before attaching: the executor must claim an existing user Flow tab from fresh inventory, record its observed identity, and release control without closing it at handoff or completion.

The observation must have only browser/tab IDs, the canonical Flow project URL, timestamp, visible selected configuration, visible balance, visible total cost, non-PII account fingerprint, and current visible asset references. It must not contain email, prompt text already in the tab, cookies, tokens, or passwords.

For recovery, retain the same database, request file, job ID, and idempotency key. Never regenerate after timeout, crash, uncertain submission, or ambiguous results. A stale observed tab is not permission to create a replacement: inventory once for the same existing project tab, otherwise stop with `EXISTING_SESSION_REQUIRED` without changing the browser UI. See the runtime's `docs/OPERATIONS.md` for its exact command surface and the guarded provider-failure retry conditions.
