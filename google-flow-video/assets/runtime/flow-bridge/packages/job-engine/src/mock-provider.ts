import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { FlowBridgeError, type FlowProvider, type PreparedSubmission, type ProviderAsset, type ProviderContext, type RuntimeSubmissionSnapshot, type VideoGenerationRequest } from "../../contracts/src/index.js";
import { DownloadManager, type DownloadProvenance } from "../../download-manager/src/index.js";

/** Deterministic fixture provider. Production callers must opt in explicitly. */
export class MockProvider implements FlowProvider {
  readonly kind = "mock" as const;
  submitCount = 0;
  constructor(private totalCredits: number | null = 4, private options: {availableCredits?:number|null;submitReadbackCredits?:number|null;submitReadbackAvailableCredits?:number|null;effectLog?:string;crashPoint?:"intent_committed_before_submit"|"after_mock_submit_effect";sourceMedia?:string} = {}) {}
  async prepare(request: VideoGenerationRequest): Promise<PreparedSubmission> {
    const snapshot: RuntimeSubmissionSnapshot = {configurationVerified:true,visibleAccountContext:"mock-account",projectRef:request.project.name,model:request.model,mode:request.mode,durationSeconds:request.durationSeconds,aspectRatio:request.aspectRatio,resolution:request.resolution,outputs:request.outputs,totalCredits:this.totalCredits,availableCredits:this.options.availableCredits??null,capturedAt:new Date().toISOString(),capabilityFingerprint:"mock-explicit-v1"};
    return {snapshot,handle:"mock-explicit-handle"};
  }
  async submitPrepared(_request:VideoGenerationRequest,prepared:PreparedSubmission,context:ProviderContext){
    if(this.options.crashPoint==="intent_committed_before_submit")process.exit(85);
    const readback=this.options.submitReadbackCredits??prepared.snapshot.totalCredits;
    if(readback===null)throw new FlowBridgeError("COST_UNKNOWN","Mock final readback cost is unknown");
    const finalBalance=this.options.submitReadbackAvailableCredits??prepared.snapshot.availableCredits;
    if(finalBalance!==null&&finalBalance<readback)throw new FlowBridgeError("INSUFFICIENT_CREDITS","Mock visible balance is below whole-job cost",{availableCredits:finalBalance,totalCredits:readback});
    if(readback>50)throw new FlowBridgeError("COST_LIMIT_EXCEEDED","Mock final readback exceeds whole-job cap",{totalCredits:readback});
    this.submitCount++;
    if(this.options.effectLog){const fd=openSync(this.options.effectLog,"a",0o600);try{writeSync(fd,`${JSON.stringify({jobId:context.jobId,attemptId:context.attemptId})}\n`);fsyncSync(fd);}finally{closeSync(fd);}}
    if(this.options.crashPoint==="after_mock_submit_effect")process.exit(86);
    return {evidence:{mock:true,submitCount:this.submitCount}};
  }
  async reconcile(r:VideoGenerationRequest,c:ProviderContext){if(!this.options.sourceMedia)return {assets:[] as ProviderAsset[],complete:false};return {complete:true,assets:[{providerAssetRef:`mock-${c.jobId}`,status:"generated" as const,metadata:{sourcePath:this.options.sourceMedia,provenance:{jobId:c.jobId,projectName:r.project.name,projectUrl:`mock://${r.project.name}`,modelRequested:r.model,modelActual:r.model,aspectRatio:r.aspectRatio,durationSeconds:r.durationSeconds,resolution:r.resolution,promptSha256:"mock-final-prompt",targetMatchEvidence:{provider_card_ref:`mock-${c.jobId}`},inputAssets:[]}}}]};}
  async download(asset:ProviderAsset,directory:string){const metadata=asset.metadata as {sourcePath?:string;provenance?:DownloadProvenance}|undefined;if(!metadata?.sourcePath||!metadata.provenance)throw new FlowBridgeError("DOWNLOAD_FAILED","Mock asset has no real staged media");return (await new DownloadManager().persist(metadata.sourcePath,directory,metadata.provenance)).asset;}
}

