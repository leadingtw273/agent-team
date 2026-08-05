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
} from "./model.js";
import {
  parseRegistrationGateSnapshot,
  parseRegistrationState,
  parseRegistrationTransitionRequest,
} from "./schema.js";

function blockerState(state: RegistrationGateState | undefined): RegistrationGateBlocker["state"] {
  return state === "failed" || state === "unknown" ? state : "missing";
}

export function evaluateRegistrationGates(gates: unknown): RegistrationGateEvaluation {
  const parsed = parseRegistrationGateSnapshot(gates);
  const snapshot: RegistrationGateSnapshot = parsed.ok ? parsed.value : {};
  const blockers: RegistrationGateBlocker[] = [];
  for (const gate of registrationGateIds) {
    const state = snapshot[gate];
    if (state !== "passed") {
      blockers.push(Object.freeze({ gate, state: blockerState(state) }));
    }
  }
  return Object.freeze({
    complete: blockers.length === 0,
    blockers: Object.freeze(blockers),
  });
}

function failClosedCapabilities(): RegistrationCapabilities {
  return Object.freeze({
    automaticDispatch: false,
    automaticAutoMerge: false,
    runningWorkCheckpoint: "required",
  });
}

function capabilitiesForKnownState(state: RegistrationState): RegistrationCapabilities {
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

export function registrationCapabilities(state: unknown): RegistrationCapabilities {
  const parsed = parseRegistrationState(state);
  return parsed.ok ? capabilitiesForKnownState(parsed.value) : failClosedCapabilities();
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
  current: unknown,
  request: unknown,
): Result<RegistrationState, DomainError<"conflict" | "invariant_violation">> {
  const parsedCurrent = parseRegistrationState(current);
  if (!parsedCurrent.ok) return err(parsedCurrent.error);

  const parsedRequest = parseRegistrationTransitionRequest(request);
  if (!parsedRequest.ok) return err(parsedRequest.error);

  const currentState = parsedCurrent.value;
  const transition = parsedRequest.value;
  if (currentState === "disabled") {
    return transition.cause === "user_enabled" ? ok("configuration_incomplete") : ok("disabled");
  }

  switch (transition.cause) {
    case "user_disabled":
      return ok("disabled");
    case "user_enabled":
      return transitionConflict();
    case "revalidation_succeeded":
      return evaluateRegistrationGates(transition.gates).complete
        ? ok("registered")
        : transitionConflict();
    case "revalidation_failed":
      return evaluateRegistrationGates(transition.gates).complete
        ? transitionConflict()
        : ok("configuration_incomplete");
    case "operational_degradation":
      return currentState === "registered" || currentState === "degraded"
        ? ok("degraded")
        : ok("configuration_incomplete");
  }
}
