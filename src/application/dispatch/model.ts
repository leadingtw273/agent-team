import { z } from "zod";

import {
  agentRoleSchema,
  changeRegionSchema,
  prioritySchema,
  type AgentRole,
  type ChangeRegion,
  type Priority,
} from "../../domain/project/index.js";
import {
  candidateRouteStateSchema,
  modelProviderSchema,
  type CandidateObservation,
  type ModelCandidate,
  type ModelProvider,
  type ModelRoutingConfig,
  type SkippedModelCandidate,
} from "../routing/index.js";

export const dispatchStageSchema = z.enum([
  "implementation",
  "review",
  "integration",
  "merge",
  "ci",
  "webhook",
  "health",
]);
export type DispatchStage = z.infer<typeof dispatchStageSchema>;

export const dispatchWorkKindSchema = z.enum(["model", "mechanical"]);
export type DispatchWorkKind = z.infer<typeof dispatchWorkKindSchema>;

const dispatchCandidateSchema = z
  .object({
    id: z.string().trim().min(1).max(255),
    projectId: z.string().trim().min(1).max(255),
    repositoryId: z.string().trim().min(1).max(255),
    priority: prioritySchema,
    readyAt: z.iso.datetime({ offset: true }),
    role: agentRoleSchema,
    workKind: dispatchWorkKindSchema,
    stage: dispatchStageSchema,
    declaredRegions: z.array(changeRegionSchema).min(1).max(100).optional(),
  })
  .strict()
  .superRefine((candidate, context) => {
    if (
      candidate.workKind === "mechanical" &&
      !["ci", "webhook", "health"].includes(candidate.stage)
    ) {
      context.addIssue({
        code: "custom",
        message: "Mechanical work is limited to CI, webhook, and health stages.",
        path: ["stage"],
      });
    }
    if (candidate.workKind === "model" && ["ci", "webhook", "health"].includes(candidate.stage)) {
      context.addIssue({
        code: "custom",
        message: "CI, webhook, and health stages must be mechanical.",
        path: ["workKind"],
      });
    }
  });

export type DispatchCandidate = z.infer<typeof dispatchCandidateSchema>;

const modelExecutionOccupancySchema = z
  .object({
    jobId: z.string().trim().min(1).max(255),
    projectId: z.string().trim().min(1).max(255),
    provider: modelProviderSchema,
  })
  .strict();

export type ModelExecutionOccupancy = z.infer<typeof modelExecutionOccupancySchema>;

const repositoryReservationSchema = z
  .object({
    jobId: z.string().trim().min(1).max(255),
    projectId: z.string().trim().min(1).max(255),
    repositoryId: z.string().trim().min(1).max(255),
    stage: dispatchStageSchema,
    declaredRegions: z.array(changeRegionSchema).min(1).max(100).optional(),
  })
  .strict();

export type RepositoryReservation = z.infer<typeof repositoryReservationSchema>;

const positiveSlotLimitSchema = z.number().int().positive().max(1_000);

export const dispatchSlotLimitsSchema = z
  .object({
    globalModelJobs: positiveSlotLimitSchema.default(4),
    perProviderModelJobs: z
      .object({
        codex: positiveSlotLimitSchema.default(3),
        claude: positiveSlotLimitSchema.default(1),
        gemini: positiveSlotLimitSchema.default(1),
      })
      .strict()
      .default({ codex: 3, claude: 1, gemini: 1 }),
    perProjectModelJobs: positiveSlotLimitSchema.default(4),
    perRepositoryIntegrationJobs: z.literal(1).default(1),
  })
  .strict();

export type DispatchSlotLimits = z.infer<typeof dispatchSlotLimitsSchema>;

export const DEFAULT_DISPATCH_SLOT_LIMITS: DispatchSlotLimits = Object.freeze({
  globalModelJobs: 4,
  perProviderModelJobs: Object.freeze({ codex: 3, claude: 1, gemini: 1 }),
  perProjectModelJobs: 4,
  perRepositoryIntegrationJobs: 1,
});

