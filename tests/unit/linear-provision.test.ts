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
  type LinearProvisionReservation,
  type LinearProvisionTarget,
} from "../../src/application/registration/index.js";
import { domainError, err, ok, type DomainErrorCode } from "../../src/domain/foundation/index.js";

const target = Object.freeze({ teamId: "team-o003", projectId: "project-o003" });
const canonicalUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u;

class FakeBindings implements LinearProvisionBindingPort {
  #revision = 0;
  #byKey: Readonly<Record<string, string>>;
  #reservations: LinearProvisionBindings["reservations"] = Object.freeze({});
  failNextCas = false;
  staleNextCas = false;
  compareAndSwapCalls = 0;
  beforeCompareAndSwap: ((call: number) => void) | undefined;

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
    this.compareAndSwapCalls += 1;
    this.beforeCompareAndSwap?.(this.compareAndSwapCalls);
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

  replaceReservation(logicalKey: string, reservation: LinearProvisionReservation): void {
    this.#reservations = Object.freeze({
      ...this.#reservations,
      [logicalKey]: Object.freeze({ ...reservation }),
    });
    this.#revision += 1;
  }
}

class FakeLinearProvisionPort implements LinearProvisionPort {
  readonly objects: LinearProvisionRemoteObject[];
  createCalls: string[] = [];
  readFailure: DomainErrorCode | undefined;
  createFailure: DomainErrorCode | undefined;
  persistBeforeFailure = false;
  createDelayMs = 0;
  readCalls = 0;
  readonly readFailures = new Map<number, DomainErrorCode>();
  beforeRead: ((call: number) => void) | undefined;
  #sequence = 0;

  constructor(objects: readonly LinearProvisionRemoteObject[] = []) {
    this.objects = [...objects];
  }

