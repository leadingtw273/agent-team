import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FileJobProgressStore,
  jobProgressRecordSchema,
  type JobProgressRecord,
} from "../../src/adapters/dispatch/job-progress-store.js";
import type {
  ProjectRegistrySnapshot,
  TrustedProjectConfig,
} from "../../src/application/projects/index.js";
import {
  evaluateRegistrationWakeupHealth,
  registrationSystemdWakeupStates,
  registrationWebhookWakeupStates,
  type RegistrationSetupDraft,
} from "../../src/application/registration/index.js";
import { createClock, domainError, err, ok } from "../../src/domain/foundation/index.js";
import { jobSchema, leaseSchema, type Job, type Lease } from "../../src/domain/jobs/index.js";
import { projectSchema, type Project } from "../../src/domain/project/index.js";
import { createProjectHandler } from "../../src/cli/project/index.js";
import {
  ProjectReadModel,
  type ProjectReadModelOptions,
} from "../../src/cli/project/read-model.js";
import { serializeProjectPayload } from "../../src/cli/project/schema.js";
import { listHostRegistrationSetupDrafts } from "../../src/cli/registration/draft-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "agent-team-project-read-"));
  roots.push(value);
  return value;
}

const projectOne = projectSchema.parse({
  schemaVersion: 1,
  id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  displayName: "Alpha Sandbox",
  localRepositoryPath: "/tmp/project-read-alpha-secret-host-path",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "team-secret", projectId: "linear-secret" },
  sourceControl: { provider: "github", repository: "owner/alpha-private" },
});

const projectTwo = projectSchema.parse({
  ...projectOne,
  id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ac",
  displayName: "Zulu Sandbox",
  localRepositoryPath: "/tmp/project-read-zulu-secret-host-path",
  workManagement: {
    provider: "linear",
    containerId: "team-secret-two",
    projectId: "linear-secret-two",
  },
  sourceControl: { provider: "github", repository: "owner/zulu-private" },
});

const jobOne = "job_018f47d2-77a4-7cc1-8ef2-012345678901";
const jobTwo = "job_018f47d2-77a4-7cc1-8ef2-012345678902";
const jobThree = "job_018f47d2-77a4-7cc1-8ef2-012345678903";
const jobMissing = "job_018f47d2-77a4-7cc1-8ef2-012345678904";
const issueOne = "issue_018f47d2-77a4-7cc1-8ef2-012345678901";
const issueTwo = "issue_018f47d2-77a4-7cc1-8ef2-012345678902";
const issueThree = "issue_018f47d2-77a4-7cc1-8ef2-012345678903";
const observedAt = "2026-08-11T12:00:00.000Z";

function trustedConfig(project: Project): TrustedProjectConfig {
  return {
    schemaVersion: 1,
    projectId: project.id,
    defaultBranch: project.defaultBranch,
    platforms: {
      workManagement: project.workManagement,
      sourceControl: project.sourceControl,
    },
    projectRules: ["token=github_pat_abcdefghijklmnopqrstuvwxyz123456"],
    roleInstructions: { implementer: ["Do not expose secrets."] },
    commands: { quality: [{ executable: "pnpm", arguments: ["test"] }], visualReview: [] },
  };
}

function draft(project: Project): RegistrationSetupDraft {
  return {
    project,
    config: trustedConfig(project),
    linearAuditIssueId: "AUDIT-SECRET-1",
  };
}

function draftEnvelope(project: Project): Readonly<Record<string, unknown>> {
  return { schemaVersion: 1, ...draft(project) };
}

function readySnapshot(projects: readonly Project[] = [projectOne]): ProjectRegistrySnapshot {
  return {
    ready: projects.map((project) => ({
      state: "ready" as const,
      project,
      config: trustedConfig(project),
      revisionSha: "a".repeat(40),
    })),
    rejected: [],
  };
}

function rejectedSnapshot(
  project: Project,
  reason: ProjectRegistrySnapshot["rejected"][number]["reason"],
): ProjectRegistrySnapshot {
  return { ready: [], rejected: [{ state: "rejected", project, reason }] };
}

