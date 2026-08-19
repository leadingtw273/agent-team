import { z } from "zod";

import {
  canonicalInstantPattern,
  parseInstant,
  type DomainError,
  type Instant,
  type Result,
} from "../../domain/foundation/index.js";
import { agentStatuses, blockingReasons, workStatuses } from "../../domain/workflow/index.js";
import type { WorkStatus } from "../../domain/workflow/index.js";
import type { WorkManagementIssueRef, WorkManagementIssueSnapshot } from "../ports/index.js";
import { workStatusLifecycleModeSchema } from "../projects/index.js";
import type { WorkStatusLifecycleMode } from "../projects/index.js";
import { sha256Digest } from "../../domain/review/index.js";

const instantSchema = z
  .string()
  .regex(canonicalInstantPattern)
  .refine((value) => parseInstant(value).ok) as unknown as z.ZodType<Instant>;
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const lastErrorCodeSchema = z.string().trim().min(1).max(64);
const externalIdSchema = z.string().trim().min(1).max(255);

export const workStatusHistoryEntrySchema = z
  .object({
    id: externalIdSchema,
    createdAt: instantSchema,
    actorKind: z.enum(["human", "automation"]),
    fromStateId: externalIdSchema.nullable(),
    toStateId: externalIdSchema.nullable(),
    fromTeamId: externalIdSchema.nullable(),
    toTeamId: externalIdSchema.nullable(),
    fromProjectId: externalIdSchema.nullable(),
    toProjectId: externalIdSchema.nullable(),
    archived: z.boolean().nullable(),
    trashed: z.boolean().nullable(),
  })
  .strict();
export const workStatusStateSpanSchema = z
  .object({
    id: externalIdSchema,
    stateId: externalIdSchema,
    startedAt: instantSchema,
    endedAt: instantSchema.nullable(),
  })
  .strict();
export interface WorkStatusHistorySnapshot {
  readonly currentStateId: string;
  readonly stateIdByWorkStatus: Readonly<Record<WorkStatus, string>>;
  readonly entries: readonly z.infer<typeof workStatusHistoryEntrySchema>[];
  readonly stateSpans: readonly z.infer<typeof workStatusStateSpanSchema>[];
}
export interface WorkStatusHistoryPort {
  getIssueHistory(
    reference: WorkManagementIssueRef,
  ): Promise<Result<WorkStatusHistorySnapshot, DomainError>>;
}

const transitionHistoryEvidenceSchema = z
  .object({
    preStateId: externalIdSchema,
    targetStateId: externalIdSchema,
    observedRevision: z.string().trim().min(1).max(255),
    historyPrefixDigest: digestSchema,
    historyEntryCount: z.number().int().min(0).max(100_000),
    historyTailId: externalIdSchema.optional(),
    preStateSpanId: externalIdSchema,
  })
  .strict();
export type TransitionHistoryEvidence = z.infer<typeof transitionHistoryEvidenceSchema>;

export const workStatusLifecycleStepSchema = z.enum([
  "work_start",
  "review_start",
  "fix_start",
  "merge_start",
  "complete",
  "requires_manual",
  "clear_condition",
]);
export type WorkStatusLifecycleStep = z.infer<typeof workStatusLifecycleStepSchema>;

const lifecycleChannelReceiptSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("not_required") }).strict(),
  z
    .object({
      state: z.literal("observed"),
      observedAt: instantSchema,
      observedRevision: z.string().trim().min(1).max(255),
    })
    .strict(),
  z
    .object({ state: z.literal("intent"), idempotencyKey: z.string().trim().min(1).max(512) })
    .strict(),
  z
    .object({
      state: z.literal("sent_unknown"),
      idempotencyKey: z.string().trim().min(1).max(512),
      errorCode: lastErrorCodeSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("confirmed"),
      idempotencyKey: z.string().trim().min(1).max(512),
      confirmedAt: instantSchema,
      observedRevision: z.string().trim().min(1).max(255),
    })
    .strict(),
]);

export const lifecycleAgentTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("clear") }).strict(),
  z
    .object({
      kind: z.literal("set"),
      status: z.enum(agentStatuses),
      blockingReason: z.enum(blockingReasons).optional(),
    })
    .strict(),
]);
export type LifecycleAgentTarget = z.infer<typeof lifecycleAgentTargetSchema>;

const lifecycleFailureCounterSchema = z
  .object({
    count: z.number().int().min(0).max(6),
    lastErrorCode: lastErrorCodeSchema.optional(),
    lastInvocation: digestSchema.optional(),
  })
  .strict();

export const workStatusLifecycleTransitionSchema = z
  .object({
    step: workStatusLifecycleStepSchema,
    instance: digestSchema,
    mainTarget: z.enum(workStatuses).optional(),
    allowedMainSources: z.array(z.enum(workStatuses)).max(workStatuses.length).optional(),
    agentTarget: lifecycleAgentTargetSchema.optional(),
    main: lifecycleChannelReceiptSchema,
    agent: lifecycleChannelReceiptSchema,
    mainFailures: lifecycleFailureCounterSchema,
    agentFailures: lifecycleFailureCounterSchema,
    historyEvidence: transitionHistoryEvidenceSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mainTarget === undefined && value.agentTarget === undefined) {
      context.addIssue({ code: "custom", message: "A lifecycle transition needs a target." });
    }
    if ((value.mainTarget === undefined) !== (value.main.state === "not_required")) {
      context.addIssue({
        code: "custom",
        path: ["main"],
        message: "Main receipt/target mismatch.",
      });
    }
    if ((value.agentTarget === undefined) !== (value.agent.state === "not_required")) {
      context.addIssue({
        code: "custom",
        path: ["agent"],
        message: "Agent receipt/target mismatch.",
      });
    }
  });
