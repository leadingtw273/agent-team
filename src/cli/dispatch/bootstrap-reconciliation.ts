import type { IssueAdmissionInventoryPort } from "../../adapters/dispatch/issue-admission-store.js";
import type { FileJobProgressStore } from "../../adapters/dispatch/job-progress-store.js";
import type { ResumeJobRepository } from "./resume-composition.js";
import { ok, type DomainError, type Result } from "../../domain/foundation/index.js";
import type { Project } from "../../domain/project/index.js";
import { implementerBranch, implementerWorktreePath } from "./implementer-request.js";

export type BootstrapReconciliationOutcome = Readonly<{
  issueId: string;
  state: "already_converged" | "attached" | "quarantined" | "blocked";
  reason?:
    | "missing_external_issue_id"
    | "job_identity_ambiguous"
    | "progress_write_failed"
    | "attach_failed";
  jobId?: string;
}>;

/**
 * Repairs only already-created Job/claim identities. It never creates a Job, releases a claim, or
 * guesses among multiple matches; ambiguous historical state stays conservatively blocked.
 */
export async function reconcileBootstrapClaims(options: {
  readonly agentTeamHome: string;
  readonly project: Project;
  readonly admission: IssueAdmissionInventoryPort;
  readonly progress: FileJobProgressStore;
  readonly jobs: ResumeJobRepository;
}): Promise<Result<readonly BootstrapReconciliationOutcome[], DomainError>> {
  const claims = await options.admission.listForProject(options.project.id);
  if (!claims.ok) return claims;
  const jobs = await options.jobs.readAll();
  if (!jobs.ok) return jobs;
  const outcomes: BootstrapReconciliationOutcome[] = [];
  for (const claim of claims.value.filter((candidate) => candidate.state === "active")) {
    const matches =
      claim.jobId === undefined
        ? jobs.value.filter(
            (job) => job.projectId === options.project.id && job.issueId === claim.issueId,
          )
        : jobs.value.filter((job) => job.id === claim.jobId && job.issueId === claim.issueId);
    if (matches.length !== 1 || matches[0] === undefined) {
      outcomes.push({
        issueId: claim.issueId,
        state: "blocked",
        reason: "job_identity_ambiguous",
        ...(claim.jobId === undefined ? {} : { jobId: claim.jobId }),
      });
      continue;
    }
    const job = matches[0];
    const existing = await options.progress.load(job.id);
    if (!existing.ok) return existing;
    if (existing.value === undefined) {
      if (claim.externalIssueId === undefined) {
        outcomes.push({
          issueId: claim.issueId,
          jobId: job.id,
          state: "blocked",
          reason: "missing_external_issue_id",
        });
        continue;
      }
      const quarantined = await options.progress.compareAndSwap(job.id, null, {
        jobId: job.id,
        projectId: options.project.id,
        issueId: claim.issueId,
        externalIssueId: claim.externalIssueId,
        model: "unresolved-bootstrap",
        stage: {
          kind: "requires_manual",
          cause: {
            stage: "dispatch",
            reasonCode: "bootstrap_incomplete",
            attempts: { count: 1 },
          },
        },
        branch: implementerBranch(options.project.id, claim.issueId, job.id),
        worktreePath: implementerWorktreePath(options.agentTeamHome, job.id),
      });
      if (!quarantined.ok) {
        outcomes.push({
          issueId: claim.issueId,
          jobId: job.id,
          state: "blocked",
          reason: "progress_write_failed",
        });
        continue;
      }
    }
    if (claim.jobId === job.id) {
      outcomes.push({
        issueId: claim.issueId,
        jobId: job.id,
        state: existing.value === undefined ? "quarantined" : "already_converged",
      });
      continue;
    }
    const attached = await options.admission.attachJob(
      options.project.id,
      claim.issueId,
      claim.revision,
      job.id,
    );
    outcomes.push(
      attached.ok
        ? {
            issueId: claim.issueId,
            jobId: job.id,
            state: existing.value === undefined ? "quarantined" : "attached",
          }
        : { issueId: claim.issueId, jobId: job.id, state: "blocked", reason: "attach_failed" },
    );
  }
  return ok(Object.freeze(outcomes));
}
