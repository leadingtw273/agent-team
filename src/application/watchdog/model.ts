import { z } from "zod";

import {
  canonicalInstantPattern,
  parseInstant,
  type Clock,
  type DomainError,
  type Instant,
} from "../../domain/foundation/index.js";
import type { Job } from "../../domain/jobs/index.js";
import type { AsyncPortResult, MutationOptions, ReadOptions } from "../ports/common.js";

const instantSchema = z
  .string()
  .regex(canonicalInstantPattern)
  .refine((value) => parseInstant(value).ok);
const fingerprintSchema = z.string().trim().min(1).max(1_024);

const effectiveActivityBase = z.object({
  occurredAt: instantSchema,
  fingerprint: fingerprintSchema,
  summary: z.string().trim().min(1).max(4_096),
});

export const watchdogActivitySchema = z.discriminatedUnion("kind", [
  effectiveActivityBase.extend({ kind: z.literal("controlled_git_diff") }).strict(),
  effectiveActivityBase.extend({ kind: z.literal("test_or_build_milestone") }).strict(),
  effectiveActivityBase.extend({ kind: z.literal("checkpoint_created") }).strict(),
  effectiveActivityBase.extend({ kind: z.literal("narrowing_error_evidence") }).strict(),
  effectiveActivityBase.extend({ kind: z.literal("distinct_solution_experiment") }).strict(),
  z.object({ kind: z.literal("heartbeat"), occurredAt: instantSchema }).strict(),
  z
    .object({
      kind: z.literal("model_output"),
      occurredAt: instantSchema,
      fingerprint: fingerprintSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("command_execution"),
      occurredAt: instantSchema,
      fingerprint: fingerprintSchema,
    })
    .strict(),
]);

export type WatchdogActivity = z.infer<typeof watchdogActivitySchema>;
export type EffectiveWatchdogActivity = Exclude<
  WatchdogActivity,
  { kind: "heartbeat" | "model_output" | "command_execution" }
>;

export interface WatchdogActivityPort {
  list(jobId: string, options?: ReadOptions): AsyncPortResult<readonly WatchdogActivity[]>;
}

export interface WatchdogInspectionPort {
  inspect(
    request: Readonly<{
      job: Job;
      now: Instant;
      effectiveProgress: readonly EffectiveWatchdogActivity[];
      remainingWorkSummary: string;
    }>,
    options?: ReadOptions,
  ): AsyncPortResult<
    Readonly<{
      originalAgentCompletionCheaper: boolean;
      summary: string;
    }>
  >;
}

export interface WatchdogJobPort {
  update(
    job: Job,
    options: MutationOptions,
  ): AsyncPortResult<Readonly<{ job: Job; durability: "confirmed" | "unknown" }>>;
}

export interface WatchdogCheckpointPort {
  checkpointAndStop(
    request: Readonly<{
      job: Job;
      reason: "watchdog_replan" | "watchdog_hard_stop";
      activities: readonly WatchdogActivity[];
      processMustStop: true;
    }>,
    options: MutationOptions,
  ): AsyncPortResult<
    Readonly<{
      checkpointId: string;
      processStopped: boolean;
      durability: "confirmed" | "unknown";
    }>
  >;
}

export interface WatchdogCoordinatorPorts {
  readonly activities: WatchdogActivityPort;
  readonly inspection: WatchdogInspectionPort;
  readonly jobs: WatchdogJobPort;
  readonly checkpoint: WatchdogCheckpointPort;
}

export interface WatchdogCoordinatorOptions {
  readonly clock?: Clock;
}

export interface WatchdogCoordinatorRequest {
  readonly job: Job;
  readonly remainingWorkSummary: string;
  readonly idempotencyKeyPrefix: string;
  readonly signal?: AbortSignal;
}

export type WatchdogFailureStage = "request" | "activities" | "inspection" | "job" | "checkpoint";

export type WatchdogCoordinatorOutcome =
  | Readonly<{ state: "continue"; extension: "none" | "active" }>
  | Readonly<{
      state: "extended";
      job: Job;
      effectiveProgress: readonly EffectiveWatchdogActivity[];
      inspectionSummary: string;
    }>
  | Readonly<{
      state: "checkpointed";
      reason: "watchdog_replan" | "watchdog_hard_stop";
      checkpointId: string;
    }>
  | Readonly<{
      state: "failed";
      stage: WatchdogFailureStage;
      error: DomainError;
    }>;
