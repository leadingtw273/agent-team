/**
 * C015a: CLI handler for `agent-team run --project <id> [--dry-run]`. Mirrors the exact shape
 * `createRegistrationProbeHandlers` (src/cli/registration/probe-handlers.ts) already established:
 * a fixed per-reason Traditional-Chinese message table for every `blocked` composition reason
 * (missing config -> exit code 3, zero external calls -- program.ts's `outcomeExitCode` maps
 * `state:"blocked"` to `cliExitCodes.blocked` unconditionally), and a `buildComposition` override
 * hook so tests can inject a fake composition without touching any real file/network.
 *
 * C015b item 5: once a candidate is genuinely `kind:"dispatched"` (never in `--dry-run`, which
 * stays zero-mutation/zero-pipeline exactly as C015a left it), this same process drives the
 * `ImplementerPipeline` to completion (`ci_waiting`/`paused`/`failed`) before this command exits
 * -- there is no separate "start the pipeline" step or background process. Only `role ===
 * "implementer"` candidates are driven; other roles' pipelines (reviewer, integration, ...) are
 * not this ticket's job, so a dispatched non-implementer job is reported as `dispatched` with
 * `pipeline: "not_applicable_role"`, exactly like before this ticket existed.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { CliHandlers } from "../program.js";
import {
  classifyClaudeChangeRegions,
  createClaudeQuotaCollector,
} from "../../adapters/providers/claude/index.js";
import { createCodexQuotaCollector } from "../../adapters/providers/codex/index.js";
import { ChildProcessRunner } from "../../adapters/process/index.js";
import { LocalGitAdapter } from "../../adapters/git/index.js";
import { GitHubAdapter } from "../../adapters/github/index.js";
import { LeaseCoordinator } from "../../application/leases/index.js";
import {
  WorkStatusLifecycleCoordinator,
  createWorkStatusLifecycleTransitionInstance,
  type ImplementerPipelineOutcome,
} from "../../application/pipelines/index.js";
import type { ModelRoutingConfig } from "../../application/routing/index.js";
import type {
  FileJobProgressStore,
  JobProgressRecord,
  JobProgressRecordMutation,
  JobProviderAssignments,
  ProtectedRegionHandoff,
  RequiresManualReasonCode,
} from "../../adapters/dispatch/job-progress-store.js";
import {
  FileIssueScopeLock,
  JobProgressWorkStatusLifecycleLedger,
} from "../../adapters/dispatch/index.js";
import { checkpointIdSchema } from "../../domain/checkpoint/index.js";
import {
  createClock,
  ok,
  type Clock,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { headShaSchema, sha256Digest } from "../../domain/review/index.js";
import { createAgentCondition } from "../../domain/workflow/index.js";
import type { Project } from "../../domain/project/index.js";
import {
  resolveAuthoritativeBaseRevision,
  type AuthoritativeBaseFailure,
} from "./authoritative-base.js";
import {
  buildDispatchComposition,
  dispatchOnce,
  type BuildDispatchCompositionResult,
  type DispatchBootstrapInput,
  type DispatchCompositionBlockedReason,
} from "./composition.js";
import {
  InMemoryIssueAdmissionStore,
  InMemoryJobRepository,
  InMemoryLeaseRepository,
} from "./ephemeral-ports.js";
import {
  buildImplementerPipelineRequest,
  implementerBranch,
  implementerWorktreePath,
} from "./implementer-request.js";
import {
  buildImplementerPipeline,
  type BuildImplementerPipelineResult,
} from "./implementer-composition.js";
import {
  buildAutoMergePauseStore,
  buildIssueAdmissionStore,
  buildJobProgressStore,
  type ResumeJobOutcome,
} from "./resume-composition.js";
import {
  buildResumeComposition,
  type BuildResumeCompositionResult,
} from "./resume-full-composition.js";
import { createOperatorCanaryCliHandlers } from "./operator-canary-attestation.js";
import { createDispatchResolveHandler } from "./resolve-handlers.js";
import { createDispatchResolveLegacyClaimHandler } from "./legacy-claim-handlers.js";
import { createDispatchAutoMergeResumeHandler } from "./auto-merge-pause-handlers.js";
import { createReviewerResumeHandler } from "./reviewer-resume-handlers.js";
import { createReviewerReplayHandlers } from "./reviewer-replay-handlers.js";
import { createWorkStatusRecoveryHandler } from "./work-status-recovery-handlers.js";
import {
  reconcileBootstrapClaims,
  type BootstrapReconciliationOutcome,
} from "./bootstrap-reconciliation.js";
import { ensureDispatchWorktreesDirectory } from "./worktree-directories.js";
import { resumeExistingProjectJobs } from "./resume-existing.js";
import { createQuotaProbeStatusHandler } from "../quota/index.js";
import { LinearWorkManagementAdapter } from "./work-management-adapter.js";
import { PrePrImplementationCoordinator } from "./pre-pr-implementation-coordinator.js";

export interface CreateDispatchCliHandlersOptions {
  readonly agentTeamHome: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Injectable for tests; production defaults to the real `buildDispatchComposition`. */
  readonly buildComposition?: (
    options: Parameters<typeof buildDispatchComposition>[0],
  ) => Promise<BuildDispatchCompositionResult>;
  /** Injectable for tests (deterministic assertions); production defaults to a fresh random id
   * per invocation. This value is not a convention C015b needs to reconstruct -- it is durably
   * recorded on the persisted `Lease` itself (`Lease.holderId`), so C015b can always discover the
   * exact holder of an active lease by reading the lease file back. */
  readonly generateHolderId?: () => string;
  /** Injectable for tests; production defaults to the real `buildImplementerPipeline`. */
  readonly buildImplementerPipeline?: (
    options: Parameters<typeof buildImplementerPipeline>[0],
  ) => Promise<BuildImplementerPipelineResult>;
  /** C015c item 2: injectable for tests; production defaults to the real `buildResumeComposition`
   * (the GitHub-auth-gated bundle of CiRecovery/Reviewer/ReviewStatus+AutoMerge/Lifecycle). */
  readonly buildResumeComposition?: (
    options: Parameters<typeof buildResumeComposition>[0],
  ) => Promise<BuildResumeCompositionResult>;
  /** Injectable for CLI redaction/orchestration tests; production uses the shared resume bridge. */
  readonly resumeExistingProjectJobs?: typeof resumeExistingProjectJobs;
  /** C015x decision 1: injectable for tests; production defaults to the real
   * `resolveAuthoritativeBaseRevision` (this ticket's fix -- see that file's own header). Existing
   * tests that predate this ticket and only care about the pipeline hand-off (not this resolution
   * itself) inject a trivial fake here rather than needing a real `origin` remote/GitHub
   * credentials just to get past this step. */
  readonly resolveAuthoritativeBase?: typeof resolveAuthoritativeBaseRevision;
  readonly clock?: Clock;
  /** Narrow test seam for the protected-region handoff; production always uses the real Linear
   * adapter built from this dispatch composition's already-shared read/mutation clients. */
  readonly protectedRegionWorkManagement?: Pick<
    LinearWorkManagementAdapter,
    "setWorkStatus" | "setAgentCondition" | "appendComment"
  >;
  readonly workStatusLifecycleWorkManagement?: Pick<
    LinearWorkManagementAdapter,
    "getIssue" | "setWorkStatus" | "setAgentCondition" | "clearAgentCondition"
  > &
    Partial<Pick<LinearWorkManagementAdapter, "getIssueHistory">>;
}

/** Preserve the adapter receiver when exposing its optional history method through the
 * lifecycle port. `LinearWorkManagementAdapter#getIssueHistory` reads private instance fields,
 * so extracting the method and invoking it as a bare function throws before the pipeline starts. */
export function bindWorkStatusIssueHistory(
  workManagement: Partial<Pick<LinearWorkManagementAdapter, "getIssueHistory">>,
): LinearWorkManagementAdapter["getIssueHistory"] | undefined {
  const getIssueHistory = workManagement.getIssueHistory;
  return getIssueHistory === undefined
    ? undefined
    : (...args) => getIssueHistory.apply(workManagement, args);
}

const implementerCompositionBlockedMessages: Readonly<Record<string, string>> = Object.freeze({
  github_authentication_unavailable: "GitHub CLI（gh）未通過身分驗證，無法建立 Draft PR。",
});

export const protectedRegionHandoffComment =
  "Agent Team 已停止自動執行：此工單宣告的變更範圍包含 AI 實作者不可寫入的受保護區域（例如 CI 設定或 repository 根層檔案）。為避免模型修改驗證機制，本次未啟動模型、未建立 PR。請由人工處理，或拆成只包含允許目錄的獨立工單；完成後先使用 dispatch resolve 結束舊工作，再重新通過 Ready Gate 並明確移回待執行。";

type ProtectedRegionPrimaryReason =
  | "job_progress_write_failed"
  | "protected_region_lease_release_failed"
  | "protected_region_sync_failed";

interface ProtectedRegionAttempt {
  readonly handoff: ProtectedRegionHandoff;
  readonly primaryReason?: Exclude<ProtectedRegionPrimaryReason, "job_progress_write_failed">;
}

