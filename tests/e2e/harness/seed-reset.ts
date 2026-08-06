/**
 * E006: Case Seed/Reset. Before a Live E2E Case (E101-E118) runs, `seedCase()` creates exactly
 * the sandbox objects that case needs and records every one of them into the case's manifest
 * (seed-reset-manifest.ts) as it goes -- never after the fact, so a partial failure still leaves
 * an accurate record of what must eventually be cleaned up. After the case finishes, `resetCase()`
 * cleans up ONLY the objects listed in that exact manifest, and only after re-reading each one
 * back from its provider and confirming its marker still matches what seeding wrote -- it never
 * searches by name/pattern, and it never touches anything outside the manifest's scope.
 *
 * Ground rules (plan.md 15.2, quoted verbatim by the task): 僅能清理自身建立且具 Run ID 的
 * Sandbox 物件；Dry-run 列全量；Scope 外物件拒絕；重跑冪等.
 *
 * Known, disclosed capability gap -- `githubBranch`: seeding a branch is fully supported (this
 * module uses the general-purpose `RegistrationProbeGitPort`, which has no branch-prefix
 * restriction). Deleting one is not: the only branch-delete mutation anywhere in `src/**` is
 * `RegistrationProbeBranchCleanupPort.deleteOwnedBranch`
 * (src/adapters/registration/proactive-probe-branch-cleanup.ts), and it hard-rejects
 * (`invariant_violation`) any branch not prefixed `agent-team/probe/` -- the O006 registration
 * probe's own namespace. Reusing it for E2E case branches would mean either laundering E2E
 * branches under O006's probe namespace (a scope/semantics violation of a security-relevant
 * adapter) or adding a new, more general `src/**` capability -- both out of this task's authorized
 * scope (`不動 src/**`) and an exact match for this task's own escalation trigger ("發現必須新增
 * src 層能力才能安全清理某類物件"). Rather than work around this silently, `resetCase()` always
 * classifies a `githubBranch` entry as `requires_manual` (reason
 * `"branch_delete_capability_unavailable"`), never attempts an unauthorized deletion route, and
 * this finding is surfaced verbatim in this task's final report for the coordinator to decide.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Clock } from "../../../src/domain/foundation/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../../src/domain/foundation/index.js";
import {
  E2eCaseManifestStore,
  caseRunIdPattern,
  type E2eCaseManifest,
  type E2eManifestEntry,
  type E2eManifestKind,
} from "./seed-reset-manifest.js";
import type {
  GitRepositoryRef,
  RegistrationProbeLinearTarget,
  SeedResetPorts,
} from "./seed-reset-ports.js";

export const e2eMarkerPrefix = "agent-team-e2e:";
export function e2eMarker(caseRunId: string): string {
  return `${e2eMarkerPrefix}${caseRunId}`;
}

const e2eBranchMarkerFilePath = ".agent-team-e2e/manifest.json";

export interface SeedLinearIssueRequest {
  readonly target: RegistrationProbeLinearTarget;
  readonly title: string;
}

export interface SeedGithubBranchRequest {
  readonly localRepository: GitRepositoryRef;
  /** Where the ephemeral push worktree is created, e.g. `<agentTeamHome>/state/e2e/worktrees` --
   * must NOT be nested under `localRepository.rootPath` (`createWorktree` rejects a target path
   * that is a descendant of the repository root as a `conflict`, mirroring how O006's own
   * `allowedWorktreeRoot` is always a sibling tree, never nested under the project repo). */
  readonly worktreeRoot: string;
  readonly remote: string;
  readonly repository: string;
  readonly baseBranch: string;
  readonly branchName: string;
}

export interface SeedGithubDraftPullRequestRequest {
  readonly repository: string;
  readonly baseBranch: string;
  /** Must equal `githubBranch.branchName` in the same command -- a draft PR always needs its
   * own head branch to already exist, and this module never seeds a branch it cannot also
   * account for in the manifest. */
  readonly headBranch: string;
  readonly title: string;
  readonly body: string;
}

export interface SeedLocalWorktreeRequest {
  readonly localRepository: GitRepositoryRef;
  readonly path: string;
  readonly branchName: string;
  readonly startPoint: string;
}

export interface SeedCaseCommand {
  readonly caseId: string;
  readonly caseRunId: string;
  readonly linearIssue?: SeedLinearIssueRequest;
  readonly githubBranch?: SeedGithubBranchRequest;
  readonly githubDraftPullRequest?: SeedGithubDraftPullRequestRequest;
  readonly localWorktree?: SeedLocalWorktreeRequest;
}

