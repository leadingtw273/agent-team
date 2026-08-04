import type { ChildProcessHandle, ProcessSpawnRequest } from "../ports/process.js";
import type { PortResult } from "../ports/common.js";

export const dangerousOperationCategories = Object.freeze([
  "project_destructive",
  "git_destructive",
  "local_environment",
  "deployment",
  "external_write",
  "secret_access",
  "paid_action",
] as const);

export type DangerousOperationCategory = (typeof dangerousOperationCategories)[number];

export type OperationClassification =
  | Readonly<{ state: "ordinary"; summary: string }>
  | Readonly<{
      state: "dangerous";
      category: DangerousOperationCategory;
      summary: string;
    }>
  | Readonly<{ state: "unknown"; summary: string }>;

export interface ProjectSafetyPolicy {
  readonly projectId: string;
  readonly projectRoot: string;
  readonly longTermAllowedCategories: readonly DangerousOperationCategory[];
}

export type SafetyDecision =
  | Readonly<{
      state: "execute";
      classification: OperationClassification;
      auditRequired: boolean;
      authorization: "ordinary" | "project_long_term";
    }>
  | Readonly<{
      state: "pause";
      classification: OperationClassification;
      reason: "dangerous_operation_approval_required" | "unknown_operation" | "invalid_policy";
    }>;

export type SafetyCheckedSpawnResult =
  | Readonly<{ state: "paused"; decision: Extract<SafetyDecision, { state: "pause" }> }>
  | Readonly<{
      state: "process_result";
      decision: Extract<SafetyDecision, { state: "execute" }>;
      result: PortResult<ChildProcessHandle>;
    }>;

export interface SafetyProcessRequest {
  readonly process: ProcessSpawnRequest;
  readonly purpose: string;
}
