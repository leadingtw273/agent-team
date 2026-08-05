import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import type { MutationOptions, ReadOptions } from "../ports/index.js";

export const githubRegistrationRequiredChecks = Object.freeze(["CI", "agent-team/review"] as const);

export const githubRegistrationManagedRulesetName = "Agent Team required merge gate v1" as const;

export const githubRegistrationDesiredPolicy = Object.freeze({
  ruleset: Object.freeze({
    name: githubRegistrationManagedRulesetName,
    target: "branch" as const,
    enforcement: "active" as const,
    conditions: Object.freeze({
      include: Object.freeze(["~DEFAULT_BRANCH"] as const),
      exclude: Object.freeze(["refs/heads/__agent_team_never__"] as const),
    }),
    bypassActors: Object.freeze([] as const),
    requiredStatusChecks: Object.freeze({
      contexts: githubRegistrationRequiredChecks,
      strictRequiredStatusChecksPolicy: true as const,
      doNotEnforceOnCreate: false as const,
    }),
  }),
  autoMerge: true as const,
});

export interface GitHubRegistrationTarget {
  readonly projectId: string;
  readonly repository: string;
  readonly defaultBranch: string;
}

export interface GitHubRegistrationInventory {
  /** SHA-256 of the complete authoritative, allowlisted provider projection. */
  readonly revision: string;
  readonly permission: "admin" | "read_only";
  readonly rulesets: "supported" | "unsupported";
  readonly autoMerge: "supported" | "unsupported";
  readonly autoMergeEnabled: boolean;
  /** Informational union only; it never substitutes for one exact managed Ruleset. */
  readonly activeRequiredChecks: readonly string[];
  readonly managedRulesetCollision: boolean;
  readonly managedRulesetExact: boolean;
  readonly managedRulesetId?: string;
}

export interface GitHubRegistrationPolicyBefore {
  readonly revision: string;
  readonly permission: "admin" | "read_only";
  readonly rulesets: "supported" | "unsupported";
  readonly autoMerge: "supported" | "unsupported";
  readonly autoMergeEnabled: boolean;
  readonly activeRequiredChecks: readonly string[];
  readonly managedRulesetCollision: boolean;
  readonly managedRulesetExact: boolean;
  readonly managedRulesetId: string | null;
}

export interface GitHubRegistrationPolicyDiff {
  readonly schemaVersion: 1;
  readonly before: GitHubRegistrationPolicyBefore;
  readonly after: Readonly<{
    readonly desiredPolicy: typeof githubRegistrationDesiredPolicy;
    readonly preservedActiveRequiredChecks: readonly string[];
  }>;
}

export interface GitHubRegistrationCreateRulesetRequest {
  readonly target: GitHubRegistrationTarget;
  readonly expectedRevision: string;
  readonly desiredPolicy: typeof githubRegistrationDesiredPolicy.ruleset;
}

export interface GitHubRegistrationEnableAutoMergeRequest {
  readonly target: GitHubRegistrationTarget;
}

export interface GitHubRegistrationPolicyPort {
  readonly inspect: (
    target: GitHubRegistrationTarget,
    options?: ReadOptions,
  ) => Promise<Result<GitHubRegistrationInventory, DomainError>>;
  /** Additive-only POST. The application journal must enter mutation_started first. */
  readonly createManagedRuleset: (
    request: GitHubRegistrationCreateRulesetRequest,
    options: MutationOptions,
  ) => Promise<Result<Readonly<{ rulesetId: string }>, DomainError>>;
  /** Idempotent true-only PATCH; authoritative read-back remains required. */
  readonly enableAutoMerge: (
    request: GitHubRegistrationEnableAutoMergeRequest,
    options: MutationOptions,
  ) => Promise<Result<Readonly<{ changed: boolean }>, DomainError>>;
}

export type GitHubPolicyOperationPhase =
  "reserved" | "mutation_started" | "verification_pending" | "completed";

export interface GitHubPolicyOperationSnapshot {
  readonly schemaVersion: 1;
  readonly operationId: string;
  /** Store-owned, monotonically increasing CAS revision. */
  readonly revision: number;
  readonly bindingRevision: string;
  readonly inventoryRevision: string;
  readonly phase: GitHubPolicyOperationPhase;
  readonly reservationId: string;
  readonly rulesetId: string | null;
  readonly autoMergeAttempted: boolean;
  readonly changed: boolean;
}

