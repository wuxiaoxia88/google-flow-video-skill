import { z } from "zod";

const asset = z.object({ path: z.string().min(1), name: z.string().optional(), contentSha256: z.string().optional(), sizeBytes: z.number().int().nonnegative().optional() });
export const videoRequestSchema = z.object({
  provider: z.enum(["flow_ui", "mock"]),
  idempotencyKey: z.string().min(1).max(200),
  project: z.object({ name: z.string().min(1), reuse: z.boolean().optional() }),
  mode: z.enum(["text_to_video","extend_video","first_frame_to_video","first_last_frames_to_video","ingredients_to_video","edit_video"]),
  prompt: z.string().min(1), promptMode: z.enum(["verbatim","enhance"]), model: z.string().min(1),
  modelPolicy: z.object({ version:z.literal(1), requiredFamily:z.enum(["gemini_omni_flash_1_1","veo"]), apiCode:z.null(), allowFallback:z.literal(false), executionBackend:z.literal("flow_ui"), selectionSource:z.enum(["default","explicit"]) }).optional(),
  aspectRatio: z.enum(["16:9","9:16"]), durationSeconds: z.number().int().positive(), resolution: z.string().min(1), outputs: z.number().int().positive(),
  inputs: z.object({ firstFrame: asset.optional(), lastFrame: asset.optional(), ingredients: z.array(asset).optional(), sourceVideo:asset.optional() }).optional(),
  download: z.object({ enabled: z.boolean(), directory: z.string().optional(), format: z.literal("mp4").optional() }).optional(),
  costPolicy: z.object({ maxCredits: z.number().int().positive().max(200), confirmAbove: z.number().int().positive().max(200), rejectWhenUnknown: z.literal(true) }),
  authorizationContext: z.object({ source: z.literal("current_conversation"), explicitlyRequestedGeneration: z.literal(true) }),
  budgetContext: z.object({ ledgerId: z.string().min(1), stepKey: z.string().min(1) }).optional(),
  sourceParentJobId: z.string().min(1).optional(),
  sourceAssetRef: z.string().min(1).optional()
}).superRefine((value,ctx)=>{if(value.mode==="edit_video"&&!value.inputs?.sourceVideo)ctx.addIssue({code:"custom",message:"edit_video requires a frozen inputs.sourceVideo"});const linked=value.sourceParentJobId!==undefined||value.sourceAssetRef!==undefined;if(value.mode==="extend_video"&&(!value.sourceParentJobId||!value.sourceAssetRef||!value.budgetContext))ctx.addIssue({code:"custom",message:"extend_video requires sourceParentJobId, sourceAssetRef and budgetContext"});if(linked&&(!value.sourceParentJobId||!value.sourceAssetRef||!value.budgetContext))ctx.addIssue({code:"custom",message:"a continuation source requires sourceParentJobId, sourceAssetRef and budgetContext"});if(linked&&value.mode==="first_frame_to_video"&&!value.inputs?.firstFrame)ctx.addIssue({code:"custom",message:"linked first_frame_to_video requires a frozen firstFrame input"});if(value.costPolicy.maxCredits!==value.costPolicy.confirmAbove)ctx.addIssue({code:"custom",message:"maxCredits and confirmAbove must be the same whole-run authorization ceiling"});});
