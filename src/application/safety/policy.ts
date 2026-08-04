import { isAbsolute } from "node:path";

import type { ProcessPort } from "../ports/process.js";
import { classifyProcessOperation } from "./classifier.js";
import {
  dangerousOperationCategories,
  type ProjectSafetyPolicy,
  type SafetyCheckedSpawnResult,
  type SafetyDecision,
  type SafetyProcessRequest,
} from "./model.js";

const categories = new Set<string>(dangerousOperationCategories);

function validPolicy(policy: ProjectSafetyPolicy): boolean {
  return (
    policy.projectId.trim().length > 0 &&
    policy.projectId.length <= 255 &&
    isAbsolute(policy.projectRoot) &&
    policy.projectRoot.length <= 4_096 &&
    policy.longTermAllowedCategories.length === new Set(policy.longTermAllowedCategories).size &&
    policy.longTermAllowedCategories.every((category) => categories.has(category))
  );
}

export function evaluateProcessSafety(
  request: SafetyProcessRequest,
  policy: ProjectSafetyPolicy,
): SafetyDecision {
  if (
    !validPolicy(policy) ||
    request.purpose.trim().length === 0 ||
    request.purpose.length > 1_024
  ) {
    return Object.freeze({
      state: "pause",
      classification: Object.freeze({ state: "unknown", summary: "安全政策或操作目的無效" }),
      reason: "invalid_policy",
    });
  }
  const classification = classifyProcessOperation(request.process, policy);
  if (classification.state === "unknown") {
    return Object.freeze({ state: "pause", classification, reason: "unknown_operation" });
  }
  if (classification.state === "ordinary") {
    return Object.freeze({
      state: "execute",
      classification,
      auditRequired: false,
      authorization: "ordinary",
    });
  }
  if (policy.longTermAllowedCategories.includes(classification.category)) {
    return Object.freeze({
      state: "execute",
      classification,
      auditRequired: true,
      authorization: "project_long_term",
    });
  }
  return Object.freeze({
    state: "pause",
    classification,
    reason: "dangerous_operation_approval_required",
  });
}

export async function spawnWithSafety(
  port: ProcessPort,
  request: SafetyProcessRequest,
  policy: ProjectSafetyPolicy,
): Promise<SafetyCheckedSpawnResult> {
  const decision = evaluateProcessSafety(request, policy);
  if (decision.state === "pause") return Object.freeze({ state: "paused", decision });
  const result = await port.spawn(request.process);
  return Object.freeze({ state: "process_result", decision, result });
}
