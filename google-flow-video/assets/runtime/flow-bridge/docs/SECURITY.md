# Security and privacy

By default FlowBridge accepts only an existing authenticated Flow tab exposed through Codex's supported browser tool. It validates the Flow origin and current tab/session for each executor ticket, disconnects without closing the user's browser or original tab, and does not launch daily Chrome User Data, copy cookies/tokens/profiles, enable a debugging port, restart Chrome, or install an extension. A separate dedicated profile is an explicit compatibility-test option only.

The executor ticket is one-shot and bound to the immutable request. Core validation and atomic intent persistence occur before ticket execution; final visible configuration, cost and balance readback occur immediately before the single click. Existing intent means `Generate=false`. Diagnostics must omit complete email addresses and any prompt already present in the user's tab.

The Flow UI path enforces a fixed 50-credit whole-job cap from the current visible configuration. Unknown or higher cost stops. Request/input hashes, runtime snapshot, intent and fencing evidence are persisted before Generate; recovery with an existing intent cannot submit again.

`flowd` listens on `127.0.0.1`. Anonymous `/healthz` returns only `{ "ok": true }`; job endpoints require the bearer token stored in a mode-0600 file and reject disallowed Host and Origin headers. Do not pass the token in command arguments or logs.

Mock mode requires explicit request and runtime enablement. Mock and synthetic artifacts must never be labeled as Flow output.

