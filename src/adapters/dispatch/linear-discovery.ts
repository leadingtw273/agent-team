/**
 * C015a: the read-only Linear discovery bridge. Polls (once per `run` invocation -- no daemon,
 * no webhook trigger; see the composition root for the "poll on demand" decision) for every
 * issue currently in the Linear "待執行" (ready) workflow state for one activated project's
 * team+project, projects each one down to a domain `Issue` + `DispatcherCandidate`, and reports
 * anything it could not safely turn into a candidate as `skipped` -- it never lets one bad issue
 * abort the whole batch, and it never silently drops an issue with no agent-role label (the
 * packet's own requirement: such issues must be visible in `skipped`, not just absent).
 *
 * This module is a pure, read-only projection layer: it does not call `evaluateEligibility`
 * itself (the engine's own `Dispatcher.dispatch()` does that, unconditionally, for every
 * candidate it is handed -- duplicating the check here would risk the two copies drifting), and
 * it never mutates anything in Linear.
 *
 * `Issue.id` cannot be Linear's own id (the domain `Issue` schema requires a scoped
 * `issue_<uuid>` identifier, and there is no persisted external-id<->domain-id mapping table
 * anywhere yet in this codebase). Every issue's domain id is instead derived deterministically
 * from its Linear id via `generateDeterministicIdentifier("issue", externalId)` (the same
 * established convention `src/application/inbox/projector.ts` and
 * `src/application/reconcile/webhook.ts` already use for external-id-to-domain-id derivation) --
 * stable across repeated polls, collision-free, and needs no new persisted state.
 */