function validateSeedCommand(command: SeedCaseCommand): Result<void, DomainError> {
  if (!caseRunIdPattern.test(command.caseRunId)) return err(domainError("invariant_violation"));
  if (command.githubDraftPullRequest !== undefined) {
    const branch = command.githubBranch;
    if (
      branch?.branchName !== command.githubDraftPullRequest.headBranch ||
      branch.repository !== command.githubDraftPullRequest.repository
    ) {
      return err(domainError("invariant_violation"));
    }
  }
  return ok(undefined);
}

function existingEntry(
  manifest: E2eCaseManifest | undefined,
  kind: E2eManifestKind,
): E2eManifestEntry | undefined {
  return manifest?.entries.find((entry) => entry.kind === kind);
}

async function seedLinearIssue(
  ports: SeedResetPorts,
  manifestStore: E2eCaseManifestStore,
  command: SeedCaseCommand,
  request: SeedLinearIssueRequest,
  clock: Pick<Clock, "now">,
  existing: E2eManifestEntry | undefined,
): Promise<Result<void, DomainError>> {
  if (existing !== undefined) return ok(undefined);
  const marker = e2eMarker(command.caseRunId);
  const created = await ports.linear.create(
    { target: request.target, marker, title: request.title, body: marker },
    { idempotencyKey: `e2e-seed:${command.caseRunId}:linearIssue` },
  );
  if (!created.ok) return created;
  const appended = await manifestStore.appendEntry(command.caseId, command.caseRunId, {
    kind: "linearIssue",
    provider: "linear",
    id: created.value.issueId,
    marker,
    createdAt: clock.now(),
    teamId: request.target.teamId,
    projectId: request.target.projectId,
    workflowStateId: request.target.workflowStateId,
  });
  return appended.ok ? ok(undefined) : appended;
}

async function seedGithubBranch(
  ports: SeedResetPorts,
  manifestStore: E2eCaseManifestStore,
  command: SeedCaseCommand,
  request: SeedGithubBranchRequest,
  clock: Pick<Clock, "now">,
  existing: E2eManifestEntry | undefined,
): Promise<Result<void, DomainError>> {
  if (existing !== undefined) return ok(undefined);
  const marker = e2eMarker(command.caseRunId);
  const worktreePath = join(request.worktreeRoot, command.caseRunId);
  const worktree = await ports.git.createWorktree(
    {
      rootPath: request.localRepository.rootPath,
      path: worktreePath,
      branch: request.branchName,
      startPoint: request.baseBranch,
    },
    { idempotencyKey: `e2e-seed:${command.caseRunId}:githubBranch:worktree` },
  );
  if (!worktree.ok) return worktree;

  const markerFilePath = join(worktree.value.path, e2eBranchMarkerFilePath);
  try {
    await mkdir(join(worktree.value.path, ".agent-team-e2e"), { recursive: true });
    await writeFile(
      markerFilePath,
      `${JSON.stringify({ marker, caseId: command.caseId, caseRunId: command.caseRunId }, null, 2)}\n`,
      "utf8",
    );
  } catch {
    return err(domainError("external_failure"));
  }

  const staged = await ports.git.stagePaths(worktree.value, [e2eBranchMarkerFilePath], {
    idempotencyKey: `e2e-seed:${command.caseRunId}:githubBranch:stage`,
  });
  if (!staged.ok) return staged;
  const committed = await ports.git.commit(
    {
      worktree: worktree.value,
      message: `agent-team-e2e: ${marker}`,
      expectedStagedPaths: [e2eBranchMarkerFilePath],
    },
    { idempotencyKey: `e2e-seed:${command.caseRunId}:githubBranch:commit` },
  );
  if (!committed.ok) return committed;
  const pushed = await ports.git.push(worktree.value, request.remote, {
    idempotencyKey: `e2e-seed:${command.caseRunId}:githubBranch:push`,
  });
  if (!pushed.ok) return pushed;
  const readBack = await ports.git.inspectRemoteBranch(
    { rootPath: request.localRepository.rootPath },
    request.remote,
    request.branchName,
  );
  if (!readBack.ok) return readBack;
  if (readBack.value?.sha !== pushed.value.sha) {
    return err(domainError("external_failure"));
  }
  const removed = await ports.git.removeWorktree(worktree.value, {
    idempotencyKey: `e2e-seed:${command.caseRunId}:githubBranch:remove`,
  });
  if (!removed.ok) return removed;

  const appended = await manifestStore.appendEntry(command.caseId, command.caseRunId, {
    kind: "githubBranch",
    provider: "github",
    id: request.branchName,
    marker,
    createdAt: clock.now(),
    repository: request.repository,
    headSha: pushed.value.sha,
  });
  return appended.ok ? ok(undefined) : appended;
}

