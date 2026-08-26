import type { JobProgressRecord } from "../../adapters/dispatch/job-progress-store.js";
import type {
  SourceControlPort,
  WorkManagementPort,
} from "../../application/ports/index.js";
import {
  parseJobPrLifecycleComment,
  parsePullRequestBackPointer,
  projectPullRequestAuthority,
} from "../../application/pipelines/index.js";
import { domainError, err, ok, type DomainError, type Result } from "../../domain/foundation/index.js";
import type { Project } from "../../domain/project/index.js";
import type { ManagedMutationRequest } from "./managed-mutation-authority.js";

export interface JobPrAuthorityValidatorOptions {
  readonly project: Project;
  readonly workManagement: Pick<WorkManagementPort, "getIssue" | "listComments">;
  readonly sourceControl: Pick<
    SourceControlPort,
    "getChangeRequest" | "findOpenChangeRequestsByHead"
  >;
  readonly mode?: "active" | "cancellation" | "completion" | "supersede";
  readonly supersededByJobId?: string;
}

function requestedLifecycleEvent(request: ManagedMutationRequest) {
  if (request.intent !== "linear_lifecycle" || typeof request.identity !== "object" || request.identity === null) {
    return undefined;
  }
  const body = (request.identity as Readonly<Record<string, unknown>>)["body"];
  return typeof body === "string" ? parseJobPrLifecycleComment(body) : undefined;
}

function isSafeConflictCondition(request: ManagedMutationRequest, record: JobProgressRecord): boolean {
  if (request.intent !== "linear_agent_condition" || typeof request.identity !== "object" || request.identity === null) {
    return false;
  }
  const identity = request.identity as Readonly<Record<string, unknown>>;
  const condition = identity["condition"];
  if (typeof condition !== "object" || condition === null) return false;
  const value = condition as Readonly<Record<string, unknown>>;
  return (
    identity["externalIssueId"] === record.externalIssueId &&
    value["status"] === "blocked" &&
    Array.isArray(value["blockingReasons"]) &&
    value["blockingReasons"].length === 1 &&
    value["blockingReasons"][0] === "integration_failure"
  );
}

/** Builds the provider read-back half of the shared mutation fence. It never mutates either
 * provider; callers still need the durable local CAS gate around the actual provider operation. */
