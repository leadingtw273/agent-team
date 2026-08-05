import type { AsyncPortResult, ReadOptions } from "./common.js";

interface RegistrationProbeObservation<Code extends string> {
  readonly evidenceCode: Code;
  readonly observedAt: string;
}

export type RegistrationLocalRepositoryObservation = RegistrationProbeObservation<
  "local_repository_unconfigured" | "local_repository_clean" | "local_repository_dirty"
>;

export type RegistrationNodeRuntimeObservation =
  RegistrationProbeObservation<"node_runtime_detected"> &
    Readonly<{
      readonly detectedMajor: number;
      readonly requiredMajor: number;
    }>;

export type RegistrationCompiledCliObservation =
  | RegistrationProbeObservation<"compiled_cli_unconfigured">
  | (RegistrationProbeObservation<"compiled_cli_version_verified"> &
      Readonly<{ readonly version: string }>);

export type RegistrationGitHubObservation = RegistrationProbeObservation<
  | "github_target_unconfigured"
  | "github_repository_readable"
  | "github_repository_unreadable"
  | "github_default_branch_mismatch"
>;

export type RegistrationLinearObservation = RegistrationProbeObservation<
  "linear_target_unconfigured" | "linear_adapter_unavailable" | "linear_context_verified"
>;

export type RegistrationContinuousIntegrationObservation = RegistrationProbeObservation<
  | "ci_target_unconfigured"
  | "ci_default_branch_mismatch"
  | "ci_no_active_workflow"
  | "ci_no_completed_run"
  | "ci_run_branch_unverified"
  | "ci_run_succeeded"
  | "ci_run_conclusion_unknown"
  | "ci_run_unsuccessful"
>;

export type RegistrationWebhookRuntimeObservation = RegistrationProbeObservation<
  | "webhook_reader_unavailable"
  | "webhook_url_unconfigured"
  | "webhook_url_invalid"
  | "webhook_url_format_verified"
>;

export type RegistrationReadOnlyGateObservation =
  | RegistrationLocalRepositoryObservation
  | RegistrationNodeRuntimeObservation
  | RegistrationCompiledCliObservation
  | RegistrationGitHubObservation
  | RegistrationLinearObservation
  | RegistrationContinuousIntegrationObservation
  | RegistrationWebhookRuntimeObservation;

/** Every method is observational and returns no arbitrary displayable text or provenance. */
export interface RegistrationLocalRepositoryProbePort {
  readonly inspect: (
    options?: ReadOptions,
  ) => AsyncPortResult<RegistrationLocalRepositoryObservation>;
}

export interface RegistrationNodeRuntimeProbePort {
  readonly inspect: (options?: ReadOptions) => AsyncPortResult<RegistrationNodeRuntimeObservation>;
}

export interface RegistrationCompiledCliProbePort {
  readonly inspect: (options?: ReadOptions) => AsyncPortResult<RegistrationCompiledCliObservation>;
}

export interface RegistrationGitHubReadOnlyProbePort {
  readonly inspect: (options?: ReadOptions) => AsyncPortResult<RegistrationGitHubObservation>;
}

export interface RegistrationLinearReadOnlyProbePort {
  readonly inspect: (options?: ReadOptions) => AsyncPortResult<RegistrationLinearObservation>;
}

export interface RegistrationContinuousIntegrationReadOnlyProbePort {
  readonly inspect: (
    options?: ReadOptions,
  ) => AsyncPortResult<RegistrationContinuousIntegrationObservation>;
}

export interface RegistrationWebhookRuntimeReadOnlyProbePort {
  readonly inspect: (
    options?: ReadOptions,
  ) => AsyncPortResult<RegistrationWebhookRuntimeObservation>;
}

/** The O002 coordinator is deliberately limited to these seven read-only checks. */
export interface RegistrationReadOnlyScanPorts {
  readonly localRepository: RegistrationLocalRepositoryProbePort;
  readonly nodeRuntime: RegistrationNodeRuntimeProbePort;
  readonly compiledCli: RegistrationCompiledCliProbePort;
  readonly github: RegistrationGitHubReadOnlyProbePort;
  readonly linear: RegistrationLinearReadOnlyProbePort;
  readonly continuousIntegration: RegistrationContinuousIntegrationReadOnlyProbePort;
  readonly webhookRuntime: RegistrationWebhookRuntimeReadOnlyProbePort;
}
