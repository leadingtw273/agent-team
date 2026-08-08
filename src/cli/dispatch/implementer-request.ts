/**
 * C015b item 5: builds `ImplementerPipelineRequest` (src/application/pipelines/implementer-model.ts)
 * from a genuinely dispatched job -- pure composition, no engine logic. The directive/PR text is
 * assembled from the same structured `Issue` fields `requirement-template.ts` just parsed out of
 * the Linear description, closing the loop: the fields that made the candidate eligible are the
 * same fields Claude is actually told to work from.
 *
 * BACKLOG (C015e, E101 first real run, not fixed by this ticket): `evaluateEligibility`
 * (src/domain/eligibility/decision.ts) never checks `changeRegions`, but
 * `ImplementerPipeline.run()`'s own `requestShapeValid` (src/application/pipelines/
 * implementer.ts) hard-requires it non-empty and fails the whole request with a generic
 * `state:"failed", stage:"request", error:{code:"invariant_violation"}` if it is missing -- an
 * eligibility/pipeline-request gap: a candidate can clear eligibility and get dispatched, then
 * hard-fail deterministically on its very first pipeline invocation with no field-specific
 * message pointing at `changeRegions`. E101's first real Linear issue hit exactly this (a human
 * filled in every other Ready Gate field but left "預期變更區域" empty). Fixing this is a
 * separate, not-yet-filed ticket -- it would need either `evaluateEligibility` gaining a
 * `changeRegions`-aware blocker (an eligibility-layer change, out of this ticket's "only
 * cli/dispatch layer" scope) or a friendlier pre-flight check here that turns the same condition
 * into an actionable CLI-level rejection before ever reaching the pipeline.
 */
import { join } from "node:path";

import { instantFromDate, type Clock, type Instant } from "../../domain/foundation/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { createRequirementSnapshot } from "../../domain/review/index.js";
import { watchdogHardStopMs, type Job } from "../../domain/jobs/index.js";
import type { Issue, Project } from "../../domain/project/index.js";
import type { TrustedProjectConfig } from "../../application/projects/index.js";
import type { ImplementerPipelineRequest } from "../../application/pipelines/index.js";

/**
 * Imports `watchdogHardStopMs` (src/domain/jobs/watchdog.ts) directly rather than duplicating the
 * literal 60-minute figure: this ticket wires no `WatchdogCoordinator` (that graduated
 * 45-minute-inspection/extension flow is genuinely new work outside this ticket's six items --
 * see the completion report), but the bounded child process deadline this composition sets must
 * still never exceed the hard-stop boundary the watchdog represents. Deriving from the same
 * constant means the process-level bound and the watchdog's own hard limit can never silently
 * drift apart, even though the smarter mid-flight extension logic is not present.
 */
const implementerProcessDeadlineMs = watchdogHardStopMs;

function bulletList(heading: string, items: readonly string[] | undefined): string | undefined {
  if (items === undefined || items.length === 0) return undefined;
  return `${heading}：\n${items.map((item) => `- ${item}`).join("\n")}`;
}

/**
 * `GitPreflight.inspect` (src/adapters/git/preflight.ts:160-183) checks `unexpected_untracked`
 * *independently* of `declaredRegions` membership -- a brand-new file the provider creates
 * *inside* a declared region is still flagged unless its exact path is also listed in
 * `expectedUntrackedPaths`. Only `coverage:"exact"` regions are used as the source for this: each
 * one already names one literal file path, which is exactly what "this specific new file is
 * expected" needs. `coverage:"subtree"` regions cannot contribute (no literal path to list), so a
 * genuinely new file the provider creates inside a `"subtree"` region will still trip
 * `unexpected_untracked` -- a disclosed limitation, not a silent one: the Ready Gate template
 * parser (`requirement-template.ts`) only ever emits `coverage:"exact"`, so this covers every
 * `changeRegions` entry this ticket's own discovery path can actually produce.
 */
function expectedUntrackedPathsFrom(issue: Issue): readonly string[] | undefined {
  const exactPaths = (issue.changeRegions ?? [])
    .filter((region) => region.coverage === "exact")
    .map((region) => region.path);
  return exactPaths.length > 0 ? exactPaths : undefined;
}

/** Builds the text handed to Claude as `controllerDirective`/the PR body -- there is no
 * "team lead" stage in this minimal path (that is a separate, unbuilt role/pipeline), so this is
 * the closest equivalent: a plain restatement of exactly the structured fields eligibility already
 * required to be present, nothing invented beyond that. */
