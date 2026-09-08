# Existing-browser executor lifecycle

This contract applies whenever a Flow action needs the visible browser. Its purpose is to preserve the user's Flow workspace and its generation cards while a job moves between agent turns.

## Acquire and record

- A run has exactly one browser executor owner at a time. Other agents may inspect local manifests and tickets, but must not acquire, create, or switch browser tabs.
- Start with a fresh browser inventory. Find the user's already-open authenticated Flow tab by its canonical project URL, provider tab identity (`providerTabId` when exposed), and current visible project identity, then claim/get that existing tab. Record the observed browser ID, tab ID, canonical URL, project identity, and observation time in the sanitized observation and run record.
- A browser ID is an executor-local connection label, not a Chrome-tab identity. Different agents can receive different browser IDs for the same visible Chrome tab. On handoff, rediscover rather than requiring browser IDs to match; match the provider tab identity and canonical project URL instead. Do not hard-code a browser ID, tab ID, profile name, or a previous run's handle.
- If the recorded handle is stale, take one fresh inventory and match the same existing Flow project tab again. If no exact existing tab is found, stop with `EXISTING_SESSION_REQUIRED`, preserve the UI, and ask the user to open the project in their existing signed-in browser. Do not create a tab, a window, a profile, or a new Flow session as fallback.

## Execute and hand off

- The executor uses the claimed existing tab for final readback, the single authorized click, reconciliation, and download. It does not create browser tabs or pages; it does not close, reload, restart, or navigate away from the user's Flow tab.
- A normal turn, subagent completion, disconnect, or executor handoff releases control only. It never closes the user tab. The next owner repeats inventory and claims the recorded existing tab; it does not reuse an opaque old handle blindly.
- If an owned test tab is unavoidable in an isolated compatibility fixture, mark it as an owned test resource and hand it off before the tool turn ends so automatic cleanup cannot erase live evidence. Such tabs are forbidden for the default Flow path and must never hold a real Flow project or generation card.

## Stop conditions

- An unsupported connector, missing executor, ambiguous project match, stale tab with no exact match, or a page that cannot be read safely is a clear stop. Report the reason and leave all visible browser state untouched.
- Reload is allowed only when the user authorizes it or when it is necessary to clear a documented, non-editing error state and the executor has confirmed there is no unsaved UI state. Restarting a browser, switching profiles, or opening a new page is never a recovery path.

The runtime ticket fence remains the source of truth for whether a click may occur. This lifecycle adds the UI ownership rule; it does not weaken the ticket, quote, idempotency, or authorization checks.
