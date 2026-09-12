#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { FlowBridgeError, createModelPolicy, normalizeExternalRequest, type ExistingBrowserObservation, type FlowProvider } from "../../../packages/contracts/src/index.js";
import { JobEngine, MockProvider } from "../../../packages/job-engine/src/index.js";
import { Storage } from "../../../packages/storage/src/index.js";
import { FlowBrowserSession, FlowUiProvider, authorizeDedicatedCompatibility, ownFlowPage, parseExistingBrowserObservation } from "../../../packages/flow-adapter/src/index.js";
import { chromium } from "playwright";
import { ProductionWorkspace, type ModelPolicy as WorkspaceModelPolicy } from "../../../packages/production-workspace/src/index.js";

const args=process.argv.slice(2), command=args[0];
const flag=(name:string)=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined};
const dataPath=resolve(process.env.FLOWBRIDGE_DB_PATH ?? "data/flowbridge.sqlite");
await mkdir(dirname(dataPath),{recursive:true});
const storage=new Storage(dataPath);
const fixtureUrl=process.env.NODE_ENV==="test"?process.env.FLOWBRIDGE_TEST_READONLY_URL:undefined;
const fixtureProfile=process.env.NODE_ENV==="test"?process.env.FLOWBRIDGE_TEST_PROFILE_DIR:undefined;
const flowUiProvider=new FlowUiProvider(fixtureProfile?{acquirePage:async()=>{const session=await FlowBrowserSession.openDedicatedCompatibility(authorizeDedicatedCompatibility(true),fixtureProfile,fixtureUrl);return ownFlowPage(session.page,"owned_test_fixture",()=>session.close());}}:fixtureUrl?{acquirePage:async()=>{const browser=await chromium.launch({headless:true});const page=await browser.newPage();await page.goto(fixtureUrl);return ownFlowPage(page as any,"owned_test_fixture",()=>browser.close());}}:{});
const providers=new Map<string,FlowProvider>([["flow_ui",flowUiProvider]]);
if(args.includes("--enable-mock")) providers.set("mock",new MockProvider(flag("--mock-cost") ? Number(flag("--mock-cost")) : 4,{availableCredits:flag("--mock-balance")?Number(flag("--mock-balance")):undefined,submitReadbackCredits:flag("--mock-submit-cost")?Number(flag("--mock-submit-cost")):undefined,submitReadbackAvailableCredits:flag("--mock-submit-balance")?Number(flag("--mock-submit-balance")):undefined,effectLog:flag("--mock-effect-log"),crashPoint:flag("--mock-crash") as any,sourceMedia:flag("--mock-source-media")}));
const engine=new JobEngine(storage,providers);
const workspace=new ProductionWorkspace(storage);
const print=(value:unknown)=>process.stdout.write(`${JSON.stringify(value)}\n`);
const printJob=(job:{state:string})=>{print(job);if(job.state==="SUBMISSION_UNCERTAIN")process.exitCode=8;else if(job.state==="RESULT_AMBIGUOUS")process.exitCode=13;};
try {
  if(command==="auth"&&args[1]==="open") {
    print({mode:"existing_browser",status:"ACTION_REQUIRED",action:"Use the Codex browser tool to select the already signed-in Flow tab, then import a sanitized observation with flowctl browser observe --file <observation.json>. No browser or profile was launched."});
  } else if(command==="auth"&&args[1]==="status") {
    const observation=requireCurrentObservation(storage);print({mode:"existing_browser",authenticated:true,connected:true,browserId:observation.browserId,tabId:observation.tabId,projectRef:observation.projectRef,observedAt:observation.observedAt});
  } else if(command==="doctor") {
    print({ok:true,node:process.version,database:dataPath,flowUiProvider:"installed",liveSubmissionVerified:false});
  } else if(command==="credits") {
    if(fixtureUrl||fixtureProfile){const result=await flowUiProvider.readBalance();print({credits:result.balance,...result});if(result.source==="unknown")process.exitCode=4;}
    else {const observation=requireCurrentObservation(storage);print({credits:observation.availableCredits,balance:observation.availableCredits,source:observation.availableCredits===null?"unknown":"existing_browser_observation",observedAt:observation.observedAt});if(observation.availableCredits===null)process.exitCode=4;}
  } else if(command==="capabilities") {
    if(fixtureUrl||fixtureProfile){const result=await flowUiProvider.readCapabilities();print({capabilities:result.observed,...result});if(result.source==="unknown")process.exitCode=6;}
    else {const observation=requireCurrentObservation(storage);print({capabilities:observation.configuration,source:observation.configuration===null?"unknown":"existing_browser_observation",observedAt:observation.observedAt});if(observation.configuration===null)process.exitCode=6;}
  } else if(command==="browser"&&args[1]==="observe") {
    const file=flag("--file");if(!file)throw new FlowBridgeError("INVALID_REQUEST","browser observe requires --file <observation.json>");const observation=validateObservation(JSON.parse(await readFile(resolve(file),"utf8")));storage.saveBrowserObservation(observation);print({connected:true,mode:"existing_browser",browserId:observation.browserId,tabId:observation.tabId,projectRef:observation.projectRef,observedAt:observation.observedAt});
  } else if(command==="browser"&&args[1]==="prepare") {
    const file=flag("--observation"),jobId=flag("--job");if(!file||!jobId)throw new FlowBridgeError("INVALID_REQUEST","browser prepare requires --job <id> --observation <json>");print(engine.prepareExistingBrowser(jobId,validateObservation(JSON.parse(await readFile(resolve(file),"utf8")))));
  } else if(command==="browser"&&args[1]==="claim") {
    const file=flag("--observation"),ticketId=flag("--ticket");if(!file||!ticketId)throw new FlowBridgeError("INVALID_REQUEST","browser claim requires --ticket <id> --observation <json>");print(engine.claimExistingBrowser(ticketId,validateObservation(JSON.parse(await readFile(resolve(file),"utf8")))));
  } else if(command==="browser"&&args[1]==="renew-unclaimed-ticket") {
    const file=flag("--observation"),ticketId=flag("--ticket");if(!file||!ticketId)throw new FlowBridgeError("INVALID_REQUEST","browser renew-unclaimed-ticket requires --ticket <expired-issued-id> --observation <json>");print(engine.renewUnclaimedBrowserTicket(ticketId,validateObservation(JSON.parse(await readFile(resolve(file),"utf8")))));
  } else if(command==="browser"&&args[1]==="receipt") {
    const ticketId=flag("--ticket"),outcome=flag("--outcome") as "clicked"|"uncertain"|"reconciled"|undefined,evidenceFile=flag("--evidence");if(!ticketId||!outcome||!["clicked","uncertain","reconciled"].includes(outcome))throw new FlowBridgeError("INVALID_REQUEST","browser receipt requires --ticket <id> --outcome clicked|uncertain|reconciled [--evidence file.json]");const evidence=evidenceFile?JSON.parse(await readFile(resolve(evidenceFile),"utf8")):{};printJob(engine.receiptExistingBrowser(ticketId,outcome,evidence));
  } else if(command==="browser"&&args[1]==="complete") {
    const ticketId=flag("--ticket"),file=flag("--evidence");if(!ticketId||!file)throw new FlowBridgeError("INVALID_REQUEST","browser complete requires --ticket <claimed-id> --evidence <completion.json>");printJob(engine.completeExistingBrowser(ticketId,JSON.parse(await readFile(resolve(file),"utf8"))));
  } else if(command==="browser"&&args[1]==="fail") {
    const ticketId=flag("--ticket"),file=flag("--evidence");if(!ticketId||!file)throw new FlowBridgeError("INVALID_REQUEST","browser fail requires --ticket <claimed-reconcile-id> --evidence <failure.json>");printJob(await engine.failExistingBrowser(ticketId,JSON.parse(await readFile(resolve(file),"utf8"))));
  } else if(command==="browser"&&args[1]==="retry-prepare") {
    const file=flag("--observation"),jobId=flag("--job");if(!file||!jobId)throw new FlowBridgeError("INVALID_REQUEST","browser retry-prepare requires --job <failed-id> --observation <json>");print(engine.prepareControlledRetry(jobId,validateObservation(JSON.parse(await readFile(resolve(file),"utf8")))));
  } else if(command==="browser"&&args[1]==="user-resume-prepare") {
    const file=flag("--observation"),proof=flag("--proof"),authorization=flag("--authorization"),jobId=flag("--job");if(!file||!proof||!authorization||!jobId)throw new FlowBridgeError("INVALID_REQUEST","browser user-resume-prepare requires --job <unresolved-id> --observation <json> --proof <json> --authorization <json>");print(await engine.prepareUserResumeRetry(jobId,validateObservation(JSON.parse(await readFile(resolve(file),"utf8"))),resolve(proof),resolve(authorization)));
  } else if(command==="browser"&&args[1]==="attest-baseline") {
    const jobId=flag("--job"),file=flag("--evidence");if(!jobId||!file)throw new FlowBridgeError("INVALID_REQUEST","browser attest-baseline requires --job <id> --evidence <attestation.json>");print(await engine.attestLegacyBaseline(jobId,JSON.parse(await readFile(resolve(file),"utf8"))));
  } else if(command==="browser"&&args[1]==="ingest-download") {
    const jobId=flag("--job"),assetRef=flag("--asset"),file=flag("--file"),evidenceFile=flag("--evidence");if(!jobId||!assetRef||!file||!evidenceFile)throw new FlowBridgeError("INVALID_REQUEST","browser ingest-download requires --job <id> --asset <card-ref> --file <staged.mp4> --evidence <download.json>");printJob(await engine.ingestExistingBrowserDownload(jobId,assetRef,resolve(file),JSON.parse(await readFile(resolve(evidenceFile),"utf8"))));
  } else if(command==="budget"&&args[1]==="create") {
    const id=flag("--id"); if(!id) throw new FlowBridgeError("INVALID_REQUEST","budget create requires --id <ledger_id>"); print(storage.createBudgetLedger(id));
  } else if(command==="budget"&&args[1]==="status") {
    const id=flag("--id"); if(!id) throw new FlowBridgeError("INVALID_REQUEST","budget status requires --id <ledger_id>"); const ledger=storage.getBudgetLedger(id); if(!ledger) throw new FlowBridgeError("INVALID_REQUEST","Budget ledger not found"); print({...ledger,steps:storage.getBudgetSteps(id)});
  } else if(command==="budget"&&args[1]==="confirm-no-charge") {
    const jobId=flag("--job"),attemptId=flag("--attempt");if(!jobId||!attemptId)throw new FlowBridgeError("INVALID_REQUEST","budget confirm-no-charge requires --job <id> --attempt <failed-attempt-id>");print(await engine.confirmNoCharge(jobId,attemptId));
  } else if(command==="workspace"&&args[1]==="project"&&args[2]==="list") {
    print(workspace.listProjects());
  } else if(command==="workspace"&&args[1]==="project"&&args[2]==="add") {
    const name=requiredFlag("--name");print(workspace.createProject({id:flag("--id"),name}));
  } else if(command==="workspace"&&args[1]==="entity"&&args[2]==="add") {
    print(workspace.createEntity({id:flag("--id"),projectId:requiredFlag("--project"),displayName:requiredFlag("--name"),kind:flag("--kind")}));
  } else if(command==="workspace"&&args[1]==="entity"&&args[2]==="revise") {
    const locator=flag("--locator"),source={kind:requiredFlag("--source-kind") as "local"|"provider"|"generated",...(locator?{locator}:{}),...(flag("--provider-media-id")?{providerMediaId:flag("--provider-media-id")}:{})};
    print(workspace.addReferenceVersion({entityId:requiredFlag("--entity"),sha256:requiredFlag("--sha256"),role:requiredFlag("--role") as "identity"|"start_frame"|"end_frame",source}));
  } else if(command==="workspace"&&args[1]==="scene"&&args[2]==="plan") {
    print(workspace.createScenePlan({projectId:requiredFlag("--project"),sceneId:flag("--id"),ordinal:positiveIntegerFlag("--ordinal"),prompt:requiredFlag("--prompt"),modelPolicy:await workspaceModelPolicy(),referenceVersionIds:csvFlag("--references")}));
  } else if(command==="workspace"&&args[1]==="scene"&&args[2]==="revise") {
    const input:{sceneId:string;prompt?:string;modelPolicy?:WorkspaceModelPolicy;referenceVersionIds?:string[]}={sceneId:requiredFlag("--scene")};if(flag("--prompt")!==undefined)input.prompt=flag("--prompt");if(flag("--model")!==undefined||flag("--capability-observation")!==undefined)input.modelPolicy=await workspaceModelPolicy();if(flag("--references")!==undefined)input.referenceVersionIds=csvFlag("--references");print(workspace.reviseScene(input));
  } else if(command==="workspace"&&args[1]==="scene"&&args[2]==="depend") {
    print(workspace.addDependency({sceneId:requiredFlag("--scene"),dependsOnSceneId:requiredFlag("--on")}));
  } else if(command==="workspace"&&args[1]==="scene"&&args[2]==="status") {
    print(workspace.sceneStatus(requiredFlag("--scene")));
  } else if(command==="workspace"&&args[1]==="scene"&&args[2]==="list") {
    print(workspace.listScenes(requiredFlag("--project")));
  } else if(command==="workspace"&&args[1]==="scene"&&args[2]==="export-request") {
    const sceneId=requiredFlag("--scene"),status=workspace.sceneStatus(sceneId);if(status.state!=="RUNNABLE")throw new FlowBridgeError("UNSUPPORTED_COMBINATION","Scene cannot export an executable request until its blockers are resolved",{state:status.state,blockers:status.blockers});const mode=requiredFlag("--mode") as "text_to_video"|"extend_video"|"first_frame_to_video"|"first_last_frames_to_video"|"ingredients_to_video"|"edit_video",sourceVideo=flag("--source-video");const external=workspace.buildExternalRequest({sceneId,idempotencyKey:requiredFlag("--idempotency-key"),project:{name:requiredFlag("--project-name"),reuse:true},mode,...(sourceVideo?{sourceVideo:{path:resolve(sourceVideo)}}:{}),aspectRatio:requiredFlag("--aspect-ratio") as "16:9"|"9:16",durationSeconds:positiveIntegerFlag("--duration-seconds"),resolution:requiredFlag("--resolution"),outputs:positiveIntegerFlag("--outputs"),budgetLedgerId:requiredFlag("--budget-ledger"),budgetStepKey:requiredFlag("--budget-step")});const out=resolve(requiredFlag("--out"));await mkdir(dirname(out),{recursive:true});await writeFile(out,`${JSON.stringify(external,null,2)}\n`,{flag:"wx"});const job=await engine.create(normalizeExternalRequest(external)),candidate=workspace.bindExistingJob({sceneId,jobId:job.id,requestHash:job.requestHash,budgetLedgerId:external.budget_group.ledger_id,budgetStepKey:external.budget_group.step_key});print({requestFile:out,job,candidate,contractStatus:mode==="edit_video"?"TICKET_CONTRACT_PREPARED_BROWSER_UNVERIFIED":"IMMUTABLE_REQUEST_PREPARED",next:"Import a fresh existing-browser observation, then run browser prepare for this job. No provider effect has occurred."});
  } else if(command==="workspace"&&args[1]==="dispatch-to-existing-job") {
    const sceneId=requiredFlag("--scene"),jobId=requiredFlag("--job"),job=storage.getJob(jobId);if(!job)throw new FlowBridgeError("INVALID_REQUEST","Existing job not found");const request=JSON.parse(storage.getRequestJson(jobId));if(request.provider!=="flow_ui")throw new FlowBridgeError("INVALID_REQUEST","Workspace dispatch accepts an existing flow_ui job only");if(!request.budgetContext?.ledgerId||!request.budgetContext?.stepKey)throw new FlowBridgeError("INVALID_REQUEST","Existing job has no shared budget binding");const base=request.modelPolicy??createModelPolicy(request.model,"explicit"),observed=job.runtimeSnapshot?.observedProviderFamily,capabilityState=observed===base.requiredFamily?"supported":observed?"unsupported":"unknown";const policy:WorkspaceModelPolicy={...base,capabilityState,unsupportedReason:observed&&observed!==base.requiredFamily?`Observed ${observed}; required ${base.requiredFamily}`:undefined,evidenceDate:job.runtimeSnapshot?.capabilityCapture?.capturedAt??job.runtimeSnapshot?.capturedAt};print(workspace.bindExistingJob({sceneId,jobId,requestHash:job.requestHash,budgetLedgerId:request.budgetContext.ledgerId,budgetStepKey:request.budgetContext.stepKey,modelPolicy:policy}));
  } else if(command==="generate") {
    const file=flag("--file"); if(!file) throw new FlowBridgeError("INVALID_REQUEST","generate requires --file <request.json>");
    const external=JSON.parse(await readFile(resolve(file),"utf8"));
    if(external.backend==="mock"&&!args.includes("--enable-mock")) throw new FlowBridgeError("PROVIDER_UNAVAILABLE","Mock provider requires explicit --enable-mock");
    const job=await engine.create(normalizeExternalRequest(external));
    const started=args.includes("--no-run")?job:await engine.run(job.id);
    printJob(args.includes("--wait")?await engine.wait(started.id,{timeoutMs:flag("--timeout-ms")?Number(flag("--timeout-ms")):undefined}):started);
  } else if(command==="status") printJob(engine.get(args[1] ?? ""));
  else if(command==="resume") {const resumed=await engine.run(args[1] ?? "");printJob(args.includes("--wait")?await engine.wait(resumed.id,{timeoutMs:flag("--timeout-ms")?Number(flag("--timeout-ms")):undefined}):resumed);}
  else if(command==="cancel") printJob(engine.cancel(args[1] ?? ""));
  else if(command==="download") printJob(await engine.download(args[1] ?? ""));
  else throw new FlowBridgeError("INVALID_REQUEST","Usage: flowctl doctor | auth open|status | credits | capabilities | budget create|status --id <ledger_id> | workspace project|entity|scene|dispatch-to-existing-job ... | generate --file request.json [--enable-mock] | status|resume|cancel|download <job>");
} catch(error) {
  const e=error instanceof FlowBridgeError?error:new FlowBridgeError("INVALID_REQUEST",error instanceof Error?error.message:String(error));
  print({error:{code:e.code,message:e.message,details:e.details}});
  process.exitCode=e.code==="INSUFFICIENT_CREDITS"?5:e.code==="COST_UNKNOWN"||e.code==="COST_LIMIT_EXCEEDED"?4:e.code==="IDEMPOTENCY_CONFLICT"?2:e.code==="SUBMISSION_UNCERTAIN"?8:2;
} finally { storage.close(); }

