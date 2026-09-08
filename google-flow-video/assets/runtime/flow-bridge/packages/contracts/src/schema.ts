import { z } from "zod";

const asset = z.object({ path: z.string().min(1), name: z.string().optional(), contentSha256: z.string().optional(), sizeBytes: z.number().int().nonnegative().optional() });
export const videoRequestSchema = z.object({
  provider: z.enum(["flow_ui", "mock"]),
  idempotencyKey: z.string().min(1).max(200),
  project: z.object({ name: z.string().min(1), reuse: z.boolean().optional() }),
  mode: z.enum(["text_to_video","extend_video","first_frame_to_video","first_last_frames_to_video","ingredients_to_video"]),
  prompt: z.string().min(1), promptMode: z.enum(["verbatim","enhance"]), model: z.string().min(1),
  aspectRatio: z.enum(["16:9","9:16"]), durationSeconds: z.number().int().positive(), resolution: z.string().min(1), outputs: z.number().int().positive(),
  inputs: z.object({ firstFrame: asset.optional(), lastFrame: asset.optional(), ingredients: z.array(asset).optional() }).optional(),
  download: z.object({ enabled: z.boolean(), directory: z.string().optional(), format: z.literal("mp4").optional() }).optional(),
  costPolicy: z.object({ maxCredits: z.literal(50), confirmAbove: z.literal(50), rejectWhenUnknown: z.literal(true) }),
  authorizationContext: z.object({ source: z.literal("current_conversation"), explicitlyRequestedGeneration: z.literal(true) }),
  budgetContext: z.object({ ledgerId: z.string().min(1), stepKey: z.string().min(1) }).optional(),
  sourceParentJobId: z.string().min(1).optional(),
  sourceAssetRef: z.string().min(1).optional()
}).superRefine((value,ctx)=>{const linked=value.sourceParentJobId!==undefined||value.sourceAssetRef!==undefined;if(value.mode==="extend_video"&&(!value.sourceParentJobId||!value.sourceAssetRef||!value.budgetContext))ctx.addIssue({code:"custom",message:"extend_video requires sourceParentJobId, sourceAssetRef and budgetContext"});if(linked&&(!value.sourceParentJobId||!value.sourceAssetRef||!value.budgetContext))ctx.addIssue({code:"custom",message:"a continuation source requires sourceParentJobId, sourceAssetRef and budgetContext"});if(linked&&value.mode==="first_frame_to_video"&&!value.inputs?.firstFrame)ctx.addIssue({code:"custom",message:"linked first_frame_to_video requires a frozen firstFrame input"});});
