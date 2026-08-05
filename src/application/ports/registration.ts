import type { RegistrationGateState } from "../registration/model.js";
import type { AsyncPortResult, ReadOptions } from "./common.js";

/**
 * A registration probe returns only a short, display-safe observation. It must
 * never expose credentials, raw command output, request headers, or full URLs.
 */
export interface RegistrationReadOnlyGateObservation {
  readonly state: RegistrationGateState;
  readonly evidence: readonly string[];
  readonly provenance: RegistrationProbeProvenance;
  readonly observedAt: string;
}

export type RegistrationProbeProvenance =
  | "local_git"
  | "node_runtime"
  | "compiled_cli"
  | "github_read_only"
  | "linear_read_only"
  | "ci_read_only"
  | "webhook_configuration"
  | "fixture";

/** Every method is observational. Implementations must not provision, mutate, or probe-deliver. */
export interface RegistrationLocalRepositoryProbePort {
  readonly inspect: (options?: ReadOptions) => AsyncPortResult<RegistrationReadOnlyGateObservation>;
}

export interface RegistrationNodeRuntimeProbePort {
  readonly inspect: (options?: ReadOptions) => AsyncPortResult<RegistrationReadOnlyGateObservation>;
}

export interface RegistrationCompiledCliProbePort {
  readonly inspect: (options?: ReadOptions) => AsyncPortResult<RegistrationReadOnlyGateObservation>;
}

export interface RegistrationGitHubReadOnlyProbePort {
  readonly inspect: (options?: ReadOptions) => AsyncPortResult<RegistrationReadOnlyGateObservation>;
}

export interface RegistrationLinearReadOnlyProbePort {
  readonly inspect: (options?: ReadOptions) => AsyncPortResult<RegistrationReadOnlyGateObservation>;
}

export interface RegistrationContinuousIntegrationReadOnlyProbePort {
  readonly inspect: (options?: ReadOptions) => AsyncPortResult<RegistrationReadOnlyGateObservation>;
}

export interface RegistrationWebhookRuntimeReadOnlyProbePort {
  readonly inspect: (options?: ReadOptions) => AsyncPortResult<RegistrationReadOnlyGateObservation>;
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
