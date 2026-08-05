import type { ReadOptions } from "../ports/common.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import {
  linearProvisionDesiredObjects,
  linearProvisionDigest,
  linearProvisionObjectKinds,
  type LinearManualReadBackCommand,
  type LinearManualReadBackPreview,
  type LinearManualReadBackRequest,
  type LinearProvisionAction,
  type LinearProvisionActionState,
  type LinearProvisionBindingMutation,
  type LinearProvisionBindingPort,
  type LinearProvisionBindings,
  type LinearProvisionCommand,
  type LinearProvisionConfirmationContext,
  type LinearProvisionDesiredObject,
  type LinearProvisionInventory,
  type LinearProvisionObjectKind,
  type LinearProvisionOutcome,
  type LinearProvisionPort,
  type LinearProvisionPreview,
  type LinearProvisionRemoteObject,
  type LinearProvisionReservation,
  type LinearProvisionTarget,
  type LinearProvisionUseCaseOptions,
} from "./linear-provision-model.js";

export * from "./linear-provision-model.js";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const canonicalLinearIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const storeRevisionPattern = /^(?:0|[1-9][0-9]{0,15})$/u;
const provisionConfirmationText = "套用 Linear 設定" as const;
const manualConfirmationText = "確認 Linear ID read-back" as const;

interface PreviewContext {
  readonly preview: LinearProvisionPreview;
  readonly inventory: LinearProvisionInventory;
  readonly bindings: LinearProvisionBindings;
}

interface ReadContext {
  readonly inventory: LinearProvisionInventory;
  readonly bindings: LinearProvisionBindings;
}

function failure<Value>(code: DomainError["code"]): Result<Value, DomainError> {
  return err(domainError(code));
}

function validTarget(target: LinearProvisionTarget): boolean {
  return idPattern.test(target.teamId) && idPattern.test(target.projectId);
}

function validCanonicalLinearId(value: string): boolean {
  return value.length <= 36 && canonicalLinearIdPattern.test(value);
}

function sortedObjects(objects: readonly LinearProvisionRemoteObject[]) {
  return [...objects].sort((left, right) => left.id.localeCompare(right.id));
}

function validInventory(
  expectedTarget: LinearProvisionTarget,
  inventory: LinearProvisionInventory,
): boolean {
  if (
    inventory.target.teamId !== expectedTarget.teamId ||
    inventory.target.projectId !== expectedTarget.projectId ||
    new Set(inventory.objects.map((object) => object.id)).size !== inventory.objects.length
  ) {
    return false;
  }
  if (
    linearProvisionObjectKinds.some((kind) => {
      const capability: unknown = inventory.capabilities[kind];
      return capability !== "automatic" && capability !== "manual";
    })
  ) {
    return false;
  }
  return inventory.objects.every(
    (object) =>
      idPattern.test(object.id) &&
      object.teamId === expectedTarget.teamId &&
      object.name.trim().length > 0 &&
      object.name.length <= 255 &&
      linearProvisionObjectKinds.includes(object.kind) &&
      digestPattern.test(object.fingerprint) &&
      (object.parentId === undefined || idPattern.test(object.parentId)),
  );
}

function validDesiredObjects(objects: readonly LinearProvisionDesiredObject[]): boolean {
  if (objects.length === 0 || new Set(objects.map((item) => item.key)).size !== objects.length) {
    return false;
  }
  const seen = new Set<string>();
  for (const desired of objects) {
    if (
      !idPattern.test(desired.key) ||
      !linearProvisionObjectKinds.includes(desired.kind) ||
      desired.name.trim().length === 0 ||
      desired.name.length > 255 ||
      !digestPattern.test(desired.fingerprint) ||
      linearProvisionDigest(desired.payload) !== desired.fingerprint ||
      (desired.parentKey !== undefined && !seen.has(desired.parentKey))
    ) {
      return false;
    }
    seen.add(desired.key);
  }
  return true;
}

