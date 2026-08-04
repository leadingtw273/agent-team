import { describe, expect, it } from "vitest";

import {
  modelRoutingConfigSchema,
  retainActiveModelAssignment,
  selectModelRoute,
  type CandidateObservation,
} from "../../src/application/routing/index.js";

function config() {
  return {
    schemaVersion: 1,
    routes: [
      {
        role: "team_lead",
        candidates: [
          { provider: "codex", model: "gpt-5.6-sol" },
          { provider: "claude", model: "opus" },
        ],
      },
      {
        role: "implementer",
        candidates: [
          { provider: "codex", model: "gpt-5.6-terra" },
          { provider: "claude", model: "sonnet" },
        ],
      },
      {
        role: "code_reviewer",
        candidates: [
          { provider: "codex", model: "gpt-5.6-sol" },
          { provider: "claude", model: "opus" },
        ],
      },
      {
        role: "visual_reviewer",
        candidates: [
          { provider: "gemini", model: "auto" },
          { provider: "codex", model: "gpt-5.6-sol" },
        ],
      },
      {
        role: "integration_engineer",
        candidates: [
          { provider: "codex", model: "gpt-5.6-sol" },
          { provider: "claude", model: "opus" },
        ],
      },
    ],
  } as const;
}

function observation(
  provider: "codex" | "claude" | "gemini",
  model: string,
  state: CandidateObservation["state"],
): CandidateObservation {
  return { provider, model, state };
}

describe("ordered model routing", () => {
  it("selects the primary when it is ready", () => {
    expect(
      selectModelRoute(config(), "implementer", [
        observation("codex", "gpt-5.6-terra", "ready"),
        observation("claude", "sonnet", "ready"),
      ]),
    ).toEqual({
      kind: "selected",
      role: "implementer",
      candidate: { provider: "codex", model: "gpt-5.6-terra" },
      candidateIndex: 0,
      fallbackUsed: false,
      skipped: [],
    });
  });

  it.each([
    "provider_unavailable",
    "provider_slot_full",
    "quota_blocked",
    "quota_unknown",
  ] as const)("uses the next candidate when the primary is %s", (state) => {
    expect(
      selectModelRoute(config(), "implementer", [
        observation("codex", "gpt-5.6-terra", state),
        observation("claude", "sonnet", "ready"),
      ]),
    ).toMatchObject({
      kind: "selected",
      candidate: { provider: "claude", model: "sonnet" },
      candidateIndex: 1,
      fallbackUsed: true,
      skipped: [{ provider: "codex", model: "gpt-5.6-terra", index: 0, state }],
    });
  });

  it("keeps the active fallback assignment after the primary recovers", () => {
    const fallback = selectModelRoute(config(), "implementer", [
      observation("codex", "gpt-5.6-terra", "provider_unavailable"),
      observation("claude", "sonnet", "ready"),
    ]);
    if (fallback.kind !== "selected") throw new Error("expected fallback");
    const active = retainActiveModelAssignment({
      jobId: "job-existing",
      role: fallback.role,
      candidate: fallback.candidate,
      candidateIndex: fallback.candidateIndex,
    });
    const nextJob = selectModelRoute(config(), "implementer", [
      observation("codex", "gpt-5.6-terra", "ready"),
      observation("claude", "sonnet", "ready"),
    ]);

    expect(active.candidate).toEqual({ provider: "claude", model: "sonnet" });
    expect(nextJob).toMatchObject({
      kind: "selected",
      candidate: { provider: "codex", model: "gpt-5.6-terra" },
    });
  });

  it("waits without selecting or consuming a slot when no candidate is eligible", () => {
    expect(
      selectModelRoute(config(), "implementer", [
        observation("codex", "gpt-5.6-terra", "provider_slot_full"),
        observation("claude", "sonnet", "quota_unknown"),
      ]),
    ).toMatchObject({
      kind: "waiting",
      reason: "no_eligible_candidate",
      skipped: [{ state: "provider_slot_full" }, { state: "quota_unknown" }],
    });
  });

  it("requires every role once, unique candidates, and visual-only Gemini", () => {
    expect(modelRoutingConfigSchema.safeParse(config()).success).toBe(true);
    const duplicateRole = {
      ...config(),
      routes: [...config().routes.slice(0, 4), config().routes[0]],
    };
    expect(modelRoutingConfigSchema.safeParse(duplicateRole).success).toBe(false);

    const invalidGemini = {
      ...config(),
      routes: config().routes.map((route, index) =>
        index === 1 ? { ...route, candidates: [{ provider: "gemini", model: "auto" }] } : route,
      ),
    };
    expect(modelRoutingConfigSchema.safeParse(invalidGemini).success).toBe(false);

    const duplicateCandidate = {
      ...config(),
      routes: config().routes.map((route, index) =>
        index === 0
          ? {
              ...route,
              candidates: [
                { provider: "codex", model: "gpt-5.6-sol" },
                { provider: "codex", model: "gpt-5.6-sol" },
              ],
            }
          : route,
      ),
    };
    expect(modelRoutingConfigSchema.safeParse(duplicateCandidate).success).toBe(false);
  });

  it("fails closed for invalid config and missing observations", () => {
    expect(selectModelRoute({}, "implementer", [])).toMatchObject({
      kind: "waiting",
      reason: "invalid_config",
    });
    expect(selectModelRoute(config(), "implementer", [])).toMatchObject({
      kind: "waiting",
      reason: "no_eligible_candidate",
      skipped: [{ state: "observation_missing" }, { state: "observation_missing" }],
    });
    expect(
      selectModelRoute(config(), "implementer", [
        observation("codex", "gpt-5.6-terra", "ready"),
        observation("codex", "gpt-5.6-terra", "provider_unavailable"),
      ]),
    ).toMatchObject({ kind: "waiting", reason: "invalid_config" });
  });
});
