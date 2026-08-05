import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type { ReviewerEvidenceIntegrityPort } from "../../application/pipelines/index.js";
import type { ReviewEvidenceBlock } from "../../application/pipelines/reviewer-model.js";
import type { ReadOptions } from "../../application/ports/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";

const sha256Pattern = /^[0-9a-f]{64}$/u;
const maximumEvidenceBytes = 1024 * 1024 * 1024;

function isAborted(options: ReadOptions): boolean {
  return options.signal?.aborted === true;
}

export class LocalReviewerEvidenceIntegrity implements ReviewerEvidenceIntegrityPort {
  async verify(
    evidence: Extract<ReviewEvidenceBlock, { kind: "file" }>,
    options: ReadOptions = {},
  ): Promise<Result<Readonly<{ verified: boolean; byteLength: number }>, DomainError>> {
    if (isAborted(options)) return err(domainError("interrupted"));
    if (!isAbsolute(evidence.path) || !sha256Pattern.test(evidence.sha256)) {
      return err(domainError("invariant_violation"));
    }

    let pathStat;
    try {
      pathStat = await lstat(evidence.path);
    } catch {
      return err(domainError("external_failure"));
    }
    if (
      !pathStat.isFile() ||
      pathStat.isSymbolicLink() ||
      pathStat.size <= 0 ||
      pathStat.size > maximumEvidenceBytes
    ) {
      return ok({ verified: false, byteLength: pathStat.size });
    }

    let file;
    try {
      file = await open(evidence.path, "r");
      const before = await file.stat();
      if (
        !before.isFile() ||
        before.dev !== pathStat.dev ||
        before.ino !== pathStat.ino ||
        before.size !== pathStat.size
      ) {
        return ok({ verified: false, byteLength: before.size });
      }
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let offset = 0;
      for (;;) {
        if (isAborted(options)) return err(domainError("interrupted"));
        const read = await file.read(buffer, 0, buffer.length, offset);
        if (read.bytesRead === 0) break;
        hash.update(buffer.subarray(0, read.bytesRead));
        offset += read.bytesRead;
        if (offset > maximumEvidenceBytes) {
          return ok({ verified: false, byteLength: offset });
        }
      }
      const after = await file.stat();
      const stable =
        after.dev === before.dev &&
        after.ino === before.ino &&
        after.size === before.size &&
        after.mtimeMs === before.mtimeMs &&
        after.ctimeMs === before.ctimeMs;
      return ok({
        verified: stable && offset === before.size && hash.digest("hex") === evidence.sha256,
        byteLength: offset,
      });
    } catch {
      return err(domainError("external_failure"));
    } finally {
      await file?.close().catch(() => undefined);
    }
  }
}
