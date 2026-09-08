import { FlowBridgeError, type ExistingBrowserObservation, type GenerationMode, type RuntimeSubmissionSnapshot } from "../../contracts/src/index.js";

/**
 * Boundary for a tab observed through Codex CUA.  It is intentionally data-only:
 * the CLI never obtains a Chrome process, DevTools endpoint, cookie, prompt, or
 * an automation handle.  The caller supplies one fresh UI observation.
 */
export const EXISTING_BROWSER_OBSERVATION_TTL_MS = 60_000;
export const EXISTING_BROWSER_OBSERVATION_MAX_FUTURE_MS = 5_000;

export interface ExistingBrowserTabBinding {
  browserId: string;
  tabId: string;
  url: string;
}

export interface ExistingBrowserObservationDriver {
  readonly binding: ExistingBrowserTabBinding;
  observe(): Promise<ExistingBrowserObservation>;
}

/**
 * Adapter seam for a CUA-only executor.  The injected callback is the sole
 * location that may hold a live CUA Tab object; this package receives only a
 * fresh plain object and can never close, navigate, or inspect Chrome itself.
 */
export class InjectedExistingTabDriver implements ExistingBrowserObservationDriver {
  constructor(readonly binding: ExistingBrowserTabBinding, private readonly readCurrentUi: () => Promise<unknown>) {}
  async observe(): Promise<ExistingBrowserObservation> {
    let raw: unknown;
    try { raw = await this.readCurrentUi(); }
    catch (cause) { throw new FlowBridgeError("PROVIDER_UNAVAILABLE", "EXISTING_SESSION_REQUIRED: current Codex Flow tab is unavailable.", { reason: "EXISTING_SESSION_REQUIRED", cause: String(cause) }); }
    const observation = parseExistingBrowserObservation(raw);
    if (observation.browserId !== this.binding.browserId || observation.tabId !== this.binding.tabId || observation.url !== this.binding.url) {
      throw new FlowBridgeError("PROVIDER_UNAVAILABLE", "EXISTING_SESSION_REQUIRED: observed tab no longer matches the bound current Flow tab.", { reason: "EXISTING_SESSION_REQUIRED", expected: this.binding, actual: { browserId: observation.browserId, tabId: observation.tabId, url: observation.url } });
    }
    return observation;
  }
}

/** Parse and sanitize the small, non-secret UI observation that may cross into core. */
export function parseExistingBrowserObservation(value: unknown): ExistingBrowserObservation {
  if (!isRecord(value)) fail("Existing browser observation must be an object.");
  rejectSensitiveFields(value);
  const browserId = text(value.browserId, "browserId");
  const tabId = text(value.tabId, "tabId");
  const page = flowPageUrl(text(value.url, "url"));
  const url = page.url;
  const observedAt = iso(value.observedAt, "observedAt");
  const projectRef = flowProjectUrl(text(value.projectRef, "projectRef"));
  if (page.projectRef !== projectRef) fail("Observation URL and projectRef must identify the same current Flow project.");
  const configuration = value.configuration === null ? null : parseConfiguration(record(value.configuration, "configuration"));
  const availableCredits = nullableCredits(value.availableCredits, "availableCredits");
  const totalCredits = nullableCredits(value.totalCredits, "totalCredits");
  const visibleAccountContext = nullableAccountContext(value.visibleAccountContext);
  const visibleAssetRefs = optionalRefs(value.visibleAssetRefs, "visibleAssetRefs");
  const selectedSourceAssetRef = value.selectedSourceAssetRef === null || value.selectedSourceAssetRef === undefined ? null : text(value.selectedSourceAssetRef,"selectedSourceAssetRef");
  return assertFreshExistingBrowserObservation({ browserId, tabId, url, observedAt, configuration, availableCredits, totalCredits, visibleAccountContext, projectRef, visibleAssetRefs, selectedSourceAssetRef });
}

/** Reject stale UI facts at every import boundary, including REST and direct core callers. */
export function assertFreshExistingBrowserObservation(observation: ExistingBrowserObservation, now = Date.now()): ExistingBrowserObservation {
  const observedMs = Date.parse(observation.observedAt);
  if (!Number.isFinite(observedMs) || now - observedMs > EXISTING_BROWSER_OBSERVATION_TTL_MS || observedMs - now > EXISTING_BROWSER_OBSERVATION_MAX_FUTURE_MS) {
    throw new FlowBridgeError("INVALID_REQUEST", "Existing-browser observation is stale or has an invalid future timestamp.");
  }
  return observation;
}

/** Converts an authenticated CUA observation to the exact core readback shape. */
export function hasStableAccountFingerprint(value: string | null): value is string { return value !== null && /^account-sha256:[a-f0-9]{64}$/.test(value); }

