import type { AgentRole, Issue, IssueSkillSelection } from "../../domain/project/index.js";
import type { Job } from "../../domain/jobs/index.js";
import { domainError, type DomainError, type Result } from "../../domain/foundation/index.js";
import type { SkillKnowledgeAttachment } from "../ports/provider.js";
import type {
  JobSkillSnapshot,
  JobSkillSnapshotsByRole,
  ProjectSkillPolicy,
  SkillPublicReason,
} from "./model.js";

export interface SkillRuntimeFailure {
  readonly error: DomainError<"invariant_violation">;
  readonly reason: SkillPublicReason;
  readonly skillName?: string;
}

export function skillRuntimeFailure(
  reason: SkillPublicReason,
  skillName?: string,
): SkillRuntimeFailure {
  return Object.freeze({
    error: domainError("invariant_violation"),
    reason,
    ...(skillName === undefined ? {} : { skillName }),
  });
}

export interface SkillRuntimePort {
  admit(
    input: Readonly<{
      job: Job;
      role: AgentRole;
      policy: ProjectSkillPolicy;
      explicit: readonly IssueSkillSelection[];
    }>,
  ): Promise<Result<JobSkillSnapshot, SkillRuntimeFailure>>;

  materialize(
    snapshot: JobSkillSnapshot,
  ): Promise<Result<readonly SkillKnowledgeAttachment[], SkillRuntimeFailure>>;
}

export const skillSnapshotRoles = Object.freeze([
  "implementer",
  "code_reviewer",
  "visual_reviewer",
  "integration_engineer",
] as const satisfies readonly AgentRole[]);

export async function admitJobSkillSnapshots(
  runtime: SkillRuntimePort,
  input: Readonly<{
    job: Job;
    issue: Issue;
    policy: ProjectSkillPolicy;
  }>,
): Promise<Result<JobSkillSnapshotsByRole, SkillRuntimeFailure>> {
  const snapshots: Partial<Record<AgentRole, JobSkillSnapshot>> = {};
  for (const role of skillSnapshotRoles) {
    const admitted = await runtime.admit({
      job: input.job,
      role,
      policy: input.policy,
      explicit: input.issue.skillSelections ?? Object.freeze([]),
    });
    if (!admitted.ok) return admitted;
    snapshots[role] = admitted.value;
  }
  return Object.freeze({ ok: true, value: Object.freeze(snapshots) });
}
