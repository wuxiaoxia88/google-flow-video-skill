import { z } from "zod";
import type { VideoGenerationRequest } from "./index.js";

const inputAsset = z.object({path:z.string().min(1),name:z.string().optional()});
export const externalVideoRequestSchema = z.object({
  backend:z.enum(["flow_ui","mock"]),
  idempotency_key:z.string().min(1), project:z.object({name:z.string().min(1),reuse:z.boolean().optional()}),
  mode:z.enum(["text_to_video","extend_video","first_frame_to_video","first_last_frames_to_video","ingredients_to_video"]),
  prompt:z.string().min(1), prompt_mode:z.enum(["verbatim","enhance"]), model:z.string().min(1),
  aspect_ratio:z.enum(["16:9","9:16"]), duration_seconds:z.number().int().positive(), resolution:z.string().min(1), outputs:z.number().int().positive(),
  inputs:z.object({first_frame:inputAsset.optional(),last_frame:inputAsset.optional(),ingredients:z.array(inputAsset).optional()}).optional(),
  download:z.object({enabled:z.boolean(),directory:z.string().optional(),format:z.literal("mp4").optional()}).optional(),
  cost_policy:z.object({max_credits:z.literal(50),confirm_above:z.literal(50),reject_when_unknown:z.literal(true).optional()}),
  budget_group:z.object({ledger_id:z.string().min(1),step_key:z.string().min(1)}).optional(),
  source_parent_job_id:z.string().min(1).optional(),
  source_asset_ref:z.string().min(1).optional()
}).superRefine((value,ctx)=>{const linked=value.source_parent_job_id!==undefined||value.source_asset_ref!==undefined;if(value.mode==="extend_video"&&(!value.source_parent_job_id||!value.source_asset_ref||!value.budget_group))ctx.addIssue({code:"custom",message:"extend_video requires source_parent_job_id, source_asset_ref and budget_group"});if(linked&&(!value.source_parent_job_id||!value.source_asset_ref||!value.budget_group))ctx.addIssue({code:"custom",message:"a continuation source requires source_parent_job_id, source_asset_ref and budget_group"});if(linked&&value.mode==="first_frame_to_video"&&!value.inputs?.first_frame)ctx.addIssue({code:"custom",message:"linked first_frame_to_video requires inputs.first_frame"});});
export function normalizeExternalRequest(value:unknown):VideoGenerationRequest {
  const x=externalVideoRequestSchema.parse(value);
  return {provider:x.backend,idempotencyKey:x.idempotency_key,project:x.project,mode:x.mode,prompt:x.prompt,promptMode:x.prompt_mode,model:x.model,aspectRatio:x.aspect_ratio,durationSeconds:x.duration_seconds,resolution:x.resolution,outputs:x.outputs,
    inputs:x.inputs?{firstFrame:x.inputs.first_frame,lastFrame:x.inputs.last_frame,ingredients:x.inputs.ingredients}:undefined,download:x.download,
    costPolicy:{maxCredits:50,confirmAbove:50,rejectWhenUnknown:true},authorizationContext:{source:"current_conversation",explicitlyRequestedGeneration:true},budgetContext:x.budget_group?{ledgerId:x.budget_group.ledger_id,stepKey:x.budget_group.step_key}:undefined,sourceParentJobId:x.source_parent_job_id,sourceAssetRef:x.source_asset_ref};
}