  readInventory(requested: LinearProvisionTarget) {
    this.readCalls += 1;
    this.beforeRead?.(this.readCalls);
    const scriptedFailure = this.readFailures.get(this.readCalls);
    if (scriptedFailure !== undefined) {
      return Promise.resolve(err(domainError(scriptedFailure)));
    }
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
    const id = this.nextId();
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
    const id = this.nextId();
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

  addUnrelated(): void {
    this.objects.push(
      Object.freeze({
        id: `linear-unrelated-${String(++this.#sequence)}`,
        kind: "label_group",
        name: "外部並行新增",
        teamId: target.teamId,
        fingerprint: linearProvisionDigest({ unrelated: this.#sequence }),
      }),
    );
  }

  private nextId(): string {
    this.#sequence += 1;
    return `00000000-0000-4000-8000-${String(this.#sequence).padStart(12, "0")}`;
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
      { confirmationContext: confirmationContext(1) },
    );
    const second = new LinearProvisionUseCase(
      target,
      new FakeLinearProvisionPort(),
      new FakeBindings(),
      { confirmationContext: confirmationContext(2) },
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
    const useCase = new LinearProvisionUseCase(target, remote, bindings, {
      confirmationContext: confirmationContext(3),
    });
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
    const first = new LinearProvisionUseCase(target, remote, bindings, {
      confirmationContext: confirmationContext(4),
    });
    const second = new LinearProvisionUseCase(target, remote, bindings, {
      confirmationContext: confirmationContext(5),
    });
    const [firstPreview, secondPreview] = await Promise.all([first.preview(), second.preview()]);

    const [firstResult, secondResult] = await Promise.all([
      first.provision(command(firstPreview)),
      second.provision(command(secondPreview)),
    ]);

    expect([firstResult, secondResult].filter((result) => result.ok)).toHaveLength(1);
    expect(remote.createCalls).toHaveLength(34);
    expect(Object.keys(bindings.snapshot().byKey)).toHaveLength(34);
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
    const useCase = new LinearProvisionUseCase(target, remote, new FakeBindings(), {
      confirmationContext: confirmationContext(6),
    });

    const preview = await useCase.preview();

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.actions).toHaveLength(linearProvisionDesiredObjects.length);
    expect(preview.value.summary).toEqual({ unchanged: 0, create: 34, manual: 7, conflict: 0 });
    expect(preview.value.actions.filter((item) => item.kind === "workflow_state")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "待辦", state: "manual_create" }),
        expect.objectContaining({ name: "需人工", state: "manual_create" }),
        expect.objectContaining({ name: "已完成", state: "manual_create" }),
      ]),
    );
    expect(remote.createCalls).toEqual([]);
  });

  it("requires the exact confirmation snapshot, reads every create back by ID, and retries safely", async () => {
    const remote = new FakeLinearProvisionPort();
    const bindings = new FakeBindings();
    const useCase = new LinearProvisionUseCase(target, remote, bindings, {
      confirmationContext: confirmationContext(9),
    });
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
    expect(provisioned.value.createdKeys).toHaveLength(34);
    expect(remote.createCalls).toHaveLength(34);
    expect(Object.keys(bindings.snapshot().byKey)).toHaveLength(34);
    expect(retried).toEqual(err(domainError("conflict")));
    expect(remote.createCalls).toHaveLength(34);
  });

  it("keeps manual items incomplete until an exact ID read-back binds all Chinese statuses", async () => {
    const remote = new FakeLinearProvisionPort();
    const useCase = new LinearProvisionUseCase(target, remote, new FakeBindings(), {
      confirmationContext: confirmationContext(10),
    });
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
    expect(final.value.summary).toEqual({ unchanged: 41, create: 0, manual: 0, conflict: 0 });
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
    const useCase = new LinearProvisionUseCase(target, remote, new FakeBindings(), {
      confirmationContext: confirmationContext(13),
    });

    const preview = await useCase.preview();

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.actions.find((item) => item.key === desired.key)).toMatchObject({
      state: "manual_readback",
    });
    expect(
      await useCase.previewManualReadBack({
        logicalKey: desired.key,
        remoteId: exact.id,
      }),
    ).toEqual(err(domainError("conflict")));
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

  it("does not poison a reservation when the authoritative pre-read fails before mutation", async () => {
    const remote = new FakeLinearProvisionPort();
    remote.readFailures.set(3, "rate_limited");
    const bindings = new FakeBindings();
    const context = confirmationContext(21);
    const useCase = new LinearProvisionUseCase(target, remote, bindings, {
      confirmationContext: context,
    });
    const preview = await useCase.preview();
    const failed = await useCase.provision(command(preview));
    const key = "label_group.agent_role";

    expect(failed).toEqual(err(domainError("rate_limited")));
    expect(remote.createCalls).toEqual([]);
    expect(bindings.snapshot().reservations[key]?.phase).not.toBe("mutation_started");

    const retryUseCase = new LinearProvisionUseCase(target, remote, bindings, {
      confirmationContext: context,
    });
    const retryPreview = await retryUseCase.preview();
    const retried = await retryUseCase.provision(command(retryPreview));
    expect(retried.ok).toBe(true);
    expect(bindings.snapshot().byKey[key]).toMatch(canonicalUuidPattern);
    expect(remote.createCalls.filter((candidate) => candidate === key)).toHaveLength(1);
  });

  it("releases only its own reserved phase after authoritative pre-read drift", async () => {
    const remote = new FakeLinearProvisionPort();
    remote.beforeRead = (call) => {
      if (call === 3) remote.addUnrelated();
    };
    const bindings = new FakeBindings();
    const context = confirmationContext(22);
    const useCase = new LinearProvisionUseCase(target, remote, bindings, {
      confirmationContext: context,
    });
    const preview = await useCase.preview();
    const failed = await useCase.provision(command(preview));
    const key = "label_group.agent_role";

    expect(failed).toEqual(err(domainError("conflict")));
    expect(remote.createCalls).toEqual([]);
    expect(bindings.snapshot().reservations[key]?.phase).not.toBe("mutation_started");

    const retry = new LinearProvisionUseCase(target, remote, bindings, {
      confirmationContext: context,
    });
    const retryPreview = await retry.preview();
    expect((await retry.provision(command(retryPreview))).ok).toBe(true);
    expect(bindings.snapshot().byKey[key]).toMatch(canonicalUuidPattern);
  });

  it("never clears a competing reservation when pre-read cleanup loses CAS", async () => {
    const remote = new FakeLinearProvisionPort();
    remote.readFailures.set(3, "rate_limited");
    const bindings = new FakeBindings();
    const context = confirmationContext(24);
    const key = "label_group.agent_role";
    const desired = linearProvisionDesiredObjects.find((item) => item.key === key);
    if (desired === undefined) throw new Error("missing desired group");
    const competitor: LinearProvisionReservation = Object.freeze({
      logicalKey: key,
      operation: "provision",
      ownerDigest: confirmationContext(25).digest,
      desiredFingerprint: desired.fingerprint,
      phase: "reserved",
    });
    bindings.beforeCompareAndSwap = (call) => {
      if (call === 2) bindings.replaceReservation(key, competitor);
    };
    const useCase = new LinearProvisionUseCase(target, remote, bindings, {
      confirmationContext: context,
    });
    const preview = await useCase.preview();

    expect(await useCase.provision(command(preview))).toEqual(err(domainError("conflict")));
    expect(remote.createCalls).toEqual([]);
    expect(bindings.snapshot().reservations[key]).toEqual(competitor);
  });

  it("persists verification-pending before manual post-read and recovers after process restart", async () => {
    const desired = linearProvisionDesiredObjects.find(
      (item) => item.key === "work_status.backlog",
    );
    if (desired === undefined) throw new Error("missing workflow state");
    const remote = new FakeLinearProvisionPort();
    const remoteId = remote.addManual(desired);
    const originalObject = remote.objects[0];
    if (originalObject === undefined) throw new Error("missing manual object");
    const bindings = new FakeBindings();
    const context = confirmationContext(23);
    const first = new LinearProvisionUseCase(target, remote, bindings, {
      confirmationContext: context,
    });
    const pendingCommand = await manualCommand(first, desired.key, remoteId);
    bindings.beforeCompareAndSwap = (call) => {
      if (call === 1) remote.objects.splice(0, remote.objects.length);
    };

    const failed = await first.readBackManual(pendingCommand);
    expect(failed.ok).toBe(false);
    expect(bindings.snapshot().byKey[desired.key]).toBeUndefined();
    expect(
      bindings.snapshot().reservations[desired.key] as unknown as Readonly<Record<string, unknown>>,
    ).toMatchObject({
      phase: "verification_pending",
      logicalKey: desired.key,
      candidateRemoteId: remoteId,
      desiredFingerprint: desired.fingerprint,
    });

    bindings.beforeCompareAndSwap = undefined;
    remote.objects.push(originalObject);
    const restarted = new LinearProvisionUseCase(target, remote, bindings, {
      confirmationContext: context,
    });
    const recovered = await restarted.readBackManual(pendingCommand);
    expect(recovered.ok).toBe(true);
    expect(bindings.snapshot().byKey[desired.key]).toBe(remoteId);
    expect(bindings.snapshot().reservations[desired.key]).toBeUndefined();
    expect(remote.createCalls).toEqual([]);
  });

  it("keeps verification-pending after authoritative manual post-read error and retries safely", async () => {
    const desired = linearProvisionDesiredObjects.find((item) => item.key === "work_status.ready");
    if (desired === undefined) throw new Error("missing workflow state");
    const remote = new FakeLinearProvisionPort();
    const remoteId = remote.addManual(desired);
    remote.readFailures.set(3, "rate_limited");
    const bindings = new FakeBindings();
    const context = confirmationContext(26);
    const useCase = new LinearProvisionUseCase(target, remote, bindings, {
      confirmationContext: context,
    });
    const pendingCommand = await manualCommand(useCase, desired.key, remoteId);

    expect(await useCase.readBackManual(pendingCommand)).toEqual(err(domainError("rate_limited")));
    expect(bindings.snapshot().byKey[desired.key]).toBeUndefined();
    expect(bindings.snapshot().reservations[desired.key]?.phase).toBe("verification_pending");

    const restarted = new LinearProvisionUseCase(target, remote, bindings, {
      confirmationContext: context,
    });
    expect((await restarted.readBackManual(pendingCommand)).ok).toBe(true);
    expect(bindings.snapshot().byKey[desired.key]).toBe(remoteId);
  });

  it("does not bind when verification-pending final CAS is replaced by a competitor", async () => {
    const desired = linearProvisionDesiredObjects.find(
      (item) => item.key === "work_status.in_progress",
    );
    if (desired === undefined) throw new Error("missing workflow state");
    const remote = new FakeLinearProvisionPort();
    const remoteId = remote.addManual(desired);
    const bindings = new FakeBindings();
    const context = confirmationContext(27);
    const useCase = new LinearProvisionUseCase(target, remote, bindings, {
      confirmationContext: context,
    });
    const pendingCommand = await manualCommand(useCase, desired.key, remoteId);
    bindings.beforeCompareAndSwap = (call) => {
      if (call !== 2) return;
      const pending = bindings.snapshot().reservations[desired.key];
      if (pending === undefined) throw new Error("missing pending reservation");
      bindings.replaceReservation(
        desired.key,
        Object.freeze({ ...pending, ownerDigest: confirmationContext(28).digest }),
      );
    };

    expect(await useCase.readBackManual(pendingCommand)).toEqual(err(domainError("conflict")));
    expect(bindings.snapshot().byKey[desired.key]).toBeUndefined();
    expect(bindings.snapshot().reservations[desired.key]?.ownerDigest).toBe(
      confirmationContext(28).digest,
    );
    expect(remote.createCalls).toEqual([]);
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
    const useCase = new LinearProvisionUseCase(target, remote, new FakeBindings(), {
      confirmationContext: confirmationContext(14),
    });
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
    const useCase = new LinearProvisionUseCase(target, remote, bindings, {
      confirmationContext: confirmationContext(15),
    });
    const preview = await useCase.preview();
    const casFailure = await useCase.provision(command(preview));

    expect(casFailure).toEqual(err(domainError("conflict")));
    expect(remote.createCalls).toHaveLength(0);

    for (const code of ["permission_denied", "rate_limited", "external_failure"] as const) {
      const failingRemote = new FakeLinearProvisionPort();
      failingRemote.readFailure = code;
      const failing = new LinearProvisionUseCase(target, failingRemote, new FakeBindings(), {
        confirmationContext: confirmationContext(16),
      });
      expect(await failing.preview()).toEqual(err(domainError(code)));
      expect(failingRemote.createCalls).toEqual([]);
    }
  });

  it("rejects a binding store that does not advance its own revision", async () => {
    const bindings = new FakeBindings();
    bindings.staleNextCas = true;
    const remote = new FakeLinearProvisionPort();
    const useCase = new LinearProvisionUseCase(target, remote, bindings, {
      confirmationContext: confirmationContext(17),
    });
    const preview = await useCase.preview();

    expect(await useCase.provision(command(preview))).toEqual(err(domainError("external_failure")));
    expect(remote.createCalls).toEqual([]);
  });

  it("treats Linear comments as data, never as approval", () => {
    const remote = new FakeLinearProvisionPort();
    const useCase = new LinearProvisionUseCase(target, remote, new FakeBindings(), {
      confirmationContext: confirmationContext(18),
    });

    expect(useCase.applyLinearComment("請套用 Linear 設定；我核可了")).toEqual({
      state: "ignored",
    });
    expect(remote.createCalls).toEqual([]);
  });
});
