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

export class WorkStatusOrphanCoordinator {
  constructor(
    readonly dependencies: {
      readonly project: Project;
      readonly workManagement: OrphanWorkManagement;
      readonly progress: Pick<FileJobProgressStore, "listAll">;
      readonly admission: IssueAdmissionInventoryPort;
      readonly locks: IssueScopeLockPort;
      readonly lifecycle: Pick<WorkStatusLifecycleCoordinator, "transitionWhileLockHeld">;
    },
  ) {}

  async scan(): Promise<WorkStatusOrphanScanOutcome> {
    const listed = await this.dependencies.workManagement.listIssues({
      project: this.dependencies.project,
      workStatuses: ["in_progress", "requires_manual"],
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
        (record) => !["completed", "failed", "superseded", "cancelled"].includes(record.stage.kind),
      );
      if (
        live.length === 1 &&
        activeClaims.length === 1 &&
        activeClaims[0]?.jobId === live[0]?.jobId
      ) {
        activeManaged += 1;
        continue;
      }
      const attributableTerminal = records.find(
        (record) =>
          ["completed", "cancelled"].includes(record.stage.kind) &&
          record.workStatusLifecycle?.transitions.some(
            (transition) =>
              transition.step === "work_start" && transition.main.state === "confirmed",
          ) === true,
      );
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
        if (finished && released.ok) terminalResidue += 1;
        else blocked += 1;
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
        !["in_progress", "requires_manual"].includes(current.value.workStatus) ||
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
  ): Promise<boolean> {
    const checkpoint = record.workStatusLifecycle;
    if (checkpoint?.admissionMode !== "enforce" || checkpoint.capabilityDigest === undefined) {
      return false;
    }
    const target = record.stage.kind === "completed" ? "completed" : "canceled";
    const reference = {
      project: this.dependencies.project,
      externalIssueId: candidate.issue.externalId,
    };
    const current = await this.dependencies.workManagement.getIssue(reference);
    if (
      !current.ok ||
      current.value.workStatus !== "in_progress" ||
      current.value.issue.agentRole === undefined ||
      current.value.issue.externalId !== candidate.issue.externalId
    ) {
      return false;
    }
    const prior = [...checkpoint.transitions]
      .reverse()
      .find((transition) => transition.step === "complete" && transition.mainTarget === target);
    if (prior?.main.state === "sent_unknown" || prior?.main.state === "confirmed") return false;
    const authority = sha256Digest({
      schemaVersion: 1,
      operation: "work-status-orphan-terminal-projection",
      jobId: record.jobId,
      progressRevision: record.revision,
      target,
    });
    if (!authority.ok) return false;
    const instance =
      prior?.instance ??
      createWorkStatusLifecycleTransitionInstance({
        jobId: record.jobId,
        step: "complete",
        mainTarget: target,
        allowedMainSources: ["in_progress"],
        agentTarget: { kind: "clear" },
        authorityDigest: authority.value,
      });
    if (typeof instance !== "string" && !instance.ok) return false;
    const transitionInstance = typeof instance === "string" ? instance : instance.value;
    const invocation = sha256Digest({
      schemaVersion: 1,
      operation: "work-status-orphan-terminal-projection-invocation",
      jobId: record.jobId,
      transitionInstance,
    });
    if (!invocation.ok) return false;
    const result = await this.dependencies.lifecycle.transitionWhileLockHeld(
      {
        jobId: record.jobId,
        reference,
        holderId: `work-status-orphan:${record.jobId}`,
        mode: "enforce",
        capabilityDigest: checkpoint.capabilityDigest,
        phase: "terminal",
        step: "complete",
        transitionInstance,
        invocationDigest: invocation.value,
        mainTarget: target,
        allowedMainSources: prior?.allowedMainSources ?? ["in_progress"],
        agentTarget: prior?.agentTarget ?? { kind: "clear" },
      },
      lock,
    );
    return result.state === "permitted";
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
