import { FlowBridgeError } from "../../contracts/src/index.js";
import { DEFAULT_FLOW_PROFILE, ProfileLease, assertDedicatedProfile } from "./profile.js";
import { chromium as playwrightChromium } from "playwright";

export const FLOW_HOME_URL = "https://flow.google.com/";

export interface BrowserPage {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  url(): string;
  getByRole(role: string, options?: Record<string, unknown>): Locator;
  getByLabel(label: string | RegExp, options?: Record<string, unknown>): Locator;
  getByText(text: string | RegExp, options?: Record<string, unknown>): Locator;
  locator(selector: string): Locator;
  waitForEvent?(event: string): Promise<unknown>;
}
export interface Locator {
  count(): Promise<number>;
  isVisible?(): Promise<boolean>;
  click(options?: Record<string, unknown>): Promise<void>;
  fill?(value: string): Promise<void>;
  inputValue?(): Promise<string>;
  selectOption?(value: string): Promise<string[]>;
  setInputFiles?(files: string | string[]): Promise<void>;
  getAttribute?(name: string): Promise<string | null>;
  nth?(index: number): Locator;
  allTextContents?(): Promise<string[]>;
  textContent?(): Promise<string | null>;
  locator?(selector:string): Locator;
}
interface PersistentContext { pages(): BrowserPage[]; newPage(): Promise<BrowserPage>; close(): Promise<void> }
interface Chromium { launchPersistentContext(path: string, options: Record<string, unknown>): Promise<PersistentContext> }

declare const dedicatedCompatibilityAuthorization: unique symbol;
export type DedicatedCompatibilityAuthorization = { readonly [dedicatedCompatibilityAuthorization]: true };
const issuedDedicatedCompatibilityAuthorizations = new WeakSet<object>();

/**
 * Dedicated-profile Chrome is a compatibility tool, never an automatic fallback.
 * Callers must carry an explicit authorization value into the launch site.
 */
export function authorizeDedicatedCompatibility(explicitlyAuthorized: boolean): DedicatedCompatibilityAuthorization {
  if (!explicitlyAuthorized) throw new FlowBridgeError("PROVIDER_UNAVAILABLE", "Dedicated browser compatibility mode requires explicit current-request authorization.", { reason: "DEDICATED_BROWSER_NOT_AUTHORIZED" });
  const authorization = Object.freeze({}) as DedicatedCompatibilityAuthorization;
  issuedDedicatedCompatibilityAuthorizations.add(authorization);
  return authorization;
}

export class FlowBrowserSession {
  private constructor(readonly profileDir: string, private readonly lease: ProfileLease, private readonly context: PersistentContext, readonly page: BrowserPage) {}
  static async openDedicatedCompatibility(authorization: DedicatedCompatibilityAuthorization, profileDir = DEFAULT_FLOW_PROFILE, targetUrl = FLOW_HOME_URL): Promise<FlowBrowserSession> {
    if (typeof authorization !== "object" || authorization === null || !issuedDedicatedCompatibilityAuthorizations.has(authorization)) {
      throw new FlowBridgeError("PROVIDER_UNAVAILABLE", "Dedicated browser compatibility mode requires a valid runtime authorization token.", { reason: "DEDICATED_BROWSER_NOT_AUTHORIZED" });
    }
    const safeDir = assertDedicatedProfile(profileDir);
    const lease = await ProfileLease.acquire(safeDir);
    try {
      const context = await (playwrightChromium as unknown as Chromium).launchPersistentContext(safeDir, {
        channel: "chrome", headless: false, acceptDownloads: true, locale: "en-US",
      });
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
      return new FlowBrowserSession(safeDir, lease, context, page);
    } catch (cause) {
      await lease.release();
      throw cause;
    }
  }
  async close(): Promise<void> { await this.context.close().finally(() => this.lease.release()); }
  async authStatus(): Promise<{ status: "authenticated" | "auth_required" | "unknown"; url: string }> {
    const url = this.page.url();
    if (/accounts\.google\.com|signin|login/i.test(url)) return { status: "auth_required", url };
    const signIn = this.page.getByRole("button", { name: /sign in/i });
    if (await visible(signIn)) return { status: "auth_required", url };
    const flowLandmark = this.page.getByRole("main");
    return { status: await visible(flowLandmark) ? "authenticated" : "unknown", url };
  }
}

export async function visible(locator: Locator): Promise<boolean> {
  try { return locator.isVisible ? await locator.isVisible() : (await locator.count()) > 0; } catch { return false; }
}
