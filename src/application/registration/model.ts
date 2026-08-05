export const registrationStates = [
  "configuration_incomplete",
  "registered",
  "degraded",
  "disabled",
] as const;

export type RegistrationState = (typeof registrationStates)[number];

export const initialRegistrationState: RegistrationState = "configuration_incomplete";

export const registrationStateLabels = Object.freeze({
  configuration_incomplete: "設定未完成",
  registered: "已註冊",
  degraded: "降級",
  disabled: "已停用",
} as const satisfies Record<RegistrationState, string>);

export const registrationGateIds = [
  "local_repository",
  "node_runtime",
  "agent_cli",
  "trusted_project_config",
  "linear_access",
  "github_access",
  "continuous_integration",
  "github_review_status",
  "github_auto_merge",
  "webhook_runtime",
  "reconcile_wakeup",
] as const;

export type RegistrationGateId = (typeof registrationGateIds)[number];

export const registrationGateStates = ["passed", "failed", "unknown"] as const;
export type RegistrationGateState = (typeof registrationGateStates)[number];

/**
 * Gate probes are intentionally partial: a missing observation is a blocker,
 * rather than evidence that an unprobed capability is safe to automate.
 */
export type RegistrationGateSnapshot = Readonly<
  Partial<Record<RegistrationGateId, RegistrationGateState>>
>;

export type RegistrationGateRecord = Readonly<Record<RegistrationGateId, RegistrationGateState>>;

/** The versioned registration state written to local file state. */
export interface RegistrationStateSnapshot {
  readonly schemaVersion: 1;
  readonly state: RegistrationState;
  readonly gates: RegistrationGateRecord;
}

export type RegistrationGateBlockerState = Exclude<RegistrationGateState, "passed"> | "missing";

export interface RegistrationGateBlocker {
  readonly gate: RegistrationGateId;
  readonly state: RegistrationGateBlockerState;
}

export interface RegistrationGateEvaluation {
  readonly complete: boolean;
  readonly blockers: readonly RegistrationGateBlocker[];
}

export const registrationDegradationReasons = [
  "adapter_failure",
  "webhook_unavailable",
  "quota_monitor_unavailable",
  "reconcile_wakeup_unavailable",
] as const;

export type RegistrationDegradationReason = (typeof registrationDegradationReasons)[number];

export type RegistrationTransitionRequest =
  | Readonly<{ cause: "revalidation_succeeded"; gates: RegistrationGateSnapshot }>
  | Readonly<{ cause: "revalidation_failed"; gates: RegistrationGateSnapshot }>
  | Readonly<{
      cause: "operational_degradation";
      reason: RegistrationDegradationReason;
    }>
  | Readonly<{ cause: "user_disabled" }>
  | Readonly<{ cause: "user_enabled" }>;

export interface RegistrationCapabilities {
  readonly automaticDispatch: boolean;
  readonly automaticAutoMerge: boolean;
  readonly runningWorkCheckpoint: "none" | "when_safe" | "required";
}
