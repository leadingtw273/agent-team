import { describe, expect, it, vi } from "vitest";

import { createProjectUiShellReadModel } from "../../src/cli/ui/index.js";
import { projectListPayloadSchema, type ProjectListPayload } from "../../src/cli/project/schema.js";
import { createUiApplication } from "../../src/ui/registry/index.js";
import type { UiShellReadModel } from "../../src/ui/shell/index.js";

const projectOneId = "project_018f47d2-77a4-7cc1-8ef2-0123456789ab";
const projectTwoId = "project_018f47d2-77a4-7cc1-8ef2-0123456789ac";

function payload(overrides: Partial<ProjectListPayload> = {}): ProjectListPayload {
  return projectListPayloadSchema.parse({
    operation: "project_list",
    schemaVersion: 1,
    state: "completed",
    inventory: { state: "available", rejectedDraftCount: 0 },
    projects: [
      {
        id: projectOneId,
        displayName: "Production Alpha",
        registration: {
          state: "registered",
          reason: "trusted_config_verified",
          trustedConfigRevision: "a".repeat(40),
        },
        nonTerminalProgressCount: 2,
        activeLeaseCount: 1,
        workStatusLifecycleMode: "off",
        workStatusPendingCount: 0,
        workStatusInFlightModeCounts: { off: 0, observe: 0, enforce: 0 },
        workStatusCapability: {
          checkedAt: "2026-08-18T00:00:00.000Z",
          workflowStatesReady: true,
          agentLabelsReady: true,
          reasonCodesReady: true,
        },
        workStatusJobs: [
          {
            jobId: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
            workStatusLifecycleMode: "enforce",
            workStatusPhase: "review_start_pending",
            expectedLinearStateId: "state-review",
            observedLinearStateId: "state-progress",
            transitionInstance: "b".repeat(64),
            pendingMutation: {
              jobId: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
              step: "review_start",
              transitionInstance: "b".repeat(64),
              targetKind: "work_status",
              targetId: "state-review",
              consecutiveFailureCount: 1,
              lastClosedReason: "timeout",
              lastAttemptAt: "2026-08-18T01:00:00.000Z",
            },
            authority: {
              jobId: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
              claimId: "claim-safe",
              leaseExpiresAt: "2026-08-18T02:00:00.000Z",
            },
            incident: {
              kind: "main",
              reasonCode: "mutation_unconfirmed",
              state: "active",
              attemptCount: 1,
            },
          },
        ],
      },
      {
        id: projectTwoId,
        displayName: "Production Beta",
        registration: { state: "configuration_incomplete", reason: "activation_missing" },
        nonTerminalProgressCount: 3,
        activeLeaseCount: 0,
        workStatusLifecycleMode: "off",
        workStatusPendingCount: 0,
        workStatusInFlightModeCounts: { off: 0, observe: 0, enforce: 0 },
        workStatusCapability: {
          checkedAt: null,
          workflowStatesReady: false,
          agentLabelsReady: false,
          reasonCodesReady: false,
        },
        workStatusJobs: [],
      },
    ],
    ...overrides,
  });
}

async function refresh(readModel: UiShellReadModel): Promise<void> {
  if (readModel.refresh === undefined) throw new Error("Production read model must refresh.");
  await readModel.refresh();
}

