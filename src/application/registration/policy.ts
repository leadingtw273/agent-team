import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import {
  registrationGateIds,
  type RegistrationCapabilities,
  type RegistrationGateBlocker,
  type RegistrationGateEvaluation,
  type RegistrationGateSnapshot,
  type RegistrationGateState,
  type RegistrationState,
  type RegistrationTransitionRequest,
} from "./model.js";

function blockerState(state: RegistrationGateState | undefined): RegistrationGateBlocker["state"] {
  return state === "failed" || state === "unknown" ? state : "missing";
}

export function evaluateRegistrationGates(
  gates: RegistrationGateSnapshot,
): RegistrationGateEvaluation {
  const blockers: RegistrationGateBlocker[] = [];
  for (const gate of registrationGateIds) {
    const state = gates[gate];
    if (state !== "passed") {
      blockers.push(Object.freeze({ gate, state: blockerState(state) }));
    }
  }
  return Object.freeze({
    complete: blockers.length === 0,
    blockers: Object.freeze(blockers),
  });
}

export function registrationCapabilities(state: RegistrationState): RegistrationCapabilities {
  switch (state) {
    case "configuration_incomplete":
      return Object.freeze({
        automaticDispatch: false,
        automaticAutoMerge: false,
        runningWorkCheckpoint: "none",
      });
    case "registered":
      return Object.freeze({
        automaticDispatch: true,
        automaticAutoMerge: true,
        runningWorkCheckpoint: "none",
      });
    case "degraded":
      return Object.freeze({
        automaticDispatch: false,
        automaticAutoMerge: false,
        runningWorkCheckpoint: "when_safe",
      });
    case "disabled":
      return Object.freeze({
        automaticDispatch: false,
        automaticAutoMerge: false,
        runningWorkCheckpoint: "required",
      });
  }
}

function transitionConflict(): Result<RegistrationState, DomainError<"conflict">> {
  return err(domainError("conflict"));
}

/**
 * Disabled projects are deliberately absorbing for all automatic events. A
 * user must first enable the project, which returns it to an unregistered
 * state; only a later successful Revalidation can restore automation.
 */
export function transitionRegistrationState(
  current: RegistrationState,
  request: RegistrationTransitionRequest,
): Result<RegistrationState, DomainError<"conflict">> {
  if (current === "disabled") {
    return request.cause === "user_enabled" ? ok("configuration_incomplete") : ok("disabled");
  }

  switch (request.cause) {
    case "user_disabled":
      return ok("disabled");
    case "user_enabled":
      return transitionConflict();
    case "revalidation_succeeded":
      return evaluateRegistrationGates(request.gates).complete
        ? ok("registered")
        : transitionConflict();
    case "revalidation_failed":
      return evaluateRegistrationGates(request.gates).complete
        ? transitionConflict()
        : ok("configuration_incomplete");
    case "operational_degradation":
      return current === "registered" || current === "degraded"
        ? ok("degraded")
        : ok("configuration_incomplete");
  }
}
