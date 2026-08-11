import { describe, expect, it } from "vitest";

import { fixtureArtifact } from "./fixtures.js";
import { replayLiveArtifact, replayRuleIds } from "./validator.js";

function mutation(mutator: (artifact: ReturnType<typeof fixtureArtifact>) => void) {
  const artifact = structuredClone(fixtureArtifact());
  mutator(artifact);
  return replayLiveArtifact(artifact);
}

describe("T09 artifact replay validator", () => {
  it("passes the full trusted projection with the fixed ordered rule set", () => {
    const report = replayLiveArtifact(fixtureArtifact());
    expect(report.overall).toBe("pass");
    expect(report.rules.map((rule) => rule.ruleId)).toEqual(replayRuleIds);
    expect(report.rules.every((rule) => rule.reasonCode === "ok")).toBe(true);
  });

  it("returns complete, safe reports for each authority missing and schema attacks", () => {
    for (const authority of ["linear", "github", "local", "git"] as const) {
      const artifact = fixtureArtifact();
      artifact.authorities[authority] = { status: "missing", reasonCode: "read_failed" };
      const report = replayLiveArtifact(artifact);
      expect(report.overall).toBe("fail");
      expect(report.rules).toHaveLength(replayRuleIds.length);
      expect(report.rules.find((rule) => rule.ruleId === "authorities_present")).toMatchObject({
        status: "fail",
        reasonCode: "authority_missing",
      });
    }
    const ownProto: unknown = JSON.parse('{"__proto__":{"polluted":true}}');
    const report = replayLiveArtifact(ownProto);
    expect(report.rules).toHaveLength(replayRuleIds.length);
    expect(report.rules.every((rule) => rule.reasonCode === "schema_invalid")).toBe(true);
    expect(JSON.stringify(report)).not.toContain("__proto__");
  });

  it("marks every mutable semantic rule red without shortening the report", () => {
    const cases: readonly [string, (artifact: ReturnType<typeof fixtureArtifact>) => void][] = [
      [
        "cardinality",
        (artifact) => {
          if (artifact.authorities.linear.status === "present")
            artifact.authorities.linear.evidence.issueCount = 2;
        },
      ],
      [
        "linear_lifecycle",
        (artifact) => {
          const timeline = artifact.authorities.linear;
          if (timeline.status === "present") {
            const first = timeline.evidence.timeline.at(0);
            if (first !== undefined) first.count = 2;
          }
        },
      ],
      [
        "required_ci",
        (artifact) => {
          if (artifact.authorities.github.status === "present")
            artifact.authorities.github.evidence.checks = [];
        },
      ],
      [
        "head_binding",
        (artifact) => {
          if (artifact.authorities.git.status === "present")
            artifact.authorities.git.evidence.headDigest = "d".repeat(64);
        },
      ],
      [
        "digest_binding",
        (artifact) => {
          if (artifact.authorities.github.status === "present")
            artifact.authorities.github.evidence.reviewer.diffDigest = "e".repeat(64);
        },
      ],
      [
        "project_progress",
        (artifact) => {
          if (artifact.authorities.local.status === "present")
            artifact.authorities.local.evidence.projectProgress.resumable = 1;
        },
      ],
      [
        "leases",
        (artifact) => {
          if (artifact.authorities.local.status === "present")
            artifact.authorities.local.evidence.leases.active = 1;
        },
      ],
      [
        "timestamps",
        (artifact) => {
          artifact.provenance.capturedAt = "2026-08-11T09:00:00.000Z";
        },
      ],
      [
        "linear_lifecycle",
        (artifact) => {
          const timeline = artifact.authorities.linear;
          const first =
            timeline.status === "present" ? timeline.evidence.timeline.at(0) : undefined;
          const second =
            timeline.status === "present" ? timeline.evidence.timeline.at(1) : undefined;
          if (first !== undefined && second !== undefined) {
            first.occurredAt = "2026-08-11T10:03:00.000Z";
            second.occurredAt = "2026-08-11T10:01:00.000Z";
          }
        },
      ],
    ];
    for (const [ruleId, alter] of cases) {
      const report = mutation(alter);
      expect(report.overall).toBe("fail");
      expect(report.rules).toHaveLength(replayRuleIds.length);
      expect(report.rules.find((rule) => rule.ruleId === ruleId)).toMatchObject({ status: "fail" });
    }
  });
});
