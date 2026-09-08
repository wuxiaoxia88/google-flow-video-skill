#!/usr/bin/env node
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { FlowBridgeError, normalizeExternalRequest, type ExistingBrowserObservation, type FlowProvider } from "../../../packages/contracts/src/index.js";
import { JobEngine, MockProvider } from "../../../packages/job-engine/src/index.js";
import { Storage } from "../../../packages/storage/src/index.js";
import { FlowBrowserSession, FlowUiProvider, authorizeDedicatedCompatibility, ownFlowPage, parseExistingBrowserObservation } from "../../../packages/flow-adapter/src/index.js";
import { chromium } from "playwright";

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
  else throw new FlowBridgeError("INVALID_REQUEST","Usage: flowctl doctor | auth open|status | credits | capabilities | budget create|status --id <ledger_id> | generate --file request.json [--enable-mock] | status|resume|cancel|download <job>");
} catch(error) {
  const e=error instanceof FlowBridgeError?error:new FlowBridgeError("INVALID_REQUEST",error instanceof Error?error.message:String(error));
  print({error:{code:e.code,message:e.message,details:e.details}});
  process.exitCode=e.code==="INSUFFICIENT_CREDITS"?5:e.code==="COST_UNKNOWN"||e.code==="COST_LIMIT_EXCEEDED"?4:e.code==="IDEMPOTENCY_CONFLICT"?2:e.code==="SUBMISSION_UNCERTAIN"?8:2;
} finally { storage.close(); }

function validateObservation(value:unknown):ExistingBrowserObservation {const observation=parseExistingBrowserObservation(value);if(Date.now()-Date.parse(observation.observedAt)>60_000||Date.parse(observation.observedAt)-Date.now()>5_000)throw new FlowBridgeError("INVALID_REQUEST","Existing-browser observation is stale or has an invalid future timestamp");return observation;}
function requireCurrentObservation(storage:Storage):ExistingBrowserObservation {const value=storage.getBrowserObservation();if(!value)throw new FlowBridgeError("AUTH_REQUIRED","No current existing-browser observation; use the Codex browser tool and import one",{reason:"EXISTING_SESSION_REQUIRED"});return validateObservation(value);}
