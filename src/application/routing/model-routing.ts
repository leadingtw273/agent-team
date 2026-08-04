import { z } from "zod";

import { agentRoleSchema, type AgentRole } from "../../domain/project/index.js";

export const modelProviderSchema = z.enum(["codex", "claude", "gemini"]);
export type ModelProvider = z.infer<typeof modelProviderSchema>;

export const modelCandidateSchema = z
  .object({
    provider: modelProviderSchema,
    model: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]*$/u),
  })
  .strict();

export type ModelCandidate = z.infer<typeof modelCandidateSchema>;

export const roleModelRouteSchema = z
  .object({
    role: agentRoleSchema,
    candidates: z.array(modelCandidateSchema).min(1).max(20),
  })
  .strict()
  .superRefine((route, context) => {
    const identities = route.candidates.map(
      (candidate) => `${candidate.provider}:${candidate.model}`,
    );
    if (new Set(identities).size !== identities.length) {
      context.addIssue({
        code: "custom",
        message: "Model candidates must be unique within a role route.",
        path: ["candidates"],
      });
    }
    if (
      route.role !== "visual_reviewer" &&
      route.candidates.some((candidate) => candidate.provider === "gemini")
    ) {
      context.addIssue({
        code: "custom",
        message: "Gemini is visual-review-only in version 1.",
        path: ["candidates"],
      });
    }
  });

const versionOneRoles = agentRoleSchema.options;

export const modelRoutingConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    routes: z.array(roleModelRouteSchema).length(versionOneRoles.length),
  })
  .strict()
  .superRefine((config, context) => {
    const configuredRoles = new Set(config.routes.map((route) => route.role));
    for (const role of versionOneRoles) {
      if (!configuredRoles.has(role)) {
        context.addIssue({
          code: "custom",
          message: `Missing model route for ${role}.`,
          path: ["routes"],
        });
      }
    }
    if (configuredRoles.size !== config.routes.length) {
      context.addIssue({
        code: "custom",
        message: "Every role must have exactly one model route.",
        path: ["routes"],
      });
    }
  });

export type ModelRoutingConfig = z.infer<typeof modelRoutingConfigSchema>;

export const candidateRouteStateSchema = z.enum([
  "ready",
  "provider_unavailable",
  "provider_slot_full",
  "quota_blocked",
  "quota_unknown",
]);
export type CandidateRouteState = z.infer<typeof candidateRouteStateSchema>;

export interface CandidateObservation extends ModelCandidate {
  readonly state: CandidateRouteState;
}

const candidateObservationSchema = z
  .object({
    provider: modelProviderSchema,
    model: modelCandidateSchema.shape.model,
    state: candidateRouteStateSchema,
  })
  .strict();

export interface SkippedModelCandidate extends ModelCandidate {
  readonly index: number;
  readonly state: Exclude<CandidateRouteState, "ready"> | "observation_missing";
}

export type ModelRouteDecision =
  | Readonly<{
      kind: "selected";
      role: AgentRole;
      candidate: ModelCandidate;
      candidateIndex: number;
      fallbackUsed: boolean;
      skipped: readonly SkippedModelCandidate[];
    }>
  | Readonly<{
      kind: "waiting";
      role: AgentRole;
      reason: "invalid_config" | "no_eligible_candidate";
      skipped: readonly SkippedModelCandidate[];
    }>;

function candidateIdentity(candidate: ModelCandidate): string {
  return `${candidate.provider}:${candidate.model}`;
}

export function selectModelRoute(
  configInput: unknown,
  roleInput: unknown,
  observationsInput: readonly CandidateObservation[],
): ModelRouteDecision {
  const config = modelRoutingConfigSchema.safeParse(configInput);
  const role = agentRoleSchema.safeParse(roleInput);
  const observations = z.array(candidateObservationSchema).safeParse(observationsInput);
  const observationIdentities = observations.success
    ? observations.data.map(candidateIdentity)
    : [];
  if (
    !config.success ||
    !role.success ||
    !observations.success ||
    new Set(observationIdentities).size !== observationIdentities.length
  ) {
    return Object.freeze({
      kind: "waiting",
      role: role.success ? role.data : "team_lead",
      reason: "invalid_config",
      skipped: Object.freeze([]),
    });
  }
  const route = config.data.routes.find((candidateRoute) => candidateRoute.role === role.data);
  if (route === undefined) {
    return Object.freeze({
      kind: "waiting",
      role: role.data,
      reason: "invalid_config",
      skipped: Object.freeze([]),
    });
  }
  const observationMap = new Map(
    observations.data.map((observation) => [candidateIdentity(observation), observation.state]),
  );
  const skipped: SkippedModelCandidate[] = [];
  for (const [index, candidate] of route.candidates.entries()) {
    const state = observationMap.get(candidateIdentity(candidate));
    if (state === "ready") {
      return Object.freeze({
        kind: "selected",
        role: role.data,
        candidate: Object.freeze(candidate),
        candidateIndex: index,
        fallbackUsed: index > 0,
        skipped: Object.freeze(skipped),
      });
    }
    skipped.push(
      Object.freeze({
        ...candidate,
        index,
        state: state ?? "observation_missing",
      }),
    );
  }
  return Object.freeze({
    kind: "waiting",
    role: role.data,
    reason: "no_eligible_candidate",
    skipped: Object.freeze(skipped),
  });
}

export interface ActiveModelAssignment {
  readonly jobId: string;
  readonly role: AgentRole;
  readonly candidate: ModelCandidate;
  readonly candidateIndex: number;
}

export function retainActiveModelAssignment(
  assignment: ActiveModelAssignment,
): ActiveModelAssignment {
  return Object.freeze({
    jobId: assignment.jobId,
    role: assignment.role,
    candidate: Object.freeze({ ...assignment.candidate }),
    candidateIndex: assignment.candidateIndex,
  });
}