function job(id: string, project: Project, issueId: string): Job {
  return jobSchema.parse({
    schemaVersion: 1,
    id,
    projectId: project.id,
    issueId,
    createdAt: "2026-08-11T11:00:00.000Z",
    watchdogExtensionGranted: false,
    attempts: { processRecoveries: 0, ciFixRounds: 0, reviewerFixRounds: 0, reviewRuns: 0 },
  });
}

function progress(
  id: string,
  project: Project,
  issueId: string,
  stage: Readonly<Record<string, unknown>>,
): JobProgressRecord {
  return jobProgressRecordSchema.parse({
    schemaVersion: 1,
    revision: 0,
    jobId: id,
    projectId: project.id,
    issueId,
    externalIssueId: "EXTERNAL-ISSUE-SECRET",
    model: "provider-secret-model",
    stage,
    branch: "agent-team/branch-secret",
    worktreePath: "/tmp/worktree-secret",
    updatedAt: observedAt,
  });
}

function lease(id: string, jobId: string, issueId: string, expiresAt: string): Lease {
  return leaseSchema.parse({
    schemaVersion: 1,
    id,
    jobId,
    issueId,
    holderId: "holder-secret",
    acquiredAt: "2026-08-11T11:00:00.000Z",
    expiresAt,
  });
}

function model(overrides: Partial<ProjectReadModelOptions> = {}): ProjectReadModel {
  const defaults = {
    discoverDrafts: () =>
      Promise.resolve({
        state: "available" as const,
        drafts: [draft(projectOne)],
        rejectedDraftCount: 0,
      }),
    registry: { load: vi.fn(() => Promise.resolve(readySnapshot())) },
    progress: { listAll: vi.fn(() => Promise.resolve(ok(Object.freeze([])))) },
    jobs: { readAll: vi.fn(() => Promise.resolve(ok(Object.freeze([])))) },
    leases: { readAll: vi.fn(() => Promise.resolve(ok(Object.freeze([])))) },
    clock: createClock(() => new Date(observedAt)),
  } satisfies ProjectReadModelOptions;
  return new ProjectReadModel({ ...defaults, ...overrides });
}

function payload(result: Awaited<ReturnType<ProjectReadModel["read"]>>): Record<string, unknown> {
  return JSON.parse(serializeProjectPayload(result.payload)) as Record<string, unknown>;
}

async function projectedDisplayName(displayName: string): Promise<string> {
  const project = projectSchema.parse({ ...projectOne, displayName });
  const rendered = payload(
    await model({
      discoverDrafts: () =>
        Promise.resolve({
          state: "available",
          drafts: [draft(project)],
          rejectedDraftCount: 0,
        }),
      registry: { load: vi.fn(() => Promise.resolve(readySnapshot([project]))) },
    }).read({ projectId: project.id }),
  );
  const value = (rendered["project"] as Record<string, unknown>)["displayName"];
  if (typeof value !== "string") throw new Error("display_name_missing_from_projection");
  return value;
}

describe("T05 registration draft discovery", () => {
  it("scans exact draft filenames deterministically, rejects malformed/mismatched/symlink drafts, and never exposes their path", async () => {
    const home = await root();
    const directory = join(home, "config", "registration");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `${projectTwo.id}.draft.json`),
      JSON.stringify(draftEnvelope(projectTwo)),
    );
    await writeFile(
      join(directory, `${projectOne.id}.draft.json`),
      JSON.stringify(draftEnvelope(projectOne)),
    );
    await writeFile(
      join(directory, "mismatched.draft.json"),
      JSON.stringify(draftEnvelope(projectOne)),
    );
    await writeFile(join(directory, "malformed.draft.json"), "{ invalid json");
    await symlink(
      join(directory, `${projectOne.id}.draft.json`),
      join(directory, "linked.draft.json"),
    );
    await writeFile(join(directory, "not-a-draft.json"), "{ invalid json");

    const discovered = await listHostRegistrationSetupDrafts(home);

    expect(discovered).toMatchObject({ state: "available", rejectedDraftCount: 3 });
    if (discovered.state === "available") {
      expect(discovered.drafts.map((candidate) => candidate.project.id)).toEqual([
        projectOne.id,
        projectTwo.id,
      ]);
      for (const rejectedName of [
        "mismatched.draft.json",
        "malformed.draft.json",
        "linked.draft.json",
      ]) {
        expect(JSON.stringify(discovered)).not.toContain(rejectedName);
      }
    }
  });

  it("fails closed when the registration directory cannot be enumerated", async () => {
    const home = await root();
    await mkdir(join(home, "config"), { recursive: true });
    await writeFile(join(home, "config", "registration"), "not a directory");

    await expect(listHostRegistrationSetupDrafts(home)).resolves.toEqual({
      state: "unavailable",
      drafts: [],
      rejectedDraftCount: 0,
    });
  });
});

