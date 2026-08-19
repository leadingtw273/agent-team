import {
  domainError,
  parseInstant,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { attemptLimits, consumeAttempt, jobSchema, type Job } from "../../domain/jobs/index.js";
import { projectSchema } from "../../domain/project/index.js";
import { requirementSnapshotSchema } from "../../domain/review/index.js";
import { trustedProjectConfigSchema } from "../projects/index.js";
import type {
  CommitChecksSnapshot,
  ExternalDataBlock,
  MutationOptions,
  ProviderRunHandle,
} from "../ports/index.js";
import type {
  CiFailureLogOutcome,
  CiRecoveryFailureStage,
  CiRecoveryObservabilityPort,
  CiRecoveryPipelineOutcome,
  CiRecoveryPipelinePorts,
  CiRecoveryPipelineRequest,
} from "./ci-recovery-model.js";

/**
 * C017: the source string of the single external-data block this pipeline attaches to the repair
 * prompt -- see `ciFailureLogExternalData` below. Distinct from any block already present in
 * `request.externalData` (currently always empty at every call site, but kept generic in case
 * that changes), so it never collides with something else during redaction/logging.
 */
const ciFailureLogSource = "ci_check_logs";

/**
 * C017: turns whatever `ports.ciLog.getFailedCheckLogExcerpts` reported (success, "no log for
 * this provider", or a hard port failure) into exactly one `ExternalDataBlock`, always -- the
 * repair prompt always gets a clear signal either way, never silence. This block flows into
 * `ports.provider.start`'s `externalData`, which every real `ProviderPort` implementation
 * (`buildProviderJobContext`, provider-job/context.ts) already wraps in the
 * `=== BEGIN/END EXTERNAL DATA ===` boundary and passes through the configured `Redactor` before
 * it ever reaches a model -- this function only builds the untrusted *content*, it does not
 * itself apply the boundary or redaction.
 *
 * Exported so a dedicated test can assert, end to end, that the resulting block really does come
 * out boundary-wrapped and redacted once handed to the real `buildProviderJobContext`.
 */
export function ciFailureLogExternalData(outcome: CiFailureLogOutcome): ExternalDataBlock {
  const content = outcome.available
    ? outcome.excerpts
        .map(
          (excerpt) =>
            `Check: ${excerpt.checkName}${excerpt.truncated ? " (truncated)" : ""}\n${excerpt.text}`,
        )
        .join("\n---\n")
    : `CI failure log is unavailable (reason: ${outcome.reason}). Diagnose using only the check name/status/conclusion/URL already provided above -- do not guess at log contents.`;
  return Object.freeze({
    kind: "text" as const,
    source: ciFailureLogSource,
    mediaType: "text/plain",
    content,
  });
}

/**
 * C017b (D2): derives the closed-shape, content-free observability record from whatever
 * `ports.ciLog.getFailedCheckLogExcerpts` reported -- mirrors `ciFailureLogExternalData`'s own
 * three-way handling (`available: true`, `available: false`, hard port `err`) immediately above,
 * but only ever produces booleans/short reason strings/byte counts, never `excerpt.text` itself.
 */
export function recordCiLogExcerptObservability(
  jobId: string,
  failureLog: Result<CiFailureLogOutcome, DomainError>,
): Parameters<CiRecoveryObservabilityPort["recordCiLogExcerpt"]>[0] {
  if (!failureLog.ok) {
    return { jobId, available: false, reason: `ci_log_port_error:${failureLog.error.code}` };
  }
  if (!failureLog.value.available) {
    return { jobId, available: false, reason: failureLog.value.reason };
  }
  return {
    jobId,
    available: true,
    sourceBytes: failureLog.value.excerpts.reduce((sum, excerpt) => sum + excerpt.sourceBytes, 0),
    excerptBytes: failureLog.value.excerpts.reduce(
      (sum, excerpt) => sum + Buffer.byteLength(excerpt.text, "utf8"),
      0,
    ),
  };
}

const idempotencyPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]{0,254}$/u;
const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;

function mutation(request: CiRecoveryPipelineRequest, step: string): MutationOptions {
  return {
    idempotencyKey: `${request.idempotencyKeyPrefix}:${step}`,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  };
}

function failed(
  stage: CiRecoveryFailureStage,
  error: DomainError,
  job: Job,
): CiRecoveryPipelineOutcome {
  return Object.freeze({ state: "failed", stage, error, job });
}