export type GitHubPolicyOperationNext = Omit<
  GitHubPolicyOperationSnapshot,
  "schemaVersion" | "operationId" | "revision"
>;

export interface GitHubPolicyOperationStore {
  readonly read: (
    operationId: string,
  ) => Promise<Result<GitHubPolicyOperationSnapshot | undefined, DomainError>>;
  readonly compareAndSwap: (
    command: Readonly<{
      operationId: string;
      expectedRevision: number | null;
      next: GitHubPolicyOperationNext;
    }>,
  ) => Promise<Result<GitHubPolicyOperationSnapshot, DomainError>>;
}

export type GitHubRegistrationChange = "ensure_required_checks" | "enable_auto_merge";
export type GitHubRegistrationBlockReason =
  | "auto_merge_unsupported"
  | "confirmation_invalid"
  | "inventory_changed"
  | "managed_ruleset_collision"
  | "mutation_outcome_unknown"
  | "operation_recovery_required"
  | "permission_required"
  | "provider_unavailable"
  | "read_back_incomplete"
  | "rulesets_unsupported";

export type GitHubRegistrationPreview =
  | Readonly<{
      state: "ready";
      setupState: "configuration_incomplete";
      expectedRevision: string;
      confirmationToken: string;
      changes: readonly GitHubRegistrationChange[];
      policyDiff: GitHubRegistrationPolicyDiff;
    }>
  | Readonly<{
      state: "configured";
      setupState: "configuration_incomplete";
      changes: readonly [];
      gates: Readonly<{
        github_review_status: "passed";
        github_auto_merge: "passed";
      }>;
    }>
  | Readonly<{
      state: "blocked";
      setupState: "configuration_incomplete";
      reason: GitHubRegistrationBlockReason;
      changes: readonly GitHubRegistrationChange[];
    }>;

export interface GitHubRegistrationApplyCommand extends GitHubRegistrationTarget {
  readonly operation: "apply_github_policy";
  readonly confirmationText: "套用 GitHub 合併保護";
  readonly expectedRevision: string;
  readonly confirmationToken: string;
  readonly signal?: AbortSignal;
}

export type GitHubRegistrationApplyOutcome =
  | Readonly<{
      state: "configured";
      setupState: "configuration_incomplete";
      changed: boolean;
      gates: Readonly<{
        github_review_status: "passed";
        github_auto_merge: "passed";
      }>;
    }>
  | Readonly<{
      state: "blocked";
      setupState: "configuration_incomplete";
      reason: GitHubRegistrationBlockReason;
    }>;

export interface GitHubRegistrationPolicyUseCase {
  readonly preview: (
    target: GitHubRegistrationTarget,
    options?: ReadOptions,
  ) => Promise<GitHubRegistrationPreview>;
  readonly apply: (
    command: GitHubRegistrationApplyCommand,
  ) => Promise<GitHubRegistrationApplyOutcome>;
}

interface CreateGitHubRegistrationPolicyOptions {
  readonly port: GitHubRegistrationPolicyPort;
  readonly operationStore: GitHubPolicyOperationStore;
  readonly confirmationKey: Uint8Array;
  readonly confirmationContext: Readonly<{ authorityDigest: string }>;
  readonly generateReservationId?: () => string;
}

interface ConfirmationPayload {
  readonly schemaVersion: 3;
  readonly purpose: "agent-team-github-registration-confirmation-v3";
  readonly authorityDigest: string;
  readonly operation: "apply_github_policy";
  readonly projectId: string;
  readonly repository: string;
  readonly defaultBranch: string;
  readonly desiredPolicy: typeof githubRegistrationDesiredPolicy;
  readonly inventoryRevision: string;
  readonly bindingRevision: string;
  readonly storeRevision: number;
  readonly changes: readonly GitHubRegistrationChange[];
  readonly policyDiff: GitHubRegistrationPolicyDiff;
  readonly policyDiffDigest: string;
}

const projectIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$/u;
const authorityDigestPattern = /^[a-f0-9]{64}$/u;
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/u;
const branchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u;
const revisionPattern = /^[a-f0-9]{64}$/u;
const tokenPattern = /^[A-Za-z0-9_-]{20,12288}\.[A-Za-z0-9_-]{43}$/u;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const maximumActiveRequiredCheckCharacters = 3_000;
const passedGates = Object.freeze({
  github_review_status: "passed" as const,
  github_auto_merge: "passed" as const,
});
const noChanges: readonly [] = Object.freeze([]);

function validTarget(target: GitHubRegistrationTarget): boolean {
  const parts = target.repository.split("/");
  return (
    projectIdPattern.test(target.projectId) &&
    repositoryPattern.test(target.repository) &&
    parts.length === 2 &&
    parts.every((part) => part !== "." && part !== "..") &&
    branchPattern.test(target.defaultBranch) &&
    !target.defaultBranch.includes("..") &&
    !target.defaultBranch.includes("//") &&
    !target.defaultBranch.endsWith(".") &&
    !target.defaultBranch.endsWith("/") &&
    !target.defaultBranch.endsWith(".lock")
  );
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function bindingRevision(target: GitHubRegistrationTarget): string {
  return stableHash({ target, desiredPolicy: githubRegistrationDesiredPolicy });
}

function operationId(target: GitHubRegistrationTarget): string {
  return stableHash({
    purpose: "github-policy-operation-v1",
    target,
    desiredPolicy: githubRegistrationDesiredPolicy,
  });
}

function changesFor(inventory: GitHubRegistrationInventory): readonly GitHubRegistrationChange[] {
  const changes: GitHubRegistrationChange[] = [];
  if (!inventory.managedRulesetExact) changes.push("ensure_required_checks");
  if (!inventory.autoMergeEnabled) changes.push("enable_auto_merge");
  return Object.freeze(changes);
}

function policyBefore(inventory: GitHubRegistrationInventory): GitHubRegistrationPolicyBefore {
  return Object.freeze({
    revision: inventory.revision,
    permission: inventory.permission,
    rulesets: inventory.rulesets,
    autoMerge: inventory.autoMerge,
    autoMergeEnabled: inventory.autoMergeEnabled,
    activeRequiredChecks: Object.freeze([...inventory.activeRequiredChecks]),
    managedRulesetCollision: inventory.managedRulesetCollision,
    managedRulesetExact: inventory.managedRulesetExact,
    managedRulesetId: inventory.managedRulesetId ?? null,
  });
}

function policyDiffFor(inventory: GitHubRegistrationInventory): GitHubRegistrationPolicyDiff {
  const before = policyBefore(inventory);
  return Object.freeze({
    schemaVersion: 1,
    before,
    after: Object.freeze({
      desiredPolicy: githubRegistrationDesiredPolicy,
      preservedActiveRequiredChecks: Object.freeze([...before.activeRequiredChecks]),
    }),
  });
}

function inventoryFromPolicyBefore(
  before: GitHubRegistrationPolicyBefore,
): GitHubRegistrationInventory {
  return Object.freeze({
    revision: before.revision,
    permission: before.permission,
    rulesets: before.rulesets,
    autoMerge: before.autoMerge,
    autoMergeEnabled: before.autoMergeEnabled,
    activeRequiredChecks: before.activeRequiredChecks,
    managedRulesetCollision: before.managedRulesetCollision,
    managedRulesetExact: before.managedRulesetExact,
    ...(before.managedRulesetId === null ? {} : { managedRulesetId: before.managedRulesetId }),
  });
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function totalCheckCharacters(checks: readonly unknown[]): number {
  let total = 0;
  for (const context of checks) {
    if (typeof context !== "string") return maximumActiveRequiredCheckCharacters + 1;
    total += context.length;
  }
  return total;
}

function policyDiffIsValid(value: unknown): value is GitHubRegistrationPolicyDiff {
  if (typeof value !== "object" || value === null) return false;
  const diff = value as Readonly<Record<string, unknown>>;
  const beforeValue = diff["before"];
  const afterValue = diff["after"];
  if (
    diff["schemaVersion"] !== 1 ||
    !exactKeys(diff, ["after", "before", "schemaVersion"]) ||
    typeof beforeValue !== "object" ||
    beforeValue === null ||
    typeof afterValue !== "object" ||
    afterValue === null
  ) {
    return false;
  }
  const before = beforeValue as Readonly<Record<string, unknown>>;
  const after = afterValue as Readonly<Record<string, unknown>>;
  const checks = before["activeRequiredChecks"];
  const managedRulesetId = before["managedRulesetId"];
  if (
    !exactKeys(before, [
      "activeRequiredChecks",
      "autoMerge",
      "autoMergeEnabled",
      "managedRulesetCollision",
      "managedRulesetExact",
      "managedRulesetId",
      "permission",
      "revision",
      "rulesets",
    ]) ||
    typeof before["revision"] !== "string" ||
    !revisionPattern.test(before["revision"]) ||
    (before["permission"] !== "admin" && before["permission"] !== "read_only") ||
    (before["rulesets"] !== "supported" && before["rulesets"] !== "unsupported") ||
    (before["autoMerge"] !== "supported" && before["autoMerge"] !== "unsupported") ||
    typeof before["autoMergeEnabled"] !== "boolean" ||
    !Array.isArray(checks) ||
    checks.length > 100 ||
    totalCheckCharacters(checks) > maximumActiveRequiredCheckCharacters ||
    !checks.every(
      (context) =>
        typeof context === "string" &&
        context.length > 0 &&
        context.length <= 100 &&
        !/[\r\n\0]/u.test(context),
    ) ||
    typeof before["managedRulesetCollision"] !== "boolean" ||
    typeof before["managedRulesetExact"] !== "boolean" ||
    (managedRulesetId !== null &&
      (typeof managedRulesetId !== "string" || !identifierPattern.test(managedRulesetId))) ||
    (before["managedRulesetExact"] && managedRulesetId === null) ||
    !exactKeys(after, ["desiredPolicy", "preservedActiveRequiredChecks"]) ||
    JSON.stringify(after["desiredPolicy"]) !== JSON.stringify(githubRegistrationDesiredPolicy) ||
    JSON.stringify(after["preservedActiveRequiredChecks"]) !== JSON.stringify(checks)
  ) {
    return false;
  }
  const typed = value as GitHubRegistrationPolicyDiff;
  return (
    JSON.stringify(typed) === JSON.stringify(policyDiffFor(inventoryFromPolicyBefore(typed.before)))
  );
}

function inventoryIsValid(inventory: GitHubRegistrationInventory): boolean {
  return (
    revisionPattern.test(inventory.revision) &&
    Array.isArray(inventory.activeRequiredChecks) &&
    inventory.activeRequiredChecks.length <= 100 &&
    totalCheckCharacters(inventory.activeRequiredChecks) <= maximumActiveRequiredCheckCharacters &&
    inventory.activeRequiredChecks.every(
      (context) =>
        typeof context === "string" &&
        context.length > 0 &&
        context.length <= 100 &&
        !/[\r\n\0]/u.test(context),
    ) &&
    (inventory.managedRulesetId === undefined ||
      identifierPattern.test(inventory.managedRulesetId)) &&
    (!inventory.managedRulesetExact || inventory.managedRulesetId !== undefined)
  );
}

function blocked(
  reason: GitHubRegistrationBlockReason,
  changes: readonly GitHubRegistrationChange[] = Object.freeze([]),
): GitHubRegistrationPreview {
  return Object.freeze({
    state: "blocked",
    setupState: "configuration_incomplete",
    reason,
    changes,
  });
}

function blockReason(error: DomainError): GitHubRegistrationBlockReason {
  return error.code === "permission_denied" ? "permission_required" : "provider_unavailable";
}

function policyBlock(
  inventory: GitHubRegistrationInventory,
): GitHubRegistrationBlockReason | undefined {
  if (!inventoryIsValid(inventory)) return "provider_unavailable";
  if (inventory.permission !== "admin") return "permission_required";
  if (inventory.rulesets !== "supported") return "rulesets_unsupported";
  if (inventory.autoMerge !== "supported") return "auto_merge_unsupported";
  if (inventory.managedRulesetCollision) return "managed_ruleset_collision";
  return undefined;
}

function confirmationPayload(
  authorityDigest: string,
  target: GitHubRegistrationTarget,
  storeRevision: number,
  changes: readonly GitHubRegistrationChange[],
  policyDiff: GitHubRegistrationPolicyDiff,
): ConfirmationPayload {
  return Object.freeze({
    schemaVersion: 3,
    purpose: "agent-team-github-registration-confirmation-v3",
    authorityDigest,
    operation: "apply_github_policy",
    projectId: target.projectId,
    repository: target.repository,
    defaultBranch: target.defaultBranch,
    desiredPolicy: githubRegistrationDesiredPolicy,
    inventoryRevision: policyDiff.before.revision,
    bindingRevision: bindingRevision(target),
    storeRevision,
    changes,
    policyDiff,
    policyDiffDigest: stableHash(policyDiff),
  });
}

function signedToken(key: Uint8Array, payload: ConfirmationPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", key).update(encoded, "ascii").digest("base64url");
  return `${encoded}.${signature}`;
}

function secureSignatureEqual(candidate: string, expected: string): boolean {
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(candidate, "ascii"), Buffer.from(expected, "ascii"));
}

function parseConfirmationToken(key: Uint8Array, token: string): ConfirmationPayload | undefined {
  if (!tokenPattern.test(token)) return undefined;
  const [encoded, candidateSignature] = token.split(".");
  if (encoded === undefined || candidateSignature === undefined) return undefined;
  const expectedSignature = createHmac("sha256", key).update(encoded, "ascii").digest("base64url");
  if (!secureSignatureEqual(candidateSignature, expectedSignature)) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null) return undefined;
    const payload = value as Readonly<Record<string, unknown>>;
    const authority = payload["authorityDigest"];
    const projectId = payload["projectId"];
    const repository = payload["repository"];
    const defaultBranch = payload["defaultBranch"];
    const inventoryRevision = payload["inventoryRevision"];
    const binding = payload["bindingRevision"];
    if (
      payload["schemaVersion"] !== 3 ||
      payload["purpose"] !== "agent-team-github-registration-confirmation-v3" ||
      typeof authority !== "string" ||
      !authorityDigestPattern.test(authority) ||
      payload["operation"] !== "apply_github_policy" ||
      typeof projectId !== "string" ||
      !projectIdPattern.test(projectId) ||
      typeof repository !== "string" ||
      !repositoryPattern.test(repository) ||
      typeof defaultBranch !== "string" ||
      !branchPattern.test(defaultBranch) ||
      typeof inventoryRevision !== "string" ||
      !revisionPattern.test(inventoryRevision) ||
      typeof binding !== "string" ||
      !revisionPattern.test(binding) ||
      !Number.isSafeInteger(payload["storeRevision"]) ||
      (payload["storeRevision"] as number) < 0 ||
      JSON.stringify(payload["desiredPolicy"]) !==
        JSON.stringify(githubRegistrationDesiredPolicy) ||
      !Array.isArray(payload["changes"]) ||
      !payload["changes"].every(
        (change) => change === "ensure_required_checks" || change === "enable_auto_merge",
      ) ||
      !policyDiffIsValid(payload["policyDiff"]) ||
      typeof payload["policyDiffDigest"] !== "string" ||
      !revisionPattern.test(payload["policyDiffDigest"]) ||
      payload["policyDiffDigest"] !== stableHash(payload["policyDiff"]) ||
      payload["policyDiff"].before.revision !== inventoryRevision ||
      JSON.stringify(payload["changes"]) !==
        JSON.stringify(changesFor(inventoryFromPolicyBefore(payload["policyDiff"].before))) ||
      !exactKeys(payload, [
        "authorityDigest",
        "bindingRevision",
        "changes",
        "defaultBranch",
        "desiredPolicy",
        "inventoryRevision",
        "operation",
        "policyDiff",
        "policyDiffDigest",
        "projectId",
        "purpose",
        "repository",
        "schemaVersion",
        "storeRevision",
      ])
    ) {
      return undefined;
    }
    return payload as unknown as ConfirmationPayload;
  } catch {
    return undefined;
  }
}

