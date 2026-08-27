import type {
  WorkManagementComment,
  WorkManagementIssueRef,
  WorkManagementPort,
} from "../ports/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import {
  formatJobPrLifecycleComment,
  parseJobPrLifecycleComment,
  type JobPrLifecycleEvent,
} from "./job-pr-authority-model.js";

export interface JobPrLifecyclePublicationRequest {
  readonly issue: WorkManagementIssueRef;
  readonly humanSummary: string;
  readonly event: JobPrLifecycleEvent;
}

export type JobPrLifecyclePublicationOutcome = Readonly<{
  state: "published" | "reused";
  comment: WorkManagementComment;
}>;

export class JobPrLifecyclePublisher {
  constructor(
    readonly workManagement: Pick<WorkManagementPort, "listComments" | "appendComment">,
  ) {}

  async publish(
    request: JobPrLifecyclePublicationRequest,
  ): Promise<Result<JobPrLifecyclePublicationOutcome, DomainError>> {
    const body = formatJobPrLifecycleComment(request.humanSummary, request.event);
    if (!body.ok) return body;
    const prior = await this.workManagement.listComments(request.issue);
    if (!prior.ok) return prior;
    const existing = prior.value.find(
      (comment) => parseJobPrLifecycleComment(comment.body)?.eventId === request.event.eventId,
    );
    if (existing !== undefined) return ok({ state: "reused", comment: existing });

    const appended = await this.workManagement.appendComment(request.issue, body.value, {
      idempotencyKey: `job-pr-lifecycle:${request.event.eventId}`,
    });
    const readBack = await this.workManagement.listComments(request.issue);
    if (!readBack.ok) return readBack;
    const confirmed = readBack.value.find(
      (comment) => parseJobPrLifecycleComment(comment.body)?.eventId === request.event.eventId,
    );
    if (confirmed !== undefined) return ok({ state: "published", comment: confirmed });
    return appended.ok ? err(domainError("external_failure")) : appended;
  }
}
