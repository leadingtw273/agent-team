/**
 * E007 unit tests. `validateEvidence` is a pure function, so every test here works directly on
 * plain fixture objects (fixtures.ts) -- no fakes, no filesystem, no network. Two shapes of test:
 * (1) the happy path, where a fully-green bundle reconciles clean against its own expectation; and
 * (2) one deliberate injected failure per rule in `evidenceValidationRuleIds`, each asserting the
 * exact `ruleId`/`reasonCode` that must go red and that every *other* rule stays unaffected (no
 * failure ever silently masks or short-circuits the rest of the report).
 */
import { describe, expect, it } from "vitest";

import { evidenceSourceNames, type EvidenceBundle } from "../harness/schema.js";
import { buildGreenBundle, buildGreenExpectation, fixtureHeadSha } from "./fixtures.js";
import { evidenceValidationRuleIds } from "./rules.js";
import type { EvidenceValidationExpectation } from "./expectation.js";
import { validateEvidence } from "./validator.js";

function ruleResult(report: ReturnType<typeof validateEvidence>, ruleId: string) {
  const found = report.rules.find((rule) => rule.ruleId === ruleId);
  if (found === undefined) throw new Error(`rule ${ruleId} missing from report`);
  return found;
}

function otherRulesStillPass(
  report: ReturnType<typeof validateEvidence>,
  failedRuleIds: readonly string[],
): void {
  for (const rule of report.rules) {
    if (failedRuleIds.includes(rule.ruleId)) continue;
    expect(rule.status, `expected ${rule.ruleId} to still pass`).toBe("pass");
  }
}

describe("validateEvidence: happy path", () => {
  it("reports overall pass with every rule passing, in the fixed rule order, when the bundle fully reconciles", () => {
    const report = validateEvidence(buildGreenBundle(), buildGreenExpectation());

    expect(report.schemaVersion).toBe(1);
    expect(report.caseId).toBe("E101");
    expect(report.runId).toBe("run-e101-001");
    expect(report.overall).toBe("pass");
    expect(report.rules.map((rule) => rule.ruleId)).toEqual([...evidenceValidationRuleIds]);
    for (const rule of report.rules) {
      expect(rule.status).toBe("pass");
      expect(rule.reasonCode).toBe("ok");
    }
  });
});

describe("validateEvidence: bundle_case_identity_match", () => {
  it("fails when the bundle's own caseId does not match the case being validated", () => {
    const bundle: EvidenceBundle = { ...buildGreenBundle(), caseId: "E999" };

    const report = validateEvidence(bundle, buildGreenExpectation());

    expect(report.overall).toBe("fail");
    expect(ruleResult(report, "bundle_case_identity_match")).toMatchObject({
      status: "fail",
      reasonCode: "value_mismatch",
    });
    otherRulesStillPass(report, ["bundle_case_identity_match"]);
  });
});

describe("validateEvidence: source_presence (缺一來源必紅)", () => {
  it.each(evidenceSourceNames)(
    "fails source_presence and every rule that depends on %s when it is missing",
    (missingSource) => {
      const green = buildGreenBundle();
      const bundle: EvidenceBundle = {
        ...green,
        [missingSource]: {
          status: "missing",
          collectedAt: "2026-08-06T11:59:00.000Z",
          reason: "not_found",
        },
      };

      const report = validateEvidence(bundle, buildGreenExpectation());

      expect(report.overall).toBe("fail");
      expect(ruleResult(report, "source_presence")).toMatchObject({
        status: "fail",
        reasonCode: "source_missing",
      });

      const dependentRuleIdsBySource: Record<
        (typeof evidenceSourceNames)[number],
        readonly string[]
      > = {
        linear: ["linear_issue_id_match", "linear_comment_timestamps_in_window"],
        github: [
          "github_pull_request_number_match",
          "github_head_sha_match",
          "github_checks_head_sha_binding",
          "github_statuses_head_sha_binding",
        ],
        localEvents: [
          "local_events_delivery_id_dedup",
          "local_events_timestamps_monotonic",
          "local_events_required_event_types_present",
        ],
        checkpoints: ["checkpoint_case_binding"],
      };
      for (const ruleId of dependentRuleIdsBySource[missingSource]) {
        expect(ruleResult(report, ruleId)).toMatchObject({
          status: "fail",
          reasonCode: "source_missing",
        });
      }
      // A missing source always makes the cross-source timeline rule unverifiable too.
      expect(ruleResult(report, "timeline_no_timestamp_before_case_start")).toMatchObject({
        status: "fail",
        reasonCode: "source_missing",
      });
    },
  );
});

