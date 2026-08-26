import type {
  AsyncPortResult,
  GitPort,
  MutationOptions,
  SourceControlPort,
  WorkManagementPort,
} from "../../application/ports/index.js";
import {
  JobPrLifecyclePublisher,
  createJobPrLifecycleEvent,
  type ManagedMutationIntent,
} from "../../application/pipelines/index.js";
import type {
  FileJobProgressStore,
  JobControlFence,
  JobProgressRecord,
  JobProgressRecordMutation,
  ProviderMutationLedgerEntry,
} from "../../adapters/dispatch/job-progress-store.js";
import {
  createClock,
  domainError,
  err,
  ok,
  type Clock,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { sha256Digest } from "../../domain/review/index.js";
import type { Project } from "../../domain/project/index.js";
import { createJobPrAuthorityValidator } from "./job-pr-authority-validator.js";

export interface ManagedMutationRequest {
  readonly intent: ManagedMutationIntent;
  /** Retained only for caller audit. The provider key is always re-derived from Job+intent+identity. */
  readonly idempotencyKey: string;
  readonly identity: unknown;
  readonly signal?: AbortSignal;
}

export interface ManagedMutationGate {
  execute<Value>(
    request: ManagedMutationRequest,
    operation: (options: MutationOptions) => AsyncPortResult<Value>,
  ): AsyncPortResult<Value>;
}

export interface FileManagedMutationAuthorityOptions {
  readonly progress: FileJobProgressStore;
  readonly jobId: string;
  readonly expectedFence: Omit<JobControlFence, "state">;
  readonly clock?: Clock;
  /** Provider read-back policy. It must validate Linear native state and PR owner/head identity. */
  readonly validateAuthority: (
    record: JobProgressRecord,
    request: ManagedMutationRequest,
    identityDigest: string,
  ) => Promise<Result<void, DomainError>>;
  /** Optional public fail-closed projection for an exhausted sent-unknown mutation. */
  readonly escalation?: Readonly<{
    project: Project;
    workManagement: WorkManagementLifecyclePort;
    sourceControl: Pick<
      SourceControlPort,
      "getChangeRequest" | "findOpenChangeRequestsByHead"
    >;
    mode?: "active" | "cancellation" | "completion" | "supersede";
    supersededByJobId?: string;
  }>;
}

export async function rotateJobControlFence(
  progress: FileJobProgressStore,
  record: JobProgressRecord,
  lease: Readonly<{ id: JobControlFence["leaseId"]; holderId: string }>,
  signal?: AbortSignal,
): Promise<Result<JobProgressRecord, DomainError>> {
  if (terminalStages.has(record.stage.kind) || record.controlFence?.state === "revoked") {
    return err(domainError("permission_denied"));
  }
  const nextEpoch = (record.controlFence?.leaseEpoch ?? 0) + 1;
  return progress.compareAndSwap(
    record.jobId,
    record.revision,
    {
      ...mutationFrom(record),
      controlFence: {
        leaseId: lease.id,
        holderId: lease.holderId,
        leaseEpoch: nextEpoch,
        ownershipEpoch: record.controlFence?.ownershipEpoch ?? 0,
        state: "active",
      },
    },
    { ...(signal === undefined ? {} : { signal }) },
  );
}

export function revokeJobControlFence(record: JobProgressRecord): JobProgressRecordMutation {
  return {
    ...mutationFrom(record),
    ...(record.controlFence === undefined
      ? {}
      : { controlFence: { ...record.controlFence, state: "revoked" as const } }),
  };
}

const terminalStages = new Set(["completed", "superseded", "cancelled"]);

function mutationFrom(record: JobProgressRecord): JobProgressRecordMutation {
  const { schemaVersion: _schemaVersion, revision: _revision, updatedAt: _updatedAt, ...mutation } =
    record;
  void _schemaVersion;
  void _revision;
  void _updatedAt;
  return mutation;
}

function exactFence(
  actual: JobControlFence | undefined,
  expected: Omit<JobControlFence, "state">,
): actual is JobControlFence {
  return (
    actual?.state === "active" &&
    actual.leaseId === expected.leaseId &&
    actual.holderId === expected.holderId &&
    actual.leaseEpoch === expected.leaseEpoch &&
    actual.ownershipEpoch === expected.ownershipEpoch
  );
}

function settlement(error: DomainError | undefined): "confirmed" | "sent_unknown" | "rejected" {
  if (error === undefined) return "confirmed";
  return ["timeout", "unavailable", "external_failure", "interrupted"].includes(error.code)
    ? "sent_unknown"
    : "rejected";
}

export class FileManagedMutationAuthority implements ManagedMutationGate {
  readonly #options: FileManagedMutationAuthorityOptions;
  readonly #clock: Clock;

  constructor(options: FileManagedMutationAuthorityOptions) {
    this.#options = options;
    this.#clock = options.clock ?? createClock();
  }

  async execute<Value>(
    request: ManagedMutationRequest,
    operation: (options: MutationOptions) => AsyncPortResult<Value>,
  ): AsyncPortResult<Value> {
    const identityDigest = sha256Digest(request.identity);
    if (!identityDigest.ok || request.idempotencyKey.trim().length === 0) {
      return err(domainError("invariant_violation"));
    }
    const operationKey = `managed:${this.#options.jobId}:${request.intent}:${identityDigest.value}`;
    const loaded = await this.#options.progress.load(this.#options.jobId, {
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (!loaded.ok) return loaded;
    if (
      loaded.value === undefined ||
      terminalStages.has(loaded.value.stage.kind) ||
      !exactFence(loaded.value.controlFence, this.#options.expectedFence)
    ) {
      return err(domainError("permission_denied"));
    }
    const authorized = await this.#options.validateAuthority(
      loaded.value,
      request,
      identityDigest.value,
    );
    if (!authorized.ok) {
      if (authorized.error.code === "conflict" && this.#options.escalation !== undefined) {
        const nestedAuthority = new FileManagedMutationAuthority({
          progress: this.#options.progress,
          jobId: this.#options.jobId,
          expectedFence: this.#options.expectedFence,
          clock: this.#clock,
          validateAuthority: this.#options.validateAuthority,
        });
        const projected = await publishAuthorityConflict({
          authority: nestedAuthority,
          project: this.#options.escalation.project,
          workManagement: this.#options.escalation.workManagement,
          record: loaded.value,
          conflictClass: "linear_github_mismatch",
          observedIdentity: request.identity,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        if (!projected.ok) return projected;
      }
      return authorized;
    }

    const ledger = [...(loaded.value.mutationAttempts ?? [])];
    const entryIndex = ledger.findIndex((entry) => entry.operationKey === operationKey);
    const currentEntry = entryIndex < 0 ? undefined : ledger[entryIndex];
    const exhaustedUnknown =
      (currentEntry?.attempts.length ?? 0) >= 2 &&
      ["prepared", "sent_unknown"].includes(
        currentEntry?.attempts.at(-1)?.outcome ?? "confirmed",
      );
    if (exhaustedUnknown) {
      const escalated = await this.#escalate(
        loaded.value,
        request,
        identityDigest.value,
        currentEntry?.attempts.length ?? 2,
      );
      return escalated.ok ? err(domainError("permission_denied")) : escalated;
    }
    if (
      currentEntry?.attempts.at(-1)?.outcome === "confirmed" ||
      currentEntry?.attempts.at(-1)?.outcome === "rejected" ||
      (currentEntry?.attempts.length ?? 0) >= 2
    ) {
      return err(domainError("permission_denied"));
    }
    const ordinal = (currentEntry?.attempts.length ?? 0) + 1;
    const preparedAttempt = {
      ordinal,
      preparedAt: this.#clock.now(),
      outcome: "prepared" as const,
    };
    const nextEntry: ProviderMutationLedgerEntry =
      currentEntry === undefined
        ? {
            operationKey,
            intent: request.intent,
            identityDigest: identityDigest.value,
            attempts: [preparedAttempt],
          }
        : {
            ...currentEntry,
            attempts: [...currentEntry.attempts, preparedAttempt],
          };
    if (entryIndex < 0) ledger.push(nextEntry);
    else ledger[entryIndex] = nextEntry;
    const prepared = await this.#options.progress.compareAndSwap(
      this.#options.jobId,
      loaded.value.revision,
      { ...mutationFrom(loaded.value), mutationAttempts: ledger },
      { ...(request.signal === undefined ? {} : { signal: request.signal }) },
    );
    if (!prepared.ok) return prepared;

    let providerResult: Result<Value, DomainError>;
    try {
      providerResult = await operation({
        idempotencyKey: operationKey,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch {
      providerResult = err(domainError("external_failure"));
    }
    const settled = await this.#settle(
      operationKey,
      ordinal,
      settlement(providerResult.ok ? undefined : providerResult.error),
      request.signal,
    );
    if (!settled.ok) return err(domainError("external_failure"));
    if (!providerResult.ok && ordinal >= 2 && settlement(providerResult.error) === "sent_unknown") {
      const refreshed = await this.#options.progress.load(this.#options.jobId, {
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      if (!refreshed.ok || refreshed.value === undefined) {
        return refreshed.ok ? err(domainError("not_found")) : refreshed;
      }
      const escalated = await this.#escalate(
        refreshed.value,
        request,
        identityDigest.value,
        ordinal,
      );
      if (!escalated.ok) return escalated;
    }
    return providerResult;
  }

  async #escalate(
    record: JobProgressRecord,
    request: ManagedMutationRequest,
    identityDigest: string,
    attemptCount: number,
  ): Promise<Result<void, DomainError>> {
    const escalation = this.#options.escalation;
    if (escalation === undefined) return ok(undefined);
    const event = createJobPrLifecycleEvent({
      schemaVersion: 1,
      kind: "escalation_requested",
      projectId: record.projectId,
      issueId: record.issueId,
      jobId: record.jobId,
      ...(record.changeRequestId === undefined
        ? {}
        : { prNumber: Number.parseInt(record.changeRequestId, 10) }),
      ...(record.headSha === undefined ? {} : { headSha: record.headSha }),
      mutationIntent: request.intent,
      identityDigest,
      escalationEpoch: 1,
      attemptCount: Math.min(2, Math.max(1, attemptCount)),
      decisionQuestion: "retry_or_abandon",
    });
    if (!event.ok) return event;
    const nestedAuthority = new FileManagedMutationAuthority({
      progress: this.#options.progress,
      jobId: this.#options.jobId,
      expectedFence: this.#options.expectedFence,
      clock: this.#clock,
      validateAuthority: createJobPrAuthorityValidator({
        project: escalation.project,
        workManagement: escalation.workManagement,
        sourceControl: escalation.sourceControl,
        ...(escalation.mode === undefined ? {} : { mode: escalation.mode }),
        ...(escalation.supersededByJobId === undefined
          ? {}
          : { supersededByJobId: escalation.supersededByJobId }),
      }),
    });
    const workManagement = fenceWorkManagementLifecyclePort(
      escalation.workManagement,
      nestedAuthority,
    );
    const publisher = new JobPrLifecyclePublisher(workManagement);
    const published = await publisher.publish({
      issue: { project: escalation.project, externalIssueId: record.externalIssueId },
      humanSummary: `Agent Team 的 ${request.intent} 操作已達兩次安全嘗試上限，已停止並請團隊管理者裁決。`,
      event: event.value,
    });
    if (!published.ok) return published;
    const condition = await workManagement.setAgentCondition(
      { project: escalation.project, externalIssueId: record.externalIssueId },
      { status: "blocked", blockingReasons: ["integration_failure"] },
      {
        idempotencyKey: `managed-escalation:${record.jobId}:${identityDigest}:condition`,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      },
    );
    if (!condition.ok) return condition;
    return condition.value.agentCondition?.status === "blocked" &&
      condition.value.agentCondition.blockingReasons.includes("integration_failure")
      ? ok(undefined)
      : err(domainError("conflict"));
  }

  async #settle(
    operationKey: string,
    ordinal: number,
    outcome: "confirmed" | "sent_unknown" | "rejected",
    signal: AbortSignal | undefined,
  ): Promise<Result<void, DomainError>> {
    const loaded = await this.#options.progress.load(this.#options.jobId, {
      ...(signal === undefined ? {} : { signal }),
    });
    if (
      !loaded.ok ||
      loaded.value === undefined ||
      !exactFence(loaded.value.controlFence, this.#options.expectedFence)
    ) {
      return loaded.ok ? err(domainError("conflict")) : loaded;
    }
    const ledger = [...(loaded.value.mutationAttempts ?? [])];
    const entryIndex = ledger.findIndex((entry) => entry.operationKey === operationKey);
    const entry = entryIndex < 0 ? undefined : ledger[entryIndex];
    const attempt = entry?.attempts[ordinal - 1];
    if (entry === undefined || attempt?.outcome !== "prepared" || attempt.ordinal !== ordinal) {
      return err(domainError("conflict"));
    }
    const attempts = [...entry.attempts];
    attempts[ordinal - 1] = { ...attempt, outcome };
    ledger[entryIndex] = { ...entry, attempts };
    const written = await this.#options.progress.compareAndSwap(
      this.#options.jobId,
      loaded.value.revision,
      { ...mutationFrom(loaded.value), mutationAttempts: ledger },
      { ...(signal === undefined ? {} : { signal }) },
    );
    return written.ok ? ok(undefined) : written;
  }
}

