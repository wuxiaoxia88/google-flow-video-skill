# FlowBridge contributor rules

- Read `docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, and `docs/OPERATIONS.md` before runtime changes.
- Keep browser operations in `packages/flow-adapter`. The default `existing_browser` route may use the user's already-open, already-authenticated Flow tab only through a supported Codex browser-tool connection and an executor ticket. Never launch a persistent context over daily Chrome User Data, copy cookies/tokens/profiles, enable a debugging port, restart Chrome, install an extension, or close the user's browser/original tab. Dedicated-profile operation is compatibility testing only and requires explicit opt-in.
- Bind every ticket to the current Flow origin, tab/session identity and immutable request. Do not persist a complete email address or pre-existing page prompt. An existing submission intent sets `Generate=false`; recovery may observe, reconcile and download only.
- The whole Flow UI parent-run cap is fixed at 200 Credits for new ledgers. Existing 50-Credit ledgers are immutable recovery records and are never automatically upgraded. Unknown or over-cap cost has no provider effect.
- Persist immutable hashes, runtime snapshot and intent before Generate. Existing intent allows recovery only.
- Mock mode must be explicit and its artifacts labeled mock.
- Run `pnpm check`. Real account tests require centralized authorization and cannot be inferred from mock success.
- When multi-agent work is explicitly requested, assign concrete implementation or verification work to SOL, TERRA, or LUNA agents with clear file ownership; the coordinating agent integrates shared contracts, dependencies, and final validation.

## Current audio decision (2026-09-06)

For future video generation, Chinese dialogue is an independent unified-voice localization stem; the generation phase uses `background_music_only` (background music and picture, with no spoken language). See [docs/GENERATION_AUDIO_POLICY.md](docs/GENERATION_AUDIO_POLICY.md). Existing Flow submissions, the original master, and historical derived prompts are immutable and must not be rewritten.