describe("validateEvidence: github rules", () => {
  it("github_pull_request_number_match fails on a PR number mismatch, independent of the head SHA rule", () => {
    const green = buildGreenBundle();
    if (green.github.status !== "present") throw new Error("fixture must be present");
    const bundle: EvidenceBundle = {
      ...green,
      github: {
        ...green.github,
        data: {
          ...green.github.data,
          pullRequest: { ...green.github.data.pullRequest, number: 999 },
        },
      },
    };

    const report = validateEvidence(bundle, buildGreenExpectation());

    expect(report.overall).toBe("fail");
    expect(ruleResult(report, "github_pull_request_number_match")).toMatchObject({
      status: "fail",
      reasonCode: "value_mismatch",
    });
    otherRulesStillPass(report, ["github_pull_request_number_match"]);
  });

  it("github_head_sha_match fails on a wrong head SHA (錯 SHA 必紅)", () => {
    const green = buildGreenBundle();
    if (green.github.status !== "present") throw new Error("fixture must be present");
    // The whole PR moved to a different head SHA than the case expected, but checks/statuses were
    // (correctly) re-fetched for that same new head -- so binding itself still holds; only the
    // comparison against the case's *expected* SHA should fail.
    const wrongSha = "b".repeat(40);
    const bundle: EvidenceBundle = {
      ...green,
      github: {
        ...green.github,
        data: {
          ...green.github.data,
          pullRequest: { ...green.github.data.pullRequest, headSha: wrongSha },
          checks: { ...green.github.data.checks, headSha: wrongSha },
          statuses: { ...green.github.data.statuses, headSha: wrongSha },
        },
      },
    };

    const report = validateEvidence(bundle, buildGreenExpectation());

    expect(report.overall).toBe("fail");
    expect(ruleResult(report, "github_head_sha_match")).toMatchObject({
      status: "fail",
      reasonCode: "value_mismatch",
    });
    // checks/statuses still bind to the PR's own (now-relocated) head SHA, so binding itself holds.
    expect(ruleResult(report, "github_checks_head_sha_binding").status).toBe("pass");
    expect(ruleResult(report, "github_statuses_head_sha_binding").status).toBe("pass");
  });

  it("github_checks_head_sha_binding fails when checks are bound to a different head than the PR's own", () => {
    const green = buildGreenBundle();
    if (green.github.status !== "present") throw new Error("fixture must be present");
    const bundle: EvidenceBundle = {
      ...green,
      github: {
        ...green.github,
        data: {
          ...green.github.data,
          checks: { ...green.github.data.checks, headSha: "c".repeat(40) },
        },
      },
    };

    const report = validateEvidence(bundle, buildGreenExpectation());

    expect(report.overall).toBe("fail");
    expect(ruleResult(report, "github_checks_head_sha_binding")).toMatchObject({
      status: "fail",
      reasonCode: "binding_mismatch",
    });
    // The PR itself still matches the case's expected head SHA.
    expect(ruleResult(report, "github_head_sha_match").status).toBe("pass");
    otherRulesStillPass(report, ["github_checks_head_sha_binding"]);
  });

  it("github_statuses_head_sha_binding fails when statuses are bound to a different head than the PR's own", () => {
    const green = buildGreenBundle();
    if (green.github.status !== "present") throw new Error("fixture must be present");
    const bundle: EvidenceBundle = {
      ...green,
      github: {
        ...green.github,
        data: {
          ...green.github.data,
          statuses: { ...green.github.data.statuses, headSha: "d".repeat(40) },
        },
      },
    };

    const report = validateEvidence(bundle, buildGreenExpectation());

    expect(report.overall).toBe("fail");
    expect(ruleResult(report, "github_statuses_head_sha_binding")).toMatchObject({
      status: "fail",
      reasonCode: "binding_mismatch",
    });
    otherRulesStillPass(report, ["github_statuses_head_sha_binding"]);
  });
});