export async function publishAuthorityConflict(options: Readonly<{
  authority: ManagedMutationGate;
  project: Project;
  workManagement: WorkManagementLifecyclePort;
  record: JobProgressRecord;
  conflictClass:
    | "multiple_pr_candidates"
    | "pr_identity_mismatch"
    | "owner_conflict"
    | "unsettled_pr"
    | "linear_github_mismatch";
  observedIdentity: unknown;
  prNumber?: number;
  signal?: AbortSignal;
}>): Promise<Result<void, DomainError>> {
  const observedIdentityDigest = sha256Digest(options.observedIdentity);
  if (!observedIdentityDigest.ok) return observedIdentityDigest;
  const event = createJobPrLifecycleEvent({
    schemaVersion: 1,
    kind: "authority_conflict",
    projectId: options.record.projectId,
    issueId: options.record.issueId,
    jobId: options.record.jobId,
    ...(options.prNumber === undefined ? {} : { prNumber: options.prNumber }),
    conflictClass: options.conflictClass,
    conflictEpoch: 1,
    observedIdentityDigest: observedIdentityDigest.value,
  });
  if (!event.ok) return event;
  const fenced = fenceWorkManagementLifecyclePort(options.workManagement, options.authority);
  const published = await new JobPrLifecyclePublisher(fenced).publish({
    issue: { project: options.project, externalIssueId: options.record.externalIssueId },
    humanSummary: `Agent Team 偵測到 ${options.conflictClass} 權威衝突，已停止自動操作並交由團隊管理者判斷。`,
    event: event.value,
  });
  if (!published.ok) return published;
  const condition = await fenced.setAgentCondition(
    { project: options.project, externalIssueId: options.record.externalIssueId },
    { status: "blocked", blockingReasons: ["integration_failure"] },
    {
      idempotencyKey: `authority-conflict:${options.record.jobId}:${event.value.eventId}:condition`,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  return condition.ok &&
    condition.value.agentCondition?.status === "blocked" &&
    condition.value.agentCondition.blockingReasons.includes("integration_failure")
    ? ok(undefined)
    : condition.ok
      ? err(domainError("conflict"))
      : condition;
}

export interface ProjectManagedMutationAuthorityOptions {
  readonly progress: FileJobProgressStore;
  readonly project: Project;
  readonly holderId: string;
  readonly workManagement: Pick<WorkManagementPort, "getIssue" | "listComments">;
  readonly sourceControl: Pick<
    SourceControlPort,
    "getChangeRequest" | "findOpenChangeRequestsByHead"
  >;
  readonly escalationWorkManagement?: WorkManagementLifecyclePort;
  readonly clock?: Clock;
}

function identityField(identity: unknown, field: string): string | undefined {
  if (typeof identity !== "object" || identity === null) return undefined;
  const value = (identity as Readonly<Record<string, unknown>>)[field];
  return typeof value === "string" ? value : undefined;
}

function requestMatchesRecord(request: ManagedMutationRequest, record: JobProgressRecord): boolean {
  switch (request.intent) {
    case "git_push":
      return identityField(request.identity, "branch") === record.branch;
    case "pr_create":
      return identityField(request.identity, "headBranch") === record.branch;
    case "pr_update":
    case "pr_ready":
    case "pr_close":
    case "pr_comment":
    case "auto_merge":
    case "merge":
      return identityField(request.identity, "changeRequestId") === record.changeRequestId;
    case "commit_status":
    case "review_status":
      return identityField(request.identity, "headSha") === record.headSha;
    case "linear_lifecycle":
    case "linear_work_status":
    case "linear_agent_condition":
      return identityField(request.identity, "externalIssueId") === record.externalIssueId;
  }
}

/** Project-scoped resolver used by the shared resume composition. It still delegates the actual
 * persist-before-send protocol to the exact per-Job authority after resolving one unambiguous
 * active fence owned by this process. */
export class ProjectManagedMutationAuthority implements ManagedMutationGate {
  constructor(readonly options: ProjectManagedMutationAuthorityOptions) {}

  async execute<Value>(
    request: ManagedMutationRequest,
    operation: (options: MutationOptions) => AsyncPortResult<Value>,
  ): AsyncPortResult<Value> {
    const records = await this.options.progress.listForProject(this.options.project.id, {
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (!records.ok) return records;
    const matches = records.value.filter(
      (record) =>
        !terminalStages.has(record.stage.kind) &&
        record.controlFence?.state === "active" &&
        record.controlFence.holderId === this.options.holderId &&
        requestMatchesRecord(request, record),
    );
    if (matches.length !== 1 || matches[0]?.controlFence === undefined) {
      return err(domainError("permission_denied"));
    }
    const record = matches[0];
    const fence = record.controlFence;
    if (fence === undefined) return err(domainError("permission_denied"));
    return new FileManagedMutationAuthority({
      progress: this.options.progress,
      jobId: record.jobId,
      expectedFence: {
        leaseId: fence.leaseId,
        holderId: fence.holderId,
        leaseEpoch: fence.leaseEpoch,
        ownershipEpoch: fence.ownershipEpoch,
      },
      ...(this.options.clock === undefined ? {} : { clock: this.options.clock }),
      validateAuthority: createJobPrAuthorityValidator({
        project: this.options.project,
        workManagement: this.options.workManagement,
        sourceControl: this.options.sourceControl,
      }),
      ...(this.options.escalationWorkManagement === undefined
        ? {}
        : {
            escalation: {
              project: this.options.project,
              workManagement: this.options.escalationWorkManagement,
              sourceControl: this.options.sourceControl,
            },
          }),
    }).execute(request, operation);
  }
}

function request(
  intent: ManagedMutationIntent,
  options: MutationOptions,
  identity: unknown,
): ManagedMutationRequest {
  return {
    intent,
    idempotencyKey: options.idempotencyKey,
    identity,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

export function fenceSourceControlPort(
  inner: SourceControlPort,
  gate: ManagedMutationGate,
): SourceControlPort {
  return {
    getChangeRequest: (reference, options) => inner.getChangeRequest(reference, options),
    findOpenChangeRequestsByHead: (repository, headBranch, options) =>
      inner.findOpenChangeRequestsByHead(repository, headBranch, options),
    getCommitChecks: (repository, headSha, options) =>
      inner.getCommitChecks(repository, headSha, options),
    getCommitStatuses: (repository, headSha, options) =>
      inner.getCommitStatuses(repository, headSha, options),
    createDraftChangeRequest: (command, options) =>
      gate.execute(
        request("pr_create", options, {
          projectId: command.project.id,
          repository: command.project.sourceControl.repository,
          title: command.title,
          body: command.body,
          baseBranch: command.baseBranch,
          headBranch: command.headBranch,
        }),
        (stable) => inner.createDraftChangeRequest(command, stable),
      ),
    setCommitStatus: (command, options) =>
      gate.execute(
        request(command.context === "agent-team/review" ? "review_status" : "commit_status", options, {
          projectId: command.project.id,
          headSha: command.headSha,
          context: command.context,
          state: command.state,
          description: command.description,
          targetUrl: command.targetUrl ?? null,
        }),
        (stable) => inner.setCommitStatus(command, stable),
      ),
    appendChangeRequestComment: (command, options) =>
      gate.execute(
        request("pr_comment", options, {
          projectId: command.changeRequest.project.id,
          changeRequestId: command.changeRequest.changeRequestId,
          expectedHeadSha: command.expectedHeadSha,
          kind: command.kind,
          body: command.body,
        }),
        (stable) => inner.appendChangeRequestComment(command, stable),
      ),
    markChangeRequestReady: (reference, expectedHeadSha, options) =>
      gate.execute(
        request("pr_ready", options, {
          projectId: reference.project.id,
          changeRequestId: reference.changeRequestId,
          expectedHeadSha,
        }),
        (stable) => inner.markChangeRequestReady(reference, expectedHeadSha, stable),
      ),
    enableAutoMerge: (reference, expectedHeadSha, options) =>
      gate.execute(
        request("auto_merge", options, {
          projectId: reference.project.id,
          changeRequestId: reference.changeRequestId,
          expectedHeadSha,
        }),
        (stable) => inner.enableAutoMerge(reference, expectedHeadSha, stable),
      ),
    closeChangeRequest: (reference, options) =>
      gate.execute(
        request("pr_close", options, {
          projectId: reference.project.id,
          changeRequestId: reference.changeRequestId,
        }),
        (stable) => inner.closeChangeRequest(reference, stable),
      ),
  };
}

export function fenceGitPort(inner: GitPort, gate: ManagedMutationGate): GitPort {
  return {
    inspectRepository: (repository, options) => inner.inspectRepository(repository, options),
    resolveAuthoritativeBranch: (command, options) =>
      inner.resolveAuthoritativeBranch(command, options),
    createWorktree: (command, options) => inner.createWorktree(command, options),
    inspectWorktree: (worktree, options) => inner.inspectWorktree(worktree, options),
    inspectWorkingTree: (worktree, options) => inner.inspectWorkingTree(worktree, options),
    readTextFileAtRevision: (command, options) => inner.readTextFileAtRevision(command, options),
    stagePaths: (worktree, paths, options) => inner.stagePaths(worktree, paths, options),
    getEffectiveTreeDiff: (repository, baseRevision, headRevision, options) =>
      inner.getEffectiveTreeDiff(repository, baseRevision, headRevision, options),
    getStagedTreeDiff: (worktree, baseRevision, options) =>
      inner.getStagedTreeDiff(worktree, baseRevision, options),
    inspectCommit: (repository, revision, options) =>
      inner.inspectCommit(repository, revision, options),
    commit: (command, options) => inner.commit(command, options),
    push: (worktree, remote, options) =>
      gate.execute(
        request("git_push", options, {
          branch: worktree.branch,
          headSha: worktree.headSha,
          remote,
        }),
        (stable) => inner.push(worktree, remote, stable),
      ),
    removeWorktree: (worktree, options) => inner.removeWorktree(worktree, options),
  };
}

export function fenceWorkManagementPort(
  inner: WorkManagementPort,
  gate: ManagedMutationGate,
): WorkManagementPort {
  return {
    getIssue: (reference, options) => inner.getIssue(reference, options),
    listIssues: (query, options) => inner.listIssues(query, options),
    listComments: (reference, options) => inner.listComments(reference, options),
    createIssue: (command, options) =>
      gate.execute(
        request("linear_lifecycle", options, {
          projectId: command.project.id,
          title: command.issue.title,
        }),
        (stable) => inner.createIssue(command, stable),
      ),
    setWorkStatus: (reference, status, options) =>
      gate.execute(
        request("linear_work_status", options, {
          projectId: reference.project.id,
          externalIssueId: reference.externalIssueId,
          status,
          cause: options.cause ?? null,
        }),
        (stable) =>
          inner.setWorkStatus(reference, status, {
            ...stable,
            ...(options.cause === undefined ? {} : { cause: options.cause }),
          }),
      ),
    setAgentCondition: (reference, condition, options) =>
      gate.execute(
        request("linear_agent_condition", options, {
          projectId: reference.project.id,
          externalIssueId: reference.externalIssueId,
          condition,
        }),
        (stable) => inner.setAgentCondition(reference, condition, stable),
      ),
    clearAgentCondition: (reference, options) =>
      gate.execute(
        request("linear_agent_condition", options, {
          projectId: reference.project.id,
          externalIssueId: reference.externalIssueId,
          clear: true,
        }),
        (stable) => inner.clearAgentCondition(reference, stable),
      ),
    appendComment: (reference, body, options) =>
      gate.execute(
        request("linear_lifecycle", options, {
          projectId: reference.project.id,
          externalIssueId: reference.externalIssueId,
          body,
        }),
        (stable) => inner.appendComment(reference, body, stable),
      ),
    uploadArtifact: (reference, artifact, options) =>
      gate.execute(
        request("linear_lifecycle", options, {
          projectId: reference.project.id,
          externalIssueId: reference.externalIssueId,
          filename: artifact.filename,
          mediaType: artifact.mediaType,
          sha256: artifact.sha256,
        }),
        (stable) => inner.uploadArtifact(reference, artifact, stable),
      ),
  };
}

export type WorkManagementLifecyclePort = Pick<
  WorkManagementPort,
  | "getIssue"
  | "listIssues"
  | "listComments"
  | "setWorkStatus"
  | "setAgentCondition"
  | "clearAgentCondition"
  | "appendComment"
>;

export function fenceWorkManagementLifecyclePort(
  inner: WorkManagementLifecyclePort,
  gate: ManagedMutationGate,
): WorkManagementLifecyclePort {
  return {
    getIssue: (reference, options) => inner.getIssue(reference, options),
    listIssues: (query, options) => inner.listIssues(query, options),
    listComments: (reference, options) => inner.listComments(reference, options),
    setWorkStatus: (reference, status, options) =>
      gate.execute(
        request("linear_work_status", options, {
          projectId: reference.project.id,
          externalIssueId: reference.externalIssueId,
          status,
          cause: options.cause ?? null,
        }),
        (stable) =>
          inner.setWorkStatus(reference, status, {
            ...stable,
            ...(options.cause === undefined ? {} : { cause: options.cause }),
          }),
      ),
    setAgentCondition: (reference, condition, options) =>
      gate.execute(
        request("linear_agent_condition", options, {
          projectId: reference.project.id,
          externalIssueId: reference.externalIssueId,
          condition,
        }),
        (stable) => inner.setAgentCondition(reference, condition, stable),
      ),
    clearAgentCondition: (reference, options) =>
      gate.execute(
        request("linear_agent_condition", options, {
          projectId: reference.project.id,
          externalIssueId: reference.externalIssueId,
          clear: true,
        }),
        (stable) => inner.clearAgentCondition(reference, stable),
      ),
    appendComment: (reference, body, options) =>
      gate.execute(
        request("linear_lifecycle", options, {
          projectId: reference.project.id,
          externalIssueId: reference.externalIssueId,
          body,
        }),
        (stable) => inner.appendComment(reference, body, stable),
      ),
  };
}
