/**
 * O009 acceptance-critical unit tests for `registration probe run|status` handlers, mirroring
 * registration-cli-setup-handlers.test.ts: confirmation mismatch is exit-2 with zero composition
 * calls, missing configuration is blocked (exit 3) with a fixed reason.
 */
import { describe, expect, it, vi } from "vitest";

import { createRegistrationProbeHandlers } from "../../src/cli/registration/probe-handlers.js";
import type { buildRegistrationProbeComposition } from "../../src/cli/registration/probe-composition.js";

async function* stream(chunk: string): AsyncIterable<string> {
  await Promise.resolve();
  yield chunk;
}

function neverCalledBuildComposition() {
  return vi.fn<typeof buildRegistrationProbeComposition>(() =>
    Promise.reject(new Error("must never be called: confirmation should reject first")),
  );
}

describe("registration probe run: confirmation gate", () => {
  it("rejects a wrong probe run confirmation phrase with zero composition calls", async () => {
    const buildComposition = neverCalledBuildComposition();
    const handlers = createRegistrationProbeHandlers({
      agentTeamHome: "/nonexistent",
      stdin: stream("run full revalidation\n"), // wrong case
      buildComposition,
    });

    const result = await handlers.probeRun({ projectId: "proj-1" });

    expect(result.state).toBe("rejected");
    expect(buildComposition).not.toHaveBeenCalled();
  });

  it("accepts the exact probe run confirmation phrase and proceeds to build the composition", async () => {
    const buildComposition = vi.fn<typeof buildRegistrationProbeComposition>(() =>
      Promise.resolve({ state: "blocked", reason: "activation_not_found" }),
    );
    const handlers = createRegistrationProbeHandlers({
      agentTeamHome: "/nonexistent",
      stdin: stream("RUN FULL REVALIDATION\n"),
      buildComposition,
    });

    const result = await handlers.probeRun({ projectId: "proj-1" });

    expect(buildComposition).toHaveBeenCalledTimes(1);
    expect(result.state).toBe("blocked");
    expect(JSON.parse(result.message ?? "")).toMatchObject({ reason: "activation_not_found" });
  });
});

describe("registration probe run/status: fail-closed on missing configuration", () => {
  it("reports blocked (exit 3) with a fixed reason when the composition is not ready", async () => {
    const buildComposition = vi.fn<typeof buildRegistrationProbeComposition>(() =>
      Promise.resolve({ state: "blocked", reason: "webhook_secret_unavailable" }),
    );
    const handlers = createRegistrationProbeHandlers({
      agentTeamHome: "/nonexistent",
      buildComposition,
    });

    const status = await handlers.probeStatus({ projectId: "proj-1" });

    expect(status.state).toBe("blocked");
    expect(JSON.parse(status.message ?? "")).toMatchObject({
      reason: "webhook_secret_unavailable",
    });
  });

  it("reports the coordinator's verified outcome on success", async () => {
    const start = vi.fn(() =>
      Promise.resolve({
        state: "verified" as const,
        run: { runId: "probe-run-1" },
      } as never),
    );
    const buildComposition = vi.fn<typeof buildRegistrationProbeComposition>(() =>
      Promise.resolve({
        state: "ready",
        value: {
          coordinator: { start },
          command: { project: { id: "proj-1" } },
          journal: { listActiveForProject: vi.fn(), load: vi.fn() },
        },
      } as never),
    );
    const handlers = createRegistrationProbeHandlers({
      agentTeamHome: "/nonexistent",
      stdin: stream("RUN FULL REVALIDATION\n"),
      buildComposition,
    });

    const result = await handlers.probeRun({ projectId: "proj-1" });

    expect(result.state).toBe("success");
    expect(JSON.parse(result.message ?? "")).toMatchObject({
      operation: "registration_probe_run",
      state: "verified",
      runId: "probe-run-1",
    });
  });

  it("reports active runs from the journal on status", async () => {
    const listActiveForProject = vi.fn(() =>
      Promise.resolve({
        ok: true,
        value: [{ runId: "probe-run-1", phase: "linear_created" }],
      } as never),
    );
    const buildComposition = vi.fn<typeof buildRegistrationProbeComposition>(() =>
      Promise.resolve({
        state: "ready",
        value: {
          coordinator: { start: vi.fn() },
          command: { project: { id: "proj-1" } },
          journal: { listActiveForProject, load: vi.fn() },
        },
      } as never),
    );
    const handlers = createRegistrationProbeHandlers({
      agentTeamHome: "/nonexistent",
      buildComposition,
    });

    const result = await handlers.probeStatus({ projectId: "proj-1" });

    expect(result.state).toBe("success");
    expect(JSON.parse(result.message ?? "")).toEqual({
      operation: "registration_probe_status",
      state: "active",
      activeRuns: [{ runId: "probe-run-1", phase: "linear_created" }],
    });
  });
});