export type WorkStatusLifecycleTransition = z.infer<typeof workStatusLifecycleTransitionSchema>;

export const workStatusLifecycleCheckpointSchema = z
  .object({
    admissionMode: workStatusLifecycleModeSchema,
    capabilityDigest: digestSchema.optional(),
    phase: z.enum(["work_start", "implementing", "reviewing", "fixing", "merging", "terminal"]),
    transitions: z.array(workStatusLifecycleTransitionSchema).max(64),
    incident: z
      .object({
        reasonCode: z.enum([
          "capability_unavailable",
          "identity_drift",
          "human_status_drift",
          "mutation_unconfirmed",
          "retry_exhausted",
          "bootstrap_incomplete",
        ]),
        channel: z.enum(["main", "agent", "bootstrap"]),
      })
      .strict()
      .optional(),
    recovery: z
      .object({ epoch: z.number().int().min(1).max(100), operatorReceiptDigest: digestSchema })
      .strict()
      .optional(),
    recoveries: z
      .array(
        z
          .object({
            epoch: z.number().int().min(1).max(100),
            sourceTransitionInstance: digestSchema,
            disposition: z.enum(["target_observed", "pre_state_reissued", "pre_state_retained"]),
            operatorReceiptDigest: digestSchema,
            authorizedAt: instantSchema,
            historyDigest: digestSchema,
            continuationTransitionInstance: digestSchema.optional(),
          })
          .strict(),
      )
      .max(100)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.admissionMode === "enforce" && value.capabilityDigest === undefined) {
      context.addIssue({
        code: "custom",
        path: ["capabilityDigest"],
        message: "Enforce checkpoints require a capability digest.",
      });
    }
  });
export type WorkStatusLifecycleCheckpoint = z.infer<typeof workStatusLifecycleCheckpointSchema>;

export interface IssueScope {
  readonly projectId: string;
  readonly externalIssueId: string;
}

export interface IssueScopeLockHandle {
  readonly scopeDigest: string;
  readonly holderId: string;
  release(): Promise<Result<void, DomainError>>;
}

/**
 * The one lock namespace shared by dispatch, resume, reconcile, webhook, and future Ready Gate
 * mutations. Callers must never introduce a route-specific prefix around the same Issue scope.
 */
export interface IssueScopeLockPort {
  acquire(scope: IssueScope, holderId: string): Promise<Result<IssueScopeLockHandle, DomainError>>;
}

export interface WorkStatusLifecycleLedgerSnapshot {
  readonly revision: number;
  readonly checkpoint: WorkStatusLifecycleCheckpoint;
}

export interface WorkStatusLifecycleLedgerPort {
  load(jobId: string): Promise<Result<WorkStatusLifecycleLedgerSnapshot | undefined, DomainError>>;
  compareAndSwap(
    jobId: string,
    expectedRevision: number,
    checkpoint: WorkStatusLifecycleCheckpoint,
  ): Promise<Result<WorkStatusLifecycleLedgerSnapshot, DomainError>>;
}

export interface WorkStatusLifecycleTransitionBinding {
  readonly jobId: string;
  readonly step: WorkStatusLifecycleStep;
  readonly mainTarget?: WorkStatus;
  readonly agentTarget?: LifecycleAgentTarget;
  readonly allowedMainSources?: readonly WorkStatus[];
  /** Authoritative per-step binding, e.g. execution epoch or review identity digest. */
  readonly authorityDigest: string;
}

export function createWorkStatusLifecycleTransitionInstance(
  binding: WorkStatusLifecycleTransitionBinding,
): Result<string, DomainError<"invariant_violation">> {
  return sha256Digest({ schemaVersion: 1, ...binding });
}

export interface WorkStatusLifecycleRequest {
  readonly jobId: string;
  readonly reference: WorkManagementIssueRef;
  readonly holderId: string;
  readonly mode: WorkStatusLifecycleMode;
  readonly capabilityDigest?: string;
  readonly phase: WorkStatusLifecycleCheckpoint["phase"];
  readonly step: WorkStatusLifecycleStep;
  readonly transitionInstance: string;
  readonly invocationDigest: string;
  readonly mainTarget?: WorkStatus;
  readonly allowedMainSources?: readonly WorkStatus[];
  readonly agentTarget?: LifecycleAgentTarget;
}

export type WorkStatusLifecycleOutcome =
  | Readonly<{
      state: "permitted";
      mode: WorkStatusLifecycleMode;
      main: "confirmed" | "operator_authorized" | "observed" | "not_required";
      agent: "confirmed" | "observed" | "not_required" | "pending";
      snapshot?: WorkManagementIssueSnapshot;
    }>
  | Readonly<{
      state: "blocked";
      reason:
        | "lock_conflict"
        | "ledger_unavailable"
        | "checkpoint_identity_mismatch"
        | "human_status_drift"
        | "authority_ambiguous"
        | "main_unconfirmed"
        | "retry_exhausted"
        | "provider_outage";
      error?: DomainError;
    }>;