function validReservation(
  key: string,
  reservation: LinearProvisionReservation,
  desiredKeys: ReadonlySet<string>,
): boolean {
  const operation: unknown = reservation.operation;
  const phase: unknown = reservation.phase;
  const commonValid =
    desiredKeys.has(key) &&
    reservation.logicalKey === key &&
    digestPattern.test(reservation.ownerDigest) &&
    digestPattern.test(reservation.desiredFingerprint) &&
    (phase === "reserved" || phase === "mutation_started" || phase === "verification_pending");
  if (!commonValid) return false;
  if (phase === "verification_pending") {
    return (
      operation === "manual_readback" &&
      reservation.candidateRemoteId !== undefined &&
      validCanonicalLinearId(reservation.candidateRemoteId) &&
      reservation.candidateResourceFingerprint !== undefined &&
      digestPattern.test(reservation.candidateResourceFingerprint) &&
      reservation.authoritativeInventoryDigest !== undefined &&
      digestPattern.test(reservation.authoritativeInventoryDigest) &&
      reservation.confirmationProofDigest !== undefined &&
      digestPattern.test(reservation.confirmationProofDigest)
    );
  }
  return (
    operation === "provision" &&
    reservation.candidateRemoteId === undefined &&
    reservation.candidateResourceFingerprint === undefined &&
    reservation.authoritativeInventoryDigest === undefined &&
    reservation.confirmationProofDigest === undefined
  );
}

function validBindings(
  bindings: LinearProvisionBindings,
  desiredObjects: readonly LinearProvisionDesiredObject[],
): boolean {
  const desiredByKey = new Map(desiredObjects.map((item) => [item.key, item]));
  const desiredKeys = new Set(desiredByKey.keys());
  const bindingEntries = Object.entries(bindings.byKey);
  const reservationEntries = Object.entries(bindings.reservations);
  return (
    storeRevisionPattern.test(bindings.revision) &&
    bindingEntries.every(([key, id]) => desiredKeys.has(key) && idPattern.test(id)) &&
    new Set(bindingEntries.map(([, id]) => id)).size === bindingEntries.length &&
    reservationEntries.every(([key, reservation]) =>
      validReservation(key, reservation, desiredKeys),
    ) &&
    reservationEntries.every(
      ([key, reservation]) => reservation.desiredFingerprint === desiredByKey.get(key)?.fingerprint,
    ) &&
    reservationEntries.every(([key]) => bindings.byKey[key] === undefined)
  );
}

function revisionAdvanced(previous: string, next: string): boolean {
  try {
    return BigInt(next) > BigInt(previous);
  } catch {
    return false;
  }
}

function expectedParentId(
  desired: LinearProvisionDesiredObject,
  bindings: Readonly<Record<string, string>>,
): string | undefined {
  return desired.parentKey === undefined ? undefined : bindings[desired.parentKey];
}

function matchesDesired(
  remote: LinearProvisionRemoteObject,
  desired: LinearProvisionDesiredObject,
  target: LinearProvisionTarget,
  bindings: Readonly<Record<string, string>>,
): boolean {
  return (
    remote.kind === desired.kind &&
    remote.name === desired.name &&
    remote.teamId === target.teamId &&
    remote.fingerprint === desired.fingerprint &&
    remote.parentId === expectedParentId(desired, bindings)
  );
}

function manualInstruction(kind: LinearProvisionObjectKind, readBack: boolean): string {
  if (readBack) {
    return "請在本機 UI 輸入 Linear 物件 ID，先預覽 authoritative read-back，再做第二步確認；系統不會只憑名稱接管。";
  }
  switch (kind) {
    case "workflow_state":
      return "請在 Linear Team 工作流程中建立此中文狀態，重新預覽後在本機 UI 輸入物件 ID。";
    case "label_group":
      return "請在 Linear 建立單選 Label Group，重新預覽後在本機 UI 輸入 Group ID。";
    case "label":
      return "請先完成父 Label Group，再建立子 Label，重新預覽後在本機 UI 輸入子 Label ID。";
    case "form_template":
      return "請在 Linear 建立中文 Issue Form Template，重新預覽後在本機 UI 輸入 Template ID。";
  }
}

