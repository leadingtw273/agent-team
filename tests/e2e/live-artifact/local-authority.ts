import { isAbsolute, join } from "node:path";

import {
  FileJobProgressStore,
  jobProgressRecordSchema,
} from "../../../src/adapters/dispatch/job-progress-store.js";
import { jobSchema } from "../../../src/domain/jobs/index.js";
import { FileJobRepository } from "../../../src/infrastructure/jobs/file-repository.js";
import { createProjectReadModel } from "../../../src/cli/project/index.js";
import { projectDetailPayloadSchema } from "../../../src/cli/project/schema.js";
import { hasSafeDataShape } from "./boundary.js";
import type { Authority, LocalEvidence, MissingReasonCode } from "./schema.js";

export interface LocalAuthorityInput {
  readonly projectId: string;
  readonly expectedLinearIssueId: string;
  readonly expectedCanaryJobId: string;
  readonly agentTeamHome: string;
}

function missing(reasonCode: MissingReasonCode): Authority<LocalEvidence> {
  return { status: "missing", reasonCode };
}

export async function readProductionLocalAuthority(
  input: LocalAuthorityInput,
): Promise<Authority<LocalEvidence>> {
  if (
    !isAbsolute(input.agentTeamHome) ||
    input.projectId.trim().length === 0 ||
    input.expectedLinearIssueId.trim().length === 0 ||
    input.expectedCanaryJobId.trim().length === 0
  ) {
    return missing("parse_failed");
  }
  const stateRoot = join(input.agentTeamHome, "state");
  try {
    const model = createProjectReadModel({ agentTeamHome: input.agentTeamHome });
    const detail = await model.read({ projectId: input.projectId });
    if (detail.state !== "success" || !hasSafeDataShape(detail.payload))
      return missing("read_failed");
    const payload = projectDetailPayloadSchema.safeParse(detail.payload);
    if (!payload.success) return missing("parse_failed");
    const jobsStore = new FileJobRepository(
      join(stateRoot, "jobs.json"),
      join(stateRoot, "jobs.lock"),
    );
    const progressStore = new FileJobProgressStore(join(stateRoot, "dispatch", "progress"));
    const [allJobs, expectedProgress, projectProgress] = await Promise.all([
      jobsStore.readAll(),
      progressStore.load(input.expectedCanaryJobId),
      progressStore.listForProject(input.projectId),
    ]);
    if (!allJobs.ok || !expectedProgress.ok || !projectProgress.ok) return missing("read_failed");
    if (expectedProgress.value === undefined) return missing("not_found");
    if (
      !hasSafeDataShape(expectedProgress.value) ||
      !hasSafeDataShape(allJobs.value) ||
      !hasSafeDataShape(projectProgress.value)
    )
      return missing("parse_failed");
    const progress = jobProgressRecordSchema.safeParse(expectedProgress.value);
    const jobs = allJobs.value.map((job) => jobSchema.safeParse(job));
    const projectRecords = projectProgress.value.map((record) =>
      jobProgressRecordSchema.safeParse(record),
    );
    if (
      !progress.success ||
      jobs.some((item) => !item.success) ||
      projectRecords.some((item) => !item.success)
    )
      return missing("parse_failed");
    const expectedJobs = jobs.filter(
      (item) => item.success && item.data.id === input.expectedCanaryJobId,
    );
    if (expectedJobs.length !== 1)
      return missing(expectedJobs.length === 0 ? "not_found" : "duplicate_result");
    const job = expectedJobs[0];
    if (!job?.success) return missing("parse_failed");
    if (
      job.data.projectId !== input.projectId ||
      progress.data.jobId !== input.expectedCanaryJobId ||
      progress.data.projectId !== input.projectId
    )
      return missing("binding_missing");
    if (
      job.data.issueId !== progress.data.issueId ||
      progress.data.externalIssueId !== input.expectedLinearIssueId
    )
      return missing("binding_missing");
    const jobsForIssue = jobs.filter(
      (item) =>
        item.success &&
        item.data.projectId === input.projectId &&
        item.data.issueId === job.data.issueId,
    );
    const progressForIssue = projectRecords.filter(
      (item) => item.success && item.data.issueId === job.data.issueId,
    );
    if (jobsForIssue.length !== 1 || progressForIssue.length !== 1)
      return missing("duplicate_result");
    if (progress.data.stage.kind !== "completed") return missing("binding_missing");
    const project = payload.data.project;
    if (project.progress.state !== "available" || project.leases.state !== "available")
      return missing("authority_unavailable");
    return {
      status: "present",
      evidence: {
        jobAlias: "job-1",
        issueAlias: "issue-1",
        jobsForIssue: jobsForIssue.length,
        exactJob: { stage: "completed", updatedAt: progress.data.updatedAt },
        projectProgress: {
          state: "available",
          resumable: project.progress.counts.resumable,
          blocked: project.progress.counts.blocked,
          nonTerminal: project.progress.nonTerminal.length,
        },
        leases: {
          state: "available",
          active: project.leases.counts.active,
          expired: project.leases.counts.expired,
          observedAt: project.leases.observedAt,
        },
      },
    };
  } catch {
    return missing("read_failed");
  }
}
