import { createHmac, timingSafeEqual } from "node:crypto";

import type { DomainError, Result } from "../../domain/foundation/index.js";
import type { MutationOptions, ReadOptions } from "../ports/index.js";

export const githubRegistrationRequiredChecks = Object.freeze(["CI", "agent-team/review"] as const);

export const githubRegistrationManagedRulesetName = "Agent Team required merge gate v1" as const;

export interface GitHubRegistrationTarget {
  readonly repository: string;
  readonly defaultBranch: string;
}

export interface GitHubRegistrationInventory {
  /** SHA-256 of the authoritative, allowlisted provider projection. */
  readonly revision: string;
  readonly permission: "admin" | "read_only";
  readonly rulesets: "supported" | "unsupported";
  readonly autoMerge: "supported" | "unsupported";
  readonly autoMergeEnabled: boolean;
  /** Union of required contexts from active rules applicable to the default branch. */
  readonly activeRequiredChecks: readonly string[];
  /** A foreign/drifted rule already occupies the reserved managed name. */
  readonly managedRulesetCollision: boolean;
}

export interface GitHubRegistrationProvisionRequest {
  readonly target: GitHubRegistrationTarget;
  readonly expectedRevision: string;
  readonly requiredChecks: typeof githubRegistrationRequiredChecks;
  readonly enableAutoMerge: true;
}

export interface GitHubRegistrationPolicyPort {
  readonly inspect: (
    target: GitHubRegistrationTarget,
    options?: ReadOptions,
  ) => Promise<Result<GitHubRegistrationInventory, DomainError>>;
  /**
   * Implementations must re-read and compare expectedRevision before any write.
   * They may only add the managed Ruleset and set auto-merge to true.
   */
  readonly provision: (
    request: GitHubRegistrationProvisionRequest,
    options: MutationOptions,
  ) => Promise<Result<Readonly<{ changed: boolean }>, DomainError>>;
}

export type GitHubRegistrationChange = "ensure_required_checks" | "enable_auto_merge";
export type GitHubRegistrationBlockReason =
  | "auto_merge_unsupported"
  | "confirmation_invalid"
  | "inventory_changed"
  | "managed_ruleset_collision"
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
  readonly confirmationKey: Uint8Array;
}

const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/u;
const branchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u;
const revisionPattern = /^[a-f0-9]{64}$/u;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;
const requiredCheckSet = new Set<string>(githubRegistrationRequiredChecks);
const passedGates = Object.freeze({
  github_review_status: "passed" as const,
  github_auto_merge: "passed" as const,
});
const noChanges: readonly [] = Object.freeze([]);

