import type {
  ConflictAssessment,
  ConflictClassification,
  ConflictEscalationReason,
} from "./conflict-model.js";

export function classifyConflict(assessment: ConflictAssessment): ConflictClassification {
  if (assessment.requirementsCompatibility !== "compatible") return "requirements";
  return assessment.resolutionNature === "mechanical" ? "simple" : "semantic";
}

export function requirementEscalationReason(
  assessment: ConflictAssessment,
): Extract<ConflictEscalationReason, "requirements_conflict" | "requirements_unknown"> {
  return assessment.requirementsCompatibility === "incompatible"
    ? "requirements_conflict"
    : "requirements_unknown";
}