const rotationCursorSchema = z
  .object({
    urgent: z.string().trim().min(1).max(255).optional(),
    high: z.string().trim().min(1).max(255).optional(),
    medium: z.string().trim().min(1).max(255).optional(),
    low: z.string().trim().min(1).max(255).optional(),
  })
  .strict()
  .default({});

export type RotationCursor = z.infer<typeof rotationCursorSchema>;

const candidateObservationSchema = z
  .object({
    provider: modelProviderSchema,
    model: z.string().trim().min(1).max(255),
    state: candidateRouteStateSchema,
  })
  .strict();

export const dispatchDecisionInputSchema = z
  .object({
    candidates: z.array(dispatchCandidateSchema).max(10_000),
    executionOccupancy: z.array(modelExecutionOccupancySchema).max(10_000),
    repositoryReservations: z.array(repositoryReservationSchema).max(10_000),
    routingConfig: z.unknown(),
    routeObservations: z.array(candidateObservationSchema).max(1_000),
    rotation: rotationCursorSchema,
    slotLimits: dispatchSlotLimitsSchema.default(DEFAULT_DISPATCH_SLOT_LIMITS),
  })
  .strict()
  .superRefine((input, context) => {
    const candidateIds = input.candidates.map((candidate) => candidate.id);
    if (new Set(candidateIds).size !== candidateIds.length) {
      context.addIssue({
        code: "custom",
        message: "Dispatch candidate IDs must be unique.",
        path: ["candidates"],
      });
    }
    const occupancyJobIds = input.executionOccupancy.map((entry) => entry.jobId);
    if (new Set(occupancyJobIds).size !== occupancyJobIds.length) {
      context.addIssue({
        code: "custom",
        message: "Model execution occupancy Job IDs must be unique.",
        path: ["executionOccupancy"],
      });
    }
    const reservationJobIds = input.repositoryReservations.map((entry) => entry.jobId);
    if (new Set(reservationJobIds).size !== reservationJobIds.length) {
      context.addIssue({
        code: "custom",
        message: "Repository reservation Job IDs must be unique.",
        path: ["repositoryReservations"],
      });
    }
  });

export interface DispatchDecisionInput {
  readonly candidates: readonly DispatchCandidate[];
  readonly executionOccupancy: readonly ModelExecutionOccupancy[];
  readonly repositoryReservations: readonly RepositoryReservation[];
  readonly routingConfig: ModelRoutingConfig;
  readonly routeObservations: readonly CandidateObservation[];
  readonly rotation?: RotationCursor;
  readonly slotLimits?: DispatchSlotLimits;
}

export type DispatchBlocker =
  | Readonly<{ code: "global_model_slot_full" }>
  | Readonly<{ code: "project_model_slot_full"; projectId: string }>
  | Readonly<{
      code: "provider_route_unavailable";
      role: AgentRole;
      skipped: readonly SkippedModelCandidate[];
    }>
  | Readonly<{
      code: "repository_scope_conflict";
      repositoryId: string;
      activeJobId: string;
    }>
  | Readonly<{
      code: "repository_integration_slot_full";
      repositoryId: string;
    }>;

export interface SkippedDispatchCandidate {
  readonly candidateId: string;
  readonly blocker: DispatchBlocker;
}

export type DispatchDecision =
  | Readonly<{
      kind: "selected";
      candidate: DispatchCandidate;
      consumesModelSlot: boolean;
      model?: Readonly<{
        candidate: ModelCandidate;
        candidateIndex: number;
        fallbackUsed: boolean;
      }>;
      nextRotation: RotationCursor;
      skipped: readonly SkippedDispatchCandidate[];
    }>
  | Readonly<{
      kind: "waiting";
      reason: "invalid_input" | "no_candidates" | "no_dispatchable_candidate";
      skipped: readonly SkippedDispatchCandidate[];
    }>;

export const PRIORITY_ORDER: Readonly<Record<Priority, number>> = Object.freeze({
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
});

export type { AgentRole, ChangeRegion, ModelProvider, Priority };
