import type { Issue } from "../../domain/project/index.js";
import { canonicalSerialize } from "../../domain/review/index.js";
import type {
  ChangeAssessment,
  RequirementChangeClassification,
  RequirementChangeReason,
} from "./model.js";

const hardFields = [
  "acceptanceCriteria",
  "inScope",
  "outOfScope",
  "dependencies",
  "agentRole",
  "reviewRequirement",
  "estimatedMinutes",
  "constraints",
  "risks",
  "changeRegions",
] as const satisfies readonly (keyof Issue)[];

const allFields = [
  "title",
  "goal",
  "background",
  "acceptanceCriteria",
  "inScope",
  "outOfScope",
  "dependencies",
  "priority",
  "agentRole",
  "reviewRequirement",
  "estimatedMinutes",
  "constraints",
  "risks",
  "changeRegions",
] as const satisfies readonly (keyof Issue)[];

function canonical(value: unknown): string | undefined {
  const serialized = canonicalSerialize(value === undefined ? null : value);
  return serialized.ok ? serialized.value : undefined;
}

function normalizedField(issue: Issue, field: (typeof allFields)[number]): unknown {
  const value = issue[field];
  if (
    field === "acceptanceCriteria" ||
    field === "inScope" ||
    field === "outOfScope" ||
    field === "constraints" ||
    field === "risks"
  ) {
    return Array.isArray(value) ? [...value].sort() : value;
  }
  if (field === "dependencies" && value !== undefined && typeof value === "object") {
    const dependency = value as Issue["dependencies"];
    return dependency?.kind === "issues"
      ? { kind: "issues", issueIds: [...dependency.issueIds].sort() }
      : dependency;
  }
  if (field === "changeRegions" && issue.changeRegions !== undefined) {
    return [...issue.changeRegions].sort((left, right) => {
      const leftKey = `${left.path}:${left.coverage}`;
      const rightKey = `${right.path}:${right.coverage}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  }
  return value;
}

function changedFields(current: Issue, proposed: Issue): readonly string[] | undefined {
  const changed: string[] = [];
  for (const field of allFields) {
    const before = canonical(normalizedField(current, field));
    const after = canonical(normalizedField(proposed, field));
    if (before === undefined || after === undefined) return undefined;
    if (before !== after) changed.push(field);
  }
  return Object.freeze(changed);
}

function signalReason(
  value: boolean | "unknown",
  reason: RequirementChangeReason,
  reasons: RequirementChangeReason[],
): void {
  if (value === true) reasons.push(reason);
  if (value === "unknown") reasons.push("uncertain_change");
}

export function classifyRequirementChange(
  current: Issue,
  proposed: Issue,
  assessment: ChangeAssessment,
): RequirementChangeClassification {
  const fields = changedFields(current, proposed);
  if (fields === undefined) {
    const reasons: readonly RequirementChangeReason[] = Object.freeze(["uncertain_change"]);
    return Object.freeze({
      kind: "substantive",
      changedFields: Object.freeze([]),
      reasons,
    });
  }
  const reasons: RequirementChangeReason[] = [];
  if (fields.includes("acceptanceCriteria")) reasons.push("acceptance_criteria_changed");
  if (fields.includes("inScope") || fields.includes("outOfScope")) reasons.push("scope_changed");
  if (fields.includes("dependencies")) reasons.push("dependencies_changed");
  if (fields.includes("agentRole")) reasons.push("agent_role_changed");
  if (fields.includes("reviewRequirement")) reasons.push("review_requirement_changed");
  if (fields.includes("estimatedMinutes")) reasons.push("estimate_changed");
  if (fields.includes("constraints")) reasons.push("constraints_changed");
  if (fields.includes("risks")) reasons.push("risks_changed");
  if (fields.includes("changeRegions")) reasons.push("change_regions_changed");

  const narrativeFieldsChanged = fields.some((field) =>
    ["title", "goal", "background"].includes(field),
  );
  if (
    (narrativeFieldsChanged && assessment.narrativeChange === "none") ||
    (!narrativeFieldsChanged && assessment.narrativeChange !== "none") ||
    assessment.narrativeChange === "unknown"
  ) {
    reasons.push("uncertain_change");
  }
  if (assessment.narrativeChange === "observable_change") {
    reasons.push("observable_outcome_changed");
  }
  signalReason(assessment.observableOutcomeChanged, "observable_outcome_changed", reasons);
  signalReason(assessment.externalServiceAdded, "external_service_added", reasons);
  signalReason(assessment.dangerousOperationAdded, "dangerous_operation_added", reasons);
  signalReason(assessment.deliverableChanged, "deliverable_changed", reasons);
  signalReason(assessment.edgeCaseAdded, "edge_case_added", reasons);

  if (hardFields.some((field) => fields.includes(field)) && reasons.length === 0) {
    reasons.push("uncertain_change");
  }
  const uniqueReasons = Object.freeze([...new Set(reasons)]);
  if (uniqueReasons.length > 0) {
    return Object.freeze({ kind: "substantive", changedFields: fields, reasons: uniqueReasons });
  }
  return fields.length === 0
    ? Object.freeze({ kind: "no_change", changedFields: fields })
    : Object.freeze({ kind: "small_supplement", changedFields: fields });
}
