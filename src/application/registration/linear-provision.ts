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
  type LinearProvisionAction,
  type LinearProvisionActionState,
  type LinearProvisionBindingPort,
  type LinearProvisionBindings,
  type LinearProvisionCommand,
  type LinearProvisionDesiredObject,
  type LinearProvisionInventory,
  type LinearProvisionObjectKind,
  type LinearProvisionOutcome,
  type LinearProvisionPort,
  type LinearProvisionPreview,
  type LinearProvisionRemoteObject,
  type LinearProvisionTarget,
} from "./linear-provision-model.js";

export * from "./linear-provision-model.js";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const confirmationText = "套用 Linear 設定" as const;

interface PreviewContext {
  readonly preview: LinearProvisionPreview;
  readonly inventory: LinearProvisionInventory;
  readonly bindings: LinearProvisionBindings;
}

function failure<Value>(code: DomainError["code"]): Result<Value, DomainError> {
  return err(domainError(code));
}

function validTarget(target: LinearProvisionTarget): boolean {
  return idPattern.test(target.teamId) && idPattern.test(target.projectId);
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

function validBindings(bindings: LinearProvisionBindings): boolean {
  const desiredKeys = new Set(linearProvisionDesiredObjects.map((item) => item.key));
  const entries = Object.entries(bindings.byKey);
  return (
    digestPattern.test(bindings.revision) &&
    entries.every(([key, id]) => desiredKeys.has(key) && idPattern.test(id)) &&
    new Set(entries.map(([, id]) => id)).size === entries.length
  );
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
    return "請在本機 UI 以 Linear 物件 ID 完成 read-back 綁定；系統不會只憑名稱接管既有項目。";
  }
  switch (kind) {
    case "workflow_state":
      return "請在 Linear Team 工作流程中建立此中文狀態，再回本機 UI 輸入物件 ID 做 read-back。";
    case "label_group":
      return "請在 Linear 建立單選 Label Group，再回本機 UI 輸入 Group ID 做 read-back。";
    case "label":
      return "請先完成父 Label Group，再建立子 Label，最後回本機 UI 以子 Label ID 做 read-back。";
    case "form_template":
      return "請在 Linear 建立中文 Issue Form Template，再回本機 UI 輸入 Template ID 做 read-back。";
  }
}