function progressMutation(record: JobProgressRecord): JobProgressRecordMutation {
  return Object.freeze({
    jobId: record.jobId,
    projectId: record.projectId,
    issueId: record.issueId,
    externalIssueId: record.externalIssueId,
    model: record.model,
    ...(record.providerAssignments === undefined
      ? {}
      : { providerAssignments: record.providerAssignments }),
    stage: record.stage,
    branch: record.branch,
    worktreePath: record.worktreePath,
    ...(record.protectedRegionHandoff === undefined
      ? {}
      : { protectedRegionHandoff: record.protectedRegionHandoff }),
    ...(record.changeRequestId === undefined ? {} : { changeRequestId: record.changeRequestId }),
    ...(record.headSha === undefined ? {} : { headSha: record.headSha }),
    ...(record.mergeMutations === undefined ? {} : { mergeMutations: record.mergeMutations }),
    ...(record.baseRevision === undefined ? {} : { baseRevision: record.baseRevision }),
    ...(record.reviewerReplay === undefined ? {} : { reviewerReplay: record.reviewerReplay }),
    ...(record.previousReviewerReplay === undefined
      ? {}
      : { previousReviewerReplay: record.previousReviewerReplay }),
    ...(record.workStatusLifecycle === undefined
      ? {}
      : { workStatusLifecycle: record.workStatusLifecycle }),
  });
}

async function persistDispatchProgress(
  progress: FileJobProgressStore,
  next: JobProgressRecordMutation,
): Promise<Result<JobProgressRecord, DomainError>> {
  const current = await progress.load(next.jobId);
  if (!current.ok) return current;
  if (current.value === undefined) return progress.compareAndSwap(next.jobId, null, next);
  return progress.compareAndSwap(next.jobId, current.value.revision, {
    ...progressMutation(current.value),
    ...next,
    ...(next.workStatusLifecycle === undefined && current.value.workStatusLifecycle !== undefined
      ? { workStatusLifecycle: current.value.workStatusLifecycle }
      : {}),
  });
}

function providerAssignmentsForNewJob(
  execution: Readonly<{ provider: string; model: string }> | undefined,
  routingConfig: ModelRoutingConfig,
): JobProviderAssignments | undefined {
  const codeReview = routingConfig.routes.find((route) => route.role === "code_reviewer")
    ?.candidates[0];
  if (execution?.provider !== "codex" || codeReview?.provider !== "claude") return undefined;
  return Object.freeze({
    execution: Object.freeze({ provider: "codex", model: execution.model }),
    codeReview: Object.freeze({ provider: "claude", model: codeReview.model }),
  });
}

async function attemptProtectedRegionHandoff(options: {
  readonly handoff: ProtectedRegionHandoff;
  readonly project: Project;
  readonly externalIssueId: string;
  readonly workManagement: Pick<
    LinearWorkManagementAdapter,
    "setWorkStatus" | "setAgentCondition" | "appendComment"
  >;
  readonly leases: LeaseCoordinator;
  readonly idempotencyPrefix: string;
}): Promise<ProtectedRegionAttempt> {
  let workflowState = options.handoff.workflowState;
  let agentCondition = options.handoff.agentCondition;
  let comment = options.handoff.comment;
  let leaseRelease = options.handoff.leaseRelease;

  const reference = { project: options.project, externalIssueId: options.externalIssueId };
  if (workflowState === "pending") {
    const result = await options.workManagement.setWorkStatus(reference, "requires_manual", {
      idempotencyKey: `${options.idempotencyPrefix}:workflow`,
    });
    if (result.ok) workflowState = "confirmed";
  }
  if (agentCondition === "pending") {
    const result = await options.workManagement.setAgentCondition(
      reference,
      createAgentCondition("blocked", ["unknown_error"]),
      { idempotencyKey: `${options.idempotencyPrefix}:agent-condition` },
    );
    if (result.ok) agentCondition = "confirmed";
  }
  if (comment === "pending") {
    const result = await options.workManagement.appendComment(
      reference,
      protectedRegionHandoffComment,
      { idempotencyKey: `${options.idempotencyPrefix}:comment` },
    );
    if (result.ok) comment = "confirmed";
  }
  if (leaseRelease === "pending") {
    const result = await options.leases.release({
      leaseId: options.handoff.leaseId,
      holderId: options.handoff.holderId,
    });
    if (
      result.ok &&
      result.value.persistence !== "unknown" &&
      result.value.lockRelease === "confirmed"
    ) {
      leaseRelease = "confirmed";
    }
  }

  const handoff = Object.freeze({
    ...options.handoff,
    workflowState,
    agentCondition,
    comment,
    leaseRelease,
  });
  const syncConfirmed =
    workflowState === "confirmed" && agentCondition === "confirmed" && comment === "confirmed";
  return Object.freeze({
    handoff,
    ...(leaseRelease !== "confirmed"
      ? { primaryReason: "protected_region_lease_release_failed" as const }
      : !syncConfirmed
        ? { primaryReason: "protected_region_sync_failed" as const }
        : {}),
  });
}

async function persistProtectedRegionAttempt(
  progress: FileJobProgressStore,
  record: JobProgressRecord,
  attempt: ProtectedRegionAttempt,
): Promise<Result<JobProgressRecord, DomainError>> {
  return progress.compareAndSwap(record.jobId, record.revision, {
    ...progressMutation(record),
    protectedRegionHandoff: attempt.handoff,
  });
}

function safeResumeOutcomes(
  outcomes: readonly ResumeJobOutcome[],
): readonly Readonly<Record<string, unknown>>[] {
  return Object.freeze(
    outcomes.map((candidate) => {
      const withPossibleError = candidate as ResumeJobOutcome & { readonly error?: DomainError };
      const { error, ...safe } = withPossibleError;
      return Object.freeze(error === undefined ? safe : { ...safe, errorCode: error.code });
    }),
  );
}

type DispatchHandlers = Pick<
  CliHandlers,
  | "run"
  | "dispatchResolve"
  | "dispatchResolveLegacyClaim"
  | "dispatchAutoMergeResume"
  | "dispatchReviewerResume"
  | "dispatchReviewerReplay"
  | "dispatchReviewerReplayPolicy"
  | "dispatchWorkStatusRecover"
  | "quota"
>;

const blockedMessages: Readonly<Record<DispatchCompositionBlockedReason, string>> = Object.freeze({
  draft_unavailable:
    "找不到有效的 Setup draft 檔（${AGENT_TEAM_HOME}/config/registration/<projectId>.draft.json），或格式不符 schema。",
  linear_api_key_missing: "缺少 LINEAR_API_KEY 環境變數。",
  routing_config_unavailable:
    "找不到有效的 Model Routing 設定檔（${AGENT_TEAM_HOME}/config/dispatch/routing.json），或格式不符 schema。",
  provider_config_unavailable:
    "找不到有效的 Provider 設定檔（${AGENT_TEAM_HOME}/config/dispatch/providers.json），或格式不符 schema。",
  invalid_registry_entry: "專案設定物件本身不符合 Project schema。",
  trusted_config_missing: "專案 repository 內找不到 .agent-team/project.json。",
  trusted_config_unavailable: "讀取專案 repository 內 .agent-team/project.json 失敗。",
  trusted_config_invalid: "專案 repository 內 .agent-team/project.json 格式不符 schema。",
  secret_in_trusted_config: ".agent-team/project.json 內偵測到疑似機密內容，拒絕載入。",
  project_id_mismatch: "Draft 內的 project id 與 repository 內信任設定不一致。",
  default_branch_mismatch: "Draft 內的 defaultBranch 與 repository 內信任設定不一致。",
  platform_mismatch:
    "Draft 內的 workManagement／sourceControl 設定與 repository 內信任設定不一致。",
  activation_missing: "此 project 尚未完成 Registration Setup activation。",
  activation_unavailable: "讀取 Registration Setup activation 記錄失敗。",
  activation_invalid: "Registration Setup activation 記錄格式不符 schema。",
  registry_conflict: "此 project 與其他已註冊專案的 id／repository 衝突。",
});

function outcome(state: "success" | "failed" | "blocked", payload: unknown) {
  return Object.freeze({ state, message: JSON.stringify(payload) });
}

/** C015x decision 1: `AuthoritativeBaseFailure`'s three variants carry different evidence
 * (`default_branch_mismatch` has no `DomainError` at all -- it is a live cross-check disagreement,
 * not an external-call failure) -- this normalizes them into a single serializable shape for the
 * CLI's own JSON output, never dropping whichever evidence that specific reason actually has. */
function authoritativeBaseErrorDetail(
  error: AuthoritativeBaseFailure,
): Readonly<Record<string, unknown>> {
  switch (error.reason) {
    case "default_branch_metadata_unavailable":
    case "authoritative_branch_unavailable":
      return Object.freeze({ code: error.error.code });
    case "default_branch_mismatch":
      return Object.freeze({
        githubDefaultBranch: error.githubDefaultBranch,
        configuredDefaultBranch: error.configuredDefaultBranch,
      });
  }
}

