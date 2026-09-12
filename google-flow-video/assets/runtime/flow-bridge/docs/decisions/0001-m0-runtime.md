# ADR 0001: M0 runtime and dependency boundary

Status: accepted for M0 implementation.

FlowBridge uses Node.js 22, TypeScript with NodeNext modules, pnpm, Zod, Fastify, Playwright and SQLite through `better-sqlite3`. The M0 path is a direct minimal CLI to `JobEngine` to `FlowProvider` chain. `flowd` remains a thin local REST wrapper over the same engine; MCP and Gemini billing are deferred to M5/M6.

The mock Provider is test-only and must be explicitly selected. The real `flow_ui` path never falls back to mock success. Any whole-job Flow cost that is unknown or above 50 Credits is rejected before a persistent submission intent can be consumed. Once an intent exists, restart and resume reconcile only and never call Generate again.

