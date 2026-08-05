import type { ReadOptions } from "../../application/ports/index.js";
import { trustedProjectConfigSchema } from "../../application/projects/index.js";
import type {
  RegistrationSetupDraft,
  RegistrationSetupDraftSourcePort,
} from "../../application/registration/index.js";
import { domainError, err, ok } from "../../domain/foundation/index.js";
import { projectSchema } from "../../domain/project/index.js";

/**
 * Production host boundary for a complete in-process Project/config draft.
 * It snapshots constructor input and reparses each read, so later host mutation
 * cannot alter an already composed preview.
 */
export class HostRegistrationSetupDraftSource implements RegistrationSetupDraftSourcePort {
  readonly #snapshot: unknown;

  constructor(draft: RegistrationSetupDraft) {
    try {
      this.#snapshot = structuredClone(draft);
    } catch {
      this.#snapshot = undefined;
    }
  }

  load(_options: ReadOptions = {}) {
    void _options;
    if (typeof this.#snapshot !== "object" || this.#snapshot === null) {
      return Promise.resolve(err(domainError("invariant_violation")));
    }
    const source = this.#snapshot as Readonly<Record<string, unknown>>;
    const project = projectSchema.safeParse(source["project"]);
    const config = trustedProjectConfigSchema.safeParse(source["config"]);
    return Promise.resolve(
      project.success && config.success
        ? ok(Object.freeze({ project: project.data, config: config.data }))
        : err(domainError("invariant_violation")),
    );
  }
}
