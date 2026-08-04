import {
  createClock,
  generateIdentifier,
  parseInstant,
  type Clock,
  type DomainError,
  type Identifier,
  type Result,
} from "../../domain/foundation/index.js";
import { emptyAttemptCounters, jobSchema, type Job, type Lease } from "../../domain/jobs/index.js";
import { evaluateEligibility, type EligibilityContext } from "../../domain/eligibility/index.js";
import { issueSchema, type Issue } from "../../domain/project/index.js";
import type { LeaseCoordinator } from "../leases/index.js";
import type { ProjectRegistrySnapshot } from "../projects/index.js";
import type { CandidateObservation, ModelRoutingConfig } from "../routing/index.js";
import { decideNextDispatch } from "./decision.js";
import type {
  ActiveDispatch,
  DispatchBlocker,
  DispatchCandidate,
  DispatchDecision,
  DispatchSlotLimits,
  DispatchStage,
  DispatchWorkKind,
  RotationCursor,
} from "./model.js";

export interface DispatcherCandidate {
  readonly issue: Issue;
  readonly readyAt: string;
  readonly stage: DispatchStage;
  readonly workKind: DispatchWorkKind;
}

export interface JobWriteReceipt {
  readonly durability: "confirmed" | "unknown";
}

export interface JobRepository {
  create(job: Job): Promise<Result<JobWriteReceipt, DomainError>>;
}

export type JobIdFactory = () => Result<Identifier<"job">, DomainError>;

export interface DispatcherPorts {
  readonly leases: LeaseCoordinator;
  readonly jobs: JobRepository;
}

export interface DispatcherOptions {
  readonly clock?: Clock;
  readonly generateJobId?: JobIdFactory;
}

export interface DispatchInput {
  readonly holderId: string;
  readonly candidates: readonly DispatcherCandidate[];
  readonly registry: ProjectRegistrySnapshot;
  readonly dependencyContexts?: Readonly<Record<string, EligibilityContext>>;
  readonly active: readonly ActiveDispatch[];
  readonly routingConfig: ModelRoutingConfig;
  readonly routeObservations: readonly CandidateObservation[];
  readonly rotation?: RotationCursor;
  readonly slotLimits?: DispatchSlotLimits;
}

export type DispatcherSkipReason =
  | Readonly<{ code: "invalid_issue" }>
  | Readonly<{ code: "not_eligible"; blockers: ReturnType<typeof evaluateEligibility>["blockers"] }>
  | Readonly<{ code: "project_not_ready" }>
  | Readonly<{ code: "dispatch_blocked"; blocker: DispatchBlocker }>
  | Readonly<{ code: "lease_conflict" }>
  | Readonly<{ code: "job_create_failed"; error: DomainError }>;

export interface DispatcherSkippedCandidate {
  readonly issueId: string;
  readonly reason: DispatcherSkipReason;
}

export type DispatcherResult =
  | Readonly<{
      kind: "dispatched";
      job: Job;
      lease: Lease;
      decision: Extract<DispatchDecision, { kind: "selected" }>;
      skipped: readonly DispatcherSkippedCandidate[];
    }>
  | Readonly<{
      kind: "waiting";
      reason: "no_eligible_candidates" | "no_dispatchable_candidate";
      skipped: readonly DispatcherSkippedCandidate[];
    }>
  | Readonly<{
      kind: "blocked";
      reason:
        | "invalid_runtime_input"
        | "lease_store_failed"
        | "lease_persistence_unknown"
        | "job_persistence_unknown"
        | "lease_cleanup_failed";
      skipped: readonly DispatcherSkippedCandidate[];
    }>;

interface PreparedCandidate {
  readonly issue: Issue;
  readonly dispatch: DispatchCandidate;
}

function dispatchBlockers(decision: DispatchDecision): readonly DispatcherSkippedCandidate[] {
  return decision.skipped.map((skipped) =>
    Object.freeze({
      issueId: skipped.candidateId,
      reason: Object.freeze({ code: "dispatch_blocked" as const, blocker: skipped.blocker }),
    }),
  );
}

function removeCandidate(
  candidates: readonly PreparedCandidate[],
  issueId: string,
): readonly PreparedCandidate[] {
  return candidates.filter((candidate) => candidate.issue.id !== issueId);
}

export class Dispatcher {
  readonly #clock: Clock;
  readonly #generateJobId: JobIdFactory;

  constructor(
    readonly ports: DispatcherPorts,
    options: DispatcherOptions = {},
  ) {
    this.#clock = options.clock ?? createClock();
    this.#generateJobId = options.generateJobId ?? (() => generateIdentifier("job"));
  }

