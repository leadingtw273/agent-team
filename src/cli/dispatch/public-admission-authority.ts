import type { SourceControlPort, WorkManagementPort } from "../../application/ports/index.js";
import { parseJobPrLifecycleComment } from "../../application/pipelines/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import type { Issue, Project } from "../../domain/project/index.js";
import { implementerBranch } from "./implementer-request.js";

export interface PublicAdmissionAuthorityOptions {
  readonly project: Project;
  readonly workManagement: Pick<WorkManagementPort, "listComments">;
  readonly sourceControl: Pick<SourceControlPort, "findOpenChangeRequestsByHead">;
}

export type PublicAdmissionDecision = "allowed" | "existing_job_or_pr";

/** External-authority admission guard. A missing local claim is not evidence that the issue has
 * no prior work line: active public Jobs and open deterministic branches both block a new Job. */
export async function checkPublicIssueAdmissionAuthority(
  options: PublicAdmissionAuthorityOptions,
  issue: Issue,
): Promise<Result<PublicAdmissionDecision, DomainError>> {
  const comments = await options.workManagement.listComments({
    project: options.project,
    externalIssueId: issue.externalId,
  });
  if (!comments.ok) return comments;
  const events = comments.value.flatMap((comment) => {
    const event = parseJobPrLifecycleComment(comment.body);
    return event === undefined ? [] : [event];
  });
  if (
    events.some((event) => event.projectId !== options.project.id || event.issueId !== issue.id)
  ) {
    return err(domainError("conflict"));
  }
  const started = new Set(
    events.flatMap((event) => (event.kind === "job_started" ? [event.jobId] : [])),
  );
  const terminal = new Set(
    events.flatMap((event) =>
      event.kind === "job_cancelled" || event.kind === "job_completed"
        ? [event.jobId]
        : event.kind === "job_superseded"
          ? [event.oldJobId]
          : [],
    ),
  );
  if ([...started].some((jobId) => !terminal.has(jobId))) {
    return ok("existing_job_or_pr");
  }
  const referencedJobs = new Set(started);
  for (const event of events) {
    if (event.kind === "pr_bound") referencedJobs.add(event.jobId);
    if (event.kind === "pr_handoff") {
      referencedJobs.add(event.oldJobId);
      referencedJobs.add(event.newJobId);
    }
  }
  for (const jobId of referencedJobs) {
    const open = await options.sourceControl.findOpenChangeRequestsByHead(
      { project: options.project },
      implementerBranch(options.project.id, issue.id, jobId),
    );
    if (!open.ok) return open;
    if (open.value.length > 0) return ok("existing_job_or_pr");
  }
  return ok("allowed");
}
