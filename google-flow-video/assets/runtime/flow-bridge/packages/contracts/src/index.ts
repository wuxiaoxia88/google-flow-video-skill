export const FLOW_CREDIT_HARD_CAP = 200 as const;
export const LEGACY_FLOW_CREDIT_HARD_CAP = 50 as const;
import type { ModelPolicy,ProviderModelFamily } from "./model-policy.js";
export { MODEL_POLICY_VERSION,DEFAULT_MODEL_POLICY,createModelPolicy,type ModelPolicy,type ProviderModelFamily } from "./model-policy.js";

export type ProviderKind = "flow_ui" | "mock";
export type GenerationMode =
  | "text_to_video"
  | "extend_video"
  | "first_frame_to_video"
  | "first_last_frames_to_video"
  | "ingredients_to_video"
  | "edit_video";

export type JobState =
  | "CREATED" | "VALIDATING" | "AWAITING_CLARIFICATION" | "QUEUED"
  | "STARTING_BROWSER" | "AUTH_REQUIRED" | "CONFIGURING" | "READY_TO_SUBMIT"
  | "SUBMITTING" | "GENERATING" | "SUBMISSION_UNCERTAIN" | "GENERATED"
  | "RESULT_AMBIGUOUS" | "DOWNLOADING" | "DOWNLOAD_FAILED" | "COMPLETED"
  | "PARTIALLY_COMPLETED" | "PAUSED_FOR_HUMAN" | "FAILED"
  | "CANCELLED_PRE_SUBMIT" | "LOCAL_WAIT_CANCELLED_PROVIDER_CONTINUES";

export type ErrorCode =
  | "AUTH_REQUIRED" | "COST_LIMIT_EXCEEDED" | "COST_UNKNOWN" | "INSUFFICIENT_CREDITS"
  | "IDEMPOTENCY_CONFLICT" | "SUBMISSION_UNCERTAIN" | "RESULT_AMBIGUOUS"
  | "INVALID_REQUEST" | "UNSUPPORTED_COMBINATION" | "DOWNLOAD_FAILED"
  | "STALE_FENCING_TOKEN" | "PROVIDER_UNAVAILABLE" | "PROVIDER_FAILURE";

export interface InputAsset {
  path: string;
  name?: string;
  contentSha256?: string;
  sizeBytes?: number;
}

export interface VideoGenerationRequest {
  provider: ProviderKind;
  idempotencyKey: string;
  project: { name: string; reuse?: boolean };
  mode: GenerationMode;
  prompt: string;
  promptMode: "verbatim" | "enhance";
  model: string;
  modelPolicy?: ModelPolicy;
  aspectRatio: "16:9" | "9:16";
  durationSeconds: number;
  resolution: string;
  outputs: number;
  inputs?: { firstFrame?: InputAsset; lastFrame?: InputAsset; ingredients?: InputAsset[]; sourceVideo?: InputAsset };
  download?: { enabled: boolean; directory?: string; format?: "mp4" };
  costPolicy: { maxCredits: number; confirmAbove: number; rejectWhenUnknown: true };
  authorizationContext: { source: "current_conversation"; explicitlyRequestedGeneration: boolean };
  budgetContext?: { ledgerId: string; stepKey: string };
  sourceParentJobId?: string;
  sourceAssetRef?: string;
}

export interface RuntimeSubmissionSnapshot {
  configurationVerified: boolean;
  visibleAccountContext: string | null;
  projectRef: string;
  model: string;
  modelOption?: { label: string; value: string } | null;
  observedProviderFamily?: ProviderModelFamily;
  capabilityCapture?: { hash: string; capturedAt: string; locale: string | null; source: "page_visible" | "executor_observation" } | null;
  finalProviderModelReadback?: { family: ProviderModelFamily; label: string | null; value: string | null; source: "result_card" | "result_detail" | "unknown" };
  mode: GenerationMode;
  durationSeconds: number;
  aspectRatio: string;
  resolution: string;
  outputs: number;
  totalCredits: number | null;
  /** Independently read visible account balance; null means not reliably visible. */
  availableCredits: number | null;
  capturedAt: string;
  capabilityFingerprint: string;
  /** Visible source card selected for Extend; required to match sourceAssetRef for extend_video. */
  selectedSourceAssetRef?: string | null;
  /** Sanitized card refs visible before execution, used as the immutable attribution baseline. */
  baselineAssetRefs?: string[];
}

export interface ProviderAsset {
  providerAssetRef: string;
  status: "generating" | "generated" | "failed";
  localPath?: string;
  sha256?: string;
  metadata?: Record<string, unknown>;
}

export interface ProviderContext {
  jobId: string;
  attemptId: string;
  fencingToken: string;
  requestHash: string;
  projectRef?: string;
  intentRecordedAt?: string;
  submissionEvidence?: Record<string, unknown>;
}
export interface PreparedSubmission { snapshot: RuntimeSubmissionSnapshot; handle: string }

