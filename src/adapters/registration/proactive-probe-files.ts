import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";

import type { MutationOptions, RegistrationProbeFilePort } from "../../application/ports/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { repositoryRelativePathSchema } from "../../domain/project/index.js";

const digestPattern = /^[a-f0-9]{64}$/u;
const maximumContentBytes = 64 * 1024;

function mutationAllowed(options: MutationOptions): boolean {
  return options.idempotencyKey.trim().length > 0 && options.signal?.aborted !== true;
}

function contentDigest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Writes only the deterministic, secret-free probe manifest at a caller-supplied relative path
 * inside an already-created worktree. The path is validated against the same repository-relative
 * schema used elsewhere in the codebase, resolved, and re-checked to stay inside the worktree
 * before any write occurs; the content is read back and its digest re-verified afterward.
 */
export class RegistrationProbeFileAdapter implements RegistrationProbeFilePort {
  async writeProbeManifest(
    command: Parameters<RegistrationProbeFilePort["writeProbeManifest"]>[0],
    options: MutationOptions,
  ): ReturnType<RegistrationProbeFilePort["writeProbeManifest"]> {
    if (
      !mutationAllowed(options) ||
      !isAbsolute(command.worktree.path) ||
      !repositoryRelativePathSchema.safeParse(command.path).success ||
      !digestPattern.test(command.contentDigest) ||
      command.content.length === 0 ||
      Buffer.byteLength(command.content, "utf8") > maximumContentBytes ||
      contentDigest(command.content) !== command.contentDigest
    ) {
      return err(domainError("invariant_violation"));
    }

    const worktreeRoot = normalize(command.worktree.path);
    const target = normalize(join(worktreeRoot, command.path));
    const relativeToRoot = relative(worktreeRoot, target);
    if (relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) {
      return err(domainError("invariant_violation"));
    }

    // Idempotent: a crash-recovered retry may find the manifest already written with the exact
    // same content, in which case there is nothing more to do.
    const existing = await this.#readBack(target);
    if (existing.ok) {
      return existing.value === command.content
        ? ok(Object.freeze({ path: command.path, contentDigest: command.contentDigest }))
        : err(domainError("conflict"));
    }
    if (existing.error.code !== "not_found") return existing;

    try {
      await mkdir(dirname(target), { recursive: true, mode: 0o755 });
      await writeFile(target, command.content, { encoding: "utf8", mode: 0o644, flag: "wx" });
    } catch (error) {
      return err(mapWriteError(error));
    }

    const readBack = await this.#readBack(target);
    if (!readBack.ok) return readBack;
    if (readBack.value !== command.content) return err(domainError("external_failure"));

    return ok(Object.freeze({ path: command.path, contentDigest: command.contentDigest }));
  }

  async #readBack(target: string): Promise<Result<string, DomainError>> {
    try {
      return ok(await readFile(target, "utf8"));
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return err(domainError("not_found"));
      }
      return err(domainError("external_failure"));
    }
  }
}

function mapWriteError(error: unknown): DomainError {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (code === "EEXIST") return domainError("conflict");
    if (code === "ENOENT") return domainError("not_found");
  }
  return domainError("external_failure");
}