function configuredPreview(): GitHubRegistrationPreview {
  return Object.freeze({
    state: "configured",
    setupState: "configuration_incomplete",
    changes: noChanges,
    gates: passedGates,
  });
}

function memoryOperationStore(): GitHubPolicyOperationStore {
  const records = new Map<string, GitHubPolicyOperationSnapshot>();
  return Object.freeze({
    read: (id: string) => Promise.resolve(ok(records.get(id))),
    compareAndSwap: (
      command: Readonly<{
        operationId: string;
        expectedRevision: number | null;
        next: GitHubPolicyOperationNext;
      }>,
    ) => {
      const current = records.get(command.operationId);
      if ((current?.revision ?? null) !== command.expectedRevision) {
        return Promise.resolve(err(domainError("conflict")));
      }
      const stored = Object.freeze({
        schemaVersion: 1 as const,
        operationId: command.operationId,
        revision: (current?.revision ?? 0) + 1,
        ...command.next,
      });
      records.set(command.operationId, stored);
      return Promise.resolve(ok(stored));
    },
  });
}

export function createInMemoryGitHubPolicyOperationStore(): GitHubPolicyOperationStore {
  return memoryOperationStore();
}

export function createGitHubRegistrationPolicy(
  options: CreateGitHubRegistrationPolicyOptions,
): GitHubRegistrationPolicyUseCase {
  const key = Uint8Array.from(options.confirmationKey);
  const authorityDigest = options.confirmationContext.authorityDigest;
  const store = options.operationStore;
  const generateReservationId = options.generateReservationId ?? randomUUID;
  if (key.byteLength < 32)
    throw new TypeError("GitHub confirmation key must be at least 32 bytes.");
  if (!authorityDigestPattern.test(authorityDigest)) {
    throw new TypeError("GitHub confirmation authority digest must be a SHA-256 digest.");
  }

  const preview: GitHubRegistrationPolicyUseCase["preview"] = async (target, readOptions = {}) => {
    if (!validTarget(target)) return blocked("provider_unavailable");
    const operation = await store.read(operationId(target));
    if (!operation.ok) return blocked("provider_unavailable");
    if (
      operation.value !== undefined &&
      (operation.value.bindingRevision !== bindingRevision(target) ||
        operation.value.phase === "reserved" ||
        operation.value.phase === "mutation_started")
    ) {
      return blocked("operation_recovery_required");
    }
    const result = await options.port.inspect(target, readOptions);
    if (!result.ok) {
      return blocked(
        operation.value?.phase === "verification_pending" && operation.value.autoMergeAttempted
          ? "mutation_outcome_unknown"
          : blockReason(result.error),
      );
    }
    if (
      operation.value?.phase === "verification_pending" &&
      operation.value.autoMergeAttempted &&
      !result.value.autoMergeEnabled
    ) {
      return blocked("mutation_outcome_unknown");
    }
    const policyFailure = policyBlock(result.value);
    const changes = changesFor(result.value);
    if (policyFailure !== undefined) return blocked(policyFailure, changes);
    if (
      operation.value?.phase === "verification_pending" ||
      operation.value?.phase === "completed"
    ) {
      if (
        !result.value.managedRulesetExact ||
        result.value.managedRulesetId !== operation.value.rulesetId
      ) {
        return blocked("read_back_incomplete", changes);
      }
    }
    if (operation.value?.phase === "completed") {
      return changes.length === 0 ? configuredPreview() : blocked("read_back_incomplete", changes);
    }
    if (changes.length === 0 && operation.value?.phase !== "verification_pending") {
      return configuredPreview();
    }
    const payload = confirmationPayload(
      authorityDigest,
      target,
      operation.value?.revision ?? 0,
      changes,
      policyDiffFor(result.value),
    );
    return Object.freeze({
      state: "ready",
      setupState: "configuration_incomplete",
      expectedRevision: result.value.revision,
      confirmationToken: signedToken(key, payload),
      changes,
      policyDiff: payload.policyDiff,
    });
  };

  const apply: GitHubRegistrationPolicyUseCase["apply"] = async (command) => {
    const blockedApply = (reason: GitHubRegistrationBlockReason): GitHubRegistrationApplyOutcome =>
      Object.freeze({ state: "blocked", setupState: "configuration_incomplete", reason });
    if (
      !validTarget(command) ||
      (command as { readonly operation?: unknown }).operation !== "apply_github_policy" ||
      (command as { readonly confirmationText?: unknown }).confirmationText !==
        "套用 GitHub 合併保護" ||
      !revisionPattern.test(command.expectedRevision)
    ) {
      return blockedApply("confirmation_invalid");
    }
    const payload = parseConfirmationToken(key, command.confirmationToken);
    if (payload?.authorityDigest !== authorityDigest) {
      return blockedApply("confirmation_invalid");
    }
    const target = Object.freeze({
      projectId: command.projectId,
      repository: command.repository,
      defaultBranch: command.defaultBranch,
    });
    if (
      payload.projectId !== target.projectId ||
      payload.repository !== target.repository ||
      payload.defaultBranch !== target.defaultBranch ||
      payload.bindingRevision !== bindingRevision(target) ||
      payload.inventoryRevision !== command.expectedRevision
    ) {
      return blockedApply("inventory_changed");
    }
    const id = operationId(target);
    const stored = await store.read(id);
    if (!stored.ok) return blockedApply("provider_unavailable");
    if (
      stored.value?.phase === "reserved" ||
      stored.value?.phase === "mutation_started" ||
      (stored.value !== undefined && stored.value.bindingRevision !== payload.bindingRevision)
    ) {
      return blockedApply("operation_recovery_required");
    }
    const readOptions = command.signal === undefined ? {} : { signal: command.signal };
    const current = await options.port.inspect(target, readOptions);
    if (!current.ok) {
      return blockedApply(
        stored.value?.phase === "verification_pending" && stored.value.autoMergeAttempted
          ? "mutation_outcome_unknown"
          : blockReason(current.error),
      );
    }
    if (
      stored.value?.phase === "verification_pending" &&
      stored.value.autoMergeAttempted &&
      !current.value.autoMergeEnabled
    ) {
      return blockedApply("mutation_outcome_unknown");
    }
    if ((stored.value?.revision ?? 0) !== payload.storeRevision) {
      return blockedApply("inventory_changed");
    }
    const policyFailure = policyBlock(current.value);
    if (policyFailure !== undefined) return blockedApply(policyFailure);
    if (current.value.revision !== payload.inventoryRevision) {
      return blockedApply("inventory_changed");
    }
    const changes = changesFor(current.value);
    if (
      JSON.stringify(changes) !== JSON.stringify(payload.changes) ||
      JSON.stringify(policyDiffFor(current.value)) !== JSON.stringify(payload.policyDiff)
    ) {
      return blockedApply("inventory_changed");
    }

    const completeVerification = async (
      snapshot: GitHubPolicyOperationSnapshot,
    ): Promise<GitHubRegistrationApplyOutcome> => {
      let journal = snapshot;
      let observed = current.value;
      if (!observed.managedRulesetExact || observed.managedRulesetId !== journal.rulesetId) {
        const fresh = await options.port.inspect(target, readOptions);
        if (!fresh.ok) return blockedApply(blockReason(fresh.error));
        observed = fresh.value;
      }
      if (
        policyBlock(observed) !== undefined ||
        !observed.managedRulesetExact ||
        observed.managedRulesetId !== journal.rulesetId
      ) {
        return blockedApply("read_back_incomplete");
      }
      if (!observed.autoMergeEnabled) {
        if (journal.autoMergeAttempted) {
          return blockedApply("mutation_outcome_unknown");
        }
        const attempting = await store.compareAndSwap({
          operationId: id,
          expectedRevision: journal.revision,
          next: Object.freeze({
            ...journal,
            phase: "verification_pending" as const,
            autoMergeAttempted: true,
          }),
        });
        if (!attempting.ok) return blockedApply("inventory_changed");
        journal = attempting.value;
        const enabled = await options.port.enableAutoMerge(Object.freeze({ target }), {
          idempotencyKey: `github-policy-operation:${id}:auto-merge`,
          ...readOptions,
        });
        if (!enabled.ok) return blockedApply("mutation_outcome_unknown");
      }
      const readBack = await options.port.inspect(target, readOptions);
      if (!readBack.ok) return blockedApply(blockReason(readBack.error));
      if (
        policyBlock(readBack.value) !== undefined ||
        !readBack.value.managedRulesetExact ||
        readBack.value.managedRulesetId !== journal.rulesetId ||
        !readBack.value.autoMergeEnabled ||
        changesFor(readBack.value).length !== 0
      ) {
        return blockedApply("read_back_incomplete");
      }
      const completed = await store.compareAndSwap({
        operationId: id,
        expectedRevision: journal.revision,
        next: Object.freeze({
          ...journal,
          phase: "completed" as const,
          autoMergeAttempted: journal.autoMergeAttempted || !current.value.autoMergeEnabled,
        }),
      });
      if (!completed.ok) return blockedApply("inventory_changed");
      return Object.freeze({
        state: "configured",
        setupState: "configuration_incomplete",
        changed: completed.value.changed,
        gates: passedGates,
      });
    };

    if (stored.value?.phase === "verification_pending") {
      return completeVerification(stored.value);
    }
    if (stored.value?.phase === "completed") {
      return changes.length === 0 &&
        current.value.managedRulesetExact &&
        current.value.managedRulesetId === stored.value.rulesetId
        ? Object.freeze({
            state: "configured",
            setupState: "configuration_incomplete",
            changed: false,
            gates: passedGates,
          })
        : blockedApply("read_back_incomplete");
    }
    if (changes.length === 0) {
      return Object.freeze({
        state: "configured",
        setupState: "configuration_incomplete",
        changed: false,
        gates: passedGates,
      });
    }

    const reservationId = generateReservationId();
    if (!identifierPattern.test(reservationId)) return blockedApply("provider_unavailable");
    const reserved = await store.compareAndSwap({
      operationId: id,
      expectedRevision: null,
      next: Object.freeze({
        bindingRevision: payload.bindingRevision,
        inventoryRevision: payload.inventoryRevision,
        phase: "reserved" as const,
        reservationId,
        autoMergeAttempted: false,
        changed: false,
        rulesetId: null,
      }),
    });
    if (!reserved.ok) return blockedApply("inventory_changed");
    const preRead = await options.port.inspect(target, readOptions);
    if (
      !preRead.ok ||
      preRead.value.revision !== payload.inventoryRevision ||
      policyBlock(preRead.value) !== undefined ||
      JSON.stringify(changesFor(preRead.value)) !== JSON.stringify(payload.changes) ||
      JSON.stringify(policyDiffFor(preRead.value)) !== JSON.stringify(payload.policyDiff)
    ) {
      return blockedApply(preRead.ok ? "inventory_changed" : blockReason(preRead.error));
    }
    const started = await store.compareAndSwap({
      operationId: id,
      expectedRevision: reserved.value.revision,
      next: Object.freeze({
        ...reserved.value,
        phase: "mutation_started" as const,
      }),
    });
    if (!started.ok) return blockedApply("inventory_changed");

    let rulesetId = preRead.value.managedRulesetId;
    let changed = false;
    if (!preRead.value.managedRulesetExact) {
      const created = await options.port.createManagedRuleset(
        Object.freeze({
          target,
          expectedRevision: preRead.value.revision,
          desiredPolicy: githubRegistrationDesiredPolicy.ruleset,
        }),
        {
          idempotencyKey: `github-policy-operation:${id}:ruleset`,
          ...readOptions,
        },
      );
      if (!created.ok) return blockedApply("operation_recovery_required");
      rulesetId = created.value.rulesetId;
      changed = true;
    }
    if (rulesetId === undefined || !identifierPattern.test(rulesetId)) {
      return blockedApply("read_back_incomplete");
    }
    const verification = await store.compareAndSwap({
      operationId: id,
      expectedRevision: started.value.revision,
      next: Object.freeze({
        ...started.value,
        phase: "verification_pending" as const,
        rulesetId,
        changed,
      }),
    });
    if (!verification.ok) return blockedApply("operation_recovery_required");
    return completeVerification(verification.value);
  };

  return Object.freeze({ preview, apply });
}
