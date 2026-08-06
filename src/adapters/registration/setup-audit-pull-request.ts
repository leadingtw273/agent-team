import type { MutationOptions, SourceControlPort } from "../../application/ports/index.js";
import { type DomainError, type Result, ok } from "../../domain/foundation/index.js";
import type { Project } from "../../domain/project/index.js";
import type {
  PullRequestAuditCommentWriter,
  RegistrationSetupExternalAuditCommentReceipt,
} from "./setup-audit.js";

/**
 * Thin, field-mapping-only production `PullRequestAuditCommentWriter`: delegates every mutation
 * to the existing `SourceControlPort.appendChangeRequestComment` (the same method
 * `GitHubAdapter` already exposes, src/adapters/github/adapter.ts:459-534). `kind` is fixed to
 * `"automation"` -- this writer never emits `"review_evidence"` comments; that stays the
 * exclusive concern of `SourceControlRegistrationSetupGateEvidence`.
 *
 * Two fields the engine's `RegistrationSetupExternalAuditCommentReceipt` requires are not part of
 * `SourceControlPort`'s own `ChangeRequestCommentReceipt` (which is deliberately narrow:
 * `{id, url, createdAt}`, see src/application/ports/source-control.ts:74-78):
 *
 * - `body`: safe to return as the exact `body` this call was asked to post, *not* because it is
 *   echoed unverified, but because `GitHubAdapter.appendChangeRequestComment` only ever resolves
 *   `ok(...)` after an internal exact-string readback already confirmed the persisted GitHub
 *   comment body equals `storedBody` (== this `body` plus the adapter's own idempotency marker)
 *   -- both its "reused existing comment" branch and its "created new comment" branch assert
 *   this before returning success. By the time this method observes `ok`, `body` is already a
 *   verified fact about upstream state.
 * - `reused`: genuinely not observable through this port (both branches above share one return
 *   shape). This adapter reports `reused: false` as a best-effort placeholder; this is provably
 *   harmless today because nothing in application code branches on the pull-request destination's
 *   `.reused` (grep confirms zero readers) -- it is carried through only as durable audit
 *   metadata, never a control-flow input.
 */
export class GitHubPullRequestAuditCommentWriter implements PullRequestAuditCommentWriter {
  readonly #sourceControl: Pick<SourceControlPort, "appendChangeRequestComment">;

  constructor(sourceControl: Pick<SourceControlPort, "appendChangeRequestComment">) {
    this.#sourceControl = sourceControl;
  }

  async appendChangeRequestComment(
    changeRequest: Readonly<{
      projectId: string;
      repository: string;
      changeRequestId: string;
    }>,
    exactHead: string,
    body: string,
    options: MutationOptions,
  ): Promise<Result<RegistrationSetupExternalAuditCommentReceipt, DomainError>> {
    // `GitHubAdapter.appendChangeRequestComment` only ever reads
    // `reference.project.sourceControl.{provider,repository}` (see `validRepository` /
    // `repositoryPath` in adapter.ts:155-180) and `reference.changeRequestId` -- never any other
    // `Project` field -- so a minimal literal satisfying just those two is safe to pass through
    // this narrow boundary. `PullRequestAuditCommentWriter`'s own contract intentionally never
    // carries a full `Project` (see setup-audit.ts:36-47), only `projectId`/`repository`.
    const minimalProject = {
      sourceControl: { provider: "github", repository: changeRequest.repository },
    } as unknown as Project;
    const result = await this.#sourceControl.appendChangeRequestComment(
      {
        changeRequest: { project: minimalProject, changeRequestId: changeRequest.changeRequestId },
        expectedHeadSha: exactHead,
        kind: "automation",
        body,
      },
      options,
    );
    if (!result.ok) return result;
    return ok(
      Object.freeze({
        id: result.value.id,
        body,
        createdAt: result.value.createdAt,
        reused: false,
      }),
    );
  }
}
