/**
 * E010a live case (gated, off by default): runs `runStandardHappyPathCase` against
 * `buildProductionCaseRunnerPorts` -- the real CLI subprocess (`node dist/cli/index.js run
 * --project ...`), real `gh`-backed CI polling, a real timer, and E005's real Linear/GitHub
 * evidence adapters. This is the template a future E102/E103 ticket's own live case file is meant
 * to copy, and this ticket's own demonstration of the "live case 必須環境變數 gate" requirement
 * (docs already established by E005's sandbox-smoke.test.ts, same `describe.skipIf` convention).
 *
 * Deliberately never run for real by this ticket's own author: every required environment
 * variable below is left unset in this repository's own test run (and in CI), so this file always
 * takes the `disabled` branch. Running it for real requires a built `dist/cli/index.js`
 * (`pnpm build` -- this ticket is explicitly forbidden from running that itself), a real sandbox
 * project already registered (E004), a `gh`-authenticated shell, and a real `LINEAR_API_KEY` --
 * see `/home/markchou/.claude/jobs/6152588f/tmp/e101-cycle2.sh` for the exact manual sequence this
 * automates, including realistic values for every variable below.
 *
 * To run: set every `E010A_LIVE_*` variable, `E2E_LIVE=1`, and `LINEAR_API_KEY`, then invoke this
 * file directly, e.g.
 *   E2E_LIVE=1 LINEAR_API_KEY=... \
 *   E010A_LIVE_REPOSITORY_ROOT=/home/markchou/project/agent-team \
 *   E010A_LIVE_AGENT_TEAM_HOME=/home/markchou/.agent-team \
 *   E010A_LIVE_PROJECT_ID=project_... E010A_LIVE_REPOSITORY=owner/agent-team-sandbox \
 *   E010A_LIVE_LINEAR_TEAM_ID=... E010A_LIVE_LINEAR_PROJECT_ID=... \
 *   E010A_LIVE_CASE_ID=E101 E010A_LIVE_CASE_RUN_ID=e2e-e101-<hex> \
 *   E010A_LIVE_TIME_WINDOW_FROM=2026-01-01T00:00:00.000Z E010A_LIVE_TIME_WINDOW_TO=2026-12-31T23:59:59.999Z \
 *     pnpm exec vitest run tests/e2e/harness/case-runner-live.test.ts
 */
import { describe, expect, it } from "vitest";

import { buildProductionCaseRunnerPorts, runStandardHappyPathCase } from "./case-runner.js";

const requiredEnvironmentKeys = [
  "E2E_LIVE",
  "LINEAR_API_KEY",
  "E010A_LIVE_REPOSITORY_ROOT",
  "E010A_LIVE_AGENT_TEAM_HOME",
  "E010A_LIVE_PROJECT_ID",
  "E010A_LIVE_REPOSITORY",
  "E010A_LIVE_LINEAR_TEAM_ID",
  "E010A_LIVE_LINEAR_PROJECT_ID",
  "E010A_LIVE_CASE_ID",
  "E010A_LIVE_CASE_RUN_ID",
  "E010A_LIVE_TIME_WINDOW_FROM",
  "E010A_LIVE_TIME_WINDOW_TO",
] as const;

const missingEnvironmentKeys = requiredEnvironmentKeys.filter((key) => {
  const value = process.env[key];
  return value === undefined || value.trim() === "";
});
const enabled = missingEnvironmentKeys.length === 0 && process.env["E2E_LIVE"] === "1";

describe.skipIf(!enabled)(
  "E010a live: the real CLI subprocess, real sandbox CI, real evidence adapters",
  () => {
    it(
      "drives one full standard happy-path Live E2E Case against a real registered sandbox project",
      async () => {
        const ports = buildProductionCaseRunnerPorts({
          repositoryRoot: process.env["E010A_LIVE_REPOSITORY_ROOT"] ?? "",
          agentTeamHome: process.env["E010A_LIVE_AGENT_TEAM_HOME"] ?? "",
          linearApiKey: process.env["LINEAR_API_KEY"] ?? "",
          repository: process.env["E010A_LIVE_REPOSITORY"] ?? "",
        });

        const outcome = await runStandardHappyPathCase(ports, {
          caseId: process.env["E010A_LIVE_CASE_ID"] ?? "",
          caseRunId: process.env["E010A_LIVE_CASE_RUN_ID"] ?? "",
          projectId: process.env["E010A_LIVE_PROJECT_ID"] ?? "",
          repository: process.env["E010A_LIVE_REPOSITORY"] ?? "",
          linear: {
            teamId: process.env["E010A_LIVE_LINEAR_TEAM_ID"] ?? "",
            projectId: process.env["E010A_LIVE_LINEAR_PROJECT_ID"] ?? "",
          },
          timeWindow: {
            from: process.env["E010A_LIVE_TIME_WINDOW_FROM"] ?? "",
            to: process.env["E010A_LIVE_TIME_WINDOW_TO"] ?? "",
          },
          requiredEventTypes: [],
        });

        console.log(
          `[E010a live] aborted=${String(outcome.aborted)}` +
            (outcome.aborted ? ` reason=${outcome.reason}` : ` verdict=${outcome.verdict}`),
        );
        expect(outcome.aborted).toBe(false);
        if (outcome.aborted) return;
        expect(outcome.verdict).toBe("green");
      },
      // Dispatch + CI poll (up to 10m) + lease wait (5.5m) + resume + evidence read-back.
      20 * 60_000,
    );
  },
);

describe.skipIf(enabled)("E010a live (disabled)", () => {
  it.skip(`skipped: set ${missingEnvironmentKeys.join(", ") || "E2E_LIVE=1"} to run this against a real sandbox`, () => {
    // Intentionally empty -- see sandbox-smoke.test.ts's own identical companion block for why
    // this exists: a named, discoverable "skipped" test explaining exactly what is missing,
    // instead of this live case simply vanishing from the report with no trace.
  });
});
