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

For a new live request, choose a user-owned writable directory outside this skill and set `FLOWBRIDGE_DB_PATH` there. Create the job with `generate --no-run`; this is local persistence only. New parent ledgers use the 200-Credit cap; an older 50-Credit ledger remains a recovery record and must not be upgraded. A live click requires a fresh sanitized observation from the current connected Flow tab, then `browser prepare`, `browser claim`, an executor final readback and the single authorized click, followed by a receipt. The CLI cannot attach to a browser by itself. Read [executor session lifecycle](executor-session-lifecycle.md) before attaching: the executor must claim an existing user Flow tab from fresh inventory, record its observed identity, and release control without closing it at handoff or completion.

The production workspace can create versioned references, scene plans, dependency checks, and immutable request inputs. `edit_video` requires a local `source_video` whose hash is frozen by the engine; it uses the default Omni policy and has no model fallback. These commands prepare local records only. The current Flow page must visibly expose the matching Edit video mode and upload slot at final readback, otherwise the engine stops before intent or click. No live Flow edit has been accepted by this portable package.

The observation must have only browser/tab IDs, the canonical Flow project URL, timestamp, visible selected configuration, visible balance, visible total cost, non-PII account fingerprint, and current visible asset references. It must not contain email, prompt text already in the tab, cookies, tokens, or passwords.

## Local production workspace commands

The workspace commands are local planning operations. They never click Generate. Capture the JSON IDs from each command and use one 200-Credit ledger ID with distinct step keys across the film:

```bash
pnpm --silent flowctl workspace project add --name "Local film"
pnpm --silent flowctl workspace entity add --project <project-id> --name "Lead" --kind character
pnpm --silent flowctl workspace entity revise --entity <entity-id> --sha256 <sha256> --role identity --source-kind local --locator /absolute/path/lead.png
pnpm --silent flowctl workspace scene plan --project <project-id> --ordinal 1 --prompt "Shot action" --references <reference-version-id>
pnpm --silent flowctl workspace scene revise --scene <scene-id> --capability-observation /absolute/path/observation.json
pnpm --silent flowctl workspace scene revise --scene <scene-id> --model "Veo 3.1 Fast" --capability-observation /absolute/path/observation.json
pnpm --silent flowctl workspace scene depend --scene <child-scene-id> --on <parent-scene-id>
pnpm --silent flowctl workspace scene status --scene <scene-id>
pnpm --silent flowctl workspace scene export-request --scene <scene-id> --idempotency-key <key> --project-name <flow-project-name> --mode text_to_video --aspect-ratio 16:9 --duration-seconds 4 --resolution 720p --outputs 1 --budget-ledger <film-200> --budget-step <shot-01> --out /absolute/path/request.json
```

The Veo command is only for an explicit user choice. Its name must be visibly present on the current Flow page; a missing or mismatched option stops and never falls back to Omni or another model. `export-request` creates an immutable local job with no provider effect and binds it to the scene, request hash, and shared budget context. `dispatch-to-existing-job --scene <scene-id> --job <job-id>` does not run a provider; it writes a local binding record only when the immutable request and budget context match. A changed local reference file fails hash validation; a submitted or terminal job is reconciliation-only.

For an offline edit ticket, pass `--mode edit_video --source-video /absolute/path/source.mp4`. It is not proof of a successful Flow edit. The connected existing page must visibly read back Edit video and its source-video upload slot before intent or click.

Run `pnpm --silent flowd` to start the loopback-only read-only dashboard. Its startup JSON supplies `dashboardUrl` and `tokenPath`; use the token from that local file in the dashboard. It cannot submit, retry, or operate the browser.

For recovery, retain the same database, request file, job ID, and idempotency key. Never regenerate after timeout, crash, uncertain submission, or ambiguous results. A stale observed tab is not permission to create a replacement: inventory once for the same existing project tab, otherwise stop with `EXISTING_SESSION_REQUIRED` without changing the browser UI. See the runtime's `docs/OPERATIONS.md` for its exact command surface and the guarded provider-failure retry conditions.
