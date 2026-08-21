import { z } from "zod";

import { jobIdSchema } from "../jobs/index.js";
import { issueIdSchema, projectIdSchema } from "../project/index.js";
import { canonicalInstantPattern, parseInstant, type Instant } from "../foundation/index.js";
import { sha256Digest } from "../review/index.js";

const instantSchema = z
  .string()
  .regex(canonicalInstantPattern)
  .refine((value) => parseInstant(value).ok) as unknown as z.ZodType<Instant>;
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const revisionSchema = z.number().int().nonnegative();
const receiptSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[a-zA-Z0-9_.:/@+-]+$/u);
const externalIdSchema = z.string().trim().min(1).max(255);
const commitSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u);

export const humanAcceptanceStateSchema = z.enum([
  "pending",
  "adjustment_pending",
  "accepted",
  "invalidated",
]);
export type HumanAcceptanceState = z.infer<typeof humanAcceptanceStateSchema>;

export const humanDecisionSchema = z.enum(["accept", "request_adjustment"]);
export type HumanDecision = z.infer<typeof humanDecisionSchema>;

export const humanAcceptanceInvalidationReasonSchema = z.enum([
  "cancelled",
  "reopened",
  "requirements_changed",
]);
export type HumanAcceptanceInvalidationReason = z.infer<
  typeof humanAcceptanceInvalidationReasonSchema
>;

export const humanAcceptanceIdentitySchema = z
  .object({
    projectId: projectIdSchema,
    issueId: issueIdSchema,
    jobId: jobIdSchema,
    requirementDigest: digestSchema,
    mergeCommit: commitSchema,
  })
  .strict();
export type HumanAcceptanceIdentity = z.infer<typeof humanAcceptanceIdentitySchema>;

const decisionSchema = z
  .object({
    sequence: z.number().int().positive(),
    decision: humanDecisionSchema,
    decisionReceiptId: receiptSchema,
    decidedAt: instantSchema,
  })
  .strict();

const adjustmentCompletionSchema = z
  .object({
    adjustmentIssueId: externalIdSchema,
    mergeCommit: commitSchema,
    mergedAt: instantSchema,
  })
  .strict();

const adjustmentSchema = z
  .object({
    sequence: z.number().int().positive(),
    decisionReceiptId: receiptSchema,
    adjustmentIssueId: externalIdSchema.optional(),
    completion: adjustmentCompletionSchema.optional(),
  })
  .strict()
  .superRefine((adjustment, context) => {
    if (adjustment.completion !== undefined && adjustment.adjustmentIssueId === undefined) {
      context.addIssue({
        code: "custom",
        message: "a completed adjustment must be attached first",
        path: ["adjustmentIssueId"],
      });
    }
    if (
      adjustment.completion !== undefined &&
      adjustment.completion.adjustmentIssueId !== adjustment.adjustmentIssueId
    ) {
      context.addIssue({
        code: "custom",
        message: "adjustment completion must bind the attached issue",
        path: ["completion", "adjustmentIssueId"],
      });
    }
  });

const invalidationSchema = z
  .object({
    reason: humanAcceptanceInvalidationReasonSchema,
    observedAt: instantSchema,
  })
  .strict();

