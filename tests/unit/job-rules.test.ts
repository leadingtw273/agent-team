import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  parseIdentifier,
  parseInstant,
  type Identifier,
  type Instant,
} from "../../src/domain/foundation/index.js";
import {
  attemptLimits,
  canAcquireLease,
  canConsumeAttempt,
  consumeAttempt,
  emptyAttemptCounters,
  evaluateWatchdog,
  grantWatchdogExtension,
  jobJsonSchema,
  jobSchema,
  leaseJsonSchema,
  leaseSchema,
  leaseState,
  progressEvidenceKinds,
  type AttemptKind,
  type JobAttemptCounters,
  type Lease,
} from "../../src/domain/jobs/index.js";

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8"),
  ) as unknown;
}

function instant(value: string): Instant {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function id<Scope extends string>(scope: Scope, value: string): Identifier<Scope> {
  const parsed = parseIdentifier(scope, value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function lease(overrides: Partial<Lease> = {}): Lease {
  return leaseSchema.parse({
    schemaVersion: 1,
    id: "lease_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    jobId: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    issueId: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    holderId: "controller-1",
    acquiredAt: "2026-08-04T12:00:00.000Z",
    expiresAt: "2026-08-04T12:05:00.000Z",
    ...overrides,
  });
}

function consumeRepeatedly(kind: AttemptKind, times: number): JobAttemptCounters {
  let counters = emptyAttemptCounters();
  for (let index = 0; index < times; index += 1) {
    const result = consumeAttempt(counters, kind);
    if (!result.ok) throw new Error(result.error.code);
    counters = result.value;
  }
  return counters;
}

describe("job schema and attempt budgets", () => {
  it("accepts the committed job fixture and rejects unknown fields", async () => {
    const fixture = await readJson("fixtures/domain/job-v1.valid.json");
    expect(jobSchema.parse(fixture)).toEqual(fixture);
    expect(jobSchema.safeParse({ ...(fixture as object), surprise: true }).success).toBe(false);
  });

  it("rejects a Job start before its creation", async () => {
    const fixture = (await readJson("fixtures/domain/job-v1.valid.json")) as object;
    expect(jobSchema.safeParse({ ...fixture, startedAt: "2026-08-04T11:59:59.999Z" }).success).toBe(
      false,
    );
  });

  it.each([
    ["processRecoveries", 1],
    ["ciFixRounds", 2],
    ["reviewerFixRounds", 2],
    ["reviewRuns", 3],
  ] as const)("allows %s up to %i and rejects the next attempt", (kind, limit) => {
    expect(attemptLimits[kind]).toBe(limit);
    const exhausted = consumeRepeatedly(kind, limit);
    expect(exhausted[kind]).toBe(limit);
    expect(canConsumeAttempt(exhausted, kind)).toBe(false);
    expect(consumeAttempt(exhausted, kind)).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
  });

  it("keeps CI and Reviewer counters independent", () => {
    const ciExhausted = consumeRepeatedly("ciFixRounds", 2);
    expect(canConsumeAttempt(ciExhausted, "reviewerFixRounds")).toBe(true);
    expect(canConsumeAttempt(ciExhausted, "reviewRuns")).toBe(true);
  });
});

describe("lease rules", () => {
  const now = instant("2026-08-04T12:02:00.000Z");
  const target = {
    jobId: id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab"),
    issueId: id("issue", "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab"),
  };

  it("prevents a second active lease for the same Job or Issue", () => {
    const active = lease();
    expect(leaseState(active, now)).toBe("active");
    expect(canAcquireLease([active], target, now)).toBe(false);
    expect(
      canAcquireLease(
        [
          lease({
            jobId: id("job", "job_018f47d2-77a4-7cc1-8ef2-1123456789ab"),
          }),
        ],
        target,
        now,
      ),
    ).toBe(false);
    expect(
      canAcquireLease(
        [
          lease({
            issueId: id("issue", "issue_018f47d2-77a4-7cc1-8ef2-1123456789ab"),
          }),
        ],
        target,
        now,
      ),
    ).toBe(false);
  });

  it("allows acquisition after release or expiry", () => {
    const released = lease({ releasedAt: instant("2026-08-04T12:01:00.000Z") });
    const expired = lease({ expiresAt: instant("2026-08-04T12:02:00.000Z") });
    expect(leaseState(released, now)).toBe("released");
    expect(leaseState(expired, now)).toBe("expired");
    expect(canAcquireLease([released, expired], target, now)).toBe(true);
  });

  it("does not treat a future release timestamp as already released", () => {
    const futureRelease = lease({ releasedAt: instant("2026-08-04T12:03:00.000Z") });
    expect(leaseState(futureRelease, now)).toBe("active");
    expect(canAcquireLease([futureRelease], target, now)).toBe(false);
  });

  it("rejects invalid lease chronology", () => {
    expect(
      leaseSchema.safeParse({
        ...lease(),
        expiresAt: "2026-08-04T12:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      leaseSchema.safeParse({
        ...lease(),
        releasedAt: "2026-08-04T11:59:59.000Z",
      }).success,
    ).toBe(false);
  });
});

describe("45/60 minute watchdog", () => {
  const startedAt = instant("2026-08-04T12:00:00.000Z");

  it("continues before 45 minutes and requests inspection at 45", () => {
    expect(
      evaluateWatchdog({
        startedAt,
        now: instant("2026-08-04T12:44:59.999Z"),
        extensionGranted: false,
      }),
    ).toEqual({ ok: true, value: "continue" });
    expect(
      evaluateWatchdog({
        startedAt,
        now: instant("2026-08-04T12:45:00.000Z"),
        extensionGranted: false,
      }),
    ).toEqual({ ok: true, value: "inspection_required" });
  });

  it("extends once only when effective progress exists and finishing is cheaper", () => {
    expect(progressEvidenceKinds).not.toContain("heartbeat");
    expect(
      evaluateWatchdog({
        startedAt,
        now: instant("2026-08-04T12:45:00.000Z"),
        extensionGranted: false,
        inspection: {
          effectiveProgress: ["test_or_build_milestone"],
          originalAgentCompletionCheaper: true,
        },
      }),
    ).toEqual({ ok: true, value: "continue_once_extended" });
    expect(
      evaluateWatchdog({
        startedAt,
        now: instant("2026-08-04T12:45:00.000Z"),
        extensionGranted: false,
        inspection: { effectiveProgress: [], originalAgentCompletionCheaper: true },
      }),
    ).toEqual({ ok: true, value: "checkpoint_and_replan" });
    expect(
      evaluateWatchdog({
        startedAt,
        now: instant("2026-08-04T12:45:00.000Z"),
        extensionGranted: false,
        inspection: {
          effectiveProgress: ["test_or_build_milestone"],
          originalAgentCompletionCheaper: false,
        },
      }),
    ).toEqual({ ok: true, value: "checkpoint_and_replan" });
  });

  it("rejects runtime evidence outside the effective-progress whitelist", () => {
    const result = evaluateWatchdog({
      startedAt,
      now: instant("2026-08-04T12:45:00.000Z"),
      extensionGranted: false,
      inspection: {
        effectiveProgress: ["heartbeat"],
        originalAgentCompletionCheaper: true,
      },
    } as unknown as Parameters<typeof evaluateWatchdog>[0]);
    expect(result).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("persists a watchdog extension at most once", async () => {
    const fixture = jobSchema.parse(await readJson("fixtures/domain/job-v1.valid.json"));
    const granted = grantWatchdogExtension(fixture, "continue_once_extended");
    expect(granted).toMatchObject({
      ok: true,
      value: { watchdogExtensionGranted: true },
    });
    if (!granted.ok) throw new Error(granted.error.code);
    expect(grantWatchdogExtension(granted.value, "continue_once_extended")).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(grantWatchdogExtension(fixture, "inspection_required")).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
  });

  it("hard-stops at 60 minutes even when an extension was granted", () => {
    expect(
      evaluateWatchdog({
        startedAt,
        now: instant("2026-08-04T13:00:00.000Z"),
        extensionGranted: true,
      }),
    ).toEqual({ ok: true, value: "checkpoint_hard_stop" });
  });

  it("rejects a clock reading before the Job start", () => {
    expect(
      evaluateWatchdog({
        startedAt,
        now: instant("2026-08-04T11:59:59.999Z"),
        extensionGranted: false,
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});

describe("committed job schemas", () => {
  it("keeps Job and Lease JSON Schemas synchronized with Zod", async () => {
    await expect(readJson("schemas/job-v1.json")).resolves.toEqual(jobJsonSchema);
    await expect(readJson("schemas/lease-v1.json")).resolves.toEqual(leaseJsonSchema);
  });
});