async function seedGithubDraftPullRequest(
  ports: SeedResetPorts,
  manifestStore: E2eCaseManifestStore,
  command: SeedCaseCommand,
  request: SeedGithubDraftPullRequestRequest,
  clock: Pick<Clock, "now">,
  existing: E2eManifestEntry | undefined,
): Promise<Result<void, DomainError>> {
  if (existing !== undefined) return ok(undefined);
  const marker = e2eMarker(command.caseRunId);
  const created = await ports.sourceControl.createDraftChangeRequest(
    {
      repository: request.repository,
      title: request.title,
      body: `${request.body}\n\n${marker}`,
      baseBranch: request.baseBranch,
      headBranch: request.headBranch,
    },
    { idempotencyKey: `e2e-seed:${command.caseRunId}:githubDraftPullRequest` },
  );
  if (!created.ok) return created;
  const appended = await manifestStore.appendEntry(command.caseId, command.caseRunId, {
    kind: "githubDraftPullRequest",
    provider: "github",
    id: String(created.value.number),
    marker,
    createdAt: clock.now(),
    repository: request.repository,
    headBranch: request.headBranch,
  });
  return appended.ok ? ok(undefined) : appended;
}

async function seedLocalWorktree(
  ports: SeedResetPorts,
  manifestStore: E2eCaseManifestStore,
  command: SeedCaseCommand,
  request: SeedLocalWorktreeRequest,
  clock: Pick<Clock, "now">,
  existing: E2eManifestEntry | undefined,
): Promise<Result<void, DomainError>> {
  if (existing !== undefined) return ok(undefined);
  const marker = e2eMarker(command.caseRunId);
  const worktree = await ports.git.createWorktree(
    {
      rootPath: request.localRepository.rootPath,
      path: request.path,
      branch: request.branchName,
      startPoint: request.startPoint,
    },
    { idempotencyKey: `e2e-seed:${command.caseRunId}:localWorktree` },
  );
  if (!worktree.ok) return worktree;
  const appended = await manifestStore.appendEntry(command.caseId, command.caseRunId, {
    kind: "localWorktree",
    provider: "local",
    id: worktree.value.path,
    marker,
    createdAt: clock.now(),
    repositoryRoot: request.localRepository.rootPath,
    branch: worktree.value.branch,
    headSha: worktree.value.headSha,
  });
  return appended.ok ? ok(undefined) : appended;
}

/**
 * Seeds every requested kind, in a fixed order (`linearIssue` -> `githubBranch` ->
 * `githubDraftPullRequest` -> `localWorktree`), persisting each created object into the manifest
 * immediately after it is created -- before moving on to the next kind -- so a failure partway
 * through still leaves an accurate, reset-able record of everything that was actually created.
 * Idempotent: a kind already present in the manifest is never re-created.
 */
export async function seedCase(
  ports: SeedResetPorts,
  manifestStore: E2eCaseManifestStore,
  command: SeedCaseCommand,
  clock: Pick<Clock, "now">,
): Promise<Result<E2eCaseManifest, DomainError>> {
  const validated = validateSeedCommand(command);
  if (!validated.ok) return validated;

  const before = await manifestStore.load(command.caseRunId);
  if (!before.ok) return before;
  if (before.value !== undefined && before.value.caseId !== command.caseId) {
    return err(domainError("invariant_violation"));
  }

  if (command.linearIssue !== undefined) {
    const result = await seedLinearIssue(
      ports,
      manifestStore,
      command,
      command.linearIssue,
      clock,
      existingEntry(before.value, "linearIssue"),
    );
    if (!result.ok) return result;
  }
  if (command.githubBranch !== undefined) {
    const result = await seedGithubBranch(
      ports,
      manifestStore,
      command,
      command.githubBranch,
      clock,
      existingEntry(before.value, "githubBranch"),
    );
    if (!result.ok) return result;
  }
  if (command.githubDraftPullRequest !== undefined) {
    const result = await seedGithubDraftPullRequest(
      ports,
      manifestStore,
      command,
      command.githubDraftPullRequest,
      clock,
      existingEntry(before.value, "githubDraftPullRequest"),
    );
    if (!result.ok) return result;
  }
  if (command.localWorktree !== undefined) {
    const result = await seedLocalWorktree(
      ports,
      manifestStore,
      command,
      command.localWorktree,
      clock,
      existingEntry(before.value, "localWorktree"),
    );
    if (!result.ok) return result;
  }

  const after = await manifestStore.load(command.caseRunId);
  if (!after.ok) return after;
  if (after.value === undefined) return err(domainError("invariant_violation"));
  return ok(after.value);
}

