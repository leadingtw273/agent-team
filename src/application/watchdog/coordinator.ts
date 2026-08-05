import {
  createClock,
  domainError,
  type Clock,
  type DomainError,
} from "../../domain/foundation/index.js";
import {
  evaluateWatchdog,
  grantWatchdogExtension,
  jobSchema,
  type WatchdogDecision,
} from "../../domain/jobs/index.js";
import type { MutationOptions } from "../ports/index.js";
import {
  effectiveProgressKinds,
  effectiveWatchdogProgress,
  validateWatchdogActivities,
} from "./activity.js";
import type {
  WatchdogCoordinatorOptions,
  WatchdogCoordinatorOutcome,
  WatchdogCoordinatorPorts,
  WatchdogCoordinatorRequest,
  WatchdogFailureStage,
} from "./model.js";

const idempotencyPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]{0,220}$/u;

function mutation(request: WatchdogCoordinatorRequest, step: string): MutationOptions {
  return {
    idempotencyKey: `${request.idempotencyKeyPrefix}:${step}`,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  };
}

function failed(stage: WatchdogFailureStage, error: DomainError): WatchdogCoordinatorOutcome {
  return Object.freeze({ state: "failed", stage, error });
}

function sameJob(
  left: WatchdogCoordinatorRequest["job"],
  right: WatchdogCoordinatorRequest["job"],
): boolean {
  return (
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.issueId === right.issueId &&
    left.createdAt === right.createdAt &&
    left.startedAt === right.startedAt &&
    JSON.stringify(left.attempts) === JSON.stringify(right.attempts)
  );
}

export class WatchdogCoordinator {
  readonly #clock: Clock;

  constructor(
    readonly ports: WatchdogCoordinatorPorts,
    options: WatchdogCoordinatorOptions = {},
  ) {
    this.#clock = options.clock ?? createClock();
  }

  async evaluate(request: WatchdogCoordinatorRequest): Promise<WatchdogCoordinatorOutcome> {
    if (
      !jobSchema.safeParse(request.job).success ||
      request.job.startedAt === undefined ||
      request.remainingWorkSummary.trim().length === 0 ||
      request.remainingWorkSummary.length > 16_384 ||
      !idempotencyPattern.test(request.idempotencyKeyPrefix)
    ) {
      return failed("request", domainError("invariant_violation"));
    }
    const now = this.#clock.now();
    const initial = evaluateWatchdog({
      startedAt: request.job.startedAt,
      now,
      extensionGranted: request.job.watchdogExtensionGranted,
    });
    if (!initial.ok) return failed("request", initial.error);
    if (initial.value === "continue") {
      return Object.freeze({ state: "continue", extension: "none" });
    }
    if (initial.value === "continue_once_extended" && request.job.watchdogExtensionGranted) {
      return Object.freeze({ state: "continue", extension: "active" });
    }

    const activities = await this.ports.activities.list(
      request.job.id,
      request.signal === undefined ? {} : { signal: request.signal },
    );
    if (!activities.ok) return failed("activities", activities.error);
    if (!validateWatchdogActivities(activities.value, request.job.startedAt, now)) {
      return failed("activities", domainError("conflict"));
    }
    if (initial.value === "checkpoint_hard_stop") {
      return this.#checkpoint(request, activities.value, "watchdog_hard_stop");
    }

    const effectiveProgress = effectiveWatchdogProgress(activities.value);
    let completionCheaper = false;
    let inspectionSummary = "No effective progress; checkpoint and replan mechanically.";
    if (effectiveProgress.length > 0) {
      const inspection = await this.ports.inspection.inspect(
        {
          job: request.job,
          now,
          effectiveProgress,
          remainingWorkSummary: request.remainingWorkSummary,
        },
        request.signal === undefined ? {} : { signal: request.signal },
      );
      if (!inspection.ok) return failed("inspection", inspection.error);
      if (inspection.value.summary.trim().length === 0) {
        return failed("inspection", domainError("external_failure"));
      }
      completionCheaper = inspection.value.originalAgentCompletionCheaper;
      inspectionSummary = inspection.value.summary;
    }
    const inspected = evaluateWatchdog({
      startedAt: request.job.startedAt,
      now,
      extensionGranted: false,
      inspection: {
        effectiveProgress: effectiveProgressKinds(effectiveProgress),
        originalAgentCompletionCheaper: completionCheaper,
      },
    });
    if (!inspected.ok) return failed("inspection", inspected.error);
    if (inspected.value !== "continue_once_extended") {
      return this.#checkpoint(request, activities.value, "watchdog_replan");
    }
    return this.#extend(request, inspected.value, effectiveProgress, inspectionSummary);
  }

  async #extend(
    request: WatchdogCoordinatorRequest,
    decision: WatchdogDecision,
    effectiveProgress: Extract<
      WatchdogCoordinatorOutcome,
      { state: "extended" }
    >["effectiveProgress"],
    inspectionSummary: string,
  ): Promise<WatchdogCoordinatorOutcome> {
    const granted = grantWatchdogExtension(request.job, decision);
    if (!granted.ok) return failed("job", granted.error);
    const persisted = await this.ports.jobs.update(
      granted.value,
      mutation(request, "grant-extension"),
    );
    if (!persisted.ok) return failed("job", persisted.error);
    if (
      persisted.value.durability !== "confirmed" ||
      !jobSchema.safeParse(persisted.value.job).success ||
      !sameJob(request.job, persisted.value.job) ||
      !persisted.value.job.watchdogExtensionGranted
    ) {
      return failed("job", domainError("conflict"));
    }
    return Object.freeze({
      state: "extended",
      job: persisted.value.job,
      effectiveProgress,
      inspectionSummary,
    });
  }

  async #checkpoint(
    request: WatchdogCoordinatorRequest,
    activities: Parameters<
      WatchdogCoordinatorPorts["checkpoint"]["checkpointAndStop"]
    >[0]["activities"],
    reason: "watchdog_replan" | "watchdog_hard_stop",
  ): Promise<WatchdogCoordinatorOutcome> {
    const checkpoint = await this.ports.checkpoint.checkpointAndStop(
      { job: request.job, reason, activities, processMustStop: true },
      mutation(request, reason),
    );
    if (!checkpoint.ok) return failed("checkpoint", checkpoint.error);
    if (
      checkpoint.value.durability !== "confirmed" ||
      !checkpoint.value.processStopped ||
      checkpoint.value.checkpointId.trim().length === 0
    ) {
      return failed("checkpoint", domainError("external_failure"));
    }
    return Object.freeze({
      state: "checkpointed",
      reason,
      checkpointId: checkpoint.value.checkpointId,
    });
  }
}
