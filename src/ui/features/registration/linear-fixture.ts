import {
  LinearProvisionUseCase,
  linearProvisionDigest,
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
  #byKey: Readonly<Record<string, string>> = Object.freeze({});

  read() {
    return Promise.resolve(ok(this.snapshot()));
  }

  compareAndSwap(
    _target: LinearProvisionTarget,
    expectedRevision: string,
    nextByKey: Readonly<Record<string, string>>,
  ) {
    if (expectedRevision !== this.snapshot().revision) {
      return Promise.resolve(err(domainError("conflict")));
    }
    this.#byKey = Object.freeze({ ...nextByKey });
    return Promise.resolve(ok(this.snapshot()));
  }

  private snapshot(): LinearProvisionBindings {
    return Object.freeze({
      revision: linearProvisionDigest({ byKey: this.#byKey }),
      byKey: this.#byKey,
    });
  }
}

class FixtureLinearPort implements LinearProvisionPort {
  readonly #objects: LinearProvisionRemoteObject[] = [];
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

/** Synthetic, in-memory composition only. It never reads credentials or calls Linear. */
export function createFixtureLinearProvisionUseCase(): LinearProvisionUseCase {
  return new LinearProvisionUseCase(
    fixtureLinearProvisionTarget,
    new FixtureLinearPort(),
    new FixtureBindingPort(),
  );
}
