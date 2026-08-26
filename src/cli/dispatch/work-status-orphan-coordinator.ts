import type {
  FileJobProgressStore,
  JobProgressRecord,
} from "../../adapters/dispatch/job-progress-store.js";
import type { IssueAdmissionInventoryPort } from "../../adapters/dispatch/issue-admission-store.js";
import {
  createWorkStatusLifecycleTransitionInstance,
  type IssueScopeLockHandle,
  type IssueScopeLockPort,
  type WorkStatusLifecycleCoordinator,
} from "../../application/pipelines/index.js";
import type {
  WorkManagementIssueSnapshot,
  WorkManagementPort,
} from "../../application/ports/index.js";
import { sha256Digest } from "../../domain/review/index.js";
import type { Project } from "../../domain/project/index.js";
import { createAgentCondition } from "../../domain/workflow/index.js";
import {
  hasConfirmedWorkStart,
  latestConfirmedActiveWorkStatus,
  mayProjectRequiresManual,
  requiresManualBlockingReason,
  requiresManualHandoffComment,
} from "./requires-manual-projection.js";

type OrphanWorkManagement = Pick<
  WorkManagementPort,
  "listIssues" | "getIssue" | "setWorkStatus" | "setAgentCondition" | "appendComment"
>;

export interface WorkStatusOrphanScanOutcome {
  readonly projectId: string;
  readonly inspected: number;
  readonly humanOwned: number;
  readonly activeManaged: number;
  readonly terminalResidue: number;
  readonly quarantined: number;
  readonly blocked: number;
}

export type WorkStatusJobReconcileOutcome = Readonly<
  | { state: "completed"; projectId: string; jobId: string }
  | {
      state: "blocked";
      projectId: string;
      jobId: string;
      reason:
        | "project_mismatch"
        | "job_not_reconcilable"
        | "issue_unavailable"
        | "issue_not_automation_owned"
        | "issue_lock_unavailable"
        | "projection_blocked"
        | "projection_stale"
        | "issue_lock_release_failed";
    }
>;

type TerminalProjectionOutcome = "completed" | "stale" | "blocked";

export class WorkStatusOrphanCoordinator {
  constructor(
    readonly dependencies: {
      readonly project: Project;
      readonly workManagement: OrphanWorkManagement;
      readonly progress: Pick<FileJobProgressStore, "listAll" | "load">;
      readonly admission: IssueAdmissionInventoryPort;
      readonly locks: IssueScopeLockPort;
      readonly lifecycle: Pick<WorkStatusLifecycleCoordinator, "transitionWhileLockHeld">;
    },
  ) {}

  /**
   * Exact-job recovery surface. Unlike scan(), this never enumerates or mutates another Linear
   * issue. The terminal projector still re-reads progress, claim, competing jobs and Linear state
   * while holding the per-issue lock before it performs any mutation.
   */
  async reconcileJob(record: JobProgressRecord): Promise<WorkStatusJobReconcileOutcome> {
    const blocked = (
      reason: Extract<WorkStatusJobReconcileOutcome, { state: "blocked" }>["reason"],
    ): WorkStatusJobReconcileOutcome =>
      Object.freeze({ state: "blocked", projectId: record.projectId, jobId: record.jobId, reason });
    if (record.projectId !== this.dependencies.project.id) return blocked("project_mismatch");
    if (
      record.stage.kind !== "requires_manual" ||
      !mayProjectRequiresManual(record) ||
      !hasConfirmedWorkStart(record)
    ) {
      return blocked("job_not_reconcilable");
    }
    const reference = {
      project: this.dependencies.project,
      externalIssueId: record.externalIssueId,
    };
    const candidate = await this.dependencies.workManagement.getIssue(reference);
    if (!candidate.ok) return blocked("issue_unavailable");
    if (
      candidate.value.issue.agentRole === undefined ||
      candidate.value.issue.externalId !== record.externalIssueId
    ) {
      return blocked("issue_not_automation_owned");
    }
    const lock = await this.dependencies.locks.acquire(
      { projectId: record.projectId, externalIssueId: record.externalIssueId },
      `work-status-orphan:${record.jobId}`,
    );
    if (!lock.ok) return blocked("issue_lock_unavailable");
    const projected = await this.#finishTerminalProjection(record, candidate.value, lock.value);
    const released = await lock.value.release();
    if (!released.ok) return blocked("issue_lock_release_failed");
    if (projected === "blocked") return blocked("projection_blocked");
    if (projected === "stale") return blocked("projection_stale");
    return Object.freeze({ state: "completed", projectId: record.projectId, jobId: record.jobId });
  }

