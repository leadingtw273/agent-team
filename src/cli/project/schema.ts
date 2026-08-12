import { z } from "zod";

import {
  evaluateRegistrationWakeupHealth,
  registrationSystemdWakeupStates,
  registrationWebhookWakeupStates,
  type RegistrationWakeupHealth,
} from "../../application/registration/index.js";

import { requiresManualReasonCodeSchema } from "../../adapters/dispatch/job-progress-store.js";
import { canonicalInstantPattern } from "../../domain/foundation/index.js";
import { projectIdSchema } from "../../domain/project/index.js";

const countSchema = z.number().int().nonnegative().max(100_000);
const revisionSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const instantSchema = z.string().regex(canonicalInstantPattern);

export const projectRegistrationStates = [
  "registered",
  "configuration_incomplete",
  "unknown",
] as const;
export type ProjectRegistrationState = (typeof projectRegistrationStates)[number];

export const projectRegistrationReasonCodes = [
  "trusted_config_verified",
  "registration_draft_conflict",
  "trusted_config_missing",
  "trusted_config_invalid",
  "trusted_config_mismatch",
  "activation_missing",
  "activation_invalid",
  "trusted_config_unavailable",
  "activation_unavailable",
] as const;
export type ProjectRegistrationReasonCode = (typeof projectRegistrationReasonCodes)[number];

const registrationSchema = z
  .object({
    state: z.enum(projectRegistrationStates),
    reason: z.enum(projectRegistrationReasonCodes),
    trustedConfigRevision: revisionSchema.optional(),
  })
  .strict()
  .superRefine((registration, context) => {
    if (
      registration.state === "registered" &&
      (registration.reason !== "trusted_config_verified" ||
        registration.trustedConfigRevision === undefined)
    ) {
      context.addIssue({ code: "custom", message: "Invalid registered projection." });
    }
    if (registration.state !== "registered" && registration.trustedConfigRevision !== undefined) {
      context.addIssue({ code: "custom", message: "Untrusted revision must not be exposed." });
    }
    if (
      registration.state === "configuration_incomplete" &&
      ![
        "registration_draft_conflict",
        "trusted_config_missing",
        "trusted_config_invalid",
        "trusted_config_mismatch",
        "activation_missing",
        "activation_invalid",
      ].includes(registration.reason)
    ) {
      context.addIssue({ code: "custom", message: "Invalid incomplete reason." });
    }
    if (
      registration.state === "unknown" &&
      !["trusted_config_unavailable", "activation_unavailable"].includes(registration.reason)
    ) {
      context.addIssue({ code: "custom", message: "Invalid unknown reason." });
    }
  });

const inventorySchema = z
  .object({
    state: z.enum(["available", "unavailable"]),
    rejectedDraftCount: countSchema,
    reason: z.literal("registration_drafts_unavailable").optional(),
  })
  .strict()
  .superRefine((inventory, context) => {
    if (inventory.state === "available" && inventory.reason !== undefined) {
      context.addIssue({ code: "custom", message: "Available inventory has no failure reason." });
    }
    if (inventory.state === "unavailable" && inventory.reason === undefined) {
      context.addIssue({ code: "custom", message: "Unavailable inventory needs a fixed reason." });
    }
  });

const progressStageSchema = z.enum([
  "implementing",
  "ci_waiting",
  "awaiting_review",
  "fix_round",
  "merging",
  "completed",
  "failed",
  "paused",
  "requires_manual",
  "review_pending_retry",
  "ci_pending_retry",
  "superseded",
  "cancelled",
  "review_report_pending_retry",
]);

const progressSchema = z.union([
  z
    .object({
      state: z.literal("available"),
      counts: z
        .object({
          resumable: countSchema,
          blocked: countSchema,
          terminal: countSchema,
          total: countSchema,
        })
        .strict(),
      nonTerminal: z
        .array(
          z
            .object({
              jobId: z.string().regex(/^job_[0-9a-f-]{36}$/u),
              stage: progressStageSchema,
              updatedAt: instantSchema,
              reasonCode: requiresManualReasonCodeSchema.optional(),
            })
            .strict()
            .superRefine((record, context) => {
              if (record.stage !== "requires_manual" && record.reasonCode !== undefined) {
                context.addIssue({ code: "custom", message: "Reason code is not permitted." });
              }
            }),
        )
        .max(100_000),
    })
    .strict()
    .superRefine((progress, context) => {
      if (
        progress.counts.total !==
        progress.counts.resumable + progress.counts.blocked + progress.counts.terminal
      ) {
        context.addIssue({ code: "custom", message: "Progress counts must add up." });
      }
      if (progress.nonTerminal.length !== progress.counts.resumable + progress.counts.blocked) {
        context.addIssue({ code: "custom", message: "Non-terminal projection is incomplete." });
      }
    }),
  z
    .object({
      state: z.literal("unavailable"),
      reason: z.literal("durable_progress_unavailable"),
    })
    .strict(),
]);

