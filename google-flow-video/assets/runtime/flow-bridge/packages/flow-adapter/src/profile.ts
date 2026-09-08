import { mkdir, open, unlink } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { homedir } from "node:os";
import { FlowBridgeError } from "../../contracts/src/index.js";

export const DEFAULT_FLOW_PROFILE = resolve(homedir(), "Library/Application Support/FlowBridge/ChromeProfile");
const DAILY_CHROME_ROOT = resolve(homedir(), "Library/Application Support/Google/Chrome");

export function assertDedicatedProfile(profileDir = DEFAULT_FLOW_PROFILE): string {
  const candidate = resolve(profileDir);
  if (candidate === DAILY_CHROME_ROOT || candidate.startsWith(`${DAILY_CHROME_ROOT}${sep}`)) {
    throw new FlowBridgeError("PROVIDER_UNAVAILABLE", "Refusing to use Chrome's regular User Data directory.", { profileDir: candidate });
  }
  return candidate;
}

/** A process-local exclusive profile lease; failure is safe and never steals a live profile. */
export class ProfileLease {
  private constructor(private readonly lockPath: string, private readonly handle: Awaited<ReturnType<typeof open>>) {}
  static async acquire(profileDir: string): Promise<ProfileLease> {
    const directory = assertDedicatedProfile(profileDir);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lockPath = resolve(directory, ".flowbridge.lock");
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      return new ProfileLease(lockPath, handle);
    } catch (cause) {
      throw new FlowBridgeError("PROVIDER_UNAVAILABLE", "Dedicated Flow profile is already in use.", { reason: "PROFILE_BUSY", profileDir: directory, cause: String(cause) });
    }
  }
  async release(): Promise<void> {
    await this.handle.close();
    await unlink(this.lockPath).catch(() => undefined);
  }
}
