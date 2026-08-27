import { describe, expect, it } from "vitest";

import {
  parsePublishedReviewEvidence,
  renderReviewComment,
} from "../../src/application/pipelines/review-evidence.js";
import type { ReviewerPipelineOutcome } from "../../src/application/pipelines/reviewer-model.js";

const digest = (character: string): string => character.repeat(64);
const headSha = "a".repeat(40);

const decision = {
  state: "changes_requested",
  identity: {
    requirementsDigest: digest("b"),
    headSha,
    diffDigest: digest("c"),
  },
  reports: [
    {
      schemaVersion: 1,
      role: "code_reviewer",
      verdict: "changes_requested",
      requirementsDigest: digest("b"),
      headSha,
      diffDigest: digest("c"),
      summary: "One blocking finding.",
      acceptanceCriteria: [
        {
          criterion: "The new smoke test runs in CI.",
          status: "failed",
          summary: "The runner does not invoke it.",
          evidenceSources: ["agent-team:diff"],
        },
      ],
      qualityChecks: [
        {
          dimension: "test_effectiveness",
          status: "failed",
          summary: "The test is dead code.",
          evidenceSources: ["agent-team:ci"],
        },
      ],
      findings: [
        {
          severity: "blocking",
          title: "Smoke test is not registered",
          description: "The quality runner never executes the new smoke test.",
          acceptanceCriteria: ["The new smoke test runs in CI."],
          evidenceSources: ["agent-team:diff", "agent-team:ci"],
          path: "tests/combat_boundary_smoke.gd",
        },
      ],
    },
  ],
  findings: [
    {
      severity: "blocking",
      title: "Smoke test is not registered",
      description: "The quality runner never executes the new smoke test.",
      acceptanceCriteria: ["The new smoke test runs in CI."],
      evidenceSources: ["agent-team:diff", "agent-team:ci"],
      path: "tests/combat_boundary_smoke.gd",
    },
  ],
} as unknown as Extract<ReviewerPipelineOutcome, { state: "changes_requested" }>;

describe("published review evidence", () => {
  it("round-trips the strict public review contract and preserves blocking findings", () => {
    const body = `${renderReviewComment(decision)}\n\n<!-- agent-team:review_evidence:${digest("d")} -->`;
    const parsed = parsePublishedReviewEvidence(body);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.verdict).toBe("changes_requested");
    expect(parsed.value.identity).toEqual(decision.identity);
    expect(parsed.value.findings).toEqual(decision.findings);
    expect(parsed.value.markerDigest).toBe(digest("d"));
  });

  it.each([
    ["missing marker", renderReviewComment(decision)],
    [
      "wrong marker kind",
      `${renderReviewComment(decision)}\n\n<!-- agent-team:automation:${digest("d")} -->`,
    ],
    [
      "multiple JSON fences",
      `${renderReviewComment(decision)}\n\n\`\`\`json\n{}\n\`\`\`\n\n<!-- agent-team:review_evidence:${digest("d")} -->`,
    ],
  ])("rejects %s", (_case, body) => {
    expect(parsePublishedReviewEvidence(body).ok).toBe(false);
  });
});
