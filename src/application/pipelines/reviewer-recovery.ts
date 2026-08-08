import { domainError, parseInstant, type DomainError } from "../../domain/foundation/index.js";
import { attemptLimits, consumeAttempt, jobSchema, type Job } from "../../domain/jobs/index.js";
import { projectSchema } from "../../domain/project/index.js";
import { requirementSnapshotSchema } from "../../domain/review/index.js";
import { trustedProjectConfigSchema } from "../projects/index.js";
import type { ExternalDataBlock, MutationOptions, ProviderRunHandle } from "../ports/index.js";
import type { ReviewFinding } from "./reviewer-model.js";
import type {
  ReviewerRecoveryFailureStage,
  ReviewerRecoveryPipelineOutcome,
  ReviewerRecoveryPipelinePorts,
  ReviewerRecoveryPipelineRequest,
} from "./reviewer-recovery-model.js";

const reviewerFindingsSource = "reviewer_findings";
const idempotencyPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]{0,254}$/u;
const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;

/** 將 reviewer 回報視為不受信任的外部資料；prompt builder 會統一標界並遮蔽機密。 */
export function reviewFindingsExternalData(findings: readonly ReviewFinding[]): ExternalDataBlock {
  return Object.freeze({
    kind: "text",
    source: reviewerFindingsSource,
    mediaType: "text/plain",
    content: findings
      .map((finding) =>
        [
          `Finding: ${finding.title} (${finding.severity})`,
          finding.description,
          `Acceptance criteria: ${finding.acceptanceCriteria.join("; ") || "(none)"}`,
          `Evidence: ${finding.evidenceSources.join("; ") || "(none)"}`,
          `Path: ${finding.path ?? "(not specified)"}`,
        ].join("\n"),
      )
      .join("\n---\n"),
  });
}

function mutation(request: ReviewerRecoveryPipelineRequest, step: string): MutationOptions {
  return {
    idempotencyKey: `${request.idempotencyKeyPrefix}:${step}`,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  };
}

function failed(
  stage: ReviewerRecoveryFailureStage,
  error: DomainError,
  job: Job,
): ReviewerRecoveryPipelineOutcome {
  return Object.freeze({ state: "failed", stage, error, job });
}

function sameSha(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function validRequest(request: ReviewerRecoveryPipelineRequest): boolean {
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
    shaPattern.test(request.worktree.headSha) &&
    config.data.defaultBranch === project.data.defaultBranch &&
    config.data.platforms.workManagement.provider === project.data.workManagement.provider &&
    config.data.platforms.workManagement.containerId === project.data.workManagement.containerId &&
    config.data.platforms.workManagement.projectId === project.data.workManagement.projectId &&
    config.data.platforms.sourceControl.provider === project.data.sourceControl.provider &&
    config.data.platforms.sourceControl.repository === project.data.sourceControl.repository
  );
}

function requestShapeValid(request: ReviewerRecoveryPipelineRequest): boolean {
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
    request.findings.length > 0 &&
    request.findings.every((finding) => finding.severity === "blocking")
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

export class ReviewerRecoveryPipeline {
  constructor(readonly ports: ReviewerRecoveryPipelinePorts) {}

  async run(request: ReviewerRecoveryPipelineRequest): Promise<ReviewerRecoveryPipelineOutcome> {
    if (!validRequest(request) || !requestShapeValid(request)) {
      return failed("request", domainError("invariant_violation"), request.job);
    }
    const declaredRegions = request.requirementSnapshot.issue.changeRegions;
    if (declaredRegions === undefined)
      return failed("request", domainError("invariant_violation"), request.job);

    if (
      request.job.attempts.reviewerFixRounds >= attemptLimits.reviewerFixRounds ||
      request.job.attempts.reviewRuns >= attemptLimits.reviewRuns
    ) {
      return this.#checkpoint(request, request.job, "attempt_limit_reached");
    }
    const consumed = consumeAttempt(request.job.attempts, "reviewerFixRounds");
    if (!consumed.ok) return this.#checkpoint(request, request.job, "attempt_limit_reached");
    const repairedJob = jobSchema.safeParse({ ...request.job, attempts: consumed.value });
    if (!repairedJob.success)
      return failed("request", domainError("invariant_violation"), request.job);

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
        externalData: Object.freeze([
          ...request.externalData,
          reviewFindingsExternalData(request.findings),
        ]),
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
    if (toolResult.error !== undefined)
      return failed("tool_decision", toolResult.error, request.job);
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
      return Object.freeze({ state: "paused", reason: "provider_interrupted", job: request.job });
    }
    if (completion.value.outcome !== "completed")
      return failed("provider_run", completion.value.error, request.job);

    const preflight = await this.ports.preflight.inspect(
      { worktree: request.worktree, declaredRegions },
      request.signal === undefined ? {} : { signal: request.signal },
    );
    if (!preflight.ok) return failed("preflight", preflight.error, request.job);
    if (preflight.value.changedPaths.length === 0) {
      return Object.freeze({ state: "paused", reason: "no_changes", job: request.job });
    }
    if (
      !preflight.value.allowed ||
      !preflight.value.scopeVerified ||
      !sameSha(preflight.value.headSha, request.worktree.headSha)
    ) {
      return this.#checkpoint(
        request,
        request.job,
        "scope_overrun",
        preflight.value.findings,
        preflight.value.changedPaths,
      );
    }

    const round = repairedJob.data.attempts.reviewerFixRounds;
    const staged = await this.ports.git.stagePaths(
      request.worktree,
      preflight.value.changedPaths,
      mutation(request, `reviewer-stage-${String(round)}`),
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
      mutation(request, `reviewer-commit-${String(round)}`),
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
      mutation(request, `reviewer-push-${String(round)}`),
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
      mutation(request, `reviewer-attempt-${String(round)}`),
    );
    if (!persisted.ok) return failed("attempt_persistence", persisted.error, request.job);
    if (persisted.value.durability !== "confirmed") {
      return failed("attempt_persistence", domainError("external_failure"), request.job);
    }
    return Object.freeze({
      state: "repair_pushed",
      job: repairedJob.data,
      commit: committed.value,
      push: pushed.value,
      ...(completion.value.sessionId === undefined
        ? {}
        : { providerSessionId: completion.value.sessionId }),
    });
  }

  async #checkpoint(
    request: ReviewerRecoveryPipelineRequest,
    job: Job,
    reason: Parameters<ReviewerRecoveryPipelinePorts["checkpoint"]["preserve"]>[0]["reason"],
    findings?: Parameters<ReviewerRecoveryPipelinePorts["checkpoint"]["preserve"]>[0]["findings"],
    changedPaths?: readonly string[],
  ): Promise<ReviewerRecoveryPipelineOutcome> {
    const checkpoint = await this.ports.checkpoint.preserve(
      {
        job,
        worktree: request.worktree,
        requirementSnapshot: request.requirementSnapshot,
        reason,
        ...(findings === undefined ? {} : { findings }),
        ...(changedPaths === undefined ? {} : { changedPaths }),
      },
      mutation(request, `checkpoint-${reason}`),
    );
    if (!checkpoint.ok) return failed("checkpoint", checkpoint.error, job);
    if (checkpoint.value.checkpointId.trim().length === 0)
      return failed("checkpoint", domainError("invariant_violation"), job);
    return Object.freeze({
      state: "checkpointed",
      reason,
      job,
      checkpointId: checkpoint.value.checkpointId,
      ...(findings === undefined ? {} : { findings }),
    });
  }

  async #consumeTools(
    handle: ProviderRunHandle,
    request: ReviewerRecoveryPipelineRequest,
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