export type ResetEntryAction =
  | "already_confirmed"
  | "confirmed_now"
  | "already_absent"
  | "requires_manual"
  | "would_clean"
  | "would_confirm_absent";

export interface ResetEntryOutcome {
  readonly kind: E2eManifestKind;
  readonly id: string;
  readonly action: ResetEntryAction;
  readonly reason?: string;
}

export interface ResetCaseOutcome {
  readonly caseRunId: string;
  readonly dryRun: boolean;
  readonly entries: readonly ResetEntryOutcome[];
}

const branchDeleteCapabilityUnavailableReason = "branch_delete_capability_unavailable";

async function resetLinearIssue(
  ports: SeedResetPorts,
  entry: E2eManifestEntry & { readonly kind: "linearIssue" },
  dryRun: boolean,
): Promise<Result<ResetEntryOutcome, DomainError>> {
  const target: RegistrationProbeLinearTarget = {
    teamId: entry.teamId,
    projectId: entry.projectId,
    workflowStateId: entry.workflowStateId,
  };
  const found = await ports.linear.findByMarker(target, entry.marker);
  if (!found.ok) return found;
  if (found.value?.issueId !== entry.id) {
    return ok({
      kind: entry.kind,
      id: entry.id,
      action: dryRun ? "would_confirm_absent" : "already_absent",
    });
  }
  if (found.value.state === "cancelled") {
    return ok({
      kind: entry.kind,
      id: entry.id,
      action: dryRun ? "would_confirm_absent" : "already_absent",
    });
  }
  if (dryRun) return ok({ kind: entry.kind, id: entry.id, action: "would_clean" });
  const cancelled = await ports.linear.cancel(entry.id, {
    idempotencyKey: `e2e-reset:linearIssue:${entry.id}`,
  });
  if (!cancelled.ok) return cancelled;
  if (cancelled.value.issueId !== entry.id || cancelled.value.state !== "cancelled") {
    return ok({
      kind: entry.kind,
      id: entry.id,
      action: "requires_manual",
      reason: "cancel_readback_mismatch",
    });
  }
  return ok({ kind: entry.kind, id: entry.id, action: "confirmed_now" });
}

async function resetGithubDraftPullRequest(
  ports: SeedResetPorts,
  entry: E2eManifestEntry & { readonly kind: "githubDraftPullRequest" },
  dryRun: boolean,
): Promise<Result<ResetEntryOutcome, DomainError>> {
  const found = await ports.github.findDraftPullRequestByHead(
    { repository: entry.repository, headBranch: entry.headBranch },
    entry.marker,
  );
  if (!found.ok) return found;
  if (found.value === undefined) {
    return ok({
      kind: entry.kind,
      id: entry.id,
      action: dryRun ? "would_confirm_absent" : "already_absent",
    });
  }
  if (dryRun) return ok({ kind: entry.kind, id: entry.id, action: "would_clean" });
  const closed = await ports.sourceControl.closeChangeRequest(
    { repository: entry.repository, changeRequestId: found.value.changeRequestId },
    { idempotencyKey: `e2e-reset:githubDraftPullRequest:${entry.id}` },
  );
  if (!closed.ok) return closed;
  if (closed.value.state === "open") {
    return ok({
      kind: entry.kind,
      id: entry.id,
      action: "requires_manual",
      reason: "close_readback_mismatch",
    });
  }
  return ok({ kind: entry.kind, id: entry.id, action: "confirmed_now" });
}

