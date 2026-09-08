import { FLOW_CREDIT_HARD_CAP, FlowBridgeError, type RuntimeSubmissionSnapshot, type VideoGenerationRequest } from "../../contracts/src/index.js";

export function assertCostPolicy(request: VideoGenerationRequest, snapshot: RuntimeSubmissionSnapshot): void {
  if (request.costPolicy.maxCredits !== FLOW_CREDIT_HARD_CAP || request.costPolicy.confirmAbove !== FLOW_CREDIT_HARD_CAP || !request.costPolicy.rejectWhenUnknown) {
    throw new FlowBridgeError("INVALID_REQUEST", "Flow UI policy must be fixed at a 50 Credits hard cap");
  }
  if (!request.authorizationContext.explicitlyRequestedGeneration) {
    throw new FlowBridgeError("INVALID_REQUEST", "Generation must be explicitly requested in the current conversation");
  }
  if (snapshot.totalCredits === null) throw new FlowBridgeError("COST_UNKNOWN", "Visible whole-job cost is unknown; submission is blocked");
  if (!Number.isInteger(snapshot.totalCredits) || snapshot.totalCredits < 0) throw new FlowBridgeError("COST_UNKNOWN", "Visible whole-job cost is invalid");
  if (snapshot.availableCredits !== null && snapshot.availableCredits < snapshot.totalCredits) {
    throw new FlowBridgeError("INSUFFICIENT_CREDITS", "Visible account balance is below the whole-job cost; submission is blocked", { availableCredits: snapshot.availableCredits, totalCredits: snapshot.totalCredits });
  }
  if (snapshot.totalCredits  > FLOW_CREDIT_HARD_CAP) {
    throw new FlowBridgeError("COST_LIMIT_EXCEEDED", `Whole-job cost ${snapshot.totalCredits} exceeds 50 Credits`, { totalCredits: snapshot.totalCredits });
  }
}

export function assertSnapshotMatches(request: VideoGenerationRequest, snapshot: RuntimeSubmissionSnapshot): void {
  if (!snapshot.configurationVerified) throw new FlowBridgeError("UNSUPPORTED_COMBINATION", "Runtime configuration was not independently read back from the provider UI");
  const expected = [request.model, request.mode, request.durationSeconds, request.aspectRatio, request.resolution, request.outputs];
  const actual = [snapshot.model, snapshot.mode, snapshot.durationSeconds, snapshot.aspectRatio, snapshot.resolution, snapshot.outputs];
  if (expected.some((value, index) => value !== actual[index])) {
    throw new FlowBridgeError("UNSUPPORTED_COMBINATION", "Runtime configuration differs from the immutable request", { expected, actual });
  }
  if (request.mode === "extend_video" && (!request.sourceAssetRef || snapshot.selectedSourceAssetRef !== request.sourceAssetRef)) {
    throw new FlowBridgeError("UNSUPPORTED_COMBINATION", "Extend source card differs from the immutable parent asset reference", { expected: request.sourceAssetRef, actual: snapshot.selectedSourceAssetRef ?? null });
  }
}
