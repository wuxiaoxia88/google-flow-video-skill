# FlowBridge

FlowBridge is a local, auditable bridge from Codex to the Google Flow web UI. The default `existing_browser` path is designed to use a Flow tab already connected through Codex's supported browser tool; the standalone CLI cannot acquire that Codex browser handle by itself. The safety core, explicit mock testing, and validated local media persistence are implemented. Historical run evidence under `out/` includes completed live Flow assets, but that machine-specific evidence does not make a fresh executor connection available or prove unattended portability.

```bash
pnpm install
pnpm check
pnpm --silent flowctl doctor
pnpm --silent flowctl generate --file /absolute/path/request.json --no-run
```

Requirements are Node.js 22, pnpm 11, a Codex executor connection for the default visible Flow UI path, and `ffprobe` plus `ffmpeg` for downloaded-media acceptance. Requests use the snake_case contract in [PRD.md](docs/PRD.md). `flow_ui` never falls back to mock; mock requires both `backend: mock` and `--enable-mock`.

New Flow UI parent ledgers have a fixed 200-credit cap. Existing 50-credit ledgers are preserved for recovery and never upgraded. Unknown or higher visible cost stops before the provider effect. A persisted submission intent blocks automatic resubmission after restart or uncertainty.

New jobs request Gemini Omni Flash by default; Veo is selected only when the user explicitly asks for it, and no model fallback is allowed. The bridge uses the existing logged-in Flow page only: it does not use Google APIs, private RPC, tokens, or a replacement browser tab. The local production workspace records versioned source references, scene dependencies, and edit branches; its `edit_video` request is a ticket/input contract until the current Flow UI visibly confirms the mode and upload slot.

Use `pnpm --silent flowctl` when stdout must be pure JSON; the ordinary pnpm script wrapper prints its own command line. `generate --wait`, original-job resume, validated automatic download, and download-only retry are implemented and tested with the explicit mock provider and real local media tools. Historical UI runs exercised reconciliation and download capture; every new run still requires a fresh supported Codex executor connection and current page evidence.

For `flow_ui`, Codex first supplies a fresh sanitized observation from the selected existing Flow tab, then asks the core to prepare a one-shot browser ticket for the created job. The Codex executor performs final readback and any authorized click, then returns a receipt. The receipt command records executor-reported evidence; calling it alone does not operate Chrome and is not proof that a click occurred.

See [ARCHITECTURE.md](docs/ARCHITECTURE.md), [OPERATIONS.md](docs/OPERATIONS.md), and [SECURITY.md](docs/SECURITY.md).

For immutable prompt derivation, unified external Chinese TTS, locked-stem assembly and local QC, see [PRODUCTION_CLI.md](docs/PRODUCTION_CLI.md). This companion remains separate from the Flow credit ledger.