function resetGithubBranch(
  entry: E2eManifestEntry & { readonly kind: "githubBranch" },
  dryRun: boolean,
): ResetEntryOutcome {
  // See the file-level doc comment: no `src/**` capability exists today to delete an arbitrary
  // branch this module created (only the O006-scoped `agent-team/probe/`-prefixed one does).
  // Always fail closed rather than invent a workaround.
  return {
    kind: entry.kind,
    id: entry.id,
    action: "requires_manual",
    reason: dryRun
      ? `${branchDeleteCapabilityUnavailableReason}_dry_run`
      : branchDeleteCapabilityUnavailableReason,
  };
}

async function resetLocalWorktree(
  ports: SeedResetPorts,
  entry: E2eManifestEntry & { readonly kind: "localWorktree" },
  dryRun: boolean,
): Promise<Result<ResetEntryOutcome, DomainError>> {
  const worktree = {
    repositoryRoot: entry.repositoryRoot,
    path: entry.id,
    branch: entry.branch,
    headSha: entry.headSha,
  };
  const inspected = await ports.git.inspectWorkingTree(worktree);
  if (!inspected.ok) {
    return inspected.error.code === "not_found"
      ? ok({
          kind: entry.kind,
          id: entry.id,
          action: dryRun ? "would_confirm_absent" : "already_absent",
        })
      : inspected;
  }
  if (inspected.value.headSha !== entry.headSha || inspected.value.changes.length > 0) {
    return ok({
      kind: entry.kind,
      id: entry.id,
      action: "requires_manual",
      reason: "worktree_dirty_or_moved",
    });
  }
  if (dryRun) return ok({ kind: entry.kind, id: entry.id, action: "would_clean" });
  const removed = await ports.git.removeWorktree(worktree, {
    idempotencyKey: `e2e-reset:localWorktree:${entry.id}`,
  });
  if (!removed.ok) return removed;
  return ok({ kind: entry.kind, id: entry.id, action: "confirmed_now" });
}

async function resetEntry(
  ports: SeedResetPorts,
  entry: E2eManifestEntry,
  dryRun: boolean,
): Promise<Result<ResetEntryOutcome, DomainError>> {
  switch (entry.kind) {
    case "linearIssue":
      return resetLinearIssue(ports, entry, dryRun);
    case "githubDraftPullRequest":
      return resetGithubDraftPullRequest(ports, entry, dryRun);
    case "githubBranch":
      return ok(resetGithubBranch(entry, dryRun));
    case "localWorktree":
      return resetLocalWorktree(ports, entry, dryRun);
  }
}

/**
 * Resets (or, when `dryRun` is true, only reports what it would do to) every entry in this
 * case's manifest -- and nothing else. Never mutates in dry-run mode. An entry already recorded
 * as `resolution.state === "confirmed"` from a previous run is reported as `already_confirmed`
 * without any port call at all (idempotent re-run). Every other entry is re-verified against its
 * provider by exact id + marker readback before any mutation is attempted; a mismatch never
 * mutates and is flagged `requires_manual` instead.
 */
export async function resetCase(
  ports: SeedResetPorts,
  manifestStore: E2eCaseManifestStore,
  caseRunId: string,
  clock: Pick<Clock, "now">,
  options: Readonly<{ dryRun: boolean }>,
): Promise<Result<ResetCaseOutcome, DomainError>> {
  const loaded = await manifestStore.load(caseRunId);
  if (!loaded.ok) return loaded;
  if (loaded.value === undefined) return err(domainError("not_found"));

  const outcomes: ResetEntryOutcome[] = [];
  for (const entry of loaded.value.entries) {
    if (entry.resolution?.state === "confirmed") {
      outcomes.push({ kind: entry.kind, id: entry.id, action: "already_confirmed" });
      continue;
    }
    const outcome = await resetEntry(ports, entry, options.dryRun);
    if (!outcome.ok) return outcome;
    outcomes.push(outcome.value);

    if (options.dryRun) continue;
    if (outcome.value.action === "confirmed_now" || outcome.value.action === "already_absent") {
      const recorded = await manifestStore.recordResolution(caseRunId, entry.kind, entry.id, {
        state: "confirmed",
        resolvedAt: clock.now(),
      });
      if (!recorded.ok) return recorded;
    } else if (outcome.value.action === "requires_manual") {
      const recorded = await manifestStore.recordResolution(caseRunId, entry.kind, entry.id, {
        state: "requires_manual",
        resolvedAt: clock.now(),
        reason: outcome.value.reason ?? "unknown",
      });
      if (!recorded.ok) return recorded;
    }
  }

  return ok({ caseRunId, dryRun: options.dryRun, entries: outcomes });
}
