import { isAbsolute } from "node:path";

import { domainError, parseInstant, type DomainError } from "../../domain/foundation/index.js";
import { jobSchema } from "../../domain/jobs/index.js";
import { projectSchema } from "../../domain/project/index.js";
import { requirementSnapshotSchema } from "../../domain/review/index.js";
import { trustedProjectConfigSchema } from "../projects/index.js";
import type {
  GitWorktree,
  MutationOptions,
  ProviderRunHandle,
  SkillKnowledgeAttachment,
} from "../ports/index.js";
import type {
  ImplementerFailureStage,
  ImplementerPipelineOutcome,
  ImplementerPipelinePorts,
  ImplementerPipelineRequest,
} from "./implementer-model.js";

const idempotencyPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]{0,254}$/u;

function mutation(request: ImplementerPipelineRequest, step: string): MutationOptions {
  return {
    idempotencyKey: `${request.idempotencyKeyPrefix}:${step}`,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  };
}

function failed(
  stage: ImplementerFailureStage,
  error: DomainError,
  worktree?: GitWorktree,
): ImplementerPipelineOutcome {
  return Object.freeze({
    state: "failed",
    stage,
    error,
    ...(worktree === undefined ? {} : { worktree }),
  });
}

function validRequest(request: ImplementerPipelineRequest): boolean {
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
    request.repositoryRoot === project.data.localRepositoryPath &&
    config.data.defaultBranch === project.data.defaultBranch &&
    config.data.platforms.workManagement.provider === project.data.workManagement.provider &&
    config.data.platforms.workManagement.containerId === project.data.workManagement.containerId &&
    config.data.platforms.workManagement.projectId === project.data.workManagement.projectId &&
    config.data.platforms.sourceControl.provider === project.data.sourceControl.provider &&
    config.data.platforms.sourceControl.repository === project.data.sourceControl.repository &&
    (config.data.skillPolicy === undefined) === (request.skillSnapshot === undefined)
  );
}

