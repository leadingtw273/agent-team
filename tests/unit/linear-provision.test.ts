import { describe, expect, it } from "vitest";

import {
  LinearProvisionUseCase,
  createLinearProvisionConfirmationContext,
  linearProvisionDesiredObjects,
  linearProvisionDigest,
  type LinearProvisionBindingMutation,
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

class FakeBindings implements LinearProvisionBindingPort {
  #revision = 0;
  #byKey: Readonly<Record<string, string>>;
  #reservations: LinearProvisionBindings["reservations"] = Object.freeze({});
  failNextCas = false;
  staleNextCas = false;

  constructor(initial: Readonly<Record<string, string>> = {}) {
    this.#byKey = Object.freeze({ ...initial });
  }

  read() {
    return Promise.resolve(ok(this.snapshot()));
  }

  compareAndSwap(
    _target: LinearProvisionTarget,
    expectedRevision: string,
    next: LinearProvisionBindingMutation,
  ) {
    if (this.failNextCas) {
      this.failNextCas = false;
      return Promise.resolve(err(domainError("conflict")));
    }
    if (expectedRevision !== this.snapshot().revision) {
      return Promise.resolve(err(domainError("conflict")));
    }
    this.#byKey = Object.freeze({ ...next.byKey });
    this.#reservations = Object.freeze({ ...next.reservations });
    if (!this.staleNextCas) this.#revision += 1;
    this.staleNextCas = false;
    return Promise.resolve(ok(this.snapshot()));
  }

  snapshot(): LinearProvisionBindings {
    return Object.freeze({
      revision: String(this.#revision),
      byKey: this.#byKey,
      reservations: this.#reservations,
    });
  }
}

class FakeLinearProvisionPort implements LinearProvisionPort {
  readonly objects: LinearProvisionRemoteObject[];
  createCalls: string[] = [];
  readFailure: DomainErrorCode | undefined;
  createFailure: DomainErrorCode | undefined;
  persistBeforeFailure = false;
  createDelayMs = 0;
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

  async create(
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
      return err(domainError(code));
    }
    if (this.createDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.createDelayMs));
    }
    return ok(Object.freeze({ id }));
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
    operation: "provision" as const,
    expectedRevision: preview.value.expectedRevision,
    confirmationToken: preview.value.confirmationToken,
    confirmationText: "套用 Linear 設定" as const,
  });
}

function confirmationContext(seed: number) {
  return createLinearProvisionConfirmationContext(new Uint8Array(32).fill(seed));
}

async function manualCommand(
  useCase: LinearProvisionUseCase,
  logicalKey: string,
  remoteId: string,
) {
  const preview = await useCase.previewManualReadBack({ logicalKey, remoteId });
  if (!preview.ok) throw new Error("manual preview failed");
  return Object.freeze({
    operation: "manual_readback" as const,
    logicalKey,
    remoteId,
    expectedRevision: preview.value.expectedRevision,
    confirmationToken: preview.value.confirmationToken,
    confirmationText: "確認 Linear ID read-back" as const,
  });
}

