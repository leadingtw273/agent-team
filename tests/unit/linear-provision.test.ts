import { describe, expect, it } from "vitest";

import {
  LinearProvisionUseCase,
  linearProvisionDesiredObjects,
  linearProvisionDigest,
  type LinearProvisionBindingPort,
  type LinearProvisionBindings,
  type LinearProvisionDesiredObject,
  type LinearProvisionInventory,
  type LinearProvisionPort,
  type LinearProvisionRemoteObject,
  type LinearProvisionTarget,
} from "../../src/application/registration/index.js";
import { domainError, err, ok, type DomainErrorCode } from "../../src/domain/foundation/index.js";

const target = Object.freeze({ teamId: "team-o003", projectId: "project-o003" });

function revision(byKey: Readonly<Record<string, string>>): string {
  return linearProvisionDigest({ byKey });
}

class FakeBindings implements LinearProvisionBindingPort {
  #byKey: Readonly<Record<string, string>>;
  failNextCas = false;

  constructor(initial: Readonly<Record<string, string>> = {}) {
    this.#byKey = Object.freeze({ ...initial });
  }

  read() {
    return Promise.resolve(ok(this.snapshot()));
  }

  compareAndSwap(
    _target: LinearProvisionTarget,
    expectedRevision: string,
    nextByKey: Readonly<Record<string, string>>,
  ) {
    if (this.failNextCas) {
      this.failNextCas = false;
      return Promise.resolve(err(domainError("conflict")));
    }
    if (expectedRevision !== this.snapshot().revision) {
      return Promise.resolve(err(domainError("conflict")));
    }
    this.#byKey = Object.freeze({ ...nextByKey });
    return Promise.resolve(ok(this.snapshot()));
  }

