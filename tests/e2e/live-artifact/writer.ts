import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { AtomicFileStore } from "../../../src/infrastructure/files/atomic.js";
import { canonicalSerialize } from "../../../src/domain/review/canonical.js";
import { hasSafeDataShape } from "./boundary.js";
import { firstSandboxLiveArtifactSchema } from "./schema.js";
import { replayLiveArtifact, type LiveArtifactReplayReport } from "./validator.js";

const fileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u;
const maximumBytes = 2 * 1024 * 1024;

function targetFor(rootDirectory: string, name: string): string | undefined {
  if (!isAbsolute(rootDirectory) || !fileName.test(name)) return undefined;
  const target = resolve(rootDirectory, name);
  const contained = relative(rootDirectory, target);
  return contained.startsWith("..") || isAbsolute(contained) ? undefined : target;
}
async function readSafe(
  target: string,
): Promise<
  Readonly<{ state: "read"; bytes: Uint8Array }> | Readonly<{ state: "not_found" | "read_failed" }>
> {
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) {
      return { state: "read_failed" };
    }
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const bytes = await handle.readFile();
      return bytes.byteLength > maximumBytes ? { state: "read_failed" } : { state: "read", bytes };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
      ? { state: "not_found" }
      : { state: "read_failed" };
  }
}

export function serializeLiveArtifact(input: unknown): Uint8Array | undefined {
  if (!hasSafeDataShape(input)) return undefined;
  const parsed = firstSandboxLiveArtifactSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const serialized = canonicalSerialize(parsed.data);
  return serialized.ok ? Buffer.from(`${serialized.value}\n`, "utf8") : undefined;
}

export async function replayLiveArtifactFile(
  rootDirectory: string,
  name: string,
): Promise<
  | Readonly<{ state: "replayed"; report: LiveArtifactReplayReport }>
  | Readonly<{
      state: "failed";
      reasonCode:
        "artifact_not_found" | "target_invalid" | "read_failed" | "parse_failed" | "replay_failed";
    }>
> {
  const target = targetFor(rootDirectory, name);
  if (target === undefined) return { state: "failed", reasonCode: "target_invalid" };
  let root;
  try {
    root = await lstat(rootDirectory);
  } catch {
    return { state: "failed", reasonCode: "artifact_not_found" };
  }
  if (!root.isDirectory() || root.isSymbolicLink())
    return { state: "failed", reasonCode: "target_invalid" };
  const read = await readSafe(target);
  if (read.state === "not_found") return { state: "failed", reasonCode: "artifact_not_found" };
  if (read.state !== "read") return { state: "failed", reasonCode: "read_failed" };
  let input: unknown;
  try {
    input = JSON.parse(Buffer.from(read.bytes).toString("utf8"));
  } catch {
    return { state: "failed", reasonCode: "parse_failed" };
  }
  if (!hasSafeDataShape(input) || !firstSandboxLiveArtifactSchema.safeParse(input).success)
    return { state: "failed", reasonCode: "parse_failed" };
  const report = replayLiveArtifact(input);
  return report.overall === "pass"
    ? { state: "replayed", report }
    : { state: "failed", reasonCode: "replay_failed" };
}

export class LiveArtifactWriter {
  readonly #store = new AtomicFileStore();
  constructor(readonly rootDirectory: string) {}
  async write(
    name: string,
    input: unknown,
  ): Promise<
    | Readonly<{ state: "written" }>
    | Readonly<{
        state: "failed";
        reasonCode: "target_invalid" | "write_failed" | "readback_failed" | "replay_failed";
      }>
  > {
    const target = targetFor(this.rootDirectory, name);
    if (target === undefined) return { state: "failed", reasonCode: "target_invalid" };
    try {
      const root = await lstat(this.rootDirectory);
      if (!root.isDirectory() || root.isSymbolicLink())
        return { state: "failed", reasonCode: "target_invalid" };
    } catch {
      return { state: "failed", reasonCode: "target_invalid" };
    }
    const bytes = serializeLiveArtifact(input);
    if (bytes === undefined) return { state: "failed", reasonCode: "write_failed" };
    const written = await this.#store.write(target, bytes, { visibility: "project" });
    if (!written.ok || written.value.durability !== "confirmed")
      return { state: "failed", reasonCode: "write_failed" };
    const readBack = await readSafe(target);
    if (readBack.state !== "read" || !Buffer.from(readBack.bytes).equals(Buffer.from(bytes)))
      return { state: "failed", reasonCode: "readback_failed" };
    const replay = await replayLiveArtifactFile(this.rootDirectory, name);
    return replay.state === "replayed"
      ? { state: "written" }
      : {
          state: "failed",
          reasonCode: replay.reasonCode === "replay_failed" ? "replay_failed" : "readback_failed",
        };
  }
  target(name: string): string {
    return join(this.rootDirectory, name);
  }
}