export function observationSnapshot(observation: ExistingBrowserObservation): RuntimeSubmissionSnapshot {
  if (!observation.configuration) throw new FlowBridgeError("UNSUPPORTED_COMBINATION", "A Generate ticket requires a complete current configuration observation.");
  return {
    configurationVerified: true,
    visibleAccountContext: observation.visibleAccountContext,
    projectRef: observation.projectRef,
    model: observation.configuration.model,
    mode: observation.configuration.mode,
    aspectRatio: observation.configuration.aspectRatio,
    durationSeconds: observation.configuration.durationSeconds,
    resolution: observation.configuration.resolution,
    outputs: observation.configuration.outputs,
    totalCredits: observation.totalCredits,
    availableCredits: observation.availableCredits,
    capturedAt: observation.observedAt,
    capabilityFingerprint: `cua:${observation.browserId}:${observation.tabId}:${observation.projectRef}`,
    selectedSourceAssetRef: observation.selectedSourceAssetRef ?? null,
    baselineAssetRefs: observation.visibleAssetRefs ?? [],
  };
}

function parseConfiguration(configuration:Record<string,unknown>){return {model:text(configuration.model,"configuration.model"),mode:generationMode(configuration.mode),aspectRatio:text(configuration.aspectRatio,"configuration.aspectRatio"),durationSeconds:whole(configuration.durationSeconds,"configuration.durationSeconds",1),resolution:text(configuration.resolution,"configuration.resolution"),outputs:whole(configuration.outputs,"configuration.outputs",1)};}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function record(value: unknown, name: string): Record<string, unknown> { if (!isRecord(value)) fail(`${name} must be an object.`); return value; }
function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) fail(`${name} must be a non-empty string.`); return value.trim(); }
function iso(value: unknown, name: string): string { const out = text(value, name); if (Number.isNaN(Date.parse(out))) fail(`${name} must be an ISO timestamp.`); return out; }
function whole(value: unknown, name: string, min: number): number { if (typeof value !== "number" || !Number.isInteger(value) || value < min) fail(`${name} must be an integer >= ${min}.`); return value; }
function nullableCredits(value: unknown, name: string): number | null { if (value === null) return null; if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(`${name} must be a non-negative finite number or null.`); return value; }
function generationMode(value: unknown): GenerationMode { const out = text(value, "configuration.mode"); if (out === "text_to_video" || out === "extend_video" || out === "first_frame_to_video" || out === "first_last_frames_to_video" || out === "ingredients_to_video") return out; fail("configuration.mode is not a supported Flow generation mode."); }
function optionalRefs(value:unknown,name:string):string[]|undefined {if(value===undefined)return undefined;if(!Array.isArray(value))fail(`${name} must be an array.`);const refs=value.map((v,i)=>text(v,`${name}[${i}]`));if(new Set(refs).size!==refs.length)fail(`${name} must not contain duplicates.`);return refs;}
function flowProjectUrl(value: string): string {const parsed=flowPageUrl(value);if(parsed.url!==parsed.projectRef)fail("projectRef must be one canonical https://flow.google.com/project/<id> URL.");return parsed.projectRef;}
function flowPageUrl(value:string):{url:string;projectRef:string}{let url:URL;try{url=new URL(value);}catch{fail("Observation must contain a valid Flow project URL.");}if(url.origin!=="https://flow.google.com"||url.username||url.password||url.search||url.hash)fail("Observation must bind to the official canonical Flow origin without credentials, query, or hash.");const match=url.pathname.match(/^\/project\/([A-Za-z0-9_-]+)(?:\/edit\/([A-Za-z0-9_-]+))?\/?$/);if(!match)fail("Observation URL must be /project/<id> or /project/<id>/edit/<scene-id>.");const projectRef=`https://flow.google.com/project/${match[1]}`;const normalized=match[2]?`${projectRef}/edit/${match[2]}`:projectRef;return {url:normalized,projectRef};}
function nullableAccountContext(value: unknown): string | null { if (value === null || value === undefined) return null; const out = text(value, "visibleAccountContext"); if (/@|\b[\w.+-]+@[\w.-]+\b/.test(out)) fail("visibleAccountContext must be a non-PII plan label, never an email address."); if (out.length > 80) fail("visibleAccountContext is too long for a non-PII plan label."); return out; }
function rejectSensitiveFields(value: Record<string, unknown>): void { for (const key of ["prompt", "email", "cookies", "cookie", "token", "password", "authorization"]) if (key in value) fail(`Existing browser observation must not include ${key}.`); }
function fail(message: string): never { throw new FlowBridgeError("INVALID_REQUEST", message); }