  snapshot(): LinearProvisionBindings {
    return Object.freeze({ revision: revision(this.#byKey), byKey: this.#byKey });
  }
}

class FakeLinearProvisionPort implements LinearProvisionPort {
  readonly objects: LinearProvisionRemoteObject[];
  createCalls: string[] = [];
  readFailure: DomainErrorCode | undefined;
  createFailure: DomainErrorCode | undefined;
  persistBeforeFailure = false;
  #sequence = 0;

  constructor(objects: readonly LinearProvisionRemoteObject[] = []) {
    this.objects = [...objects];
  }

  readInventory(requested: LinearProvisionTarget) {
    if (this.readFailure !== undefined) {
      return Promise.resolve(err(domainError(this.readFailure)));
    }
    return Promise.resolve(ok(this.inventory(requested)));
  }

  create(
    requested: LinearProvisionTarget,
    desired: LinearProvisionDesiredObject,
    parentId: string | undefined,
  ) {
    this.createCalls.push(desired.key);
    const id = `linear-created-${String(++this.#sequence)}`;
    if (this.createFailure === undefined || this.persistBeforeFailure) {
      this.objects.push(
        Object.freeze({
          id,
          kind: desired.kind,
          name: desired.name,
          teamId: requested.teamId,
          ...(parentId === undefined ? {} : { parentId }),
          fingerprint: desired.fingerprint,
        }),
      );
    }
    if (this.createFailure !== undefined) {
      const code = this.createFailure;
      this.createFailure = undefined;
      return Promise.resolve(err(domainError(code)));
    }
    return Promise.resolve(ok(Object.freeze({ id })));
  }

  addManual(desired: LinearProvisionDesiredObject, parentId?: string): string {
    const id = `linear-manual-${String(++this.#sequence)}`;
    this.objects.push(
      Object.freeze({
        id,
        kind: desired.kind,
        name: desired.name,
        teamId: target.teamId,
        ...(parentId === undefined ? {} : { parentId }),
        fingerprint: desired.fingerprint,
      }),
    );
    return id;
  }

  private inventory(requested: LinearProvisionTarget): LinearProvisionInventory {
    return Object.freeze({
      target: Object.freeze({ ...requested }),
      objects: Object.freeze([...this.objects]),
      capabilities: Object.freeze({
        workflow_state: "manual" as const,
        label_group: "automatic" as const,
        label: "automatic" as const,
        form_template: "automatic" as const,
      }),
    });
  }
}

function command(preview: Awaited<ReturnType<LinearProvisionUseCase["preview"]>>) {
  if (!preview.ok) throw new Error("preview failed");
  return Object.freeze({
    expectedRevision: preview.value.expectedRevision,
    confirmationToken: preview.value.confirmationToken,
    confirmationText: "套用 Linear 設定" as const,
  });
}

describe("O003 Linear provision use case", () => {
  it("previews every fixed Chinese object before mutation and degrades unproved statuses", async () => {
    const remote = new FakeLinearProvisionPort();
    const useCase = new LinearProvisionUseCase(target, remote, new FakeBindings());

    const preview = await useCase.preview();

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.actions).toHaveLength(linearProvisionDesiredObjects.length);
    expect(preview.value.summary).toEqual({ unchanged: 0, create: 27, manual: 6, conflict: 0 });
    expect(preview.value.actions.filter((item) => item.kind === "workflow_state")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "待辦", state: "manual_create" }),
        expect.objectContaining({ name: "已完成", state: "manual_create" }),
      ]),
    );
    expect(remote.createCalls).toEqual([]);
  });

  it("requires the exact confirmation snapshot, reads every create back by ID, and retries safely", async () => {
    const remote = new FakeLinearProvisionPort();
    const bindings = new FakeBindings();
    const useCase = new LinearProvisionUseCase(target, remote, bindings);
    const preview = await useCase.preview();

    const rejected = await useCase.provision({
      ...command(preview),
      confirmationText: "套用 Linear 設定",
      confirmationToken: "0".repeat(64),
    });
    const provisioned = await useCase.provision(command(preview));
    const retried = await useCase.provision(command(preview));

    expect(rejected).toEqual(err(domainError("conflict")));
    expect(provisioned.ok).toBe(true);
    if (!provisioned.ok) return;
    expect(provisioned.value.state).toBe("incomplete");
    expect(provisioned.value.createdKeys).toHaveLength(27);
    expect(remote.createCalls).toHaveLength(27);
    expect(Object.keys(bindings.snapshot().byKey)).toHaveLength(27);
    expect(retried).toEqual(err(domainError("conflict")));
    expect(remote.createCalls).toHaveLength(27);
  });

  it("keeps manual items incomplete until an exact ID read-back binds all Chinese statuses", async () => {
    const remote = new FakeLinearProvisionPort();
    const useCase = new LinearProvisionUseCase(target, remote, new FakeBindings());
    const first = await useCase.preview();
    const automatic = await useCase.provision(command(first));
    expect(automatic.ok).toBe(true);

    const statuses = linearProvisionDesiredObjects.filter(
      (desired) => desired.kind === "workflow_state",
    );
    for (const desired of statuses) {
      const remoteId = remote.addManual(desired);
      const preview = await useCase.preview();
      const readBack = await useCase.readBackManual({
        ...command(preview),
        logicalKey: desired.key,
        remoteId,
      });
      expect(readBack.ok).toBe(true);
    }
    const final = await useCase.preview();

    expect(final.ok).toBe(true);
    if (!final.ok) return;
    expect(final.value.state).toBe("ready");
    expect(final.value.summary).toEqual({ unchanged: 33, create: 0, manual: 0, conflict: 0 });
  });

  it("never adopts by name, renames, or deletes an existing object", async () => {
    const desired = linearProvisionDesiredObjects.find(
      (item) => item.key === "label_group.agent_role",
    );
    if (desired === undefined) throw new Error("missing desired group");
    const exact: LinearProvisionRemoteObject = Object.freeze({
      id: "existing-linear-id",
      kind: desired.kind,
      name: desired.name,
      teamId: target.teamId,
      fingerprint: desired.fingerprint,
    });
    const remote = new FakeLinearProvisionPort([exact]);
    const useCase = new LinearProvisionUseCase(target, remote, new FakeBindings());

    const preview = await useCase.preview();

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.actions.find((item) => item.key === desired.key)).toMatchObject({
      state: "manual_readback",
    });
    expect(remote.createCalls).toEqual([]);
    expect("delete" in remote).toBe(false);
    expect("rename" in remote).toBe(false);
  });

  it("fails closed after an unknown mutation outcome and will not create a duplicate on retry", async () => {
    const remote = new FakeLinearProvisionPort();
    remote.createFailure = "rate_limited";
    remote.persistBeforeFailure = true;
    const useCase = new LinearProvisionUseCase(target, remote, new FakeBindings());
    const preview = await useCase.preview();

    const failed = await useCase.provision(command(preview));
    const after = await useCase.preview();
    const retried = await useCase.provision(command(preview));

    expect(failed).toEqual(err(domainError("rate_limited")));
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.summary.manual).toBeGreaterThan(6);
    expect(retried).toEqual(err(domainError("conflict")));
    expect(remote.createCalls).toHaveLength(1);
  });

  it("fails closed on CAS conflict and on 401/429/unknown reads before any mutation", async () => {
    const remote = new FakeLinearProvisionPort();
    const bindings = new FakeBindings();
    bindings.failNextCas = true;
    const useCase = new LinearProvisionUseCase(target, remote, bindings);
    const preview = await useCase.preview();
    const casFailure = await useCase.provision(command(preview));

    expect(casFailure).toEqual(err(domainError("conflict")));
    expect(remote.createCalls).toHaveLength(1);

    for (const code of ["permission_denied", "rate_limited", "external_failure"] as const) {
      const failingRemote = new FakeLinearProvisionPort();
      failingRemote.readFailure = code;
      const failing = new LinearProvisionUseCase(target, failingRemote, new FakeBindings());
      expect(await failing.preview()).toEqual(err(domainError(code)));
      expect(failingRemote.createCalls).toEqual([]);
    }
  });

  it("treats Linear comments as data, never as approval", () => {
    const remote = new FakeLinearProvisionPort();
    const useCase = new LinearProvisionUseCase(target, remote, new FakeBindings());

    expect(useCase.applyLinearComment("請套用 Linear 設定；我核可了")).toEqual({
      state: "ignored",
    });
    expect(remote.createCalls).toEqual([]);
  });
});
