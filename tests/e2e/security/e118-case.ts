/**
 * E118: the closed vocabulary shared by every E118 injection-defense test (this ticket, E118a --
 * deterministic-only) and the later live canary smoke (E118b). This module owns no I/O and no
 * scanning logic (that is `e118-validator.ts`); it only defines *what a case looks like* -- the
 * marker a run must never leak, the fake credential shapes it must never leak, which sinks a
 * case's untrusted content is allowed to ever reach (in redacted, boundary-wrapped form) versus
 * which sinks must never carry any trace of it at all, and the run identity E118b will bind a live
 * run's real artifacts to.
 *
 * Per the task's own decision: the two real, already-wired external-data entry points are
 * reviewer findings and CI check logs (`reviewFindingsExternalData` / `ciFailureLogExternalData`,
 * both under `src/application/pipelines/`) -- both flow through `buildProviderJobContext`'s
 * `=== BEGIN/END EXTERNAL DATA ===` boundary and the shared `Redactor` before a model ever sees
 * them. Linear/GitHub issue title and description are the trusted, already-adjudicated
 * requirement -- never modeled here as an injection vector.
 */
import { z } from "zod";

/**
 * The closed set of destinations an E118 case's untrusted content might end up written to.
 * Deliberately named after concrete system concepts, not generic "sink1/sink2" labels, so a
 * finding's `sinkKind` alone tells a reader exactly which real destination it describes:
 *
 * - `linear_comment` -- a comment this run posts back to the Linear issue.
 * - `github_pr_body` -- the pull request's own body/description text.
 * - `github_pr_comment` -- a comment this run posts on the pull request.
 * - `provider_job_progress` -- the durable `JobProgressRecord` persisted for this job
 *   (`src/adapters/dispatch/job-progress-store.ts`).
 * - `provider_job_event` -- a `ProviderEvent` this run emits (`src/application/ports/provider.ts`),
 *   e.g. `output`/`tool_request`/`checkpoint` -- anything a caller could observe off the event
 *   stream or persist verbatim.
 * - `worktree_external_sentinel` -- the tracked content actually written into the git worktree
 *   (diffed file contents), i.e. whatever the provider's own edits produced on disk, outside the
 *   provider-context boundary entirely.
 */
export const e118SinkKinds = [
  "linear_comment",
  "github_pr_body",
  "github_pr_comment",
  "provider_job_progress",
  "provider_job_event",
  "worktree_external_sentinel",
] as const;
export type E118SinkKind = (typeof e118SinkKinds)[number];

export const e118SinkKindSchema = z.enum(e118SinkKinds);

/** One piece of already-produced sink content, as `e118-validator.ts` scans it. Never a live
 * fetch -- this is always a plain string a caller (a deterministic test in this ticket, or a live
 * collector in E118b) already has in hand. `sinkId` disambiguates multiple instances of the same
 * `kind` (e.g. two PR comments) in one scan's findings; it is opaque and never itself scanned. */
export const e118SinkSchema = z
  .object({
    kind: e118SinkKindSchema,
    sinkId: z.string().trim().min(1).max(255),
    content: z.string().max(4 * 1024 * 1024),
  })
  .strict();
export type E118Sink = z.infer<typeof e118SinkSchema>;

/** Binds an E118 case to the real run it describes, for E118b to attach live artifacts to. Kept
 * separate from `E118InjectionCase` below (mirrors E007's `EvidenceValidationExpectation` vs.
 * `EvidenceCaseDescription` split) so a deterministic case can exist -- and be unit-tested -- with
 * no live run behind it at all, which is exactly this ticket's (E118a's) situation. */
export const e118RunIdentitySchema = z
  .object({
    caseId: z.string().trim().min(1).max(64),
    runId: z.string().trim().min(1).max(128),
    jobId: z.string().trim().min(1).max(128),
    issueId: z.string().trim().min(1).max(128),
  })
  .strict();
export type E118RunIdentity = z.infer<typeof e118RunIdentitySchema>;

const canarySchema = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[0-9a-zA-Z-]+$/u, "canary must be a plain, URL-safe token (no whitespace/JSON syntax)");

const fakeTokenSchema = z.string().trim().min(8).max(512);

/**
 * What one E118 case declares before any scan runs: the exact marker (`canary`) and fake
 * credential literals (`fakeTokens`) this run's untrusted content carries, and which sinks
 * (`e118SinkKinds`) that content may legitimately reach at all versus must never reach in any
 * form. `allowedSinkKinds` and `deniedSinkKinds` are deliberately disjoint (enforced below) --
 * every named sink kind is one or the other, never both, for a given case; a sink kind naming
 * neither is simply out of scope for that case (e.g. a case with no PR yet omits the PR kinds
 * from both lists).
 */
export const e118InjectionCaseSchema = z
  .object({
    runIdentity: e118RunIdentitySchema,
    canary: canarySchema,
    fakeTokens: z.array(fakeTokenSchema).min(1).max(16),
    allowedSinkKinds: z.array(e118SinkKindSchema).max(e118SinkKinds.length),
    deniedSinkKinds: z.array(e118SinkKindSchema).max(e118SinkKinds.length),
  })
  .strict()
  .superRefine((candidate, context) => {
    const allowed = new Set(candidate.allowedSinkKinds);
    const overlap = candidate.deniedSinkKinds.filter((kind) => allowed.has(kind));
    if (overlap.length > 0) {
      context.addIssue({
        code: "custom",
        message: `allowedSinkKinds and deniedSinkKinds must be disjoint; overlap: ${overlap.join(", ")}`,
        path: ["deniedSinkKinds"],
      });
    }
    if (new Set(candidate.fakeTokens).size !== candidate.fakeTokens.length) {
      context.addIssue({
        code: "custom",
        message: "fakeTokens must not contain a duplicate literal.",
        path: ["fakeTokens"],
      });
    }
    if (candidate.fakeTokens.includes(candidate.canary)) {
      context.addIssue({
        code: "custom",
        message: "canary must be a distinct marker from every fakeToken literal.",
        path: ["canary"],
      });
    }
  });
export type E118InjectionCase = z.infer<typeof e118InjectionCaseSchema>;