export function createJobPrAuthorityValidator(options: JobPrAuthorityValidatorOptions) {
  return async (
    record: JobProgressRecord,
    request: ManagedMutationRequest,
  ): Promise<Result<void, DomainError>> => {
    const reference = { project: options.project, externalIssueId: record.externalIssueId };
    const [issue, comments] = await Promise.all([
      options.workManagement.getIssue(reference),
      options.workManagement.listComments(reference),
    ]);
    if (!issue.ok) return issue;
    if (!comments.ok) return comments;
    if (
      issue.value.issue.id !== record.issueId ||
      issue.value.issue.projectId !== record.projectId ||
      issue.value.issue.externalId !== record.externalIssueId
    ) {
      return err(domainError("conflict"));
    }
    const requestedEvent = requestedLifecycleEvent(request);
    if (
      requestedEvent?.kind === "authority_conflict" &&
      requestedEvent.projectId === record.projectId &&
      requestedEvent.issueId === record.issueId &&
      requestedEvent.jobId === record.jobId
    ) {
      return ok(undefined);
    }
    if (isSafeConflictCondition(request, record)) return ok(undefined);
    if (issue.value.archivedAt !== undefined || issue.value.trashed === true) {
      return err(domainError("conflict"));
    }
    const mode = options.mode ?? "active";
    if (
      (mode === "active" && issue.value.workStatus === "canceled") ||
      (mode === "active" &&
        issue.value.workStatus === "completed" &&
        request.intent !== "linear_lifecycle") ||
      (mode === "cancellation" && issue.value.workStatus !== "canceled") ||
      (mode === "completion" && issue.value.workStatus !== "completed") ||
      (mode === "supersede" && ["canceled", "completed"].includes(issue.value.workStatus))
    ) {
      return err(domainError("permission_denied"));
    }

    const events = comments.value.flatMap((comment) => {
      const event = parseJobPrLifecycleComment(comment.body);
      return event === undefined ? [] : [event];
    });
    const terminalJobIds = new Set(
      events.flatMap((event) =>
        event.kind === "job_cancelled" || event.kind === "job_completed"
          ? [event.jobId]
          : event.kind === "job_superseded"
            ? [event.oldJobId]
            : [],
      ),
    );
    const activeStartedJobs = new Set(
      events
        .filter((event) => event.kind === "job_started" && !terminalJobIds.has(event.jobId))
        .map((event) => (event.kind === "job_started" ? event.jobId : record.jobId)),
    );
    const startingThisJob =
      requestedEvent?.kind === "job_started" && requestedEvent.jobId === record.jobId;
    if (requestedEvent?.kind === "job_started") {
      return startingThisJob &&
        requestedEvent.projectId === record.projectId &&
        requestedEvent.issueId === record.issueId &&
        !terminalJobIds.has(record.jobId) &&
        activeStartedJobs.size === 0
        ? ok(undefined)
        : err(domainError("conflict"));
    }
    if (record.changeRequestId === undefined) {
      const reverse = await options.sourceControl.findOpenChangeRequestsByHead(
        { project: options.project },
        record.branch,
      );
      if (!reverse.ok) return reverse;
      if (reverse.value.length !== 0) return err(domainError("conflict"));
      if (
        requestedEvent !== undefined &&
        (requestedEvent.projectId !== record.projectId ||
          requestedEvent.issueId !== record.issueId ||
          ("jobId" in requestedEvent && requestedEvent.jobId !== record.jobId))
      ) {
        return err(domainError("conflict"));
      }
      if (
        requestedEvent?.kind === "pr_handoff" ||
        (requestedEvent?.kind === "job_superseded" &&
          (mode !== "supersede" ||
            requestedEvent.oldJobId !== record.jobId ||
            requestedEvent.newJobId !== options.supersededByJobId))
      ) {
        return err(domainError("conflict"));
      }
      if (
        activeStartedJobs.size > (activeStartedJobs.has(record.jobId) ? 1 : 0) ||
        (!activeStartedJobs.has(record.jobId) && !startingThisJob)
      ) {
        return err(domainError("conflict"));
      }
      return ok(undefined);
    }

    const changeRequest = await options.sourceControl.getChangeRequest({
      project: options.project,
      changeRequestId: record.changeRequestId,
    });
    if (!changeRequest.ok) return changeRequest;
    if (
      changeRequest.value.headBranch !== record.branch ||
      (record.headSha !== undefined && changeRequest.value.headSha !== record.headSha)
    ) {
      return err(domainError("conflict"));
    }
    const pointer = parsePullRequestBackPointer(changeRequest.value.body ?? "");
    const pointerValue = pointer.ok ? pointer.value : undefined;
    if (
      !pointer.ok ||
      pointerValue?.projectId !== record.projectId ||
      pointerValue.issueId !== record.issueId ||
      pointerValue.branch !== record.branch
    ) {
      return err(domainError("conflict"));
    }
    const projection = projectPullRequestAuthority(events, changeRequest.value.number);
    if (record.controlFence?.ownershipEpoch === 0) {
      return requestedEvent?.kind === "pr_bound" &&
        pointerValue.jobId === record.jobId &&
        requestedEvent.jobId === record.jobId &&
        requestedEvent.prNumber === changeRequest.value.number &&
        requestedEvent.branch === record.branch &&
        requestedEvent.initialHeadSha === changeRequest.value.headSha &&
        requestedEvent.ownershipEpoch === 1 &&
        projection.state === "none"
        ? ok(undefined)
        : err(domainError("conflict"));
    }
    const ownershipEpoch = record.controlFence?.ownershipEpoch;
    if (ownershipEpoch === undefined) return err(domainError("conflict"));
    if (
      requestedEvent?.kind === "pr_handoff"
        ? requestedEvent.oldJobId !== record.jobId ||
          requestedEvent.newJobId !== options.supersededByJobId ||
          requestedEvent.prNumber !== changeRequest.value.number ||
          requestedEvent.priorOwnershipEpoch !== ownershipEpoch ||
          requestedEvent.ownershipEpoch !== ownershipEpoch + 1 ||
          requestedEvent.handoffHeadSha !== changeRequest.value.headSha ||
          projection.state !== "owned" ||
          projection.ownerJobId !== record.jobId
        : requestedEvent?.kind === "job_superseded"
          ? mode !== "supersede" ||
            requestedEvent.oldJobId !== record.jobId ||
            requestedEvent.newJobId !== options.supersededByJobId ||
            projection.state !== "owned" ||
            projection.ownerJobId !== options.supersededByJobId ||
            projection.ownershipEpoch !== ownershipEpoch
          : projection.state !== "owned" ||
            projection.ownerJobId !== record.jobId ||
            projection.ownershipEpoch !== ownershipEpoch
    ) {
      return err(domainError("conflict"));
    }
    return ok(undefined);
  };
}
