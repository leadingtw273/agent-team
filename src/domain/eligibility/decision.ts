import type { Identifier } from "../foundation/index.js";
import type { Issue } from "../project/index.js";

export type DependencyState = "completed" | "incomplete" | "unknown";

export type EligibilityBlocker =
  | Readonly<{ code: "human_owned" }>
  | Readonly<{
      code:
        | "missing_goal"
        | "missing_background"
        | "missing_acceptance_criteria"
        | "missing_in_scope"
        | "missing_out_of_scope"
        | "missing_dependencies"
        | "missing_priority"
        | "missing_review_requirement"
        | "missing_estimate"
        | "task_too_large";
    }>
  | Readonly<{
      code: "dependency_not_completed";
      dependencyId: Identifier<"issue">;
      state: DependencyState;
    }>;

export interface EligibilityDecision {
  readonly ownership: "human" | "agent";
  readonly readyForAutomation: boolean;
  readonly eligibleForDispatch: boolean;
  readonly blockers: readonly EligibilityBlocker[];
}

export interface EligibilityContext {
  readonly dependencyStates?: Readonly<Record<string, DependencyState>>;
}

type StaticBlockerCode = Exclude<EligibilityBlocker["code"], "dependency_not_completed">;

function blocker<Code extends StaticBlockerCode>(code: Code): Readonly<{ code: Code }> {
  return Object.freeze({ code });
}

export function evaluateEligibility(
  issue: Issue,
  context: EligibilityContext = {},
): EligibilityDecision {
  if (issue.agentRole === undefined) {
    return Object.freeze({
      ownership: "human",
      readyForAutomation: false,
      eligibleForDispatch: false,
      blockers: Object.freeze([blocker("human_owned")]),
    });
  }

  const blockers: EligibilityBlocker[] = [];
  if (issue.goal === undefined) blockers.push(blocker("missing_goal"));
  if (issue.background === undefined) blockers.push(blocker("missing_background"));
  if (issue.acceptanceCriteria === undefined) {
    blockers.push(blocker("missing_acceptance_criteria"));
  }
  if (issue.inScope === undefined) blockers.push(blocker("missing_in_scope"));
  if (issue.outOfScope === undefined) blockers.push(blocker("missing_out_of_scope"));
  if (issue.dependencies === undefined) blockers.push(blocker("missing_dependencies"));
  if (issue.priority === undefined) blockers.push(blocker("missing_priority"));
  if (issue.reviewRequirement === undefined) {
    blockers.push(blocker("missing_review_requirement"));
  }
  if (issue.estimatedMinutes === undefined) {
    blockers.push(blocker("missing_estimate"));
  } else if (issue.estimatedMinutes > 45) {
    blockers.push(blocker("task_too_large"));
  }

  const readyForAutomation = blockers.length === 0;
  if (readyForAutomation && issue.dependencies?.kind === "issues") {
    for (const dependencyId of issue.dependencies.issueIds) {
      const state = context.dependencyStates?.[dependencyId] ?? "unknown";
      if (state === "completed") continue;
      blockers.push(
        Object.freeze({
          code: "dependency_not_completed",
          dependencyId,
          state,
        }),
      );
    }
  }

  return Object.freeze({
    ownership: "agent",
    readyForAutomation,
    eligibleForDispatch: readyForAutomation && blockers.length === 0,
    blockers: Object.freeze(blockers),
  });
}
