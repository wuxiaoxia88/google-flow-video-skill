# Operations

## Verification

```bash
pnpm install
pnpm check
```

The suite includes unit/fixture checks plus black-box CLI, REST, SQLite/process-restart and synthetic-media acceptance. It does not spend Flow Credits.

## CLI

```bash
LEDGER_ID="replace-with-ledger-id"
JOB_ID="replace-with-job-id"
TICKET_ID="replace-with-ticket-id"
pnpm --silent flowctl doctor
pnpm --silent flowctl credits
pnpm --silent flowctl capabilities
pnpm --silent flowctl budget create --id "$LEDGER_ID"
pnpm --silent flowctl budget status --id "$LEDGER_ID"
pnpm --silent flowctl generate --file /absolute/path/request.json --no-run
pnpm --silent flowctl browser observe --file /absolute/path/sanitized-observation.json
pnpm --silent flowctl browser prepare --job "$JOB_ID" --observation /absolute/path/fresh-observation.json
pnpm --silent flowctl browser claim --ticket "$TICKET_ID" --observation /absolute/path/final-observation.json
pnpm --silent flowctl browser receipt --ticket "$TICKET_ID" --outcome clicked
RECONCILE_TICKET_ID="replace-with-claimed-reconcile-ticket-id"
FAILED_JOB_ID="replace-with-failed-job-id"
pnpm --silent flowctl browser fail --ticket "$RECONCILE_TICKET_ID" --evidence /absolute/path/failure-evidence.json
pnpm --silent flowctl browser retry-prepare --job "$FAILED_JOB_ID" --observation /absolute/path/fresh-observation.json
pnpm --silent flowctl status "$JOB_ID"
pnpm --silent flowctl resume "$JOB_ID"
pnpm --silent flowctl cancel "$JOB_ID"
```

Credits reads one uniquely visible account balance and capabilities returns only the currently visible model/mode/ratio/duration/resolution/output combination, each with source and capture time. Missing or ambiguous controls return `unknown` with a nonzero exit; no static values or inferred capability matrix are substituted. Preserve the original database, job id, request and key for recovery; never create a new submission after `SUBMISSION_UNCERTAIN`.

`browser fail` is limited to a claimed `RECONCILE` ticket for an existing active attempt. Its hash-bound evidence must identify the same project, contain the exact provider failure message, show the immutable pre-submit and current asset sets are identical, set `charged` to `not_charged`, show no retry click, and include unchanged before/after balances when balance proof is supplied. The original Generate ticket must already have one matching `clicked` receipt. Unknown charging, changed balances, missing baseline, a new output, a different tab/account/project, or malformed evidence leaves the job unresolved and cannot authorize another effect. A failure page may omit generation controls and price because reconciliation itself has no provider effect.

After that guarded transition produces `FAILED/PROVIDER_FAILURE`, `browser retry-prepare` can create exactly one attempt 2 on the same job, idempotency key and request hash. It requires the original browser/tab/account/project fence plus a complete fresh configuration and price. The retry quote is reserved under `<original_step_key>-retry1`; the first quote remains conservatively consumed. Repeated prepare is idempotently blocked and attempt 3 is forbidden. Timeout, crash, `SUBMISSION_UNCERTAIN`, `RESULT_AMBIGUOUS`, and any job with an output are never eligible for this retry route.

The default `existing_browser` route requires Codex to connect the already-open Flow tab to the local executor-ticket bridge. A standalone CLI cannot obtain the Codex browser handle automatically and returns `EXISTING_SESSION_REQUIRED` when no executor is attached. One executor owns browser work for a run. It begins with a fresh inventory, claims the existing tab matching the recorded canonical project identity, and records the observed browser/tab identifiers as per-run evidence only. A browser ID is executor-local; two agents may see different browser IDs for the same Chrome tab. Handoff therefore rediscovers and matches `providerTabId` when exposed plus the canonical project URL, rather than requiring browser IDs to match. It never hard-codes or reuses a prior run's opaque handle. The ticket validates the Flow origin and current tab/session, performs final readback, and permits at most one click after the core has atomically persisted intent. Executor teardown, handoff, and agent completion only release local references; they must not close or disconnect the browser or original tab. Existing intent disables Generate and permits status, reconciliation and download only. Keep the same user-opened Flow tab for the whole parent run, including retries and recovery. Do not create a replacement tab when a ticket completes, fails, expires, or is renewed. Dedicated-profile compatibility mode is a separate explicit authorization path and is never a fallback for a missing or stale existing tab.