function exactSameNameObjects(
  desired: LinearProvisionDesiredObject,
  inventory: LinearProvisionInventory,
  bindings: LinearProvisionBindings,
): readonly LinearProvisionRemoteObject[] {
  return inventory.objects.filter(
    (object) =>
      object.name === desired.name &&
      matchesDesired(object, desired, inventory.target, bindings.byKey),
  );
}

function actionFor(
  desired: LinearProvisionDesiredObject,
  inventory: LinearProvisionInventory,
  bindings: LinearProvisionBindings,
  priorActions: ReadonlyMap<string, LinearProvisionAction>,
  context: LinearProvisionConfirmationContext,
): LinearProvisionAction {
  const boundId = bindings.byKey[desired.key];
  if (boundId !== undefined) {
    const matches = inventory.objects.filter((object) => object.id === boundId);
    const unchanged =
      matches.length === 1 &&
      matches[0] !== undefined &&
      matchesDesired(matches[0], desired, inventory.target, bindings.byKey);
    return Object.freeze({
      key: desired.key,
      kind: desired.kind,
      name: desired.name,
      state: unchanged ? "unchanged" : "conflict",
      ...(unchanged
        ? {}
        : {
            instruction:
              "已綁定的 Linear 物件遺失或內容不符；系統不會刪除、改名或改綁，請人工查明。",
          }),
    });
  }

  const reservation = bindings.reservations[desired.key];
  if (reservation !== undefined) {
    const exact = exactSameNameObjects(desired, inventory, bindings);
    if (exact.length === 1) {
      return Object.freeze({
        key: desired.key,
        kind: desired.kind,
        name: desired.name,
        state: "manual_readback",
        instruction: manualInstruction(desired.kind, true),
      });
    }
    const ownerMayResume =
      reservation.operation === "provision" &&
      reservation.ownerDigest === context.digest &&
      reservation.desiredFingerprint === desired.fingerprint &&
      reservation.phase === "reserved";
    return Object.freeze({
      key: desired.key,
      kind: desired.kind,
      name: desired.name,
      state: ownerMayResume ? "create" : "conflict",
      ...(ownerMayResume
        ? {}
        : {
            instruction:
              reservation.phase === "mutation_started"
                ? "前次 mutation outcome 無法確認；不得重送建立。請查明 Linear 物件 ID 後做 manual read-back。"
                : reservation.phase === "verification_pending"
                  ? "Manual ID read-back 尚待 authoritative post-read；不得自動建立或接管。"
                  : "另一個本機工作階段已保留此建立操作；本工作階段不會送出 mutation。",
          }),
    });
  }

  const sameName = inventory.objects.filter(
    (object) => object.teamId === inventory.target.teamId && object.name === desired.name,
  );
  if (sameName.length > 0) {
    const exact = sameName.filter((object) =>
      matchesDesired(object, desired, inventory.target, bindings.byKey),
    );
    return Object.freeze({
      key: desired.key,
      kind: desired.kind,
      name: desired.name,
      state: exact.length === 1 && sameName.length === 1 ? "manual_readback" : "conflict",
      instruction:
        exact.length === 1 && sameName.length === 1
          ? manualInstruction(desired.kind, true)
          : "Linear 已有同名或不相容物件；請以 ID 查明並人工處理，系統不會刪除或靜默改名。",
    });
  }

  if (desired.parentKey !== undefined && bindings.byKey[desired.parentKey] === undefined) {
    const parentAction = priorActions.get(desired.parentKey);
    if (parentAction?.state !== "create") {
      return Object.freeze({
        key: desired.key,
        kind: desired.kind,
        name: desired.name,
        state: "manual_create",
        instruction: manualInstruction(desired.kind, false),
      });
    }
  }

  const state: LinearProvisionActionState =
    inventory.capabilities[desired.kind] === "automatic" ? "create" : "manual_create";
  return Object.freeze({
    key: desired.key,
    kind: desired.kind,
    name: desired.name,
    state,
    ...(state === "manual_create" ? { instruction: manualInstruction(desired.kind, false) } : {}),
  });
}