describe("O003 Linear provision use case", () => {
  it("binds confirmations to a fresh session context", async () => {
    const first = new LinearProvisionUseCase(
      target,
      new FakeLinearProvisionPort(),
      new FakeBindings(),
    );
    const second = new LinearProvisionUseCase(
      target,
      new FakeLinearProvisionPort(),
      new FakeBindings(),
    );

    const [firstPreview, secondPreview] = await Promise.all([first.preview(), second.preview()]);

    expect(firstPreview.ok && secondPreview.ok).toBe(true);
    if (!firstPreview.ok || !secondPreview.ok) return;
    expect(firstPreview.value.confirmationToken).not.toBe(secondPreview.value.confirmationToken);
  });

  it("rejects a provision token when the requested operation is manual read-back", async () => {
    const desired = linearProvisionDesiredObjects.find((item) => item.kind === "workflow_state");
    if (desired === undefined) throw new Error("missing workflow state");
    const remote = new FakeLinearProvisionPort();
    const remoteId = remote.addManual(desired);
    const bindings = new FakeBindings();
    const useCase = new LinearProvisionUseCase(target, remote, bindings);
    const provisionPreview = await useCase.preview();

    const result = await useCase.readBackManual({
      ...command(provisionPreview),
      logicalKey: desired.key,
      remoteId,
    } as unknown as Parameters<LinearProvisionUseCase["readBackManual"]>[0]);

    expect(result).toEqual(err(domainError("conflict")));
    expect(bindings.snapshot().byKey).toEqual({});
  });

  it("atomically reserves before a cross-instance race so only one remote create occurs", async () => {
    const remote = new FakeLinearProvisionPort();
    remote.createDelayMs = 1;
    const bindings = new FakeBindings();
    const first = new LinearProvisionUseCase(target, remote, bindings);
    const second = new LinearProvisionUseCase(target, remote, bindings);
    const [firstPreview, secondPreview] = await Promise.all([first.preview(), second.preview()]);

    const [firstResult, secondResult] = await Promise.all([
      first.provision(command(firstPreview)),
      second.provision(command(secondPreview)),
    ]);

    expect([firstResult, secondResult].filter((result) => result.ok)).toHaveLength(1);
    expect(remote.createCalls).toHaveLength(27);
    expect(Object.keys(bindings.snapshot().byKey)).toHaveLength(27);
  });

  it("rejects confirmation replay across contexts and config payload changes", async () => {
    const sharedContext = confirmationContext(7);
    const original = new LinearProvisionUseCase(
      target,
      new FakeLinearProvisionPort(),
      new FakeBindings(),
      { confirmationContext: sharedContext },
    );
    const changedObjects = linearProvisionDesiredObjects.map((item, index) => {
      if (index !== 0) return item;
      const payload = Object.freeze({ ...item.payload, description: "不同設定內容" });
      return Object.freeze({
        ...item,
        payload,
        fingerprint: linearProvisionDigest(payload),
      });
    });
    const changed = new LinearProvisionUseCase(
      target,
      new FakeLinearProvisionPort(),
      new FakeBindings(),
      { confirmationContext: sharedContext, desiredObjects: changedObjects },
    );
    const otherContextRemote = new FakeLinearProvisionPort();
    const otherContext = new LinearProvisionUseCase(
      target,
      otherContextRemote,
      new FakeBindings(),
      { confirmationContext: confirmationContext(8) },
    );
    const [originalPreview, changedPreview] = await Promise.all([
      original.preview(),
      changed.preview(),
    ]);
    expect(originalPreview.ok && changedPreview.ok).toBe(true);
    if (!originalPreview.ok || !changedPreview.ok) return;
    expect(originalPreview.value.confirmationToken).not.toBe(
      changedPreview.value.confirmationToken,
    );
    expect(await otherContext.provision(command(originalPreview))).toEqual(
      err(domainError("conflict")),
    );
    expect(otherContextRemote.createCalls).toEqual([]);
  });

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
      const readBack = await useCase.readBackManual(
        await manualCommand(useCase, desired.key, remoteId),
      );
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
    const bindings = new FakeBindings();
    const context = confirmationContext(11);
    const useCase = new LinearProvisionUseCase(target, remote, bindings, {
      confirmationContext: context,
    });
    const preview = await useCase.preview();

    const failed = await useCase.provision(command(preview));
    const after = await useCase.preview();
    const retryUseCase = new LinearProvisionUseCase(target, remote, bindings, {
      confirmationContext: context,
    });
    const retryPreview = await retryUseCase.preview();
    const retried = await retryUseCase.provision(command(retryPreview));

    expect(failed).toEqual(err(domainError("rate_limited")));
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.summary.manual).toBeGreaterThan(6);
    expect(retried.ok).toBe(true);
    const failedKey = remote.createCalls[0];
    expect(remote.createCalls.filter((key) => key === failedKey)).toHaveLength(1);
    expect(bindings.snapshot().reservations[failedKey ?? ""]?.phase).toBe("mutation_started");
  });

  it("keeps an unknown-outcome reservation on wrong ID then binds and removes it atomically", async () => {
    const remote = new FakeLinearProvisionPort();
    remote.createFailure = "rate_limited";
    remote.persistBeforeFailure = true;
    const bindings = new FakeBindings();
    const useCase = new LinearProvisionUseCase(target, remote, bindings, {
      confirmationContext: confirmationContext(12),
    });
    const preview = await useCase.preview();
    expect(await useCase.provision(command(preview))).toEqual(err(domainError("rate_limited")));
    const key = remote.createCalls[0];
    const created = remote.objects[0];
    if (key === undefined || created === undefined) throw new Error("missing failed mutation");
    const beforeWrong = bindings.snapshot();
    expect(await useCase.previewManualReadBack({ logicalKey: key, remoteId: "wrong-id" })).toEqual(
      err(domainError("conflict")),
    );
    expect(bindings.snapshot()).toEqual(beforeWrong);

    const applied = await useCase.readBackManual(await manualCommand(useCase, key, created.id));
    expect(applied.ok).toBe(true);
    expect(bindings.snapshot().byKey[key]).toBe(created.id);
    expect(bindings.snapshot().reservations[key]).toBeUndefined();
    expect(BigInt(bindings.snapshot().revision)).toBeGreaterThan(BigInt(beforeWrong.revision));
  });

  it("rejects a manual read-back token when the requested operation is provision", async () => {
    const desired = linearProvisionDesiredObjects.find((item) => item.kind === "workflow_state");
    if (desired === undefined) throw new Error("missing workflow state");
    const remote = new FakeLinearProvisionPort();
    const remoteId = remote.addManual(desired);
    const useCase = new LinearProvisionUseCase(target, remote, new FakeBindings());
    const manual = await manualCommand(useCase, desired.key, remoteId);

    const result = await useCase.provision({
      ...manual,
      confirmationText: "套用 Linear 設定",
    } as unknown as Parameters<LinearProvisionUseCase["provision"]>[0]);

    expect(result).toEqual(err(domainError("conflict")));
    expect(remote.createCalls).toEqual([]);
  });

  it("fails closed on CAS conflict and on 401/429/unknown reads before any mutation", async () => {
    const remote = new FakeLinearProvisionPort();
    const bindings = new FakeBindings();
    bindings.failNextCas = true;
    const useCase = new LinearProvisionUseCase(target, remote, bindings);
    const preview = await useCase.preview();
    const casFailure = await useCase.provision(command(preview));

    expect(casFailure).toEqual(err(domainError("conflict")));
    expect(remote.createCalls).toHaveLength(0);

    for (const code of ["permission_denied", "rate_limited", "external_failure"] as const) {
      const failingRemote = new FakeLinearProvisionPort();
      failingRemote.readFailure = code;
      const failing = new LinearProvisionUseCase(target, failingRemote, new FakeBindings());
      expect(await failing.preview()).toEqual(err(domainError(code)));
      expect(failingRemote.createCalls).toEqual([]);
    }
  });

  it("rejects a binding store that does not advance its own revision", async () => {
    const bindings = new FakeBindings();
    bindings.staleNextCas = true;
    const remote = new FakeLinearProvisionPort();
    const useCase = new LinearProvisionUseCase(target, remote, bindings);
    const preview = await useCase.preview();

    expect(await useCase.provision(command(preview))).toEqual(err(domainError("external_failure")));
    expect(remote.createCalls).toEqual([]);
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