function actionFor(
  desired: LinearProvisionDesiredObject,
  inventory: LinearProvisionInventory,
  bindings: LinearProvisionBindings,
  priorActions: ReadonlyMap<string, LinearProvisionAction>,
): LinearProvisionAction {
  const boundId = bindings.byKey[desired.key];
  if (boundId !== undefined) {
    const matches = inventory.objects.filter((object) => object.id === boundId);
    return Object.freeze({
      key: desired.key,
      kind: desired.kind,
      name: desired.name,
      state:
        matches.length === 1 &&
        matches[0] !== undefined &&
        matchesDesired(matches[0], desired, inventory.target, bindings.byKey)
          ? "unchanged"
          : "conflict",
      ...(matches.length === 1 &&
      matches[0] !== undefined &&
      matchesDesired(matches[0], desired, inventory.target, bindings.byKey)
        ? {}
        : {
            instruction:
              "已綁定的 Linear 物件遺失或內容不符；系統不會刪除、改名或改綁，請人工查明。",
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

function previewContext(
  target: LinearProvisionTarget,
  inventory: LinearProvisionInventory,
  bindings: LinearProvisionBindings,
): PreviewContext {
  const actions: LinearProvisionAction[] = [];
  const priorActions = new Map<string, LinearProvisionAction>();
  for (const desired of linearProvisionDesiredObjects) {
    const action = actionFor(desired, inventory, bindings, priorActions);
    actions.push(action);
    priorActions.set(action.key, action);
  }
  const expectedRevision = linearProvisionDigest({
    target,
    inventory: inventoryDigest(inventory),
    bindingRevision: bindings.revision,
    bindings: bindings.byKey,
  });
  const confirmationToken = linearProvisionDigest({
    purpose: "agent-team-linear-provision-confirmation-v1",
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

export class LinearProvisionUseCase {
  readonly #inFlight = new Map<string, Promise<Result<LinearProvisionOutcome, DomainError>>>();

  constructor(
    readonly target: LinearProvisionTarget,
    readonly remote: LinearProvisionPort,
    readonly bindingStore: LinearProvisionBindingPort,
  ) {
    if (!validTarget(target)) throw new TypeError("Invalid Linear provision target.");
  }

  async preview(options: ReadOptions = {}): Promise<Result<LinearProvisionPreview, DomainError>> {
    const context = await this.#readContext(options);
    return context.ok ? ok(context.value.preview) : context;
  }

  provision(
    command: LinearProvisionCommand,
    options: ReadOptions = {},
  ): Promise<Result<LinearProvisionOutcome, DomainError>> {
    const suppliedConfirmation: unknown = command.confirmationText;
    if (
      !digestPattern.test(command.expectedRevision) ||
      !digestPattern.test(command.confirmationToken) ||
      suppliedConfirmation !== confirmationText
    ) {
      return Promise.resolve(failure("conflict"));
    }
    const operationKey = `${command.expectedRevision}:${command.confirmationToken}`;
    const pending = this.#inFlight.get(operationKey);
    if (pending !== undefined) return pending;
    const operation = this.#provision(command, options).finally(() => {
      this.#inFlight.delete(operationKey);
    });
    this.#inFlight.set(operationKey, operation);
    return operation;
  }

  async readBackManual(
    command: LinearManualReadBackCommand,
    options: ReadOptions = {},
  ): Promise<Result<LinearProvisionPreview, DomainError>> {
    const suppliedConfirmation: unknown = command.confirmationText;
    if (
      !idPattern.test(command.remoteId) ||
      !linearProvisionDesiredObjects.some((item) => item.key === command.logicalKey) ||
      suppliedConfirmation !== confirmationText
    ) {
      return failure("conflict");
    }
    const context = await this.#confirmedContext(command, options);
    if (!context.ok) return context;
    if (context.value.bindings.byKey[command.logicalKey] !== undefined) {
      return failure("conflict");
    }
    const desired = linearProvisionDesiredObjects.find((item) => item.key === command.logicalKey);
    const remote = context.value.inventory.objects.find((object) => object.id === command.remoteId);
    if (
      desired === undefined ||
      remote === undefined ||
      !matchesDesired(remote, desired, this.target, context.value.bindings.byKey)
    ) {
      return failure("conflict");
    }
    const saved = await this.bindingStore.compareAndSwap(
      this.target,
      context.value.bindings.revision,
      Object.freeze({ ...context.value.bindings.byKey, [desired.key]: remote.id }),
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
    const confirmed = await this.#confirmedContext(command, options);
    if (!confirmed.ok) return confirmed;
    let inventory = confirmed.value.inventory;
    let bindings = confirmed.value.bindings;
    const createdKeys: string[] = [];

    for (const action of confirmed.value.preview.actions) {
      if (action.state !== "create") continue;
      if (options.signal?.aborted === true) return failure("interrupted");
      const desired = linearProvisionDesiredObjects.find((item) => item.key === action.key);
      if (desired === undefined || bindings.byKey[desired.key] !== undefined) {
        return failure("conflict");
      }
      const justBefore = await this.remote.readInventory(this.target, options);
      if (!justBefore.ok) return justBefore;
      if (
        !validInventory(this.target, justBefore.value) ||
        inventoryDigest(justBefore.value) !== inventoryDigest(inventory)
      ) {
        return failure("conflict");
      }
      const parentId = expectedParentId(desired, bindings.byKey);
      if (desired.parentKey !== undefined && parentId === undefined) return failure("conflict");
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
      const saved = await this.bindingStore.compareAndSwap(
        this.target,
        bindings.revision,
        Object.freeze({ ...bindings.byKey, [desired.key]: remote.id }),
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

  async #confirmedContext(
    command: LinearProvisionCommand,
    options: ReadOptions,
  ): Promise<Result<PreviewContext, DomainError>> {
    const context = await this.#readContext(options);
    if (!context.ok) return context;
    return context.value.preview.expectedRevision === command.expectedRevision &&
      context.value.preview.confirmationToken === command.confirmationToken
      ? context
      : failure("conflict");
  }

  async #readContext(options: ReadOptions): Promise<Result<PreviewContext, DomainError>> {
    if (options.signal?.aborted === true) return failure("interrupted");
    const [inventory, bindings] = await Promise.all([
      this.remote.readInventory(this.target, options),
      this.bindingStore.read(this.target, options),
    ]);
    if (!inventory.ok) return inventory;
    if (!bindings.ok) return bindings;
    if (!validInventory(this.target, inventory.value) || !validBindings(bindings.value)) {
      return failure("external_failure");
    }
    return ok(previewContext(this.target, inventory.value, bindings.value));
  }
}
