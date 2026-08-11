import { hasSafeDataShape } from "./boundary.js";
import {
  firstSandboxLiveArtifactSchema,
  timelineKinds,
  type FirstSandboxLiveArtifact,
} from "./schema.js";

export const replayRuleIds = [
  "schema_valid",
  "authorities_present",
  "cardinality",
  "linear_lifecycle",
  "required_ci",
  "head_binding",
  "digest_binding",
  "project_progress",
  "leases",
  "timestamps",
] as const;
export type ReplayRuleId = (typeof replayRuleIds)[number];
export interface LiveArtifactReplayReport {
  readonly schemaVersion: 1;
  readonly overall: "pass" | "fail";
  readonly rules: readonly Readonly<{
    ruleId: ReplayRuleId;
    status: "pass" | "fail";
    reasonCode: string;
  }>[];
}

function result(ruleId: ReplayRuleId, passed: boolean, failure: string) {
  return {
    ruleId,
    status: passed ? ("pass" as const) : ("fail" as const),
    reasonCode: passed ? "ok" : failure,
  };
}
function completeFailure(reasonCode: string): LiveArtifactReplayReport {
  return {
    schemaVersion: 1,
    overall: "fail",
    rules: replayRuleIds.map((ruleId) => result(ruleId, false, reasonCode)),
  };
}
function allPresent(artifact: FirstSandboxLiveArtifact) {
  return Object.values(artifact.authorities).every((authority) => authority.status === "present");
}

export function replayLiveArtifact(input: unknown): LiveArtifactReplayReport {
  if (!hasSafeDataShape(input)) return completeFailure("schema_invalid");
  const parsed = firstSandboxLiveArtifactSchema.safeParse(input);
  if (!parsed.success) return completeFailure("schema_invalid");
  const artifact = parsed.data;
  if (!allPresent(artifact))
    return {
      schemaVersion: 1,
      overall: "fail",
      rules: replayRuleIds.map((ruleId) =>
        result(
          ruleId,
          ruleId === "schema_valid",
          ruleId === "authorities_present" ? "authority_missing" : "dependency_missing",
        ),
      ),
    };
  const { linear, github, local, git } = artifact.authorities;
  if (
    linear.status !== "present" ||
    github.status !== "present" ||
    local.status !== "present" ||
    git.status !== "present"
  )
    return completeFailure("authority_missing");
  const timeline = linear.evidence.timeline;
  const lifecycle =
    timeline.map((item) => item.kind).join("\0") === timelineKinds.join("\0") &&
    timeline.every((item) => item.count === 1) &&
    Date.parse(timeline[0]?.occurredAt ?? "") <= Date.parse(timeline[1]?.occurredAt ?? "") &&
    Date.parse(timeline[1]?.occurredAt ?? "") <= Date.parse(timeline[2]?.occurredAt ?? "");
  const started = Date.parse(artifact.provenance.startedAt);
  const captured = Date.parse(artifact.provenance.capturedAt);
  const timestamps = [
    linear.evidence.updatedAt,
    ...timeline.map((item) => item.occurredAt),
    github.evidence.merge.observedAt,
    local.evidence.exactJob.updatedAt,
    local.evidence.leases.observedAt,
  ];
  const rules = [
    result("schema_valid", true, "schema_invalid"),
    result("authorities_present", true, "authority_missing"),
    result(
      "cardinality",
      linear.evidence.issueCount === 1 &&
        github.evidence.pullRequestCount === 1 &&
        local.evidence.jobsForIssue === 1,
      "cardinality_invalid",
    ),
    result("linear_lifecycle", lifecycle, "lifecycle_invalid"),
    result(
      "required_ci",
      github.evidence.checks.length === 1 && github.evidence.checks[0]?.name === "CI",
      "check_invalid",
    ),
    result(
      "head_binding",
      [
        github.evidence.reviewStatus.headDigest,
        github.evidence.reviewer.headDigest,
        github.evidence.merge.headDigest,
        git.evidence.headDigest,
        ...github.evidence.checks.map((check) => check.headDigest),
      ].every((digest) => digest === github.evidence.headDigest),
      "head_mismatch",
    ),
    result(
      "digest_binding",
      github.evidence.reviewer.diffDigest === git.evidence.effectiveDiffDigest,
      "digest_mismatch",
    ),
    result(
      "project_progress",
      local.evidence.projectProgress.resumable === 0 &&
        local.evidence.projectProgress.blocked === 0 &&
        local.evidence.projectProgress.nonTerminal === 0,
      "local_invalid",
    ),
    result(
      "leases",
      local.evidence.leases.active === 0 && local.evidence.leases.expired === 0,
      "local_invalid",
    ),
    result(
      "timestamps",
      Number.isFinite(started) &&
        Number.isFinite(captured) &&
        started <= captured &&
        timestamps.every((value) => Date.parse(value) >= started && Date.parse(value) <= captured),
      "timestamp_invalid",
    ),
  ] as const;
  return {
    schemaVersion: 1,
    overall: rules.every((rule) => rule.status === "pass") ? "pass" : "fail",
    rules,
  };
}