function inventoryDigest(inventory: LinearProvisionInventory): string {
  return linearProvisionDigest({
    target: inventory.target,
    capabilities: inventory.capabilities,
    objects: sortedObjects(inventory.objects),
  });
}

function configDigest(desiredObjects: readonly LinearProvisionDesiredObject[]): string {
  return linearProvisionDigest(
    desiredObjects.map((desired) => ({
      key: desired.key,
      kind: desired.kind,
      name: desired.name,
      parentKey: desired.parentKey ?? null,
      payload: desired.payload,
      fingerprint: desired.fingerprint,
    })),
  );
}

function snapshotRevision(
  target: LinearProvisionTarget,
  inventory: LinearProvisionInventory,
  bindings: LinearProvisionBindings,
  desiredConfigDigest: string,
): string {
  return linearProvisionDigest({
    target,
    desiredConfigDigest,
    inventoryRevision: inventoryDigest(inventory),
    bindingRevision: bindings.revision,
    bindings: bindings.byKey,
    reservations: bindings.reservations,
  });
}

function previewContext(
  target: LinearProvisionTarget,
  inventory: LinearProvisionInventory,
  bindings: LinearProvisionBindings,
  desiredObjects: readonly LinearProvisionDesiredObject[],
  context: LinearProvisionConfirmationContext,
  desiredConfigDigest: string,
): PreviewContext {
  const actions: LinearProvisionAction[] = [];
  const priorActions = new Map<string, LinearProvisionAction>();
  for (const desired of desiredObjects) {
    const action = actionFor(desired, inventory, bindings, priorActions, context);
    actions.push(action);
    priorActions.set(action.key, action);
  }
  const expectedRevision = snapshotRevision(target, inventory, bindings, desiredConfigDigest);
  const confirmationToken = linearProvisionDigest({
    purpose: "agent-team-linear-confirmation-v2",
    operation: "provision",
    contextDigest: context.digest,
    target,
    desiredConfigDigest,
    inventoryRevision: inventoryDigest(inventory),
    bindingRevision: bindings.revision,
    expectedRevision,
    actions,
  });
  const summary = Object.freeze({
    unchanged: actions.filter((action) => action.state === "unchanged").length,
    create: actions.filter((action) => action.state === "create").length,
    manual: actions.filter(
      (action) => action.state === "manual_create" || action.state === "manual_readback",
    ).length,
    conflict: actions.filter((action) => action.state === "conflict").length,
  });
  const preview: LinearProvisionPreview = Object.freeze({
    state:
      summary.create === 0 && summary.manual === 0 && summary.conflict === 0
        ? "ready"
        : "incomplete",
    target: Object.freeze({ ...target }),
    expectedRevision,
    confirmationToken,
    actions: Object.freeze(actions),
    summary,
  });
  return Object.freeze({ preview, inventory, bindings });
}

function onlyExpectedAddition(
  before: LinearProvisionInventory,
  after: LinearProvisionInventory,
  createdId: string,
): boolean {
  const beforeById = new Map(before.objects.map((object) => [object.id, object]));
  const afterById = new Map(after.objects.map((object) => [object.id, object]));
  if (afterById.size !== beforeById.size + 1 || beforeById.has(createdId)) return false;
  for (const [id, object] of beforeById) {
    const afterObject = afterById.get(id);
    if (
      afterObject === undefined ||
      linearProvisionDigest(object) !== linearProvisionDigest(afterObject)
    ) {
      return false;
    }
  }
  return afterById.has(createdId);
}

function withoutReservation(
  reservations: LinearProvisionBindings["reservations"],
  key: string,
): Readonly<Record<string, LinearProvisionReservation>> {
  return Object.freeze(
    Object.fromEntries(Object.entries(reservations).filter(([candidate]) => candidate !== key)),
  );
}

