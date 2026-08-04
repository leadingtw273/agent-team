import type { ReadOptions } from "../../application/ports/common.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Instant,
  type Result,
} from "../../domain/foundation/index.js";
import type { AgentCondition, WorkStatus } from "../../domain/workflow/index.js";
import type { LinearIssueSnapshot, LinearProjectContext } from "./model.js";

export interface LinearReconcileReader {
  readIssue(
    context: LinearProjectContext,
    issueId: string,
  ): Promise<Result<LinearIssueSnapshot, DomainError>>;
}

export interface LocalLinearObservation {
  readonly workStatus: WorkStatus;
  readonly agentCondition?: AgentCondition;
  readonly updatedAt?: Instant;
}

export type LinearReconcileFinding =
  | {
      readonly kind: "work_status_changed";
      readonly previous: WorkStatus;
      readonly current: WorkStatus;
    }
  | {
      readonly kind: "agent_condition_changed";
      readonly previous?: AgentCondition;
      readonly current?: AgentCondition;
    }
  | {
      readonly kind: "issue_revision_changed";
      readonly previous: Instant;
      readonly current: Instant;
    };

export interface LinearReconcileSnapshot {
  readonly provider: "linear";
  readonly issue: LinearIssueSnapshot;
  readonly findings: readonly LinearReconcileFinding[];
}

function sameAgentCondition(
  left: AgentCondition | undefined,
  right: AgentCondition | undefined,
): boolean {
  return (
    left?.status === right?.status &&
    (left?.blockingReasons.length ?? 0) === (right?.blockingReasons.length ?? 0) &&
    (left?.blockingReasons.every((reason) => right?.blockingReasons.includes(reason)) ?? true)
  );
}

export class LinearReconcileAdapter {
  constructor(readonly reader: LinearReconcileReader) {}

  async readBack(
    context: LinearProjectContext,
    issueId: string,
    local: LocalLinearObservation,
    options: ReadOptions = {},
  ): Promise<Result<LinearReconcileSnapshot, DomainError>> {
    if (options.signal?.aborted === true) return err(domainError("interrupted"));
    if (issueId.trim().length === 0 || issueId.length > 255) {
      return err(domainError("external_failure"));
    }
    const issue = await this.reader.readIssue(context, issueId);
    if (!issue.ok) return issue;
    const findings: LinearReconcileFinding[] = [];
    if (local.workStatus !== issue.value.workStatus) {
      findings.push({
        kind: "work_status_changed",
        previous: local.workStatus,
        current: issue.value.workStatus,
      });
    }
    if (!sameAgentCondition(local.agentCondition, issue.value.agentCondition)) {
      findings.push({
        kind: "agent_condition_changed",
        ...(local.agentCondition === undefined ? {} : { previous: local.agentCondition }),
        ...(issue.value.agentCondition === undefined
          ? {}
          : { current: issue.value.agentCondition }),
      });
    }
    if (local.updatedAt !== undefined && local.updatedAt !== issue.value.updatedAt) {
      findings.push({
        kind: "issue_revision_changed",
        previous: local.updatedAt,
        current: issue.value.updatedAt,
      });
    }
    return ok(
      Object.freeze({
        provider: "linear" as const,
        issue: issue.value,
        findings: Object.freeze(findings),
      }),
    );
  }
}
