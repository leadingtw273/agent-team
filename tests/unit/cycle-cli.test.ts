import { chmod, mkdir, mkdtemp, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { domainError, err } from "../../src/domain/foundation/index.js";
import {
  createControllerCycleHandler,
  createNoopControllerCycleStages,
  type ControllerCycleSignalScope,
  type ControllerCycleStage,
  type ControllerCycleStages,
} from "../../src/cli/cycle/index.js";
import {
  acquireControllerCycleLock,
  controllerCycleLockPath,
  createControllerCycleLockAcquirer,
} from "../../src/cli/cycle/lock.js";
import type { FileLockSnapshot } from "../../src/infrastructure/files/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-team-cycle-cli-"));
  roots.push(root);
  return join(root, ".agent-team");
}

function deferred<Value>() {
  let resolve: (value: Value | PromiseLike<Value>) => void = () => undefined;
  const promise = new Promise<Value>((innerResolve) => {
    resolve = innerResolve;
  });
  return Object.freeze({ promise, resolve });
}

function stage(
  id: ControllerCycleStage["id"],
  run: ControllerCycleStage["run"],
): ControllerCycleStage {
  return Object.freeze({ id, run });
}

function stages(overrides: Partial<ControllerCycleStages> = {}): ControllerCycleStages {
  return Object.freeze({ ...createNoopControllerCycleStages(), ...overrides });
}

function signalScope(controller = new AbortController()): ControllerCycleSignalScope {
  return Object.freeze({ signal: controller.signal, dispose: () => undefined });
}

function payload(message: string | undefined): Readonly<Record<string, unknown>> {
  expect(message).toBeDefined();
  return JSON.parse(message ?? "") as Readonly<Record<string, unknown>>;
}