export class LinearProvisionUseCase {
  readonly #inFlight = new Map<string, Promise<Result<LinearProvisionOutcome, DomainError>>>();
  readonly #confirmationContext: LinearProvisionConfirmationContext;
  readonly #desiredObjects: readonly LinearProvisionDesiredObject[];
  readonly #desiredConfigDigest: string;

  constructor(
    readonly target: LinearProvisionTarget,
    readonly remote: LinearProvisionPort,
    readonly bindingStore: LinearProvisionBindingPort,
    options: LinearProvisionUseCaseOptions,
  ) {
    const confirmationContext = options.confirmationContext;
    const desiredObjects = options.desiredObjects ?? linearProvisionDesiredObjects;
    if (
      !validTarget(target) ||
      !digestPattern.test(confirmationContext.digest) ||
      !validDesiredObjects(desiredObjects)
    ) {
      throw new TypeError("Invalid Linear provision composition.");
    }
    this.#confirmationContext = Object.freeze({ ...confirmationContext });
    this.#desiredObjects = Object.freeze([...desiredObjects]);
    this.#desiredConfigDigest = configDigest(this.#desiredObjects);
  }

  async preview(options: ReadOptions = {}): Promise<Result<LinearProvisionPreview, DomainError>> {
    const context = await this.#readContext(options);
    return context.ok ? ok(this.#previewContext(context.value).preview) : context;
  }

  provision(
    command: LinearProvisionCommand,
    options: ReadOptions = {},
  ): Promise<Result<LinearProvisionOutcome, DomainError>> {
    const suppliedOperation: unknown = command.operation;
    const suppliedConfirmation: unknown = command.confirmationText;
    if (
      suppliedOperation !== "provision" ||
      !digestPattern.test(command.expectedRevision) ||
      !digestPattern.test(command.confirmationToken) ||
      suppliedConfirmation !== provisionConfirmationText
    ) {
      return Promise.resolve(failure("conflict"));
    }
    const operationKey = `provision:${command.expectedRevision}:${command.confirmationToken}`;
    const pending = this.#inFlight.get(operationKey);
    if (pending !== undefined) return pending;
    const operation = this.#provision(command, options).finally(() => {
      this.#inFlight.delete(operationKey);
    });
    this.#inFlight.set(operationKey, operation);
    return operation;
  }

  async previewManualReadBack(
    request: LinearManualReadBackRequest,
    options: ReadOptions = {},
  ): Promise<Result<LinearManualReadBackPreview, DomainError>> {
    if (!validCanonicalLinearId(request.remoteId)) return failure("conflict");
    const desired = this.#desiredObjects.find((item) => item.key === request.logicalKey);
    if (desired === undefined) return failure("conflict");
    const context = await this.#readContext(options);
    if (!context.ok) return context;
    return this.#manualPreview(request, desired, context.value);
  }

  #manualPreview(
    request: LinearManualReadBackRequest,
    desired: LinearProvisionDesiredObject,
    context: ReadContext,
  ): Result<LinearManualReadBackPreview, DomainError> {
    if (context.bindings.byKey[desired.key] !== undefined) return failure("conflict");
    const remote = context.inventory.objects.find((object) => object.id === request.remoteId);
    if (
      remote === undefined ||
      !matchesDesired(remote, desired, this.target, context.bindings.byKey)
    ) {
      return failure("conflict");
    }
    const reservation = context.bindings.reservations[desired.key];
    if (
      reservation !== undefined &&
      (reservation.desiredFingerprint !== desired.fingerprint ||
        reservation.phase === "verification_pending")
    ) {
      return failure("conflict");
    }
    const expectedRevision = snapshotRevision(
      this.target,
      context.inventory,
      context.bindings,
      this.#desiredConfigDigest,
    );
    const confirmationToken = linearProvisionDigest({
      purpose: "agent-team-linear-confirmation-v2",
      operation: "manual_readback",
      contextDigest: this.#confirmationContext.digest,
      target: this.target,
      desiredConfigDigest: this.#desiredConfigDigest,
      inventoryRevision: inventoryDigest(context.inventory),
      bindingRevision: context.bindings.revision,
      expectedRevision,
      logicalKey: desired.key,
      desiredFingerprint: desired.fingerprint,
      remoteIdDigest: linearProvisionDigest(request.remoteId),
    });
    return ok(
      Object.freeze({
        operation: "manual_readback",
        state: "ready",
        logicalKey: desired.key,
        name: desired.name,
        expectedRevision,
        confirmationToken,
      }),
    );
  }

  async readBackManual(
    command: LinearManualReadBackCommand,
    options: ReadOptions = {},
  ): Promise<Result<LinearProvisionPreview, DomainError>> {
    const suppliedOperation: unknown = command.operation;
    const suppliedConfirmation: unknown = command.confirmationText;
    if (
      suppliedOperation !== "manual_readback" ||
      suppliedConfirmation !== manualConfirmationText ||
      !validCanonicalLinearId(command.remoteId) ||
      !digestPattern.test(command.expectedRevision) ||
      !digestPattern.test(command.confirmationToken)
    ) {
      return failure("conflict");
    }
    const context = await this.#readContext(options);
    if (!context.ok) return context;
    const desired = this.#desiredObjects.find((item) => item.key === command.logicalKey);
    if (desired === undefined) return failure("conflict");
    const existing = context.value.bindings.reservations[command.logicalKey];
    if (existing?.phase === "verification_pending") {
      return this.#completeManualVerification(
        command,
        desired,
        existing,
        context.value.bindings,
        options,
      );
    }
    const preview = this.#manualPreview(command, desired, context.value);
    if (
      !preview.ok ||
      preview.value.expectedRevision !== command.expectedRevision ||
      preview.value.confirmationToken !== command.confirmationToken
    ) {
      return preview.ok ? failure("conflict") : preview;
    }
    const remote = context.value.inventory.objects.find((object) => object.id === command.remoteId);
    if (
      remote === undefined ||
      context.value.bindings.byKey[command.logicalKey] !== undefined ||
      snapshotRevision(
        this.target,
        context.value.inventory,
        context.value.bindings,
        this.#desiredConfigDigest,
      ) !== command.expectedRevision ||
      !matchesDesired(remote, desired, this.target, context.value.bindings.byKey)
    ) {
      return failure("conflict");
    }
    const pending: LinearProvisionReservation = Object.freeze({
      logicalKey: desired.key,
      operation: "manual_readback",
      ownerDigest: this.#confirmationContext.digest,
      desiredFingerprint: desired.fingerprint,
      phase: "verification_pending",
      candidateRemoteId: remote.id,
      candidateResourceFingerprint: remote.fingerprint,
      authoritativeInventoryDigest: inventoryDigest(context.value.inventory),
      confirmationProofDigest: linearProvisionDigest(command.confirmationToken),
    });
    const staged = await this.#cas(
      context.value.bindings,
      Object.freeze({
        byKey: context.value.bindings.byKey,
        reservations: Object.freeze({
          ...context.value.bindings.reservations,
          [command.logicalKey]: pending,
        }),
      }),
      options,
    );
    if (!staged.ok) return staged;
    return this.#completeManualVerification(command, desired, pending, staged.value, options);
  }

  async #completeManualVerification(
    command: LinearManualReadBackCommand,
    desired: LinearProvisionDesiredObject,
    pending: LinearProvisionReservation,
    bindings: LinearProvisionBindings,
    options: ReadOptions,
  ): Promise<Result<LinearProvisionPreview, DomainError>> {
    if (
      pending.operation !== "manual_readback" ||
      pending.phase !== "verification_pending" ||
      pending.ownerDigest !== this.#confirmationContext.digest ||
      pending.desiredFingerprint !== desired.fingerprint ||
      pending.candidateRemoteId !== command.remoteId ||
      pending.confirmationProofDigest !== linearProvisionDigest(command.confirmationToken) ||
      bindings.byKey[desired.key] !== undefined
    ) {
      return failure("conflict");
    }
    const postRead = await this.remote.readInventory(this.target, options);
    if (!postRead.ok) return postRead;
    const remote = postRead.value.objects.find((object) => object.id === pending.candidateRemoteId);
    if (
      !validInventory(this.target, postRead.value) ||
      inventoryDigest(postRead.value) !== pending.authoritativeInventoryDigest ||
      remote === undefined ||
      remote.fingerprint !== pending.candidateResourceFingerprint ||
      !matchesDesired(remote, desired, this.target, bindings.byKey)
    ) {
      return failure("conflict");
    }
    const saved = await this.#cas(
      bindings,
      Object.freeze({
        byKey: Object.freeze({ ...bindings.byKey, [desired.key]: remote.id }),
        reservations: withoutReservation(bindings.reservations, desired.key),
      }),
      options,
    );
    if (!saved.ok) return saved;
    return this.preview(options);
  }

  /** Linear comments are untrusted timeline data and can never confirm provisioning. */
  applyLinearComment(comment: string): Readonly<{ state: "ignored" }> {
    void comment;
    return Object.freeze({ state: "ignored" });
  }

  async #provision(
    command: LinearProvisionCommand,
    options: ReadOptions,
  ): Promise<Result<LinearProvisionOutcome, DomainError>> {
    const confirmed = await this.#confirmedProvisionContext(command, options);
    if (!confirmed.ok) return confirmed;
    let inventory = confirmed.value.inventory;
    let bindings = confirmed.value.bindings;
    const createdKeys: string[] = [];

    for (const action of confirmed.value.preview.actions) {
      if (action.state !== "create") continue;
      if (options.signal?.aborted === true) return failure("interrupted");
      const desired = this.#desiredObjects.find((item) => item.key === action.key);
      if (desired === undefined || bindings.byKey[desired.key] !== undefined) {
        return failure("conflict");
      }

      let reservation = bindings.reservations[desired.key];
      if (reservation === undefined) {
        reservation = Object.freeze({
          logicalKey: desired.key,
          operation: "provision",
          ownerDigest: this.#confirmationContext.digest,
          desiredFingerprint: desired.fingerprint,
          phase: "reserved",
        });
        const reserved = await this.#cas(
          bindings,
          Object.freeze({
            byKey: bindings.byKey,
            reservations: Object.freeze({
              ...bindings.reservations,
              [desired.key]: reservation,
            }),
          }),
          options,
        );
        if (!reserved.ok) return reserved;
        bindings = reserved.value;
      } else if (
        reservation.ownerDigest !== this.#confirmationContext.digest ||
        reservation.desiredFingerprint !== desired.fingerprint ||
        reservation.phase !== "reserved"
      ) {
        return failure("conflict");
      }

      const justBefore = await this.remote.readInventory(this.target, options);
      if (!justBefore.ok) {
        const released = await this.#releaseReserved(bindings, desired.key, reservation, options);
        return released.ok ? justBefore : released;
      }
      if (
        !validInventory(this.target, justBefore.value) ||
        inventoryDigest(justBefore.value) !== inventoryDigest(inventory)
      ) {
        const released = await this.#releaseReserved(bindings, desired.key, reservation, options);
        return released.ok ? failure("conflict") : released;
      }
      const parentId = expectedParentId(desired, bindings.byKey);
      if (desired.parentKey !== undefined && parentId === undefined) {
        const released = await this.#releaseReserved(bindings, desired.key, reservation, options);
        return released.ok ? failure("conflict") : released;
      }

      const mutationStartedReservation: LinearProvisionReservation = Object.freeze({
        ...reservation,
        phase: "mutation_started",
      });
      const mutationStarted = await this.#cas(
        bindings,
        Object.freeze({
          byKey: bindings.byKey,
          reservations: Object.freeze({
            ...bindings.reservations,
            [desired.key]: mutationStartedReservation,
          }),
        }),
        options,
      );
      if (!mutationStarted.ok) return mutationStarted;
      bindings = mutationStarted.value;

      const created = await this.remote.create(this.target, desired, parentId, options);
      if (!created.ok) return created;
      if (!idPattern.test(created.value.id)) return failure("external_failure");

      const readBack = await this.remote.readInventory(this.target, options);
      if (!readBack.ok) return readBack;
      const remote = readBack.value.objects.find((object) => object.id === created.value.id);
      if (
        !validInventory(this.target, readBack.value) ||
        remote === undefined ||
        !matchesDesired(remote, desired, this.target, bindings.byKey) ||
        !onlyExpectedAddition(inventory, readBack.value, remote.id)
      ) {
        return failure("external_failure");
      }
      const saved = await this.#cas(
        bindings,
        Object.freeze({
          byKey: Object.freeze({ ...bindings.byKey, [desired.key]: remote.id }),
          reservations: withoutReservation(bindings.reservations, desired.key),
        }),
        options,
      );
      if (!saved.ok) return saved;
      bindings = saved.value;
      inventory = readBack.value;
      createdKeys.push(desired.key);
    }

    const finalPreview = await this.preview(options);
    if (!finalPreview.ok) return finalPreview;
    return ok(
      Object.freeze({
        state: finalPreview.value.state === "ready" ? "complete" : "incomplete",
        createdKeys: Object.freeze(createdKeys),
        preview: finalPreview.value,
      }),
    );
  }

  async #confirmedProvisionContext(
    command: LinearProvisionCommand,
    options: ReadOptions,
  ): Promise<Result<PreviewContext, DomainError>> {
    const context = await this.#readContext(options);
    if (!context.ok) return context;
    const projected = this.#previewContext(context.value);
    return projected.preview.expectedRevision === command.expectedRevision &&
      projected.preview.confirmationToken === command.confirmationToken
      ? ok(projected)
      : failure("conflict");
  }

  async #releaseReserved(
    bindings: LinearProvisionBindings,
    logicalKey: string,
    reservation: LinearProvisionReservation,
    options: ReadOptions,
  ): Promise<Result<LinearProvisionBindings, DomainError>> {
    const current = bindings.reservations[logicalKey];
    if (
      current?.operation !== "provision" ||
      current.ownerDigest !== this.#confirmationContext.digest ||
      current.phase !== "reserved" ||
      linearProvisionDigest(current) !== linearProvisionDigest(reservation)
    ) {
      return failure("conflict");
    }
    return this.#cas(
      bindings,
      Object.freeze({
        byKey: bindings.byKey,
        reservations: withoutReservation(bindings.reservations, logicalKey),
      }),
      options,
    );
  }

  async #cas(
    current: LinearProvisionBindings,
    next: LinearProvisionBindingMutation,
    options: ReadOptions,
  ): Promise<Result<LinearProvisionBindings, DomainError>> {
    const saved = await this.bindingStore.compareAndSwap(
      this.target,
      current.revision,
      next,
      options,
    );
    if (!saved.ok) return saved;
    return validBindings(saved.value, this.#desiredObjects) &&
      revisionAdvanced(current.revision, saved.value.revision) &&
      linearProvisionDigest({
        byKey: saved.value.byKey,
        reservations: saved.value.reservations,
      }) === linearProvisionDigest(next)
      ? saved
      : failure("external_failure");
  }

  #previewContext(context: ReadContext): PreviewContext {
    return previewContext(
      this.target,
      context.inventory,
      context.bindings,
      this.#desiredObjects,
      this.#confirmationContext,
      this.#desiredConfigDigest,
    );
  }

  async #readContext(options: ReadOptions): Promise<Result<ReadContext, DomainError>> {
    if (options.signal?.aborted === true) return failure("interrupted");
    const [inventory, bindings] = await Promise.all([
      this.remote.readInventory(this.target, options),
      this.bindingStore.read(this.target, options),
    ]);
    if (!inventory.ok) return inventory;
    if (!bindings.ok) return bindings;
    if (
      !validInventory(this.target, inventory.value) ||
      !validBindings(bindings.value, this.#desiredObjects)
    ) {
      return failure("external_failure");
    }
    return ok(Object.freeze({ inventory: inventory.value, bindings: bindings.value }));
  }
}
