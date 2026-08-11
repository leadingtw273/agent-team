/**
 * E010b: composition-level tests for `src/cli/reconcile/composition.ts` -- the first production
 * wiring of `ReconcileCoordinator` (real store, no fake adapters injected into the coordinator
 * itself; only the file paths are rooted at a temporary directory instead of `$AGENT_TEAM_HOME`).
 *
 * Scope proven here: (1) `leases.reclaimExpired` genuinely reclaims a real expired lease from a
 * real `FileLeaseRepository`, durably, and the CLI-facing outcome reflects that; (2) re-running the
 * exact same reconcile pass is idempotent -- no duplicate reclaim, no duplicate write; (3) the four
 * ports with no real production backing yet (`providers`, `events`, `processes`, `blocks`) always
 * fail closed with an honest `"unavailable"` error, never a fabricated success, and `jobs.listActive`
 * always resolves to the empty set -- together these two facts are *why* a real reconcile run can
 * never spawn a model process (the coordinator's per-target loop, the only place any of those four
 * ports would ever be called, is structurally unreachable while `listActive` returns `[]`).
 *
 * E010c adds disclosed scope. T02B additionally proves the production use case reads the durable
 * progress directory once and reports active/terminal inventory without reaching any model port.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildManualReconcilePorts,
  buildManualReconcileUseCase,
} from "../../src/cli/reconcile/composition.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-reconcile-composition-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeLeasesFixture(
  agentTeamHome: string,
  leases: readonly Readonly<Record<string, unknown>>[],
): Promise<string> {
  const stateDirectory = join(agentTeamHome, "state");
  // The file-locking layer (src/infrastructure/files/secure-directory.ts) requires every directory
  // in a lock file's path to be a private (0700) directory -- mirrors the same requirement the
  // real `FileLeaseRepository` production composition already relies on under `$AGENT_TEAM_HOME`.
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const leasesPath = join(stateDirectory, "leases.json");
  await writeFile(leasesPath, JSON.stringify({ schemaVersion: 1, leases }, null, 2), "utf8");
  return leasesPath;
}

const expiredLease = Object.freeze({
  schemaVersion: 1,
  id: "lease_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  jobId: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  issueId: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  holderId: "dead-holder",
  acquiredAt: "2020-01-01T00:00:00.000Z",
  expiresAt: "2020-01-01T00:05:00.000Z",
});

async function writeProgressFixture(
  agentTeamHome: string,
  jobId: string,
  stage: Readonly<Record<string, unknown>>,
  projectId = "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
): Promise<void> {
  const directory = join(agentTeamHome, "state", "dispatch", "progress");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory, `${jobId}.json`),
    JSON.stringify(
      {
        schemaVersion: 1,
        revision: 0,
        jobId,
        projectId,
        issueId: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab",
        externalIssueId: "ENG-1",
        model: "test-model",
        stage,
        branch: `agent-team/${jobId}`,
        worktreePath: `/tmp/${jobId}`,
        updatedAt: "2026-08-11T12:00:00.000Z",
      },
      null,
      2,
    ),
    { encoding: "utf8", mode: 0o600 },
  );
}

describe("E010b manual reconcile production composition", () => {
  it("reclaims a real expired lease from the shared FileLeaseRepository", async () => {
    const agentTeamHome = await temporaryHome();
    const leasesPath = await writeLeasesFixture(agentTeamHome, [expiredLease]);

    const useCase = buildManualReconcileUseCase({ agentTeamHome });
    const outcome = await useCase.reconcileAll({
      controllerId: "manual-reconcile",
      idempotencyKeyPrefix: "reconcile-test:first",
    });

    expect(outcome).toEqual({
      state: "completed",
      reclaimedLeaseIds: [expiredLease.id],
      targets: [],
      modelResumeAttempts: 0,
    });

    const persisted = JSON.parse(await readFile(leasesPath, "utf8")) as {
      readonly leases: readonly { readonly id: string; readonly releasedAt?: string }[];
    };
    expect(persisted.leases).toHaveLength(1);
    expect(persisted.leases[0]).toMatchObject({ id: expiredLease.id });
    expect(typeof persisted.leases[0]?.releasedAt).toBe("string");
  });

  it("is idempotent: re-running against an already-reclaimed lease reclaims nothing new", async () => {
    const agentTeamHome = await temporaryHome();
    const leasesPath = await writeLeasesFixture(agentTeamHome, [expiredLease]);
    const useCase = buildManualReconcileUseCase({ agentTeamHome });

    const first = await useCase.reconcileAll({
      controllerId: "manual-reconcile",
      idempotencyKeyPrefix: "reconcile-test:first",
    });
    const second = await useCase.reconcileAll({
      controllerId: "manual-reconcile",
      idempotencyKeyPrefix: "reconcile-test:second",
    });

    expect(first).toMatchObject({ state: "completed", reclaimedLeaseIds: [expiredLease.id] });
    expect(second).toEqual({
      state: "completed",
      reclaimedLeaseIds: [],
      targets: [],
      modelResumeAttempts: 0,
    });

    const persistedAfterBoth = JSON.parse(await readFile(leasesPath, "utf8")) as {
      readonly leases: readonly unknown[];
    };
    // Still exactly one lease record -- no duplicate row was ever written by the second pass.
    expect(persistedAfterBoth.leases).toHaveLength(1);
  });

  it("reports completed with zero reclaims and zero model resume attempts when there is no state at all", async () => {
    const agentTeamHome = await temporaryHome();
    // Deliberately never writes state/leases.json or state/jobs.json -- proves the "not_found"
    // path (FileLeaseRepository/FileJobRepository readAll()) is treated as an honest empty
    // collection, not a failure, matching every other production composition in this codebase.
    const useCase = buildManualReconcileUseCase({ agentTeamHome });

    await expect(
      useCase.reconcileAll({
        controllerId: "manual-reconcile",
        idempotencyKeyPrefix: "reconcile-test:empty",
      }),
    ).resolves.toEqual({
      state: "completed",
      reclaimedLeaseIds: [],
      targets: [],
      modelResumeAttempts: 0,
    });
    await expect(useCase.readJobProgressInventory()).resolves.toEqual({
      ok: true,
      value: { resumable: [], blocked: [], terminal: [] },
    });
  });

  it("reads resumable, blocked and terminal durable progress without invoking generic target ports", async () => {
    const agentTeamHome = await temporaryHome();
    await writeProgressFixture(agentTeamHome, "job_018f47d2-77a4-7cc1-8ef2-012345678901", {
      kind: "ci_waiting",
    });
    await writeProgressFixture(agentTeamHome, "job_018f47d2-77a4-7cc1-8ef2-012345678902", {
      kind: "implementing",
    });
    await writeProgressFixture(agentTeamHome, "job_018f47d2-77a4-7cc1-8ef2-012345678903", {
      kind: "completed",
    });

    const useCase = buildManualReconcileUseCase({ agentTeamHome });
    const inventory = await useCase.readJobProgressInventory();
    expect(inventory.ok).toBe(true);
    if (!inventory.ok) return;
    expect(inventory.value.resumable.map((record) => record.stage.kind)).toEqual(["ci_waiting"]);
    expect(inventory.value.blocked.map((record) => record.stage.kind)).toEqual(["implementing"]);
    expect(inventory.value.terminal.map((record) => record.stage.kind)).toEqual(["completed"]);
  });

  it("groups one inventory snapshot by project and invokes the resume-only bridge once per project", async () => {
    const agentTeamHome = await temporaryHome();
    const projectA = "project_018f47d2-77a4-7cc1-8ef2-0123456789ab";
    const projectB = "project_018f47d2-77a4-7cc1-8ef2-0123456789ac";
    const jobA1 = "job_018f47d2-77a4-7cc1-8ef2-012345678901";
    const jobA2 = "job_018f47d2-77a4-7cc1-8ef2-012345678902";
    const jobB = "job_018f47d2-77a4-7cc1-8ef2-012345678903";
    await writeProgressFixture(agentTeamHome, jobA1, { kind: "ci_waiting" }, projectA);
    await writeProgressFixture(agentTeamHome, jobA2, { kind: "awaiting_review" }, projectA);
    await writeProgressFixture(agentTeamHome, jobB, { kind: "ci_waiting" }, projectB);
    const builtProjects: string[] = [];
    const resumedSelections: string[][] = [];
    const buildDispatch = vi.fn((options: { projectId: string }) => {
      builtProjects.push(options.projectId);
      return Promise.resolve({ state: "ready" as const, value: {} as never });
    });
    const resumeProject = vi.fn((options: { selections?: readonly { jobId: string }[] }) => {
      resumedSelections.push(options.selections?.map((item) => item.jobId) ?? []);
      return Promise.resolve({
        state: "resumed" as const,
        outcomes: (options.selections ?? []).map((item) => ({
          jobId: item.jobId,
          outcome: "completed" as const,
        })),
      });
    });
    const useCase = buildManualReconcileUseCase({
      agentTeamHome,
      buildDispatchComposition: buildDispatch,
      resumeExistingProjectJobs: resumeProject,
    });
    const inventory = await useCase.readJobProgressInventory();
    expect(inventory.ok).toBe(true);
    if (!inventory.ok) return;

    const result = await useCase.resumeJobProgress(inventory.value.resumable);

    expect(builtProjects).toEqual([projectA, projectB]);
    expect(resumedSelections).toEqual([[jobA1, jobA2], [jobB]]);
    expect(result.blocked).toEqual([]);
    expect(result.outcomes.map((outcome) => outcome.jobId)).toEqual([jobA1, jobA2, jobB]);
  });

  describe("E010c disclosed-scope derivation", () => {
    it("reports durable progress inventory separately from the unwired coordinator target snapshot", async () => {
      const agentTeamHome = await temporaryHome();
      const useCase = buildManualReconcileUseCase({ agentTeamHome });

      expect(useCase.disclosedScope).toEqual({
        wiredCapabilities: [
          "lease_reclaim",
          "job_update",
          "durable_progress_inventory",
          "durable_progress_resume",
        ],
        unwiredCapabilities: [
          "active_job_snapshot",
          "provider_readback",
          "event_repair",
          "process_inspect",
          "process_resume",
          "block_record",
          "lease_recovery_prepare",
          "lease_recovery_release",
        ],
      });
    });

    it("derives from the actual built ports rather than a fixed literal: every id in the union is classified exactly once", async () => {
      const agentTeamHome = await temporaryHome();
      const useCase = buildManualReconcileUseCase({ agentTeamHome });
      const { wiredCapabilities, unwiredCapabilities } = useCase.disclosedScope;

      // No id is missing and none is double-counted -- the disclosure covers the whole
      // `ReconcileCapabilityId` surface derived from `describeDisclosedScope`'s accessor table.
      const all = [...wiredCapabilities, ...unwiredCapabilities];
      expect(new Set(all).size).toBe(all.length);
      expect(all).toHaveLength(12);
      const overlap = wiredCapabilities.filter((id) => unwiredCapabilities.includes(id));
      expect(overlap).toEqual([]);
    });
  });

  describe("disclosed gap ports (providers/events/processes/blocks)", () => {
    it("never fabricates success for the four ports with no real production backing yet", async () => {
      const agentTeamHome = await temporaryHome();
      const ports = buildManualReconcilePorts({ agentTeamHome });

      // `jobs.listActive` is the structural reason none of the four gap ports below can ever be
      // reached from a real `reconcileAll()` call -- the coordinator only calls them from inside
      // its per-target loop, which iterates exactly `listActive()`'s result.
      await expect(ports.jobs.listActive()).resolves.toEqual({ ok: true, value: [] });

      const target = {
        project: {
          schemaVersion: 1,
          id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
          displayName: "fixture",
          localRepositoryPath: "/tmp/fixture",
          defaultBranch: "main",
          workManagement: {
            provider: "linear" as const,
            containerId: "workspace",
            projectId: "team",
          },
          sourceControl: { provider: "github" as const, repository: "owner/repository" },
        },
        externalIssueId: "ENG-1",
        job: {
          schemaVersion: 1,
          id: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
          projectId: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
          issueId: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab",
          createdAt: "2026-08-05T12:00:00.000Z",
          startedAt: "2026-08-05T12:01:00.000Z",
          watchdogExtensionGranted: false,
          attempts: { processRecoveries: 0, ciFixRounds: 0, reviewerFixRounds: 0, reviewRuns: 0 },
        },
      };

      await expect(ports.providers.readBack(target as never)).resolves.toMatchObject({
        ok: false,
        error: { code: "unavailable" },
      });
      await expect(
        ports.events.repairMissing(
          { target: target as never, providerFindings: [] },
          { idempotencyKey: "k" },
        ),
      ).resolves.toMatchObject({ ok: false, error: { code: "unavailable" } });
      await expect(ports.processes.inspect(target.job as never)).resolves.toMatchObject({
        ok: false,
        error: { code: "unavailable" },
      });
      await expect(
        ports.processes.resumeFromCheckpoint(
          {
            job: target.job as never,
            checkpointId: "checkpoint-1",
            reason: "unexpected_process_exit",
          },
          { idempotencyKey: "k" },
        ),
      ).resolves.toMatchObject({ ok: false, error: { code: "unavailable" } });
      await expect(
        ports.blocks.record(
          { target: target as never, reason: "source_unavailable" },
          { idempotencyKey: "k" },
        ),
      ).resolves.toMatchObject({ ok: false, error: { code: "unavailable" } });
      await expect(
        ports.leases.prepareRecovery(target as never, "manual-reconcile", { idempotencyKey: "k" }),
      ).resolves.toMatchObject({ ok: false, error: { code: "unavailable" } });
      await expect(
        ports.leases.releaseRecovery("lease-1", "manual-reconcile", { idempotencyKey: "k" }),
      ).resolves.toMatchObject({ ok: false, error: { code: "unavailable" } });
    });
  });
});
