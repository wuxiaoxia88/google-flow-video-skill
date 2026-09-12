import { createHash } from "node:crypto";
import { access, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { FlowBridgeError, type ProviderAsset, type ProviderModelFamily } from "../../contracts/src/index.js";

export interface DownloadProvenance { jobId: string; projectName: string; projectUrl: string; modelRequested: string; modelActual: string; modelActualReadback?:{family:ProviderModelFamily;label:string|null;value:string|null;source:"result_card"|"result_detail"|"unknown"}; aspectRatio: "16:9" | "9:16"; durationSeconds: number; resolution: string; promptSha256: string; targetMatchEvidence: Record<string, unknown>; inputAssets?: Array<{ ordinal: number; contentSha256: string }>; creditsBefore?: number | null; creditsAfter?: number | null; requireAudio?: boolean; }
export interface ValidatedDownload { asset: ProviderAsset; sidecarPath: string; mediaProbe: Record<string, unknown>; fullDecode: Record<string, unknown>; }

export class DownloadManager {
  async persist(sourcePath: string, directory: string, provenance: DownloadProvenance): Promise<ValidatedDownload> {
    const source = resolve(sourcePath), outputDir = resolve(directory); await access(source, constants.R_OK); await mkdir(outputDir, { recursive: true, mode: 0o700 });
    const target = join(outputDir, fileName(provenance)); const part = `${target}.part`;
    if (extname(source).toLowerCase() !== ".mp4") throw new FlowBridgeError("DOWNLOAD_FAILED", "Only verified MP4 downloads are accepted.", { source: basename(source) });
    // rename is atomic only on one filesystem: source must already be the registered temp download.
    await rename(source, part).catch(async () => { throw new FlowBridgeError("DOWNLOAD_FAILED", "Download must be staged on the same filesystem before atomic persistence.", { source, part }); });
    let mediaProbe: Record<string, unknown>; let decodeResult: Record<string, unknown>; let sha256: string;
    try { mediaProbe = await ffprobe(part, provenance); decodeResult = await fullDecode(part); sha256 = await sha256File(part); }
    catch (cause) {
      const diagnosticPath = `${target}.invalid.part`;
      await rename(part, diagnosticPath).catch(() => undefined);
      if (cause instanceof FlowBridgeError) throw new FlowBridgeError("DOWNLOAD_FAILED", cause.message, { ...cause.details, diagnosticPath });
      throw new FlowBridgeError("DOWNLOAD_FAILED", "Downloaded media did not pass validation.", { cause: String(cause), diagnosticPath });
    }
    await rename(part, target);
    const sidecarPath = `${target}.json`;
    const asset: ProviderAsset = { providerAssetRef: String(provenance.targetMatchEvidence.provider_card_ref ?? "verified-flow-asset"), status: "generated", localPath: target, sha256, metadata: { sizeBytes: (await stat(target)).size, mediaProbe, fullDecode: decodeResult, sidecarPath } };
    const sidecar = { job_id: provenance.jobId, provider: "flow_ui", project_name: provenance.projectName, project_url: provenance.projectUrl, model_requested: provenance.modelRequested, model_actual: provenance.modelActual, model_actual_readback:provenance.modelActualReadback??{family:"unknown",label:null,value:null,source:"unknown"}, duration_seconds: provenance.durationSeconds, aspect_ratio: provenance.aspectRatio, resolution: provenance.resolution, credits_before: provenance.creditsBefore ?? null, credits_after: provenance.creditsAfter ?? null, credits_used: null, credits_attribution_confidence: "unknown", prompt_sha256: provenance.promptSha256, input_assets: (provenance.inputAssets ?? []).map(asset => ({ ordinal: asset.ordinal, content_sha256: asset.contentSha256 })), asset_sha256: sha256, target_match_evidence: provenance.targetMatchEvidence, media_probe: mediaProbe, full_decode: decodeResult, billing_source: "flow_ai_credits", created_at: new Date().toISOString() };
    await writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, { mode: 0o600 }); return { asset, sidecarPath, mediaProbe, fullDecode: decodeResult };
  }
}
function fileName(p: DownloadProvenance): string { const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14); return `${stamp}_${safe(p.projectName)}_${safe(p.modelActual)}_${p.aspectRatio.replace(":", "x")}_${p.durationSeconds}s_${safe(p.jobId).slice(-8)}.mp4`; }
function safe(value: string): string { return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64) || "asset"; }
function run(command: string, args: string[]): Promise<string> { return new Promise((resolveRun, reject) => { const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] }); let out = "", err = ""; child.stdout.on("data", d => out += d); child.stderr.on("data", d => err += d); child.on("error", e => reject(e)); child.on("close", code => code === 0 ? resolveRun(out) : reject(new Error(`${command} exit ${code}: ${err}`))); }); }
async function ffprobe(path: string, expected: DownloadProvenance): Promise<Record<string, unknown>> {
  try {
    const raw = await run("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", path]);
    const parsed = JSON.parse(raw) as { streams?: Array<{ codec_type?: string; width?: number; height?: number; r_frame_rate?: string; duration?: string }>; format?: { duration?: string; format_name?: string } };
    const video = parsed.streams?.find(s => s.codec_type === "video"); if (!video?.width || !video.height || !video.r_frame_rate) throw new Error("missing complete video stream metadata");
    if(expected.requireAudio&&!parsed.streams?.some(s=>s.codec_type==="audio"))throw new Error("required audio stream is missing");
    const actualRatio = video.width / video.height, expectedRatio = expected.aspectRatio === "16:9" ? 16 / 9 : 9 / 16;
    const duration = Number(parsed.format?.duration ?? video.duration); if (!Number.isFinite(duration) || Math.abs(duration - expected.durationSeconds) > 0.35) throw new Error(`duration ${duration} does not match requested ${expected.durationSeconds}s`);
    if (Math.abs(actualRatio - expectedRatio) > 0.015) throw new Error(`aspect ratio ${video.width}x${video.height} does not match ${expected.aspectRatio}`);
    const minimumShortEdge = expected.resolution === "720p" ? 720 : expected.resolution === "360p" ? 360 : null;
    if (minimumShortEdge !== null && Math.min(video.width, video.height) !== minimumShortEdge) throw new Error(`short edge ${Math.min(video.width, video.height)} does not match ${expected.resolution}`);
    return parsed as Record<string, unknown>;
  } catch (cause) { throw new FlowBridgeError("DOWNLOAD_FAILED", `ffprobe validation failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause: String(cause) }); }
}
async function fullDecode(path: string): Promise<Record<string, unknown>> { try { await run("ffmpeg", ["-xerror", "-v", "error", "-i", path, "-f", "null", "-"]); return { ok: true, validator: "ffmpeg", mode: "-xerror full decode" }; } catch (cause) { throw new FlowBridgeError("DOWNLOAD_FAILED", "ffmpeg full decode failed; refusing completion.", { cause: String(cause) }); } }
function sha256File(path: string): Promise<string> { return new Promise((resolveHash, reject) => { const hash = createHash("sha256"); createReadStream(path).on("error", reject).on("data", d => hash.update(d)).on("end", () => resolveHash(hash.digest("hex"))); }); }
