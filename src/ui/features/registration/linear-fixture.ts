import {
  LinearProvisionUseCase,
  linearProvisionDesiredObjects,
  type LinearProvisionBindingMutation,
  type LinearProvisionBindingPort,
  type LinearProvisionBindings,
  type LinearProvisionDesiredObject,
  type LinearProvisionInventory,
  type LinearProvisionPort,
  type LinearProvisionRemoteObject,
  type LinearProvisionTarget,
} from "../../../application/registration/index.js";
import { domainError, err, ok } from "../../../domain/foundation/index.js";

export const fixtureLinearProvisionTarget: LinearProvisionTarget = Object.freeze({
  teamId: "fixture-linear-team",
  projectId: "fixture-linear-project",
});

class FixtureBindingPort implements LinearProvisionBindingPort {
  #revision = 0;
  #byKey: Readonly<Record<string, string>> = Object.freeze({});
  #reservations: LinearProvisionBindings["reservations"] = Object.freeze({});

  read() {
    return Promise.resolve(ok(this.snapshot()));
  }

  compareAndSwap(
    _target: LinearProvisionTarget,
    expectedRevision: string,
    next: LinearProvisionBindingMutation,
  ) {
    if (expectedRevision !== this.snapshot().revision) {
      return Promise.resolve(err(domainError("conflict")));
    }
    this.#byKey = Object.freeze({ ...next.byKey });
    this.#reservations = Object.freeze({ ...next.reservations });
    this.#revision += 1;
    return Promise.resolve(ok(this.snapshot()));
  }

  private snapshot(): LinearProvisionBindings {
    return Object.freeze({
      revision: String(this.#revision),
      byKey: this.#byKey,
      reservations: this.#reservations,
    });
  }
}

class FixtureLinearPort implements LinearProvisionPort {
  readonly #objects: LinearProvisionRemoteObject[] = linearProvisionDesiredObjects
    .filter((desired) => desired.kind === "workflow_state")
    .map((desired) =>
      Object.freeze({
        id: fixtureManualRemoteId(desired.key),
        kind: desired.kind,
        name: desired.name,
        teamId: fixtureLinearProvisionTarget.teamId,
        fingerprint: desired.fingerprint,
      }),
    );
  #sequence = 0;

  readInventory(target: LinearProvisionTarget) {
    const inventory: LinearProvisionInventory = Object.freeze({
      target: Object.freeze({ ...target }),
      objects: Object.freeze([...this.#objects]),
      capabilities: Object.freeze({
        workflow_state: "manual" as const,
        label_group: "automatic" as const,
        label: "automatic" as const,
        form_template: "automatic" as const,
      }),
    });
    return Promise.resolve(ok(inventory));
  }

  create(
    target: LinearProvisionTarget,
    desired: LinearProvisionDesiredObject,
    parentId: string | undefined,
  ) {
    const id = `fixture-linear-object-${String(++this.#sequence)}`;
    this.#objects.push(
      Object.freeze({
        id,
        kind: desired.kind,
        name: desired.name,
        teamId: target.teamId,
        ...(parentId === undefined ? {} : { parentId }),
        fingerprint: desired.fingerprint,
      }),
    );
    return Promise.resolve(ok(Object.freeze({ id })));
  }
}

export function fixtureManualRemoteId(logicalKey: string): string {
  return `fixture-manual-${logicalKey}`;
}

/** Synthetic, in-memory composition only. It never reads credentials or calls Linear. */
export function createFixtureLinearProvisionUseCase(): LinearProvisionUseCase {
  return new LinearProvisionUseCase(
    fixtureLinearProvisionTarget,
    new FixtureLinearPort(),
    new FixtureBindingPort(),
  );
}
