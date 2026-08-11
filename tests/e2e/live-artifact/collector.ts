import { createDiffDigest } from "../../../src/domain/review/diff.js";
import type { GhTransport } from "../../../src/adapters/github/transport.js";
import { z } from "zod";
import { readProductionLocalAuthority } from "./local-authority.js";
import { readBoundReviewerIdentity } from "./reviewer.js";
import {
  digestIdentifier,
  firstSandboxLiveArtifactSchema,
  rawGitObservationSchema,
  rawGithubObservationSchema,
  rawLinearObservationSchema,
  safeAuthorityRead,
  timelineKinds,
  type Authority,
  type AuthorityRead,
  type FirstSandboxLiveArtifact,
  type GitEvidence,
  type GithubEvidence,
  type LinearEvidence,
  type MissingReasonCode,
} from "./schema.js";

export type CollectProductionLiveArtifactInput = Readonly<{
  provenance: Omit<FirstSandboxLiveArtifact["provenance"], "capturedAt">;
  projectId: string;
  expectedLinearIssueId: string;
  expectedCanaryJobId: string;
  repository: string;
  pullRequestNumber: number;
  agentTeamHome: string;
}>;

export type ExternalAuthorityPorts = Readonly<{
  linear: { read(input: CollectProductionLiveArtifactInput): Promise<unknown> };
  github: { read(input: CollectProductionLiveArtifactInput): Promise<unknown> };
  git: { read(input: CollectProductionLiveArtifactInput): Promise<unknown> };
  githubComments: Pick<GhTransport, "requestJson">;
}>;

function missing<Value>(reasonCode: MissingReasonCode): Authority<Value> {
  return { status: "missing", reasonCode };
}
function projectLinear(
  read: AuthorityRead<z.infer<typeof rawLinearObservationSchema>>,
  expectedLinearIssueId: string,
): Authority<LinearEvidence> {
  if (read.state === "missing") return missing(read.reasonCode);
  if (read.value.issues.length !== 1)
    return missing(read.value.issues.length === 0 ? "not_found" : "duplicate_result");
  const issue = read.value.issues[0];
  if (issue?.id !== expectedLinearIssueId || issue.workStatus !== "completed") {
    return missing("binding_missing");
  }
  const grouped = new Map<string, string[]>();
  for (const event of issue.timeline) {
    if (!timelineKinds.some((kind) => kind === event.marker)) return missing("parse_failed");
    grouped.set(event.marker, [...(grouped.get(event.marker) ?? []), event.occurredAt]);
  }
  const timeline = timelineKinds.map((kind) => ({
    kind,
    occurredAt: grouped.get(kind)?.[0] ?? "",
    count: grouped.get(kind)?.length ?? 0,
  }));
  const parsed = firstSandboxLiveArtifactSchema.shape.authorities.shape.linear.safeParse({
    status: "present",
    evidence: {
      issueAlias: "issue-1",
      issueCount: 1,
      workStatus: "completed",
      updatedAt: issue.updatedAt,
      timeline,
    },
  });
  return parsed.success && parsed.data.status === "present" ? parsed.data : missing("parse_failed");
}
function projectGit(
  read: AuthorityRead<z.infer<typeof rawGitObservationSchema>>,
): Authority<GitEvidence> {
  if (read.state === "missing") return missing(read.reasonCode);
  const diff = createDiffDigest(read.value.changes);
  if (!diff.ok) return missing("parse_failed");
  const parsed = firstSandboxLiveArtifactSchema.shape.authorities.shape.git.safeParse({
    status: "present",
    evidence: {
      baseDigest: digestIdentifier("git-base", read.value.baseSha),
      headDigest: digestIdentifier("github-head", read.value.headSha),
      effectiveDiffDigest: diff.value,
    },
  });
  return parsed.success && parsed.data.status === "present" ? parsed.data : missing("parse_failed");
}
async function projectGithub(
  read: AuthorityRead<z.infer<typeof rawGithubObservationSchema>>,
  input: CollectProductionLiveArtifactInput,
  comments: Pick<GhTransport, "requestJson">,
): Promise<Authority<GithubEvidence>> {
  if (read.state === "missing") return missing(read.reasonCode);
  if (read.value.pullRequests.length !== 1)
    return missing(read.value.pullRequests.length === 0 ? "not_found" : "duplicate_result");
  const pr = read.value.pullRequests[0];
  if (pr?.state !== "merged" || pr.number !== input.pullRequestNumber)
    return missing("binding_missing");
  const reviewer = await readBoundReviewerIdentity(comments, {
    repository: input.repository,
    pullRequestNumber: input.pullRequestNumber,
    github: read.value,
  });
  if (reviewer.status === "missing") return missing(reviewer.reasonCode);
  const checks = pr.checks
    .filter((check) => check.name === "CI")
    .map((check) => ({
      name: check.name,
      status: check.status,
      conclusion: check.conclusion,
      headDigest: digestIdentifier("github-head", check.headSha),
    }));
  const statuses = pr.statuses.filter(
    (status) =>
      status.context === "agent-team/review" &&
      status.state === "success" &&
      status.headSha === pr.headSha &&
      status.targetUrl !== null,
  );
  if (statuses.length !== 1)
    return missing(statuses.length === 0 ? "binding_missing" : "duplicate_result");
  const status = statuses[0];
  if (status === undefined) return missing("binding_missing");
  const headDigest = digestIdentifier("github-head", pr.headSha);
  const parsed = firstSandboxLiveArtifactSchema.shape.authorities.shape.github.safeParse({
    status: "present",
    evidence: {
      pullRequestAlias: "pr-1",
      pullRequestCount: 1,
      state: "merged",
      headDigest,
      checks,
      reviewStatus: {
        context: "agent-team/review",
        state: "success",
        headDigest: digestIdentifier("github-head", status.headSha),
      },
      reviewer: reviewer.evidence,
      merge: { state: "merged", headDigest, observedAt: pr.mergedAt },
    },
  });
  return parsed.success && parsed.data.status === "present" ? parsed.data : missing("parse_failed");
}

export async function collectProductionLiveArtifact(
  input: CollectProductionLiveArtifactInput,
  ports: ExternalAuthorityPorts,
): Promise<FirstSandboxLiveArtifact> {
  // Defer every invocation to a separate microtask. A synchronous adapter fault must not stop
  // the other three independent read attempts from being started.
  const linearRead = safeAuthorityRead(
    rawLinearObservationSchema,
    Promise.resolve().then(() => ports.linear.read(input)),
  );
  const githubRead = safeAuthorityRead(
    rawGithubObservationSchema,
    Promise.resolve().then(() => ports.github.read(input)),
  );
  const gitRead = safeAuthorityRead(
    rawGitObservationSchema,
    Promise.resolve().then(() => ports.git.read(input)),
  );
  const localRead = Promise.resolve().then(() => readProductionLocalAuthority(input));
  const [linear, github, git, local] = await Promise.all([
    linearRead,
    githubRead,
    gitRead,
    localRead,
  ]);
  const capturedAt = new Date().toISOString();
  return firstSandboxLiveArtifactSchema.parse({
    schemaVersion: 1,
    kind: "first_sandbox_live_artifact",
    provenance: { ...input.provenance, capturedAt },
    authorities: {
      linear: projectLinear(linear, input.expectedLinearIssueId),
      github: await projectGithub(github, input, ports.githubComments),
      local,
      git: projectGit(git),
    },
  });
}
