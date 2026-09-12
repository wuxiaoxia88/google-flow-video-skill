import { randomUUID } from "node:crypto";
import { FlowBridgeError, type FlowProvider, type PreparedSubmission, type ProviderAsset, type ProviderContext, type VideoGenerationRequest } from "../../contracts/src/index.js";
import { type BrowserPage } from "./browser-session.js";
import { SemanticFlowPage } from "./semantic-flow-page.js";
import { assertSnapshotMatches } from "../../policy-engine/src/index.js";

const PAGE_LEASE = Symbol("flowbridge.page-lease");
export interface FlowPageLease {
  readonly page: BrowserPage;
  readonly ownership: "borrowed_existing_tab" | "owned_dedicated_compatibility" | "owned_test_fixture";
  readonly [PAGE_LEASE]: true;
  release(): Promise<void>;
}

/** Borrow a user-owned existing tab. Releasing this lease is intentionally a no-op. */
export function borrowExistingFlowTab(page: BrowserPage): FlowPageLease {
  return Object.freeze({ page, ownership: "borrowed_existing_tab" as const, [PAGE_LEASE]: true as const, release: async () => undefined });
}

/** Wrap an explicitly owned session. This is used only by dedicated compatibility and fixtures. */
export function ownFlowPage(page: BrowserPage, ownership: "owned_dedicated_compatibility" | "owned_test_fixture", disposeOwnedSession: () => Promise<void>): FlowPageLease {
  let released = false;
  return Object.freeze({ page, ownership, [PAGE_LEASE]: true as const, release: async () => { if (released) return; released = true; await disposeOwnedSession(); } });
}

export interface FlowUiProviderOptions {
  /** Explicit lease factory. The provider has no browser/tab close or launch capability. */
  acquirePage?: () => Promise<FlowPageLease>;
  downloadAsset?: (asset: ProviderAsset, directory: string) => Promise<ProviderAsset>;
}
export type ReadOnlyBalance = { balance: number | null; source: "page_visible" | "unknown"; capturedAt: string; reason?: string };
export type ObservedCapabilities = Awaited<ReturnType<SemanticFlowPage["readObservedCombination"]>>;