function pipelineOutcomePayload(
  outcome: ImplementerPipelineOutcome,
): Readonly<Record<string, unknown>> {
  switch (outcome.state) {
    case "ci_waiting":
      return Object.freeze({
        pipeline: "ci_waiting",
        changeRequestUrl: outcome.changeRequest.url,
        commitSha: outcome.commit.sha,
        ...(outcome.providerSessionId === undefined
          ? {}
          : { providerSessionId: outcome.providerSessionId }),
      });
    case "paused":
      return Object.freeze({
        pipeline: "paused",
        pauseReason: outcome.reason,
        ...(outcome.checkpointId === undefined ? {} : { checkpointId: outcome.checkpointId }),
        ...(outcome.toolSummary === undefined ? {} : { toolSummary: outcome.toolSummary }),
      });
    case "failed":
      return Object.freeze({
        pipeline: "failed",
        stage: outcome.stage,
        errorCode: outcome.error.code,
        // C015j (side item): `ImplementerPipeline.run()`'s own internal request-shape validation
        // (`requestShapeValid`/`validRequest`, src/application/pipelines/implementer.ts) fails
        // closed with a single generic `domainError("invariant_violation")` for every one of the
        // many distinct things it checks (idempotency key shape, worktree path, branch, model,
        // deadline, changeRegions, ...) -- `DomainError.code` is a fixed, small enum (see
        // domain/foundation/error.ts) that cannot grow a dedicated code per check without
        // touching the domain foundation type itself (an engine change, outside this ticket's
        // authority). This adds a fixed, diagnosable CLI-layer reason on top -- it never changes
        // `error.code` itself, which is still exactly what the engine returned; it only gives an
        // operator reading `agent-team run`'s JSON output something more specific than
        // `invariant_violation` to search for. C015j's main fix (the discovery-layer
        // `missing_change_regions` skip, src/adapters/dispatch/linear-discovery.ts) already
        // prevents the one known *data-quality* cause of this stage failing for implementer-role
        // candidates -- what is left here is a genuine internal-invariant failure (a bug in this
        // CLI layer's own `buildImplementerPipelineRequest`, not a bad Linear issue).
        ...(outcome.stage === "request"
          ? { pipelineReason: "implementer_pipeline_request_rejected" }
          : {}),
      });
  }
}

/**
 * C018 fix: every `outcome("failed", ...)` return inside `case "dispatched"` below, once the
 * per-issue admission claim already has `jobId` attached (`attachJob`, issue-admission-store.ts,
 * called by `dispatchOnce`/composition.ts *before* it ever returns `kind:"dispatched"`) and a real
 * `Job`/`Lease` already exist, used to leave that claim durably, permanently unreleasable -- the
 * exact same defect class C016 already closed for `state:"paused"`, generalized here to every
 * remaining exit (see job-progress-store.ts's own `requiresManualStageSchema`/`paused`-stage
 * comments for the full invariant this now establishes).
 *
 * `not_dispatched` (issue-admission-store.ts's own release-reason enum) is deliberately never used
 * for any of these exits: that reason is reserved for a claim that *never* had a `jobId` attached
 * at all (a losing candidate in `dispatchOnce`'s own reconcile step, composition.ts) -- releasing
 * a claim that already has this job's real `jobId` on it with `not_dispatched` would misrepresent
 * a job that genuinely started (a domain `Job` + `Lease` both exist) as one that never did. Every
 * exit this closes instead writes a `requires_manual` record (`cause.stage:"dispatch"`, a new,
 * closed reasonCode per exit) -- `dispatch resolve` (resolve-handlers.ts) already knows how to
 * transition any non-terminal job-progress record to `superseded`/`cancelled` and release the
 * matching claim, so this reuses that exact mechanism rather than inventing a second one.
 *
 * Fails closed exactly like the pre-existing `ci_waiting`/`paused` writes further down (C016's own
 * discipline, restated here so it is not just tribal knowledge at each of this function's several
 * call sites): if *this* write itself fails, the caller must surface `job_progress_write_failed`
 * and persist nothing partial -- never attempt a second, differently-shaped write. The store
 * already failed once; a second attempt against the same store is not expected to fare any
 * better, and a half-written record would be worse than none.
 */
async function writeDispatchRequiresManual(
  progress: FileJobProgressStore,
  reasonCode: RequiresManualReasonCode,
  fields: Omit<JobProgressRecordMutation, "stage">,
): Promise<Result<JobProgressRecord, DomainError>> {
  const written = await persistDispatchProgress(progress, {
    ...fields,
    stage: {
      kind: "requires_manual",
      cause: { stage: "dispatch", reasonCode, attempts: { count: 1 } },
    },
  });
  return written;
}

/**
 * C019 fix (item 3): extracted out of both `requires_manual` fallback call sites that need it
 * (the `role_pipeline_unavailable` and `implementer_request_invalid` writes below) so it is
 * directly unit-testable on its own. This ticket's own review confirmed there is no way to reach
 * `issue === undefined` through the public `createDispatchCliHandlers` composition: the
 * `candidates.find(...)` lookup at each call site and the candidate `dispatchOnce` actually
 * dispatched are both always derived from the exact same single `discoverReadyDispatchCandidates`
 * call within one `dispatchOnce` invocation (composition.ts), so they can never diverge in
 * production -- this is a defensive discovery/decision-inconsistency guard, not a reachable
 * branch, and is tested directly here rather than via a fabricated end-to-end fixture.
 */
export function implementerRequestInvalidExternalIssueId(
  issue: { readonly externalId: string } | undefined,
  jobIssueId: string,
): string {
  return issue?.externalId ?? jobIssueId;
}

