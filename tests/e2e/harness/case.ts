/**
 * E005: the case description every Live E2E Case (E101-E118) hands to the collector. This is
 * deliberately just "what to look for" (identifiers + a time window) -- never *where* the host's
 * local state lives (that is `EvidenceCollectorPorts`'s concern, built once per environment by
 * `buildProductionEvidenceCollectorPorts` in ports.ts) and never a mutation of any kind.
 */
import { z } from "zod";

import { canonicalInstantPattern, parseInstant } from "../../../src/domain/foundation/index.js";

const instantSchema = z
  .string()
  .regex(canonicalInstantPattern)
  .refine((value) => parseInstant(value).ok, "Timestamp must be a canonical ISO instant.");

export const evidenceCaseDescriptionSchema = z
  .object({
    caseId: z.string().trim().min(1).max(64),
    runId: z.string().trim().min(1).max(128),
    timeWindow: z
      .object({ from: instantSchema, to: instantSchema })
      .strict()
      .refine((window) => window.from <= window.to, "timeWindow.from must not be after .to"),
    /** Identifies the Linear issue this case's evidence must be found on. `teamId`/`projectId`
     * are required because the existing, unmodified `LinearReadModel.readContext` (see
     * ../../../src/adapters/linear/read.ts) needs them to resolve the workflow-state/label
     * catalog before it will read any issue at all -- this collector deliberately reuses that
     * exact read path rather than inventing a lighter one. */
    linear: z
      .object({
        teamId: z.string().trim().min(1),
        projectId: z.string().trim().min(1),
        issueId: z.string().trim().min(1),
      })
      .strict(),
    github: z
      .object({
        repository: z.string().trim().min(1),
        pullRequestNumber: z.number().int().positive(),
        headSha: z
          .string()
          .trim()
          .regex(/^[0-9a-f]{40}$/u),
      })
      .strict(),
  })
  .strict();

export type EvidenceCaseDescription = z.infer<typeof evidenceCaseDescriptionSchema>;
