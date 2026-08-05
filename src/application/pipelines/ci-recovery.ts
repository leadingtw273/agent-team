import { domainError, parseInstant, type DomainError } from "../../domain/foundation/index.js";
import { attemptLimits, consumeAttempt, jobSchema, type Job } from "../../domain/jobs/index.js";
import { projectSchema } from "../../domain/project/index.js";
import { requirementSnapshotSchema } from "../../domain/review/index.js";
import { trustedProjectConfigSchema } from "../projects/index.js";
import type { CommitChecksSnapshot, MutationOptions, ProviderRunHandle } from "../ports/index.js";
import type {
  CiRecoveryFailureStage,
  CiRecoveryPipelineOutcome,
  CiRecoveryPipelinePorts,
  CiRecoveryPipelineRequest,
} from "./ci-recovery-model.js";

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
    job.attempts.reviewerFixRounds >= attemptLimits.reviewerFixRounds ||
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
        externalData: request.externalData,
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