function sameSha(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function validChecksSnapshot(snapshot: CommitChecksSnapshot): boolean {
  return (
    shaPattern.test(snapshot.headSha) &&
    ["pending", "success", "failure"].includes(snapshot.aggregate) &&
    snapshot.checks.every(
      (check) =>
        check.name.trim().length > 0 &&
        ["queued", "in_progress", "completed"].includes(check.status) &&
        (check.conclusion === null ||
          ["success", "failure", "cancelled", "skipped"].includes(check.conclusion)) &&
        (check.status === "completed" || check.conclusion === null),
    )
  );
}

function validRequest(request: CiRecoveryPipelineRequest): boolean {
  const job = jobSchema.safeParse(request.job);
  const project = projectSchema.safeParse(request.project);
  const config = trustedProjectConfigSchema.safeParse(request.trustedConfig);
  const snapshot = requirementSnapshotSchema.safeParse(request.requirementSnapshot);
  return (
    job.success &&
    project.success &&
    config.success &&
    snapshot.success &&
    job.data.projectId === project.data.id &&
    job.data.issueId === snapshot.data.issue.id &&
    snapshot.data.issue.projectId === project.data.id &&
    config.data.projectId === project.data.id &&
    request.worktree.repositoryRoot === project.data.localRepositoryPath &&
    request.changeRequest.state === "open" &&
    request.changeRequest.draft &&
    request.changeRequest.baseBranch === project.data.defaultBranch &&
    request.changeRequest.headBranch === request.worktree.branch &&
    shaPattern.test(request.changeRequest.headSha) &&
    sameSha(request.changeRequest.headSha, request.worktree.headSha) &&
    config.data.defaultBranch === project.data.defaultBranch &&
    config.data.platforms.workManagement.provider === project.data.workManagement.provider &&
    config.data.platforms.workManagement.containerId === project.data.workManagement.containerId &&
    config.data.platforms.workManagement.projectId === project.data.workManagement.projectId &&
    config.data.platforms.sourceControl.provider === project.data.sourceControl.provider &&
    config.data.platforms.sourceControl.repository === project.data.sourceControl.repository
  );
}

function requestShapeValid(request: CiRecoveryPipelineRequest): boolean {
  return (
    idempotencyPattern.test(request.idempotencyKeyPrefix) &&
    request.idempotencyKeyPrefix.length <= 220 &&
    request.model.trim().length > 0 &&
    request.remote.trim().length > 0 &&
    request.commitMessage.trim().length > 0 &&
    request.controllerDirective.trim().length > 0 &&
    parseInstant(request.deadlineAt).ok &&
    request.requirementSnapshot.issue.changeRegions !== undefined &&
    request.requirementSnapshot.issue.changeRegions.length > 0 &&
    (request.trigger.kind !== "webhook" || validChecksSnapshot(request.trigger.observedChecks))
  );
}

function anyAttemptLimitReached(job: Job): boolean {
  return (
    job.attempts.ciFixRounds >= attemptLimits.ciFixRounds ||
    job.attempts.reviewRuns >= attemptLimits.reviewRuns
  );
}

function touchedPaths(
  change: Readonly<{ path: string; previousPath?: string }>,
): readonly string[] {
  return change.previousPath === undefined ? [change.path] : [change.previousPath, change.path];
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((path, index) => path === b[index]);
}

interface ToolRunResult {
  readonly error?: DomainError;
  readonly pauseSummary?: string;
}

export class CiRecoveryPipeline {
  constructor(readonly ports: CiRecoveryPipelinePorts) {}

  async run(request: CiRecoveryPipelineRequest): Promise<CiRecoveryPipelineOutcome> {
    if (!validRequest(request) || !requestShapeValid(request)) {
      return failed("request", domainError("invariant_violation"), request.job);
    }
    const declaredRegions = request.requirementSnapshot.issue.changeRegions;
    if (declaredRegions === undefined) {
      return failed("request", domainError("invariant_violation"), request.job);
    }

    const authoritative = await this.ports.sourceControl.getCommitChecks(
      { project: request.project },
      request.changeRequest.headSha,
      request.signal === undefined ? {} : { signal: request.signal },
    );
    if (!authoritative.ok) return failed("checks", authoritative.error, request.job);
    if (!sameSha(authoritative.value.headSha, request.changeRequest.headSha)) {
      return failed("checks", domainError("conflict"), request.job);
    }
    const source = request.trigger.kind;
    if (authoritative.value.aggregate === "pending") {
      return Object.freeze({
        state: "ci_waiting",
        source,
        job: request.job,
        checks: authoritative.value,
      });
    }
    if (authoritative.value.aggregate === "success") {
      return Object.freeze({
        state: "ready_for_review",
        source,
        job: request.job,
        checks: authoritative.value,
      });
    }

    if (anyAttemptLimitReached(request.job)) {
      return this.#checkpoint(request, request.job, authoritative.value, "attempt_limit_reached");
    }
    const consumed = consumeAttempt(request.job.attempts, "ciFixRounds");
    if (!consumed.ok) {
      return this.#checkpoint(request, request.job, authoritative.value, "attempt_limit_reached");
    }
    const repairedJob = jobSchema.safeParse({ ...request.job, attempts: consumed.value });
    if (!repairedJob.success) {
      return failed("request", domainError("invariant_violation"), request.job);
    }

    // C017: fetch a bounded CI failure log excerpt for the repair prompt -- the whole point of
    // this ticket. `ciLog.getFailedCheckLogExcerpts` is contractually a *read* (see its own
    // header, ci-recovery-model.ts): it never returns a hard `err` for anything survivable
    // (missing capability, no Actions-backed failing check, log endpoint failure). The `!ok`
    // branch below is defense in depth for a nonconforming port, not the expected path -- either
    // way, a log-fetch problem must never turn into a `failed()` result; it only ever degrades
    // the one external-data block below to its "unavailable" content.
    const failureLog = await this.ports.ciLog.getFailedCheckLogExcerpts(
      { project: request.project },
      authoritative.value.headSha,
      request.signal === undefined ? {} : { signal: request.signal },
    );
    // C017b (D2): best-effort, non-blocking diagnostic -- see `CiRecoveryObservabilityPort`'s own
    // header (ci-recovery-model.ts) for why this is fire-and-forget and content-free. A throwing
    // `observability` implementation must never turn a diagnostic into a repair-blocking failure,
    // hence the `try`/`catch` around a call whose own port contract is already synchronous `void`.
    try {
      this.ports.observability?.recordCiLogExcerpt(
        recordCiLogExcerptObservability(request.job.id, failureLog),
      );
    } catch {
      // Diagnostics-only; deliberately swallowed. See comment above.
    }
    const externalData = Object.freeze([
      ...request.externalData,
      ciFailureLogExternalData(
        failureLog.ok
          ? failureLog.value
          : { available: false, reason: `ci_log_port_error:${failureLog.error.code}` },
      ),
    ]);

    const started = await this.ports.provider.start(
      {
        job: request.job,
        role: "implementer",
        model: request.model,
        workingDirectory: request.worktree.path,
        requirementSnapshot: request.requirementSnapshot,
        controllerDirective: request.controllerDirective,
        projectRules: Object.freeze([
          ...request.trustedConfig.projectRules,
          ...(request.trustedConfig.roleInstructions.implementer ?? []),
        ]),
        externalData,
        deadlineAt: request.deadlineAt,
      },
      request.signal === undefined ? {} : { signal: request.signal },
    );
    if (!started.ok) return failed("provider_start", started.error, request.job);

    const tools = this.#consumeTools(started.value, request, request.job);
    const completion = await started.value.completion(
      request.signal === undefined ? {} : { signal: request.signal },
    );
    const toolResult = await tools;
    if (toolResult.error !== undefined) {
      return failed("tool_decision", toolResult.error, request.job);
    }
    if (toolResult.pauseSummary !== undefined) {
      return Object.freeze({
        state: "paused",
        reason: "safety_approval_required",
        job: request.job,
        toolSummary: toolResult.pauseSummary,
      });
    }
    if (!completion.ok) return failed("provider_run", completion.error, request.job);
    if (completion.value.outcome === "interrupted") {
      return Object.freeze({
        state: "paused",
        reason: "provider_interrupted",
        job: request.job,
      });
    }
    if (completion.value.outcome !== "completed") {
      return failed("provider_run", completion.value.error, request.job);
    }

    const preflight = await this.ports.preflight.inspect(
      {
        worktree: request.worktree,
        declaredRegions,
        ...(request.expectedUntrackedPaths === undefined
          ? {}
          : { expectedUntrackedPaths: request.expectedUntrackedPaths }),
        ...(request.concurrentJobs === undefined ? {} : { concurrentJobs: request.concurrentJobs }),
        ...(request.knownSecrets === undefined ? {} : { knownSecrets: request.knownSecrets }),
      },
      request.signal === undefined ? {} : { signal: request.signal },
    );
    if (!preflight.ok) return failed("preflight", preflight.error, request.job);
    if (preflight.value.changedPaths.length === 0) {
      return Object.freeze({ state: "paused", reason: "no_changes", job: request.job });
    }
    if (
      !preflight.value.allowed ||
      !preflight.value.scopeVerified ||
      !sameSha(preflight.value.headSha, request.changeRequest.headSha)
    ) {
      return this.#checkpoint(
        request,
        request.job,
        authoritative.value,
        "scope_overrun",
        preflight.value.findings,
        preflight.value.changedPaths,
      );
    }

    const staged = await this.ports.git.stagePaths(
      request.worktree,
      preflight.value.changedPaths,
      mutation(request, `ci-stage-${String(repairedJob.data.attempts.ciFixRounds)}`),
    );
    if (!staged.ok) return failed("stage", staged.error, request.job);
    const stagedPaths = staged.value.changes
      .filter((change) => change.staged)
      .flatMap(touchedPaths);
    if (
      !sameSha(staged.value.headSha, preflight.value.headSha) ||
      !samePaths(stagedPaths, preflight.value.changedPaths)
    ) {
      return failed("stage", domainError("conflict"), request.job);
    }
    const committed = await this.ports.git.commit(
      {
        worktree: request.worktree,
        message: request.commitMessage,
        expectedStagedPaths: preflight.value.changedPaths,
      },
      mutation(request, `ci-commit-${String(repairedJob.data.attempts.ciFixRounds)}`),
    );
    if (!committed.ok) return failed("commit", committed.error, request.job);
    const clean = await this.ports.git.inspectWorkingTree(request.worktree);
    if (
      !clean.ok ||
      !sameSha(clean.value.headSha, committed.value.sha) ||
      clean.value.changes.length !== 0 ||
      committed.value.branch !== request.worktree.branch
    ) {
      return failed("post_commit", clean.ok ? domainError("conflict") : clean.error, request.job);
    }
    const pushed = await this.ports.git.push(
      request.worktree,
      request.remote,
      mutation(request, `ci-push-${String(repairedJob.data.attempts.ciFixRounds)}`),
    );
    if (!pushed.ok) return failed("push", pushed.error, request.job);
    if (
      !sameSha(pushed.value.sha, committed.value.sha) ||
      pushed.value.branch !== committed.value.branch
    ) {
      return failed("push", domainError("conflict"), request.job);
    }
    const persisted = await this.ports.jobs.update(
      repairedJob.data,
      mutation(request, `ci-attempt-${String(repairedJob.data.attempts.ciFixRounds)}`),
    );
    if (!persisted.ok) {
      return failed("attempt_persistence", persisted.error, request.job);
    }
    if (persisted.value.durability !== "confirmed") {
      return failed("attempt_persistence", domainError("external_failure"), request.job);
    }
    const newChecks = await this.ports.sourceControl.getCommitChecks(
      { project: request.project },
      pushed.value.sha,
      request.signal === undefined ? {} : { signal: request.signal },
    );
    if (!newChecks.ok) return failed("new_checks", newChecks.error, repairedJob.data);
    if (!sameSha(newChecks.value.headSha, pushed.value.sha)) {
      return failed("new_checks", domainError("conflict"), repairedJob.data);
    }
    return Object.freeze({
      state: "repair_pushed",
      job: repairedJob.data,
      commit: committed.value,
      push: pushed.value,
      checks: newChecks.value,
      ...(completion.value.sessionId === undefined
        ? {}
        : { providerSessionId: completion.value.sessionId }),
    });
  }

  async #checkpoint(
    request: CiRecoveryPipelineRequest,
    job: Job,
    checks: Parameters<CiRecoveryPipelinePorts["checkpoint"]["preserve"]>[0]["checks"],
    reason: Parameters<CiRecoveryPipelinePorts["checkpoint"]["preserve"]>[0]["reason"],
    findings?: Parameters<CiRecoveryPipelinePorts["checkpoint"]["preserve"]>[0]["findings"],
    changedPaths?: readonly string[],
  ): Promise<CiRecoveryPipelineOutcome> {
    const checkpoint = await this.ports.checkpoint.preserve(
      {
        job,
        worktree: request.worktree,
        requirementSnapshot: request.requirementSnapshot,
        reason,
        checks,
        ...(findings === undefined ? {} : { findings }),
        ...(changedPaths === undefined ? {} : { changedPaths }),
      },
      mutation(request, `checkpoint-${reason}`),
    );
    if (!checkpoint.ok) return failed("checkpoint", checkpoint.error, job);
    if (checkpoint.value.checkpointId.trim().length === 0) {
      return failed("checkpoint", domainError("invariant_violation"), job);
    }
    return Object.freeze({
      state: "checkpointed",
      reason,
      job,
      checkpointId: checkpoint.value.checkpointId,
      checks,
      ...(findings === undefined ? {} : { findings }),
    });
  }

  async #consumeTools(
    handle: ProviderRunHandle,
    request: CiRecoveryPipelineRequest,
    job: Job,
  ): Promise<ToolRunResult> {
    for await (const event of handle.events) {
      if (event.kind !== "tool_request") continue;
      const decision = await this.ports.toolDecisions.decide(
        event,
        { job, project: request.project },
        request.signal === undefined ? {} : { signal: request.signal },
      );
      if (!decision.ok) {
        await handle.respondToToolRequest(event.requestId, "decline");
        await handle.interrupt();
        return Object.freeze({ error: decision.error });
      }
      const responded = await handle.respondToToolRequest(event.requestId, decision.value.response);
      if (!responded.ok) {
        await handle.interrupt();
        return Object.freeze({ error: responded.error });
      }
      if (decision.value.pause) {
        await handle.interrupt();
        return Object.freeze({ pauseSummary: decision.value.summary });
      }
    }
    return Object.freeze({});
  }
}
