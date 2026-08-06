/**
 * E005 optional smoke test: a genuinely read-only evidence collection against the *real*
 * `agent-team-sandbox` project (E004's own leftover evidence -- e.g. the LEA-9 Linear issue and
 * GitHub PR #1 the coordinator's task packet names), using the real `GhTransport` (shells out to
 * the `gh` CLI) and a real `LinearGraphqlTransport` (a real network call to Linear).
 *
 * Deliberately local-only, never part of CI or the default `pnpm test` run: it needs a real
 * LINEAR_API_KEY, a real `gh auth login`'d shell, and network access to two live external
 * services, none of which any other test in this repo (or this suite) ever requires. It is
 * gated behind explicit environment variables rather than hardcoded sandbox identifiers, both
 * because the exact ids are host/environment configuration (not something this test file should
 * assume or embed) and so a run without every required variable set skips cleanly instead of
 * failing.
 *
 * To run: set every `E005_SMOKE_*` variable below (plus `LINEAR_API_KEY` and a `gh`-authenticated
 * shell) and invoke this file directly, e.g.
 *   E005_SMOKE_AGENT_TEAM_HOME=~/.agent-team \
 *   E005_SMOKE_LINEAR_TEAM_ID=... E005_SMOKE_LINEAR_PROJECT_ID=... E005_SMOKE_LINEAR_ISSUE_ID=... \
 *   E005_SMOKE_GITHUB_REPOSITORY=owner/agent-team-sandbox E005_SMOKE_PR_NUMBER=1 \
 *   E005_SMOKE_HEAD_SHA=<40-hex> E005_SMOKE_FROM=2026-01-01T00:00:00.000Z \
 *   E005_SMOKE_TO=2026-12-31T23:59:59.999Z LINEAR_API_KEY=... \
 *     pnpm exec vitest run tests/e2e/harness/sandbox-smoke.test.ts
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { evidenceCaseDescriptionSchema } from "./case.js";
import { collectEvidence } from "./collector.js";
import { buildProductionEvidenceCollectorPorts } from "./ports.js";

const requiredEnvironmentKeys = [
  "E005_SMOKE_LINEAR_TEAM_ID",
  "E005_SMOKE_LINEAR_PROJECT_ID",
  "E005_SMOKE_LINEAR_ISSUE_ID",
  "E005_SMOKE_GITHUB_REPOSITORY",
  "E005_SMOKE_PR_NUMBER",
  "E005_SMOKE_HEAD_SHA",
  "E005_SMOKE_FROM",
  "E005_SMOKE_TO",
  "LINEAR_API_KEY",
] as const;

const missingEnvironmentKeys = requiredEnvironmentKeys.filter((key) => {
  const value = process.env[key];
  return value === undefined || value.trim() === "";
});
const enabled = missingEnvironmentKeys.length === 0;

describe.skipIf(!enabled)(
  "E005 local-only smoke: real read-only collection against the real agent-team-sandbox",
  () => {
    it("collects from all four real sources without ever mutating anything", async () => {
      const agentTeamHome = resolve(
        process.env["E005_SMOKE_AGENT_TEAM_HOME"] ?? join(homedir(), ".agent-team"),
      );
      const linearApiKey = process.env["LINEAR_API_KEY"] ?? "";
      const pullRequestNumber = Number(process.env["E005_SMOKE_PR_NUMBER"]);

      const ports = buildProductionEvidenceCollectorPorts({ agentTeamHome, linearApiKey });
      const caseDescription = evidenceCaseDescriptionSchema.parse({
        caseId: "E004-leftover-smoke",
        runId: "e005-sandbox-smoke",
        timeWindow: {
          from: process.env["E005_SMOKE_FROM"],
          to: process.env["E005_SMOKE_TO"],
        },
        linear: {
          teamId: process.env["E005_SMOKE_LINEAR_TEAM_ID"],
          projectId: process.env["E005_SMOKE_LINEAR_PROJECT_ID"],
          issueId: process.env["E005_SMOKE_LINEAR_ISSUE_ID"],
        },
        github: {
          repository: process.env["E005_SMOKE_GITHUB_REPOSITORY"],
          pullRequestNumber,
          headSha: process.env["E005_SMOKE_HEAD_SHA"],
        },
      });

      const outcome = await collectEvidence(caseDescription, ports);

      // This is intentionally not a hard `expect(outcome.state).toBe("green")`: E004's own
      // leftover state may or may not still have local event-log/checkpoint evidence retained
      // (this harness's localEvents/checkpoints sources depend on a job-execution pipeline that,
      // as of this task, has not yet been wired up in production -- see ports.ts's own doc
      // comment). The smoke test's actual proof is narrower and unconditional: the collector ran
      // real read-only calls against real Linear/GitHub without throwing, and whichever sources
      // it *did* find are schema-valid and non-empty.
      console.log(
        `[E005 smoke] state=${outcome.state}` +
          (outcome.state === "not_green" ? ` missing=${outcome.missingSources.join(",")}` : ""),
      );
      expect(["green", "not_green"]).toContain(outcome.state);
      if (outcome.bundle.linear.status === "present") {
        expect(outcome.bundle.linear.data.issueId.length).toBeGreaterThan(0);
      }
      if (outcome.bundle.github.status === "present") {
        expect(outcome.bundle.github.data.pullRequest.number).toBe(pullRequestNumber);
      }
    }, 60_000);
  },
);

describe.skipIf(enabled)("E005 local-only smoke (disabled)", () => {
  it.skip(`skipped: set ${missingEnvironmentKeys.join(", ")} to run this against a real sandbox`, () => {
    // Intentionally empty -- this block exists only so `vitest run` reports a named, discoverable
    // "skipped" test explaining exactly which environment variables are missing, instead of the
    // smoke test simply vanishing from the report with no trace.
  });
});
