import type { LinearMutationClient, LinearReadModel } from "../linear/index.js";
import { type DomainError, type Result, ok } from "../../domain/foundation/index.js";
import type {
  LinearAuditCommentWriter,
  RegistrationSetupExternalAuditCommentReceipt,
} from "./setup-audit.js";

export interface LinearAuditTarget {
  readonly teamId: string;
  readonly projectId: string;
}

/**
 * Thin, field-mapping-only production `LinearAuditCommentWriter`. It delegates every mutation to
 * the existing `LinearMutationClient.appendComment` (src/adapters/linear/write.ts:323-336), which
 * already implements every invariant this port needs (durable-marker dedupe, cross-process
 * coalescing, exact readback verification of the stored body before returning success).
 *
 * The one real gap: `appendComment` needs a `LinearProjectContext` (`{team, project, catalog}`),
 * but this port's own contract (setup-audit.ts:28-34) only ever supplies a bare
 * `linearAuditIssueId` -- never a team/project pair. This adapter closes that gap using
 * `LinearReadModel.readContext(teamId, projectId)` (src/adapters/linear/read.ts:225-303), which
 * already exists as a production, fail-closed, read-only context loader: it reads the exact-ID
 * team/project identity plus the full label/workflow-state catalog, and returns `err(...)`
 * (never a partial/degraded context) the instant either the team or the project cannot be
 * resolved. No new read logic is written here -- `teamId`/`projectId` are supplied once at
 * construction (mirroring `RegistrationProbeLinearAdapter`'s own use of the same read model, see
 * src/adapters/registration/proactive-probe-linear.ts:74-93), and every call simply re-reads the
 * context fresh and fails closed if that read does not succeed.
 */
export class LinearIssueAuditCommentWriter implements LinearAuditCommentWriter {
  readonly #readModel: Pick<LinearReadModel, "readContext">;
  readonly #mutationClient: Pick<LinearMutationClient, "appendComment">;
  readonly #target: LinearAuditTarget;

  constructor(
    readModel: Pick<LinearReadModel, "readContext">,
    mutationClient: Pick<LinearMutationClient, "appendComment">,
    target: LinearAuditTarget,
  ) {
    this.#readModel = readModel;
    this.#mutationClient = mutationClient;
    this.#target = target;
  }

  async appendComment(
    linearAuditIssueId: string,
    body: string,
    idempotencyKey: string,
  ): Promise<Result<RegistrationSetupExternalAuditCommentReceipt, DomainError>> {
    const context = await this.#readModel.readContext(this.#target.teamId, this.#target.projectId);
    if (!context.ok) return context;
    const appended = await this.#mutationClient.appendComment(
      context.value,
      linearAuditIssueId,
      body,
      idempotencyKey,
    );
    if (!appended.ok) return appended;
    return ok(
      Object.freeze({
        id: appended.value.id,
        body: appended.value.body,
        createdAt: appended.value.createdAt,
        reused: appended.value.reused,
      }),
    );
  }
}