function validateObservation(value:unknown):ExistingBrowserObservation {const observation=parseExistingBrowserObservation(value);if(Date.now()-Date.parse(observation.observedAt)>60_000||Date.parse(observation.observedAt)-Date.now()>5_000)throw new FlowBridgeError("INVALID_REQUEST","Existing-browser observation is stale or has an invalid future timestamp");return observation;}
function requireCurrentObservation(storage:Storage):ExistingBrowserObservation {const value=storage.getBrowserObservation();if(!value)throw new FlowBridgeError("AUTH_REQUIRED","No current existing-browser observation; use the Codex browser tool and import one",{reason:"EXISTING_SESSION_REQUIRED"});return validateObservation(value);}
function requiredFlag(name:string):string {const value=flag(name);if(!value)throw new FlowBridgeError("INVALID_REQUEST",`${name} is required`);return value;}
function positiveIntegerFlag(name:string):number {const value=Number(requiredFlag(name));if(!Number.isInteger(value)||value<1)throw new FlowBridgeError("INVALID_REQUEST",`${name} must be a positive integer`);return value;}
function csvFlag(name:string):string[] {const value=flag(name);return value?value.split(",").map(x=>x.trim()).filter(Boolean):[];}
async function workspaceModelPolicy():Promise<WorkspaceModelPolicy> {const explicit=flag("--model"),base=createModelPolicy(explicit,explicit?"explicit":"default"),file=flag("--capability-observation");if(!file)return {...base,capabilityState:"unknown"};const observation=validateObservation(JSON.parse(await readFile(resolve(file),"utf8")));if(!observation.configuration)throw new FlowBridgeError("UNSUPPORTED_COMBINATION","Capability observation has no complete visible configuration");const observed=createModelPolicy(observation.configuration.model,"explicit"),supported=observed.requiredFamily===base.requiredFamily;return {...base,capabilityState:supported?"supported":"unsupported",unsupportedReason:supported?undefined:`Observed ${observed.requiredFamily}; required ${base.requiredFamily}`,evidenceDate:observation.observedAt};}
