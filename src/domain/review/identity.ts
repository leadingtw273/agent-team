import { z } from "zod";

import { domainError, err, ok, type DomainError, type Result } from "../foundation/index.js";
import type { EffectiveTreeChange } from "./diff.js";
import { createDiffDigest } from "./diff.js";
import type { Sha256Digest } from "./canonical.js";
import type { RequirementSnapshot } from "./snapshot.js";

declare const headShaBrand: unique symbol;
export type HeadSha = string & { readonly [headShaBrand]: true };

export const headShaSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u) as unknown as z.ZodType<HeadSha>;

export interface ReviewIdentity {
  readonly requirementsDigest: RequirementSnapshot["requirementsDigest"];
  readonly headSha: HeadSha;
  readonly diffDigest: Sha256Digest;
}

export function createReviewIdentity(
  snapshot: RequirementSnapshot,
  headShaInput: string,
  changes: readonly EffectiveTreeChange[],
): Result<ReviewIdentity, DomainError<"invariant_violation">> {
  const headSha = headShaSchema.safeParse(headShaInput);
  if (!headSha.success) return err(domainError("invariant_violation"));
  const diffDigest = createDiffDigest(changes);
  if (!diffDigest.ok) return diffDigest;

  return ok(
    Object.freeze({
      requirementsDigest: snapshot.requirementsDigest,
      headSha: headSha.data,
      diffDigest: diffDigest.value,
    }),
  );
}

export type ReviewReuseDecision = "unchanged" | "ci_revalidation" | "full_review";

export function compareReviewIdentity(
  approved: ReviewIdentity,
  current: ReviewIdentity,
): ReviewReuseDecision {
  if (
    approved.requirementsDigest !== current.requirementsDigest ||
    approved.diffDigest !== current.diffDigest
  ) {
    return "full_review";
  }
  return approved.headSha === current.headSha ? "unchanged" : "ci_revalidation";
}
