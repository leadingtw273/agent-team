import { z } from "zod";

import {
  modelCandidateSchema,
  modelRoutingConfigSchema,
  type ActiveModelAssignment,
  type ModelCandidate,
  type ModelRoutingConfig,
} from "../../../application/routing/index.js";
import { agentRoleSchema, type AgentRole } from "../../../domain/project/index.js";
import { err, ok, type Result } from "../../../domain/foundation/index.js";
import { findRoleModelCandidate } from "./catalog.js";

export const roleModelSettingsInputSchema = modelRoutingConfigSchema;

export const activeModelAssignmentSchema = z
  .object({
    jobId: z.string().trim().min(1).max(255),
    role: agentRoleSchema,
    candidate: modelCandidateSchema,
    candidateIndex: z.number().int().min(0).max(19),
  })
  .strict();

export type RoleModelSettingsError =
  | Readonly<{ code: "invalid_input" }>
  | Readonly<{ code: "unknown_candidate"; role: AgentRole; candidate: ModelCandidate }>
  | Readonly<{
      code: "candidate_not_available_for_role";
      role: AgentRole;
      candidate: ModelCandidate;
    }>
  | Readonly<{ code: "stored_config_invalid" }>
  | Readonly<{ code: "active_assignment_invalid" }>
  | Readonly<{ code: "store_unavailable" }>
  | Readonly<{ code: "read_back_mismatch" }>;

function cloneCandidate(candidate: ModelCandidate): ModelCandidate {
  return Object.freeze({ provider: candidate.provider, model: candidate.model });
}

export function cloneRoleModelRoutingConfig(config: ModelRoutingConfig): ModelRoutingConfig {
  return {
    schemaVersion: 1,
    routes: config.routes.map((route) => ({
      role: route.role,
      candidates: route.candidates.map(cloneCandidate),
    })),
  };
}

export function cloneActiveModelAssignment(
  assignment: ActiveModelAssignment,
): ActiveModelAssignment {
  return Object.freeze({
    jobId: assignment.jobId,
    role: assignment.role,
    candidate: cloneCandidate(assignment.candidate),
    candidateIndex: assignment.candidateIndex,
  });
}

export function validateRoleModelSettings(
  input: unknown,
): Result<ModelRoutingConfig, RoleModelSettingsError> {
  const parsed = roleModelSettingsInputSchema.safeParse(input);
  if (!parsed.success) return err(Object.freeze({ code: "invalid_input" }));

  for (const route of parsed.data.routes) {
    for (const candidate of route.candidates) {
      const known = findRoleModelCandidate(candidate);
      if (known === undefined) {
        return err(
          Object.freeze({
            code: "unknown_candidate",
            role: route.role,
            candidate: cloneCandidate(candidate),
          }),
        );
      }
      if (!known.roles.includes(route.role)) {
        return err(
          Object.freeze({
            code: "candidate_not_available_for_role",
            role: route.role,
            candidate: cloneCandidate(candidate),
          }),
        );
      }
    }
  }

  return ok(cloneRoleModelRoutingConfig(parsed.data));
}

export function validateActiveModelAssignments(
  input: readonly unknown[],
): Result<readonly ActiveModelAssignment[], RoleModelSettingsError> {
  const assignments: ActiveModelAssignment[] = [];
  const jobIds = new Set<string>();
  for (const candidate of input) {
    const parsed = activeModelAssignmentSchema.safeParse(candidate);
    if (!parsed.success) {
      return err(Object.freeze({ code: "active_assignment_invalid" }));
    }
    if (jobIds.has(parsed.data.jobId))
      return err(Object.freeze({ code: "active_assignment_invalid" }));
    jobIds.add(parsed.data.jobId);
    assignments.push(cloneActiveModelAssignment(parsed.data));
  }
  return ok(Object.freeze(assignments));
}
