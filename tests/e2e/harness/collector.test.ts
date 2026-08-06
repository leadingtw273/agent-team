/**
 * E005 unit tests: the core "collect from four sources, missing any one means not_green" rule,
 * against fake ports satisfying `EvidenceCollectorPorts` directly (no real Linear/GitHub/
 * filesystem access at all). The real production wiring (ports.ts) is covered separately by the
 * integration test (real local event store + checkpoint fixture + fake external transport) and
 * the optional local-only sandbox smoke test.
 */
import { describe, expect, it } from "vitest";

import { createFixedClock } from "../../../src/domain/foundation/index.js";
import { collectEvidence, type EvidenceCollectorPorts } from "./collector.js";
import { evidenceCaseDescriptionSchema, type EvidenceCaseDescription } from "./case.js";
import { evidenceBundleSchema, evidenceSourceNames } from "./schema.js";

const fixedNow = "2026-08-06T12:00:00.000Z" as never;

function baseCase(overrides: Partial<EvidenceCaseDescription> = {}): EvidenceCaseDescription {
  return evidenceCaseDescriptionSchema.parse({
    caseId: "E101",
    runId: "run-e101-001",
    timeWindow: { from: "2026-08-06T00:00:00.000Z", to: "2026-08-06T23:59:59.999Z" },
    linear: { teamId: "team-1", projectId: "linear-project-1", issueId: "issue-e101" },
    github: {
      repository: "owner/sandbox",
      pullRequestNumber: 42,
      headSha: "a".repeat(40),
    },
    ...overrides,
  });
}

function allGreenPorts(): EvidenceCollectorPorts {
  return {
    linear: {
      read: () =>
        Promise.resolve({
          ok: true,
          data: {
            issueId: "issue-e101",
            identifier: "AGT-101",
            title: "Sample issue",
            workStatus: "in_review",
            updatedAt: "2026-08-06T10:00:00.000Z",
            comments: [
              { id: "comment-1", body: "Looks good", createdAt: "2026-08-06T10:05:00.000Z" },
            ],
          },
        }),
    },
    github: {
      read: () =>
        Promise.resolve({
          ok: true,
          data: {
            pullRequest: {
              number: 42,
              state: "open",
              draft: false,
              headSha: "a".repeat(40),
              baseBranch: "main",
              headBranch: "task/agt-101",
              url: "https://github.test/owner/sandbox/pull/42",
              mergeability: "mergeable",
              autoMergeEnabled: false,
            },
            checks: {
              headSha: "a".repeat(40),
              aggregate: "success",
              checks: [{ name: "CI", status: "completed", conclusion: "success" }],
            },
            statuses: {
              headSha: "a".repeat(40),
              statuses: [{ context: "agent-team/review", state: "success" }],
            },
          },
        }),
    },
    localEvents: {
      read: () =>
        Promise.resolve({
          ok: true,
          data: {
            events: [
              {
                eventId: "event_018f47d2-0000-4000-8000-000000000010",
                eventType: "job.completed",
                occurredAt: "2026-08-06T11:00:00.000Z",
                correlationId: "run-e101-001",
                subjectKind: "job",
                subjectId: "job-1",
              },
            ],
            inboxRecords: [
              {
                provider: "github",
                deliveryId: "delivery-1",
                eventType: "pull_request",
                receivedAt: "2026-08-06T09:00:00.000Z",
              },
            ],
          },
        }),
    },
    checkpoints: {
      read: () =>
        Promise.resolve({
          ok: true,
          data: {
            checkpoints: [
              {
                id: "checkpoint_018f47d2-0000-4000-8000-000000000020",
                projectId: "project-1",
                issueId: "issue-e101",
                jobId: "job-1",
                createdAt: "2026-08-06T08:00:00.000Z",
                reason: "manual",
              },
            ],
          },
        }),
    },
  };
}

describe("collectEvidence: all four sources present", () => {
  it("is green, produces a schema-valid bundle, and every present source carries a collectedAt timestamp", async () => {
    const outcome = await collectEvidence(baseCase(), allGreenPorts(), {
      clock: createFixedClock(fixedNow),
    });

    expect(outcome.state).toBe("green");
    const parsed = evidenceBundleSchema.parse(outcome.bundle);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.caseId).toBe("E101");
    expect(parsed.runId).toBe("run-e101-001");
    for (const name of evidenceSourceNames) {
      expect(parsed[name].status).toBe("present");
      expect(parsed[name].collectedAt).toBe(fixedNow);
    }
    // SHA fields (GitHub) and timestamp fields (every source) are present and well-formed --
    // the exact fields E007's later cross-source reconciliation will need.
    if (parsed.github.status === "present") {
      expect(parsed.github.data.pullRequest.headSha).toMatch(/^[0-9a-f]{40}$/u);
      expect(parsed.github.data.checks.headSha).toMatch(/^[0-9a-f]{40}$/u);
    }
    if (parsed.linear.status === "present") {
      expect(parsed.linear.data.updatedAt).toBe("2026-08-06T10:00:00.000Z");
    }
  });
});

describe("collectEvidence: missing any single source means not_green (缺任一來源即不得綠)", () => {
  it.each(evidenceSourceNames)("is not_green when only %s is missing", async (missingSource) => {
    const ports = allGreenPorts();
    const failingPorts: EvidenceCollectorPorts = {
      ...ports,
      [missingSource]: { read: () => Promise.resolve({ ok: false, reason: "not_found" }) },
    };

    const outcome = await collectEvidence(baseCase(), failingPorts, {
      clock: createFixedClock(fixedNow),
    });

    expect(outcome.state).toBe("not_green");
    if (outcome.state === "not_green") {
      expect(outcome.missingSources).toEqual([missingSource]);
      expect(outcome.bundle[missingSource]).toMatchObject({
        status: "missing",
        reason: "not_found",
        collectedAt: fixedNow,
      });
      // Every *other* source must still be independently, fully collected -- a single miss must
      // never short-circuit or hide the rest of the bundle.
      for (const other of evidenceSourceNames) {
        if (other === missingSource) continue;
        expect(outcome.bundle[other].status).toBe("present");
      }
    }
  });

  it("is not_green with all four sources listed when every source is missing", async () => {
    const failingPorts: EvidenceCollectorPorts = {
      linear: { read: () => Promise.resolve({ ok: false, reason: "read_error" }) },
      github: { read: () => Promise.resolve({ ok: false, reason: "read_error" }) },
      localEvents: { read: () => Promise.resolve({ ok: false, reason: "empty_result" }) },
      checkpoints: { read: () => Promise.resolve({ ok: false, reason: "empty_result" }) },
    };

    const outcome = await collectEvidence(baseCase(), failingPorts, {
      clock: createFixedClock(fixedNow),
    });

    expect(outcome.state).toBe("not_green");
    if (outcome.state === "not_green") {
      expect(new Set(outcome.missingSources)).toEqual(new Set(evidenceSourceNames));
    }
  });

  it("never fabricates a present source when a port throws instead of returning {ok:false}", async () => {
    const ports = allGreenPorts();
    const throwingPorts: EvidenceCollectorPorts = {
      ...ports,
      github: {
        read: () => Promise.reject(new Error("simulated transport crash")),
      },
    };

    const outcome = await collectEvidence(baseCase(), throwingPorts, {
      clock: createFixedClock(fixedNow),
    });

    expect(outcome.state).toBe("not_green");
    if (outcome.state === "not_green") {
      expect(outcome.missingSources).toEqual(["github"]);
      expect(outcome.bundle.github).toMatchObject({ status: "missing", reason: "read_error" });
    }
  });
});
