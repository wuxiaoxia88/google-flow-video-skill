import { z } from "zod";
import type { VideoGenerationRequest } from "./index.js";
import { createModelPolicy } from "./model-policy.js";

const inputAsset = z.object({path:z.string().min(1),name:z.string().optional()});
export const externalVideoRequestSchema = z.object({
  backend:z.enum(["flow_ui","mock"]),
  idempotency_key:z.string().min(1), project:z.object({name:z.string().min(1),reuse:z.boolean().optional()}),
  mode:z.enum(["text_to_video","extend_video","first_frame_to_video","first_last_frames_to_video","ingredients_to_video","edit_video"]),
  prompt:z.string().min(1), prompt_mode:z.enum(["verbatim","enhance"]), model:z.string().min(1).optional(),
  model_policy:z.object({version:z.literal(1),required_family:z.enum(["gemini_omni_flash_1_1","veo"]),api_code:z.null(),allow_fallback:z.literal(false),execution_backend:z.literal("flow_ui"),selection_source:z.enum(["default","explicit"])}).optional(),
  aspect_ratio:z.enum(["16:9","9:16"]), duration_seconds:z.number().int().positive(), resolution:z.string().min(1), outputs:z.number().int().positive(),
  inputs:z.object({first_frame:inputAsset.optional(),last_frame:inputAsset.optional(),ingredients:z.array(inputAsset).optional(),source_video:inputAsset.optional()}).optional(),
  download:z.object({enabled:z.boolean(),directory:z.string().optional(),format:z.literal("mp4").optional()}).optional(),
  cost_policy:z.object({max_credits:z.literal(200),confirm_above:z.literal(200),reject_when_unknown:z.literal(true).optional()}).optional(),
  budget_group:z.object({ledger_id:z.string().min(1),step_key:z.string().min(1)}).optional(),
  source_parent_job_id:z.string().min(1).optional(),
  source_asset_ref:z.string().min(1).optional()
}).superRefine((value,ctx)=>{if(value.mode==="edit_video"&&!value.inputs?.source_video)ctx.addIssue({code:"custom",message:"edit_video requires inputs.source_video"});const linked=value.source_parent_job_id!==undefined||value.source_asset_ref!==undefined;if(value.mode==="extend_video"&&(!value.source_parent_job_id||!value.source_asset_ref||!value.budget_group))ctx.addIssue({code:"custom",message:"extend_video requires source_parent_job_id, source_asset_ref and budget_group"});if(linked&&(!value.source_parent_job_id||!value.source_asset_ref||!value.budget_group))ctx.addIssue({code:"custom",message:"a continuation source requires source_parent_job_id, source_asset_ref and budget_group"});if(linked&&value.mode==="first_frame_to_video"&&!value.inputs?.first_frame)ctx.addIssue({code:"custom",message:"linked first_frame_to_video requires inputs.first_frame"});});
export function normalizeExternalRequest(value:unknown):VideoGenerationRequest {
  const x=externalVideoRequestSchema.parse(value);
  const inferred=createModelPolicy(x.model,x.model?"explicit":"default");
  const policy=x.model_policy?{version:1 as const,requiredFamily:x.model_policy.required_family,apiCode:x.model_policy.api_code,allowFallback:false as const,executionBackend:"flow_ui" as const,selectionSource:x.model_policy.selection_source}:inferred;
  if(x.model_policy&&x.model&&policy.requiredFamily!==inferred.requiredFamily)throw new Error("model and model_policy disagree");
  const model=x.model??"Gemini Omni Flash 1.1";
  return {provider:x.backend,idempotencyKey:x.idempotency_key,project:x.project,mode:x.mode,prompt:x.prompt,promptMode:x.prompt_mode,model,modelPolicy:policy,aspectRatio:x.aspect_ratio,durationSeconds:x.duration_seconds,resolution:x.resolution,outputs:x.outputs,
    inputs:x.inputs?{firstFrame:x.inputs.first_frame,lastFrame:x.inputs.last_frame,ingredients:x.inputs.ingredients,sourceVideo:x.inputs.source_video}:undefined,download:x.download,
    costPolicy:{maxCredits:200,confirmAbove:200,rejectWhenUnknown:true},authorizationContext:{source:"current_conversation",explicitlyRequestedGeneration:true},budgetContext:x.budget_group?{ledgerId:x.budget_group.ledger_id,stepKey:x.budget_group.step_key}:undefined,sourceParentJobId:x.source_parent_job_id,sourceAssetRef:x.source_asset_ref};
}
