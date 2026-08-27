import { describe, expect, it } from "vitest";

import {
  createJobPrLifecycleEvent,
  formatJobPrLifecycleComment,
} from "../../src/application/pipelines/job-pr-authority-model.js";
import { checkPublicIssueAdmissionAuthority } from "../../src/cli/dispatch/public-admission-authority.js";
import { implementerBranch } from "../../src/cli/dispatch/implementer-request.js";
import {
  ok,
  parseIdentifier,
  parseInstant,
  type Identifier,
} from "../../src/domain/foundation/index.js";
import { issueSchema, projectSchema } from "../../src/domain/project/index.js";

function id<Scope extends string>(scope: Scope, value: string): Identifier<Scope> {
  const parsed = parseIdentifier(scope, value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const projectId = id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const issueId = id("issue", "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const jobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab");
function instant(value: string) {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const createdAt = instant("2026-08-26T12:00:00.000Z");

const project = projectSchema.parse({
  schemaVersion: 1,
  id: projectId,
  displayName: "Sandbox",
  localRepositoryPath: "/tmp/sandbox",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "team-1", projectId: "linear-project" },
  sourceControl: { provider: "github", repository: "owner/sandbox" },
});
const issue = issueSchema.parse({
  schemaVersion: 1,
  id: issueId,
  projectId,
  externalId: "linear-issue-1",
  title: "Prevent duplicate work",
  goal: "Reuse public authority before admitting work.",
  background: "The local claim may be missing after a crash.",
  acceptanceCriteria: ["A second Job is not created."],
  inScope: ["Public admission guard"],
  outOfScope: ["Historical migration"],
  dependencies: { kind: "none" },
  priority: "high",
  agentRole: "implementer",
  reviewRequirement: "code_review",
  estimatedMinutes: 30,
  changeRegions: [{ path: "src/cli/dispatch", coverage: "subtree" }],
});

function lifecycleComment(kind: "job_started" | "job_completed"): string {
  const event =
    kind === "job_started"
      ? createJobPrLifecycleEvent({
          schemaVersion: 1,
          kind,
          projectId,
          issueId,
          jobId,
        })
      : createJobPrLifecycleEvent({
          schemaVersion: 1,
          kind,
          projectId,
          issueId,
          jobId,
          prNumber: 42,
          mergeCommitSha: "b".repeat(40),
        });
  if (!event.ok) throw new Error(event.error.code);
  const body = formatJobPrLifecycleComment("生命週期事件。", event.value);
  if (!body.ok) throw new Error(body.error.code);
  return body.value;
}

function comments(...bodies: readonly string[]) {
  return bodies.map((body, index) => ({
    id: `comment-${String(index + 1)}`,
    body,
    createdAt,
  }));
}

describe("public issue admission authority", () => {
  it("blocks on an active public Job without consulting GitHub", async () => {
    let githubReads = 0;
    const result = await checkPublicIssueAdmissionAuthority(
      {
        project,
        workManagement: {
          listComments: () => Promise.resolve(ok(comments(lifecycleComment("job_started")))),
        },
        sourceControl: {
          findOpenChangeRequestsByHead: () => {
            githubReads += 1;
            return Promise.resolve(ok([]));
          },
        },
      },
      issue,
    );

    expect(result).toEqual({ ok: true, value: "existing_job_or_pr" });
    expect(githubReads).toBe(0);
  });

  it("blocks when a terminal public Job still has an open deterministic-head PR", async () => {
    const expectedBranch = implementerBranch(projectId, issueId, jobId);
    const observedBranches: string[] = [];
    const result = await checkPublicIssueAdmissionAuthority(
      {
        project,
        workManagement: {
          listComments: () =>
            Promise.resolve(
              ok(comments(lifecycleComment("job_started"), lifecycleComment("job_completed"))),
            ),
        },
        sourceControl: {
          findOpenChangeRequestsByHead: (_repository, branch) => {
            observedBranches.push(branch);
            return Promise.resolve(ok([{ number: 42 }] as never));
          },
        },
      },
      issue,
    );

    expect(result).toEqual({ ok: true, value: "existing_job_or_pr" });
    expect(observedBranches).toEqual([expectedBranch]);
  });

  it("allows a terminal public Job only after its deterministic head has no open PR", async () => {
    const result = await checkPublicIssueAdmissionAuthority(
      {
        project,
        workManagement: {
          listComments: () =>
            Promise.resolve(
              ok(comments(lifecycleComment("job_started"), lifecycleComment("job_completed"))),
            ),
        },
        sourceControl: {
          findOpenChangeRequestsByHead: () => Promise.resolve(ok([])),
        },
      },
      issue,
    );

    expect(result).toEqual({ ok: true, value: "allowed" });
  });
});