describe("C01 Controller cycle CLI and singleton lock", () => {
  it("renders already_running only for an independently confirmed active conflict", async () => {
    const agentTeamHome = await temporaryHome();
    const webhookHealth = vi.fn(() => Promise.resolve({ state: "completed" as const }));
    const inspect = vi.fn(() => Promise.resolve(err(domainError("conflict"))));
    const outcome = await createControllerCycleHandler({
      agentTeamHome,
      stages: stages({ webhookHealth: stage("webhook_health", webhookHealth) }),
      acquireLock: createControllerCycleLockAcquirer({
        acquire: () => Promise.resolve(err(domainError("conflict"))),
        inspect,
      }),
      createSignalScope: signalScope,
    })({ all: true });

    expect(outcome.state).toBe("success");
    expect(payload(outcome.message)).toEqual({
      operation: "controller_cycle",
      state: "already_running",
    });
    expect(inspect).toHaveBeenCalledOnce();
    expect(webhookHealth).not.toHaveBeenCalled();
  });

  it.each(["not_found", "external_failure", "invariant_violation", "unavailable"] as const)(
    "fails closed instead of rendering already_running for secondary lock probe %s",
    async (probeError) => {
      const agentTeamHome = await temporaryHome();
      const webhookHealth = vi.fn(() => Promise.resolve({ state: "completed" as const }));
      const inspect = vi.fn(() => Promise.resolve(err(domainError(probeError))));
      const outcome = await createControllerCycleHandler({
        agentTeamHome,
        stages: stages({ webhookHealth: stage("webhook_health", webhookHealth) }),
        acquireLock: createControllerCycleLockAcquirer({
          acquire: () => Promise.resolve(err(domainError("conflict"))),
          inspect,
        }),
        createSignalScope: signalScope,
      })({ all: true });

      expect(outcome.state).toBe("failed");
      expect(payload(outcome.message)).toEqual({
        operation: "controller_cycle",
        state: "failed",
        reasonCode: "lock_acquire_failed",
        stageCounts: { completed: 0, degraded: 0, failed: 0 },
      });
      expect(inspect).toHaveBeenCalledOnce();
      expect(webhookHealth).not.toHaveBeenCalled();
    },
  );

  it("fails closed and redacts an unknown secondary lock probe exception", async () => {
    const agentTeamHome = await temporaryHome();
    const unsafe = "https://internal.example/secondary-probe?pid=1234&secret=raw-error";
    const outcome = await createControllerCycleHandler({
      agentTeamHome,
      acquireLock: createControllerCycleLockAcquirer({
        acquire: () => Promise.resolve(err(domainError("conflict"))),
        inspect: () => Promise.reject(new Error(unsafe)),
      }),
      createSignalScope: signalScope,
    })({ all: true });

    expect(outcome.state).toBe("failed");
    expect(payload(outcome.message)).toEqual({
      operation: "controller_cycle",
      state: "failed",
      reasonCode: "lock_acquire_failed",
      stageCounts: { completed: 0, degraded: 0, failed: 0 },
    });
    expect(outcome.message).not.toContain(unsafe);
    expect(outcome.message).not.toContain(agentTeamHome);
  });

  it("fails closed and redacts a thrown initial lock acquisition before any stage", async () => {
    const agentTeamHome = await temporaryHome();
    const unsafe = "https://internal.example/acquire?pid=5678&secret=raw-error";
    const webhookHealth = vi.fn(() => Promise.resolve({ state: "completed" as const }));
    const inspect = vi.fn(() => Promise.resolve(err(domainError("conflict"))));
    const outcome = await createControllerCycleHandler({
      agentTeamHome,
      stages: stages({ webhookHealth: stage("webhook_health", webhookHealth) }),
      acquireLock: createControllerCycleLockAcquirer({
        acquire: () => Promise.reject(new Error(unsafe)),
        inspect,
      }),
      createSignalScope: signalScope,
    })({ all: true });

    expect(outcome.state).toBe("failed");
    expect(payload(outcome.message)).toEqual({
      operation: "controller_cycle",
      state: "failed",
      reasonCode: "lock_acquire_failed",
      stageCounts: { completed: 0, degraded: 0, failed: 0 },
    });
    expect(inspect).not.toHaveBeenCalled();
    expect(webhookHealth).not.toHaveBeenCalled();
    expect(outcome.message).not.toContain(unsafe);
    expect(outcome.message).not.toContain(agentTeamHome);
    expect(outcome.message).not.toContain("5678");
  });

  it("fails closed and redacts an unexpected successful secondary lock probe", async () => {
    const agentTeamHome = await temporaryHome();
    const unsafe = "https://internal.example/inspect?pid=6789&secret=raw-error";
    const unexpectedSnapshot: FileLockSnapshot = Object.freeze({
      schemaVersion: 1,
      token: unsafe,
      holderId: unsafe,
      pid: 6789,
      acquiredAt: "2026-08-12T00:00:00.000Z" as FileLockSnapshot["acquiredAt"],
    });
    const webhookHealth = vi.fn(() => Promise.resolve({ state: "completed" as const }));
    const inspect = vi.fn(() => Promise.resolve({ ok: true as const, value: unexpectedSnapshot }));
    const outcome = await createControllerCycleHandler({
      agentTeamHome,
      stages: stages({ webhookHealth: stage("webhook_health", webhookHealth) }),
      acquireLock: createControllerCycleLockAcquirer({
        acquire: () => Promise.resolve(err(domainError("conflict"))),
        inspect,
      }),
      createSignalScope: signalScope,
    })({ all: true });

    expect(outcome.state).toBe("failed");
    expect(payload(outcome.message)).toEqual({
      operation: "controller_cycle",
      state: "failed",
      reasonCode: "lock_acquire_failed",
      stageCounts: { completed: 0, degraded: 0, failed: 0 },
    });
    expect(inspect).toHaveBeenCalledOnce();
    expect(webhookHealth).not.toHaveBeenCalled();
    expect(outcome.message).not.toContain(unsafe);
    expect(outcome.message).not.toContain(agentTeamHome);
    expect(outcome.message).not.toContain("6789");
  });

  it("fails closed without a secondary probe when the initial lock read is unknown", async () => {
    const agentTeamHome = await temporaryHome();
    const inspect = vi.fn(() => Promise.resolve(err(domainError("conflict"))));
    const outcome = await createControllerCycleHandler({
      agentTeamHome,
      acquireLock: createControllerCycleLockAcquirer({
        acquire: () => Promise.resolve(err(domainError("external_failure"))),
        inspect,
      }),
      createSignalScope: signalScope,
    })({ all: true });

    expect(outcome.state).toBe("failed");
    expect(payload(outcome.message)).toEqual({
      operation: "controller_cycle",
      state: "failed",
      reasonCode: "lock_acquire_failed",
      stageCounts: { completed: 0, degraded: 0, failed: 0 },
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("allows exactly one concurrent cycle to enter the ordered stages", async () => {
    const agentTeamHome = await temporaryHome();
    const started = deferred<undefined>();
    const releaseFirst = deferred<undefined>();
    const calls: string[] = [];
    const cycleStages = stages({
      webhookHealth: stage("webhook_health", async () => {
        calls.push("webhook_health");
        started.resolve(undefined);
        await releaseFirst.promise;
        return { state: "completed" };
      }),
      inbox: stage("inbox", () => {
        calls.push("inbox");
        return Promise.resolve({ state: "completed" as const });
      }),
      reconcile: stage("reconcile", () => {
        calls.push("reconcile");
        return Promise.resolve({ state: "completed" as const });
      }),
      projects: stage("projects", () => {
        calls.push("projects");
        return Promise.resolve({ state: "completed" as const });
      }),
    });
    const handler = createControllerCycleHandler({
      agentTeamHome,
      stages: cycleStages,
      createSignalScope: signalScope,
    });

    const first = handler({ all: true });
    await started.promise;
    const second = await handler({ all: true });

    expect(second.state).toBe("success");
    expect(payload(second.message)).toEqual({
      operation: "controller_cycle",
      state: "already_running",
    });
    expect(calls).toEqual(["webhook_health"]);

    releaseFirst.resolve(undefined);
    const completed = await first;
    expect(completed.state).toBe("success");
    expect(payload(completed.message)).toEqual({
      operation: "controller_cycle",
      state: "completed",
      stageCounts: { completed: 4, degraded: 0, failed: 0 },
    });
    expect(calls).toEqual(["webhook_health", "inbox", "reconcile", "projects"]);
  });

  it("creates the canonical private state and lock inode for an otherwise empty home", async () => {
    const agentTeamHome = await temporaryHome();
    const outcome = await createControllerCycleHandler({
      agentTeamHome,
      createSignalScope: signalScope,
    })({ all: true });
    const lockPath = controllerCycleLockPath(agentTeamHome);

    expect(outcome.state).toBe("success");
    expect((await stat(join(agentTeamHome, "state"))).mode & 0o777).toBe(0o700);
    expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
  });

  it("fails closed for stale legacy, symlink, and wrong-mode lock entries before any stage", async () => {
    for (const fixture of ["stale", "symlink", "wrong_mode"] as const) {
      const agentTeamHome = await temporaryHome();
      const stateDirectory = join(agentTeamHome, "state");
      const lockPath = controllerCycleLockPath(agentTeamHome);
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      await chmod(agentTeamHome, 0o700);
      await chmod(stateDirectory, 0o700);

      if (fixture === "stale") {
        await writeFile(lockPath, '{"pid":999999,"state":"stale"}\n', {
          encoding: "utf8",
          mode: 0o600,
        });
      } else if (fixture === "symlink") {
        const target = join(stateDirectory, "lock-target");
        await writeFile(target, "target\n", { encoding: "utf8", mode: 0o600 });
        await symlink(target, lockPath);
      } else {
        await writeFile(lockPath, "wrong-mode\n", { encoding: "utf8", mode: 0o600 });
        await chmod(lockPath, 0o644);
      }

      const webhookHealth = vi.fn(() => Promise.resolve({ state: "completed" as const }));
      const outcome = await createControllerCycleHandler({
        agentTeamHome,
        stages: stages({ webhookHealth: stage("webhook_health", webhookHealth) }),
        createSignalScope: signalScope,
      })({ all: true });

      expect(outcome.state).toBe("failed");
      expect(payload(outcome.message)).toEqual({
        operation: "controller_cycle",
        state: "failed",
        reasonCode: "lock_acquire_failed",
        stageCounts: { completed: 0, degraded: 0, failed: 0 },
      });
      expect(webhookHealth).not.toHaveBeenCalled();
    }
  });

  it("fails closed when its canonical lock is replaced before release", async () => {
    const agentTeamHome = await temporaryHome();
    const lockPath = controllerCycleLockPath(agentTeamHome);
    const displaced = `${lockPath}.displaced`;
    const neverStarts = vi.fn(() => Promise.resolve({ state: "completed" as const }));
    const outcome = await createControllerCycleHandler({
      agentTeamHome,
      stages: stages({
        webhookHealth: stage("webhook_health", async () => {
          await rename(lockPath, displaced);
          await writeFile(lockPath, "", { encoding: "utf8", mode: 0o600 });
          return { state: "failed" };
        }),
        inbox: stage("inbox", neverStarts),
      }),
      createSignalScope: signalScope,
    })({ all: true });

    expect(outcome.state).toBe("failed");
    expect(payload(outcome.message)).toEqual({
      operation: "controller_cycle",
      state: "failed",
      reasonCode: "lock_release_failed",
      stageCounts: { completed: 0, degraded: 0, failed: 1 },
    });
    expect(neverStarts).not.toHaveBeenCalled();
  });

  it("stops the ordered coordinator after a failed stage", async () => {
    const agentTeamHome = await temporaryHome();
    const neverStarts = vi.fn(() => Promise.resolve({ state: "completed" as const }));
    const outcome = await createControllerCycleHandler({
      agentTeamHome,
      stages: stages({
        webhookHealth: stage("webhook_health", () => Promise.resolve({ state: "failed" as const })),
        inbox: stage("inbox", neverStarts),
      }),
      createSignalScope: signalScope,
    })({ all: true });

    expect(outcome.state).toBe("failed");
    expect(payload(outcome.message)).toEqual({
      operation: "controller_cycle",
      state: "failed",
      reasonCode: "stage_failed",
      stageCounts: { completed: 0, degraded: 0, failed: 1 },
    });
    expect(neverStarts).not.toHaveBeenCalled();
  });

  it("stops before the next stage after SIGINT or SIGTERM-equivalent abort and releases safely", async () => {
    for (const signalName of ["SIGINT", "SIGTERM"] as const) {
      const agentTeamHome = await temporaryHome();
      const controller = new AbortController();
      const inbox = vi.fn(() => Promise.resolve({ state: "completed" as const }));
      const outcome = await createControllerCycleHandler({
        agentTeamHome,
        stages: stages({
          webhookHealth: stage("webhook_health", ({ signal }) => {
            expect(signal.aborted).toBe(false);
            controller.abort(signalName);
            return Promise.resolve({ state: "completed" as const });
          }),
          inbox: stage("inbox", inbox),
        }),
        createSignalScope: () => signalScope(controller),
      })({ all: true });

      expect(outcome.state).toBe("interrupted");
      expect(payload(outcome.message)).toEqual({
        operation: "controller_cycle",
        state: "interrupted",
        stageCounts: { completed: 1, degraded: 0, failed: 0 },
      });
      expect(inbox).not.toHaveBeenCalled();

      const reacquired = await acquireControllerCycleLock(
        agentTeamHome,
        "post-signal-verification",
      );
      expect(reacquired.ok).toBe(true);
      if (reacquired.ok)
        await expect(reacquired.value.release()).resolves.toEqual({
          ok: true,
          value: undefined,
        });
    }
  });

  it("renders only allowlisted diagnostic codes when lock or stage internals fail", async () => {
    const agentTeamHome = await temporaryHome();
    const unsafe = "https://internal.example/path?pid=1234&secret=raw-error";
    const outcome = await createControllerCycleHandler({
      agentTeamHome,
      acquireLock: () => Promise.reject(new Error(unsafe)),
      createSignalScope: signalScope,
    })({ all: true });

    expect(outcome.state).toBe("failed");
    expect(payload(outcome.message)).toEqual({
      operation: "controller_cycle",
      state: "failed",
      reasonCode: "lock_acquire_failed",
      stageCounts: { completed: 0, degraded: 0, failed: 0 },
    });
    expect(outcome.message).not.toContain(unsafe);
    expect(outcome.message).not.toContain(agentTeamHome);
  });
});