describe("validateEvidence: linear rules", () => {
  it("linear_issue_id_match fails on a wrong issue id (錯 issue id 必紅)", () => {
    const green = buildGreenBundle();
    if (green.linear.status !== "present") throw new Error("fixture must be present");
    const bundle: EvidenceBundle = {
      ...green,
      linear: { ...green.linear, data: { ...green.linear.data, issueId: "issue-wrong" } },
    };

    const report = validateEvidence(bundle, buildGreenExpectation());

    expect(report.overall).toBe("fail");
    expect(ruleResult(report, "linear_issue_id_match")).toMatchObject({
      status: "fail",
      reasonCode: "value_mismatch",
    });
    otherRulesStillPass(report, ["linear_issue_id_match"]);
  });

  it("linear_comment_timestamps_in_window fails when a comment falls outside the case's time window", () => {
    const green = buildGreenBundle();
    if (green.linear.status !== "present") throw new Error("fixture must be present");
    const bundle: EvidenceBundle = {
      ...green,
      linear: {
        ...green.linear,
        data: {
          ...green.linear.data,
          comments: [
            ...green.linear.data.comments,
            { id: "comment-late", body: "too late", createdAt: "2026-08-07T00:00:00.000Z" },
          ],
        },
      },
    };

    const report = validateEvidence(bundle, buildGreenExpectation());

    expect(report.overall).toBe("fail");
    expect(ruleResult(report, "linear_comment_timestamps_in_window")).toMatchObject({
      status: "fail",
      reasonCode: "timestamp_out_of_window",
    });
    // This comment is after the window, not before the case's start, so the timeline rule holds.
    expect(ruleResult(report, "timeline_no_timestamp_before_case_start").status).toBe("pass");
  });
});

describe("validateEvidence: local events rules (時間線倒置／deliveryId 重複必紅)", () => {
  it("local_events_delivery_id_dedup fails when the same (provider, deliveryId) pair repeats", () => {
    const green = buildGreenBundle();
    if (green.localEvents.status !== "present") throw new Error("fixture must be present");
    const [first] = green.localEvents.data.inboxRecords;
    if (first === undefined) throw new Error("fixture must have at least one inbox record");
    const bundle: EvidenceBundle = {
      ...green,
      localEvents: {
        ...green.localEvents,
        data: {
          ...green.localEvents.data,
          inboxRecords: [first, { ...first, eventType: "pull_request_replayed" }],
        },
      },
    };

    const report = validateEvidence(bundle, buildGreenExpectation());

    expect(report.overall).toBe("fail");
    expect(ruleResult(report, "local_events_delivery_id_dedup")).toMatchObject({
      status: "fail",
      reasonCode: "duplicate_delivery_id",
    });
    otherRulesStillPass(report, ["local_events_delivery_id_dedup"]);
  });

  it("local_events_timestamps_monotonic fails when events go backwards in time (時間戳倒置必紅)", () => {
    const green = buildGreenBundle();
    if (green.localEvents.status !== "present") throw new Error("fixture must be present");
    const bundle: EvidenceBundle = {
      ...green,
      localEvents: {
        ...green.localEvents,
        data: { ...green.localEvents.data, events: [...green.localEvents.data.events].reverse() },
      },
    };

    const report = validateEvidence(bundle, buildGreenExpectation());

    expect(report.overall).toBe("fail");
    expect(ruleResult(report, "local_events_timestamps_monotonic")).toMatchObject({
      status: "fail",
      reasonCode: "timestamp_order_violation",
    });
    otherRulesStillPass(report, ["local_events_timestamps_monotonic"]);
  });

  it("local_events_required_event_types_present fails when a case-mandatory event type never occurred", () => {
    const expectation: EvidenceValidationExpectation = {
      ...buildGreenExpectation(),
      requiredEventTypes: ["job.started", "job.completed", "job.failed"],
    };

    const report = validateEvidence(buildGreenBundle(), expectation);

    expect(report.overall).toBe("fail");
    expect(ruleResult(report, "local_events_required_event_types_present")).toMatchObject({
      status: "fail",
      reasonCode: "required_event_type_missing",
    });
    otherRulesStillPass(report, ["local_events_required_event_types_present"]);
  });
});

