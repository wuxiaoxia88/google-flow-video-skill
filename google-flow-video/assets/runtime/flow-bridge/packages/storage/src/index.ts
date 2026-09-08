import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { FlowBridgeError, type BrowserExecutionTicket, type BudgetLedger, type BudgetStep, type ExistingBrowserObservation, type JobRecord, type JobState, type LegacyBaselineAttestationEvidence, type ProviderAsset, type ProviderKind, type RuntimeSubmissionSnapshot } from "../../contracts/src/index.js";

export class Storage {
  readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }
  close() { this.db.close(); }
  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL, request_json TEXT NOT NULL, final_prompt_sha256 TEXT NOT NULL,
        state TEXT NOT NULL, runtime_snapshot_json TEXT, error_code TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(provider, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS submission_attempts (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL, ordinal INTEGER NOT NULL DEFAULT 1, attempt_status TEXT NOT NULL DEFAULT 'ACTIVE', fencing_token TEXT NOT NULL,
        request_hash TEXT NOT NULL, snapshot_json TEXT NOT NULL, intent_recorded_at TEXT NOT NULL,
        evidence_json TEXT, FOREIGN KEY(job_id) REFERENCES jobs(id), UNIQUE(job_id,ordinal)
      );
      CREATE TABLE IF NOT EXISTS job_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, state TEXT NOT NULL,
        event_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assets (
        provider_asset_ref TEXT NOT NULL, job_id TEXT NOT NULL, payload_json TEXT NOT NULL,
        local_path TEXT, sha256 TEXT, created_at TEXT NOT NULL,
        PRIMARY KEY(job_id, provider_asset_ref), FOREIGN KEY(job_id) REFERENCES jobs(id)
      );
      CREATE TABLE IF NOT EXISTS browser_execution_tickets (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt_id TEXT NOT NULL, action TEXT NOT NULL,
        status TEXT NOT NULL, browser_id TEXT NOT NULL, tab_id TEXT NOT NULL, project_ref TEXT NOT NULL,
        request_hash TEXT NOT NULL, snapshot_json TEXT NOT NULL, issued_at TEXT NOT NULL, receipt_json TEXT,
        FOREIGN KEY(job_id) REFERENCES jobs(id)
      );
      CREATE TABLE IF NOT EXISTS browser_observations (
        id INTEGER PRIMARY KEY CHECK(id=1), payload_json TEXT NOT NULL, imported_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS browser_baseline_attestations (
        attempt_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, request_hash TEXT NOT NULL,
        project_ref TEXT NOT NULL, browser_id TEXT NOT NULL, tab_id TEXT NOT NULL,
        captured_at TEXT NOT NULL, source_observation_path TEXT NOT NULL,
        source_observation_sha256 TEXT NOT NULL, baseline_asset_refs_json TEXT NOT NULL,
        attested_at TEXT NOT NULL, reason TEXT NOT NULL CHECK(reason='legacy_mapping_defect'),
        FOREIGN KEY(job_id) REFERENCES jobs(id), FOREIGN KEY(attempt_id) REFERENCES submission_attempts(id)
      );
      CREATE TABLE IF NOT EXISTS browser_execution_leases (
        browser_id TEXT NOT NULL, tab_id TEXT NOT NULL, project_ref TEXT NOT NULL,
        job_id TEXT NOT NULL, acquired_at TEXT NOT NULL,
        PRIMARY KEY(browser_id,tab_id,project_ref), FOREIGN KEY(job_id) REFERENCES jobs(id)
      );
      CREATE TABLE IF NOT EXISTS budget_ledgers (
        parent_id TEXT PRIMARY KEY, cap_credits INTEGER NOT NULL CHECK(cap_credits=50),
        reserved_credits INTEGER NOT NULL DEFAULT 0, consumed_credits INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS budget_steps (
        parent_id TEXT NOT NULL, step_key TEXT NOT NULL, quoted_credits INTEGER NOT NULL CHECK(quoted_credits>=0),
        state TEXT NOT NULL CHECK(state IN ('RESERVED','CONSUMED','NOT_CHARGED')), created_at TEXT NOT NULL,
        job_id TEXT, request_hash TEXT,
        PRIMARY KEY(parent_id, step_key), FOREIGN KEY(parent_id) REFERENCES budget_ledgers(parent_id)
      );
      CREATE TABLE IF NOT EXISTS budget_no_charge_confirmations (
        attempt_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, parent_id TEXT NOT NULL, step_key TEXT NOT NULL,
        quoted_credits INTEGER NOT NULL, source_evidence_sha256 TEXT NOT NULL, evidence_json TEXT NOT NULL,
        confirmed_at TEXT NOT NULL, FOREIGN KEY(job_id) REFERENCES jobs(id), FOREIGN KEY(parent_id,step_key) REFERENCES budget_steps(parent_id,step_key)
      );
    `);
    const attemptSql=String((this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='submission_attempts'").get() as {sql:string}).sql);
    if(/job_id TEXT NOT NULL UNIQUE/.test(attemptSql)){
      this.db.pragma("foreign_keys = OFF");this.db.pragma("legacy_alter_table = ON");
      this.db.exec(`ALTER TABLE submission_attempts RENAME TO submission_attempts_v1;
        CREATE TABLE submission_attempts (id TEXT PRIMARY KEY,job_id TEXT NOT NULL,ordinal INTEGER NOT NULL DEFAULT 1,attempt_status TEXT NOT NULL DEFAULT 'ACTIVE',fencing_token TEXT NOT NULL,request_hash TEXT NOT NULL,snapshot_json TEXT NOT NULL,intent_recorded_at TEXT NOT NULL,evidence_json TEXT,FOREIGN KEY(job_id) REFERENCES jobs(id),UNIQUE(job_id,ordinal));
        INSERT INTO submission_attempts(id,job_id,ordinal,attempt_status,fencing_token,request_hash,snapshot_json,intent_recorded_at,evidence_json) SELECT id,job_id,1,'ACTIVE',fencing_token,request_hash,snapshot_json,intent_recorded_at,evidence_json FROM submission_attempts_v1;
        DROP TABLE submission_attempts_v1;`);
      this.db.pragma("legacy_alter_table = OFF");this.db.pragma("foreign_keys = ON");
      const fk=this.db.prepare("PRAGMA foreign_key_check").all();if(fk.length)throw new Error(`submission attempt migration broke foreign keys: ${JSON.stringify(fk)}`);
    }
    const attemptColumns=(this.db.prepare("PRAGMA table_info(submission_attempts)").all() as Array<{name:string}>).map(x=>x.name);
    if(!attemptColumns.includes("ordinal")) this.db.exec("ALTER TABLE submission_attempts ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 1");
    if(!attemptColumns.includes("attempt_status")) this.db.exec("ALTER TABLE submission_attempts ADD COLUMN attempt_status TEXT NOT NULL DEFAULT 'ACTIVE'");
    const budgetSql=String((this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='budget_steps'").get() as {sql:string}).sql);
    if(!budgetSql.includes("NOT_CHARGED")){this.db.pragma("foreign_keys = OFF");this.db.pragma("legacy_alter_table = ON");this.db.exec(`ALTER TABLE budget_steps RENAME TO budget_steps_v1;CREATE TABLE budget_steps(parent_id TEXT NOT NULL,step_key TEXT NOT NULL,quoted_credits INTEGER NOT NULL CHECK(quoted_credits>=0),state TEXT NOT NULL CHECK(state IN ('RESERVED','CONSUMED','NOT_CHARGED')),created_at TEXT NOT NULL,job_id TEXT,request_hash TEXT,PRIMARY KEY(parent_id,step_key),FOREIGN KEY(parent_id) REFERENCES budget_ledgers(parent_id));INSERT INTO budget_steps SELECT * FROM budget_steps_v1;DROP TABLE budget_steps_v1;`);this.db.pragma("legacy_alter_table = OFF");this.db.pragma("foreign_keys = ON");const fk=this.db.prepare("PRAGMA foreign_key_check").all();if(fk.length)throw new Error(`budget migration broke foreign keys: ${JSON.stringify(fk)}`);}
    for(const sql of ["ALTER TABLE browser_baseline_attestations ADD COLUMN record_type TEXT NOT NULL DEFAULT 'pre_submit_observation'","ALTER TABLE browser_baseline_attestations ADD COLUMN evidence_json TEXT"])try{this.db.exec(sql);}catch(error){if(!String(error).includes("duplicate column name"))throw error;}
  }
  createOrGet(input: { provider: ProviderKind; idempotencyKey: string; requestHash: string; requestJson: string; finalPromptSha256: string }): { job: JobRecord; created: boolean } {
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM jobs WHERE provider=? AND idempotency_key=?").get(input.provider, input.idempotencyKey) as Row | undefined;
      if (existing) return { job: rowToJob(existing), created: false };
      const now = new Date().toISOString(), id = `job_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      this.db.prepare(`INSERT INTO jobs(id,provider,idempotency_key,request_hash,request_json,final_prompt_sha256,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?, ?,?)`)
        .run(id, input.provider, input.idempotencyKey, input.requestHash, input.requestJson, input.finalPromptSha256, "CREATED", now, now);
      return { job: this.getJob(id)!, created: true };
    })();
  }
  getJob(id: string): JobRecord | null { const row = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as Row | undefined; return row ? {...rowToJob(row),assets:this.getAssets(id)} : null; }
  getRequestJson(id: string): string { const row = this.db.prepare("SELECT request_json FROM jobs WHERE id=?").get(id) as {request_json:string}|undefined; if (!row) throw new Error("job not found"); return row.request_json; }
  transition(id: string, state: JobState, errorCode: string | null = null) {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare("UPDATE jobs SET state=?,error_code=?,updated_at=? WHERE id=?").run(state,errorCode,now,id);
      this.db.prepare("INSERT INTO job_events(job_id,state,event_type,payload_json,created_at) VALUES(?,?,?,?,?)").run(id,state,"STATE_CHANGED","{}",now);
      if (["GENERATED","COMPLETED","PARTIALLY_COMPLETED","FAILED","CANCELLED_PRE_SUBMIT"].includes(state)) this.db.prepare("DELETE FROM browser_execution_leases WHERE job_id=?").run(id);
    })();
  }
  recordIntent(jobId: string, requestHash: string, snapshot: RuntimeSubmissionSnapshot): { attemptId: string; fencingToken: string; existed: boolean } {
    return this.db.transaction(() => this.recordIntentUnsafe(jobId, requestHash, snapshot))();
  }
  /** Atomically reserves one current-browser binding and persists its intent. */
  reserveExistingBrowserIntent(input: { jobId: string; requestHash: string; snapshot: RuntimeSubmissionSnapshot; browserId: string; tabId: string; projectRef: string; budget?: { ledgerId: string; stepKey: string; quotedCredits: number } }): { attemptId: string; fencingToken: string; existed: boolean } {
    return this.db.transaction(() => {
      const lease = this.db.prepare("SELECT job_id FROM browser_execution_leases WHERE browser_id=? AND tab_id=? AND project_ref=?").get(input.browserId,input.tabId,input.projectRef) as {job_id:string}|undefined;
      if (lease && lease.job_id !== input.jobId) {
        const holder = this.db.prepare("SELECT state FROM jobs WHERE id=?").get(lease.job_id) as {state:JobState}|undefined;
        if (holder && !["COMPLETED","PARTIALLY_COMPLETED","FAILED","CANCELLED_PRE_SUBMIT","GENERATED"].includes(holder.state)) throw new FlowBridgeError("PROVIDER_UNAVAILABLE", "Existing Flow browser tab/project is leased by another unfinished job.", { reason: "BROWSER_SESSION_BUSY", holderJobId: lease.job_id });
        this.db.prepare("DELETE FROM browser_execution_leases WHERE browser_id=? AND tab_id=? AND project_ref=?").run(input.browserId,input.tabId,input.projectRef);
      }
      if (input.budget) this.reserveBudgetStepUnsafe(input.budget.ledgerId,input.budget.stepKey,input.budget.quotedCredits,{jobId:input.jobId,requestHash:input.requestHash});
      this.db.prepare("INSERT OR IGNORE INTO browser_execution_leases(browser_id,tab_id,project_ref,job_id,acquired_at) VALUES(?,?,?,?,?)").run(input.browserId,input.tabId,input.projectRef,input.jobId,new Date().toISOString());
      return this.recordIntentUnsafe(input.jobId,input.requestHash,input.snapshot);
    })();
  }
  releaseExistingBrowserLease(jobId: string): void { this.db.prepare("DELETE FROM browser_execution_leases WHERE job_id=?").run(jobId); }
  private recordIntentUnsafe(jobId: string, requestHash: string, snapshot: RuntimeSubmissionSnapshot): { attemptId: string; fencingToken: string; existed: boolean } {
    const current = this.db.prepare("SELECT * FROM submission_attempts WHERE job_id=? AND attempt_status='ACTIVE' ORDER BY ordinal DESC LIMIT 1").get(jobId) as AttemptRow|undefined;
    if (current) return { attemptId: current.id, fencingToken: current.fencing_token, existed: true };
    const attemptId = `attempt_${randomUUID()}`, fencingToken = randomUUID(), now = new Date().toISOString();
    const ordinal=((this.db.prepare("SELECT max(ordinal) n FROM submission_attempts WHERE job_id=?").get(jobId) as {n:number|null}).n??0)+1;
    this.db.prepare("INSERT INTO submission_attempts(id,job_id,ordinal,attempt_status,fencing_token,request_hash,snapshot_json,intent_recorded_at) VALUES(?,?,?,'ACTIVE',?,?,?,?)")
      .run(attemptId,jobId,ordinal,fencingToken,requestHash,JSON.stringify(snapshot),now);
    this.db.prepare("UPDATE jobs SET state='SUBMITTING',runtime_snapshot_json=?,updated_at=? WHERE id=?").run(JSON.stringify(snapshot),now,jobId);
    this.db.prepare("INSERT INTO job_events(job_id,state,event_type,payload_json,created_at) VALUES(?,?,?,?,?)").run(jobId,"SUBMITTING","SUBMISSION_INTENT_RECORDED",JSON.stringify({attemptId}),now);
    return { attemptId, fencingToken, existed: false };
  }
  getIntent(jobId: string): AttemptRow | null { return (this.db.prepare("SELECT * FROM submission_attempts WHERE job_id=? AND attempt_status='ACTIVE' ORDER BY ordinal DESC LIMIT 1").get(jobId) as AttemptRow|undefined) ?? null; }
  getLatestAttempt(jobId:string):AttemptRow|null{return (this.db.prepare("SELECT * FROM submission_attempts WHERE job_id=? ORDER BY ordinal DESC LIMIT 1").get(jobId) as AttemptRow|undefined)??null;}
  confirmProviderFailure(jobId:string,attemptId:string,payload:Record<string,unknown>):void{this.db.transaction(()=>{const a=this.db.prepare("SELECT attempt_status FROM submission_attempts WHERE id=? AND job_id=?").get(attemptId,jobId) as {attempt_status:string}|undefined;if(!a||a.attempt_status!=="ACTIVE")throw new Error("ATTEMPT_NOT_ACTIVE");const now=new Date().toISOString();this.db.prepare("UPDATE submission_attempts SET attempt_status='FAILED' WHERE id=?").run(attemptId);this.db.prepare("UPDATE jobs SET state='FAILED',error_code='PROVIDER_FAILURE',updated_at=? WHERE id=?").run(now,jobId);this.db.prepare("INSERT INTO job_events(job_id,state,event_type,payload_json,created_at) VALUES(?,'FAILED','PROVIDER_FAILURE_CONFIRMED',?,?)").run(jobId,JSON.stringify(payload),now);this.db.prepare("DELETE FROM browser_execution_leases WHERE job_id=?").run(jobId);})();}
  reserveControlledRetryIntent(input:{jobId:string;requestHash:string;snapshot:RuntimeSubmissionSnapshot;browserId:string;tabId:string;projectRef:string;budget:{ledgerId:string;stepKey:string;quotedCredits:number}}){return this.db.transaction(()=>{const job=this.db.prepare("SELECT request_hash FROM jobs WHERE id=?").get(input.jobId) as {request_hash:string}|undefined,attempts=this.db.prepare("SELECT * FROM submission_attempts WHERE job_id=? ORDER BY ordinal").all(input.jobId) as AttemptRow[];if(!job||job.request_hash!==input.requestHash||attempts.length!==1||attempts[0].request_hash!==input.requestHash||attempts[0].attempt_status!=="FAILED"||this.getIntent(input.jobId))throw new Error("RETRY_NOT_ELIGIBLE");this.reserveBudgetStepUnsafe(input.budget.ledgerId,input.budget.stepKey,input.budget.quotedCredits,{jobId:input.jobId,requestHash:input.requestHash});this.db.prepare("INSERT INTO browser_execution_leases(browser_id,tab_id,project_ref,job_id,acquired_at) VALUES(?,?,?,?,?)").run(input.browserId,input.tabId,input.projectRef,input.jobId,new Date().toISOString());const x=this.recordIntentUnsafe(input.jobId,input.requestHash,input.snapshot);this.db.prepare("INSERT INTO job_events(job_id,state,event_type,payload_json,created_at) VALUES(?,'SUBMITTING','CONTROLLED_RETRY_INTENT_RECORDED',?,?)").run(input.jobId,JSON.stringify({attemptId:x.attemptId,ordinal:2}),new Date().toISOString());return x;})();}
  reserveUserResumeIntent(input:{jobId:string;requestHash:string;snapshot:RuntimeSubmissionSnapshot;browserId:string;tabId:string;projectRef:string;budget:{ledgerId:string;stepKey:string;quotedCredits:number};audit:Record<string,unknown>}){return this.db.transaction(()=>{const job=this.db.prepare("SELECT request_hash FROM jobs WHERE id=?").get(input.jobId) as {request_hash:string}|undefined,attempts=this.db.prepare("SELECT * FROM submission_attempts WHERE job_id=? ORDER BY ordinal").all(input.jobId) as AttemptRow[];if(!job||job.request_hash!==input.requestHash||attempts.length!==1||attempts[0].request_hash!==input.requestHash||attempts[0].attempt_status!=="ACTIVE")throw new Error("USER_RESUME_NOT_ELIGIBLE");this.reserveBudgetStepUnsafe(input.budget.ledgerId,input.budget.stepKey,input.budget.quotedCredits,{jobId:input.jobId,requestHash:input.requestHash});this.db.prepare("UPDATE submission_attempts SET attempt_status='UNRESOLVED' WHERE id=? AND attempt_status='ACTIVE'").run(attempts[0].id);this.db.prepare("DELETE FROM browser_execution_leases WHERE job_id=?").run(input.jobId);this.db.prepare("INSERT INTO browser_execution_leases(browser_id,tab_id,project_ref,job_id,acquired_at) VALUES(?,?,?,?,?)").run(input.browserId,input.tabId,input.projectRef,input.jobId,new Date().toISOString());const x=this.recordIntentUnsafe(input.jobId,input.requestHash,input.snapshot),now=new Date().toISOString();this.db.prepare("INSERT INTO job_events(job_id,state,event_type,payload_json,created_at) VALUES(?,'SUBMITTING','USER_RESUME_AUTHORIZED_UNRESOLVED',?,?)").run(input.jobId,JSON.stringify({...input.audit,originalAttemptId:attempts[0].id,newAttemptId:x.attemptId,ordinal:2}),now);return x;})();}
  appendBaselineAttestation(jobId:string,attemptId:string,evidence:LegacyBaselineAttestationEvidence):void {this.db.transaction(()=>{const now=new Date().toISOString(),recordType=evidence.recordType??"pre_submit_observation";this.db.prepare("INSERT INTO browser_baseline_attestations(attempt_id,job_id,request_hash,project_ref,browser_id,tab_id,captured_at,source_observation_path,source_observation_sha256,baseline_asset_refs_json,attested_at,reason,record_type,evidence_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(attemptId,jobId,evidence.requestHash,evidence.projectRef,evidence.browserId,evidence.tabId,evidence.capturedAt,evidence.sourceObservationPath,evidence.sourceObservationSha256,JSON.stringify(evidence.baselineAssetRefs),now,evidence.reason,recordType,JSON.stringify(evidence));this.db.prepare("INSERT INTO job_events(job_id,state,event_type,payload_json,created_at) SELECT id,state,'BASELINE_ATTESTED',?,? FROM jobs WHERE id=?").run(JSON.stringify({attemptId,sourceObservationSha256:evidence.sourceObservationSha256,reason:evidence.reason,recordType}),now,jobId);})();}
  getBaselineAttestation(attemptId:string):LegacyBaselineAttestationEvidence|null {const r=this.db.prepare("SELECT * FROM browser_baseline_attestations WHERE attempt_id=?").get(attemptId) as any;if(!r)return null;if(r.evidence_json)return JSON.parse(r.evidence_json);return {recordType:r.record_type,requestHash:r.request_hash,projectRef:r.project_ref,browserId:r.browser_id,tabId:r.tab_id,capturedAt:r.captured_at,sourceObservationPath:r.source_observation_path,sourceObservationSha256:r.source_observation_sha256,baselineAssetRefs:JSON.parse(r.baseline_asset_refs_json),reason:r.reason};}
  getBrowserTicketReceipt(ticketId:string):Record<string,unknown>|null {const r=this.db.prepare("SELECT receipt_json FROM browser_execution_tickets WHERE id=?").get(ticketId) as {receipt_json:string|null}|undefined;return r?.receipt_json?JSON.parse(r.receipt_json):null;}
  saveBrowserObservation(observation:ExistingBrowserObservation):void {this.db.prepare("INSERT INTO browser_observations(id,payload_json,imported_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,imported_at=excluded.imported_at").run(JSON.stringify(observation),new Date().toISOString());}
  getBrowserObservation():ExistingBrowserObservation|null {const r=this.db.prepare("SELECT payload_json FROM browser_observations WHERE id=1").get() as {payload_json:string}|undefined;return r?JSON.parse(r.payload_json):null;}
  issueBrowserTicket(input: Omit<BrowserExecutionTicket,"ticketId"|"status"|"issuedAt">): BrowserExecutionTicket {
    const ticketId=`ticket_${randomUUID()}`,issuedAt=new Date().toISOString();
    this.db.prepare("INSERT INTO browser_execution_tickets(id,job_id,attempt_id,action,status,browser_id,tab_id,project_ref,request_hash,snapshot_json,issued_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(ticketId,input.jobId,input.attemptId,input.action,"ISSUED",input.browserId,input.tabId,input.projectRef,input.requestHash,JSON.stringify(input.expectedSnapshot),issuedAt);
    return {...input,ticketId,status:"ISSUED" as const,issuedAt};
  }
  renewUnclaimedBrowserTicket(ticketId:string,input:Omit<BrowserExecutionTicket,"ticketId"|"status"|"issuedAt">):BrowserExecutionTicket{return this.db.transaction(()=>{const old=this.getBrowserTicket(ticketId);if(!old||old.status!=="ISSUED"||old.action!=="GENERATE"||old.jobId!==input.jobId||old.attemptId!==input.attemptId||old.requestHash!==input.requestHash)throw new Error("TICKET_NOT_RENEWABLE");if(Date.now()-Date.parse(old.issuedAt)<=60_000)throw new Error("TICKET_NOT_EXPIRED");const attempt=this.db.prepare("SELECT attempt_status,request_hash FROM submission_attempts WHERE id=? AND job_id=?").get(old.attemptId,old.jobId) as {attempt_status:string;request_hash:string}|undefined;if(!attempt||attempt.attempt_status!=="ACTIVE"||attempt.request_hash!==old.requestHash)throw new Error("ATTEMPT_NOT_ACTIVE");const conflicting=this.db.prepare("SELECT count(*) n FROM browser_execution_tickets WHERE attempt_id=? AND action='GENERATE' AND id<>? AND status IN ('CLAIMED','RECEIPTED')").get(old.attemptId,ticketId) as {n:number};if(conflicting.n)throw new Error("GENERATE_EFFECT_ALREADY_ACTIVE");const now=new Date().toISOString(),newId=`ticket_${randomUUID()}`;this.db.prepare("UPDATE browser_execution_tickets SET status='EXPIRED' WHERE id=? AND status='ISSUED'").run(ticketId);this.db.prepare("INSERT INTO browser_execution_tickets(id,job_id,attempt_id,action,status,browser_id,tab_id,project_ref,request_hash,snapshot_json,issued_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(newId,input.jobId,input.attemptId,input.action,"ISSUED",input.browserId,input.tabId,input.projectRef,input.requestHash,JSON.stringify(input.expectedSnapshot),now);this.db.prepare("INSERT INTO job_events(job_id,state,event_type,payload_json,created_at) SELECT id,state,'UNCLAIMED_TICKET_RENEWED',?,? FROM jobs WHERE id=?").run(JSON.stringify({expiredTicketId:ticketId,newTicketId:newId,attemptId:old.attemptId}),now,old.jobId);return{...input,ticketId:newId,status:"ISSUED" as const,issuedAt:now};})();}
  getBrowserTicket(ticketId:string):BrowserExecutionTicket|null {const r=this.db.prepare("SELECT * FROM browser_execution_tickets WHERE id=?").get(ticketId) as any;if(!r)return null;return {ticketId:r.id,jobId:r.job_id,attemptId:r.attempt_id,action:r.action,status:r.status,browserId:r.browser_id,tabId:r.tab_id,projectRef:r.project_ref,requestHash:r.request_hash,expectedSnapshot:JSON.parse(r.snapshot_json),issuedAt:r.issued_at};}
  getGenerateTicketForAttempt(attemptId:string):BrowserExecutionTicket|null {const r=this.db.prepare("SELECT * FROM browser_execution_tickets WHERE attempt_id=? AND action='GENERATE' ORDER BY issued_at LIMIT 1").get(attemptId) as any;return r?{ticketId:r.id,jobId:r.job_id,attemptId:r.attempt_id,action:r.action,status:r.status,browserId:r.browser_id,tabId:r.tab_id,projectRef:r.project_ref,requestHash:r.request_hash,expectedSnapshot:JSON.parse(r.snapshot_json),issuedAt:r.issued_at}:null;}
  claimBrowserTicket(ticketId:string):BrowserExecutionTicket {return this.db.transaction(()=>{const ticket=this.getBrowserTicket(ticketId);if(!ticket||ticket.status!=="ISSUED")throw new Error("TICKET_NOT_ISSUED");this.db.prepare("UPDATE browser_execution_tickets SET status='CLAIMED' WHERE id=? AND status='ISSUED'").run(ticketId);return {...ticket,status:"CLAIMED" as const};})();}
  receiptBrowserTicket(ticketId:string,receipt:Record<string,unknown>):BrowserExecutionTicket {return this.db.transaction(()=>{const ticket=this.getBrowserTicket(ticketId);if(!ticket||ticket.status!=="CLAIMED")throw new Error("TICKET_NOT_CLAIMED");this.db.prepare("UPDATE browser_execution_tickets SET status='RECEIPTED',receipt_json=? WHERE id=?").run(JSON.stringify(receipt),ticketId);return {...ticket,status:"RECEIPTED" as const};})();}
  completeBrowserTicket(ticketId:string,receipt:Record<string,unknown>,assets:ProviderAsset[]):BrowserExecutionTicket {return this.db.transaction(()=>{const ticket=this.getBrowserTicket(ticketId);if(!ticket||ticket.status!=="CLAIMED")throw new Error("TICKET_NOT_CLAIMED");const now=new Date().toISOString();this.db.prepare("UPDATE browser_execution_tickets SET status='RECEIPTED',receipt_json=? WHERE id=?").run(JSON.stringify(receipt),ticketId);const assetStmt=this.db.prepare("INSERT INTO assets(provider_asset_ref,job_id,payload_json,local_path,sha256,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(job_id,provider_asset_ref) DO UPDATE SET payload_json=excluded.payload_json,local_path=excluded.local_path,sha256=excluded.sha256");for(const asset of assets)assetStmt.run(asset.providerAssetRef,ticket.jobId,JSON.stringify(asset),asset.localPath??null,asset.sha256??null,now);this.db.prepare("UPDATE jobs SET state='GENERATED',error_code=NULL,updated_at=? WHERE id=?").run(now,ticket.jobId);this.db.prepare("INSERT INTO job_events(job_id,state,event_type,payload_json,created_at) VALUES(?,?,?,?,?)").run(ticket.jobId,"GENERATED","STATE_CHANGED",JSON.stringify({assetRefs:assets.map(a=>a.providerAssetRef)}),now);this.db.prepare("DELETE FROM browser_execution_leases WHERE job_id=?").run(ticket.jobId);return {...ticket,status:"RECEIPTED" as const};})();}
  recordEvidence(jobId: string, fencingToken: string, evidence: Record<string,unknown>) {
    const result=this.db.prepare("UPDATE submission_attempts SET evidence_json=? WHERE job_id=? AND fencing_token=?").run(JSON.stringify(evidence),jobId,fencingToken);
    if (result.changes !== 1) throw new Error("STALE_FENCING_TOKEN");
  }
  saveAssets(jobId:string,assets:ProviderAsset[]){const now=new Date().toISOString();const stmt=this.db.prepare("INSERT INTO assets(provider_asset_ref,job_id,payload_json,local_path,sha256,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(job_id,provider_asset_ref) DO UPDATE SET payload_json=excluded.payload_json,local_path=excluded.local_path,sha256=excluded.sha256");this.db.transaction(()=>{for(const asset of assets)stmt.run(asset.providerAssetRef,jobId,JSON.stringify(asset),asset.localPath??null,asset.sha256??null,now);})();}
  getAssets(jobId:string):any[]{return (this.db.prepare("SELECT payload_json FROM assets WHERE job_id=? ORDER BY provider_asset_ref").all(jobId) as Array<{payload_json:string}>).map(x=>JSON.parse(x.payload_json));}
  createBudgetLedger(parentId:string):BudgetLedger { const now=new Date().toISOString(); this.db.prepare("INSERT OR IGNORE INTO budget_ledgers(parent_id,cap_credits,created_at) VALUES(?,50,?)").run(parentId,now); return this.getBudgetLedger(parentId)!; }
  getBudgetLedger(parentId:string):BudgetLedger|null { const r=this.db.prepare("SELECT * FROM budget_ledgers WHERE parent_id=?").get(parentId) as BudgetLedgerRow|undefined; return r?{parentId:r.parent_id,capCredits:r.cap_credits,reservedCredits:r.reserved_credits,consumedCredits:r.consumed_credits,createdAt:r.created_at}:null; }
  reserveBudgetStep(parentId:string,stepKey:string,quotedCredits:number,binding:{jobId?:string;requestHash?:string}={}):BudgetStep { return this.db.transaction(()=>this.reserveBudgetStepUnsafe(parentId,stepKey,quotedCredits,binding))(); }
  private reserveBudgetStepUnsafe(parentId:string,stepKey:string,quotedCredits:number,binding:{jobId?:string;requestHash?:string}={}):BudgetStep { if(!Number.isInteger(quotedCredits)||quotedCredits<0)throw new Error("INVALID_BUDGET_QUOTE"); this.createBudgetLedger(parentId); const old=this.db.prepare("SELECT * FROM budget_steps WHERE parent_id=? AND step_key=?").get(parentId,stepKey) as BudgetStepRow|undefined; if(old){if((binding.jobId&&old.job_id!==binding.jobId)||(binding.requestHash&&old.request_hash!==binding.requestHash))throw new Error("BUDGET_STEP_CONFLICT");return rowToBudgetStep(old);} const ledger=this.getBudgetLedger(parentId)!; if(ledger.reservedCredits+quotedCredits>ledger.capCredits)throw new Error("BUDGET_EXCEEDED"); const now=new Date().toISOString(); this.db.prepare("INSERT INTO budget_steps(parent_id,step_key,quoted_credits,state,created_at,job_id,request_hash) VALUES(?,?,?,?,?,?,?)").run(parentId,stepKey,quotedCredits,"RESERVED",now,binding.jobId??null,binding.requestHash??null); this.db.prepare("UPDATE budget_ledgers SET reserved_credits=reserved_credits+? WHERE parent_id=?").run(quotedCredits,parentId); return {parentId,stepKey,quotedCredits,state:"RESERVED" as const,createdAt:now}; }
  getBudgetStep(parentId:string,stepKey:string):BudgetStep|null {const r=this.db.prepare("SELECT * FROM budget_steps WHERE parent_id=? AND step_key=?").get(parentId,stepKey) as BudgetStepRow|undefined;return r?rowToBudgetStep(r):null;}
  consumeBudgetStep(parentId:string,stepKey:string):BudgetStep { return this.db.transaction(()=>{ const row=this.db.prepare("SELECT * FROM budget_steps WHERE parent_id=? AND step_key=?").get(parentId,stepKey) as BudgetStepRow|undefined; if(!row)throw new Error("BUDGET_STEP_NOT_FOUND"); if(row.state==="CONSUMED")return rowToBudgetStep(row); this.db.prepare("UPDATE budget_steps SET state='CONSUMED' WHERE parent_id=? AND step_key=?").run(parentId,stepKey); this.db.prepare("UPDATE budget_ledgers SET consumed_credits=consumed_credits+? WHERE parent_id=?").run(row.quoted_credits,parentId); return {...rowToBudgetStep(row),state:"CONSUMED" as const}; })(); }
  getBudgetSteps(parentId:string):BudgetStep[]{return (this.db.prepare("SELECT * FROM budget_steps WHERE parent_id=? ORDER BY created_at,step_key").all(parentId) as BudgetStepRow[]).map(rowToBudgetStep);}
  confirmBudgetStepNotCharged(input:{attemptId:string;jobId:string;parentId:string;stepKey:string;sourceEvidenceSha256:string;evidence:Record<string,unknown>}):{confirmed:true;releasedCredits:number;idempotent:boolean}{return this.db.transaction(()=>{const old=this.db.prepare("SELECT quoted_credits,evidence_json FROM budget_no_charge_confirmations WHERE attempt_id=?").get(input.attemptId) as {quoted_credits:number;evidence_json:string}|undefined;if(old)return{confirmed:true as const,releasedCredits:old.quoted_credits,idempotent:true};const step=this.db.prepare("SELECT * FROM budget_steps WHERE parent_id=? AND step_key=?").get(input.parentId,input.stepKey) as BudgetStepRow|undefined;if(!step||step.state!=="CONSUMED"||step.job_id!==input.jobId)throw new Error("BUDGET_STEP_NOT_ELIGIBLE");const now=new Date().toISOString();this.db.prepare("UPDATE budget_steps SET state='NOT_CHARGED' WHERE parent_id=? AND step_key=? AND state='CONSUMED'").run(input.parentId,input.stepKey);this.db.prepare("UPDATE budget_ledgers SET reserved_credits=reserved_credits-?,consumed_credits=consumed_credits-? WHERE parent_id=? AND reserved_credits>=? AND consumed_credits>=?").run(step.quoted_credits,step.quoted_credits,input.parentId,step.quoted_credits,step.quoted_credits);this.db.prepare("INSERT INTO budget_no_charge_confirmations(attempt_id,job_id,parent_id,step_key,quoted_credits,source_evidence_sha256,evidence_json,confirmed_at) VALUES(?,?,?,?,?,?,?,?)").run(input.attemptId,input.jobId,input.parentId,input.stepKey,step.quoted_credits,input.sourceEvidenceSha256,JSON.stringify(input.evidence),now);return{confirmed:true as const,releasedCredits:step.quoted_credits,idempotent:false};})();}
}

type Row = {id:string;provider:ProviderKind;idempotency_key:string;request_hash:string;final_prompt_sha256:string;state:JobState;runtime_snapshot_json:string|null;error_code:any;created_at:string;updated_at:string};
export type AttemptRow = {id:string;job_id:string;ordinal:number;attempt_status:"ACTIVE"|"FAILED"|"SUCCEEDED"|"UNRESOLVED";fencing_token:string;request_hash:string;snapshot_json:string;intent_recorded_at:string;evidence_json:string|null};
type BudgetLedgerRow={parent_id:string;cap_credits:50;reserved_credits:number;consumed_credits:number;created_at:string};
type BudgetStepRow={parent_id:string;step_key:string;quoted_credits:number;state:"RESERVED"|"CONSUMED"|"NOT_CHARGED";created_at:string;job_id:string|null;request_hash:string|null};
function rowToBudgetStep(r:BudgetStepRow):BudgetStep{return {parentId:r.parent_id,stepKey:r.step_key,quotedCredits:r.quoted_credits,state:r.state,createdAt:r.created_at};}
function rowToJob(r: Row): JobRecord { return {id:r.id,provider:r.provider,idempotencyKey:r.idempotency_key,requestHash:r.request_hash,finalPromptSha256:r.final_prompt_sha256,state:r.state,runtimeSnapshot:r.runtime_snapshot_json?JSON.parse(r.runtime_snapshot_json):null,errorCode:r.error_code,createdAt:r.created_at,updatedAt:r.updated_at}; }
