import { DEFAULT_FLOW_PROFILE } from "./profile.js";
import { FLOW_HOME_URL, FlowBrowserSession, authorizeDedicatedCompatibility } from "./browser-session.js";

export type AuthStatus = "authenticated" | "auth_required" | "unknown";
export interface AuthRunUpdate { status: AuthStatus; url: string; profileDir: string; }
export interface AuthRunnerOptions { dedicatedCompatibilityAuthorized?: true; profileDir?: string; targetUrl?: string; pollMs?: number; onUpdate?: (update: AuthRunUpdate) => void | Promise<void>; }

/**
 * Owns one Playwright context for the whole manual-login interaction. Its timer
 * deliberately keeps Node alive; callers must await `close()` or abort it.
 */
export class FlowAuthRunner {
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private last: AuthRunUpdate | undefined;
  private constructor(private readonly session: FlowBrowserSession, private readonly options: Required<Pick<AuthRunnerOptions, "pollMs">> & AuthRunnerOptions) {}
  static async open(options: AuthRunnerOptions = {}): Promise<FlowAuthRunner> {
    const authorization = authorizeDedicatedCompatibility(options.dedicatedCompatibilityAuthorized === true);
    const session = await FlowBrowserSession.openDedicatedCompatibility(authorization, options.profileDir ?? DEFAULT_FLOW_PROFILE, options.targetUrl ?? FLOW_HOME_URL);
    const runner = new FlowAuthRunner(session, { ...options, pollMs: options.pollMs ?? 750 });
    await runner.poll();
    runner.timer = setInterval(() => { void runner.poll(); }, runner.options.pollMs);
    return runner;
  }
  get profileDir(): string { return this.session.profileDir; }
  get status(): AuthRunUpdate | undefined { return this.last; }
  async waitForAuthenticated(signal?: AbortSignal): Promise<AuthRunUpdate> {
    while (!this.closed) {
      if (this.last?.status === "authenticated") return this.last;
      if (signal?.aborted) throw signal.reason ?? new Error("Authentication wait aborted");
      await delay(this.options.pollMs);
    }
    throw new Error("Authentication window was closed before confirmation");
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.session.close();
  }
  private async poll(): Promise<void> {
    if (this.closed) return;
    let current: { status: AuthStatus; url: string };
    try { current = await this.session.authStatus(); }
    catch { current = { status: "unknown", url: "" }; }
    const update = { ...current, profileDir: this.profileDir };
    if (!this.last || this.last.status !== update.status || this.last.url !== update.url) {
      this.last = update; await this.options.onUpdate?.(update);
    }
  }
}
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