/** Sanitized observation supplied by the Codex CUA executor; never contains prompt, email, cookies, or tokens. */
export interface ExistingBrowserObservation {
  browserId: string; tabId: string; url: string; observedAt: string;
  configuration: { model: string; modelOption?: { label: string; value: string } | null; mode: GenerationMode; aspectRatio: string; durationSeconds: number; resolution: string; outputs: number } | null;
  capabilityCapture?: { hash: string; capturedAt: string; locale: string | null; modelOptions: Array<{ label: string; value: string }> } | null;
  availableCredits: number | null; totalCredits: number | null;
  visibleAccountContext: string | null; projectRef: string;
  visibleAssetRefs?: string[];
  selectedSourceAssetRef?: string | null;
}
export interface BrowserExecutionTicket {
  ticketId: string; action: "GENERATE" | "RECONCILE"; status: "ISSUED" | "CLAIMED" | "RECEIPTED" | "EXPIRED";
  jobId: string; attemptId: string; requestHash: string; browserId: string; tabId: string; projectRef: string;
  expectedSnapshot: RuntimeSubmissionSnapshot; issuedAt: string;
  baselineAssetRefs?: string[];
}

export interface ExistingBrowserCompletionEvidence {
  projectRef: string;
  completedAt: string;
  beforeAssetRefs: string[];
  actual: { model: string; modelOption?: { label: string; value: string } | null; providerModelReadback?: { family: ProviderModelFamily; label: string | null; value: string | null; source: "result_card" | "result_detail" | "unknown" }; mode: GenerationMode; aspectRatio: string; durationSeconds: number; resolution: string; outputs: number; selectedSourceAssetRef?: string | null; outputKind?: "continuation" | "cumulative"; actualDurationSeconds?: number };
  assets: Array<{ providerAssetRef: string; status: "generated"; observedAt: string; downloadUrl?: string; outputKind?: "continuation" | "cumulative"; actualDurationSeconds?: number }>;
}
export interface ExistingBrowserDownloadEvidence { jobId:string; providerAssetRef:string; projectRef:string; downloadedAt:string; sourceSha256:string; }
export interface ExistingBrowserFailureEvidence { projectRef:string; observedAt:string; providerStatus:"failed"; providerMessage:string; beforeAssetRefs:string[]; currentAssetRefs:string[]; charged:"not_charged"; balanceBefore?:number; balanceAfter?:number; sourceEvidencePath:string; sourceEvidenceSha256:string; }
export interface LegacyBaselineAttestationEvidence { recordType?:"pre_submit_observation"|"contemporaneous_tool_log"; requestHash:string; projectRef:string; browserId:string; tabId:string; capturedAt:string; sourceObservationPath:string; sourceObservationSha256:string; baselineAssetRefs:string[]; reason:"legacy_mapping_defect"; sourceThreadId?:string; sourceItemId?:string; sourceRolloutOrdinal?:number; sourceLine?:number; approveItemId?:string; approveAt?:string; }

export interface FlowProvider {
  readonly kind: ProviderKind;
  prepare(request: VideoGenerationRequest): Promise<PreparedSubmission>;
  discardPrepared?(prepared: PreparedSubmission): Promise<void>;
  submitPrepared(request: VideoGenerationRequest, prepared: PreparedSubmission, context: ProviderContext): Promise<{ evidence: Record<string, unknown> }>;
  reconcile(request: VideoGenerationRequest, context: ProviderContext): Promise<{ assets: ProviderAsset[]; complete: boolean }>;
  download(asset: ProviderAsset, directory: string): Promise<ProviderAsset>;
}

export interface JobRecord {
  id: string;
  provider: ProviderKind;
  idempotencyKey: string;
  requestHash: string;
  finalPromptSha256: string;
  state: JobState;
  runtimeSnapshot: RuntimeSubmissionSnapshot | null;
  errorCode: ErrorCode | null;
  createdAt: string;
  updatedAt: string;
  assets?: ProviderAsset[];
}

export type BudgetStepState = "RESERVED" | "CONSUMED" | "NOT_CHARGED";
export interface BudgetLedger {
  parentId: string;
  capCredits: number;
  reservedCredits: number;
  consumedCredits: number;
  createdAt: string;
}
export interface BudgetStep {
  parentId: string;
  stepKey: string;
  quotedCredits: number;
  state: BudgetStepState;
  createdAt: string;
}

export type JobEventType = "STATE_CHANGED" | "SUBMISSION_INTENT_RECORDED" | "PROVIDER_EVIDENCE" | "RECOVERY_BLOCKED_RESUBMIT" | "BASELINE_ATTESTED" | "PROVIDER_FAILURE_CONFIRMED" | "CONTROLLED_RETRY_INTENT_RECORDED" | "USER_RESUME_AUTHORIZED_UNRESOLVED" | "UNCLAIMED_TICKET_RENEWED";
export interface JobEvent { jobId: string; state: JobState; eventType: JobEventType; payload: Record<string, unknown>; createdAt: string }

export class FlowBridgeError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}
export { videoRequestSchema } from "./schema.js";
export { externalVideoRequestSchema, normalizeExternalRequest } from "./external.js";
