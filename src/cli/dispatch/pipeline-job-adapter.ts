/**
 * C015c items 3/3b: `ReviewerJobPort` and `CiRecoveryJobPort` (reviewer-model.ts/ci-recovery-
 * model.ts) are both structurally identical -- `update(job, options): AsyncPortResult<{durability:
 * "confirmed" | "unknown"}>` -- and both are satisfied by the same thing: `FileJobRepository.update`
 * (C015c item 1's read-modify-write-under-lock extension). One adapter, not two, since a second
 * class with the identical body would just be duplication with a different name.
 */
import type { AsyncPortResult, MutationOptions } from "../../application/ports/index.js";
import type { Job } from "../../domain/jobs/index.js";
import type { FileJobRepository } from "../../infrastructure/jobs/index.js";

export class FileJobUpdateAdapter {
  constructor(private readonly repository: FileJobRepository) {}

  update(
    job: Job,
    options: MutationOptions,
  ): AsyncPortResult<Readonly<{ durability: "confirmed" | "unknown" }>> {
    return this.repository.update(job, options);
  }
}
