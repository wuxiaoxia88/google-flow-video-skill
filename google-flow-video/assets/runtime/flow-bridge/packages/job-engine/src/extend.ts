import { FlowBridgeError, type VideoGenerationRequest } from "../../contracts/src/index.js";
import { Storage } from "../../storage/src/index.js";

const reliableSourceStates = new Set(["GENERATED","DOWNLOADING","DOWNLOAD_FAILED","COMPLETED"]);

/** Fail-closed binding from an Extend request to one durable parent asset and shared budget ledger. */
export function assertExtendSource(storage:Storage, jobId:string, request:VideoGenerationRequest):void {
  const linked=request.sourceParentJobId!==undefined||request.sourceAssetRef!==undefined;
  if(request.mode!=="extend_video"&&!linked)return;
  if(!request.sourceParentJobId||!request.sourceAssetRef||!request.budgetContext)throw new FlowBridgeError("INVALID_REQUEST","Continuation requires an immutable parent job, source asset and shared budget ledger");
  if(request.mode==="first_frame_to_video"&&!request.inputs?.firstFrame?.contentSha256)throw new FlowBridgeError("INVALID_REQUEST","Linked first-frame continuation requires a frozen first-frame asset hash");
  if(request.sourceParentJobId===jobId)throw new FlowBridgeError("INVALID_REQUEST","Extend cannot use its own job as the source");
  const parent=storage.getJob(request.sourceParentJobId);
  if(!parent||!reliableSourceStates.has(parent.state))throw new FlowBridgeError("INVALID_REQUEST","Extend parent has no reliably generated source asset",{parentState:parent?.state??null});
  const assets=storage.getAssets(parent.id);
  if(assets.length!==1||assets[0]?.providerAssetRef!==request.sourceAssetRef||assets[0]?.status!=="generated")throw new FlowBridgeError("RESULT_AMBIGUOUS","Extend source must be the parent's unique generated asset",{expected:request.sourceAssetRef,actual:assets.map(a=>a.providerAssetRef)});
  const parentRequest=JSON.parse(storage.getRequestJson(parent.id)) as VideoGenerationRequest;
  if(parentRequest.project.name!==request.project.name||parentRequest.model!==request.model)throw new FlowBridgeError("UNSUPPORTED_COMBINATION","Extend must retain the parent project and model",{parentProject:parentRequest.project.name,parentModel:parentRequest.model});
  if(!parentRequest.budgetContext||parentRequest.budgetContext.ledgerId!==request.budgetContext.ledgerId)throw new FlowBridgeError("COST_LIMIT_EXCEEDED","Extend parent and child must share one 50-credit budget ledger");
  const parentStep=storage.getBudgetStep(parentRequest.budgetContext.ledgerId,parentRequest.budgetContext.stepKey);
  if(!parentStep)throw new FlowBridgeError("COST_LIMIT_EXCEEDED","Extend parent budget reservation is missing");
}