export function createDispatchCliHandlers(
  options: CreateDispatchCliHandlersOptions,
): DispatchHandlers {
  const generateHolderId = options.generateHolderId ?? (() => `cli-dispatch:${randomUUID()}`);
  const clock = options.clock ?? createClock();
  const buildPipelineComposition = options.buildImplementerPipeline ?? buildImplementerPipeline;
  const operatorCanary = createOperatorCanaryCliHandlers({
    agentTeamHome: options.agentTeamHome,
    clock,
  });
  const quota = Object.freeze({
    ...operatorCanary,
    probeStatus: createQuotaProbeStatusHandler({
      agentTeamHome: options.agentTeamHome,
      clock,
      claude: createClaudeQuotaCollector({
        process: new ChildProcessRunner(),
        workingDirectory: process.cwd(),
        clock,
      }),
      codex: createCodexQuotaCollector({ clock }),
    }),
  });

  // C015o decision 4: `dispatch resolve` always operates on the real, durable job-progress/
  // admission stores -- there is no `--dry-run` concept for it (it is itself the manual escape
  // hatch out of a stuck real job; a dry-run version would have nothing meaningful to predict).
  const dispatchResolve = createDispatchResolveHandler({
    progress: buildJobProgressStore(options.agentTeamHome),
    admission: buildIssueAdmissionStore(options.agentTeamHome),
  });

  // C016: same "no --dry-run concept" rationale as `dispatchResolve` right above -- this is
  // itself a manual, human-confirmed repair of a real durable claim; a dry-run version would have
  // nothing meaningful to predict.
  const dispatchResolveLegacyClaim = createDispatchResolveLegacyClaimHandler({
    progress: buildJobProgressStore(options.agentTeamHome),
    admission: buildIssueAdmissionStore(options.agentTeamHome),
  });

  // E116cap: shared across this handler's own `dispatchAutoMergeResume` (the write side, a human
  // resolving a pause) and the `run` handler's resume cycle below (the read side, threaded into
  // `buildResumeComposition` -> `AutoMergeGate`'s gate check) -- exactly one store instance per
  // process, mirroring `progress`'s own single-instance-per-process convention just above.
  const autoMergePause = buildAutoMergePauseStore(options.agentTeamHome);
  const dispatchAutoMergeResume = createDispatchAutoMergeResumeHandler({
    store: autoMergePause,
    progress: buildJobProgressStore(options.agentTeamHome),
  });
  const dispatchReviewerResume = createReviewerResumeHandler({
    progress: buildJobProgressStore(options.agentTeamHome),
    clock,
  });
  const reviewerReplayHandlers = createReviewerReplayHandlers({
    agentTeamHome: options.agentTeamHome,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    clock,
    generateHolderId,
  });
  const dispatchWorkStatusRecover = createWorkStatusRecoveryHandler({
    agentTeamHome: options.agentTeamHome,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    clock,
    generateHolderId,
  });

  return Object.freeze({
    dispatchResolve,
    dispatchResolveLegacyClaim,
    dispatchAutoMergeResume,
    dispatchReviewerResume,
    dispatchReviewerReplay: reviewerReplayHandlers.reviewerReplay,
    dispatchReviewerReplayPolicy: reviewerReplayHandlers.reviewerReplayPolicy,
    dispatchWorkStatusRecover,
    quota,
    async run(input) {
      if (input.projectId === undefined || input.projectId.trim().length === 0) {
        return outcome("blocked", {
          operation: "dispatch_run",
          state: "blocked",
          reason: "project_id_required",
          message: "run 需要 --project <project-id>。",
        });
      }
      const build = await (options.buildComposition ?? buildDispatchComposition)({
        agentTeamHome: options.agentTeamHome,
        projectId: input.projectId,
        ...(options.environment === undefined ? {} : { environment: options.environment }),
      });
      if (build.state !== "ready") {
        return outcome("blocked", {
          operation: "dispatch_run",
          state: "blocked",
          reason: build.reason,
          message: blockedMessages[build.reason],
        });
      }

      const holderId = generateHolderId();
      const dryRun = input.dryRun === true;
      // Constructing this is cheap (no I/O) and safe in `--dry-run` too; only *using* it (the
      // resume scan below, and the ci_waiting backport further down) is guarded by `!dryRun`.
      const progress = buildJobProgressStore(options.agentTeamHome);
      const durableAdmission = buildIssueAdmissionStore(options.agentTeamHome);
      let bootstrapReconciliation: readonly BootstrapReconciliationOutcome[] = Object.freeze([]);

      if (!dryRun) {
        const reconciled = await reconcileBootstrapClaims({
          agentTeamHome: options.agentTeamHome,
          project: build.value.project,
          admission: durableAdmission,
          progress,
          jobs: build.value.jobs,
        });
        if (!reconciled.ok) {
          return outcome("failed", {
            operation: "dispatch_run",
            state: "blocked",
            projectId: input.projectId,
            reason: "bootstrap_reconciliation_failed",
            errorCode: reconciled.error.code,
          });
        }
        bootstrapReconciliation = reconciled.value;
      }

      // Resume-only bridge shared with `reconcile --all`. It can converge to `none`, but never
      // falls through internally to discovery/new-Job admission.
      if (!dryRun) {
        const resumed = await (options.resumeExistingProjectJobs ?? resumeExistingProjectJobs)({
          agentTeamHome: options.agentTeamHome,
          ready: build.value,
          holderId,
          clock,
          autoMergePause,
          ...(options.buildResumeComposition === undefined
            ? {}
            : { buildResumeComposition: options.buildResumeComposition }),
          buildImplementerPipeline: buildPipelineComposition,
          ...(options.resolveAuthoritativeBase === undefined
            ? {}
            : { resolveAuthoritativeBase: options.resolveAuthoritativeBase }),
        });
        if (resumed.state === "resumed") {
          return outcome(
            resumed.outcomes.some((job) => job.outcome === "failed") ? "failed" : "success",
            {
              operation: "dispatch_run",
              state: "resumed",
              projectId: input.projectId,
              resumed: safeResumeOutcomes(resumed.outcomes),
            },
          );
        }
        if (resumed.state === "blocked") {
          switch (resumed.reason) {
            case "resume_composition_blocked":
              return outcome("blocked", {
                operation: "dispatch_run",
                state: "blocked",
                projectId: input.projectId,
                reason: resumed.compositionReason,
                message: implementerCompositionBlockedMessages[resumed.compositionReason],
              });
            case "job_progress_read_failed":
              return outcome("failed", {
                operation: "dispatch_run",
                state: "blocked",
                projectId: input.projectId,
                reason: resumed.reason,
                message: "讀取本機 job 進度索引失敗（外部/檔案系統故障，非設定缺失，可重試）。",
                errorCode: resumed.error.code,
              });
            case "worktree_directory_unavailable":
              return outcome("failed", {
                operation: "dispatch_run",
                state: "blocked",
                projectId: input.projectId,
                reason: resumed.reason,
                message:
                  "無法確保 dispatch worktree 目錄存在（檔案系統故障，非設定缺失，可重試）。",
                errorCode: resumed.error.code,
              });
            case "resume_cycle_failed":
              return outcome("failed", {
                operation: "dispatch_run",
                state: "blocked",
                projectId: input.projectId,
                reason: resumed.reason,
                message: "恢復既有工作流程時發生非預期錯誤。",
                errorCode: resumed.error.code,
              });
          }
        }
      }

      const ports = dryRun
        ? {
            leases: new LeaseCoordinator(new InMemoryLeaseRepository()),
            jobs: new InMemoryJobRepository(),
            admission: new InMemoryIssueAdmissionStore(),
          }
        : {
            leases: new LeaseCoordinator(build.value.leases),
            jobs: build.value.jobs,
            admission: durableAdmission,
            locks: new FileIssueScopeLock(
              join(options.agentTeamHome, "state", "dispatch", "issue-scope-locks"),
            ),
            bootstrap: async (input: DispatchBootstrapInput) => {
              const { result, candidate, lifecycle } = input;
              const model = result.decision.model?.candidate.model ?? "unresolved";
              const providerAssignments = providerAssignmentsForNewJob(
                result.decision.model?.candidate,
                build.value.routingConfig,
              );
              const written = await progress.compareAndSwap(result.job.id, null, {
                jobId: result.job.id,
                projectId: build.value.project.id,
                issueId: result.job.issueId,
                externalIssueId: candidate.issue.externalId,
                model,
                ...(providerAssignments === undefined ? {} : { providerAssignments }),
                stage: { kind: "work_start_pending" },
                branch: implementerBranch(result.job.id),
                worktreePath: implementerWorktreePath(options.agentTeamHome, result.job.id),
                workStatusLifecycle: {
                  admissionMode: lifecycle.mode,
                  ...(lifecycle.capabilityDigest === undefined
                    ? {}
                    : { capabilityDigest: lifecycle.capabilityDigest }),
                  phase: "work_start",
                  transitions: [],
                },
              });
              return written.ok ? ok(undefined) : written;
            },
          };

      const linearWorkManagement = new LinearWorkManagementAdapter({
        readModel: build.value.discovery.readModel,
        mutationClient: build.value.discovery.mutationClient,
        teamId: build.value.discovery.teamId,
        linearProjectId: build.value.discovery.linearProjectId,
      });
      const workManagement = options.protectedRegionWorkManagement ?? linearWorkManagement;
      const lifecycleWorkManagement =
        options.workStatusLifecycleWorkManagement ?? linearWorkManagement;
      const protectedRegionSyncFailures: Readonly<Record<string, string>>[] = [];
      if (!dryRun) {
        const records = await progress.listForProject(build.value.project.id);
        if (!records.ok) {
          return outcome("failed", {
            operation: "dispatch_run",
            state: "blocked",
            projectId: input.projectId,
            reason: "job_progress_read_failed",
            errorCode: records.error.code,
          });
        }
        for (const record of records.value) {
          if (
            record.stage.kind !== "requires_manual" ||
            record.stage.cause?.reasonCode !== "protected_region_requires_human" ||
            record.protectedRegionHandoff === undefined ||
            (record.protectedRegionHandoff.workflowState === "confirmed" &&
              record.protectedRegionHandoff.agentCondition === "confirmed" &&
              record.protectedRegionHandoff.comment === "confirmed" &&
              record.protectedRegionHandoff.leaseRelease === "confirmed")
          ) {
            continue;
          }
          const attempt = await attemptProtectedRegionHandoff({
            handoff: record.protectedRegionHandoff,
            project: build.value.project,
            externalIssueId: record.externalIssueId,
            workManagement,
            leases: ports.leases,
            idempotencyPrefix: `cli-dispatch:${record.jobId}:protected-region`,
          });
          const persisted = await persistProtectedRegionAttempt(progress, record, attempt);
          if (!persisted.ok || attempt.primaryReason !== undefined) {
            protectedRegionSyncFailures.push(
              Object.freeze({
                jobId: record.jobId,
                reason: !persisted.ok
                  ? "job_progress_write_failed"
                  : (attempt.primaryReason ?? "protected_region_sync_failed"),
              }),
            );
          }
        }
      }

      const dispatchOnceOutcome = await dispatchOnce(build.value, ports, holderId, {
        allowOperatorCanary: !dryRun,
      });
      if (dispatchOnceOutcome.outcome === "capability_failed") {
        return outcome("blocked", {
          operation: "dispatch_run",
          state: "blocked",
          projectId: input.projectId,
          reason: "work_status_capability_unavailable",
          errorCode: dispatchOnceOutcome.error.code,
        });
      }
      if (dispatchOnceOutcome.outcome === "discovery_failed") {
        return outcome("failed", {
          operation: "dispatch_run",
          state: "blocked",
          projectId: input.projectId,
          reason: "discovery_failed",
          message: "讀取 Linear 待執行工單失敗（外部呼叫故障，非設定缺失，可重試）。",
          errorCode: dispatchOnceOutcome.error.code,
        });
      }
      const { result, candidates, discoverySkipped, admissionSkipped, bootstrap } =
        dispatchOnceOutcome;
      const candidateSummaries = candidates.map((candidate) => ({
        issueId: candidate.issue.id,
        externalId: candidate.issue.externalId,
        title: candidate.issue.title,
        agentRole: candidate.issue.agentRole,
        priority: candidate.issue.priority,
        readyAt: candidate.readyAt,
        stage: candidate.stage,
        workKind: candidate.workKind,
      }));

      if (dryRun) {
        const selectedIssue =
          result.kind === "dispatched"
            ? candidates.find((candidate) => candidate.issue.id === result.job.issueId)?.issue
            : undefined;
        const protectedRegionPrediction =
          selectedIssue?.agentRole === "implementer" &&
          selectedIssue.changeRegions !== undefined &&
          classifyClaudeChangeRegions(selectedIssue.changeRegions).state === "blocked"
            ? Object.freeze({
                state: "blocked" as const,
                reason: "protected_region_requires_human" as const,
              })
            : Object.freeze({ state: "allowed" as const });
        return outcome("success", {
          operation: "dispatch_run",
          state: "dry_run",
          projectId: input.projectId,
          result,
          discoverySkipped,
          admissionSkipped,
          candidateSummaries,
          protectedRegionPrediction,
        });
      }

      if (result.kind === "dispatched" && bootstrap.state === "blocked") {
        return outcome("failed", {
          operation: "dispatch_run",
          state: "blocked",
          projectId: input.projectId,
          jobId: result.job.id,
          issueId: result.job.issueId,
          reason: bootstrap.reason,
          pipelineReason: bootstrap.reason,
          errorCode: bootstrap.error.code,
          pipeline: "not_started",
        });
      }

      switch (result.kind) {
        case "dispatched": {
          const dispatchedPayload = {
            operation: "dispatch_run",
            state: "dispatched",
            projectId: input.projectId,
            jobId: result.job.id,
            issueId: result.job.issueId,
            leaseId: result.lease.id,
            holderId,
            skipped: result.skipped,
            discoverySkipped,
            admissionSkipped,
            protectedRegionSyncFailures,
            bootstrapReconciliation,
          };

          // C018 fix: deterministic (a pure function of `result.job.id`, never dependent on
          // `buildImplementerPipelineRequest` succeeding) -- every exit below this point that can
          // fire *before* that call, or when it itself fails, still needs a schema-valid, non-empty
          // `branch`/`worktreePath` pair for its own `requires_manual` fallback write. Reusing the
          // exact same derivation `buildImplementerPipelineRequest` itself calls (implementer-
          // request.ts) means a fallback record's `branch`/`worktreePath` can never silently drift
          // from whatever a later successful dispatch for this same job id would have used.
          //
          // C019 fix: hoisted above the role-scope check right below (previously computed further
          // down, only on the implementer path) -- the non-implementer exit now needs the exact
          // same `branch`/`worktreePath`/`issue`/`model` derivation for its own fallback write, and
          // reusing this one computation keeps both paths' fallback records byte-for-byte
          // consistent with whatever a real implementer dispatch for this same job id would use.
          const branch = implementerBranch(result.job.id);
          const worktreePath = implementerWorktreePath(options.agentTeamHome, result.job.id);

          const issue = candidates.find(
            (candidate) => candidate.issue.id === result.job.issueId,
          )?.issue;
          const model = result.decision.model?.candidate.model;
          const providerAssignments = providerAssignmentsForNewJob(
            result.decision.model?.candidate,
            build.value.routingConfig,
          );
          const providerAssignmentFields =
            providerAssignments === undefined ? {} : { providerAssignments };

          // C015b item 5 scope boundary: only implementer-role work drives a pipeline here.
          // Reviewer/integration/etc. pipelines are separate, unbuilt C-series tickets.
          //
          // C019 fix (item 1, codex-reviewed defect from C018's own acceptance sweep): this used
          // to `return` success right here with zero store writes -- but by this point
          // `dispatchOnce` has already called `attachJob` (composition.ts) and the per-issue
          // admission claim is already active, exactly like every other exit this file's own
          // `writeDispatchRequiresManual` header describes. A non-implementer role is not itself a
          // failure (the pipeline is genuinely, deliberately never constructed for it -- the CLI's
          // own `pipeline:"not_applicable_role"` string is kept verbatim for that reason), but the
          // still-active claim is just as unreleasable as LEA-16's silent-claim deadlock unless a
          // resolvable `requires_manual` record is left behind here too. `role_pipeline_unavailable`
          // is a new, dedicated reasonCode (not reused from any implementer-path check) because the
          // human-facing situation is genuinely different: nothing here failed, this role's
          // pipeline simply does not exist yet.
          if (result.decision.candidate.role !== "implementer") {
            const requiresManual = await writeDispatchRequiresManual(
              progress,
              "role_pipeline_unavailable",
              {
                jobId: result.job.id,
                projectId: build.value.project.id,
                issueId: result.job.issueId,
                externalIssueId: implementerRequestInvalidExternalIssueId(
                  issue,
                  result.job.issueId,
                ),
                model: model ?? "unresolved",
                ...providerAssignmentFields,
                branch,
                worktreePath,
              },
            );
            if (!requiresManual.ok) {
              return outcome("failed", {
                ...dispatchedPayload,
                pipeline: "failed",
                pipelineReason: "job_progress_write_failed",
                errorCode: requiresManual.error.code,
              });
            }
            return outcome("success", {
              ...dispatchedPayload,
              pipeline: "not_applicable_role",
              requiresManual: true,
            });
          }

          if (issue === undefined || model === undefined) {
            // C018 fix: `DispatchCandidate` (application/dispatch/model.ts, the shape
            // `result.decision.candidate` actually has) is deliberately a slim routing-only
            // projection with no `Issue` field at all -- only `DispatcherCandidate`
            // (dispatcher.ts's own internal shape, fed into `Dispatcher.dispatch()` but never
            // returned from it) carries the full `Issue`. So when the `candidates.find(...)`
            // lookup right above genuinely comes back empty, there is no *other* source of this
            // job's real `externalIssueId` anywhere in this function's scope -- an actual
            // discovery/decision inconsistency this defensive branch exists to catch, not merely
            // a narrower way to reach the same data. `result.job.issueId` (the derived domain id,
            // not the raw Linear id) is used as an honest fallback rather than blocking the write
            // entirely: it is still enough for a human to correlate this record with the same
            // invocation's own stdout/logs, and it keeps the actual invariant this ticket closes
            // (a resolvable record exists) even in this narrower, worse-diagnostic-quality case.
            const requiresManual = await writeDispatchRequiresManual(
              progress,
              "implementer_request_invalid",
              {
                jobId: result.job.id,
                projectId: build.value.project.id,
                issueId: result.job.issueId,
                externalIssueId: implementerRequestInvalidExternalIssueId(
                  issue,
                  result.job.issueId,
                ),
                // `model` may genuinely be the undefined half of this branch's own condition --
                // `JobProgressRecord.model` has no optional variant (every other write path
                // always has a real one), so there is no schema-valid way to omit it. This fixed
                // placeholder is never read back as a real model id by any code in this repo; it
                // exists purely so this record can still be written at all, and `dispatch resolve`
                // can still find and release the claim.
                model: model ?? "unresolved",
                ...providerAssignmentFields,
                branch,
                worktreePath,
              },
            );
            if (!requiresManual.ok) {
              return outcome("failed", {
                ...dispatchedPayload,
                pipeline: "failed",
                pipelineReason: "job_progress_write_failed",
                errorCode: requiresManual.error.code,
              });
            }
            return outcome("failed", {
              ...dispatchedPayload,
              pipeline: "failed",
              pipelineReason: "implementer_request_invalid",
            });
          }

          const regionClassification = classifyClaudeChangeRegions(issue.changeRegions ?? []);
          if (regionClassification.state === "blocked") {
            const pendingHandoff: ProtectedRegionHandoff = Object.freeze({
              leaseId: result.lease.id,
              holderId,
              workflowState: "pending",
              agentCondition: "pending",
              comment: "pending",
              leaseRelease: "pending",
            });
            const written = await writeDispatchRequiresManual(
              progress,
              "protected_region_requires_human",
              {
                jobId: result.job.id,
                projectId: build.value.project.id,
                issueId: result.job.issueId,
                externalIssueId: issue.externalId,
                model,
                ...providerAssignmentFields,
                branch,
                worktreePath,
                protectedRegionHandoff: pendingHandoff,
              },
            );
            const attempt = await attemptProtectedRegionHandoff({
              handoff: pendingHandoff,
              project: build.value.project,
              externalIssueId: issue.externalId,
              workManagement,
              leases: ports.leases,
              idempotencyPrefix: `cli-dispatch:${result.job.id}:protected-region`,
            });
            const persisted = written.ok
              ? await persistProtectedRegionAttempt(progress, written.value, attempt)
              : written;
            const primaryReason: ProtectedRegionPrimaryReason | undefined = !written.ok
              ? "job_progress_write_failed"
              : !persisted.ok
                ? "job_progress_write_failed"
                : attempt.primaryReason;
            return outcome(primaryReason === undefined ? "success" : "failed", {
              ...dispatchedPayload,
              state: "requires_manual",
              pipeline: "not_started",
              pipelineReason: primaryReason ?? "protected_region_requires_human",
              protectedRegionCount: regionClassification.protectedRegionCount,
              handoff: attempt.handoff,
              requiresManual: true,
            });
          }

          // LWS03: every newly-bootstrapped Job now uses the same pre-PR coordinator as crash
          // recovery. The legacy block below remains only as a defensive fallback for an old or
          // injected progress record that predates the work_start checkpoint contract.
          const prePrRecord = await progress.load(result.job.id);
          if (
            prePrRecord.ok &&
            prePrRecord.value?.stage.kind === "work_start_pending" &&
            prePrRecord.value.workStatusLifecycle !== undefined
          ) {
            let observedPipelineOutcome: ImplementerPipelineOutcome | undefined;
            const lifecycleHistory = bindWorkStatusIssueHistory(lifecycleWorkManagement);
            const prePr = new PrePrImplementationCoordinator({
              agentTeamHome: options.agentTeamHome,
              project: build.value.project,
              trustedConfig: build.value.trustedConfig,
              progress,
              jobs: build.value.jobs,
              admission: durableAdmission,
              workManagement: lifecycleWorkManagement,
              workStatus: new WorkStatusLifecycleCoordinator({
                workManagement: lifecycleWorkManagement,
                ...(lifecycleHistory !== undefined
                  ? {
                      history: {
                        getIssueHistory: (...args) => lifecycleHistory(...args),
                      },
                    }
                  : {}),
                ledger: new JobProgressWorkStatusLifecycleLedger(progress),
                locks: new FileIssueScopeLock(
                  join(options.agentTeamHome, "state", "dispatch", "issue-scope-locks"),
                ),
                clock,
              }),
              clock,
              ensureWorktreeDirectory: () =>
                ensureDispatchWorktreesDirectory(options.agentTeamHome),
              buildPipeline: () =>
                buildPipelineComposition({
                  agentTeamHome: options.agentTeamHome,
                  codexConfig: build.value.codex.config,
                }),
              resolveAuthoritativeBase: (project, resolveOptions) =>
                (options.resolveAuthoritativeBase ?? resolveAuthoritativeBaseRevision)(
                  project,
                  { git: new LocalGitAdapter(), sourceControl: new GitHubAdapter() },
                  resolveOptions,
                ),
            });
            const coordinated = await prePr.run(prePrRecord.value, {
              holderId: `work-status:${holderId}`,
              issue,
              onPipelineOutcome: (pipelineOutcome) => {
                observedPipelineOutcome = pipelineOutcome;
              },
            });
            const pipelineResultMatches =
              observedPipelineOutcome?.state === "ci_waiting"
                ? coordinated.outcome === "still_ci_waiting"
                : observedPipelineOutcome?.state === "paused"
                  ? coordinated.outcome === "checkpointed" ||
                    (coordinated.outcome === "requires_manual" &&
                      coordinated.reason === observedPipelineOutcome.reason)
                  : observedPipelineOutcome?.state === "failed";
            if (observedPipelineOutcome !== undefined && pipelineResultMatches) {
              return outcome(observedPipelineOutcome.state === "failed" ? "failed" : "success", {
                ...dispatchedPayload,
                ...pipelineOutcomePayload(observedPipelineOutcome),
              });
            }
            const coordinatedError = "error" in coordinated ? coordinated.error : undefined;
            const coordinatedReason =
              "reason" in coordinated ? coordinated.reason : coordinated.outcome;
            const authoritativeBaseFailure = new Set([
              "default_branch_metadata_unavailable",
              "authoritative_branch_unavailable",
              "default_branch_mismatch",
            ]).has(coordinatedReason);
            return outcome("failed", {
              ...dispatchedPayload,
              pipeline:
                coordinatedReason === "github_authentication_unavailable" ? "blocked" : "failed",
              pipelineReason: authoritativeBaseFailure
                ? "authoritative_base_unavailable"
                : coordinatedReason,
              ...(authoritativeBaseFailure ? { reason: coordinatedReason } : {}),
              ...(coordinatedError === undefined
                ? ["invalid_head_sha", "invalid_checkpoint_id", "invalid_base_revision"].includes(
                    coordinatedReason,
                  )
                  ? { errorCode: "invariant_violation" }
                  : {}
                : { errorCode: coordinatedError.code }),
              requiresManual: coordinated.outcome === "requires_manual",
            });
          }

          const pipelineComposition = await buildPipelineComposition({
            agentTeamHome: options.agentTeamHome,
            codexConfig: build.value.codex.config,
          });
          if (pipelineComposition.state !== "ready") {
            const requiresManual = await writeDispatchRequiresManual(
              progress,
              "implementer_composition_blocked",
              {
                jobId: result.job.id,
                projectId: build.value.project.id,
                issueId: result.job.issueId,
                externalIssueId: issue.externalId,
                model,
                ...providerAssignmentFields,
                branch,
                worktreePath,
              },
            );
            if (!requiresManual.ok) {
              return outcome("failed", {
                ...dispatchedPayload,
                pipeline: "failed",
                pipelineReason: "job_progress_write_failed",
                errorCode: requiresManual.error.code,
              });
            }
            return outcome("failed", {
              ...dispatchedPayload,
              pipeline: "blocked",
              pipelineReason: pipelineComposition.reason,
              message: implementerCompositionBlockedMessages[pipelineComposition.reason],
            });
          }

          // C015x decision 1: the worktree must be pinned to a real, *authoritative* revision --
          // never the branch name itself (see implementer-request.ts's own comment on
          // `baseRevision`), and, since this ticket, never the local clone's own possibly-stale
          // checked-out `HEAD` either (the coordinator's own root-cause finding for the real BEHIND
          // incident this ticket fixes: `inspectRepository(...).headSha` reflects whatever the
          // *local* clone happened to be checked out to, which this project's own local clone never
          // re-syncs on its own -- not GitHub's actual current default-branch tip). Fresh
          // `LocalGitAdapter`/`GitHubAdapter` instances here (rather than reaching into
          // `pipelineComposition.value.ports.git`) are deliberate for the exact same reason the
          // prior version of this comment already gave for `LocalGitAdapter`:
          // `ImplementerPipelinePorts.git` is narrowed to
          // `Pick<GitPort,"createWorktree"|"stagePaths"|"commit"|"inspectWorkingTree"|"push">`
          // (missing both `inspectRepository` and the new `resolveAuthoritativeBranch`), and both
          // adapters are stateless CLI wrappers -- constructing fresh instances is cheap and does
          // not duplicate any state.
          const authoritativeBase = await (
            options.resolveAuthoritativeBase ?? resolveAuthoritativeBaseRevision
          )(
            build.value.project,
            { git: new LocalGitAdapter(), sourceControl: new GitHubAdapter() },
            { idempotencyKey: `cli-dispatch:${result.job.id}:authoritative-base` },
          );
          if (!authoritativeBase.ok) {
            const requiresManual = await writeDispatchRequiresManual(
              progress,
              "authoritative_base_unavailable",
              {
                jobId: result.job.id,
                projectId: build.value.project.id,
                issueId: result.job.issueId,
                externalIssueId: issue.externalId,
                model,
                ...providerAssignmentFields,
                branch,
                worktreePath,
              },
            );
            if (!requiresManual.ok) {
              return outcome("failed", {
                ...dispatchedPayload,
                pipeline: "failed",
                pipelineReason: "job_progress_write_failed",
                errorCode: requiresManual.error.code,
              });
            }
            return outcome("failed", {
              ...dispatchedPayload,
              pipeline: "failed",
              pipelineReason: "authoritative_base_unavailable",
              reason: authoritativeBase.error.reason,
              error: authoritativeBaseErrorDetail(authoritativeBase.error),
            });
          }

          // C015e: `LocalGitAdapter.createWorktree` requires its target's *parent* directory to
          // already exist -- nothing in this composition ever created
          // `${agentTeamHome}/state/dispatch/worktrees` (E101's second real run died here,
          // `stage:"worktree"`, on a genuinely fresh `${AGENT_TEAM_HOME}`). Never run in
          // `--dry-run` (this whole switch-case is unreachable there -- see the `if (dryRun)`
          // short-circuit above).
          const worktreeDirectory = await ensureDispatchWorktreesDirectory(options.agentTeamHome);
          if (!worktreeDirectory.ok) {
            const requiresManual = await writeDispatchRequiresManual(
              progress,
              "worktree_directory_unavailable",
              {
                jobId: result.job.id,
                projectId: build.value.project.id,
                issueId: result.job.issueId,
                externalIssueId: issue.externalId,
                model,
                ...providerAssignmentFields,
                branch,
                worktreePath,
              },
            );
            if (!requiresManual.ok) {
              return outcome("failed", {
                ...dispatchedPayload,
                pipeline: "failed",
                pipelineReason: "job_progress_write_failed",
                errorCode: requiresManual.error.code,
              });
            }
            return outcome("failed", {
              ...dispatchedPayload,
              pipeline: "failed",
              pipelineReason: "worktree_directory_unavailable",
              errorCode: worktreeDirectory.error.code,
            });
          }

          const request = buildImplementerPipelineRequest({
            job: result.job,
            issue,
            project: build.value.project,
            trustedConfig: build.value.trustedConfig,
            model,
            agentTeamHome: options.agentTeamHome,
            clock,
            baseRevision: authoritativeBase.value.baseRevision,
          });
          if (!request.ok) {
            // C018 fix: `implementer_request_invalid` -- this file's grep-verified sixth exit
            // (never separately enumerated by this ticket's own known-list, which named the
            // sibling check right above the `pipelineComposition` build instead; both describe the
            // identical human-facing situation -- "this job's `ImplementerPipelineRequest` could
            // never be built" -- and already shared this exact CLI-JSON `pipelineReason` string
            // before this fix, so reusing one reasonCode for both is not a new conflation).
            const requiresManual = await writeDispatchRequiresManual(
              progress,
              "implementer_request_invalid",
              {
                jobId: result.job.id,
                projectId: build.value.project.id,
                issueId: result.job.issueId,
                externalIssueId: issue.externalId,
                model,
                ...providerAssignmentFields,
                branch,
                worktreePath,
              },
            );
            if (!requiresManual.ok) {
              return outcome("failed", {
                ...dispatchedPayload,
                pipeline: "failed",
                pipelineReason: "job_progress_write_failed",
                errorCode: requiresManual.error.code,
              });
            }
            return outcome("failed", {
              ...dispatchedPayload,
              pipeline: "failed",
              pipelineReason: "implementer_request_invalid",
              errorCode: request.error.code,
            });
          }

          const bootstrapRecord = await progress.load(result.job.id);
          if (!bootstrapRecord.ok || bootstrapRecord.value?.workStatusLifecycle === undefined) {
            return outcome("failed", {
              ...dispatchedPayload,
              pipeline: "not_started",
              pipelineReason: "job_progress_read_failed",
              errorCode: bootstrapRecord.ok ? "not_found" : bootstrapRecord.error.code,
            });
          }
          const authorityDigest = sha256Digest({
            schemaVersion: 1,
            jobId: result.job.id,
            executionEpoch: 1,
          });
          const transitionInstance = authorityDigest.ok
            ? createWorkStatusLifecycleTransitionInstance({
                jobId: result.job.id,
                step: "work_start",
                mainTarget: "in_progress",
                allowedMainSources: ["ready", "in_progress"],
                agentTarget: { kind: "set", status: "executing" },
                authorityDigest: authorityDigest.value,
              })
            : authorityDigest;
          const invocationDigest = sha256Digest({
            schemaVersion: 1,
            operation: "dispatch-work-start",
            jobId: result.job.id,
            holderId,
          });
          if (!transitionInstance.ok || !invocationDigest.ok) {
            return outcome("failed", {
              ...dispatchedPayload,
              pipeline: "not_started",
              pipelineReason: "work_status_identity_invalid",
              errorCode: "invariant_violation",
            });
          }
          const lifecycleHistory = bindWorkStatusIssueHistory(lifecycleWorkManagement);
          const workStart = await new WorkStatusLifecycleCoordinator({
            workManagement: lifecycleWorkManagement,
            ...(lifecycleHistory !== undefined
              ? {
                  history: {
                    getIssueHistory: (...args) => lifecycleHistory(...args),
                  },
                }
              : {}),
            ledger: new JobProgressWorkStatusLifecycleLedger(progress),
            locks: new FileIssueScopeLock(
              join(options.agentTeamHome, "state", "dispatch", "issue-scope-locks"),
            ),
            clock,
          }).transition({
            jobId: result.job.id,
            reference: { project: build.value.project, externalIssueId: issue.externalId },
            holderId: `work-status:${holderId}`,
            mode: bootstrapRecord.value.workStatusLifecycle.admissionMode,
            ...(bootstrapRecord.value.workStatusLifecycle.capabilityDigest === undefined
              ? {}
              : {
                  capabilityDigest: bootstrapRecord.value.workStatusLifecycle.capabilityDigest,
                }),
            phase: "work_start",
            step: "work_start",
            transitionInstance: transitionInstance.value,
            invocationDigest: invocationDigest.value,
            mainTarget: "in_progress",
            allowedMainSources: ["ready"],
            agentTarget: { kind: "set", status: "executing" },
          });
          if (workStart.state !== "permitted") {
            return outcome("failed", {
              ...dispatchedPayload,
              pipeline: "not_started",
              pipelineReason: `work_status_${workStart.reason}`,
              ...(workStart.error === undefined ? {} : { errorCode: workStart.error.code }),
            });
          }
          const beforeProvider = await progress.load(result.job.id);
          if (!beforeProvider.ok || beforeProvider.value?.workStatusLifecycle === undefined) {
            return outcome("failed", {
              ...dispatchedPayload,
              pipeline: "not_started",
              pipelineReason: "job_progress_read_failed",
              errorCode: beforeProvider.ok ? "not_found" : beforeProvider.error.code,
            });
          }
          const implementing = await progress.compareAndSwap(
            result.job.id,
            beforeProvider.value.revision,
            {
              ...progressMutation(beforeProvider.value),
              stage: {
                kind: "implementing",
                executionEpoch: { ordinal: 1, providerOutput: "none", startedAt: clock.now() },
              },
              workStatusLifecycle: {
                ...beforeProvider.value.workStatusLifecycle,
                phase: "implementing",
              },
            },
          );
          if (!implementing.ok) {
            return outcome("failed", {
              ...dispatchedPayload,
              pipeline: "not_started",
              pipelineReason: "job_progress_write_failed",
              errorCode: implementing.error.code,
            });
          }

          const pipelineOutcome = await pipelineComposition.value.run(request.value);
          const afterProvider = await progress.load(result.job.id);
          if (!afterProvider.ok || afterProvider.value === undefined) {
            return outcome("failed", {
              ...dispatchedPayload,
              pipeline: "failed",
              pipelineReason: "job_progress_read_failed",
              errorCode: afterProvider.ok ? "not_found" : afterProvider.error.code,
            });
          }
          const providerOutputConfirmed = await progress.compareAndSwap(
            result.job.id,
            afterProvider.value.revision,
            {
              ...progressMutation(afterProvider.value),
              stage: {
                kind: "implementing",
                executionEpoch: {
                  ordinal: 1,
                  providerOutput: "confirmed",
                  ...(afterProvider.value.stage.kind === "implementing" &&
                  afterProvider.value.stage.executionEpoch?.startedAt !== undefined
                    ? { startedAt: afterProvider.value.stage.executionEpoch.startedAt }
                    : {}),
                },
              },
            },
          );
          if (!providerOutputConfirmed.ok) {
            return outcome("failed", {
              ...dispatchedPayload,
              pipeline: "failed",
              pipelineReason: "job_progress_write_failed",
              errorCode: providerOutputConfirmed.error.code,
            });
          }
          // C015c item 2's own backport (small, disclosed addition to C015b's scope): the instant
          // a real Draft PR exists, record it in the job-progress index -- this is the *only*
          // place a job's `changeRequestId`/`headSha` are ever first learned, and a later
          // `agent-team run` (item 2's resume path) has no other way to find this job again.
          // Written before returning, not best-effort afterward: a `ci_waiting` outcome with no
          // corresponding progress record would be silently unresumable forever.
          //
          // C016 fix: the exact same "written before returning" discipline now also applies to
          // `state:"paused"` right below -- this branch used to not exist at all, which is the
          // root cause this ticket closes. The per-issue admission claim
          // (issue-admission-store.ts) is claimed *before* this job was even created (C015o
          // decision 3) and is never released automatically for a non-terminal stage (that
          // store's own header, deliberately unchanged by this ticket). `dispatch resolve`
          // (resolve-handlers.ts) is the *only* CLI path that can ever release it, and it always
          // looks the job up by this exact progress record first -- so a `paused` outcome that
          // returned here without ever persisting one left that claim durably, permanently
          // unreleasable: no CLI command could find the job to resolve it, and
          // issue-admission-store.ts's own conservative "never auto-release a non-terminal stage"
          // policy correctly refuses to help either (this is the real incident that produced
          // this ticket, `issue_78bf4038`/LEA-16). See job-progress-store.ts's own comment on the
          // `paused` stage variant for the precise invariant this write establishes.
          if (pipelineOutcome.state === "ci_waiting") {
            const headSha = headShaSchema.safeParse(pipelineOutcome.commit.sha);
            if (!headSha.success) {
              // C018 fix: unlike the `recorded.ok` guard further down (a genuine store failure,
              // where attempting a second, differently-shaped write is not expected to fare any
              // better -- see this function's own header on `writeDispatchRequiresManual`), this
              // is a malformed *value*, not a broken store: the write itself is still worth
              // attempting, just with a `requires_manual` shape that never needs the malformed
              // `headSha` at all. `changeRequestId` is still real and worth keeping -- a human can
              // find the actual Draft PR by number even without the SHA this process failed to
              // trust.
              const requiresManual = await writeDispatchRequiresManual(
                progress,
                "invalid_head_sha",
                {
                  jobId: result.job.id,
                  projectId: build.value.project.id,
                  issueId: result.job.issueId,
                  externalIssueId: issue.externalId,
                  model,
                  ...providerAssignmentFields,
                  branch: request.value.branch,
                  worktreePath: request.value.worktreePath,
                  changeRequestId: String(pipelineOutcome.changeRequest.number),
                },
              );
              // C019 fix (item 2, codex-reviewed defect from C018's own acceptance sweep): this
              // used to report `pipelineReason:"job_progress_write_failed"` unconditionally, even
              // when `requiresManual.ok` -- honestly meaning "the record you're about to go look
              // for via `dispatch resolve` was never written," which is the exact opposite of what
              // happened here. Only a genuine write failure (this store call itself coming back
              // `!ok`) may ever use that reason; when the write succeeded, the honest reason is the
              // malformed value that triggered this fallback in the first place.
              if (!requiresManual.ok) {
                return outcome("failed", {
                  ...dispatchedPayload,
                  pipeline: "failed",
                  pipelineReason: "job_progress_write_failed",
                  errorCode: requiresManual.error.code,
                });
              }
              return outcome("failed", {
                ...dispatchedPayload,
                pipeline: "failed",
                pipelineReason: "invalid_head_sha",
                errorCode: "invariant_violation",
              });
            }
            // C015y decision A: the same authoritative SHA this dispatch just pinned the worktree
            // to (`authoritativeBase.value.baseRevision`) is persisted here as this job's
            // henceforth-immutable `baseRevision` -- see job-progress-store.ts's own header on
            // that field. `authoritativeBase.value.baseRevision` is already a real git SHA
            // (`resolveAuthoritativeBaseRevision`'s own contract), so this parse only guards
            // against a malformed injected test fake; it is never expected to fail in production.
            const dispatchBaseRevision = headShaSchema.safeParse(
              authoritativeBase.value.baseRevision,
            );
            if (!dispatchBaseRevision.success) {
              // C018 fix: symmetric to the `headSha` guard right above -- `headSha` itself already
              // parsed successfully here, so the fallback record keeps it (and `changeRequestId`),
              // only `baseRevision` is omitted (optional on the schema; a legacy-shaped record
              // establishing it for the first time is not the write-once invariant's concern --
              // see `#compareAndSwapLocked`'s own comment, job-progress-store.ts).
              const requiresManual = await writeDispatchRequiresManual(
                progress,
                "invalid_base_revision",
                {
                  jobId: result.job.id,
                  projectId: build.value.project.id,
                  issueId: result.job.issueId,
                  externalIssueId: issue.externalId,
                  model,
                  ...providerAssignmentFields,
                  branch: request.value.branch,
                  worktreePath: request.value.worktreePath,
                  changeRequestId: String(pipelineOutcome.changeRequest.number),
                  headSha: headSha.data,
                },
              );
              // C019 fix (item 2): symmetric to the `headSha` guard's own fix right above -- only a
              // genuine write failure may report `job_progress_write_failed`; a successful fallback
              // write reports the honest `invalid_base_revision` reason instead.
              if (!requiresManual.ok) {
                return outcome("failed", {
                  ...dispatchedPayload,
                  pipeline: "failed",
                  pipelineReason: "job_progress_write_failed",
                  errorCode: requiresManual.error.code,
                });
              }
              return outcome("failed", {
                ...dispatchedPayload,
                pipeline: "failed",
                pipelineReason: "invalid_base_revision",
                errorCode: "invariant_violation",
              });
            }
            const recorded = await persistDispatchProgress(progress, {
              jobId: result.job.id,
              projectId: build.value.project.id,
              issueId: result.job.issueId,
              externalIssueId: issue.externalId,
              model,
              ...providerAssignmentFields,
              stage: { kind: "ci_waiting" },
              branch: request.value.branch,
              worktreePath: request.value.worktreePath,
              changeRequestId: String(pipelineOutcome.changeRequest.number),
              headSha: headSha.data,
              baseRevision: dispatchBaseRevision.data,
            });
            if (!recorded.ok) {
              // C018 fix: a genuine store failure (disk full, permissions, ...), not a malformed
              // value -- unlike the `headSha`/`dispatchBaseRevision` guards above, attempting a
              // second, differently-shaped write against the exact same store here is not expected
              // to fare any better, so this fails closed with nothing written at all (see this
              // function's own `writeDispatchRequiresManual` header for the general rule).
              return outcome("failed", {
                ...dispatchedPayload,
                pipeline: "failed",
                pipelineReason: "job_progress_write_failed",
                errorCode: recorded.error.code,
              });
            }
          }
          // C016 fix: see this branch's sibling comment above (right before the `ci_waiting`
          // write) for the full incident this closes. `checkpointId` is genuinely optional on
          // `ImplementerPipelineOutcome`'s own `paused` variant (only `"scope_overrun"` ever
          // carries one) -- parsed here, not trusted verbatim, for the same reason the
          // `ci_waiting` branch above never trusts `pipelineOutcome.commit.sha` verbatim: a
          // malformed value from this process's own pipeline is an internal invariant violation,
          // not something a resume attempt should ever have to guard against later.
          if (pipelineOutcome.state === "paused") {
            let parsedCheckpointId: ReturnType<typeof checkpointIdSchema.parse> | undefined;
            if (pipelineOutcome.checkpointId !== undefined) {
              const checkpointId = checkpointIdSchema.safeParse(pipelineOutcome.checkpointId);
              if (!checkpointId.success) {
                // C018 fix: symmetric to the `ci_waiting` branch's own `headSha`/
                // `dispatchBaseRevision` guards above -- a malformed value, not a broken store, so
                // still worth a `requires_manual` fallback write (which never needs the malformed
                // `checkpointId` at all).
                const requiresManual = await writeDispatchRequiresManual(
                  progress,
                  "invalid_checkpoint_id",
                  {
                    jobId: result.job.id,
                    projectId: build.value.project.id,
                    issueId: result.job.issueId,
                    externalIssueId: issue.externalId,
                    model,
                    ...providerAssignmentFields,
                    branch: request.value.branch,
                    worktreePath: request.value.worktreePath,
                  },
                );
                // C019 fix (item 2): symmetric to the `ci_waiting` branch's own `headSha`/
                // `dispatchBaseRevision` fixes above -- only a genuine write failure may report
                // `job_progress_write_failed`; a successful fallback write reports the honest
                // `invalid_checkpoint_id` reason instead.
                if (!requiresManual.ok) {
                  return outcome("failed", {
                    ...dispatchedPayload,
                    pipeline: "failed",
                    pipelineReason: "job_progress_write_failed",
                    errorCode: requiresManual.error.code,
                  });
                }
                return outcome("failed", {
                  ...dispatchedPayload,
                  pipeline: "failed",
                  pipelineReason: "invalid_checkpoint_id",
                  errorCode: "invariant_violation",
                });
              }
              parsedCheckpointId = checkpointId.data;
            }
            const recorded = await persistDispatchProgress(progress, {
              jobId: result.job.id,
              projectId: build.value.project.id,
              issueId: result.job.issueId,
              externalIssueId: issue.externalId,
              model,
              ...providerAssignmentFields,
              stage: {
                kind: "paused",
                pauseReason: pipelineOutcome.reason,
                ...(parsedCheckpointId === undefined ? {} : { checkpointId: parsedCheckpointId }),
              },
              branch: request.value.branch,
              worktreePath: request.value.worktreePath,
            });
            if (!recorded.ok) {
              // C018 fix: same "genuine store failure, do not attempt a second write" rule as the
              // `ci_waiting` branch's own `recorded.ok` guard above.
              return outcome("failed", {
                ...dispatchedPayload,
                pipeline: "failed",
                pipelineReason: "job_progress_write_failed",
                errorCode: recorded.error.code,
              });
            }
          }
          // C018 fix: the fifth exit this ticket's own packet named explicitly -- a genuine
          // `ImplementerPipelineOutcome` of `state:"failed"` (the pipeline was actually invoked,
          // unlike every `requires_manual` write above this comment, all of which fire *before*
          // `pipelineComposition.value.run()` is ever called) used to `return` here with no
          // job-progress record at all. Written *before* returning, same discipline as every other
          // write in this function -- the full diagnostic (`stage`/`error`) is already carried in
          // this same response's own `pipelineOutcomePayload(pipelineOutcome)` below for whoever is
          // watching this one invocation; the durable record's job is only to make the still-active
          // admission claim findable and resolvable by a *later* `dispatch resolve` invocation.
          if (pipelineOutcome.state === "failed") {
            const requiresManual = await writeDispatchRequiresManual(
              progress,
              "implementer_pipeline_failed",
              {
                jobId: result.job.id,
                projectId: build.value.project.id,
                issueId: result.job.issueId,
                externalIssueId: issue.externalId,
                model,
                ...providerAssignmentFields,
                branch: request.value.branch,
                worktreePath: request.value.worktreePath,
              },
            );
            if (!requiresManual.ok) {
              return outcome("failed", {
                ...dispatchedPayload,
                pipeline: "failed",
                pipelineReason: "job_progress_write_failed",
                errorCode: requiresManual.error.code,
              });
            }
          }
          return outcome(pipelineOutcome.state === "failed" ? "failed" : "success", {
            ...dispatchedPayload,
            ...pipelineOutcomePayload(pipelineOutcome),
          });
        }
        case "waiting":
          return outcome("success", {
            operation: "dispatch_run",
            state: "waiting",
            projectId: input.projectId,
            reason: result.reason,
            skipped: result.skipped,
            discoverySkipped,
            admissionSkipped,
            protectedRegionSyncFailures,
            bootstrapReconciliation,
          });
        case "blocked":
          return outcome("failed", {
            operation: "dispatch_run",
            state: "blocked",
            projectId: input.projectId,
            reason: result.reason,
            skipped: result.skipped,
            discoverySkipped,
            admissionSkipped,
            protectedRegionSyncFailures,
            bootstrapReconciliation,
          });
      }
    },
  });
}
