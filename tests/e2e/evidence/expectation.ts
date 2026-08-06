/**
 * E007: what a Live E2E Case (E101-E118) expects its own four-source `EvidenceBundle` (E005,
 * ../harness/schema.ts) to reconcile against. This is deliberately a separate, later-stage
 * description from `../harness/case.ts`'s `EvidenceCaseDescription` -- that type is "what to read"
 * (handed to the collector); this type is "what the read result must equal" (handed to the
 * validator). They overlap in the identifiers they both carry (by design, so a case's expectation
 * is easy to derive from the same case description that drove collection), but this module does
 * not import or extend `EvidenceCaseDescription` -- keeping the validator's own input contract
 * independent of the harness's collection-side types, per this task's "read harness, don't modify
 * it" boundary.
 */
import { z } from "zod";

import { canonicalInstantPattern, parseInstant } from "../../../src/domain/foundation/index.js";

const instantSchema = z
  .string()
  .regex(canonicalInstantPattern)
  .refine((value) => parseInstant(value).ok, "Timestamp must be a canonical ISO instant.");

const shaPattern = /^[0-9a-f]{40}$/u;

export const evidenceValidationExpectationSchema = z
  .object({
    caseId: z.string().trim().min(1).max(64),
    runId: z.string().trim().min(1).max(128),
    timeWindow: z
      .object({ from: instantSchema, to: instantSchema })
      .strict()
      .refine((window) => window.from <= window.to, "timeWindow.from must not be after .to"),
    linear: z.object({ issueId: z.string().trim().min(1) }).strict(),
    github: z
      .object({
        pullRequestNumber: z.number().int().positive(),
        headSha: z.string().trim().regex(shaPattern),
      })
      .strict(),
    checkpoint: z
      .object({ issueId: z.string().trim().min(1), jobId: z.string().trim().min(1) })
      .strict(),
    /** Event types (`localEvents.events[].eventType`) this case declares mandatory; every one
     * must appear at least once among the collected events or
     * `local_events_required_event_types_present` fails. May be empty for a case that names no
     * mandatory event type, but never omitted -- an explicit empty list, not an implicit one. */
    requiredEventTypes: z.array(z.string().trim().min(1)),
  })
  .strict();

export type EvidenceValidationExpectation = z.infer<typeof evidenceValidationExpectationSchema>;