/** UI-only provider: no private endpoints, retries, or static-price authorization. */
export class FlowUiProvider implements FlowProvider {
  readonly kind = "flow_ui" as const;
  private readonly prepared = new Map<string, { lease: FlowPageLease; page: SemanticFlowPage }>();
  constructor(private readonly options: FlowUiProviderOptions = {}) {}
  private async acquire(): Promise<FlowPageLease> {
    if (!this.options.acquirePage) throw new FlowBridgeError("PROVIDER_UNAVAILABLE", "Default Flow execution requires the existing-browser executor ticket bridge; no browser or tab will be created.", { reason: "EXISTING_SESSION_REQUIRED" });
    const lease = await this.options.acquirePage();
    if (!lease || lease[PAGE_LEASE] !== true) throw new FlowBridgeError("PROVIDER_UNAVAILABLE", "Browser adapter did not provide a lifecycle-safe page lease.", { reason: "UNSAFE_BROWSER_ADAPTER" });
    return lease;
  }
  async readBalance(): Promise<ReadOnlyBalance> {
    const result = await this.readOnly(page => page.readVisibleBalance());
    return { ...result, balance: "balance" in result && typeof result.balance === "number" ? result.balance : null };
  }
  async readCapabilities(): Promise<ObservedCapabilities> {
    const result = await this.readOnly(page => page.readObservedCombination());
    return { ...result, observed: "observed" in result ? result.observed : null };
  }
  private async readOnly<T extends { source: "page_visible" | "unknown"; capturedAt: string; reason?: string }>(read: (page: SemanticFlowPage) => Promise<T>): Promise<T> {
    let lease: FlowPageLease | undefined;
    try { lease = await this.acquire(); return await read(new SemanticFlowPage(lease.page)); }
    catch (cause) { return { source: "unknown", capturedAt: new Date().toISOString(), reason: cause instanceof FlowBridgeError ? String(cause.details.reason ?? cause.code) : "READ_ONLY_SESSION_FAILED" } as T; }
    finally { await lease?.release(); }
  }
  async prepare(request: VideoGenerationRequest): Promise<PreparedSubmission> {
    const lease = await this.acquire();
    try {
      const page = new SemanticFlowPage(lease.page);
      await page.configure(request);
      const snapshot = await page.readSnapshot(request);
      const handle = randomUUID(); this.prepared.set(handle, { lease, page });
      return { snapshot, handle };
    } catch (cause) { await lease.release(); throw cause; }
  }
  async discardPrepared(prepared: PreparedSubmission): Promise<void> {
    const active = this.prepared.get(prepared.handle);
    if (!active) return;
    this.prepared.delete(prepared.handle);
    await active.lease.release();
  }
  async submitPrepared(request: VideoGenerationRequest, prepared: PreparedSubmission, context: ProviderContext): Promise<{ evidence: Record<string, unknown> }> {
    const active = this.prepared.get(prepared.handle);
    if (!active) throw new FlowBridgeError("SUBMISSION_UNCERTAIN", "Prepared browser state is unavailable; do not re-submit.", { handle: prepared.handle });
    this.prepared.delete(prepared.handle);
    try {
      const before = (await active.page.visibleAssets()).map(asset => asset.ref);
      const snapshot = await active.page.readSnapshot(request);
      assertSnapshotMatches(request,snapshot);
      const configuredChanged = snapshot.mode !== request.mode || snapshot.aspectRatio !== request.aspectRatio || snapshot.durationSeconds !== request.durationSeconds || snapshot.resolution !== request.resolution || snapshot.outputs !== request.outputs;
      const preparedChanged = snapshot.projectRef !== prepared.snapshot.projectRef || snapshot.modelOption?.label !== prepared.snapshot.modelOption?.label || snapshot.modelOption?.value !== prepared.snapshot.modelOption?.value || snapshot.capabilityCapture?.hash!==prepared.snapshot.capabilityCapture?.hash || snapshot.mode !== prepared.snapshot.mode || snapshot.aspectRatio !== prepared.snapshot.aspectRatio || snapshot.durationSeconds !== prepared.snapshot.durationSeconds || snapshot.resolution !== prepared.snapshot.resolution || snapshot.outputs !== prepared.snapshot.outputs || snapshot.visibleAccountContext !== prepared.snapshot.visibleAccountContext;
      if (configuredChanged || preparedChanged) {
        throw new FlowBridgeError("UNSUPPORTED_COMBINATION", "Visible Flow settings changed after prepare; refusing the Generate click.", { requested: request, readback: snapshot });
      }
      if (snapshot.totalCredits === null) throw new FlowBridgeError("COST_UNKNOWN", "Visible Flow cost cannot be reliably read; refusing to submit.");
      if (snapshot.availableCredits !== null && snapshot.availableCredits < snapshot.totalCredits) throw new FlowBridgeError("INSUFFICIENT_CREDITS", "Visible account balance is below the whole-job cost; refusing to submit.", { availableCredits: snapshot.availableCredits, totalCredits: snapshot.totalCredits });
      if (snapshot.totalCredits > request.costPolicy.maxCredits) throw new FlowBridgeError("COST_LIMIT_EXCEEDED", `Visible whole-job cost exceeds the authorized ${request.costPolicy.maxCredits}-Credit ceiling.`, { totalCredits: snapshot.totalCredits });
      // Exactly one button click; the job engine records the intent before this method is reached.
      await active.page.clickGenerateOnce();
      return { evidence: { attemptId: context.attemptId, requestHash: context.requestHash, beforeAssetRefs: before, projectRef: snapshot.projectRef, submittedAt: new Date().toISOString(), snapshot } };
    } catch (cause) {
      // Any post-intent browser uncertainty must be treated as unknown, never retried by this adapter.
      if (cause instanceof FlowBridgeError) throw cause;
      throw new FlowBridgeError("SUBMISSION_UNCERTAIN", "Flow UI action failed after submission was authorized; do not click Generate again.", { cause: String(cause), attemptId: context.attemptId });
    } finally { await active.lease.release(); }
  }
  async reconcile(request: VideoGenerationRequest, context: ProviderContext): Promise<{ assets: ProviderAsset[]; complete: boolean }> {
    const projectRef = context.projectRef;
    const before = context.submissionEvidence?.beforeAssetRefs;
    if (!projectRef || !Array.isArray(before) || !before.every(value => typeof value === "string")) throw new FlowBridgeError("RESULT_AMBIGUOUS", "Persisted project/asset baseline evidence is unavailable; no asset can be attributed safely.");
    const lease = await this.acquire();
    try {
      if (lease.ownership === "borrowed_existing_tab") {
        assertBorrowedTabProject(lease.page.url(), projectRef);
      } else {
        await lease.page.goto(projectRef, { waitUntil: "domcontentloaded" });
        if (lease.page.url() !== projectRef) throw new FlowBridgeError("RESULT_AMBIGUOUS", "Owned compatibility page did not read back the requested Flow project after recovery.", { expected: projectRef, actual: lease.page.url() });
      }
      const candidates = (await new SemanticFlowPage(lease.page).visibleAssets()).filter(asset => !before.includes(asset.ref));
      const providerAssets: ProviderAsset[] = candidates.map(asset => ({
        providerAssetRef: asset.ref, status: asset.status,
        metadata: { projectRef, cardRef: asset.ref, providerModelReadback:asset.modelReadback, provenance: { jobId: context.jobId, projectName: request.project.name, projectUrl: projectRef, modelRequested: request.model, modelActual: asset.modelReadback.family==="unknown"?"unknown":asset.modelReadback.label??asset.modelReadback.value??"unknown", aspectRatio: request.aspectRatio, durationSeconds: request.durationSeconds, resolution: request.resolution, promptSha256: context.requestHash, targetMatchEvidence: { provider_card_ref: asset.ref, before_asset_refs: before, intent_recorded_at: context.intentRecordedAt ?? null }, inputAssets: inputHashes(request) } },
      }));
      if (candidates.some(asset => asset.status === "generating")) return { assets: providerAssets, complete: false };
      const done = candidates.filter(asset => asset.status === "generated");
      if (done.length !== request.outputs || candidates.length !== request.outputs) throw new FlowBridgeError("RESULT_AMBIGUOUS", "Completed Flow cards cannot be uniquely attributed to this submission.", { candidateCount: candidates.length, completedCount: done.length, expectedOutputs: request.outputs });
      const required=request.modelPolicy?.requiredFamily;
      const mismatched=done.filter(asset=>asset.modelReadback.family!=="unknown"&&required&&asset.modelReadback.family!==required);
      if(mismatched.length)throw new FlowBridgeError("RESULT_AMBIGUOUS","Result card model readback conflicts with the immutable requested model policy",{requiredFamily:required,readbacks:mismatched.map(x=>x.modelReadback)});
      return { assets: providerAssets, complete: true };
    } finally { await lease.release(); }
  }
  async download(asset: ProviderAsset, directory: string): Promise<ProviderAsset> {
    if (!this.options.downloadAsset) throw new FlowBridgeError("DOWNLOAD_FAILED", "No verified download manager is attached to FlowUiProvider.", { providerAssetRef: asset.providerAssetRef, directory });
    return this.options.downloadAsset(asset, directory);
  }
}
function inputHashes(request: VideoGenerationRequest): Array<{ ordinal: number; contentSha256: string }> {
  return [request.inputs?.firstFrame, request.inputs?.lastFrame, ...(request.inputs?.ingredients ?? [])].flatMap((asset, ordinal) => asset?.contentSha256 ? [{ ordinal, contentSha256: asset.contentSha256 }] : []);
}

