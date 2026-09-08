import { FlowBridgeError, type GenerationMode, type RuntimeSubmissionSnapshot, type VideoGenerationRequest } from "../../contracts/src/index.js";
import type { BrowserPage, Locator } from "./browser-session.js";
import { visible } from "./browser-session.js";

const labels = { model: /model/i, mode: /(?:^|\b)(?:mode|generation type)(?:\b|$)/i, duration: /length|duration/i, ratio: /orientation|aspect/i, resolution: /resolution/i, outputs: /outputs?|number of outputs/i, credits: /credits?/i };
const modeLabels: Record<GenerationMode, string> = { text_to_video: "Text to video", extend_video: "Extend video", first_frame_to_video: "First frame to video", first_last_frames_to_video: "First and last frames to video", ingredients_to_video: "Ingredients to video" };

export class SemanticFlowPage {
  constructor(private readonly page: BrowserPage) {}
  private async one(locator: Locator, what: string): Promise<Locator> {
    if ((await locator.count()) !== 1 || !(await visible(locator))) throw new FlowBridgeError("PROVIDER_UNAVAILABLE", `Flow UI cannot reliably locate ${what}.`, { what });
    return locator;
  }
  async readSnapshot(request: VideoGenerationRequest): Promise<RuntimeSubmissionSnapshot> {
    const cost = this.page.getByText(/(?:generation\s+)?(?:total\s+)?(?:cost|price)\s*:/i);
    const totalCredits = (await cost.count()) === 1 && await visible(cost) ? parseVisibleCredits(await this.text(cost)) : null;
    const balance = await this.readVisibleBalance();
    const model = await this.readControl(labels.model, "model");
    const mode = parseMode(await this.readControl(labels.mode, "generation mode"));
    const aspectRatio = await this.readControl(labels.ratio, "aspect ratio");
    const durationSeconds = Number(await this.readControl(labels.duration, "duration"));
    const resolution = await this.readControl(labels.resolution, "resolution");
    const outputs = Number(await this.readControl(labels.outputs, "outputs"));
    if (!Number.isInteger(durationSeconds) || !Number.isInteger(outputs)) throw new FlowBridgeError("UNSUPPORTED_COMBINATION", "Flow UI did not expose an unambiguous duration or output count.");
    const projectRef = await this.verifyProject(request.project.name, false);
    return { configurationVerified: true, visibleAccountContext: null, projectRef, model, mode, durationSeconds, aspectRatio, resolution, outputs, totalCredits, availableCredits: balance.balance, capturedAt: new Date().toISOString(), capabilityFingerprint: await this.fingerprint() };
  }
  /** Read-only account balance. It intentionally never calls parseVisibleCredits. */
  async readVisibleBalance(): Promise<{ balance: number | null; source: "page_visible" | "unknown"; capturedAt: string; reason?: string }> {
    const candidate = this.page.getByText(/(?:balance|credits? remaining|credits? available)/i);
    if ((await candidate.count()) !== 1 || !(await visible(candidate))) return { balance: null, source: "unknown", capturedAt: new Date().toISOString(), reason: "BALANCE_NOT_UNIQUELY_VISIBLE" };
    const text = await this.text(candidate);
    const match = text.replace(/,/g, "").match(/(?:balance|remaining|available)\D{0,24}(\d+(?:\.\d+)?)/i);
    return match ? { balance: Number(match[1]), source: "page_visible", capturedAt: new Date().toISOString() } : { balance: null, source: "unknown", capturedAt: new Date().toISOString(), reason: "BALANCE_NOT_PARSEABLE" };
  }
  /** One currently visible selection only: no inferred model matrix or cartesian product. */
  async readObservedCombination(): Promise<{ observed: { model: string; mode: GenerationMode; aspectRatio: string; durationSeconds: number; resolution: string; outputs: number } | null; source: "page_visible" | "unknown"; capturedAt: string; reason?: string }> {
    try {
      const model = await this.readControl(labels.model, "model"); const mode = parseMode(await this.readControl(labels.mode, "generation mode"));
      const aspectRatio = await this.readControl(labels.ratio, "aspect ratio"); const durationSeconds = Number(await this.readControl(labels.duration, "duration"));
      const resolution = await this.readControl(labels.resolution, "resolution"); const outputs = Number(await this.readControl(labels.outputs, "outputs"));
      if (!Number.isInteger(durationSeconds) || !Number.isInteger(outputs)) throw new Error("numeric fields ambiguous");
      return { observed: { model, mode, aspectRatio, durationSeconds, resolution, outputs }, source: "page_visible", capturedAt: new Date().toISOString() };
    } catch (cause) { return { observed: null, source: "unknown", capturedAt: new Date().toISOString(), reason: cause instanceof Error ? cause.message : String(cause) }; }
  }
  async configure(request: VideoGenerationRequest): Promise<void> {
    await this.prepareEmptyProject(request.project.name, request.project.reuse === true);
    await this.choose(labels.mode, modeLabels[request.mode]); await this.choose(labels.model, request.model); await this.choose(labels.ratio, request.aspectRatio);
    await this.choose(labels.duration, `${request.durationSeconds}`); await this.choose(labels.resolution, request.resolution);
    await this.choose(labels.outputs, `${request.outputs}`); await this.fillPrompt(request.prompt); await this.upload(request);
  }
  /** Never clicks Generate. Core must persist the submission intent and call this once. */
  async clickGenerateOnce(): Promise<void> { await (await this.one(this.page.getByRole("button", { name: /^generate$/i }), "Generate button")).click(); }
  async assetRefs(): Promise<string[]> { return (await this.page.locator("[data-asset-id]").allTextContents?.()) ?? []; }
  /** Fixture-backed card contract. Unknown DOM is a safe failure, never "last card" selection. */
  async visibleAssets(): Promise<Array<{ ref: string; status: "generating" | "generated" | "failed" }>> {
    const cards = this.page.locator("[data-asset-id]"); const count = await cards.count();
    if (!cards.nth) throw new FlowBridgeError("PROVIDER_UNAVAILABLE", "Flow card list cannot be enumerated safely.");
    const found: Array<{ ref: string; status: "generating" | "generated" | "failed" }> = [];
    for (let index = 0; index < count; index++) {
      const card = cards.nth(index); const ref = await card.getAttribute?.("data-asset-id"); const raw = await card.getAttribute?.("data-asset-status");
      if (!ref || (raw !== "generating" && raw !== "generated" && raw !== "failed")) throw new FlowBridgeError("RESULT_AMBIGUOUS", "Flow asset cards lack stable visible reference/status evidence.");
      found.push({ ref, status: raw });
    }
    return found;
  }
  /** M0 uses a new empty project; a reused non-empty project is recovery-only and is never accepted by prepare. */
  private async prepareEmptyProject(name: string, reuse: boolean): Promise<void> {
    if (!reuse) {
      await (await this.one(this.page.getByRole("button", { name: /new project/i }), "New project button")).click();
      const input = await this.one(this.page.getByRole("textbox", { name: /project name/i }), "project name input");
      if (!input.fill) throw new FlowBridgeError("PROVIDER_UNAVAILABLE", "Project name input is not fillable."); await input.fill(name);
      await (await this.one(this.page.getByRole("button", { name: /create/i }), "Create project button")).click();
    }
    await this.verifyProject(name, true);
  }
  private async verifyProject(name: string, requireEmpty: boolean): Promise<string> {
    await this.one(this.page.getByRole("heading", { name: new RegExp(`^${escapeRegex(name)}$`, "i") }), "unique current project heading");
    const ref = this.page.url();
    if (!/^https?:|^data:/.test(ref)) throw new FlowBridgeError("PROVIDER_UNAVAILABLE", "Current Flow project does not expose a stable URL.");
    const assets = await this.page.locator("[data-asset-id]").count();
    if (requireEmpty && assets !== 0) throw new FlowBridgeError("UNSUPPORTED_COMBINATION", "M0 requires a new empty project before submission.", { assets });
    return ref;
  }
  private async choose(label: RegExp, option: string): Promise<void> {
    const control = await this.one(this.page.getByLabel(label), label.source);
    if (control.selectOption) { await control.selectOption(option); return; }
    await control.click();
    await (await this.one(this.page.getByRole("option", { name: new RegExp(`^${escapeRegex(option)}$`, "i") }), option)).click();
  }
  private async fillPrompt(prompt: string): Promise<void> { const box = await this.one(this.page.getByRole("textbox", { name: /prompt/i }), "prompt"); if (!box.fill) throw new FlowBridgeError("PROVIDER_UNAVAILABLE", "Prompt field is not fillable."); await box.fill(prompt); }
  private async upload(request: VideoGenerationRequest): Promise<void> {
    const files = [request.inputs?.firstFrame?.path, request.inputs?.lastFrame?.path, ...(request.inputs?.ingredients?.map(x => x.path) ?? [])].filter((x): x is string => Boolean(x));
    if (!files.length) return;
    const previewsBefore = await this.page.locator("[data-flowbridge-uploaded]").count();
    const input = await this.one(this.page.locator('input[type="file"]'), "file input"); if (!input.setInputFiles) throw new FlowBridgeError("PROVIDER_UNAVAILABLE", "Upload input is not usable."); await input.setInputFiles(files);
    const previewsAfter = await this.page.locator("[data-flowbridge-uploaded]").count();
    if (previewsAfter < previewsBefore + files.length) throw new FlowBridgeError("PROVIDER_UNAVAILABLE", "Upload completion/order cannot be verified from the visible Flow UI.", { expectedUploads: files.length, previewsBefore, previewsAfter });
  }
  private async readControl(label: RegExp, what: string): Promise<string> {
    const control = await this.one(this.page.getByLabel(label), what);
    const value = await control.inputValue?.();
    const text = value ?? await this.text(control);
    if (!text.trim()) throw new FlowBridgeError("UNSUPPORTED_COMBINATION", `Flow UI did not expose ${what} after configuration.`);
    return text.trim();
  }
  private async text(locator: Locator): Promise<string> { return (await locator.textContent?.()) ?? (await locator.allTextContents?.())?.join(" ") ?? ""; }
  private async fingerprint(): Promise<string> { return `ui:${(await this.page.getByRole("main").allTextContents?.())?.join(" ").slice(0, 512) ?? "unknown"}`; }
}
/**
 * Deliberately rejects a bare balance such as "812 credits remaining".  Only a
 * cost-labelled total can authorize a paid click; unknown is the safe result.
 */
export function parseVisibleCredits(text: string): number | null {
  const clean = text.replace(/,/g, "");
  const m = clean.match(/(?:total\s+)?(?:generation\s+)?(?:cost|price)\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*(?:AI |Flow )?credits?/i)
    ?? clean.match(/(\d+(?:\.\d+)?)\s*(?:AI |Flow )?credits?\s*(?:total\s+)?(?:cost|price)/i);
  return m ? Number(m[1]) : null;
}
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function parseMode(value: string): GenerationMode {
  const compact = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (compact === "text_to_video" || compact === "extend_video" || compact === "first_frame_to_video" || compact === "first_last_frames_to_video" || compact === "ingredients_to_video") return compact;
  throw new FlowBridgeError("UNSUPPORTED_COMBINATION", "Flow UI did not expose a recognized generation mode.", { visibleMode: value });
}
