import { describe, expect, it } from "vitest";

import {
  ok,
  parseIdentifier,
  parseInstant,
  type Identifier,
} from "../../src/domain/foundation/index.js";
import { issueSchema, projectSchema } from "../../src/domain/project/index.js";
import { createAgentCondition } from "../../src/domain/workflow/index.js";
import { WorkStatusOrphanCoordinator } from "../../src/cli/dispatch/work-status-orphan-coordinator.js";

function id<Scope extends string>(scope: Scope, value: string): Identifier<Scope> {
  const parsed = parseIdentifier(scope, value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}
const parsedNow = parseInstant("2026-08-18T01:00:00.000Z");
if (!parsedNow.ok) throw new Error(parsedNow.error.code);
const now = parsedNow.value;
const project = projectSchema.parse({
  schemaVersion: 1,
  id: id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab"),
  displayName: "Sandbox",
  localRepositoryPath: "/tmp/sandbox",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "team-1", projectId: "linear-project" },
  sourceControl: { provider: "github", repository: "owner/sandbox" },
});

function issue(index: number, agent: boolean) {
  return issueSchema.parse({
    schemaVersion: 1,
    id: id("issue", `issue_018f47d2-77a4-7cc1-8ef2-01234567890${String(index)}`),
    projectId: project.id,
    externalId: `linear-${String(index)}`,
    title: `Issue ${String(index)}`,
    ...(agent ? { agentRole: "implementer" as const } : {}),
  });
}

function snapshot(item: ReturnType<typeof issue>, executing = false) {
  return {
    issue: item,
    workStatus: "in_progress" as const,
    ...(executing ? { agentCondition: createAgentCondition("executing") } : {}),
    updatedAt: now,
    revision: `revision-${item.externalId}`,
  };
}

describe("work-status orphan quarantine", () => {
  it("quarantines only the true automation-owned orphan", async () => {
    const human = snapshot(issue(1, false));
    const active = snapshot(issue(2, true), true);
    const residue = snapshot(issue(3, true), true);
    const orphan = snapshot(issue(4, true), true);
    const labelOnly = snapshot(issue(5, true), true);
    let getCalls = 0;
    let statusCalls = 0;
    let conditionCalls = 0;
    let commentCalls = 0;
    let terminalProjectionCalls = 0;
    const statuses = new Map<string, "in_progress" | "requires_manual" | "completed">([
      [residue.issue.externalId, "in_progress"],
      [orphan.issue.externalId, "in_progress"],
    ]);
    const workManagement = {
      listIssues: () => Promise.resolve(ok([human, active, residue, orphan, labelOnly])),
      getIssue: (reference: { externalIssueId: string }) => {
        getCalls += 1;
        const source = reference.externalIssueId === residue.issue.externalId ? residue : orphan;
        return Promise.resolve(
          ok({
            ...source,
            workStatus: statuses.get(reference.externalIssueId) ?? "in_progress",
          }),
        );
      },
      setWorkStatus: (reference: { externalIssueId: string }, status: "requires_manual") => {
        statusCalls += 1;
        statuses.set(reference.externalIssueId, status);
        return Promise.resolve(ok({ ...orphan, workStatus: status }));
      },
      setAgentCondition: (
        _reference: unknown,
        condition: ReturnType<typeof createAgentCondition>,
      ) => {
        conditionCalls += 1;
        return Promise.resolve(
          ok({
            ...orphan,
            workStatus: statuses.get(orphan.issue.externalId) ?? "in_progress",
            agentCondition: condition,
          }),
        );
      },
      appendComment: (_reference: unknown, body: string) => {
        commentCalls += 1;
        return Promise.resolve(ok({ id: "comment-1", body, createdAt: now }));
      },
    };
    const activeJob = "job_018f47d2-77a4-7cc1-8ef2-012345678902";
    const residueJob = "job_018f47d2-77a4-7cc1-8ef2-012345678903";
    const coordinator = new WorkStatusOrphanCoordinator({
      project,
      workManagement,
      progress: {
        listAll: () =>
          Promise.resolve(
            ok([
              {
                projectId: project.id,
                externalIssueId: active.issue.externalId,
                jobId: activeJob,
                stage: { kind: "awaiting_review" },
              },
              {
                projectId: project.id,
                externalIssueId: residue.issue.externalId,
                jobId: residueJob,
                revision: 1,
                stage: { kind: "completed" },
                workStatusLifecycle: {
                  admissionMode: "enforce",
                  capabilityDigest: "a".repeat(64),
                  transitions: [{ step: "work_start", main: { state: "confirmed" } }],
                },
              },
              {
                projectId: project.id,
                externalIssueId: orphan.issue.externalId,
                jobId: "job_018f47d2-77a4-7cc1-8ef2-012345678904",
                stage: { kind: "requires_manual" },
                workStatusLifecycle: { admissionMode: "enforce", transitions: [] },
              },
            ] as never),
          ),
      },
      admission: {
        listForProject: () =>
          Promise.resolve(
            ok([
              {
                state: "active",
                externalIssueId: active.issue.externalId,
                jobId: activeJob,
              },
            ] as never),
          ),
      } as never,
      locks: {
        acquire: (_scope: unknown, holderId: string) =>
          Promise.resolve(
            ok({
              scopeDigest: "b".repeat(64),
              holderId,
              release: () => Promise.resolve(ok(undefined)),
            }),
          ),
      },
      lifecycle: {
        transitionWhileLockHeld: () => {
          terminalProjectionCalls += 1;
          statuses.set(residue.issue.externalId, "completed");
          return Promise.resolve({
            state: "permitted" as const,
            mode: "enforce" as const,
            main: "confirmed" as const,
            agent: "confirmed" as const,
          });
        },
      },
    });

    await expect(coordinator.scan()).resolves.toEqual({
      projectId: project.id,
      inspected: 5,
      humanOwned: 2,
      activeManaged: 1,
      terminalResidue: 1,
      quarantined: 1,
      blocked: 0,
    });
    expect(getCalls).toBe(2);
    expect(statusCalls).toBe(1);
    expect(conditionCalls).toBe(1);
    expect(commentCalls).toBe(1);
    expect(terminalProjectionCalls).toBe(1);
    expect(statuses.get(residue.issue.externalId)).toBe("completed");
    expect(statuses.get(orphan.issue.externalId)).toBe("requires_manual");
  });
});