export const humanAcceptanceRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: revisionSchema,
    identityDigest: digestSchema,
    identity: humanAcceptanceIdentitySchema,
    externalIssueId: externalIdSchema,
    changeRequest: z
      .object({
        url: z.url().startsWith("https://"),
        number: z.number().int().positive(),
        headSha: commitSchema,
      })
      .strict(),
    humanSummaryDigest: digestSchema,
    mergedAt: instantSchema,
    pendingSince: instantSchema,
    state: humanAcceptanceStateSchema,
    decisions: z.array(decisionSchema).max(100),
    adjustments: z.array(adjustmentSchema).max(100),
    invalidation: invalidationSchema.optional(),
    updatedAt: instantSchema,
  })
  .strict()
  .superRefine((record, context) => {
    const calculated = sha256Digest(record.identity);
    if (!calculated.ok || calculated.value !== record.identityDigest) {
      context.addIssue({
        code: "custom",
        message: "identity digest must match the canonical identity",
        path: ["identityDigest"],
      });
    }
    if (record.pendingSince < record.mergedAt || record.updatedAt < record.pendingSince) {
      context.addIssue({
        code: "custom",
        message: "acceptance timestamps must be monotonic",
        path: ["updatedAt"],
      });
    }
    record.decisions.forEach((decision, index) => {
      if (decision.sequence !== index + 1) {
        context.addIssue({
          code: "custom",
          message: "decision sequence must be contiguous",
          path: ["decisions", index, "sequence"],
        });
      }
    });
    const requestDecisions = record.decisions.filter(
      (decision) => decision.decision === "request_adjustment",
    );
    record.adjustments.forEach((adjustment, index) => {
      const decision = requestDecisions[index];
      if (
        decision === undefined ||
        adjustment.sequence !== index + 1 ||
        adjustment.decisionReceiptId !== decision.decisionReceiptId
      ) {
        context.addIssue({
          code: "custom",
          message: "adjustment must bind its request decision",
          path: ["adjustments", index],
        });
      }
    });
    if (record.adjustments.length !== requestDecisions.length) {
      context.addIssue({
        code: "custom",
        message: "every adjustment request must have one durable slot",
        path: ["adjustments"],
      });
    }
    const receiptIds = record.decisions.map((decision) => decision.decisionReceiptId);
    if (new Set(receiptIds).size !== receiptIds.length) {
      context.addIssue({
        code: "custom",
        message: "decision receipts must be unique",
        path: ["decisions"],
      });
    }
    const lastDecision = record.decisions.at(-1);
    const lastAdjustment = record.adjustments.at(-1);
    if (record.state === "accepted" && lastDecision?.decision !== "accept") {
      context.addIssue({ code: "custom", message: "accepted requires accept", path: ["state"] });
    }
    if (
      record.state === "adjustment_pending" &&
      (lastDecision?.decision !== "request_adjustment" || lastAdjustment?.completion !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "adjustment_pending requires an incomplete adjustment",
        path: ["state"],
      });
    }
    if (
      record.state === "pending" &&
      lastDecision?.decision === "request_adjustment" &&
      lastAdjustment?.completion === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "pending cannot retain an incomplete adjustment",
        path: ["state"],
      });
    }
    if ((record.state === "invalidated") !== (record.invalidation !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "invalidation is required exactly for invalidated records",
        path: ["invalidation"],
      });
    }
  });

export type HumanAcceptanceRecord = z.infer<typeof humanAcceptanceRecordSchema>;

export const humanAcceptanceLedgerSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: revisionSchema,
    projectId: projectIdSchema,
    records: z.array(humanAcceptanceRecordSchema).max(10_000),
  })
  .strict()
  .superRefine((ledger, context) => {
    const identities = ledger.records.map((record) => record.identityDigest);
    if (new Set(identities).size !== identities.length) {
      context.addIssue({ code: "custom", message: "identity must be unique", path: ["records"] });
    }
    const receipts = ledger.records.flatMap((record) =>
      record.decisions.map((decision) => decision.decisionReceiptId),
    );
    if (new Set(receipts).size !== receipts.length) {
      context.addIssue({
        code: "custom",
        message: "decision receipt cannot cross acceptance generations",
        path: ["records"],
      });
    }
  });

export type HumanAcceptanceLedger = z.infer<typeof humanAcceptanceLedgerSchema>;

export function humanAcceptanceIdentityDigest(
  identity: HumanAcceptanceIdentity,
): string | undefined {
  const parsed = humanAcceptanceIdentitySchema.safeParse(identity);
  if (!parsed.success) return undefined;
  const digest = sha256Digest(parsed.data);
  return digest.ok ? digest.value : undefined;
}