describe("validateEvidence: checkpoint_case_binding (checkpoint 綁錯 case 必紅)", () => {
  it("fails when a checkpoint's jobId does not match this case's own job", () => {
    const green = buildGreenBundle();
    if (green.checkpoints.status !== "present") throw new Error("fixture must be present");
    const [checkpoint] = green.checkpoints.data.checkpoints;
    if (checkpoint === undefined) throw new Error("fixture must have at least one checkpoint");
    const bundle: EvidenceBundle = {
      ...green,
      checkpoints: {
        ...green.checkpoints,
        data: { checkpoints: [{ ...checkpoint, jobId: "job-belongs-to-another-case" }] },
      },
    };

    const report = validateEvidence(bundle, buildGreenExpectation());

    expect(report.overall).toBe("fail");
    expect(ruleResult(report, "checkpoint_case_binding")).toMatchObject({
      status: "fail",
      reasonCode: "binding_mismatch",
    });
    otherRulesStillPass(report, ["checkpoint_case_binding"]);
  });

  it("fails when the checkpoint source is present but carries no checkpoints at all", () => {
    const green = buildGreenBundle();
    if (green.checkpoints.status !== "present") throw new Error("fixture must be present");
    const bundle: EvidenceBundle = {
      ...green,
      checkpoints: { ...green.checkpoints, data: { checkpoints: [] } },
    };

    const report = validateEvidence(bundle, buildGreenExpectation());

    expect(ruleResult(report, "checkpoint_case_binding")).toMatchObject({
      status: "fail",
      reasonCode: "binding_mismatch",
    });
  });
});

describe("validateEvidence: timeline_no_timestamp_before_case_start (時間戳早於 case 開始必紅)", () => {
  it("fails when a local event's occurredAt precedes the case's declared start", () => {
    const green = buildGreenBundle();
    if (green.localEvents.status !== "present") throw new Error("fixture must be present");
    const [firstEvent, ...restEvents] = green.localEvents.data.events;
    if (firstEvent === undefined) throw new Error("fixture must have at least one event");
    const bundle: EvidenceBundle = {
      ...green,
      localEvents: {
        ...green.localEvents,
        data: {
          ...green.localEvents.data,
          events: [{ ...firstEvent, occurredAt: "2026-08-05T23:00:00.000Z" }, ...restEvents],
        },
      },
    };

    const report = validateEvidence(bundle, buildGreenExpectation());

    expect(report.overall).toBe("fail");
    expect(ruleResult(report, "timeline_no_timestamp_before_case_start")).toMatchObject({
      status: "fail",
      reasonCode: "timestamp_before_case_start",
    });
    // This event now also breaks monotonic order relative to the checkpoint's earlier read, but
    // that is a separate, independently-asserted rule -- this test only asserts the timeline rule.
  });
});

describe("validateEvidence: tampered bundle rejected by schema (多餘欄位被 schema 拒)", () => {
  it("throws instead of validating when the bundle carries an unexpected extra field", () => {
    const tampered = {
      ...buildGreenBundle(),
      extraField: "not part of the schema",
    } as unknown as EvidenceBundle;

    expect(() => validateEvidence(tampered, buildGreenExpectation())).toThrow();
  });

  it("throws instead of validating when a nested source object carries an unexpected extra field", () => {
    const green = buildGreenBundle();
    const tampered = {
      ...green,
      github: { ...green.github, extraField: "not part of the schema" },
    } as unknown as EvidenceBundle;

    expect(() => validateEvidence(tampered, buildGreenExpectation())).toThrow();
  });

  it("throws instead of validating when the expectation carries an unexpected extra field", () => {
    const tamperedExpectation = {
      ...buildGreenExpectation(),
      extraField: "not part of the schema",
    } as unknown as EvidenceValidationExpectation;

    expect(() => validateEvidence(buildGreenBundle(), tamperedExpectation)).toThrow();
  });
});

describe("validateEvidence: head SHA sanity (fixture hygiene)", () => {
  it("the fixture's own head SHA matches the 40-hex-char pattern the schema enforces", () => {
    expect(fixtureHeadSha).toMatch(/^[0-9a-f]{40}$/u);
  });
});
