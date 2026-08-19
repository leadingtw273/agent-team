import { describe, expect, it, vi } from "vitest";

import {
  domainError,
  err,
  ok,
  parseIdentifier,
  parseInstant,
  type Identifier,
} from "../../src/domain/foundation/index.js";
import { issueSchema, projectSchema } from "../../src/domain/project/index.js";
import { createAgentCondition } from "../../src/domain/workflow/index.js";
import { WorkStatusOrphanCoordinator } from "../../src/cli/dispatch/work-status-orphan-coordinator.js";
import {
  latestConfirmedActiveWorkStatus,
  mayProjectRequiresManual,
} from "../../src/cli/dispatch/requires-manual-projection.js";
import type { WorkStatusLifecycleRequest } from "../../src/application/pipelines/index.js";

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
  it("projects only the exact eligible Job and never enumerates another Linear issue", async () => {
    const item = issue(8, true);
    const jobId = "job_018f47d2-77a4-7cc1-8ef2-012345678908";
    const record = {
      projectId: project.id,
      issueId: item.id,
      externalIssueId: item.externalId,
      jobId,
      revision: 7,
      stage: {
        kind: "requires_manual",
        cause: {
          stage: "ci_recovery",
          reasonCode: "ci_recovery_paused",
          attempts: { count: 1 },
        },
      },
      workStatusLifecycle: {
        admissionMode: "enforce",
        capabilityDigest: "a".repeat(64),
        transitions: [
          { step: "work_start", mainTarget: "in_progress", main: { state: "confirmed" } },
        ],
      },
    } as never;
    const claim = {
      state: "active",
      projectId: project.id,
      issueId: item.id,
      externalIssueId: item.externalId,
      jobId,
      revision: 1,
    } as never;
    const listIssues = vi.fn();
    const transitionWhileLockHeld = vi.fn(() =>
      Promise.resolve({
        state: "permitted" as const,
        mode: "enforce" as const,
        main: "confirmed" as const,
        agent: "confirmed" as const,
      }),
    );
    const coordinator = new WorkStatusOrphanCoordinator({
      project,
      workManagement: {
        listIssues,
        getIssue: () => Promise.resolve(ok(snapshot(item, true))),
        setWorkStatus: () => Promise.resolve(err(domainError("invariant_violation"))),
        setAgentCondition: () => Promise.resolve(err(domainError("invariant_violation"))),
        appendComment: (_reference, body) =>
          Promise.resolve(ok({ id: "comment-1", body, createdAt: now })),
      },
      progress: {
        listAll: () => Promise.resolve(ok([record])),
        load: () => Promise.resolve(ok(record)),
      },
      admission: {
        listForProject: vi.fn(),
        load: () => Promise.resolve(ok(claim)),
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
      lifecycle: { transitionWhileLockHeld },
    });

    await expect(coordinator.reconcileJob(record)).resolves.toEqual({
      state: "completed",
      projectId: project.id,
      jobId,
    });
    expect(listIssues).not.toHaveBeenCalled();
    expect(transitionWhileLockHeld).toHaveBeenCalledTimes(1);
    expect(transitionWhileLockHeld).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId,
        step: "requires_manual",
        mainTarget: "requires_manual",
      }),
      expect.objectContaining({ holderId: `work-status-orphan:${jobId}` }),
    );
  });

  it("does zero mutation when the exact Job is not an eligible manual handoff", async () => {
    const item = issue(8, true);
    const record = {
      projectId: project.id,
      issueId: item.id,
      externalIssueId: item.externalId,
      jobId: "job_018f47d2-77a4-7cc1-8ef2-012345678908",
      revision: 1,
      stage: { kind: "implementing" },
    } as never;
    const getIssue = vi.fn();
    const acquire = vi.fn();
    const transitionWhileLockHeld = vi.fn();
    const coordinator = new WorkStatusOrphanCoordinator({
      project,
      workManagement: {
        listIssues: vi.fn(),
        getIssue,
        setWorkStatus: vi.fn(),
        setAgentCondition: vi.fn(),
        appendComment: vi.fn(),
      },
      progress: { listAll: vi.fn(), load: vi.fn() },
      admission: { listForProject: vi.fn(), load: vi.fn() } as never,
      locks: { acquire },
      lifecycle: { transitionWhileLockHeld },
    });

    await expect(coordinator.reconcileJob(record)).resolves.toMatchObject({
      state: "blocked",
      reason: "job_not_reconcilable",
    });
    expect(getIssue).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(transitionWhileLockHeld).not.toHaveBeenCalled();
  });

  it("quarantines only the true automation-owned orphan", async () => {
    const human = snapshot(issue(1, false));
    const active = snapshot(issue(2, true), true);
    const residue = {
      ...snapshot(issue(3, true), true),
      workStatus: "in_review" as const,
    };
    const orphan = {
      ...snapshot(issue(4, true), true),
      workStatus: "in_review" as const,
    };
    const labelOnly = snapshot(issue(5, true), true);
    const manualResidue = snapshot(issue(6, true), true);
    const staleManual = snapshot(issue(7, true), true);
    const autoReentry = {
      ...snapshot(issue(9, true), true),
      workStatus: "in_review" as const,
    };
    const racingCompleted = snapshot(issue(0, true), true);
    let getCalls = 0;
    let statusCalls = 0;
    let conditionCalls = 0;
    let commentCalls = 0;
    let terminalProjectionCalls = 0;
    const statuses = new Map<string, "in_progress" | "in_review" | "requires_manual" | "completed">(
      [
        [residue.issue.externalId, "in_review"],
        [orphan.issue.externalId, "in_review"],
        [manualResidue.issue.externalId, "in_progress"],
        [staleManual.issue.externalId, "in_progress"],
        [autoReentry.issue.externalId, "in_review"],
        [racingCompleted.issue.externalId, "in_progress"],
      ],
    );
    const workManagement = {
      listIssues: () =>
        Promise.resolve(
          ok([
            human,
            active,
            residue,
            orphan,
            labelOnly,
            manualResidue,
            staleManual,
            autoReentry,
            racingCompleted,
          ]),
        ),
      getIssue: (reference: { externalIssueId: string }) => {
        getCalls += 1;
        const source =
          reference.externalIssueId === residue.issue.externalId
            ? residue
            : reference.externalIssueId === manualResidue.issue.externalId
              ? manualResidue
              : orphan;
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
        reference: { externalIssueId: string },
        condition: ReturnType<typeof createAgentCondition>,
      ) => {
        conditionCalls += 1;
        const source =
          reference.externalIssueId === manualResidue.issue.externalId ? manualResidue : orphan;
        return Promise.resolve(
          ok({
            ...source,
            workStatus: statuses.get(reference.externalIssueId) ?? "in_progress",
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
    const manualResidueJob = "job_018f47d2-77a4-7cc1-8ef2-012345678906";
    const staleManualJob = "job_018f47d2-77a4-7cc1-8ef2-012345678907";
    const autoReentryJob = "job_018f47d2-77a4-7cc1-8ef2-012345678909";
    const racingCompletedJob = "job_018f47d2-77a4-7cc1-8ef2-012345678910";
    const competingJob = "job_018f47d2-77a4-7cc1-8ef2-012345678911";
    const terminalRequests: WorkStatusLifecycleRequest[] = [];
    let progressListCalls = 0;
    const manualProgressRecord = {
      projectId: project.id,
      issueId: manualResidue.issue.id,
      externalIssueId: manualResidue.issue.externalId,
      jobId: manualResidueJob,
      revision: 2,
      stage: {
        kind: "requires_manual",
        cause: {
          stage: "ci_recovery",
          reasonCode: "ci_recovery_paused",
          attempts: { count: 1 },
        },
      },
      workStatusLifecycle: {
        admissionMode: "enforce",
        capabilityDigest: "a".repeat(64),
        transitions: [
          {
            step: "work_start",
            mainTarget: "in_progress",
            main: { state: "confirmed" },
          },
        ],
      },
    };
    const completedProgressRecord = {
      projectId: project.id,
      issueId: residue.issue.id,
      externalIssueId: residue.issue.externalId,
      jobId: residueJob,
      revision: 1,
      stage: { kind: "completed" },
      workStatusLifecycle: {
        admissionMode: "enforce",
        capabilityDigest: "a".repeat(64),
        transitions: [
          {
            step: "work_start",
            mainTarget: "in_progress",
            main: { state: "confirmed" },
          },
          {
            step: "review_start",
            mainTarget: "in_review",
            main: { state: "confirmed" },
          },
        ],
      },
    };
    const staleProgressRecord = {
      ...manualProgressRecord,
      issueId: staleManual.issue.id,
      externalIssueId: staleManual.issue.externalId,
      jobId: staleManualJob,
      revision: 3,
    };
    const autoReentryRecord = {
      ...manualProgressRecord,
      issueId: autoReentry.issue.id,
      externalIssueId: autoReentry.issue.externalId,
      jobId: autoReentryJob,
      revision: 4,
      stage: {
        kind: "requires_manual",
        cause: {
          stage: "merge",
          reasonCode: "lifecycle_not_completed",
          attempts: { count: 1 },
        },
      },
    };
    const racingCompletedRecord = {
      ...completedProgressRecord,
      issueId: racingCompleted.issue.id,
      externalIssueId: racingCompleted.issue.externalId,
      jobId: racingCompletedJob,
      revision: 5,
    };
    const competingRecord = {
      ...manualProgressRecord,
      issueId: racingCompleted.issue.id,
      externalIssueId: racingCompleted.issue.externalId,
      jobId: competingJob,
      revision: 0,
      stage: { kind: "implementing" },
    };
    const coordinator = new WorkStatusOrphanCoordinator({
      project,
      workManagement,
      progress: {
        listAll: () => {
          progressListCalls += 1;
          return Promise.resolve(
            ok([
              {
                projectId: project.id,
                externalIssueId: active.issue.externalId,
                jobId: activeJob,
                stage: { kind: "awaiting_review" },
              },
              completedProgressRecord,
              {
                projectId: project.id,
                externalIssueId: orphan.issue.externalId,
                jobId: "job_018f47d2-77a4-7cc1-8ef2-012345678904",
                stage: { kind: "requires_manual" },
                workStatusLifecycle: { admissionMode: "enforce", transitions: [] },
              },
              manualProgressRecord,
              staleProgressRecord,
              autoReentryRecord,
              racingCompletedRecord,
              ...(progressListCalls > 1 ? [competingRecord] : []),
            ] as never),
          );
        },
        load: (jobId: string) =>
          Promise.resolve(
            ok(
              jobId === manualResidueJob
                ? (manualProgressRecord as never)
                : jobId === residueJob
                  ? (completedProgressRecord as never)
                  : jobId === racingCompletedJob
                    ? (racingCompletedRecord as never)
                    : undefined,
            ),
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
              {
                state: "active",
                projectId: project.id,
                issueId: manualResidue.issue.id,
                externalIssueId: manualResidue.issue.externalId,
                jobId: manualResidueJob,
                revision: 1,
              },
              {
                state: "active",
                projectId: project.id,
                issueId: autoReentry.issue.id,
                externalIssueId: autoReentry.issue.externalId,
                jobId: autoReentryJob,
                revision: 1,
              },
              {
                state: "active",
                projectId: project.id,
                issueId: staleManual.issue.id,
                externalIssueId: staleManual.issue.externalId,
                jobId: staleManualJob,
                revision: 1,
              },
            ] as never),
          ),
        load: (_projectId: string, issueId: string) =>
          Promise.resolve(
            ok(
              issueId === manualResidue.issue.id
                ? {
                    state: "active",
                    projectId: project.id,
                    issueId: manualResidue.issue.id,
                    externalIssueId: manualResidue.issue.externalId,
                    jobId: manualResidueJob,
                    revision: 1,
                  }
                : issueId === staleManual.issue.id
                  ? {
                      state: "active",
                      projectId: project.id,
                      issueId: staleManual.issue.id,
                      externalIssueId: staleManual.issue.externalId,
                      jobId: staleManualJob,
                      revision: 1,
                    }
                  : issueId === racingCompleted.issue.id
                    ? {
                        state: "active",
                        projectId: project.id,
                        issueId: racingCompleted.issue.id,
                        externalIssueId: racingCompleted.issue.externalId,
                        jobId: competingJob,
                        revision: 1,
                      }
                    : undefined,
            ),
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
        transitionWhileLockHeld: (request: WorkStatusLifecycleRequest) => {
          terminalProjectionCalls += 1;
          terminalRequests.push(request);
          const target = request.mainTarget as "completed" | "requires_manual";
          const externalIssueId = (request.reference as { externalIssueId: string })
            .externalIssueId;
          statuses.set(externalIssueId, target);
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
      inspected: 9,
      humanOwned: 2,
      activeManaged: 2,
      terminalResidue: 2,
      quarantined: 1,
      blocked: 0,
    });
    expect(getCalls).toBe(3);
    expect(statusCalls).toBe(1);
    expect(conditionCalls).toBe(1);
    expect(commentCalls).toBe(2);
    expect(terminalProjectionCalls).toBe(2);
    expect(statuses.get(residue.issue.externalId)).toBe("completed");
    expect(statuses.get(orphan.issue.externalId)).toBe("requires_manual");
    expect(statuses.get(manualResidue.issue.externalId)).toBe("requires_manual");
    expect(statuses.get(staleManual.issue.externalId)).toBe("in_progress");
    expect(statuses.get(autoReentry.issue.externalId)).toBe("in_review");
    expect(statuses.get(racingCompleted.issue.externalId)).toBe("in_progress");
    expect(
      terminalRequests.some(
        (request) => request.reference.externalIssueId === staleManual.issue.externalId,
      ),
    ).toBe(false);
    expect(
      terminalRequests.some(
        (request) => request.reference.externalIssueId === racingCompleted.issue.externalId,
      ),
    ).toBe(false);
    expect(terminalRequests).toContainEqual(
      expect.objectContaining({
        step: "requires_manual",
        mainTarget: "requires_manual",
        agentTarget: {
          kind: "set",
          status: "blocked",
          blockingReason: "integration_failure",
        },
      }),
    );
  });

  it("retries a failed safe comment with stable transition identity and a fresh invocation", async () => {
    const item = issue(8, true);
    const jobId = "job_018f47d2-77a4-7cc1-8ef2-012345678908";
    let revision = 1;
    let workStatus: "in_progress" | "requires_manual" = "in_progress";
    let agentCondition = createAgentCondition("executing");
    let commentAttempt = 0;
    const requests: WorkStatusLifecycleRequest[] = [];
    const commentKeys: string[] = [];
    const transitions: unknown[] = [
      {
        step: "work_start",
        mainTarget: "in_progress",
        main: { state: "confirmed" },
      },
    ];
    const record = () =>
      ({
        projectId: project.id,
        issueId: item.id,
        externalIssueId: item.externalId,
        jobId,
        revision,
        stage: {
          kind: "requires_manual",
          cause: {
            stage: "ci_recovery",
            reasonCode: "ci_recovery_paused",
            attempts: { count: 1 },
          },
        },
        workStatusLifecycle: {
          admissionMode: "enforce",
          capabilityDigest: "a".repeat(64),
          transitions,
        },
      }) as never;
    const claim = {
      state: "active",
      projectId: project.id,
      issueId: item.id,
      externalIssueId: item.externalId,
      jobId,
      revision: 1,
    } as never;
    const coordinator = new WorkStatusOrphanCoordinator({
      project,
      workManagement: {
        listIssues: () =>
          Promise.resolve(
            ok([
              {
                ...snapshot(item, true),
                workStatus,
                agentCondition,
              },
            ]),
          ),
        getIssue: () =>
          Promise.resolve(
            ok({
              ...snapshot(item, true),
              workStatus,
              agentCondition,
            }),
          ),
        setWorkStatus: () => Promise.resolve(err(domainError("invariant_violation"))),
        setAgentCondition: () => Promise.resolve(err(domainError("invariant_violation"))),
        appendComment: (_reference, body, options) => {
          commentAttempt += 1;
          commentKeys.push(options.idempotencyKey);
          return commentAttempt === 1
            ? Promise.resolve(err(domainError("unavailable")))
            : Promise.resolve(ok({ id: "comment-1", body, createdAt: now }));
        },
      },
      progress: {
        listAll: () => Promise.resolve(ok([record()])),
        load: () => Promise.resolve(ok(record())),
      },
      admission: {
        listForProject: () => Promise.resolve(ok([claim])),
        load: () => Promise.resolve(ok(claim)),
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
        transitionWhileLockHeld: (request) => {
          requests.push(request);
          workStatus = "requires_manual";
          agentCondition = createAgentCondition("blocked", ["integration_failure"]);
          revision += 1;
          if (commentAttempt === 0) {
            transitions.push({
              step: request.step,
              instance: request.transitionInstance,
              mainTarget: request.mainTarget,
              allowedMainSources: request.allowedMainSources,
              agentTarget: request.agentTarget,
              main: { state: "confirmed" },
              agent: { state: "confirmed" },
            });
          }
          return Promise.resolve({
            state: "permitted" as const,
            mode: "enforce" as const,
            main: "confirmed" as const,
            agent: "confirmed" as const,
          });
        },
      },
    });

    await expect(coordinator.scan()).resolves.toMatchObject({
      terminalResidue: 0,
      blocked: 1,
    });
    await expect(coordinator.scan()).resolves.toMatchObject({
      terminalResidue: 1,
      blocked: 0,
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.transitionInstance).toBe(requests[1]?.transitionInstance);
    expect(requests[0]?.invocationDigest).not.toBe(requests[1]?.invocationDigest);
    expect(commentKeys).toHaveLength(2);
    expect(commentKeys[0]).toBe(commentKeys[1]);
  });
});

describe("requires-manual projection authority", () => {
  const base = {
    stage: {
      kind: "requires_manual",
      cause: {
        stage: "ci_recovery",
        reasonCode: "ci_recovery_paused",
        attempts: { count: 1 },
      },
    },
    workStatusLifecycle: {
      admissionMode: "enforce",
      capabilityDigest: "a".repeat(64),
      transitions: [
        { step: "work_start", mainTarget: "in_progress", main: { state: "confirmed" } },
      ],
    },
  };

  it("excludes every bounded auto-reentry cause from the one-way Linear projection", () => {
    expect(mayProjectRequiresManual(base as never)).toBe(true);
    for (const reasonCode of [
      "auto_merge_not_enabled",
      "lifecycle_not_completed",
      "review_reuse_unimplemented",
    ] as const) {
      expect(
        mayProjectRequiresManual({
          ...base,
          stage: {
            kind: "requires_manual",
            cause: { stage: "merge", reasonCode, attempts: { count: 1 } },
          },
        } as never),
      ).toBe(false);
    }
    expect(
      mayProjectRequiresManual({
        ...base,
        stage: {
          kind: "requires_manual",
          cause: {
            stage: "review",
            reasonCode: "review_report_contract",
            attempts: { count: 2 },
          },
        },
        reviewerReplay: { state: "review_succeeded" },
      } as never),
    ).toBe(false);
  });

  it("does not skip a later confirmed terminal transition to reuse an obsolete active source", () => {
    expect(
      latestConfirmedActiveWorkStatus({
        ...base,
        workStatusLifecycle: {
          ...base.workStatusLifecycle,
          transitions: [
            ...base.workStatusLifecycle.transitions,
            { step: "complete", mainTarget: "completed", main: { state: "confirmed" } },
          ],
        },
      } as never),
    ).toBeUndefined();
  });
});
