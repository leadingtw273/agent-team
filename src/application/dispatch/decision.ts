import { selectModelRoute, type CandidateObservation } from "../routing/index.js";
import { changeRegionsOverlap } from "../../domain/ownership/index.js";
import {
  PRIORITY_ORDER,
  dispatchDecisionInputSchema,
  type ActiveDispatch,
  type DispatchBlocker,
  type DispatchCandidate,
  type DispatchDecision,
  type DispatchSlotLimits,
  type ModelProvider,
  type Priority,
  type RotationCursor,
  type SkippedDispatchCandidate,
} from "./model.js";

const PRIORITIES = Object.freeze(
  (Object.keys(PRIORITY_ORDER) as Priority[]).sort(
    (left, right) => PRIORITY_ORDER[left] - PRIORITY_ORDER[right],
  ),
);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rotateProjects(
  projectIds: readonly string[],
  lastProjectId: string | undefined,
): string[] {
  const sorted = [...projectIds].sort(compareText);
  if (lastProjectId === undefined) return sorted;
  const lastIndex = sorted.indexOf(lastProjectId);
  const nextIndex =
    lastIndex >= 0 ? lastIndex + 1 : sorted.findIndex((projectId) => projectId > lastProjectId);
  if (nextIndex < 0 || nextIndex >= sorted.length) return sorted;
  return [...sorted.slice(nextIndex), ...sorted.slice(0, nextIndex)];
}

function orderCandidates(
  candidates: readonly DispatchCandidate[],
  rotation: RotationCursor,
): DispatchCandidate[] {
  const ordered: DispatchCandidate[] = [];
  for (const priority of PRIORITIES) {
    const bucket = candidates.filter((candidate) => candidate.priority === priority);
    const projectIds = [...new Set(bucket.map((candidate) => candidate.projectId))];
    const projects = rotateProjects(projectIds, rotation[priority]);
    const byProject = new Map(
      projects.map((projectId) => [
        projectId,
        bucket
          .filter((candidate) => candidate.projectId === projectId)
          .sort(
            (left, right) =>
              Date.parse(left.readyAt) - Date.parse(right.readyAt) ||
              compareText(left.id, right.id),
          ),
      ]),
    );
    const largestProjectQueue = Math.max(
      0,
      ...[...byProject.values()].map((items) => items.length),
    );
    for (let index = 0; index < largestProjectQueue; index += 1) {
      for (const projectId of projects) {
        const candidate = byProject.get(projectId)?.[index];
        if (candidate !== undefined) ordered.push(candidate);
      }
    }
  }
  return ordered;
}

function hasRepositoryConflict(candidate: DispatchCandidate, active: ActiveDispatch): boolean {
  if (candidate.repositoryId !== active.repositoryId) return false;
  if (
    candidate.stage === "integration" ||
    candidate.stage === "merge" ||
    active.stage === "integration" ||
    active.stage === "merge"
  ) {
    return true;
  }
  if (candidate.declaredRegions === undefined || active.declaredRegions === undefined) return true;
  return candidate.declaredRegions.some((candidateRegion) =>
    active.declaredRegions?.some((activeRegion) =>
      changeRegionsOverlap(candidateRegion, activeRegion),
    ),
  );
}

function countModelJobs(active: readonly ActiveDispatch[]): number {
  return active.filter((job) => job.workKind === "model").length;
}

function providerCounts(
  active: readonly ActiveDispatch[],
): Readonly<Record<ModelProvider, number>> {
  const counts: Record<ModelProvider, number> = { codex: 0, claude: 0, gemini: 0 };
  for (const job of active) {
    if (job.workKind === "model" && job.provider !== undefined) counts[job.provider] += 1;
  }
  return counts;
}

function observationsWithSlotState(
  observations: readonly CandidateObservation[],
  counts: Readonly<Record<ModelProvider, number>>,
  limits: DispatchSlotLimits,
): CandidateObservation[] {
  return observations.map((observation) =>
    observation.state === "ready" &&
    counts[observation.provider] >= limits.perProviderModelJobs[observation.provider]
      ? Object.freeze({ ...observation, state: "provider_slot_full" as const })
      : Object.freeze({ ...observation }),
  );
}

