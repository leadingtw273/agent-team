import { describe, expect, it } from "vitest";

import type { DispatcherCandidate } from "../../src/application/dispatch/index.js";
import type { NewJobQuotaAdmissionPort } from "../../src/application/quota/index.js";
import type { ModelRoutingConfig } from "../../src/application/routing/index.js";
import {
  applyProviderLiveness,
  createFailClosedNewJobQuotaAdmission,
  observeQuotaRouteCandidates,
} from "../../src/cli/dispatch/quota-admission.js";

const routingConfig: ModelRoutingConfig = {
  schemaVersion: 1,
  routes: [
    { role: "team_lead", candidates: [{ provider: "claude", model: "lead" }] },
    {
      role: "implementer",
      candidates: [
        { provider: "claude", model: "opus" },
        { provider: "claude", model: "sonnet" },
        { provider: "codex", model: "gpt" },
      ],
    },
    { role: "code_reviewer", candidates: [{ provider: "claude", model: "review" }] },
    { role: "visual_reviewer", candidates: [{ provider: "gemini", model: "visual" }] },
    { role: "integration_engineer", candidates: [{ provider: "claude", model: "integrate" }] },
  ],
};

function candidate(issueId: string, role = "implementer"): DispatcherCandidate {
  return {
    issue: { id: issueId, agentRole: role } as DispatcherCandidate["issue"],
    readyAt: "2026-08-11T12:00:00.000Z",
    stage: "implementation",
    workKind: "model",
  };
}

describe("dispatch quota route admission", () => {
  it("resolves each Provider once across multiple models and issues", async () => {
    const calls = new Map<string, number>();
    const quota: NewJobQuotaAdmissionPort = {
      resolve(provider) {
        calls.set(provider, (calls.get(provider) ?? 0) + 1);
        return Promise.resolve({
          state: provider === "claude" ? ("quota_unknown" as const) : ("ready" as const),
          reason: "fixture",
        });
      },
    };

    const observations = await observeQuotaRouteCandidates({
      routingConfig,
      candidates: [candidate("issue-1"), candidate("issue-2")],
      quota,
    });

    expect(calls).toEqual(
      new Map([
        ["claude", 1],
        ["codex", 1],
      ]),
    );
    expect(observations).toEqual([
      { provider: "claude", model: "opus", state: "quota_unknown" },
      { provider: "claude", model: "sonnet", state: "quota_unknown" },
      { provider: "codex", model: "gpt", state: "ready" },
    ]);
  });

  it("preserves quota denial and requires liveness for quota-ready routes", () => {
    expect(
      applyProviderLiveness(
        [
          { provider: "claude", model: "opus", state: "quota_unknown" },
          { provider: "claude", model: "sonnet", state: "ready" },
          { provider: "codex", model: "gpt", state: "ready" },
        ],
        [
          { provider: "claude", model: "opus", state: "ready" },
          { provider: "claude", model: "sonnet", state: "ready" },
        ],
      ),
    ).toEqual([
      { provider: "claude", model: "opus", state: "quota_unknown" },
      { provider: "claude", model: "sonnet", state: "ready" },
      { provider: "codex", model: "gpt", state: "provider_unavailable" },
    ]);
  });

  it("keeps the production default fail-closed and turns rejected promises into unknown", async () => {
    await expect(createFailClosedNewJobQuotaAdmission().resolve("claude")).resolves.toEqual({
      state: "quota_unknown",
      reason: "collector_unavailable",
    });
    const observations = await observeQuotaRouteCandidates({
      routingConfig,
      candidates: [candidate("issue-1")],
      quota: { resolve: () => Promise.reject(new Error("untrusted raw failure")) },
    });
    expect(observations.every((observation) => observation.state === "quota_unknown")).toBe(true);
  });

  it("turns synchronous throws and malformed runtime decisions into quota_unknown", async () => {
    const malformed = [
      null,
      {},
      { state: "ready", reason: "" },
      { state: "invented", reason: "x" },
    ];
    for (const value of malformed) {
      const observations = await observeQuotaRouteCandidates({
        routingConfig,
        candidates: [candidate("issue-1")],
        quota: { resolve: () => Promise.resolve(value as never) },
      });
      expect(observations.every((observation) => observation.state === "quota_unknown")).toBe(true);
    }

    const observations = await observeQuotaRouteCandidates({
      routingConfig,
      candidates: [candidate("issue-1")],
      quota: {
        resolve() {
          throw new Error("synchronous collector failure");
        },
      },
    });
    expect(observations.every((observation) => observation.state === "quota_unknown")).toBe(true);
  });
});