/** Exported for C015c item 2's resume orchestration: `CiRecoveryPipelineRequest.
 * controllerDirective` needs the identical text a resumed job's original `ImplementerPipelineRequest`
 * carried, and this is a pure function of `Issue` -- no reason to duplicate it. */
export function buildDirective(issue: Issue): string {
  const sections = [
    issue.goal === undefined ? undefined : `目標：${issue.goal}`,
    issue.background === undefined ? undefined : `背景：${issue.background}`,
    bulletList("驗收條件", issue.acceptanceCriteria),
    bulletList("範圍內", issue.inScope),
    bulletList("範圍外", issue.outOfScope),
    bulletList("補充限制", issue.constraints),
    bulletList("預期風險", issue.risks),
  ].filter((section): section is string => section !== undefined);
  return sections.length > 0 ? sections.join("\n\n") : `請完成工單：${issue.title}`;
}

export interface BuildImplementerPipelineRequestOptions {
  readonly job: Job;
  readonly issue: Issue;
  readonly project: Project;
  readonly trustedConfig: TrustedProjectConfig;
  readonly model: string;
  readonly agentTeamHome: string;
  readonly clock: Clock;
  /**
   * The real, resolved commit SHA to branch the worktree from -- **not** a branch name.
   * `git worktree add` happens to tolerate a branch name as a start-point too, which could hide
   * this being wrong; the caller must resolve the project's default branch to its current
   * `headSha` (e.g. via `GitPort.inspectRepository`) immediately before calling this, so the
   * worktree is pinned to a known revision rather than "whatever the branch tip happens to be by
   * the time `createWorktree` actually runs."
   */
  readonly baseRevision: string;
}

/**
 * C018 fix: extracted (no behavior change -- callers below still get identical values) so
 * `handlers.ts` can compute the exact same deterministic branch name for its own `requires_manual`
 * fallback job-progress writes on the several exits that can be reached *before*
 * `buildImplementerPipelineRequest` ever runs (or after it fails) -- those exits still need a
 * schema-valid, non-empty `branch` field, and re-deriving a *different* formula there would risk
 * silently drifting from whatever a later successful dispatch for the same job id would have used.
 */
export function implementerBranch(jobId: string): string {
  return `agent-team/${jobId}`;
}

/** C018 fix: see `implementerBranch`'s own comment right above -- same rationale, same
 * no-behavior-change extraction, for the worktree path half of the same pair. */
export function implementerWorktreePath(agentTeamHome: string, jobId: string): string {
  return join(agentTeamHome, "state", "dispatch", "worktrees", jobId);
}

export function buildImplementerPipelineRequest(
  options: BuildImplementerPipelineRequestOptions,
): Result<ImplementerPipelineRequest, DomainError> {
  const snapshot = createRequirementSnapshot(options.issue, options.clock.now());
  if (!snapshot.ok) return snapshot;

  const deadlineAt: Result<Instant, DomainError<"invalid_instant">> = instantFromDate(
    new Date(Date.parse(options.clock.now()) + implementerProcessDeadlineMs),
  );
  if (!deadlineAt.ok) return err(domainError("invariant_violation"));

  const branch = implementerBranch(options.job.id);
  const worktreePath = implementerWorktreePath(options.agentTeamHome, options.job.id);
  const directive = buildDirective(options.issue);
  const expectedUntrackedPaths = expectedUntrackedPathsFrom(options.issue);

  return ok(
    Object.freeze({
      job: options.job,
      project: options.project,
      trustedConfig: options.trustedConfig,
      requirementSnapshot: snapshot.value,
      role: "implementer" as const,
      model: options.model,
      repositoryRoot: options.project.localRepositoryPath,
      baseRevision: options.baseRevision,
      worktreePath,
      branch,
      remote: "origin",
      commitMessage: `${options.issue.title} (${options.issue.externalId})`,
      pullRequest: Object.freeze({ title: options.issue.title, body: directive }),
      controllerDirective: directive,
      externalData: Object.freeze([]),
      deadlineAt: deadlineAt.value,
      idempotencyKeyPrefix: `cli-dispatch:${options.job.id}`,
      ...(expectedUntrackedPaths === undefined ? {} : { expectedUntrackedPaths }),
    }),
  );
}
