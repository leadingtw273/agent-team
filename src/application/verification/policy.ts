import { z } from "zod";

import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { verificationLevelSchema, type VerificationLevel } from "../../domain/project/index.js";
import {
  verificationCommandCatalogSchema,
  type ProjectCommand,
  type TrustedProjectConfig,
} from "../projects/index.js";

export const verificationUpgradeReasonSchema = z.enum([
  "direct_regression_risk",
  "cross_provider_boundary",
  "security_or_secret",
  "irreversible_mutation",
  "core_lifecycle_invariant",
]);
export type VerificationUpgradeReason = z.infer<typeof verificationUpgradeReasonSchema>;

export const verificationObligations = [
  "required_ci",
  "required_review_status",
  "cancellation_and_identity_checks",
  "auto_merge_gate",
  "static_or_format",
  "runtime_smoke",
  "targeted_tests",
  "project_quality",
  "fresh_context_review",
  "full_related_tests",
  "negative_tests",
  "exact_readback",
  "crash_retry_idempotency",
] as const;
export type VerificationObligation = (typeof verificationObligations)[number];

export interface VerificationUpgradeRequest {
  readonly level: VerificationLevel;
  readonly reason: VerificationUpgradeReason;
}

export interface VerificationPolicySelection {
  readonly approvedLevel: VerificationLevel;
  readonly effectiveLevel: VerificationLevel;
  readonly reviewerUpgrade?: VerificationUpgradeRequest;
  readonly obligations: readonly VerificationObligation[];
  readonly commands: readonly ProjectCommand[];
}

const rank: Readonly<Record<VerificationLevel, number>> = Object.freeze({
  light: 0,
  standard: 1,
  strict: 2,
});

const commonObligations = [
  "required_ci",
  "required_review_status",
  "cancellation_and_identity_checks",
  "auto_merge_gate",
] as const satisfies readonly VerificationObligation[];

function commandIdentity(command: ProjectCommand): string {
  return JSON.stringify([command.executable, command.arguments]);
}

function uniqueCommands(groups: readonly (readonly ProjectCommand[])[]): readonly ProjectCommand[] {
  const seen = new Set<string>();
  const selected: ProjectCommand[] = [];
  for (const command of groups.flat()) {
    const identity = commandIdentity(command);
    if (seen.has(identity)) continue;
    seen.add(identity);
    selected.push(Object.freeze({ executable: command.executable, arguments: command.arguments }));
  }
  return Object.freeze(selected);
}

export function selectVerificationPolicy(
  input: Readonly<{
    approvedLevel: VerificationLevel;
    trustedConfig: TrustedProjectConfig;
    reviewerUpgrade?: VerificationUpgradeRequest;
  }>,
): Result<VerificationPolicySelection, DomainError<"invariant_violation">> {
  const approved = verificationLevelSchema.safeParse(input.approvedLevel);
  const catalog = verificationCommandCatalogSchema.safeParse(
    input.trustedConfig.commands.verification,
  );
  if (!approved.success || !catalog.success) return err(domainError("invariant_violation"));

  let effectiveLevel = approved.data;
  if (input.reviewerUpgrade !== undefined) {
    const requestedLevel = verificationLevelSchema.safeParse(input.reviewerUpgrade.level);
    const reason = verificationUpgradeReasonSchema.safeParse(input.reviewerUpgrade.reason);
    if (
      !requestedLevel.success ||
      !reason.success ||
      rank[requestedLevel.data] <= rank[approved.data]
    ) {
      return err(domainError("invariant_violation"));
    }
    effectiveLevel = requestedLevel.data;
  }

  const obligations: readonly VerificationObligation[] =
    effectiveLevel === "light"
      ? [...commonObligations, "static_or_format", "runtime_smoke"]
      : effectiveLevel === "standard"
        ? [
            ...commonObligations,
            "static_or_format",
            "runtime_smoke",
            "targeted_tests",
            "project_quality",
            "fresh_context_review",
          ]
        : [
            ...commonObligations,
            "static_or_format",
            "runtime_smoke",
            "targeted_tests",
            "project_quality",
            "fresh_context_review",
            "full_related_tests",
            "negative_tests",
            "exact_readback",
            "crash_retry_idempotency",
          ];

  const commands =
    effectiveLevel === "light"
      ? uniqueCommands([catalog.data.static, catalog.data.smoke])
      : effectiveLevel === "standard"
        ? uniqueCommands([
            catalog.data.static,
            catalog.data.targeted,
            input.trustedConfig.commands.quality,
            catalog.data.smoke,
          ])
        : uniqueCommands([
            catalog.data.static,
            catalog.data.targeted,
            input.trustedConfig.commands.quality,
            catalog.data.full,
            catalog.data.negative,
            catalog.data.smoke,
            catalog.data.readback,
          ]);

  return ok(
    Object.freeze({
      approvedLevel: approved.data,
      effectiveLevel,
      ...(input.reviewerUpgrade === undefined
        ? {}
        : { reviewerUpgrade: Object.freeze({ ...input.reviewerUpgrade }) }),
      obligations: Object.freeze(obligations),
      commands,
    }),
  );
}