function assertBorrowedTabProject(currentUrl: string, expectedProjectRef: string): void {
  let current: URL;
  try { current = new URL(currentUrl); }
  catch { throw new FlowBridgeError("RESULT_AMBIGUOUS", "Borrowed Flow tab identity is unavailable; recovery stopped without navigating or replacing the user's tab.", { reason: "BORROWED_TAB_IDENTITY_UNAVAILABLE" }); }
  const match = current.origin === "https://flow.google.com" && !current.search && !current.hash
    ? current.pathname.match(/^\/project\/([A-Za-z0-9_-]+)(?:\/edit\/[A-Za-z0-9_-]+)?\/?$/)
    : null;
  if (!match) throw new FlowBridgeError("RESULT_AMBIGUOUS", "Borrowed tab is not on a canonical Flow project page; recovery stopped without navigating or replacing the user's tab.", { reason: "BORROWED_TAB_IDENTITY_UNAVAILABLE", actual: currentUrl });
  const actualProjectRef = `https://flow.google.com/project/${match[1]}`;
  if (actualProjectRef !== expectedProjectRef) throw new FlowBridgeError("RESULT_AMBIGUOUS", "Borrowed Flow tab is on a different project; recovery stopped without navigating or replacing the user's tab.", { reason: "BORROWED_TAB_PROJECT_MISMATCH", expected: expectedProjectRef, actual: actualProjectRef });
}