describe("T06 production project UI bridge", () => {
  it("maps the existing completed T05 list schema into only the shell DTO fields", async () => {
    const read = vi.fn(() => Promise.resolve({ state: "success" as const, payload: payload() }));
    const readModel = createProjectUiShellReadModel({ read });

    await refresh(readModel);

    expect(read).toHaveBeenCalledExactlyOnceWith({});
    expect(readModel.readOverview()).toEqual({
      source: "runtime",
      teamState: "idle",
      activeJobCount: 5,
      registeredProjectCount: 1,
      recentEventCount: null,
      runtimeState: "completed",
      projectCount: 2,
      nonTerminalWorkCount: 5,
    });
    expect(readModel.listProjects()).toEqual([
      {
        id: projectOneId,
        name: "Production Alpha",
        status: "ready",
        activeJobCount: 2,
        registrationState: "registered",
        registrationReason: "trusted_config_verified",
        nonTerminalCount: 2,
        activeLeaseCount: 1,
        workStatusLifecycleMode: "off",
        workStatusPendingCount: 0,
        workStatusInFlightModeCounts: { off: 0, observe: 0, enforce: 0 },
        workStatusCapability: {
          checkedAt: "2026-08-18T00:00:00.000Z",
          workflowStatesReady: true,
          agentLabelsReady: true,
          reasonCodesReady: true,
        },
        workStatusJobs: [
          {
            jobId: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
            workStatusLifecycleMode: "enforce",
            workStatusPhase: "review_start_pending",
            expectedLinearStateId: "state-review",
            observedLinearStateId: "state-progress",
            transitionInstance: "b".repeat(64),
            pendingMutation: {
              jobId: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
              step: "review_start",
              transitionInstance: "b".repeat(64),
              targetKind: "work_status",
              targetId: "state-review",
              consecutiveFailureCount: 1,
              lastClosedReason: "timeout",
              lastAttemptAt: "2026-08-18T01:00:00.000Z",
            },
            authority: {
              jobId: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
              claimId: "claim-safe",
              leaseExpiresAt: "2026-08-18T02:00:00.000Z",
            },
            incident: {
              kind: "main",
              reasonCode: "mutation_unconfirmed",
              state: "active",
              attemptCount: 1,
            },
          },
        ],
      },
      {
        id: projectTwoId,
        name: "Production Beta",
        status: "attention",
        activeJobCount: 3,
        registrationState: "configuration_incomplete",
        registrationReason: "activation_missing",
        nonTerminalCount: 3,
        activeLeaseCount: 0,
        workStatusLifecycleMode: "off",
        workStatusPendingCount: 0,
        workStatusInFlightModeCounts: { off: 0, observe: 0, enforce: 0 },
        workStatusCapability: {
          checkedAt: null,
          workflowStatesReady: false,
          agentLabelsReady: false,
          reasonCodesReady: false,
        },
        workStatusJobs: [],
      },
    ]);
    expect(readModel.listEvents()).toEqual([]);
  });

  it("keeps degraded unavailable inventory as unavailable counts instead of guessing zero", async () => {
    const readModel = createProjectUiShellReadModel({
      read: () =>
        Promise.resolve(
          Object.freeze({
            state: "success" as const,
            payload: payload({
              state: "degraded",
              inventory: {
                state: "unavailable",
                rejectedDraftCount: 0,
                reason: "registration_drafts_unavailable",
              },
              projects: [],
            }),
          }),
        ),
    });

    await refresh(readModel);

    expect(readModel.readOverview()).toMatchObject({
      source: "runtime",
      runtimeState: "degraded",
      projectCount: null,
      registeredProjectCount: null,
      nonTerminalWorkCount: null,
    });
    expect(readModel.listProjects()).toEqual([]);
  });

  it("fails schema-invalid or failed T05 output closed without retaining its raw payload", async () => {
    const secret = "T06-RAW-PAYLOAD-MUST-NOT-RENDER";
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        state: "success" as const,
        payload: { operation: "project_list", schemaVersion: 1, secret },
      })
      .mockResolvedValueOnce({
        state: "failed" as const,
        payload: { operation: "project_detail", schemaVersion: 1, state: "failed", secret },
      });
    const readModel = createProjectUiShellReadModel({ read });

    await refresh(readModel);
    expect(readModel.readOverview()).toMatchObject({
      runtimeState: "unavailable",
      projectCount: null,
    });
    expect(JSON.stringify(readModel)).not.toContain(secret);

    await refresh(readModel);
    expect(readModel.readOverview()).toMatchObject({
      runtimeState: "unavailable",
      projectCount: null,
    });
    expect(JSON.stringify(readModel)).not.toContain(secret);
  });

  it("refreshes exactly once for each production HTML request and renders no fixture shell", async () => {
    const refresh = vi.fn(() => Promise.resolve());
    const readModel: UiShellReadModel = Object.freeze({
      refresh,
      readOverview: () =>
        Object.freeze({
          source: "runtime",
          teamState: "attention",
          activeJobCount: null,
          registeredProjectCount: null,
          recentEventCount: null,
          runtimeState: "unavailable",
          projectCount: null,
          nonTerminalWorkCount: null,
        }),
      listProjects: () => Object.freeze([]),
      listEvents: () => Object.freeze([]),
    });
    const application = createUiApplication({ readModel });
    const request = Object.freeze({
      method: "GET",
      url: "/",
      headers: Object.freeze({}),
      auth: Object.freeze({ kind: "session" as const }),
    });

    const page = await application.handler(request, Object.freeze({}));
    const asset = await application.handler(
      Object.freeze({ ...request, url: "/assets/ui-shell.css" }),
      Object.freeze({}),
    );

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(page.statusCode).toBe(200);
    expect(String(page.body)).toContain("T05 專案總覽");
    expect(String(page.body)).toContain("未取得／—");
    expect(String(page.body)).not.toContain("UI Shell 示範資料");
    expect(String(page.body)).toContain("ui-stat-grid--production");
    expect(asset.statusCode).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(application.routeContracts.map((route) => route.path)).toEqual([
      "/",
      "/projects",
      "/events",
      "/assets/icons.svg",
      "/assets/tabler-1.4.0.min.css",
      "/assets/ui-shell.css",
    ]);
  });
});