function validTarget(target: GitHubRegistrationTarget): boolean {
  const parts = target.repository.split("/");
  return (
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

function changesFor(inventory: GitHubRegistrationInventory): readonly GitHubRegistrationChange[] {
  const active = new Set(inventory.activeRequiredChecks);
  const changes: GitHubRegistrationChange[] = [];
  if ([...requiredCheckSet].some((context) => !active.has(context))) {
    changes.push("ensure_required_checks");
  }
  if (!inventory.autoMergeEnabled) changes.push("enable_auto_merge");
  return Object.freeze(changes);
}

function inventoryIsValid(inventory: GitHubRegistrationInventory): boolean {
  return (
    revisionPattern.test(inventory.revision) &&
    inventory.activeRequiredChecks.length <= 1_000 &&
    inventory.activeRequiredChecks.every(
      (context) =>
        typeof context === "string" &&
        context.length > 0 &&
        context.length <= 100 &&
        !/[\r\n\0]/u.test(context),
    )
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

function signingPayload(
  target: GitHubRegistrationTarget,
  expectedRevision: string,
  changes: readonly GitHubRegistrationChange[],
): string {
  return JSON.stringify({
    schemaVersion: 1,
    repository: target.repository,
    defaultBranch: target.defaultBranch,
    expectedRevision,
    changes,
  });
}

function signedToken(
  key: Uint8Array,
  target: GitHubRegistrationTarget,
  expectedRevision: string,
  changes: readonly GitHubRegistrationChange[],
): string {
  return createHmac("sha256", key)
    .update(signingPayload(target, expectedRevision, changes), "utf8")
    .digest("base64url");
}

function secureTokenEqual(candidate: string, expected: string): boolean {
  if (!tokenPattern.test(candidate) || !tokenPattern.test(expected)) return false;
  return timingSafeEqual(Buffer.from(candidate, "ascii"), Buffer.from(expected, "ascii"));
}

function configuredPreview(): GitHubRegistrationPreview {
  return Object.freeze({
    state: "configured",
    setupState: "configuration_incomplete",
    changes: noChanges,
    gates: passedGates,
  });
}

export function createGitHubRegistrationPolicy(
  options: CreateGitHubRegistrationPolicyOptions,
): GitHubRegistrationPolicyUseCase {
  const key = Uint8Array.from(options.confirmationKey);
  if (key.byteLength < 32)
    throw new TypeError("GitHub confirmation key must be at least 32 bytes.");

  const preview: GitHubRegistrationPolicyUseCase["preview"] = async (target, readOptions = {}) => {
    if (!validTarget(target)) return blocked("provider_unavailable");
    const result = await options.port.inspect(target, readOptions);
    if (!result.ok) return blocked(blockReason(result.error));
    const policyFailure = policyBlock(result.value);
    const changes = changesFor(result.value);
    if (policyFailure !== undefined) return blocked(policyFailure, changes);
    if (changes.length === 0) return configuredPreview();
    return Object.freeze({
      state: "ready",
      setupState: "configuration_incomplete",
      expectedRevision: result.value.revision,
      confirmationToken: signedToken(key, target, result.value.revision, changes),
      changes,
    });
  };

  const apply: GitHubRegistrationPolicyUseCase["apply"] = async (command) => {
    const blockedApply = (reason: GitHubRegistrationBlockReason): GitHubRegistrationApplyOutcome =>
      Object.freeze({ state: "blocked", setupState: "configuration_incomplete", reason });
    if (
      !validTarget(command) ||
      !revisionPattern.test(command.expectedRevision) ||
      !tokenPattern.test(command.confirmationToken)
    ) {
      return blockedApply("confirmation_invalid");
    }
    const target = Object.freeze({
      repository: command.repository,
      defaultBranch: command.defaultBranch,
    });
    const current = await options.port.inspect(
      target,
      command.signal === undefined ? {} : { signal: command.signal },
    );
    if (!current.ok) return blockedApply(blockReason(current.error));
    const policyFailure = policyBlock(current.value);
    if (policyFailure !== undefined) return blockedApply(policyFailure);
    if (current.value.revision !== command.expectedRevision)
      return blockedApply("inventory_changed");
    const changes = changesFor(current.value);
    const expectedToken = signedToken(key, target, command.expectedRevision, changes);
    if (!secureTokenEqual(command.confirmationToken, expectedToken)) {
      return blockedApply("confirmation_invalid");
    }
    if (changes.length === 0) {
      return Object.freeze({
        state: "configured",
        setupState: "configuration_incomplete",
        changed: false,
        gates: passedGates,
      });
    }
    const provisioned = await options.port.provision(
      Object.freeze({
        target,
        expectedRevision: current.value.revision,
        requiredChecks: githubRegistrationRequiredChecks,
        enableAutoMerge: true,
      }),
      {
        idempotencyKey: `github-registration:${command.confirmationToken}`,
        ...(command.signal === undefined ? {} : { signal: command.signal }),
      },
    );
    if (!provisioned.ok) {
      return blockedApply(
        provisioned.error.code === "conflict"
          ? "inventory_changed"
          : blockReason(provisioned.error),
      );
    }
    const readBack = await options.port.inspect(
      target,
      command.signal === undefined ? {} : { signal: command.signal },
    );
    if (!readBack.ok) return blockedApply(blockReason(readBack.error));
    if (policyBlock(readBack.value) !== undefined || changesFor(readBack.value).length !== 0) {
      return blockedApply("read_back_incomplete");
    }
    return Object.freeze({
      state: "configured",
      setupState: "configuration_incomplete",
      changed: provisioned.value.changed,
      gates: passedGates,
    });
  };

  return Object.freeze({ preview, apply });
}