describe("T05 project read model", () => {
  it("sorts list output, fails duplicate project ids closed, and degrades on rejected drafts", async () => {
    const duplicate = draft(projectOne);
    const result = await model({
      discoverDrafts: () =>
        Promise.resolve({
          state: "available",
          drafts: [draft(projectTwo), draft(projectOne), duplicate],
          rejectedDraftCount: 1,
        }),
      registry: {
        load: vi.fn(() => Promise.resolve(rejectedSnapshot(projectOne, "registry_conflict"))),
      },
    }).read({});
    const rendered = payload(result);

    expect(result.state).toBe("success");
    expect(rendered).toMatchObject({
      operation: "project_list",
      schemaVersion: 1,
      state: "degraded",
      inventory: { state: "available", rejectedDraftCount: 1 },
    });
    expect(
      (rendered["projects"] as readonly Record<string, unknown>[]).map((entry) => entry["id"]),
    ).toEqual([projectOne.id, projectTwo.id]);
    expect((rendered["projects"] as readonly Record<string, unknown>[])[0]).toMatchObject({
      displayName: "[REDACTED]",
      registration: {
        state: "configuration_incomplete",
        reason: "registration_draft_conflict",
      },
    });
  });

  it.each([
    [readySnapshot(), "registered", "trusted_config_verified"],
    [
      rejectedSnapshot(projectOne, "activation_missing"),
      "configuration_incomplete",
      "activation_missing",
    ],
    [rejectedSnapshot(projectOne, "activation_unavailable"), "unknown", "activation_unavailable"],
  ] as const)("projects registration as %s", async (snapshot, state, reason) => {
    const result = await model({ registry: { load: vi.fn(() => Promise.resolve(snapshot)) } }).read(
      {
        projectId: projectOne.id,
      },
    );
    const rendered = payload(result);
    const registration = (rendered["project"] as Record<string, unknown>)["registration"];

    expect(result.state).toBe("success");
    expect(registration).toMatchObject({ state, reason });
    if (state === "registered") {
      expect(registration).toMatchObject({ trustedConfigRevision: "a".repeat(40) });
    } else {
      expect(registration).not.toHaveProperty("trustedConfigRevision");
    }
  });

  it("returns an explicit failed exit path for a detail lookup that is not discovered", async () => {
    const handler = createProjectHandler(model());
    const outcome = await handler({ projectId: projectTwo.id });

    expect(outcome.state).toBe("failed");
    expect(JSON.parse(outcome.message ?? "")).toEqual({
      operation: "project_detail",
      schemaVersion: 1,
      state: "failed",
      reason: "project_not_found",
    });
  });

  it("projects durable progress counts and only exposes the fixed requires_manual reason", async () => {
    const records = Object.freeze([
      progress(jobTwo, projectOne, issueTwo, {
        kind: "requires_manual",
        cause: {
          stage: "setup",
          reasonCode: "change_request_unavailable",
          attempts: { count: 1 },
        },
      }),
      progress(jobOne, projectOne, issueOne, { kind: "ci_waiting" }),
      progress(jobThree, projectOne, issueThree, { kind: "completed" }),
    ]);
    const result = await model({
      progress: { listAll: vi.fn(() => Promise.resolve(ok(records))) },
    }).read({ projectId: projectOne.id });
    const rendered = payload(result);
    const progressView = (rendered["project"] as Record<string, Record<string, unknown>>)[
      "progress"
    ];

    expect(progressView).toMatchObject({
      state: "available",
      counts: { resumable: 1, blocked: 1, terminal: 1, total: 3 },
      nonTerminal: [
        { jobId: jobOne, stage: "ci_waiting", updatedAt: observedAt },
        {
          jobId: jobTwo,
          stage: "requires_manual",
          updatedAt: observedAt,
          reasonCode: "change_request_unavailable",
        },
      ],
    });
    expect(JSON.stringify(progressView)).not.toContain("EXTERNAL-ISSUE-SECRET");
    expect(JSON.stringify(progressView)).not.toContain("provider-secret-model");
  });

  it("marks all progress unavailable instead of omitting a corrupt durable record", async () => {
    const home = await root();
    const directory = join(home, "state", "dispatch", "progress");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${jobOne}.json`), "{ invalid durable record");

    const result = await model({ progress: new FileJobProgressStore(directory) }).read({
      projectId: projectOne.id,
    });
    const rendered = payload(result);

    expect((rendered["project"] as Record<string, unknown>)["progress"]).toEqual({
      state: "unavailable",
      reason: "durable_progress_unavailable",
    });
  });

  it("counts active and expired leases by Job ownership with an injected clock", async () => {
    const result = await model({
      jobs: {
        readAll: vi.fn(() =>
          Promise.resolve(
            ok(
              Object.freeze([
                job(jobOne, projectOne, issueOne),
                job(jobTwo, projectOne, issueTwo),
                job(jobThree, projectTwo, issueThree),
              ]),
            ),
          ),
        ),
      },
      leases: {
        readAll: vi.fn(() =>
          Promise.resolve(
            ok(
              Object.freeze([
                lease(
                  "lease_018f47d2-77a4-7cc1-8ef2-012345678901",
                  jobOne,
                  issueOne,
                  "2026-08-11T12:01:00.000Z",
                ),
                lease(
                  "lease_018f47d2-77a4-7cc1-8ef2-012345678902",
                  jobTwo,
                  issueTwo,
                  "2026-08-11T11:59:00.000Z",
                ),
                lease(
                  "lease_018f47d2-77a4-7cc1-8ef2-012345678903",
                  jobThree,
                  issueThree,
                  "2026-08-11T12:01:00.000Z",
                ),
              ]),
            ),
          ),
        ),
      },
    }).read({ projectId: projectOne.id });
    const rendered = payload(result);

    expect((rendered["project"] as Record<string, unknown>)["leases"]).toEqual({
      state: "available",
      observedAt,
      counts: { active: 1, expired: 1 },
    });
  });

  it("does not report a zero lease count when a lease cannot be attributed to a Job", async () => {
    const result = await model({
      jobs: { readAll: vi.fn(() => Promise.resolve(ok(Object.freeze([])))) },
      leases: {
        readAll: vi.fn(() =>
          Promise.resolve(
            ok(
              Object.freeze([
                lease(
                  "lease_018f47d2-77a4-7cc1-8ef2-012345678904",
                  jobMissing,
                  issueOne,
                  "2026-08-11T12:01:00.000Z",
                ),
              ]),
            ),
          ),
        ),
      },
    }).read({ projectId: projectOne.id });
    const rendered = payload(result);

    expect((rendered["project"] as Record<string, unknown>)["leases"]).toEqual({
      state: "unknown",
      reason: "lease_unassigned",
    });
    const listed = payload(
      await model({
        jobs: { readAll: vi.fn(() => Promise.resolve(ok(Object.freeze([])))) },
        leases: {
          readAll: vi.fn(() =>
            Promise.resolve(
              ok(
                Object.freeze([
                  lease(
                    "lease_018f47d2-77a4-7cc1-8ef2-012345678904",
                    jobMissing,
                    issueOne,
                    "2026-08-11T12:01:00.000Z",
                  ),
                ]),
              ),
            ),
          ),
        },
      }).read({}),
    );
    expect((listed["projects"] as readonly Record<string, unknown>[])[0]).toMatchObject({
      activeLeaseCount: null,
    });
  });

  it("keeps quota and wakeup honest, and white-list serialization excludes host and provider data", async () => {
    const sensitiveDisplay = projectSchema.parse({
      ...projectOne,
      displayName: "github_pat_abcdefghijklmnopqrstuvwxyz123456",
    });
    const result = await model({
      discoverDrafts: () =>
        Promise.resolve({
          state: "available",
          drafts: [draft(sensitiveDisplay)],
          rejectedDraftCount: 0,
        }),
      registry: { load: vi.fn(() => Promise.resolve(readySnapshot([sensitiveDisplay]))) },
    }).read({ projectId: sensitiveDisplay.id });
    const rendered = payload(result);
    const project = rendered["project"] as Record<string, unknown>;
    const text = JSON.stringify(rendered);

    expect(project["displayName"]).toBe("[REDACTED]");
    expect(project["quota"]).toEqual({ state: "unknown", reason: "collector_unavailable" });
    expect(project["wakeup"]).toEqual({
      state: "degraded",
      mode: "manual_reconcile_only",
      capabilities: { scheduledReconcile: false, eventDrivenIngress: false, unattended: false },
      sources: {
        systemd: { state: "unknown", evidenceCode: "systemd_status_unknown" },
        webhook: { state: "unknown", evidenceCode: "webhook_runtime_unknown" },
      },
      evidenceCodes: [
        "systemd_status_unknown",
        "webhook_runtime_unknown",
        "manual_reconcile_required",
      ],
    });
    for (const forbidden of [
      "project-read-alpha-secret-host-path",
      "team-secret",
      "owner/alpha-private",
      "github_pat_abcdefghijklmnopqrstuvwxyz123456",
      "AUDIT-SECRET-1",
      "token=",
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("projects a shared active systemd reader as scheduled-only and fails closed on bad reads", async () => {
    const activeReader = { readWakeupState: vi.fn(() => Promise.resolve("active" as const)) };
    const activeResult = await model({ wakeupReader: activeReader }).read({
      projectId: projectOne.id,
    });
    const activePayload = payload(activeResult);
    const activeWakeup = (activePayload["project"] as Record<string, unknown>)["wakeup"];

    expect(activeReader.readWakeupState).toHaveBeenCalledTimes(1);
    expect(activeWakeup).toEqual({
      state: "degraded",
      mode: "scheduled_reconcile_only",
      capabilities: { scheduledReconcile: true, eventDrivenIngress: false, unattended: false },
      sources: {
        systemd: { state: "available", evidenceCode: "systemd_timer_active" },
        webhook: { state: "unknown", evidenceCode: "webhook_runtime_unknown" },
      },
      evidenceCodes: [
        "systemd_timer_active",
        "webhook_runtime_unknown",
        "manual_reconcile_required",
      ],
    });

    const malformedReader = {
      readWakeupState: vi.fn(() => Promise.resolve("not-a-systemd-state" as never)),
    };
    const malformed = await model({ wakeupReader: malformedReader }).read({
      projectId: projectOne.id,
    });
    const throwingReader = {
      readWakeupState: vi.fn(() => Promise.reject(new Error("project-wakeup-reader-secret"))),
    };
    const thrown = await model({ wakeupReader: throwingReader }).read({ projectId: projectOne.id });

    for (const result of [malformed, thrown]) {
      const text = serializeProjectPayload(result.payload);
      expect(JSON.parse(text)).toMatchObject({
        project: { wakeup: { mode: "manual_reconcile_only" } },
      });
      expect(text).not.toContain("project-wakeup-reader-secret");
    }
  });

  it("accepts the evaluator's complete wakeup matrix at the sole project serializer boundary", async () => {
    const rendered = payload(await model().read({ projectId: projectOne.id }));

    for (const systemd of registrationSystemdWakeupStates) {
      for (const webhook of registrationWebhookWakeupStates) {
        const candidate = structuredClone(rendered);
        const project = candidate["project"] as Record<string, unknown>;
        project["wakeup"] = evaluateRegistrationWakeupHealth({ systemd, webhook });

        expect(() => serializeProjectPayload(candidate)).not.toThrow();
      }
    }
  });

  it("rejects every scheduled-only capability and evidence forgery at the serializer boundary", async () => {
    const rendered = payload(
      await model({
        wakeupReader: { readWakeupState: vi.fn(() => Promise.resolve("active" as const)) },
      }).read({ projectId: projectOne.id }),
    );
    const forge = (mutate: (wakeup: Record<string, unknown>) => void): Record<string, unknown> => {
      const candidate = structuredClone(rendered);
      const project = candidate["project"] as Record<string, unknown>;
      const wakeup = project["wakeup"] as Record<string, unknown>;
      mutate(wakeup);
      return candidate;
    };

    const cases: readonly [string, Record<string, unknown>][] = [
      [
        "scheduled reconcile disabled",
        forge((wakeup) => {
          (wakeup["capabilities"] as Record<string, unknown>)["scheduledReconcile"] = false;
        }),
      ],
      [
        "event ingress enabled",
        forge((wakeup) => {
          (wakeup["capabilities"] as Record<string, unknown>)["eventDrivenIngress"] = true;
        }),
      ],
      [
        "unattended enabled",
        forge((wakeup) => {
          (wakeup["capabilities"] as Record<string, unknown>)["unattended"] = true;
        }),
      ],
      [
        "systemd evidence changed",
        forge((wakeup) => {
          ((wakeup["sources"] as Record<string, unknown>)["systemd"] as Record<string, unknown>)[
            "evidenceCode"
          ] = "systemd_timer_inactive";
        }),
      ],
      [
        "webhook evidence changed",
        forge((wakeup) => {
          ((wakeup["sources"] as Record<string, unknown>)["webhook"] as Record<string, unknown>)[
            "evidenceCode"
          ] = "webhook_runtime_verified";
        }),
      ],
      [
        "evidence order changed",
        forge((wakeup) => {
          wakeup["evidenceCodes"] = [
            "webhook_runtime_unknown",
            "systemd_timer_active",
            "manual_reconcile_required",
          ];
        }),
      ],
      [
        "evidence content changed",
        forge((wakeup) => {
          wakeup["evidenceCodes"] = [
            "systemd_timer_active",
            "webhook_runtime_unknown",
            "unattended_wakeup_available",
          ];
        }),
      ],
      [
        "healthy state asserted",
        forge((wakeup) => {
          wakeup["state"] = "healthy";
        }),
      ],
    ];

    for (const [name, malformed] of cases) {
      expect(() => serializeProjectPayload(malformed), name).toThrow(
        "invalid_registration_wakeup_projection",
      );
    }
  });

  it("keeps a scheduled-only projection distinct from all other evaluator modes", () => {
    const modes = new Set(
      registrationSystemdWakeupStates.flatMap((systemd) =>
        registrationWebhookWakeupStates.map(
          (webhook) => evaluateRegistrationWakeupHealth({ systemd, webhook }).mode,
        ),
      ),
    );

    expect([...modes].sort()).toEqual([
      "event_ingest_only",
      "manual_reconcile_only",
      "scheduled_reconcile_only",
      "unattended",
    ]);
  });

  it.each([
    "API key: opaque-value",
    "api_key=opaque-value",
    "API-key : opaque-value",
    "token : opaque-value",
    "cookie=opaque-value",
    "signature : opaque-value",
  ])("redacts a secret-like display name assignment: %s", async (displayName) => {
    await expect(projectedDisplayName(displayName)).resolves.toBe("[REDACTED]");
  });

  it.each([
    "Alpha Sandbox",
    "API key rotation plan",
    "Token lifecycle planning",
    "Cookie policy review",
    "Signature verification checklist",
  ])("preserves an ordinary display name: %s", async (displayName) => {
    await expect(projectedDisplayName(displayName)).resolves.toBe(displayName);
  });

  it.each([
    [
      "Job",
      { jobs: { readAll: vi.fn(() => Promise.resolve(err(domainError("external_failure")))) } },
    ],
    [
      "Lease",
      { leases: { readAll: vi.fn(() => Promise.resolve(err(domainError("external_failure")))) } },
    ],
  ] as const)(
    "marks %s store failure unavailable without leaking a DomainError",
    async (_, override) => {
      const result = await model(override).read({ projectId: projectOne.id });
      const text = serializeProjectPayload(result.payload);

      expect(JSON.parse(text)).toMatchObject({
        state: "degraded",
        project: { leases: { state: "unavailable", reason: "lease_inventory_unavailable" } },
      });
      expect(text).not.toContain("external_failure");
    },
  );
});