import {
  domainError,
  err,
  generateDeterministicIdentifier,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { issueSchema, type Issue, type Project } from "../../domain/project/index.js";
import type { DispatcherCandidate } from "../../application/dispatch/index.js";
import type { LinearIssueSnapshot } from "../linear/model.js";
import type { LinearReadModel } from "../linear/read.js";
import {
  parseReadyGateTemplate,
  type ReadyGateTemplateFields,
} from "../linear/requirement-template.js";

export type LinearDiscoverySkipReason =
  | Readonly<{ code: "read_failed"; error: DomainError }>
  | Readonly<{ code: "not_ready" }>
  | Readonly<{ code: "no_agent_role" }>
  | Readonly<{ code: "dependencies_unparsed" }>
  | Readonly<{ code: "issue_invalid" }>;

export interface LinearDiscoverySkippedIssue {
  readonly externalIssueId: string;
  readonly reason: LinearDiscoverySkipReason;
}

export interface LinearDiscoveryResult {
  readonly candidates: readonly DispatcherCandidate[];
  readonly skipped: readonly LinearDiscoverySkippedIssue[];
}

export type LinearDiscoveryReadModel = Pick<
  LinearReadModel,
  "readContext" | "readIssue" | "listIssueIdsInState"
>;

export interface DiscoverReadyDispatchCandidatesOptions {
  readonly project: Project;
  readonly teamId: string;
  readonly linearProjectId: string;
  readonly readModel: LinearDiscoveryReadModel;
}

/**
 * C015b: maps the parsed Ready Gate template fields into `Issue`. `template.dependencies` must
 * already have been narrowed to exclude `"unparsed"` by the caller (`discoverReadyDispatchCandidates`
 * skips those before ever reaching this function) -- `"none"` becomes `{kind:"none"}`, `"absent"`
 * is omitted entirely (falls through to `evaluateEligibility`'s ordinary `missing_dependencies`
 * blocker, the same treatment every other un-filled template field gets). This function never
 * itself maps Linear issue *relations* into `dependencies`: deciding which relation `type` values
 * genuinely mean "blocked by" is a real domain judgment call this thin discovery bridge does not
 * have enough context to make safely (see requirement-template.ts's own header for the fuller
 * rationale on why free text is never turned into guessed issue ids either).
 */
function toDomainIssue(
  project: Project,
  snapshot: LinearIssueSnapshot,
  template: Omit<ReadyGateTemplateFields, "dependencies"> & {
    readonly dependencies: Exclude<ReadyGateTemplateFields["dependencies"], { kind: "unparsed" }>;
  },
): Result<Issue, DomainError> {
  const issueId = generateDeterministicIdentifier("issue", snapshot.id);
  if (!issueId.ok) return err(domainError("invariant_violation"));
  const parsed = issueSchema.safeParse({
    schemaVersion: 1,
    id: issueId.value,
    projectId: project.id,
    externalId: snapshot.id,
    title: snapshot.title,
    ...(template.dependencies.kind === "none" ? { dependencies: { kind: "none" as const } } : {}),
    ...(template.goal === undefined ? {} : { goal: template.goal }),
    ...(template.background === undefined ? {} : { background: template.background }),
    ...(template.acceptanceCriteria === undefined
      ? {}
      : { acceptanceCriteria: template.acceptanceCriteria }),
    ...(template.inScope === undefined ? {} : { inScope: template.inScope }),
    ...(template.outOfScope === undefined ? {} : { outOfScope: template.outOfScope }),
    ...(template.estimatedMinutes === undefined
      ? {}
      : { estimatedMinutes: template.estimatedMinutes }),
    ...(template.constraints === undefined ? {} : { constraints: template.constraints }),
    ...(template.risks === undefined ? {} : { risks: template.risks }),
    ...(snapshot.priority === undefined ? {} : { priority: snapshot.priority }),
    ...(snapshot.agentRole === undefined ? {} : { agentRole: snapshot.agentRole }),
    ...(snapshot.reviewRequirement === undefined
      ? {}
      : { reviewRequirement: snapshot.reviewRequirement }),
  });
  if (!parsed.success) return err(domainError("invariant_violation"));
  return ok(parsed.data);
}

/**
 * Reads every issue in the ready workflow state for one project's Linear team+project, and turns
 * each one that projects cleanly into a `DispatcherCandidate`. `readyAt` is the issue's own
 * `updatedAt` timestamp (an honest approximation -- this thin implementation has no persisted
 * "entered ready state at" event yet; a future ticket could improve this by watching for the
 * workflow-state transition itself).
 */
export async function discoverReadyDispatchCandidates(
  options: DiscoverReadyDispatchCandidatesOptions,
): Promise<Result<LinearDiscoveryResult, DomainError>> {
  const context = await options.readModel.readContext(options.teamId, options.linearProjectId);
  if (!context.ok) return context;
  const readyStateId = context.value.catalog.stateIdByWorkStatus.ready;
  const issueIds = await options.readModel.listIssueIdsInState(context.value, readyStateId);
  if (!issueIds.ok) return issueIds;

  const candidates: DispatcherCandidate[] = [];
  const skipped: LinearDiscoverySkippedIssue[] = [];
  for (const externalIssueId of issueIds.value) {
    const snapshot = await options.readModel.readIssue(context.value, externalIssueId);
    if (!snapshot.ok) {
      skipped.push(
        Object.freeze({
          externalIssueId,
          reason: Object.freeze({ code: "read_failed" as const, error: snapshot.error }),
        }),
      );
      continue;
    }
    // Defense in depth: the list query already filtered by the ready state id, but the issue's
    // state could have changed in the gap between that read and this one -- never trust a stale
    // membership check.
    if (snapshot.value.workStatus !== "ready") {
      skipped.push(
        Object.freeze({ externalIssueId, reason: Object.freeze({ code: "not_ready" as const }) }),
      );
      continue;
    }
    if (snapshot.value.agentRole === undefined) {
      skipped.push(
        Object.freeze({
          externalIssueId,
          reason: Object.freeze({ code: "no_agent_role" as const }),
        }),
      );
      continue;
    }
    const template = parseReadyGateTemplate(snapshot.value.description);
    if (template.dependencies.kind === "unparsed") {
      // The template was followed (a 依賴關係 heading was found) but its content is neither
      // empty nor "無" -- some dependency was declared in free text this bridge cannot safely
      // resolve into real issue ids. Skipping here (visibly, via its own reason code) rather than
      // falling through to toDomainIssue with an absent `dependencies` field is deliberate: an
      // absent field would go through evaluateEligibility's generic `missing_dependencies`
      // blocker, indistinguishable from "the human simply left this required field blank" --
      // that would hide the more specific, more actionable fact that a real dependency was
      // declared and this candidate must not be dispatched until a human resolves it.
      skipped.push(
        Object.freeze({
          externalIssueId,
          reason: Object.freeze({ code: "dependencies_unparsed" as const }),
        }),
      );
      continue;
    }
    const issue = toDomainIssue(options.project, snapshot.value, {
      ...template,
      dependencies: template.dependencies,
    });
    if (!issue.ok) {
      skipped.push(
        Object.freeze({
          externalIssueId,
          reason: Object.freeze({ code: "issue_invalid" as const }),
        }),
      );
      continue;
    }
    candidates.push(
      Object.freeze({
        issue: issue.value,
        readyAt: snapshot.value.updatedAt,
        stage: "implementation" as const,
        workKind: "model" as const,
      }),
    );
  }

  return ok(
    Object.freeze({ candidates: Object.freeze(candidates), skipped: Object.freeze(skipped) }),
  );
}
