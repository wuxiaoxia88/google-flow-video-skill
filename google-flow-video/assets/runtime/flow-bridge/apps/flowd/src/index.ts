import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { FlowBridgeError, normalizeExternalRequest, type FlowProvider } from "../../../packages/contracts/src/index.js";
import { JobEngine, MockProvider } from "../../../packages/job-engine/src/index.js";
import { Storage } from "../../../packages/storage/src/index.js";
import { FlowUiProvider, parseExistingBrowserObservation } from "../../../packages/flow-adapter/src/index.js";
import { ProductionWorkspace } from "../../../packages/production-workspace/src/index.js";

const dbPath=resolve(process.env.FLOWBRIDGE_DB_PATH??"data/flowbridge.sqlite");
const tokenPath=resolve(process.env.FLOWBRIDGE_TOKEN_PATH??"data/token");
await mkdir(dirname(dbPath),{recursive:true,mode:0o700}); await mkdir(dirname(tokenPath),{recursive:true,mode:0o700});await chmod(dirname(tokenPath),0o700);
let token:string; try{token=(await readFile(tokenPath,"utf8")).trim();if(token.length<32)throw new Error("invalid token");await chmod(tokenPath,0o600);}catch{token=randomBytes(32).toString("hex");await writeFile(tokenPath,`${token}\n`,{mode:0o600});}
const storage=new Storage(dbPath), providers=new Map<string,FlowProvider>([["flow_ui",new FlowUiProvider()]]);
if(process.env.FLOWBRIDGE_ENABLE_MOCK==="1") providers.set("mock",new MockProvider(process.env.FLOWBRIDGE_MOCK_COST?Number(process.env.FLOWBRIDGE_MOCK_COST):4));
const engine=new JobEngine(storage,providers), app=Fastify({logger:false,bodyLimit:1_000_000});
const workspace=new ProductionWorkspace(storage);
const dashboardDir=resolve(dirname(fileURLToPath(import.meta.url)),"../dashboard");
const dashboardAssets=new Map([["/dashboard/",["index.html","text/html; charset=utf-8"]],["/dashboard/app.css",["app.css","text/css; charset=utf-8"]],["/dashboard/app.js",["app.js","text/javascript; charset=utf-8"]]] as const);
app.setErrorHandler((error,_request,reply)=>{const e=error instanceof FlowBridgeError?error:new FlowBridgeError("INVALID_REQUEST",error instanceof Error?error.message:String(error));void reply.code(e.code==="INVALID_REQUEST"?404:400).send({error:{code:e.code,message:e.message,details:e.details}});});
app.addHook("onRequest",async(req,reply)=>{
  if(req.url==="/healthz"||req.url==="/dashboard"||dashboardAssets.has(req.url as any))return;
  if(req.headers.authorization!==`Bearer ${token}`){await reply.code(401).send({error:{code:"UNAUTHORIZED",message:"Bearer token required"}});return reply;}
  const host=req.headers.host??""; if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)){await reply.code(403).send({error:{code:"INVALID_HOST",message:"Loopback Host required"}});return reply;}
  const origin=req.headers.origin; if(origin&&!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)){await reply.code(403).send({error:{code:"INVALID_ORIGIN",message:"Cross-site browser requests are refused"}});return reply;}
});
app.setNotFoundHandler((req,reply)=>{
  const host=req.headers.host??"", origin=req.headers.origin;
  if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))return reply.code(403).send({error:{code:"INVALID_HOST",message:"Loopback Host required"}});
  if(origin&&!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin))return reply.code(403).send({error:{code:"INVALID_ORIGIN",message:"Cross-site browser requests are refused"}});
  return reply.code(404).send({error:{code:"NOT_FOUND",message:"Route not found"}});
});
app.get("/healthz",async()=>({ok:true}));
app.get("/dashboard",async(_req,reply)=>reply.redirect("/dashboard/"));
for(const [route,[file,type]] of dashboardAssets) app.get(route,async(_req,reply)=>reply.type(type).send(await readFile(resolve(dashboardDir,file))));
app.get("/v1/videos/:id",async req=>engine.get((req.params as {id:string}).id));
app.get("/v1/production/projects/:id/dashboard",async req=>productionDashboard((req.params as {id:string}).id));
app.post("/v1/browser/observations",async req=>{const observation=parseExistingBrowserObservation(req.body);storage.saveBrowserObservation(observation);return {connected:true,mode:"existing_browser",browserId:observation.browserId,tabId:observation.tabId,projectRef:observation.projectRef,observedAt:observation.observedAt};});
app.post("/v1/browser/tickets",async req=>{const body=req.body as {jobId:string;observation:unknown};return engine.prepareExistingBrowser(body.jobId,parseExistingBrowserObservation(body.observation));});
app.post("/v1/browser/tickets/:id/claim",async req=>engine.claimExistingBrowser((req.params as {id:string}).id,parseExistingBrowserObservation(req.body)));
app.post("/v1/browser/tickets/:id/receipt",async req=>{const body=req.body as {outcome:"clicked"|"uncertain"|"reconciled";evidence?:Record<string,unknown>};return engine.receiptExistingBrowser((req.params as {id:string}).id,body.outcome,body.evidence);});
app.post("/v1/browser/tickets/:id/complete",async req=>engine.completeExistingBrowser((req.params as {id:string}).id,req.body as any));
app.post("/v1/videos",async(req,reply)=>{try{const external=req.body as any;if(external?.backend==="mock"&&process.env.FLOWBRIDGE_ENABLE_MOCK!=="1")throw new FlowBridgeError("PROVIDER_UNAVAILABLE","Mock provider is disabled");const job=await engine.create(normalizeExternalRequest(external));return await engine.run(job.id);}catch(error){const e=error instanceof FlowBridgeError?error:new FlowBridgeError("INVALID_REQUEST",String(error));return reply.code(e.code==="COST_LIMIT_EXCEEDED"||e.code==="COST_UNKNOWN"?409:400).send({error:{code:e.code,message:e.message,details:e.details}});}});
app.post("/v1/videos/:id/cancel",async req=>engine.cancel((req.params as {id:string}).id));
app.post("/v1/videos/:id/resume",async req=>engine.run((req.params as {id:string}).id));
const port=Number(process.env.FLOWBRIDGE_PORT??43117);
const shutdown=async()=>{await app.close();storage.close();};process.on("SIGINT",()=>void shutdown());process.on("SIGTERM",()=>void shutdown());
await app.listen({host:"127.0.0.1",port});
process.stdout.write(`${JSON.stringify({ok:true,host:"127.0.0.1",port,dashboardUrl:`http://127.0.0.1:${port}/dashboard/`,tokenPath,dbPath})}\n`);

function productionDashboard(projectId:string){
  const snapshot=workspace.dashboardSnapshot(projectId);
  const scenes=snapshot.scenes.map(item=>{
    const latest=item.candidates.at(-1),job=latest?storage.getJob(latest.jobId):null,ledger=latest?storage.getBudgetLedger(latest.budgetLedgerId):null;
    const revision=storage.db.prepare("SELECT model_policy_json FROM pw_scene_revisions WHERE id=?").get(item.scene.currentRevisionId) as {model_policy_json:string}|undefined;
    const referenceVersionIds=(storage.db.prepare("SELECT reference_version_id id FROM pw_revision_references WHERE revision_id=? ORDER BY position").all(item.scene.currentRevisionId) as Array<{id:string}>).map(x=>x.id);
    const relations=(storage.db.prepare("SELECT depends_on_scene_id id FROM pw_scene_dependencies WHERE scene_id=? ORDER BY depends_on_scene_id").all(item.scene.id) as Array<{id:string}>).map(x=>x.id);
    const policy=latest?.modelPolicy??(revision?JSON.parse(revision.model_policy_json):{}),steps=latest?storage.getBudgetSteps(latest.budgetLedgerId):[];
    const unknownCredits=steps.filter(x=>x.state==="RESERVED").reduce((n,x)=>n+x.quotedCredits,0);
    return {id:item.scene.id,ordinal:item.scene.ordinal,stage:job?.state??item.status.state,referenceVersionIds,requestedModel:policy.apiCode??policy.requiredFamily??null,actualModel:job?.runtimeSnapshot?.model??null,budget:{capCredits:ledger?.capCredits??0,reservedCredits:ledger?.reservedCredits??0,consumedCredits:ledger?.consumedCredits??0,unknownCredits},blocker:[...item.status.blockers,...(latest?.blockers??[])].filter((x,i,a)=>a.indexOf(x)===i).join("; ")||null,qcStatus:job?.state==="COMPLETED"?"technical_complete":"not_run",editRelations:relations,candidateState:latest?.state??null,nextSafeOperation:latest?.nextSafeOperation??null};
  });
  const ledgerIds=[...new Set(snapshot.scenes.flatMap(x=>x.candidates.map(c=>c.budgetLedgerId)))];
  const budget=ledgerIds.reduce((out,id)=>{const ledger=storage.getBudgetLedger(id),steps=storage.getBudgetSteps(id);return {reservedCredits:out.reservedCredits+(ledger?.reservedCredits??0),consumedCredits:out.consumedCredits+(ledger?.consumedCredits??0),unknownCredits:out.unknownCredits+steps.filter(x=>x.state==="RESERVED").reduce((n,x)=>n+x.quotedCredits,0)};},{reservedCredits:0,consumedCredits:0,unknownCredits:0});
  return {project:snapshot.project,entities:snapshot.entities.map(x=>({id:x.id,displayName:x.displayName,kind:x.kind})),scenes,budget};
}
