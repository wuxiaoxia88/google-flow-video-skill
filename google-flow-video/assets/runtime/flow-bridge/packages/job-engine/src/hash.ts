import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { InputAsset, VideoGenerationRequest } from "../../contracts/src/index.js";

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value as Record<string,unknown>).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

async function freezeAsset(asset: InputAsset): Promise<InputAsset> {
  const [data, info] = await Promise.all([readFile(asset.path), stat(asset.path)]);
  return {...asset, contentSha256: sha256(data), sizeBytes: info.size};
}
export async function freezeRequest(request: VideoGenerationRequest): Promise<{request:VideoGenerationRequest;requestHash:string;finalPromptSha256:string}> {
  const inputs = request.inputs ? {
    firstFrame: request.inputs.firstFrame ? await freezeAsset(request.inputs.firstFrame) : undefined,
    lastFrame: request.inputs.lastFrame ? await freezeAsset(request.inputs.lastFrame) : undefined,
    ingredients: request.inputs.ingredients ? await Promise.all(request.inputs.ingredients.map(freezeAsset)) : undefined,
    sourceVideo: request.inputs.sourceVideo ? await freezeAsset(request.inputs.sourceVideo) : undefined
  } : undefined;
  const frozen = {...request, inputs};
  return {request:frozen, requestHash:sha256(stableStringify(frozen)), finalPromptSha256:sha256(request.prompt)};
}