  async scan(): Promise<WorkStatusOrphanScanOutcome> {
    const listed = await this.dependencies.workManagement.listIssues({
      project: this.dependencies.project,
      workStatuses: ["in_progress", "in_review", "requires_manual"],
    });
    const progress = await this.dependencies.progress.listAll();
    const claims = await this.dependencies.admission.listForProject(this.dependencies.project.id);
    if (!listed.ok || !progress.ok || !claims.ok) {
      return this.#outcome({ blocked: 1 });
    }
    let humanOwned = 0;
    let activeManaged = 0;
    let terminalResidue = 0;
    let quarantined = 0;
    let blocked = 0;
    for (const candidate of listed.value) {
      if (candidate.issue.agentRole === undefined) {
        humanOwned += 1;
        continue;
      }
      const records = progress.value.filter(
        (record) =>
          record.projectId === this.dependencies.project.id &&
          record.externalIssueId === candidate.issue.externalId,
      );
      const activeClaims = claims.value.filter(
        (claim) => claim.state === "active" && claim.externalIssueId === candidate.issue.externalId,
      );
      const live = records.filter(
        (record) =>
          !["completed", "failed", "superseded", "cancelled", "requires_manual"].includes(
            record.stage.kind,
          ),
      );
      const activeManagedJobId =
        live.length === 1 && activeClaims.length === 1 && activeClaims[0]?.jobId === live[0]?.jobId
          ? live[0]?.jobId
          : undefined;
      const manualHandoff = records.find(
        (record) =>
          record.stage.kind === "requires_manual" &&
          mayProjectRequiresManual(record) &&
          activeClaims.length === 1 &&
          activeClaims[0]?.jobId === record.jobId &&
          hasConfirmedWorkStart(record),
      );
      const autoReentryHandoff = records.some(
        (record) =>
          record.stage.kind === "requires_manual" &&
          !mayProjectRequiresManual(record) &&
          activeClaims.length === 1 &&
          activeClaims[0]?.jobId === record.jobId,
      );
      const attributableTerminal =
        manualHandoff ??
        (activeManagedJobId === undefined
          ? records.find(
              (record) =>
                ["completed", "cancelled"].includes(record.stage.kind) &&
                hasConfirmedWorkStart(record),
            )
          : undefined);
      if (attributableTerminal !== undefined) {
        const holderId = `work-status-orphan:${attributableTerminal.jobId}`;
        const lock = await this.dependencies.locks.acquire(
          {
            projectId: this.dependencies.project.id,
            externalIssueId: candidate.issue.externalId,
          },
          holderId,
        );
        if (!lock.ok) {
          blocked += 1;
          continue;
        }
        const finished = await this.#finishTerminalProjection(
          attributableTerminal,
          candidate,
          lock.value,
        );
        const released = await lock.value.release();
        if (!released.ok || finished === "blocked") blocked += 1;
        else if (finished === "completed") terminalResidue += 1;
        continue;
      }
      if (activeManagedJobId !== undefined) {
        activeManaged += 1;
        continue;
      }
      if (autoReentryHandoff) {
        activeManaged += 1;
        continue;
      }
      const automationOwned =
        records.some((record) => record.workStatusLifecycle !== undefined) ||
        activeClaims.length > 0;
      if (!automationOwned) {
        humanOwned += 1;
        continue;
      }
      const reference = {
        project: this.dependencies.project,
        externalIssueId: candidate.issue.externalId,
      };
      const holderId = `work-status-orphan:${this.dependencies.project.id}:${candidate.issue.externalId}`;
      const lock = await this.dependencies.locks.acquire(
        {
          projectId: this.dependencies.project.id,
          externalIssueId: candidate.issue.externalId,
        },
        holderId,
      );
      if (!lock.ok) {
        blocked += 1;
        continue;
      }
      const current = await this.dependencies.workManagement.getIssue(reference);
      if (
        !current.ok ||
        !["in_progress", "in_review", "requires_manual"].includes(current.value.workStatus) ||
        current.value.issue.agentRole === undefined ||
        current.value.issue.externalId !== candidate.issue.externalId
      ) {
        await lock.value.release();
        blocked += 1;
        continue;
      }
      const key = `work-status-orphan:${this.dependencies.project.id}:${candidate.issue.externalId}`;
      const status =
        current.value.workStatus === "requires_manual"
          ? current
          : await this.dependencies.workManagement.setWorkStatus(reference, "requires_manual", {
              idempotencyKey: `${key}:status`,
            });
      if (!status.ok || status.value.workStatus !== "requires_manual") {
        await lock.value.release();
        blocked += 1;
        continue;
      }
      const condition = await this.dependencies.workManagement.setAgentCondition(
        reference,
        createAgentCondition("blocked", ["unknown_error"]),
        { idempotencyKey: `${key}:condition` },
      );
      if (!condition.ok || condition.value.agentCondition?.status !== "blocked") {
        await lock.value.release();
        blocked += 1;
        continue;
      }
      const comment = await this.dependencies.workManagement.appendComment(
        reference,
        "Agent Team 偵測到此工單仍在進行中，但找不到唯一且一致的既有 Job 與 claim。已依 orphan_in_progress 安全隔離為需人工／已阻塞；系統不會自動重接或退回待執行。",
        { idempotencyKey: `${key}:comment` },
      );
      if (!comment.ok) {
        await lock.value.release();
        blocked += 1;
        continue;
      }
      const released = await lock.value.release();
      if (released.ok) quarantined += 1;
      else blocked += 1;
    }
    return this.#outcome({
      inspected: listed.value.length,
      humanOwned,
      activeManaged,
      terminalResidue,
      quarantined,
      blocked,
    });
  }

  async #finishTerminalProjection(
    record: JobProgressRecord,
    candidate: WorkManagementIssueSnapshot,
    lock: IssueScopeLockHandle,
  ): Promise<TerminalProjectionOutcome> {
    const checkpoint = record.workStatusLifecycle;
    if (checkpoint?.admissionMode !== "enforce" || checkpoint.capabilityDigest === undefined) {
      return "blocked";
    }
    const pendingHumanAcceptance =
      record.stage.kind === "completed" &&
      record.humanDelivery?.acceptanceRequirement === "required";
    if (pendingHumanAcceptance && record.humanDelivery?.acceptanceIdentityDigest === undefined) {
      return "blocked";
    }
    const target =
      record.stage.kind === "completed"
        ? pendingHumanAcceptance
          ? "in_review"
          : "completed"
        : record.stage.kind === "cancelled"
          ? "canceled"
          : "requires_manual";
    const step = target === "requires_manual" ? "requires_manual" : "complete";
    const prior = [...checkpoint.transitions]
      .reverse()
      .find((transition) => transition.step === step && transition.mainTarget === target);
    const latestConfirmedTransition = [...checkpoint.transitions]
      .reverse()
      .find((transition) => transition.main.state === "confirmed");
    const priorSource =
      prior?.allowedMainSources !== undefined && latestConfirmedTransition === prior
        ? prior.allowedMainSources.find(
            (source): source is "in_progress" | "in_review" =>
              source === "in_progress" || source === "in_review",
          )
        : undefined;
    // A confirmed terminal receipt intentionally becomes the latest confirmed transition. Reuse
    // that same receipt's immutable active source when retrying only the safe comment; do not skip
    // an unrelated later terminal transition or infer a new source from live Linear state.
    const confirmedSource = priorSource ?? latestConfirmedActiveWorkStatus(record);
    if (confirmedSource === undefined) return "blocked";
    const allowedMainSources = [confirmedSource] as const;
    const agentTarget =
      target === "requires_manual" && record.stage.kind === "requires_manual"
        ? {
            kind: "set" as const,
            status: "blocked" as const,
            blockingReason: requiresManualBlockingReason(record.stage.cause),
          }
        : ({ kind: "clear" as const } as const);
    const reference = {
      project: this.dependencies.project,
      externalIssueId: candidate.issue.externalId,
    };
    const [latest, claim, latestInventory] = await Promise.all([
      this.dependencies.progress.load(record.jobId),
      this.dependencies.admission.load(record.projectId, record.issueId),
      this.dependencies.progress.listAll(),
    ]);
    if (!latest.ok || !claim.ok || !latestInventory.ok) return "blocked";
    const expectedStage = record.stage.kind;
    const competingLiveRecord = latestInventory.value.some(
      (candidateRecord) =>
        candidateRecord.projectId === record.projectId &&
        candidateRecord.externalIssueId === record.externalIssueId &&
        candidateRecord.jobId !== record.jobId &&
        !["completed", "failed", "superseded", "cancelled"].includes(candidateRecord.stage.kind),
    );
    const conflictingClaim = claim.value?.state === "active" && claim.value.jobId !== record.jobId;
    const manualClaimMissing =
      target === "requires_manual" &&
      (claim.value?.state !== "active" ||
        claim.value.jobId !== record.jobId ||
        claim.value.externalIssueId !== record.externalIssueId);
    if (
      latest.value?.revision !== record.revision ||
      latest.value.stage.kind !== expectedStage ||
      competingLiveRecord ||
      conflictingClaim ||
      manualClaimMissing
    ) {
      return "stale";
    }
    const current = await this.dependencies.workManagement.getIssue(reference);
    if (
      !current.ok ||
      !(
        current.value.workStatus === target ||
        allowedMainSources.includes(current.value.workStatus as (typeof allowedMainSources)[number])
      ) ||
      current.value.issue.agentRole === undefined ||
      current.value.issue.externalId !== candidate.issue.externalId
    ) {
      return "blocked";
    }
    const confirmedHumanAcceptanceHandoff =
      pendingHumanAcceptance &&
      current.value.workStatus === "in_review" &&
      current.value.agentCondition === undefined &&
      latestConfirmedTransition === prior &&
      prior?.main.state === "confirmed" &&
      prior.agent.state === "confirmed";
    if (confirmedHumanAcceptanceHandoff) return "completed";
    if (prior?.main.state === "sent_unknown") return "blocked";
    const confirmedReceiptNeedsRecovery =
      pendingHumanAcceptance &&
      prior?.main.state === "confirmed" &&
      (current.value.workStatus !== "in_review" || current.value.agentCondition !== undefined);
    const reusablePrior = confirmedReceiptNeedsRecovery ? undefined : prior;
    const transitionAllowedMainSources =
      confirmedReceiptNeedsRecovery && prior.allowedMainSources !== undefined
        ? prior.allowedMainSources
        : allowedMainSources;
    const authority = sha256Digest({
      schemaVersion: 1,
      operation: "work-status-orphan-terminal-projection",
      jobId: record.jobId,
      target,
      ...(pendingHumanAcceptance
        ? { humanAcceptanceIdentityDigest: record.humanDelivery?.acceptanceIdentityDigest }
        : {}),
      ...(confirmedReceiptNeedsRecovery ? { recoveryOfTransitionInstance: prior.instance } : {}),
      ...(record.stage.kind === "requires_manual" ? { cause: record.stage.cause } : {}),
    });
    if (!authority.ok) return "blocked";
    const instance =
      reusablePrior?.instance ??
      createWorkStatusLifecycleTransitionInstance({
        jobId: record.jobId,
        step,
        mainTarget: target,
        allowedMainSources: transitionAllowedMainSources,
        agentTarget,
        authorityDigest: authority.value,
      });
    if (typeof instance !== "string" && !instance.ok) return "blocked";
    const transitionInstance = typeof instance === "string" ? instance : instance.value;
    const invocation = sha256Digest({
      schemaVersion: 1,
      operation: "work-status-orphan-terminal-projection-invocation",
      jobId: record.jobId,
      transitionInstance,
      progressRevision: record.revision,
    });
    if (!invocation.ok) return "blocked";
    const result = await this.dependencies.lifecycle.transitionWhileLockHeld(
      {
        jobId: record.jobId,
        reference,
        holderId: `work-status-orphan:${record.jobId}`,
        mode: "enforce",
        capabilityDigest: checkpoint.capabilityDigest,
        phase: "terminal",
        step,
        transitionInstance,
        invocationDigest: invocation.value,
        mainTarget: target,
        allowedMainSources: reusablePrior?.allowedMainSources ?? transitionAllowedMainSources,
        agentTarget: reusablePrior?.agentTarget ?? agentTarget,
      },
      lock,
    );
    if (result.state !== "permitted") return "blocked";
    if (target !== "requires_manual") return "completed";
    const comment = await this.dependencies.workManagement.appendComment(
      reference,
      requiresManualHandoffComment(record),
      {
        idempotencyKey: `work-status-lifecycle:${record.jobId}:${transitionInstance}:requires-manual-comment`,
      },
    );
    return comment.ok ? "completed" : "blocked";
  }

  #outcome(overrides: Partial<Omit<WorkStatusOrphanScanOutcome, "projectId">>) {
    return Object.freeze({
      projectId: this.dependencies.project.id,
      inspected: 0,
      humanOwned: 0,
      activeManaged: 0,
      terminalResidue: 0,
      quarantined: 0,
      blocked: 0,
      ...overrides,
    });
  }
}
