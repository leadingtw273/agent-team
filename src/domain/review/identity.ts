import { z } from "zod";

import { domainError, err, ok, type DomainError, type Result } from "../foundation/index.js";
import type { EffectiveTreeChange } from "./diff.js";
import { createDiffDigest } from "./diff.js";
import { sha256Digest, type Sha256Digest } from "./canonical.js";
import type { RequirementSnapshot } from "./snapshot.js";

declare const headShaBrand: unique symbol;
export type HeadSha = string & { readonly [headShaBrand]: true };

export const headShaSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u) as unknown as z.ZodType<HeadSha>;

export interface CanonicalVisualManifestArtifactInput {
  readonly path: string;
  readonly sha256: string;
  readonly mediaType: string;
  readonly acceptanceCriteria: readonly string[];
}

export interface CanonicalVisualManifestEnvironmentInput {
  readonly runner: string;
  readonly operatingSystem: string;
  readonly applicationVersion?: string;
  readonly viewport?: Readonly<{ width: number; height: number; deviceScaleFactor: number }>;
}

export interface CanonicalVisualManifestInput {
  readonly schemaVersion: number;
  readonly issueId: string;
  readonly commitSha: string;
  readonly environment: CanonicalVisualManifestEnvironmentInput;
  readonly artifacts: readonly CanonicalVisualManifestArtifactInput[];
}

export function canonicalVisualManifest(
  manifest: CanonicalVisualManifestInput,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: manifest.schemaVersion,
    issueId: manifest.issueId,
    commitSha: manifest.commitSha,
    environment: {
      runner: manifest.environment.runner,
      operatingSystem: manifest.environment.operatingSystem,
      ...(manifest.environment.applicationVersion === undefined
        ? {}
        : { applicationVersion: manifest.environment.applicationVersion }),
      ...(manifest.environment.viewport === undefined
        ? {}
        : { viewport: { ...manifest.environment.viewport } }),
    },
    artifacts: [...manifest.artifacts]
      .map((artifact) => ({
        path: artifact.path,
        sha256: artifact.sha256,
        mediaType: artifact.mediaType,
        acceptanceCriteria: [...artifact.acceptanceCriteria].sort(),
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  });
}

export function evidenceDigestOf(
  manifest: CanonicalVisualManifestInput,
): Result<Sha256Digest, DomainError<"invariant_violation">> {
  return sha256Digest(canonicalVisualManifest(manifest));
}

export interface ReviewIdentity {
  readonly requirementsDigest: RequirementSnapshot["requirementsDigest"];
  readonly headSha: HeadSha;
  readonly diffDigest: Sha256Digest;
  readonly evidenceDigest?: Sha256Digest;
  readonly publicationDigest?: Sha256Digest;
}

export function createReviewIdentity(
  snapshot: RequirementSnapshot,
  headShaInput: string,
  changes: readonly EffectiveTreeChange[],
  evidence?: Readonly<{
    visualManifest?: CanonicalVisualManifestInput;
    publicationDigest?: string;
  }>,
): Result<ReviewIdentity, DomainError<"invariant_violation">> {
  const headSha = headShaSchema.safeParse(headShaInput);
  if (!headSha.success) return err(domainError("invariant_violation"));
  const diffDigest = createDiffDigest(changes);
  if (!diffDigest.ok) return diffDigest;
  const evidenceDigest =
    evidence?.visualManifest === undefined ? undefined : evidenceDigestOf(evidence.visualManifest);
  if (evidenceDigest !== undefined && !evidenceDigest.ok) return evidenceDigest;
  if (
    evidence?.publicationDigest !== undefined &&
    !/^[0-9a-f]{64}$/u.test(evidence.publicationDigest)
  ) {
    return err(domainError("invariant_violation"));
  }

  return ok(
    Object.freeze({
      requirementsDigest: snapshot.requirementsDigest,
      headSha: headSha.data,
      diffDigest: diffDigest.value,
      ...(evidenceDigest === undefined ? {} : { evidenceDigest: evidenceDigest.value }),
      ...(evidence?.publicationDigest === undefined
        ? {}
        : { publicationDigest: evidence.publicationDigest as Sha256Digest }),
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
    approved.diffDigest !== current.diffDigest ||
    approved.evidenceDigest !== current.evidenceDigest ||
    approved.publicationDigest !== current.publicationDigest
  ) {
    return "full_review";
  }
  return approved.headSha === current.headSha ? "unchanged" : "ci_revalidation";
}