function repositoryBlocker(
  candidate: DispatchCandidate,
  active: readonly ActiveDispatch[],
  limits: DispatchSlotLimits,
): DispatchBlocker | undefined {
  if (candidate.workKind === "mechanical") return undefined;
  const sameRepository = active.filter(
    (job) => job.workKind === "model" && job.repositoryId === candidate.repositoryId,
  );
  if (candidate.stage === "integration" || candidate.stage === "merge") {
    const integrationCount = sameRepository.filter(
      (job) => job.stage === "integration" || job.stage === "merge",
    ).length;
    if (integrationCount >= limits.perRepositoryIntegrationJobs) {
      return Object.freeze({
        code: "repository_integration_slot_full",
        repositoryId: candidate.repositoryId,
      });
    }
  }
  const conflictingJob = sameRepository.find((job) => hasRepositoryConflict(candidate, job));
  return conflictingJob === undefined
    ? undefined
    : Object.freeze({
        code: "repository_scope_conflict",
        repositoryId: candidate.repositoryId,
        activeJobId: conflictingJob.jobId,
      });
}

function nextRotation(rotation: RotationCursor, candidate: DispatchCandidate): RotationCursor {
  return Object.freeze({ ...rotation, [candidate.priority]: candidate.projectId });
}

function skip(
  skipped: SkippedDispatchCandidate[],
  candidate: DispatchCandidate,
  blocker: DispatchBlocker,
): void {
  skipped.push(Object.freeze({ candidateId: candidate.id, blocker }));
}

export function decideNextDispatch(input: unknown): DispatchDecision {
  const parsed = dispatchDecisionInputSchema.safeParse(input);
  if (!parsed.success) {
    return Object.freeze({ kind: "waiting", reason: "invalid_input", skipped: Object.freeze([]) });
  }
  const { candidates, active, routingConfig, routeObservations, rotation, slotLimits } =
    parsed.data;
  if (candidates.length === 0) {
    return Object.freeze({ kind: "waiting", reason: "no_candidates", skipped: Object.freeze([]) });
  }

  const ordered = orderCandidates(candidates, rotation);
  const activeModelCount = countModelJobs(active);
  const activeProviderCounts = providerCounts(active);
  const observations = observationsWithSlotState(
    routeObservations,
    activeProviderCounts,
    slotLimits,
  );
  const skipped: SkippedDispatchCandidate[] = [];

  for (const candidate of ordered) {
    if (candidate.workKind === "model" && activeModelCount >= slotLimits.globalModelJobs) {
      skip(skipped, candidate, Object.freeze({ code: "global_model_slot_full" }));
      continue;
    }

    const route =
      candidate.workKind === "model"
        ? selectModelRoute(routingConfig, candidate.role, observations)
        : undefined;
    if (route?.kind === "waiting") {
      skip(
        skipped,
        candidate,
        Object.freeze({
          code: "provider_route_unavailable",
          role: candidate.role,
          skipped: route.skipped,
        }),
      );
      continue;
    }

    if (
      candidate.workKind === "model" &&
      active.filter((job) => job.workKind === "model" && job.projectId === candidate.projectId)
        .length >= slotLimits.perProjectModelJobs
    ) {
      skip(
        skipped,
        candidate,
        Object.freeze({ code: "project_model_slot_full", projectId: candidate.projectId }),
      );
      continue;
    }

    const repoBlocker = repositoryBlocker(candidate, active, slotLimits);
    if (repoBlocker !== undefined) {
      skip(skipped, candidate, repoBlocker);
      continue;
    }

    return Object.freeze({
      kind: "selected",
      candidate: Object.freeze({ ...candidate }),
      consumesModelSlot: candidate.workKind === "model",
      ...(route?.kind === "selected"
        ? {
            model: Object.freeze({
              candidate: Object.freeze({ ...route.candidate }),
              candidateIndex: route.candidateIndex,
              fallbackUsed: route.fallbackUsed,
            }),
          }
        : {}),
      nextRotation: nextRotation(rotation, candidate),
      skipped: Object.freeze(skipped),
    });
  }

  return Object.freeze({
    kind: "waiting",
    reason: "no_dispatchable_candidate",
    skipped: Object.freeze(skipped),
  });
}
