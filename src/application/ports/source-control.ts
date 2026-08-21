import type { Instant } from "../../domain/foundation/index.js";
import type { Project } from "../../domain/project/index.js";
import type { AsyncPortResult, MutationOptions, ReadOptions } from "./common.js";

export interface SourceControlRepositoryRef {
  readonly project: Project;
}

export interface ChangeRequestRef extends SourceControlRepositoryRef {
  /**
   * Provider-visible change request number, as a decimal string (GitHub: PR
   * number). This is NOT the same value as {@link ChangeRequestSnapshot.id},
   * which is an opaque provider-internal identifier (GitHub: GraphQL node
   * id). Adapters that parse this field into a number (e.g. GitHub's
   * `changeRequestNumber()`) require the decimal-number form; passing the
   * opaque id here fails parsing. See O009c.
   */
  readonly changeRequestId: string;
}

export interface ChangeRequestSnapshot {
  /**
   * Opaque provider-internal identifier (GitHub: GraphQL node id, e.g.
   * `PR_kwDOTvUUF877drQL`). Not a decimal string — do not use this to
   * populate {@link ChangeRequestRef.changeRequestId}; use {@link number}
   * instead. See O009c.
   */
  readonly id: string;
  readonly number: number;
  readonly url: string;
  readonly state: "open" | "closed" | "merged";
  readonly draft: boolean;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly headSha: string;
  readonly mergeability: "mergeable" | "conflicting" | "unknown";
  /**
   * C015x decision 2: GitHub's own `mergeable_state` (REST) -- before this ticket, `mergeability`
   * above (derived only from `.mergeable`) could report `"mergeable"` for a PR that is genuinely
   * `BEHIND` its base (no textual conflict, but this project's own `strictRequiredStatusChecksPolicy`
   * ruleset, O004, still refuses to execute the merge) -- BEHIND was structurally invisible to this
   * type. See resume-composition.ts's `resumeMergingStage` for the one place this actually changes
   * behavior (an immediate `requires_manual` the instant this is `"behind"`, never a silent wait).
   *
   * Optional here -- and on {@link baseSha} below -- purely to avoid a mechanical, unrelated ripple
   * across every pre-existing `ChangeRequestSnapshot` test fixture in the suite (30+ files as of
   * this ticket) that predates this field and has no reason to ever construct a BEHIND scenario.
   * The real `GitHubAdapter` (adapters/github/adapter.ts) always populates both via its own
   * required, zod-validated projection; only test fakes may ever legitimately omit them.
   */
  readonly mergeStateStatus?:
    "clean" | "behind" | "blocked" | "dirty" | "draft" | "unstable" | "unknown";
  /**
   * GitHub's own `.base.sha` -- the base commit SHA the PR's `base` ref pointed to at PR-creation
   * (readback) time. **Not** the base branch's live tip: `.base.sha` is a value GitHub freezes
   * once and never updates as the base branch advances (a PR opened against `main` yesterday still
   * reports yesterday's `main` tip here today, however far `main` has moved since).
   *
   * C015z decision (Q3): the prior header here (C015x decision 3) called this "GitHub's own
   * current base-branch tip" and `resolveLegacyBaseRevision` (resume-composition.ts) cross-checked
   * it against a freshly re-resolved *live* tip on that false premise -- the two are structurally
   * guaranteed to differ the instant the base branch advances past PR-creation time, which is
   * exactly the situation that repair path existed to handle. See that function's own header for
   * the corrected behavior (legacy records now fail closed to `requires_manual` unconditionally,
   * never attempting to reconcile this field against anything).
   *
   * C015z decision (Q4): for the same reason, this field carries no discriminating "did the merge
   * make progress" signal either -- `mergeFingerprintOf` (resume-composition.ts) no longer reads
   * it. Still present here (optional, as before) purely for pre-existing test-fixture back-compat
   * and because it remains genuine evidence worth recording on a `requires_manual` cause for a
   * human to read.
   */
  readonly baseSha?: string;
  readonly autoMergeEnabled: boolean;
  /** Exact provider merge receipt. Real adapters populate both fields for `state:"merged"`;
   * optional only for legacy test fakes and non-merged snapshots. */
  readonly mergeCommitSha?: string;
  readonly mergedAt?: Instant;
  readonly updatedAt: Instant;
}

export interface CreateDraftChangeRequestCommand extends SourceControlRepositoryRef {
  readonly title: string;
  readonly body: string;
  readonly baseBranch: string;
  readonly headBranch: string;
}

export interface CommitCheck {
  readonly name: string;
  readonly status: "queued" | "in_progress" | "completed";
  readonly conclusion: "success" | "failure" | "cancelled" | "skipped" | null;
  readonly url?: string;
}

export interface CommitChecksSnapshot {
  readonly headSha: string;
  readonly aggregate: "pending" | "success" | "failure";
  readonly checks: readonly CommitCheck[];
}

export interface CommitStatusCommand extends SourceControlRepositoryRef {
  readonly headSha: string;
  readonly context: string;
  readonly state: "pending" | "success" | "failure" | "error";
  readonly description: string;
  readonly targetUrl?: string;
}

export interface CommitStatus {
  readonly context: string;
  readonly state: "pending" | "success" | "failure" | "error";
  readonly description?: string;
  readonly targetUrl?: string;
}

export interface CommitStatusesSnapshot {
  readonly headSha: string;
  readonly statuses: readonly CommitStatus[];
}

export interface ChangeRequestCommentCommand {
  readonly changeRequest: ChangeRequestRef;
  readonly expectedHeadSha: string;
  readonly kind: "review_evidence" | "automation";
  readonly body: string;
}

export interface ChangeRequestCommentReceipt {
  readonly id: string;
  readonly url: string;
  readonly createdAt: Instant;
}

export interface SourceControlPort {
  getChangeRequest(
    reference: ChangeRequestRef,
    options?: ReadOptions,
  ): AsyncPortResult<ChangeRequestSnapshot>;
  createDraftChangeRequest(
    command: CreateDraftChangeRequestCommand,
    options: MutationOptions,
  ): AsyncPortResult<ChangeRequestSnapshot>;
  getCommitChecks(
    repository: SourceControlRepositoryRef,
    headSha: string,
    options?: ReadOptions,
  ): AsyncPortResult<CommitChecksSnapshot>;
  getCommitStatuses(
    repository: SourceControlRepositoryRef,
    headSha: string,
    options?: ReadOptions,
  ): AsyncPortResult<CommitStatusesSnapshot>;
  setCommitStatus(command: CommitStatusCommand, options: MutationOptions): AsyncPortResult<void>;
  appendChangeRequestComment(
    command: ChangeRequestCommentCommand,
    options: MutationOptions,
  ): AsyncPortResult<ChangeRequestCommentReceipt>;
  markChangeRequestReady(
    reference: ChangeRequestRef,
    expectedHeadSha: string,
    options: MutationOptions,
  ): AsyncPortResult<ChangeRequestSnapshot>;
  enableAutoMerge(
    reference: ChangeRequestRef,
    expectedHeadSha: string,
    options: MutationOptions,
  ): AsyncPortResult<ChangeRequestSnapshot>;
  closeChangeRequest(
    reference: ChangeRequestRef,
    options: MutationOptions,
  ): AsyncPortResult<ChangeRequestSnapshot>;
}