function requestShapeValid(request: ImplementerPipelineRequest): boolean {
  return (
    idempotencyPattern.test(request.idempotencyKeyPrefix) &&
    request.idempotencyKeyPrefix.length <= 220 &&
    request.baseRevision.trim().length > 0 &&
    isAbsolute(request.worktreePath) &&
    request.branch.trim().length > 0 &&
    request.remote.trim().length > 0 &&
    request.commitMessage.trim().length > 0 &&
    request.pullRequest.title.trim().length > 0 &&
    request.pullRequest.body.trim().length > 0 &&
    request.controllerDirective.trim().length > 0 &&
    request.model.trim().length > 0 &&
    parseInstant(request.deadlineAt).ok &&
    request.requirementSnapshot.issue.changeRegions !== undefined &&
    request.requirementSnapshot.issue.changeRegions.length > 0
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

export class ImplementerPipeline {
  constructor(readonly ports: ImplementerPipelinePorts) {}

  async run(request: ImplementerPipelineRequest): Promise<ImplementerPipelineOutcome> {
    if (!validRequest(request) || !requestShapeValid(request)) {
      return failed("request", domainError("invariant_violation"));
    }
    const declaredRegions = request.requirementSnapshot.issue.changeRegions;
    if (declaredRegions === undefined) {
      return failed("request", domainError("invariant_violation"));
    }
    let knowledgeAttachments: readonly SkillKnowledgeAttachment[] = Object.freeze([]);
    if (request.skillSnapshot !== undefined) {
      if (
        this.ports.skillRuntime === undefined ||
        request.skillSnapshot.jobId !== request.job.id ||
        request.skillSnapshot.projectId !== request.project.id
      ) {
        return failed("request", domainError("invariant_violation"));
      }
      const materialized = await this.ports.skillRuntime.materialize(request.skillSnapshot);
      if (!materialized.ok) return failed("request", materialized.error.error);
      knowledgeAttachments = materialized.value;
    }
    const created = await this.ports.git.createWorktree(
      {
        rootPath: request.repositoryRoot,
        path: request.worktreePath,
        branch: request.branch,
        startPoint: request.baseRevision,
      },
      mutation(request, "worktree"),
    );
    if (!created.ok) return failed("worktree", created.error);
    const worktree = created.value;
    if (
      worktree.repositoryRoot !== request.repositoryRoot ||
      worktree.path !== request.worktreePath ||
      worktree.branch !== request.branch
    ) {
      return failed("worktree", domainError("conflict"), worktree);
    }

    const started = await this.ports.provider.start(
      {
        job: request.job,
        role: request.role,
        model: request.model,
        workingDirectory: worktree.path,
        requirementSnapshot: request.requirementSnapshot,
        controllerDirective: request.controllerDirective,
        projectRules: Object.freeze([
          ...request.trustedConfig.projectRules,
          ...(request.trustedConfig.roleInstructions.implementer ?? []),
        ]),
        knowledgeAttachments,
        externalData: request.externalData,
        deadlineAt: request.deadlineAt,
      },
      request.signal === undefined ? {} : { signal: request.signal },
    );
    if (!started.ok) return failed("provider_start", started.error, worktree);

    const tools = this.#consumeTools(started.value, request);
    const completion = await started.value.completion(
      request.signal === undefined ? {} : { signal: request.signal },
    );
    const toolResult = await tools;
    if (toolResult.error !== undefined) {
      return failed("tool_decision", toolResult.error, worktree);
    }
    if (toolResult.pauseSummary !== undefined) {
      return Object.freeze({
        state: "paused",
        reason: "safety_approval_required",
        worktree,
        toolSummary: toolResult.pauseSummary,
      });
    }
    if (!completion.ok) return failed("provider_run", completion.error, worktree);
    if (completion.value.outcome === "interrupted") {
      return Object.freeze({ state: "paused", reason: "provider_interrupted", worktree });
    }
    if (completion.value.outcome !== "completed") {
      return failed("provider_run", completion.value.error, worktree);
    }

    const preflight = await this.ports.preflight.inspect(
      {
        worktree,
        declaredRegions,
        ...(request.expectedUntrackedPaths === undefined
          ? {}
          : { expectedUntrackedPaths: request.expectedUntrackedPaths }),
        ...(request.concurrentJobs === undefined ? {} : { concurrentJobs: request.concurrentJobs }),
        ...(request.knownSecrets === undefined ? {} : { knownSecrets: request.knownSecrets }),
      },
      request.signal === undefined ? {} : { signal: request.signal },
    );
    if (!preflight.ok) return failed("preflight", preflight.error, worktree);
    if (preflight.value.changedPaths.length === 0) {
      return Object.freeze({ state: "paused", reason: "no_changes", worktree });
    }
    if (
      !preflight.value.allowed ||
      !preflight.value.scopeVerified ||
      preflight.value.headSha !== worktree.headSha
    ) {
      const checkpoint = await this.ports.scopeCheckpoint.preserve(
        {
          job: request.job,
          worktree,
          requirementSnapshot: request.requirementSnapshot,
          findings: preflight.value.findings,
          changedPaths: preflight.value.changedPaths,
        },
        mutation(request, "scope-checkpoint"),
      );
      if (!checkpoint.ok) return failed("checkpoint", checkpoint.error, worktree);
      if (checkpoint.value.checkpointId.trim().length === 0) {
        return failed("checkpoint", domainError("invariant_violation"), worktree);
      }
      return Object.freeze({
        state: "paused",
        reason: "scope_overrun",
        worktree,
        checkpointId: checkpoint.value.checkpointId,
        findings: preflight.value.findings,
      });
    }

    const staged = await this.ports.git.stagePaths(
      worktree,
      preflight.value.changedPaths,
      mutation(request, "stage"),
    );
    if (!staged.ok) return failed("stage", staged.error, worktree);
    const stagedPaths = staged.value.changes
      .filter((change) => change.staged)
      .flatMap(touchedPaths);
    if (
      staged.value.headSha !== preflight.value.headSha ||
      !samePaths(stagedPaths, preflight.value.changedPaths)
    ) {
      return failed("stage", domainError("conflict"), worktree);
    }
    const committed = await this.ports.git.commit(
      {
        worktree,
        message: request.commitMessage,
        expectedStagedPaths: preflight.value.changedPaths,
      },
      mutation(request, "commit"),
    );
    if (!committed.ok) return failed("commit", committed.error, worktree);
    const clean = await this.ports.git.inspectWorkingTree(worktree);
    if (
      !clean.ok ||
      clean.value.headSha !== committed.value.sha ||
      clean.value.changes.length !== 0 ||
      committed.value.branch !== worktree.branch
    ) {
      return failed("post_commit", clean.ok ? domainError("conflict") : clean.error, worktree);
    }
    const pushed = await this.ports.git.push(worktree, request.remote, mutation(request, "push"));
    if (!pushed.ok) return failed("push", pushed.error, worktree);
    if (
      pushed.value.sha !== committed.value.sha ||
      pushed.value.branch !== committed.value.branch
    ) {
      return failed("push", domainError("conflict"), worktree);
    }
    const draft = await this.ports.sourceControl.createDraftChangeRequest(
      {
        project: request.project,
        title: request.pullRequest.title,
        body: request.pullRequest.body,
        baseBranch: request.project.defaultBranch,
        headBranch: worktree.branch,
      },
      mutation(request, "draft-pr"),
    );
    if (!draft.ok) return failed("draft_pull_request", draft.error, worktree);
    if (
      !draft.value.draft ||
      draft.value.state !== "open" ||
      draft.value.baseBranch !== request.project.defaultBranch ||
      draft.value.headBranch !== worktree.branch ||
      draft.value.headSha !== pushed.value.sha
    ) {
      return failed("draft_pull_request", domainError("conflict"), worktree);
    }
    const checks = await this.ports.sourceControl.getCommitChecks(
      { project: request.project },
      pushed.value.sha,
    );
    if (!checks.ok) return failed("checks", checks.error, worktree);
    if (checks.value.headSha !== pushed.value.sha) {
      return failed("checks", domainError("conflict"), worktree);
    }
    return Object.freeze({
      state: "ci_waiting",
      worktree,
      commit: committed.value,
      push: pushed.value,
      changeRequest: draft.value,
      checks: checks.value,
      ...(completion.value.sessionId === undefined
        ? {}
        : { providerSessionId: completion.value.sessionId }),
    });
  }

  async #consumeTools(
    handle: ProviderRunHandle,
    request: ImplementerPipelineRequest,
  ): Promise<ToolRunResult> {
    for await (const event of handle.events) {
      if (event.kind !== "tool_request") continue;
      const decision = await this.ports.toolDecisions.decide(
        event,
        { job: request.job, project: request.project },
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