  async dispatch(input: DispatchInput): Promise<DispatcherResult> {
    if (input.holderId.trim().length === 0) {
      return Object.freeze({ kind: "blocked", reason: "invalid_runtime_input", skipped: [] });
    }
    const prepared: PreparedCandidate[] = [];
    const skipped: DispatcherSkippedCandidate[] = [];
    const readyProjects = new Map(
      input.registry.ready.map((entry) => [entry.project.id, entry.project]),
    );

    for (const candidateInput of input.candidates) {
      const parsedIssue = issueSchema.safeParse(candidateInput.issue);
      if (!parsedIssue.success || !parseInstant(candidateInput.readyAt).ok) {
        skipped.push(
          Object.freeze({
            issueId: String(candidateInput.issue.id),
            reason: Object.freeze({ code: "invalid_issue" }),
          }),
        );
        continue;
      }
      const eligibility = evaluateEligibility(
        parsedIssue.data,
        input.dependencyContexts?.[parsedIssue.data.id],
      );
      if (!eligibility.eligibleForDispatch) {
        skipped.push(
          Object.freeze({
            issueId: parsedIssue.data.id,
            reason: Object.freeze({ code: "not_eligible", blockers: eligibility.blockers }),
          }),
        );
        continue;
      }
      const project = readyProjects.get(parsedIssue.data.projectId);
      if (project === undefined) {
        skipped.push(
          Object.freeze({
            issueId: parsedIssue.data.id,
            reason: Object.freeze({ code: "project_not_ready" }),
          }),
        );
        continue;
      }
      if (parsedIssue.data.priority === undefined || parsedIssue.data.agentRole === undefined) {
        return Object.freeze({ kind: "blocked", reason: "invalid_runtime_input", skipped });
      }
      prepared.push(
        Object.freeze({
          issue: parsedIssue.data,
          dispatch: Object.freeze({
            id: parsedIssue.data.id,
            projectId: parsedIssue.data.projectId,
            repositoryId: `${project.sourceControl.provider}:${project.sourceControl.repository}`,
            priority: parsedIssue.data.priority,
            readyAt: candidateInput.readyAt,
            role: parsedIssue.data.agentRole,
            workKind: candidateInput.workKind,
            stage: candidateInput.stage,
            ...(parsedIssue.data.changeRegions === undefined
              ? {}
              : { declaredRegions: parsedIssue.data.changeRegions }),
          }),
        }),
      );
    }

    if (prepared.length === 0) {
      return Object.freeze({ kind: "waiting", reason: "no_eligible_candidates", skipped });
    }

    let remaining: readonly PreparedCandidate[] = prepared;
    while (remaining.length > 0) {
      const decision = decideNextDispatch({
        candidates: remaining.map((candidate) => candidate.dispatch),
        active: input.active,
        routingConfig: input.routingConfig,
        routeObservations: input.routeObservations,
        ...(input.rotation === undefined ? {} : { rotation: input.rotation }),
        ...(input.slotLimits === undefined ? {} : { slotLimits: input.slotLimits }),
      });
      skipped.push(...dispatchBlockers(decision));
      const decisionBlockedIds = new Set(decision.skipped.map((entry) => entry.candidateId));
      remaining = remaining.filter((candidate) => !decisionBlockedIds.has(candidate.issue.id));
      if (decision.kind === "waiting") {
        if (decision.reason === "invalid_input") {
          return Object.freeze({ kind: "blocked", reason: "invalid_runtime_input", skipped });
        }
        return Object.freeze({
          kind: "waiting",
          reason: "no_dispatchable_candidate",
          skipped: Object.freeze(skipped),
        });
      }

      const selected = remaining.find((candidate) => candidate.issue.id === decision.candidate.id);
      if (selected === undefined) {
        return Object.freeze({ kind: "blocked", reason: "invalid_runtime_input", skipped });
      }
      const jobId = this.#generateJobId();
      if (!jobId.ok) {
        return Object.freeze({ kind: "blocked", reason: "invalid_runtime_input", skipped });
      }
      const now = this.#clock.now();
      const job = jobSchema.safeParse({
        schemaVersion: 1,
        id: jobId.value,
        projectId: selected.issue.projectId,
        issueId: selected.issue.id,
        createdAt: now,
        watchdogExtensionGranted: false,
        attempts: emptyAttemptCounters(),
      });
      if (!job.success) {
        return Object.freeze({ kind: "blocked", reason: "invalid_runtime_input", skipped });
      }
      const lease = await this.ports.leases.acquire({
        jobId: job.data.id,
        issueId: job.data.issueId,
        holderId: input.holderId,
      });
      if (!lease.ok) {
        if (lease.error.code !== "conflict") {
          return Object.freeze({ kind: "blocked", reason: "lease_store_failed", skipped });
        }
        skipped.push(
          Object.freeze({
            issueId: selected.issue.id,
            reason: Object.freeze({ code: "lease_conflict" }),
          }),
        );
        remaining = removeCandidate(remaining, selected.issue.id);
        continue;
      }
      if (lease.value.persistence !== "confirmed") {
        return Object.freeze({ kind: "blocked", reason: "lease_persistence_unknown", skipped });
      }

      const created = await this.ports.jobs.create(job.data);
      if (created.ok && created.value.durability === "confirmed") {
        return Object.freeze({
          kind: "dispatched",
          job: Object.freeze(job.data),
          lease: Object.freeze(lease.value.value),
          decision,
          skipped: Object.freeze(skipped),
        });
      }
      if (created.ok) {
        return Object.freeze({ kind: "blocked", reason: "job_persistence_unknown", skipped });
      }

      const released = await this.ports.leases.release({
        leaseId: lease.value.value.id,
        holderId: input.holderId,
      });
      if (!released.ok || released.value.persistence === "unknown") {
        return Object.freeze({ kind: "blocked", reason: "lease_cleanup_failed", skipped });
      }
      skipped.push(
        Object.freeze({
          issueId: selected.issue.id,
          reason: Object.freeze({ code: "job_create_failed", error: created.error }),
        }),
      );
      remaining = removeCandidate(remaining, selected.issue.id);
    }

    return Object.freeze({
      kind: "waiting",
      reason: "no_dispatchable_candidate",
      skipped: Object.freeze(skipped),
    });
  }
}
