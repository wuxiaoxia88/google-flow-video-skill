import { FlowBridgeError, videoRequestSchema, type BrowserExecutionTicket, type ExistingBrowserCompletionEvidence, type ExistingBrowserDownloadEvidence, type ExistingBrowserFailureEvidence, type ExistingBrowserObservation, type FlowProvider, type JobRecord, type LegacyBaselineAttestationEvidence, type ProviderAsset, type RuntimeSubmissionSnapshot, type VideoGenerationRequest } from "../../contracts/src/index.js";
import { readFile } from "node:fs/promises";
import { assertCostPolicy, assertSnapshotMatches } from "../../policy-engine/src/index.js";
import { Storage } from "../../storage/src/index.js";
import { assertFreshExistingBrowserObservation, hasStableAccountFingerprint, observationSnapshot as snapshotFromObservation } from "../../flow-adapter/src/index.js";
import { DownloadManager } from "../../download-manager/src/index.js";
import { freezeRequest, sha256, stableStringify } from "./hash.js";
import { assertExtendSource } from "./extend.js";

export class JobEngine {
  constructor(private storage: Storage, private providers: Map<string,FlowProvider>) {}
  async create(input: unknown): Promise<JobRecord> {
    const parsed = videoRequestSchema.safeParse(input);
    if (!parsed.success) throw new FlowBridgeError("INVALID_REQUEST", parsed.error.message);
    const frozen = await freezeRequest(parsed.data as VideoGenerationRequest);
    const found = this.storage.createOrGet({provider:frozen.request.provider,idempotencyKey:frozen.request.idempotencyKey,requestHash:frozen.requestHash,requestJson:stableStringify(frozen.request),finalPromptSha256:frozen.finalPromptSha256});
    if (!found.created) {
      if (found.job.requestHash !== frozen.requestHash) throw new FlowBridgeError("IDEMPOTENCY_CONFLICT", "Idempotency key is already bound to a different immutable request");
      return found.job;
    }
    this.storage.transition(found.job.id,"VALIDATING");
    return this.storage.getJob(found.job.id)!;
  }
  async run(jobId: string): Promise<JobRecord> {
    const job=this.requireJob(jobId), request=JSON.parse(this.storage.getRequestJson(jobId)) as VideoGenerationRequest;
    if (["COMPLETED","PARTIALLY_COMPLETED","FAILED","CANCELLED_PRE_SUBMIT","LOCAL_WAIT_CANCELLED_PROVIDER_CONTINUES"].includes(job.state)) return job;
    if(job.state==="GENERATED")return job;
    if(job.state==="DOWNLOAD_FAILED"||job.state==="DOWNLOADING")return await this.download(jobId);
    const provider=this.providers.get(job.provider);
    if (!provider) throw new FlowBridgeError("PROVIDER_UNAVAILABLE",`Provider ${job.provider} is not configured`);
    const prior=this.storage.getIntent(jobId);
    if (prior) {
      const wasGenerating=job.state==="GENERATING";
      if(!wasGenerating)this.storage.transition(jobId,"SUBMISSION_UNCERTAIN","SUBMISSION_UNCERTAIN");
      const result=await provider.reconcile(request,contextFromIntent(jobId,job.requestHash,prior));
      if(result.complete)this.storage.saveAssets(jobId,result.assets);
      this.storage.transition(jobId,result.complete ? "GENERATED" : wasGenerating ? "GENERATING" : "SUBMISSION_UNCERTAIN", result.complete||wasGenerating ? null : "SUBMISSION_UNCERTAIN");
      return this.requireJob(jobId);
    }
    const prepared=await provider.prepare(request), snapshot=prepared.snapshot;
    try { assertSnapshotMatches(request,snapshot); assertCostPolicy(request,snapshot); }
    catch(error) { await provider.discardPrepared?.(prepared); throw error; }
    this.storage.transition(jobId,"READY_TO_SUBMIT");
    const intent=this.storage.recordIntent(jobId,job.requestHash,snapshot);
    if (intent.existed) { await provider.discardPrepared?.(prepared); throw new FlowBridgeError("SUBMISSION_UNCERTAIN","Existing intent blocks another Generate"); }
    try {
      const submitted=await provider.submitPrepared(request,prepared,{jobId,attemptId:intent.attemptId,fencingToken:intent.fencingToken,requestHash:job.requestHash});
      this.storage.recordEvidence(jobId,intent.fencingToken,submitted.evidence);
      this.storage.transition(jobId,"GENERATING");
    } catch (error) {
      this.storage.transition(jobId,"SUBMISSION_UNCERTAIN","SUBMISSION_UNCERTAIN");
      throw error;
    }
    return this.requireJob(jobId);
  }
  prepareExistingBrowser(jobId:string,observation:ExistingBrowserObservation):BrowserExecutionTicket {
    const job=this.requireJob(jobId),request=JSON.parse(this.storage.getRequestJson(jobId)) as VideoGenerationRequest;
    assertFreshExistingBrowserObservation(observation);
    if(["COMPLETED","PARTIALLY_COMPLETED","FAILED","CANCELLED_PRE_SUBMIT","LOCAL_WAIT_CANCELLED_PROVIDER_CONTINUES"].includes(job.state)) throw new FlowBridgeError("INVALID_REQUEST", "Cancelled or terminal jobs cannot receive an existing-browser ticket.", { state: job.state });
    if(job.provider!=="flow_ui")throw new FlowBridgeError("INVALID_REQUEST","Existing-browser execution is only valid for flow_ui jobs");
    assertExtendSource(this.storage,jobId,request);
    const prior=this.storage.getIntent(jobId);
    const snapshot=observation.configuration?observationSnapshot(observation):prior?reconcileSnapshot(observation,JSON.parse(prior.snapshot_json) as RuntimeSubmissionSnapshot):observationSnapshot(observation);
    if(!hasStableAccountFingerprint(snapshot.visibleAccountContext)) throw new FlowBridgeError("UNSUPPORTED_COMBINATION", "Generate tickets require a current non-PII stable account fingerprint.");
    if(!prior){assertSnapshotMatches(request,snapshot);assertCostPolicy(request,snapshot);}
    else if(request.mode==="extend_video"&&snapshot.selectedSourceAssetRef!==request.sourceAssetRef)throw new FlowBridgeError("UNSUPPORTED_COMBINATION","Extend recovery observation no longer has the immutable source asset selected");
    if (!prior && request.budgetContext && snapshot.totalCredits === null) throw new FlowBridgeError("COST_UNKNOWN", "Budgeted steps require a known current quote.");
    try {
      const intent=this.storage.reserveExistingBrowserIntent({jobId,requestHash:job.requestHash,snapshot,browserId:observation.browserId,tabId:observation.tabId,projectRef:observation.projectRef,budget:!prior&&request.budgetContext?{ledgerId:request.budgetContext.ledgerId,stepKey:request.budgetContext.stepKey,quotedCredits:snapshot.totalCredits!,capCredits:request.costPolicy.maxCredits}:undefined});
      const originalSnapshot=prior?JSON.parse(prior.snapshot_json) as RuntimeSubmissionSnapshot:snapshot;
      const ticketSnapshot={...snapshot,baselineAssetRefs:prior?originalSnapshot.baselineAssetRefs:snapshot.baselineAssetRefs};
      return this.storage.issueBrowserTicket({action:intent.existed?"RECONCILE":"GENERATE",jobId,attemptId:intent.attemptId,requestHash:job.requestHash,browserId:observation.browserId,tabId:observation.tabId,projectRef:observation.projectRef,expectedSnapshot:ticketSnapshot});
    } catch (error) { if (error instanceof FlowBridgeError) throw error; throw new FlowBridgeError("COST_LIMIT_EXCEEDED", "Parent budget reservation rejected; no Generate ticket issued.", { cause: String(error) }); }
  }
  prepareControlledRetry(jobId:string,observation:ExistingBrowserObservation):BrowserExecutionTicket{
    const job=this.requireJob(jobId),request=JSON.parse(this.storage.getRequestJson(jobId)) as VideoGenerationRequest,latest=this.storage.getLatestAttempt(jobId);
    if(job.state!=="FAILED"||!latest||latest.attempt_status!=="FAILED"||latest.ordinal!==1||this.storage.getAssets(jobId).length)throw new FlowBridgeError("INVALID_REQUEST","Controlled retry requires exactly one confirmed failed, output-free attempt");
    if(!request.budgetContext)throw new FlowBridgeError("INVALID_REQUEST","Controlled retry requires a parent budget ledger");
    assertFreshExistingBrowserObservation(observation);const snapshot=observationSnapshot(observation);
    if(!hasStableAccountFingerprint(snapshot.visibleAccountContext))throw new FlowBridgeError("UNSUPPORTED_COMBINATION","Retry requires the same stable account fence");
    const original=JSON.parse(latest.snapshot_json) as RuntimeSubmissionSnapshot,generate=this.storage.getGenerateTicketForAttempt(latest.id),receipt=generate&&this.storage.getBrowserTicketReceipt(generate.ticketId);if(!generate||generate.status!=="RECEIPTED"||receipt?.outcome!=="clicked"||generate.requestHash!==job.requestHash||generate.browserId!==observation.browserId||generate.tabId!==observation.tabId||original.visibleAccountContext!==snapshot.visibleAccountContext||observation.projectRef!==generate.projectRef)throw new FlowBridgeError("UNSUPPORTED_COMBINATION","Retry lacks the original clicked receipt or differs in request, browser tab, account, or project");
    assertSnapshotMatches(request,snapshot);assertCostPolicy(request,snapshot);if(snapshot.totalCredits===null)throw new FlowBridgeError("COST_UNKNOWN","Retry quote is unknown");
    const retryStep=`${request.budgetContext.stepKey}-retry1`;
    try{const intent=this.storage.reserveControlledRetryIntent({jobId,requestHash:job.requestHash,snapshot,browserId:observation.browserId,tabId:observation.tabId,projectRef:observation.projectRef,budget:{ledgerId:request.budgetContext.ledgerId,stepKey:retryStep,quotedCredits:snapshot.totalCredits}});return this.storage.issueBrowserTicket({action:"GENERATE",jobId,attemptId:intent.attemptId,requestHash:job.requestHash,browserId:observation.browserId,tabId:observation.tabId,projectRef:observation.projectRef,expectedSnapshot:snapshot});}catch(error){if(error instanceof FlowBridgeError)throw error;throw new FlowBridgeError("COST_LIMIT_EXCEEDED","Controlled retry reservation rejected",{cause:String(error)});}
  }
  async prepareUserResumeRetry(jobId:string,observation:ExistingBrowserObservation,proofPath:string,authorizationPath:string):Promise<BrowserExecutionTicket>{
    const job=this.requireJob(jobId),request=JSON.parse(this.storage.getRequestJson(jobId)) as VideoGenerationRequest,attempts=this.storage.db.prepare("SELECT * FROM submission_attempts WHERE job_id=? ORDER BY ordinal").all(jobId) as import("../../storage/src/index.js").AttemptRow[];
    if(!["GENERATING","SUBMISSION_UNCERTAIN"].includes(job.state)||attempts.length!==1||attempts[0].ordinal!==1||attempts[0].attempt_status!=="ACTIVE"||this.storage.getAssets(jobId).length)throw new FlowBridgeError("INVALID_REQUEST","User-resume retry requires one unresolved output-free attempt 1");
    if(!request.budgetContext)throw new FlowBridgeError("INVALID_REQUEST","User-resume retry requires a parent budget ledger");
    const original=attempts[0],generate=this.storage.getGenerateTicketForAttempt(original.id),receipt=generate&&this.storage.getBrowserTicketReceipt(generate.ticketId);if(!generate||generate.status!=="RECEIPTED"||receipt?.outcome!=="clicked"||generate.requestHash!==job.requestHash)throw new FlowBridgeError("RESULT_AMBIGUOUS","Original unresolved attempt lacks one clicked Generate receipt");
    const pending=(this.storage.db.prepare("SELECT count(*) n FROM browser_execution_tickets WHERE job_id=? AND status!='RECEIPTED'").get(jobId) as {n:number}).n;if(pending)throw new FlowBridgeError("RESULT_AMBIGUOUS","An execution ticket is still pending for the unresolved attempt");
    assertFreshExistingBrowserObservation(observation);const snapshot=observationSnapshot(observation);if(!hasStableAccountFingerprint(snapshot.visibleAccountContext))throw new FlowBridgeError("UNSUPPORTED_COMBINATION","User-resume requires a stable account fingerprint");const originalSnapshot=JSON.parse(original.snapshot_json) as RuntimeSubmissionSnapshot;
    if(observation.browserId!==generate.browserId||observation.projectRef!==generate.projectRef||snapshot.visibleAccountContext!==originalSnapshot.visibleAccountContext)throw new FlowBridgeError("UNSUPPORTED_COMBINATION","User-resume may rebind only a new tab in the same authenticated browser, account, and project");
    assertSnapshotMatches(request,snapshot);assertCostPolicy(request,snapshot);if(snapshot.totalCredits===null||snapshot.totalCredits!==originalSnapshot.totalCredits)throw new FlowBridgeError("COST_LIMIT_EXCEEDED","User-resume quote is unknown or differs from the original step");
    const proofBytes=await readFile(proofPath),authBytes=await readFile(authorizationPath),proofHash=sha256(proofBytes),authorizationHash=sha256(authBytes);let proof:any,auth:any;try{proof=JSON.parse(proofBytes.toString("utf8"));auth=JSON.parse(authBytes.toString("utf8"));}catch{throw new FlowBridgeError("INVALID_REQUEST","User-resume proof and authorization must be JSON");}
    const baseline=originalSnapshot.baselineAssetRefs;if(!Array.isArray(baseline)||!sameStrings(observation.visibleAssetRefs,baseline)||proof.jobId!==jobId||proof.idempotencyKey!==job.idempotencyKey||proof.projectRef!==observation.projectRef||proof.browserId!==observation.browserId||proof.tabId!==observation.tabId||proof.visibleAccountContext!==snapshot.visibleAccountContext||proof.observedAt!==observation.observedAt||proof.providerStatus!=="unknown"||proof.activeGenerationVisible!==false||proof.terminalStatusVisible!==false||!sameStrings(proof.baselineAssetRefs,baseline)||!sameStrings(proof.currentAssetRefs,baseline)||!Array.isArray(proof.newAssetRefs)||proof.newAssetRefs.length||proof.configuration?.model!==snapshot.model||proof.configuration?.mode!==snapshot.mode||proof.configuration?.durationSeconds!==snapshot.durationSeconds||proof.configuration?.resolution!==snapshot.resolution||proof.configuration?.aspectRatio!==snapshot.aspectRatio||proof.configuration?.outputs!==snapshot.outputs||proof.totalCredits!==snapshot.totalCredits)throw new FlowBridgeError("RESULT_AMBIGUOUS","Current observation/proof does not establish same-baseline, zero-delta unresolved state");
    const sourceBytes=await readFile(proof.sourceProofPath);if(!/^[a-f0-9]{64}$/.test(proof.sourceProofSha256)||sha256(sourceBytes)!==proof.sourceProofSha256)throw new FlowBridgeError("RESULT_AMBIGUOUS","Frozen current-page source proof hash does not match");let source:any;try{source=JSON.parse(sourceBytes.toString("utf8"));}catch{throw new FlowBridgeError("INVALID_REQUEST","Frozen current-page proof is malformed JSON");}if(source.jobId!==proof.jobId||source.idempotencyKey!==proof.idempotencyKey||source.projectRef!==proof.projectRef||source.browserId!==proof.browserId||source.tabId!==proof.tabId||source.visibleAccountContext!==proof.visibleAccountContext||source.observedAt!==proof.observedAt||source.providerStatus!=="unknown"||source.activeGenerationVisible!==false||source.terminalStatusVisible!==false||source.activeGenerationVisible!==proof.activeGenerationVisible||source.terminalStatusVisible!==proof.terminalStatusVisible||!sameStrings(source.baselineAssetRefs,baseline)||!sameStrings(source.currentAssetRefs,baseline)||!Array.isArray(source.newAssetRefs)||source.newAssetRefs.length||source.totalCredits!==snapshot.totalCredits)throw new FlowBridgeError("RESULT_AMBIGUOUS","Normalized user-resume evidence differs from its frozen source proof");
    if(source.originalSourcePath||source.originalSourceSha256){const originalBytes=await readFile(source.originalSourcePath);if(!/^[a-f0-9]{64}$/.test(source.originalSourceSha256)||sha256(originalBytes)!==source.originalSourceSha256)throw new FlowBridgeError("RESULT_AMBIGUOUS","Frozen source attestation no longer matches its original readback");}
    const retryStep=`${request.budgetContext.stepKey}-retry1`;
    const ledger=this.storage.getBudgetLedger(request.budgetContext.ledgerId);if(!ledger)throw new FlowBridgeError("INVALID_REQUEST","User-resume budget ledger is missing");
    assertCurrentUserResumeAuthorization(auth,{jobId,requestHash:job.requestHash,proofHash,budgetLedgerId:request.budgetContext.ledgerId,retryStep,originalAttemptId:original.id,originalFencingToken:original.fencing_token,browserId:observation.browserId,projectRef:observation.projectRef,visibleAccountContext:snapshot.visibleAccountContext,quotedCredits:snapshot.totalCredits,parentCapCredits:ledger.capCredits,intentRecordedAt:original.intent_recorded_at});
    if(ledger.capCredits-ledger.reservedCredits-snapshot.totalCredits<auth.minRemainingCredits)throw new FlowBridgeError("COST_LIMIT_EXCEEDED","User-resume would violate the authorization's minimum remaining Credits");
    try{const intent=this.storage.reserveUserResumeIntent({jobId,requestHash:job.requestHash,snapshot,browserId:observation.browserId,tabId:observation.tabId,projectRef:observation.projectRef,budget:{ledgerId:request.budgetContext.ledgerId,stepKey:retryStep,quotedCredits:snapshot.totalCredits},audit:{authorizationHash,proofHash,authorizationId:auth.authorizationId,decision:auth.decision,authorizedAt:auth.authorizedAt,expiresAt:auth.expiresAt,rebindFrom:{browserId:generate.browserId,tabId:generate.tabId},rebindTo:{browserId:observation.browserId,tabId:observation.tabId},providerOutcome:"unresolved",baselineAssetRefs:baseline}});return this.storage.issueBrowserTicket({action:"GENERATE",jobId,attemptId:intent.attemptId,requestHash:job.requestHash,browserId:observation.browserId,tabId:observation.tabId,projectRef:observation.projectRef,expectedSnapshot:snapshot});}catch(error){if(error instanceof FlowBridgeError)throw error;throw new FlowBridgeError("COST_LIMIT_EXCEEDED","User-resume attempt 2 could not be reserved",{cause:String(error)});}
  }
  claimExistingBrowser(ticketId:string,observation:ExistingBrowserObservation):BrowserExecutionTicket {
    const ticket=this.storage.getBrowserTicket(ticketId);if(!ticket)throw new FlowBridgeError("INVALID_REQUEST","Browser ticket not found");
    assertFreshExistingBrowserObservation(observation);
    if(Date.now()-Date.parse(ticket.issuedAt)>600_000)throw new FlowBridgeError("STALE_FENCING_TOKEN","Browser ticket expired before claim");
    if(ticket.browserId!==observation.browserId||ticket.tabId!==observation.tabId||ticket.projectRef!==observation.projectRef)throw new FlowBridgeError("UNSUPPORTED_COMBINATION","Browser tab binding changed; refusing action");
    const job=this.requireJob(ticket.jobId);
    if(["COMPLETED","PARTIALLY_COMPLETED","FAILED","CANCELLED_PRE_SUBMIT","LOCAL_WAIT_CANCELLED_PROVIDER_CONTINUES"].includes(job.state)) throw new FlowBridgeError("INVALID_REQUEST", "Cancelled or terminal jobs cannot claim an existing-browser ticket.", { state: job.state });
    const snapshot=observation.configuration?observationSnapshot(observation):ticket.action==="RECONCILE"?reconcileSnapshot(observation,ticket.expectedSnapshot):observationSnapshot(observation),request=JSON.parse(this.storage.getRequestJson(ticket.jobId)) as VideoGenerationRequest;
    assertExtendSource(this.storage,ticket.jobId,request);
    if(!hasStableAccountFingerprint(snapshot.visibleAccountContext) || ticket.expectedSnapshot.visibleAccountContext!==snapshot.visibleAccountContext)throw new FlowBridgeError("UNSUPPORTED_COMBINATION","Stable account fingerprint changed or is unavailable after ticket issue; refusing action");
    if(ticket.action==="GENERATE"){assertSnapshotMatches(request,snapshot);assertCostPolicy(request,snapshot);}
    else if(request.mode==="extend_video"&&snapshot.selectedSourceAssetRef!==request.sourceAssetRef)throw new FlowBridgeError("UNSUPPORTED_COMBINATION","Extend recovery observation no longer has the immutable source asset selected");
    if (request.budgetContext && ticket.action==="GENERATE") {
      const active=this.storage.getIntent(ticket.jobId),stepKey=active?.ordinal===2?`${request.budgetContext.stepKey}-retry1`:request.budgetContext.stepKey;
      const step = this.storage.getBudgetStep(request.budgetContext.ledgerId, stepKey);
      if (!step || step.quotedCredits < (snapshot.totalCredits ?? Number.POSITIVE_INFINITY)) throw new FlowBridgeError("COST_LIMIT_EXCEEDED", "Current step quote exceeds its parent reservation; refusing action.");
    }
    try{return this.storage.claimBrowserTicket(ticketId);}catch{throw new FlowBridgeError("STALE_FENCING_TOKEN","Browser ticket was already claimed or expired");}
  }
  renewUnclaimedBrowserTicket(ticketId:string,observation:ExistingBrowserObservation):BrowserExecutionTicket{const ticket=this.storage.getBrowserTicket(ticketId);if(!ticket||ticket.status!=="ISSUED"||ticket.action!=="GENERATE"||Date.now()-Date.parse(ticket.issuedAt)<=60_000)throw new FlowBridgeError("STALE_FENCING_TOKEN","Only an expired, never-claimed Generate ticket can be renewed");assertFreshExistingBrowserObservation(observation);if(ticket.browserId!==observation.browserId||ticket.tabId!==observation.tabId||ticket.projectRef!==observation.projectRef)throw new FlowBridgeError("UNSUPPORTED_COMBINATION","Browser binding changed; refusing ticket renewal");const job=this.requireJob(ticket.jobId),active=this.storage.getIntent(ticket.jobId);if(!active||active.id!==ticket.attemptId||active.request_hash!==ticket.requestHash||this.storage.getAssets(ticket.jobId).length)throw new FlowBridgeError("RESULT_AMBIGUOUS","Active attempt or output state no longer permits renewal");const snapshot=observationSnapshot(observation),request=JSON.parse(this.storage.getRequestJson(ticket.jobId)) as VideoGenerationRequest;assertSnapshotMatches(request,snapshot);assertCostPolicy(request,snapshot);if(!hasStableAccountFingerprint(snapshot.visibleAccountContext)||snapshot.visibleAccountContext!==ticket.expectedSnapshot.visibleAccountContext||!Array.isArray(ticket.expectedSnapshot.baselineAssetRefs)||!sameStrings(snapshot.baselineAssetRefs,ticket.expectedSnapshot.baselineAssetRefs))throw new FlowBridgeError("RESULT_AMBIGUOUS","Account or visible asset baseline changed before renewal");if(snapshot.totalCredits!==ticket.expectedSnapshot.totalCredits)throw new FlowBridgeError("COST_LIMIT_EXCEEDED","Visible quote changed before renewal");try{return this.storage.renewUnclaimedBrowserTicket(ticketId,{action:"GENERATE",jobId:ticket.jobId,attemptId:ticket.attemptId,requestHash:ticket.requestHash,browserId:ticket.browserId,tabId:ticket.tabId,projectRef:ticket.projectRef,expectedSnapshot:snapshot});}catch(error){throw new FlowBridgeError("STALE_FENCING_TOKEN","Ticket could not be renewed",{cause:String(error)});}}
  receiptExistingBrowser(ticketId:string,outcome:"clicked"|"uncertain"|"reconciled",evidence:Record<string,unknown>={}):JobRecord {
    if(!["clicked","uncertain","reconciled"].includes(outcome))throw new FlowBridgeError("INVALID_REQUEST","Invalid browser execution outcome");
    let ticket:BrowserExecutionTicket;try{ticket=this.storage.receiptBrowserTicket(ticketId,{outcome,...evidence,receivedAt:new Date().toISOString()});}catch{throw new FlowBridgeError("STALE_FENCING_TOKEN","Browser ticket is not claimed or was already receipted");}
    if(ticket.action==="GENERATE"){const active=this.storage.getIntent(ticket.jobId)!;this.storage.recordEvidence(ticket.jobId,active.fencing_token,{executor:"codex_cua",outcome,...evidence});if(outcome==="clicked"){const request=JSON.parse(this.storage.getRequestJson(ticket.jobId)) as VideoGenerationRequest;if(request.budgetContext)this.storage.consumeBudgetStep(request.budgetContext.ledgerId,active.ordinal===2?`${request.budgetContext.stepKey}-retry1`:request.budgetContext.stepKey);}this.storage.transition(ticket.jobId,outcome==="clicked"?"GENERATING":"SUBMISSION_UNCERTAIN",outcome==="clicked"?null:"SUBMISSION_UNCERTAIN");}
    return this.requireJob(ticket.jobId);
  }
  async failExistingBrowser(ticketId:string,evidence:ExistingBrowserFailureEvidence):Promise<JobRecord>{
    const ticket=this.storage.getBrowserTicket(ticketId);if(!ticket||ticket.action!=="RECONCILE"||ticket.status!=="CLAIMED")throw new FlowBridgeError("STALE_FENCING_TOKEN","Failure confirmation requires one claimed RECONCILE ticket");
    const job=this.requireJob(ticket.jobId),intent=this.storage.getIntent(ticket.jobId);if(!intent||ticket.attemptId!==intent.id||ticket.requestHash!==job.requestHash)throw new FlowBridgeError("INVALID_REQUEST","Failure ticket does not match the active immutable attempt");
    const generate=this.storage.getGenerateTicketForAttempt(intent.id),generateReceipt=generate&&this.storage.getBrowserTicketReceipt(generate.ticketId);if(!generate||generate.status!=="RECEIPTED"||generateReceipt?.outcome!=="clicked"||generate.browserId!==ticket.browserId||generate.tabId!==ticket.tabId||generate.projectRef!==ticket.projectRef)throw new FlowBridgeError("RESULT_AMBIGUOUS","Failure lacks one matching original clicked Generate receipt");
    const snapshot=JSON.parse(intent.snapshot_json) as RuntimeSubmissionSnapshot,baseline=snapshot.baselineAssetRefs;if(!Array.isArray(baseline))throw new FlowBridgeError("RESULT_AMBIGUOUS","Failure requires the immutable original asset baseline");
    if(evidence.projectRef!==ticket.projectRef||evidence.providerStatus!=="failed"||evidence.charged!=="not_charged"||!sameStrings(evidence.beforeAssetRefs,baseline)||!sameStrings(evidence.currentAssetRefs,baseline)||this.storage.getAssets(job.id).length)throw new FlowBridgeError("RESULT_AMBIGUOUS","Failure evidence is ambiguous or reports an output");
    if(!/failed/i.test(evidence.providerMessage)||!/not been charged|not charged/i.test(evidence.providerMessage))throw new FlowBridgeError("INVALID_REQUEST","Provider failure must explicitly report failure and no charge");
    if(evidence.balanceBefore!==undefined||evidence.balanceAfter!==undefined){if(evidence.balanceBefore===undefined||evidence.balanceAfter===undefined||evidence.balanceBefore!==evidence.balanceAfter)throw new FlowBridgeError("RESULT_AMBIGUOUS","Balance proof is incomplete or changed");}
    const observed=Date.parse(evidence.observedAt);if(!Number.isFinite(observed)||observed<Date.parse(intent.intent_recorded_at)||observed>Date.now()+5000)throw new FlowBridgeError("INVALID_REQUEST","Failure observation time is invalid");
    const bytes=await readFile(evidence.sourceEvidencePath);if(!/^[a-f0-9]{64}$/.test(evidence.sourceEvidenceSha256)||sha256(bytes)!==evidence.sourceEvidenceSha256)throw new FlowBridgeError("RESULT_AMBIGUOUS","Failure source evidence hash does not match");
    let source:any;try{source=JSON.parse(bytes.toString("utf8"));}catch{throw new FlowBridgeError("INVALID_REQUEST","Failure source evidence must be JSON");}if(source.providerStatus!==evidence.providerStatus||source.providerMessage!==evidence.providerMessage||!sameStrings(source.providerAssetRefs??[],evidence.currentAssetRefs)||source.retryClicked!==false)throw new FlowBridgeError("RESULT_AMBIGUOUS","Failure source contents do not match or show a retry");
    this.storage.receiptBrowserTicket(ticketId,{outcome:"failed",executor:"codex_cua",evidence,receivedAt:new Date().toISOString()});this.storage.confirmProviderFailure(job.id,intent.id,{attemptId:intent.id,ordinal:intent.ordinal,providerMessage:evidence.providerMessage,charged:evidence.charged,balanceBefore:evidence.balanceBefore,balanceAfter:evidence.balanceAfter,sourceEvidenceSha256:evidence.sourceEvidenceSha256});return this.requireJob(job.id);
  }
  async confirmNoCharge(jobId:string,attemptId:string):Promise<{confirmed:true;releasedCredits:number;idempotent:boolean;ledger:unknown}>{
    const job=this.requireJob(jobId),request=JSON.parse(this.storage.getRequestJson(jobId)) as VideoGenerationRequest;if(!request.budgetContext)throw new FlowBridgeError("INVALID_REQUEST","Job has no parent budget step");
    const attempt=this.storage.db.prepare("SELECT * FROM submission_attempts WHERE id=? AND job_id=?").get(attemptId,jobId) as import("../../storage/src/index.js").AttemptRow|undefined;if(!attempt||attempt.ordinal!==1||attempt.attempt_status!=="FAILED"||attempt.request_hash!==job.requestHash)throw new FlowBridgeError("INVALID_REQUEST","No-charge confirmation requires the original confirmed-failed attempt");
    const generate=this.storage.getGenerateTicketForAttempt(attempt.id),generateReceipt=generate&&this.storage.getBrowserTicketReceipt(generate.ticketId);if(!generate||generateReceipt?.outcome!=="clicked")throw new FlowBridgeError("RESULT_AMBIGUOUS","Original attempt lacks one clicked Generate receipt");
    const failureRow=this.storage.db.prepare("SELECT * FROM browser_execution_tickets WHERE attempt_id=? AND action='RECONCILE' AND receipt_json IS NOT NULL ORDER BY issued_at DESC").get(attempt.id) as any;if(!failureRow)throw new FlowBridgeError("RESULT_AMBIGUOUS","Confirmed failure receipt is missing");let receipt:any;try{receipt=JSON.parse(failureRow.receipt_json);}catch{throw new FlowBridgeError("INVALID_REQUEST","Failure receipt JSON is malformed");}const ev=receipt.evidence;if(receipt.outcome!=="failed"||!ev||ev.charged!=="not_charged"||ev.balanceBefore!==ev.balanceAfter||!Number.isFinite(ev.balanceBefore))throw new FlowBridgeError("RESULT_AMBIGUOUS","Failure has no reliable unchanged-balance no-charge proof");
    if(failureRow.browser_id!==generate.browserId||failureRow.tab_id!==generate.tabId||failureRow.project_ref!==generate.projectRef||failureRow.request_hash!==job.requestHash)throw new FlowBridgeError("RESULT_AMBIGUOUS","Failure receipt identity differs from the original Generate");
    const original=JSON.parse(attempt.snapshot_json) as RuntimeSubmissionSnapshot,failedSnapshot=JSON.parse(failureRow.snapshot_json) as RuntimeSubmissionSnapshot;if(original.visibleAccountContext!==failedSnapshot.visibleAccountContext)throw new FlowBridgeError("RESULT_AMBIGUOUS","Failure account differs from original attempt");const baseline=original.baselineAssetRefs;if(!Array.isArray(baseline)||!sameStrings(ev.beforeAssetRefs,baseline)||!sameStrings(ev.currentAssetRefs,baseline))throw new FlowBridgeError("RESULT_AMBIGUOUS","Failure asset proof differs from original baseline");
    const event=this.storage.db.prepare("SELECT payload_json,created_at FROM job_events WHERE job_id=? AND event_type='PROVIDER_FAILURE_CONFIRMED' ORDER BY id DESC LIMIT 1").get(jobId) as {payload_json:string;created_at:string}|undefined;if(!event)throw new FlowBridgeError("RESULT_AMBIGUOUS","Provider failure audit event is missing");const payload=JSON.parse(event.payload_json);if(payload.attemptId!==attempt.id||payload.sourceEvidenceSha256!==ev.sourceEvidenceSha256||payload.balanceBefore!==ev.balanceBefore||payload.balanceAfter!==ev.balanceAfter||payload.charged!=="not_charged")throw new FlowBridgeError("RESULT_AMBIGUOUS","Failure event and receipt evidence differ");
    const bytes=await readFile(ev.sourceEvidencePath);if(!/^[a-f0-9]{64}$/.test(ev.sourceEvidenceSha256)||sha256(bytes)!==ev.sourceEvidenceSha256)throw new FlowBridgeError("RESULT_AMBIGUOUS","Failure source proof hash drifted");let source:any;try{source=JSON.parse(bytes.toString("utf8"));}catch{throw new FlowBridgeError("INVALID_REQUEST","Failure source proof is malformed JSON");}if(source.providerStatus!=="failed"||source.retryClicked!==false||!sameStrings(source.providerAssetRefs??[],baseline)||source.providerMessage!==ev.providerMessage)throw new FlowBridgeError("RESULT_AMBIGUOUS","Failure source no longer proves failed/no-output state");
    const second=this.storage.db.prepare("SELECT intent_recorded_at FROM submission_attempts WHERE job_id=? AND ordinal=2").get(jobId) as {intent_recorded_at:string}|undefined;if(second&&Date.parse(event.created_at)>=Date.parse(second.intent_recorded_at))throw new FlowBridgeError("RESULT_AMBIGUOUS","Failure audit was not recorded before attempt 2");
    try{const result=this.storage.confirmBudgetStepNotCharged({attemptId,jobId,parentId:request.budgetContext.ledgerId,stepKey:request.budgetContext.stepKey,sourceEvidenceSha256:ev.sourceEvidenceSha256,evidence:{failureTicketId:failureRow.id,generateTicketId:generate.ticketId,balanceBefore:ev.balanceBefore,balanceAfter:ev.balanceAfter,providerMessage:ev.providerMessage}});return{...result,ledger:this.storage.getBudgetLedger(request.budgetContext.ledgerId)};}catch(error){throw new FlowBridgeError("INVALID_REQUEST","Budget step cannot be confirmed no-charge",{cause:String(error)});}
  }
  completeExistingBrowser(ticketId:string,evidence:ExistingBrowserCompletionEvidence):JobRecord {
    const ticket=this.storage.getBrowserTicket(ticketId);if(!ticket||ticket.status!=="CLAIMED")throw new FlowBridgeError("STALE_FENCING_TOKEN","Completion requires one currently claimed browser ticket");
    const job=this.requireJob(ticket.jobId),intent=this.storage.getIntent(ticket.jobId),request=JSON.parse(this.storage.getRequestJson(ticket.jobId)) as VideoGenerationRequest;
    if(!intent)throw new FlowBridgeError("INVALID_REQUEST","Completion evidence cannot precede submission intent");
    assertExtendSource(this.storage,ticket.jobId,request);
    const completedAt=Date.parse(evidence.completedAt);if(!Number.isFinite(completedAt)||completedAt<Date.parse(intent.intent_recorded_at)||completedAt>Date.now()+5_000)throw new FlowBridgeError("INVALID_REQUEST","Completion time is invalid or predates intent");
    if(evidence.projectRef!==ticket.projectRef)throw new FlowBridgeError("RESULT_AMBIGUOUS","Completion project differs from the bound ticket project");
    const originalSnapshot=JSON.parse(intent.snapshot_json) as RuntimeSubmissionSnapshot;
    const attestation=this.storage.getBaselineAttestation(intent.id);
    if(!Array.isArray(originalSnapshot.baselineAssetRefs)&&!attestation)throw new FlowBridgeError("RESULT_AMBIGUOUS","Original pre-submit asset baseline was not persisted and has no verified legacy attestation; refusing to infer an empty baseline");
    const baseline=Array.isArray(originalSnapshot.baselineAssetRefs)?originalSnapshot.baselineAssetRefs:attestation!.baselineAssetRefs;
    if(!sameStrings(evidence.beforeAssetRefs,baseline))throw new FlowBridgeError("RESULT_AMBIGUOUS","Completion baseline differs from the immutable pre-submit card set",{expected:baseline,actual:evidence.beforeAssetRefs});
    const actual=evidence.actual,expected=[request.mode,request.aspectRatio,request.durationSeconds,request.resolution,request.outputs],observed=[actual.mode,actual.aspectRatio,actual.durationSeconds,actual.resolution,actual.outputs];
    if(expected.some((v,i)=>v!==observed[i])||(request.mode==="extend_video"&&actual.selectedSourceAssetRef!==request.sourceAssetRef))throw new FlowBridgeError("UNSUPPORTED_COMBINATION","Completion evidence parameters differ from the immutable request",{expected,observed});
    if(originalSnapshot.modelOption&&(actual.modelOption?.label!==originalSnapshot.modelOption.label||actual.modelOption?.value!==originalSnapshot.modelOption.value))throw new FlowBridgeError("UNSUPPORTED_COMBINATION","Completion configuration model differs from the immutable pre-submit model option",{expected:originalSnapshot.modelOption,actual:actual.modelOption??null});
    if(actual.providerModelReadback?.family&&actual.providerModelReadback.family!=="unknown"&&request.modelPolicy&&actual.providerModelReadback.family!==request.modelPolicy.requiredFamily)throw new FlowBridgeError("RESULT_AMBIGUOUS","Result model readback conflicts with the immutable requested model policy",{requiredFamily:request.modelPolicy.requiredFamily,actual:actual.providerModelReadback});
    if(!Array.isArray(evidence.assets)||evidence.assets.length!==request.outputs)throw new FlowBridgeError("RESULT_AMBIGUOUS","Completed asset count does not match requested outputs");
    const refs=evidence.assets.map(a=>a.providerAssetRef);if(new Set(refs).size!==refs.length||refs.some(ref=>!ref||baseline.includes(ref)||this.storage.getAssets(ticket.jobId).some(a=>a.providerAssetRef===ref)))throw new FlowBridgeError("RESULT_AMBIGUOUS","Completion assets are duplicated or were present before submission");
    const assets:ProviderAsset[]=evidence.assets.map(asset=>({providerAssetRef:asset.providerAssetRef,status:"generated",metadata:{...asset,projectRef:evidence.projectRef,actual:evidence.actual,sourceParentJobId:request.sourceParentJobId,sourceAssetRef:request.sourceAssetRef,completedAt:evidence.completedAt}}));
    if(request.budgetContext)this.storage.consumeBudgetStep(request.budgetContext.ledgerId,request.budgetContext.stepKey);
    try{this.storage.completeBrowserTicket(ticketId,{outcome:"reconciled",executor:"codex_cua",evidence,receivedAt:new Date().toISOString()},assets);}catch{throw new FlowBridgeError("STALE_FENCING_TOKEN","Completion ticket was already consumed");}
    return this.requireJob(job.id);
  }
  async attestLegacyBaseline(jobId:string,evidence:LegacyBaselineAttestationEvidence):Promise<{jobId:string;attemptId:string;baselineAssetRefs:string[];attested:true}>{
    const job=this.requireJob(jobId),intent=this.storage.getIntent(jobId);if(!intent)throw new FlowBridgeError("INVALID_REQUEST","Baseline attestation requires an existing submission intent");
    const snapshot=JSON.parse(intent.snapshot_json) as RuntimeSubmissionSnapshot;if(Array.isArray(snapshot.baselineAssetRefs))throw new FlowBridgeError("INVALID_REQUEST","Original intent already contains a baseline and cannot be replaced");
    if(this.storage.getBaselineAttestation(intent.id))throw new FlowBridgeError("IDEMPOTENCY_CONFLICT","A baseline attestation already exists and cannot be replaced");
    const generate=this.storage.getGenerateTicketForAttempt(intent.id);if(!generate)throw new FlowBridgeError("RESULT_AMBIGUOUS","Original Generate ticket is unavailable for baseline binding");
    const captured=Date.parse(evidence.capturedAt),intentAt=Date.parse(intent.intent_recorded_at),recordType=evidence.recordType??"pre_submit_observation";if(!Number.isFinite(captured))throw new FlowBridgeError("INVALID_REQUEST","Legacy source observation time is invalid");
    if(recordType==="pre_submit_observation"){if(captured>intentAt||intentAt-captured>60_000)throw new FlowBridgeError("INVALID_REQUEST","Legacy source observation must be within 60 seconds before the original intent");}
    else if(recordType==="contemporaneous_tool_log"){const approveAt=Date.parse(evidence.approveAt??""),receipt=this.storage.getBrowserTicketReceipt(generate.ticketId),receiptAt=Date.parse(String(receipt?.receivedAt??""));if(generate.status!=="RECEIPTED"||receipt?.outcome!=="clicked"||!evidence.sourceThreadId||!evidence.sourceItemId||!Number.isInteger(evidence.sourceRolloutOrdinal)||!Number.isInteger(evidence.sourceLine)||!evidence.approveItemId||!Number.isFinite(approveAt)||!Number.isFinite(receiptAt)||captured<intentAt||captured>approveAt||approveAt>receiptAt)throw new FlowBridgeError("INVALID_REQUEST","Contemporaneous tool log must be ordered after intent and before the unique Approve and receipt");}
    else throw new FlowBridgeError("INVALID_REQUEST","Unknown baseline attestation record type");
    if(evidence.reason!=="legacy_mapping_defect"||evidence.requestHash!==job.requestHash||evidence.requestHash!==intent.request_hash||evidence.projectRef!==generate.projectRef||evidence.browserId!==generate.browserId||evidence.tabId!==generate.tabId)throw new FlowBridgeError("RESULT_AMBIGUOUS","Legacy baseline evidence does not match the original job, request, project or browser tab");
    if(!Array.isArray(evidence.baselineAssetRefs)||new Set(evidence.baselineAssetRefs).size!==evidence.baselineAssetRefs.length||evidence.baselineAssetRefs.some(x=>typeof x!=="string"||!x))throw new FlowBridgeError("INVALID_REQUEST","Legacy baseline refs must be a unique string array");
    const bytes=await readFile(evidence.sourceObservationPath),hash=sha256(bytes);if(!/^[a-f0-9]{64}$/.test(evidence.sourceObservationSha256)||hash!==evidence.sourceObservationSha256)throw new FlowBridgeError("RESULT_AMBIGUOUS","Legacy source observation file hash does not match");
    let source:any;try{source=JSON.parse(bytes.toString("utf8"));}catch{throw new FlowBridgeError("INVALID_REQUEST","Legacy source observation file must be JSON");}if(hasSensitiveKey(source))throw new FlowBridgeError("INVALID_REQUEST","Legacy source observation contains prohibited sensitive fields");
    const sourceRefs=source.beforeAssetRefs??source.baselineAssetRefs;if(source.browserId!==evidence.browserId||source.tabId!==evidence.tabId||source.projectRef!==evidence.projectRef||source.capturedAt!==evidence.capturedAt||!sameStrings(sourceRefs,evidence.baselineAssetRefs))throw new FlowBridgeError("RESULT_AMBIGUOUS","Legacy source observation contents do not match the attestation");
    if(recordType==="contemporaneous_tool_log"&&(source.recordType!==recordType||source.sourceThreadId!==evidence.sourceThreadId||source.sourceItemId!==evidence.sourceItemId||source.sourceRolloutOrdinal!==evidence.sourceRolloutOrdinal||source.sourceLine!==evidence.sourceLine||source.approveItemId!==evidence.approveItemId||source.approveAt!==evidence.approveAt))throw new FlowBridgeError("RESULT_AMBIGUOUS","Contemporaneous tool-log provenance does not match its source export");
    try{this.storage.appendBaselineAttestation(jobId,intent.id,evidence);}catch{throw new FlowBridgeError("IDEMPOTENCY_CONFLICT","Baseline attestation is append-only and already exists");}return {jobId,attemptId:intent.id,baselineAssetRefs:evidence.baselineAssetRefs,attested:true};
  }
  async ingestExistingBrowserDownload(jobId:string,assetRef:string,sourcePath:string,evidence:ExistingBrowserDownloadEvidence):Promise<JobRecord>{
    const job=this.requireJob(jobId),request=JSON.parse(this.storage.getRequestJson(jobId)) as VideoGenerationRequest,assets=this.storage.getAssets(jobId);
    if(!["GENERATED","DOWNLOAD_FAILED"].includes(job.state)||assets.length!==1||assets[0].providerAssetRef!==assetRef)throw new FlowBridgeError("RESULT_AMBIGUOUS","Download ingest requires the job's unique attributed generated asset");
    const directory=request.download?.directory;if(!request.download?.enabled||!directory)throw new FlowBridgeError("DOWNLOAD_FAILED","Request does not authorize a download directory");
    const metadata=(assets[0].metadata??{}) as any,actual=metadata.actual??{},actualDuration=Number(metadata.actualDurationSeconds??actual.actualDurationSeconds??request.durationSeconds);
    if(!Number.isFinite(actualDuration)||actualDuration<=0)throw new FlowBridgeError("DOWNLOAD_FAILED","Completion evidence has no valid actual asset duration");
    const downloadedAt=Date.parse(evidence.downloadedAt),completedAt=Date.parse(metadata.completedAt);if(evidence.jobId!==jobId||evidence.providerAssetRef!==assetRef||evidence.projectRef!==(metadata.projectRef??request.project.name)||!Number.isFinite(downloadedAt)||downloadedAt<completedAt||!/^([a-f0-9]{64})$/.test(evidence.sourceSha256)||sha256(await readFile(sourcePath))!==evidence.sourceSha256)throw new FlowBridgeError("DOWNLOAD_FAILED","Native download evidence does not match the attributed job, card, project, time and file hash");
    this.storage.transition(jobId,"DOWNLOADING");
    const modelReadback=actual.providerModelReadback;const modelActual=modelReadback&&modelReadback.source!=="unknown"?(modelReadback.label??modelReadback.value??"unknown"):"unknown";
    try{const result=await new DownloadManager().persist(sourcePath,directory,{jobId,projectName:request.project.name,projectUrl:metadata.projectRef??request.project.name,modelRequested:request.model,modelActual,modelActualReadback:modelReadback??{family:"unknown",label:null,value:null,source:"unknown"},aspectRatio:request.aspectRatio,durationSeconds:actualDuration,resolution:actual.resolution??request.resolution,promptSha256:job.finalPromptSha256,targetMatchEvidence:{provider_card_ref:assetRef,completion:metadata,source_parent_job_id:request.sourceParentJobId??null,source_asset_ref:request.sourceAssetRef??null},requireAudio:true});this.storage.saveAssets(jobId,[result.asset]);this.storage.transition(jobId,"COMPLETED");return this.requireJob(jobId);}catch(error){this.storage.transition(jobId,"DOWNLOAD_FAILED","DOWNLOAD_FAILED");throw error;}
  }
  cancel(jobId:string): JobRecord {
    const job=this.requireJob(jobId);
    this.storage.transition(jobId,this.storage.getIntent(jobId)?"LOCAL_WAIT_CANCELLED_PROVIDER_CONTINUES":"CANCELLED_PRE_SUBMIT");
    return this.requireJob(jobId);
  }
  async wait(jobId:string,options:{timeoutMs?:number;pollMs?:number}={}):Promise<JobRecord>{
    const timeoutMs=options.timeoutMs??120_000,pollMs=options.pollMs??1_000,start=Date.now();
    const job=this.requireJob(jobId),request=JSON.parse(this.storage.getRequestJson(jobId)) as VideoGenerationRequest,provider=this.providers.get(job.provider),intent=this.storage.getIntent(jobId);
    if(!provider||!intent)throw new FlowBridgeError("INVALID_REQUEST","Waiting requires a configured provider and persisted submission intent");
    while(Date.now()-start<=timeoutMs){
      const result=await provider.reconcile(request,contextFromIntent(jobId,job.requestHash,intent));
      if(!result.complete){await delay(pollMs);continue;}
      if(result.assets.length!==request.outputs){this.storage.transition(jobId,"RESULT_AMBIGUOUS","RESULT_AMBIGUOUS");return this.requireJob(jobId);}
      this.storage.saveAssets(jobId,result.assets);this.storage.transition(jobId,"GENERATED");
      if(!request.download?.enabled)return this.requireJob(jobId);
      return await this.download(jobId);
    }
    const current=this.requireJob(jobId);
    if(current.state!=="GENERATING")this.storage.transition(jobId,"SUBMISSION_UNCERTAIN","SUBMISSION_UNCERTAIN");
    return this.requireJob(jobId);
  }
  async download(jobId:string):Promise<JobRecord>{
    const job=this.requireJob(jobId),request=JSON.parse(this.storage.getRequestJson(jobId)) as VideoGenerationRequest,provider=this.providers.get(job.provider);
    if(!provider)throw new FlowBridgeError("PROVIDER_UNAVAILABLE","Provider is not configured");
    if(!["GENERATED","DOWNLOAD_FAILED","DOWNLOADING"].includes(job.state))throw new FlowBridgeError("INVALID_REQUEST","Download is allowed only after unique generation attribution");
    const assets=this.storage.getAssets(jobId);if(assets.length!==request.outputs)throw new FlowBridgeError("RESULT_AMBIGUOUS","Persisted asset count does not match requested outputs");
    this.storage.transition(jobId,"DOWNLOADING");
    try{const directory=request.download?.directory;if(!directory)throw new FlowBridgeError("DOWNLOAD_FAILED","Request has no download directory");for(const asset of assets){if(asset.localPath&&asset.sha256)continue;const downloaded=await provider.download(asset,directory);this.storage.saveAssets(jobId,[downloaded]);}this.storage.transition(jobId,"COMPLETED");return this.requireJob(jobId);}
    catch(error){this.storage.transition(jobId,"DOWNLOAD_FAILED","DOWNLOAD_FAILED");throw error;}
  }
  get(jobId:string){ return this.requireJob(jobId); }
  private requireJob(id:string){ const job=this.storage.getJob(id); if(!job) throw new FlowBridgeError("INVALID_REQUEST","Job not found"); return job; }
}
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function sameStrings(a:unknown,b:string[]):boolean{return Array.isArray(a)&&a.length===b.length&&a.every((x,i)=>typeof x==="string"&&x===b[i]);}
function hasSensitiveKey(value:unknown):boolean{if(!value||typeof value!=="object")return false;if(Array.isArray(value))return value.some(hasSensitiveKey);return Object.entries(value as Record<string,unknown>).some(([k,v])=>["prompt","email","cookie","cookies","token","authorization","password"].includes(k.toLowerCase())||hasSensitiveKey(v));}
type UserResumeAuthorizationBinding={jobId:string;requestHash:string;proofHash:string;budgetLedgerId:string;retryStep:string;originalAttemptId:string;originalFencingToken:string;browserId:string;projectRef:string;visibleAccountContext:string|null;quotedCredits:number|null;parentCapCredits:number;intentRecordedAt:string};
function assertCurrentUserResumeAuthorization(auth:any,binding:UserResumeAuthorizationBinding):void{
  const authorizedAt=Date.parse(auth?.authorizedAt),expiresAt=Date.parse(auth?.expiresAt),now=Date.now(),session=auth?.sessionContext;
  const valid=auth?.kind==="current_user_resume_authorization"&&auth?.version===1&&auth?.actor==="current_user"&&auth?.decision==="approve_one_additional_paid_attempt"&&typeof auth?.authorizationId==="string"&&/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(auth.authorizationId)&&auth?.jobId===binding.jobId&&auth?.requestHash===binding.requestHash&&auth?.proofSha256===binding.proofHash&&auth?.budgetLedgerId===binding.budgetLedgerId&&auth?.budgetStepKey===binding.retryStep&&auth?.originalAttemptId===binding.originalAttemptId&&auth?.originalFencingToken===binding.originalFencingToken&&auth?.maxParentCredits===binding.parentCapCredits&&auth?.maxParentCredits===50&&auth?.maxRetryCredits===binding.quotedCredits&&auth?.minRemainingCredits===20&&auth?.maxAttemptOrdinal===2&&session?.browserId===binding.browserId&&session?.projectRef===binding.projectRef&&session?.visibleAccountContext===binding.visibleAccountContext&&Number.isFinite(authorizedAt)&&Number.isFinite(expiresAt)&&authorizedAt>=Date.parse(binding.intentRecordedAt)&&authorizedAt<=now+5_000&&expiresAt>now&&expiresAt>authorizedAt&&expiresAt-authorizedAt<=86_400_000;
  if(!valid)throw new FlowBridgeError("INVALID_REQUEST","Current-task user-resume authorization is missing, expired, or does not match this immutable job, proof, budget, attempt, fencing token, and session context");
}
function contextFromIntent(jobId:string,requestHash:string,intent:import("../../storage/src/index.js").AttemptRow){const snapshot=JSON.parse(intent.snapshot_json) as {projectRef?:string};return {jobId,attemptId:intent.id,fencingToken:intent.fencing_token,requestHash,projectRef:snapshot.projectRef,intentRecordedAt:intent.intent_recorded_at,submissionEvidence:intent.evidence_json?JSON.parse(intent.evidence_json):undefined};}
function observationSnapshot(o:ExistingBrowserObservation):RuntimeSubmissionSnapshot{return snapshotFromObservation(o);}
function reconcileSnapshot(o:ExistingBrowserObservation,original:RuntimeSubmissionSnapshot):RuntimeSubmissionSnapshot{return {...original,visibleAccountContext:o.visibleAccountContext,projectRef:o.projectRef,totalCredits:o.totalCredits,availableCredits:o.availableCredits,capturedAt:o.observedAt,capabilityFingerprint:`existing-browser:${o.browserId}:${o.tabId}`,selectedSourceAssetRef:o.selectedSourceAssetRef??original.selectedSourceAssetRef,baselineAssetRefs:original.baselineAssetRefs};}
export * from "./hash.js";
export * from "./mock-provider.js";
export * from "./extend.js";