const leasesSchema = z.union([
  z
    .object({
      state: z.literal("available"),
      observedAt: instantSchema,
      counts: z
        .object({
          active: countSchema,
          expired: countSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      state: z.literal("unavailable"),
      reason: z.literal("lease_inventory_unavailable"),
    })
    .strict(),
  z
    .object({
      state: z.literal("unknown"),
      reason: z.literal("lease_unassigned"),
    })
    .strict(),
]);

const quotaSchema = z
  .object({
    state: z.literal("unknown"),
    reason: z.literal("collector_unavailable"),
  })
  .strict();

const validWakeupHealths = Object.freeze(
  registrationSystemdWakeupStates.flatMap((systemd) =>
    registrationWebhookWakeupStates.map((webhook) =>
      evaluateRegistrationWakeupHealth({ systemd, webhook }),
    ),
  ),
);

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const registrationWakeupModeSchema = z.enum([
  "unattended",
  "scheduled_reconcile_only",
  "event_ingest_only",
  "manual_reconcile_only",
]);

const wakeupSchema = z
  .object({
    state: z.enum(["healthy", "degraded"]),
    mode: registrationWakeupModeSchema,
    capabilities: z
      .object({
        scheduledReconcile: z.boolean(),
        eventDrivenIngress: z.boolean(),
        unattended: z.boolean(),
      })
      .strict(),
    sources: z
      .object({
        systemd: z
          .object({
            state: z.enum(["available", "unavailable", "unknown"]),
            evidenceCode: z.string(),
          })
          .strict(),
        webhook: z
          .object({
            state: z.enum(["available", "unavailable", "unknown"]),
            evidenceCode: z.string(),
          })
          .strict(),
      })
      .strict(),
    evidenceCodes: z.array(z.string()).length(3),
  })
  .strict()
  .superRefine((candidate, context) => {
    const serializedCandidate = stableJson(candidate);
    if (!validWakeupHealths.some((expected) => stableJson(expected) === serializedCandidate)) {
      context.addIssue({ code: "custom", message: "invalid_registration_wakeup_projection" });
    }
  }) as z.ZodType<RegistrationWakeupHealth>;

const projectIdentitySchema = z
  .object({
    id: projectIdSchema,
    displayName: z.string().trim().min(1).max(120),
  })
  .strict();

const projectSummarySchema = projectIdentitySchema
  .extend({
    registration: registrationSchema,
    nonTerminalProgressCount: countSchema.nullable(),
    activeLeaseCount: countSchema.nullable(),
  })
  .strict();

const projectDetailSchema = projectIdentitySchema
  .extend({
    registration: registrationSchema,
    progress: progressSchema,
    leases: leasesSchema,
    quota: quotaSchema,
    wakeup: wakeupSchema,
  })
  .strict();

export const projectListPayloadSchema = z
  .object({
    operation: z.literal("project_list"),
    schemaVersion: z.literal(1),
    state: z.enum(["completed", "degraded"]),
    inventory: inventorySchema,
    projects: z.array(projectSummarySchema).max(10_000),
  })
  .strict();

export const projectDetailPayloadSchema = z
  .object({
    operation: z.literal("project_detail"),
    schemaVersion: z.literal(1),
    state: z.enum(["completed", "degraded"]),
    project: projectDetailSchema,
  })
  .strict();

export const projectFailurePayloadSchema = z
  .object({
    operation: z.literal("project_detail"),
    schemaVersion: z.literal(1),
    state: z.literal("failed"),
    reason: z.enum(["project_not_found", "project_inventory_unavailable", "project_read_failed"]),
  })
  .strict();

const projectPayloadSchema = z.union([
  projectListPayloadSchema,
  projectDetailPayloadSchema,
  projectFailurePayloadSchema,
]);

export type ProjectListPayload = z.infer<typeof projectListPayloadSchema>;
export type ProjectDetailPayload = z.infer<typeof projectDetailPayloadSchema>;
export type ProjectFailurePayload = z.infer<typeof projectFailurePayloadSchema>;
export type ProjectPayload = z.infer<typeof projectPayloadSchema>;

/** The sole JSON boundary for this command: unknown fields cannot reach stdout or stderr. */
export function serializeProjectPayload(payload: unknown): string {
  return JSON.stringify(projectPayloadSchema.parse(payload));
}