If a recorded handle is stale, inventory once and match the same existing project tab. If no exact existing tab is available, stop with `EXISTING_SESSION_REQUIRED`, preserve the visible UI, and ask the user to open the project in their existing signed-in browser. Do not create a browser tab, window, profile, Flow session, or fallback page. Do not reload, restart, navigate away, or close the user's Flow tab. Reload is allowed only with user authorization or to clear a documented non-editing error after confirming that no unsaved UI state exists. Isolated compatibility tests may use explicitly owned test tabs, but must hand them off before tool-turn cleanup; they are forbidden for the default live Flow path.

`browser observe`, `claim`, and `receipt` exchange sanitized data with the Codex executor. They do not control Chrome themselves. The executor must perform the one authorized action between claim and receipt; a manually supplied `clicked` receipt is only a claim and must never be presented as browser evidence without the executor's matching readback.

A credits-only observation may use `"configuration": null` and `"totalCredits": null`; this is valid for `auth status` and `credits`, and `capabilities` then returns `unknown`. A Generate ticket rejects that incomplete observation and requires a current non-PII `account-sha256:<64 lowercase hex>` account fingerprint; a plan label such as `Pro` is sufficient for read-only reporting but cannot fence a paid action. The JSON must contain only `browserId`, `tabId`, `url`, `observedAt` (fresh ISO-8601, at most 60 seconds old), `configuration`, `availableCredits`, `totalCredits`, `visibleAccountContext` (a non-PII plan label or null), and `projectRef`. `url` and `projectRef` must be the same canonical `https://flow.google.com/project/<id>` URL. Never include an email address, prompt, cookie, token, or password.

Use one explicit database for the bridge commands, for example `FLOWBRIDGE_DB_PATH=/tmp/flowbridge-existing.sqlite pnpm --silent flowctl browser observe --file /tmp/flowbridge-current-observation.json`, then run `auth status`, `credits`, or `capabilities` with the same environment value. `auth open` only prints the Codex-executor handoff and never opens a browser.

Do not work around a missing connection by launching daily Chrome User Data, copying cookies/tokens/profiles, enabling a debugging port, restarting Chrome or installing an extension. A separate dedicated profile is available only through explicit compatibility-test configuration.

`--silent` suppresses pnpm's script banner so stdout contains only FlowBridge JSON. Wait/resume/download are behavior-tested through the explicit mock provider with locally generated media, including crash recovery and download-only retry. Historical run packages under `out/` record completed live reconciliation and browser downloads. They are immutable run evidence, not proof that a current executor is connected; each new live run must establish fresh browser/account/project fences and current final readback.

The independent production companion is documented in [PRODUCTION_CLI.md](PRODUCTION_CLI.md). It derives background-music-only Flow request templates, guards one-take external TTS, assembles hash-locked stems, and records technical QC. It does not submit Flow jobs, share the Flow Credits ledger, or turn technical/ASR evidence into human audio acceptance.

## REST

```bash
FLOWBRIDGE_DB_PATH=/absolute/path/flowbridge.sqlite \
FLOWBRIDGE_TOKEN_PATH=/absolute/path/token \
FLOWBRIDGE_PORT=43117 pnpm flowd
```

M0 routes are `GET /healthz`, `POST /v1/videos`, `GET /v1/videos/:id`, `POST /v1/videos/:id/cancel`, `POST /v1/videos/:id/resume`, `POST /v1/browser/observations`, `POST /v1/browser/tickets`, `POST /v1/browser/tickets/:id/claim`, and `POST /v1/browser/tickets/:id/receipt`. Read the bearer token from its private file.

Evidence labels: `mock` is deterministic provider behavior; `local-media` is synthetic media validation; `fixture` is browser parsing; `live-flow` is reserved for an authorized real Generate and readback. The existing browser connection has been observed as authenticated by the coordinating Codex session, but the local ticket bridge, result matching, download capture and paid Generate remain pending until exercised and recorded.
