import { FLOW_CREDIT_HARD_CAP, LEGACY_FLOW_CREDIT_HARD_CAP, FlowBridgeError, createModelPolicy, type ProviderModelFamily, type RuntimeSubmissionSnapshot, type VideoGenerationRequest } from "../../contracts/src/index.js";

export function assertCostPolicy(request: VideoGenerationRequest, snapshot: RuntimeSubmissionSnapshot): void {
  const ceiling=request.costPolicy.maxCredits;
  if (![LEGACY_FLOW_CREDIT_HARD_CAP,FLOW_CREDIT_HARD_CAP].includes(ceiling as 50|200) || request.costPolicy.confirmAbove !== ceiling || !request.costPolicy.rejectWhenUnknown) {
    throw new FlowBridgeError("INVALID_REQUEST", `Flow UI policy must use an immutable ${FLOW_CREDIT_HARD_CAP}-Credit current ceiling or a preserved ${LEGACY_FLOW_CREDIT_HARD_CAP}-Credit legacy ceiling`);
  }
  if (!request.authorizationContext.explicitlyRequestedGeneration) {
    throw new FlowBridgeError("INVALID_REQUEST", "Generation must be explicitly requested in the current conversation");
  }
  if (snapshot.totalCredits === null) throw new FlowBridgeError("COST_UNKNOWN", "Visible whole-job cost is unknown; submission is blocked");
  if (!Number.isInteger(snapshot.totalCredits) || snapshot.totalCredits < 0) throw new FlowBridgeError("COST_UNKNOWN", "Visible whole-job cost is invalid");
  if (snapshot.availableCredits !== null && snapshot.availableCredits < snapshot.totalCredits) {
    throw new FlowBridgeError("INSUFFICIENT_CREDITS", "Visible account balance is below the whole-job cost; submission is blocked", { availableCredits: snapshot.availableCredits, totalCredits: snapshot.totalCredits });
  }
  if (snapshot.totalCredits > ceiling) {
    throw new FlowBridgeError("COST_LIMIT_EXCEEDED", `Whole-job cost ${snapshot.totalCredits} exceeds the authorized ${ceiling} Credits ceiling`, { totalCredits: snapshot.totalCredits, authorizedCeiling:ceiling });
  }
}

export function providerFamilyFromVisibleModel(label:string,value:string):ProviderModelFamily {
  const visible=`${label} ${value}`;
  if(/\bomni\b/i.test(visible)&&/1[._ ]1/.test(visible))return "gemini_omni_flash_1_1";
  if(/\bveo\b/i.test(visible)||/^veo[-_]/i.test(value))return "veo";
  return "unknown";
}

export function assertModelPolicy(request:VideoGenerationRequest,snapshot:RuntimeSubmissionSnapshot):void {
  if(request.provider!=="flow_ui")return;
  const policy=request.modelPolicy??createModelPolicy(request.model,"explicit");
  if(policy.version!==1||policy.executionBackend!=="flow_ui"||policy.allowFallback!==false)throw new FlowBridgeError("INVALID_REQUEST","Flow UI model policy must be version 1 with fallback disabled");
  if(request.mode==="extend_video"&&policy.requiredFamily==="gemini_omni_flash_1_1")throw new FlowBridgeError("UNSUPPORTED_COMBINATION","Omni Extend is unavailable until the current Flow UI visibly exposes and verifies it");
  if(request.mode==="edit_video"&&policy.requiredFamily!=="gemini_omni_flash_1_1")throw new FlowBridgeError("UNSUPPORTED_COMBINATION","Flow UI video editing requires an observed Gemini Omni Flash 1.1 option in this release");
  const option=snapshot.modelOption;
  if(!option?.label||!option.value)throw new FlowBridgeError("UNSUPPORTED_COMBINATION","Current Flow UI model label/value evidence is unknown; refusing model selection");
  const family=providerFamilyFromVisibleModel(option.label,option.value);
  if(family==="unknown"||family!==policy.requiredFamily||snapshot.observedProviderFamily!==family)throw new FlowBridgeError("UNSUPPORTED_COMBINATION","Visible Flow UI model does not match the immutable no-fallback model policy",{requiredFamily:policy.requiredFamily,observedFamily:family,label:option.label,value:option.value});
  const capture=snapshot.capabilityCapture;
  if(!capture||!/^sha256:[a-f0-9]{64}$/.test(capture.hash)||Math.abs(Date.parse(snapshot.capturedAt)-Date.parse(capture.capturedAt))>60_000)throw new FlowBridgeError("UNSUPPORTED_COMBINATION","Flow UI capability capture is missing, invalid, or stale");
}

export function assertSnapshotMatches(request: VideoGenerationRequest, snapshot: RuntimeSubmissionSnapshot): void {
  if (!snapshot.configurationVerified) throw new FlowBridgeError("UNSUPPORTED_COMBINATION", "Runtime configuration was not independently read back from the provider UI");
  const expected = [request.mode, request.durationSeconds, request.aspectRatio, request.resolution, request.outputs];
  const actual = [snapshot.mode, snapshot.durationSeconds, snapshot.aspectRatio, snapshot.resolution, snapshot.outputs];
  if (expected.some((value, index) => value !== actual[index])) {
    throw new FlowBridgeError("UNSUPPORTED_COMBINATION", "Runtime configuration differs from the immutable request", { expected, actual });
  }
  if (request.mode === "extend_video" && (!request.sourceAssetRef || snapshot.selectedSourceAssetRef !== request.sourceAssetRef)) {
    throw new FlowBridgeError("UNSUPPORTED_COMBINATION", "Extend source card differs from the immutable parent asset reference", { expected: request.sourceAssetRef, actual: snapshot.selectedSourceAssetRef ?? null });
  }
  assertModelPolicy(request,snapshot);
}
