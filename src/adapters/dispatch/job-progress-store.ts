/**
 * C015c item 1: durable, per-job CAS progress index for the CLI's own dispatch-run scheduling --
 * approved by the decision layer after an escalation confirmed `Job` (src/domain/jobs/schema.ts)
 * carries no lifecycle/state field at all, and F004's `WorkStatus` (src/domain/workflow/) governs
 * the Linear *Issue*, not `Job`. This store is a host-connection-layer concern, deliberately kept
 * out of `src/domain` and `src/application` -- the same precedent as O005's setup-session journal
 * and O006's probe journal (`src/adapters/registration/proactive-probe-journal.ts`), both of which
 * also keep "where did this multi-step host operation get to" entirely in adapters.
 *
 * **`stage` is not F004's `WorkStatus`, and the two must never be conflated.** `WorkStatus`
 * (backlog/ready/in_progress/in_review/completed/canceled) is the Linear issue's own state
 * machine, transitioned only through `transitionWorkStatus`/`WorkManagementPort.setWorkStatus`.
 * `JobProgressStage` below is a CLI-internal scheduling label with no engine meaning whatsoever --
 * it exists solely so a later `agent-team run` invocation (a fresh process) can find "which of my
 * own jobs got how far" without any engine changes. Do not add a case to this union expecting it
 * to influence, or be influenced by, `WorkStatus` transitions.
 *
 * File shape mirrors `FileRegistrationProbeJournalStore` exactly: one JSON file per job id
 * (`${jobId}.json`), a sibling `.lock` file guarded by a recoverable kernel-held lock
 * (`acquireRecoverableFileLock`), an explicit numeric `revision` for optimistic CAS
 * (`compareAndSwap(jobId, expectedRevision, mutation)` -- `expectedRevision: null` means "must not
 * exist yet"), and `writeJsonWithSchema`'s mandatory read-back before a write is trusted.
 *
 * `changeRequestId` is the decimal PR number as a **string** -- O009c's own lesson, restated here
 * because it is exactly the kind of value a naive implementation gets wrong twice: GitHub's
 * `ChangeRequestSnapshot.id` is an opaque GraphQL node id, *not* the same value
 * `ChangeRequestRef.changeRequestId` (a decimal string) expects. Storing the node id here would
 * make every future resume attempt fail to look the PR back up.
 */
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

import type { ReadOptions } from "../../application/ports/index.js";
import {
  createClock,
  domainError,
  err,
  ok,
  parseIdentifier,
  canonicalInstantPattern,
  parseInstant,
  type Clock,
  type DomainError,
  type Instant,
  type Result,
} from "../../domain/foundation/index.js";
import { checkpointIdSchema } from "../../domain/checkpoint/index.js";
import {
  issueIdSchema,
  jobIdSchema,
  leaseIdSchema,
  projectIdSchema,
} from "../../domain/jobs/index.js";
import { headShaSchema } from "../../domain/review/index.js";
import { reportContractFailureCategorySchema } from "../../application/pipelines/reviewer-model.js";
import {
  AtomicFileStore,
  acquireRecoverableFileLock,
  readJsonWithSchema,
  writeJsonWithSchema,
} from "../../infrastructure/files/index.js";

const instantSchema = z
  .string()
  .regex(canonicalInstantPattern)
  .refine((value) => parseInstant(value).ok) as unknown as z.ZodType<Instant>;

/** Decimal PR number, never the opaque GitHub node id -- see this file's own header (O009c). */
const changeRequestNumberSchema = z.string().regex(/^\d+$/u).max(20);

/** Bounded, structural cap only -- the *policy* cap (2 attempts, decision 2's
 * `reviewProviderRetries`/`ciProviderRetries`) is enforced by resume-composition.ts before it ever
 * writes a record with this stage; this schema-level bound exists only to keep the field itself
 * sane (never negative, never absurdly large) regardless of caller bugs. */
const providerRetryCountSchema = z.number().int().min(0).max(100);
/** The `DomainError.code` string that caused this retry -- purely for a human/log to read (see
 * this store's own header: `stage` carries no engine meaning). Not re-validated against
 * `DomainErrorCode`'s fixed enum here deliberately -- this file must never need to import that
 * enum just to stay in sync with it; resume-composition.ts is what decides whether a code is
 * `retryable` before ever reaching this stage at all. */
const lastErrorCodeSchema = z.string().trim().min(1).max(64);
const reviewBindingDigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);

/**
 * C016 fix: mirrors `ImplementerPipelineOutcome`'s own `paused` `reason` union
 * (application/pipelines/implementer-model.ts) *by value*, not by import -- same rationale as
 * `lastErrorCodeSchema` right above: this adapter file must never need to import the application
 * layer's union just to stay in sync with it. Optional on the stage below for two independent
 * reasons: (1) `resume-composition.ts`'s own two `"checkpointed"` transitions (CiRecoveryPipeline/
 * ReviewerPipeline) write this same `paused` stage with no comparable "reason" concept at all --
 * that outcome is `state:"checkpointed"`, a different shape from `ImplementerPipelineOutcome`'s
 * `state:"paused"` entirely, and always has been; (2) every `paused` record ever written before
 * this ticket has no such field at all and must keep reading back successfully (this ticket, like
 * every prior one touching this store, is forbidden from editing or migrating any existing file
 * under `~/.agent-team/state`). */
const pauseReasonSchema = z.enum([
  "scope_overrun",
  "safety_approval_required",
  "provider_interrupted",
  "no_changes",
]);

/**
 * C015r decision 1: `requires_manual` used to be the bare `{kind:"requires_manual"}` below --
 * C015q's diagnosis (`/home/markchou/.claude/jobs/6152588f/tmp/c015q-diagnose.md`, item 5) proved
 * this loses every diagnostic signal the instant a job lands there: the only place the *reason* ever
 * existed was one `agent-team run` invocation's own ephemeral stdout JSON, gone the moment that
 * process exits. `cause` closes that gap with a small, closed classification -- `stage` (which part
 * of the resume pipeline failed) + `reasonCode` (a fixed enum covering every `requiresManual(...)`
 * call site in resume-composition.ts) + `attempts` (how many tries happened before landing here, and
 * -- only when relevant -- the last report-contract failure category). This is the prerequisite
 * codex's C015q review named for ever safely requeuing a `requires_manual` job: without it, an
 * operator (or a future `dispatch requeue`, deferred to its own ticket) has no durable way to tell
 * "this was a report-contract hiccup, safe to retry" apart from "the PR state itself diverged,
 * retrying would be dangerous."
 *
 * `cause` is deliberately **optional** on the schema (not a breaking migration): job-progress
 * records written before this ticket (bare `{kind:"requires_manual"}`, no `cause` at all) must keep
 * reading back successfully -- this ticket is explicitly forbidden from editing or migrating any
 * existing file under `~/.agent-team/state`. Every *new* write from resume-composition.ts always
 * populates it; only pre-existing, un-migrated records will ever have it absent.
 *
 * `cause` never carries the provider's raw output text anywhere, on any field -- every value here is
 * one of this file's own closed enums or a bounded integer, by construction (see decision 1's own
 * explicit "不得存 provider 原始文字" requirement).
 */
/**
 * C018 fix: `"dispatch"` is this enum's fifth member -- deliberately distinct from `"setup"`
 * despite the surface-level similarity ("pre-pipeline reads/validation that failed"). `"setup"`
 * (and `"ci_recovery"`/`"review"`/`"merge"`) are exclusively resume-composition.ts's own vocabulary
 * for phases of *resuming* an already-`ci_waiting`-or-later job in a fresh process; every one of
 * this file's existing `requiresManualCause` call sites (grep confirms) is in that one file.
 * `"dispatch"` instead names handlers.ts's own fresh-dispatch attempt (`case "dispatched"` in
 * `createDispatchCliHandlers`'s `run` handler) -- the phase *before* any resume cycle could ever
 * exist, where a real `Job`+`Lease`+admission claim (with `jobId` already attached, per
 * `dispatchOnce`'s `attachJob` call, composition.ts) already exist, but the `ImplementerPipeline`
 * itself either never got invoked at all (composition/base/worktree/request-building failed first)
 * or ran and returned `state:"failed"`. Conflating the two would make a human reading a
 * `requires_manual` record's `cause.stage` guess wrong about which file/code path to go look at.
 */
export const requiresManualStageSchema = z.enum([
  "setup",
  "ci_recovery",
  "review",
  "merge",
  "dispatch",
]);
export type RequiresManualStage = z.infer<typeof requiresManualStageSchema>;

export const requiresManualReasonCodeSchema = z.enum([
  // setup: shared pre-dispatch reads/validation before either CI-recovery or review begins.
  "change_request_unavailable",
  "job_unavailable",
  "requirement_snapshot_unavailable",
  "base_revision_unavailable",
  "invalid_deadline",
  "invalid_head_sha",
  "invalid_checkpoint_id",
  // C015z decision (Q3, replacing C015y decision A's `legacy_base_revision_mismatch`): a *legacy*
  // (pre-C015y) record has no persisted `baseRevision`, and there is no safe way to reconstruct
  // what the original dispatch actually used -- the prior repair heuristic cross-checked a freshly
  // re-resolved *live* base tip against the PR's own frozen `.base.sha` (see that field's corrected
  // header, source-control.ts) on the false premise that the two describe the same thing; they
  // structurally diverge the instant the base branch advances past PR-creation time, which is
  // exactly the situation the repair path existed to handle. `resolveLegacyBaseRevision`
  // (resume-composition.ts) therefore never attempts recovery any more -- every legacy record
  // fails closed to this reasonCode unconditionally, carrying the fresh PR readback's own evidence
  // for a human to act on via `agent-team dispatch resolve`. Removed (never written again):
  // `legacy_base_revision_mismatch` -- confirmed absent from every record on disk as of this
  // ticket, safe to drop from the enum outright rather than keep as a dead, unreachable case.
  "legacy_base_revision_unrecoverable",
  /** Pre-ADR-009 records did not persist which Provider/model owned execution and review. */
  "legacy_provider_assignment_unavailable",
  // ci_recovery
  "ci_recovery_paused",
  "ci_recovery_failed",
  // review
  "review_begin_failed",
  "review_reuse_unimplemented",
  "review_paused",
  "review_provider_failed",
  // C015r decision 4: the one reasonCode that always pairs with `attempts.lastCategory` -- a
  // `report`-stage failure that exhausted the dedicated, capped report-contract retry.
  "review_report_contract",
  "review_record_failed",
  "review_not_approved",
  // C031: a non-draft PR's failed CI has no automatic repair path, so fail closed rather than
  // share draft PRs' `ci_waiting` retry semantics and loop indefinitely.
  "ci_failed_after_ready",
  // E102-3: a `visual_review`/`dual_review` job reached `resumeReview` (resume-composition.ts)
  // while either `deps.visualEvidence` itself was never wired (composition-root gap, not this
  // job's fault) or the project's own `commands.visualReview` is empty (`validReviewerRequest`,
  // reviewer-policy.ts, would fail this same job on that exact condition regardless -- this
  // reasonCode surfaces the *specific* reason before ever calling `reviewer.run()` at all, rather
  // than a generic `invariant_violation` from deep inside that pipeline), or the Visual Evidence
  // Builder itself returned a failure (bad/missing trusted command, ungitignored evidence
  // directory, corrupt artifact, ...). Never auto-retried -- every one of these needs a human or
  // an operator config fix, not a resume-cycle retry.
  "visual_evidence_unavailable",
  // E102-5: the visual evidence `built` above did produce a valid manifest, but publishing it (plus
  // its PNG artifacts) to Linear -- via `LinearVisualPublicationCoordinator.publish()`
  // (linear-publication.ts), the required gate before `reviewer.run()` may ever be called for a
  // `visual_review`/`dual_review` job -- itself failed *before* any Linear-side write succeeded
  // (invalid request, receipt-store read failure, a stale/mismatched pre-existing receipt, an
  // artifact that no longer matches its recorded hash, or the upload/comment call itself failing).
  // Also written when `deps.linearPublication` was never wired at all -- the composition-root gap
  // symmetric to `visual_evidence_unavailable` above. Never auto-retried, same as that reasonCode.
  "visual_publication_failed",
  // E102-5: the publish attempt's failure happened *after* at least one artifact (or the manifest
  // summary comment) already durably exists on Linear -- an orphan by `linear-publication.ts`'s own
  // definition (its header's "Orphan-asset contract"). Deliberately a distinct reasonCode from
  // `visual_publication_failed` above so an operator can find and reconcile the orphaned Linear
  // asset/comment specifically, rather than conflating it with a failure that created nothing.
  "visual_publication_orphan",
  "auto_merge_not_enabled",
  // merge
  "work_item_status_unavailable",
  "work_item_canceled",
  "cancellation_after_merge",
  "lifecycle_not_completed",
  // E102-4b: `resumeReview`'s own pre-arm merge recheck (immediately before
  // `AutoMergeGate.enable()`, resume-composition.ts) could not obtain a currently-valid
  // `VisualManifest` for a `dual_review`/`visual_review` job -- either `deps.visualEvidence` itself
  // (or its own `verifyExisting` method) was never wired (composition-root gap, symmetric to
  // `visual_evidence_unavailable`'s own review-time reasonCode above), or `verifyExisting` itself
  // returned a concrete failure (the evidence directory is missing, an artifact no longer hashes to
  // its recorded value, the manifest is corrupt/schema-invalid, or its issue/headSha identity no
  // longer matches). Deliberately never auto-retried, and deliberately never routed through
  // `AutoMergeGate.enable()` at all -- see `VisualEvidenceBuilder.verifyExisting`'s own header
  // (visual-evidence-builder.ts) for why this recheck never falls back to `build()`.
  "visual_evidence_missing_at_merge",
  // E102-4b: symmetric to `visual_evidence_missing_at_merge` above, but for the Linear publication
  // receipt side of the same pre-arm recheck -- either `deps.linearPublicationStore` was never
  // wired, or `FileLinearPublicationStore.load()` found no receipt (or a load failure) for this
  // exact (projectId, issueId, headSha).
  "visual_publication_missing_at_merge",
  // E102-4b: `AutoMergeGate.enable()` returned `"evidence_drift_detected"` -- the freshly
  // re-verified `VisualManifest` at this *identical* commit hashes differently from the one the
  // recorded approval was actually reviewed against. Never auto-retried and never treated as
  // `auto_merge_not_enabled`/`re_review_required` -- see that outcome's own header
  // (merge-gate-model.ts) for why this is a distinct, always-human-routed safety event.
  "evidence_drift_detected",
  // E102-4b: symmetric to `evidence_drift_detected` above, for the Linear publication receipt.
  "publication_drift_detected",
  // C015x decision 3: the change request's own authoritative `mergeStateStatus` reads `"behind"` --
  // GitHub's own `strict` required-status-checks ruleset policy (O004) means this can never
  // actually execute the merge no matter how long a job sits in `"merging"`; escalates immediately,
  // never waits for `mergingNoProgressLimit` (resume-composition.ts).
  "change_request_behind_base",
  // C015x decision 3: `mergingNoProgressLimit` consecutive resumes observed the exact same
  // authoritative readback fingerprint (head SHA, base SHA, mergeable state, merged) -- auto-merge
  // was enabled, but GitHub has not moved the PR forward at all across every one of those resumes.
  // C015y decision C: this reasonCode is now reached by *either* half of a two-layer wall-clock
  // rule (see `resumeMergingStage`'s own header, resume-composition.ts) -- the `ResumeJobOutcome`'s
  // own `reason` string (never this persisted enum) distinguishes which half fired, for a
  // human/log reading it.
  "auto_merge_stalled",
  // C015y decision C: `mergeStateStatus` has read `"unknown"` on every one of at least
  // `mergeStateUnknownMinReadbacks` consecutive *fresh* readbacks, spanning at least
  // `mergeStateUnknownWallClockMs` wall-clock -- GitHub's own "still computing" transient must not
  // be allowed to stall this job forever just because it never happens to resolve to a concrete
  // state. Deliberately independent of `auto_merge_stalled` above (that reasonCode's own
  // `noProgressCount`/wall-clock tracking never even advances while `mergeStateStatus` is
  // `"unknown"` -- see this file's own `merging` stage schema comment on `unknownSince`/
  // `unknownCount`). The 30-minute absolute deadline (`auto_merge_stalled`'s own second OR-branch)
  // still applies independently and unconditionally even while this is flapping.
  "merge_state_unknown_timeout",
  // E116cap: `AutoMergeGate.enable()` found the project's persisted auto-merge pause flag set
  // (`FileAutoMergePauseStore`, auto-merge-pause-store.ts) -- a prior out-of-process merge on this
  // project quarantined it against arming any *new* auto-merge until a human resolves it
  // (`FileAutoMergePauseStore.resolve`). Never auto-cleared by a resume; see
  // `resumeUnderLease`'s own `case "auto_merge_paused":` (resume-composition.ts) for why this is
  // deliberately never treated as a wait-and-retry condition like `ci_pending` is.
  "auto_merge_paused_out_of_process_merge",
  // C018 fix: `stage:"dispatch"` reasonCodes -- every one of handlers.ts's own fresh-dispatch
  // exits that used to `return` after the admission claim (and real `Job`/`Lease`) already
  // existed, with no job-progress record left behind for `dispatch resolve` to ever find (see
  // this file's own `requiresManualStageSchema` comment on why these are a distinct `stage` from
  // resume-composition.ts's `"setup"`). `"implementer_request_invalid"` covers *both* of
  // handlers.ts's two distinct checks that already shared this exact string as their CLI-JSON
  // `pipelineReason` before this ticket (the eligible-candidate/model lookup coming back
  // undefined, and `buildImplementerPipelineRequest` itself returning an error) -- both describe
  // the identical situation from a human's perspective: "this job's `ImplementerPipelineRequest`
  // could never be built," so one reasonCode for both is not a new conflation, it mirrors a
  // conflation the CLI-JSON output already had.
  "implementer_request_invalid",
  "implementer_composition_blocked",
  "authoritative_base_unavailable",
  "worktree_directory_unavailable",
  // The pipeline was genuinely invoked and itself returned `state:"failed"` -- distinct from every
  // reasonCode above, which all fire *before* `pipelineComposition.value.run()` is ever called.
  "implementer_pipeline_failed",
  // Symmetric to the pre-existing `"invalid_head_sha"`/`"invalid_checkpoint_id"` above (reused
  // here under `stage:"dispatch"` rather than duplicated -- both already mean exactly "this
  // process's own internal invariant on a SHA-shaped field was violated," and `cause.stage`
  // disambiguates which phase found it): `resolveAuthoritativeBaseRevision`'s own contract
  // guarantees a real git SHA, so `headShaSchema.safeParse(authoritativeBase.value.baseRevision)`
  // failing is, like those two, never expected outside an injected test fake -- but the same
  // "claim already active, so still leave a resolvable record" discipline applies.
  "invalid_base_revision",
  // C019 fix (item 1): handlers.ts's own dispatched-but-non-implementer-role exit (the "10th
  // exit" -- `result.decision.candidate.role !== "implementer"`) used to `return` a `success`
  // CLI payload with zero store writes, even though `dispatchOnce`'s own `attachJob` call and the
  // per-issue admission claim are both already real and active by that point -- the same
  // LEA-16-shaped silent-claim leak every other `stage:"dispatch"` reasonCode above exists to
  // close, just reachable through a role this file's own scope boundary (C015b item 5) never
  // builds a pipeline for at all. Deliberately its own reasonCode, not reused from
  // `implementer_request_invalid` or any other above: nothing here failed, so conflating it with
  // an actual failure reasonCode would mislead whoever reads this record later via `dispatch
  // resolve`.
  "role_pipeline_unavailable",
  "protected_region_requires_human",
]);
export type RequiresManualReasonCode = z.infer<typeof requiresManualReasonCodeSchema>;

/**
 * C015x decision 3: the persisted, restart-safe snapshot of the last authoritative GitHub readback
 * a `"merging"` job observed -- `mergeStateStatus` is deliberately a loosely-validated bounded
 * string, not a re-declared strict enum, for exactly the reason `lastErrorCodeSchema`'s own comment
 * above gives for `DomainError.code`: this file must never need to import
 * `ChangeRequestSnapshot["mergeStateStatus"]`'s enum just to stay in sync with it. `headSha` is the
 * change request's own head SHA on `ChangeRequestSnapshot` -- an unbranded plain `string` there
 * (unlike this file's own top-level `JobProgressRecord.headSha`, which reuses the branded
 * `headShaSchema`) -- so this reuses the same hex-hash shape without the brand, avoiding a
 * pointless parse-or-throw just to satisfy a nominal type this fingerprint has no other use for.
 *
 * C015z decision (Q4): `baseSha` is deliberately **not** part of the no-progress comparison any
 * more -- `mergeFingerprintOf`/`mergeFingerprintsEqual` (resume-composition.ts) no longer read it
 * at all. GitHub's `.base.sha` is a value frozen at PR-creation time (see
 * `ChangeRequestSnapshot.baseSha`'s corrected header, source-control.ts), not a live signal of
 * anything changing -- keeping it in the equality check gave it zero discriminating power for
 * "did the merge make progress" while still being real evidence worth recording on a
 * `requires_manual` cause (`mergeEvidence` below may still carry it). Optional here purely so a
 * record written by C015x/C015y (which always populated it) still reads back successfully; a
 * *new* write from this ticket onward never includes it, and no code compares it. */
const mergeReadbackFingerprintSchema = z
  .object({
    headSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
    baseSha: z.string().max(128).optional(),
    mergeStateStatus: z.string().trim().min(1).max(32),
    merged: z.boolean(),
  })
  .strict();
export type MergeReadbackFingerprint = z.infer<typeof mergeReadbackFingerprintSchema>;

/** C015y decision C: the wall-clock evidence codex's review named as missing from every
 * `"merging"`-stage `requires_manual` escalation -- `armedAt`/`lastProgressAt`/`observedAt`/
 * `elapsedMs` (the exact four fields the ticket text specifies), so a human reading a stalled job's
 * `cause` can see *how long* it has actually been stuck, not just an invocation count.
 * `lastProgressAt` is optional here for the one legitimate case where it genuinely never existed:
 * a job escalating on the 30-minute absolute deadline before any concrete (non-`"unknown"`)
 * fingerprint was ever observed at all. `elapsedMs` is always measured from `armedAt` to
 * `observedAt` -- the one wall-clock quantity that is unambiguous regardless of which of the two
 * OR-branches fired. */
const requiresManualStallTimingSchema = z
  .object({
    armedAt: instantSchema,
    lastProgressAt: instantSchema.optional(),
    observedAt: instantSchema,
    elapsedMs: z.number().int().nonnegative(),
  })
  .strict();
export type RequiresManualStallTiming = z.infer<typeof requiresManualStallTimingSchema>;

export const requiresManualCauseSchema = z
  .object({
    stage: requiresManualStageSchema,
    reasonCode: requiresManualReasonCodeSchema,
    attempts: z
      .object({
        count: z.number().int().min(1).max(1_000),
        lastCategory: reportContractFailureCategorySchema.optional(),
      })
      .strict(),
    // C015x decision 3: populated for the merge-stage reasonCodes that ticket (and C015y) add
    // (`change_request_behind_base`/`auto_merge_stalled`/`merge_state_unknown_timeout`) -- the
    // coordinator's explicit "保留當時 head/base SHA 與狀態證據於 cause" requirement. C015z decision
    // (Q3) reuses this same evidence slot for `legacy_base_revision_unrecoverable` (a `setup`-stage
    // reasonCode) -- the fresh PR readback's head/base SHA and merge state at the moment a legacy
    // record was found unrecoverable, for whoever runs `dispatch resolve` to act on. Optional for
    // every other reasonCode and for every pre-existing, un-migrated `cause` record (same
    // backward-compatibility rationale as `cause` itself being optional on the stage below -- see
    // this file's own header comment).
    mergeEvidence: mergeReadbackFingerprintSchema.optional(),
    // C015y decision C: populated only for `auto_merge_stalled`/`merge_state_unknown_timeout` --
    // see `requiresManualStallTimingSchema`'s own header. Optional for the same reason
    // `mergeEvidence` above is: every other reasonCode, and every pre-existing record written
    // before this ticket, never has it.
    stallTiming: requiresManualStallTimingSchema.optional(),
  })
  .strict();
export type RequiresManualCause = z.infer<typeof requiresManualCauseSchema>;

export const jobProgressStageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("implementing") }).strict(),
  z.object({ kind: z.literal("ci_waiting") }).strict(),
  z.object({ kind: z.literal("awaiting_review") }).strict(),
  z
    .object({
      kind: z.literal("reviewer_waiting"),
      reason: z.enum(["confirmed_quota_wall", "unconfirmed_throttling"]),
      confidence: z.enum(["confirmed", "unconfirmed"]),
      bucket: z.enum(["weekly", "five_hour", "model_weekly"]).optional(),
      resetAt: instantSchema.optional(),
      retryNotBefore: instantSchema.optional(),
      binding: z
        .object({
          requirementsDigest: reviewBindingDigestSchema,
          headSha: headShaSchema,
          diffDigest: reviewBindingDigestSchema,
        })
        .strict(),
      publication: z.enum(["pending", "confirmed"]),
    })
    .strict(),
  z.object({ kind: z.literal("fix_round") }).strict(),
  // C015x decision 3: previously the bare `{kind:"merging"}` below -- the coordinator's own
  // diagnosis (this ticket) named this as having *zero* bound on how long a job may sit being
  // resumed as `still_merging`: no retry count, no timestamp, nothing. `armedAt`/`fingerprint`/
  // `noProgressCount` are all **optional**, for the exact same backward-compatibility reason
  // `requires_manual`'s own `cause` field is optional (see this file's own header) -- this ticket
  // is explicitly forbidden from editing or migrating any existing file under
  // `~/.agent-team/state`, and a real, currently-stuck `"merging"` job-progress record already
  // exists on disk with none of these fields. `resumeMergingStage` (resume-composition.ts) treats
  // an absent `fingerprint` as "first observation since C015x", never as "zero prior progress" --
  // it seeds a fresh baseline on that first read rather than guessing at history it never recorded.
  z
    .object({
      kind: z.literal("merging"),
      armedAt: instantSchema.optional(),
      fingerprint: mergeReadbackFingerprintSchema.optional(),
      noProgressCount: z.number().int().min(0).max(1_000).optional(),
      // C015y decision C: the wall-clock half of the bounded wait `armedAt` alone never actually
      // gated (codex's review confirmed this was always the original, half-implemented
      // requirement) -- updated *only* when the observed fingerprint changes substantively; never
      // touched by re-persisting an unchanged fingerprint, and never touched while
      // `mergeStateStatus` reads `"unknown"` (see `unknownSince`/`unknownCount` below for that
      // separate machinery). Optional for the same backward-compatibility reason every other field
      // on this stage is.
      lastProgressAt: instantSchema.optional(),
      // C015y decision C: tracks a currently-in-progress streak of consecutive *fresh* `"unknown"`
      // `mergeStateStatus` readings -- deliberately independent of `noProgressCount`/
      // `lastProgressAt` above (an `"unknown"` reading means GitHub is still computing, which is
      // neither evidence of progress nor of no-progress on the underlying merge itself).
      // `unknownSince` is when the *current* unknown streak began; `unknownCount` is how many
      // consecutive fresh readbacks it has spanned. Both are cleared (not merely zeroed) the
      // moment a non-`"unknown"` reading is observed again -- see `resumeMergingStage`'s own
      // header, resume-composition.ts.
      unknownSince: instantSchema.optional(),
      unknownCount: z.number().int().min(0).max(1_000).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("completed") }).strict(),
  z.object({ kind: z.literal("failed") }).strict(),
  // References a real domain Checkpoint (src/domain/checkpoint/) -- checkpoint's own paused/
  // human-handoff semantics are unchanged; this is only a pointer so a resume attempt knows one
  // exists, per the decision layer's "進度檔與 checkpoint 並存不互斥" instruction.
  //
  // C016 fix: `checkpointId` used to be required here -- correct for `resume-composition.ts`'s
  // own two `"checkpointed"` transitions (which always have one), but wrong for the case this
  // ticket closes: `handlers.ts`'s dispatch-time write of `ImplementerPipelineOutcome`'s own
  // `state:"paused"` (`reason: "safety_approval_required"|"provider_interrupted"|"no_changes"`)
  // explicitly may have *no* checkpoint at all -- only `"scope_overrun"` (via
  // `ImplementerPreflightPort`) ever captures one. Making it optional is exactly why `pauseReason`
  // exists right above: without it, a human reading this record back would have no way to tell
  // "no checkpoint because none was ever taken" apart from "a checkpoint write silently failed."
  //
  // Codex's own corrected framing of the invariant this write establishes (see this ticket's own
  // packet): **not** "every active admission claim has a job-progress record" -- claim writes
  // happen before the job (and its progress record) even exists, and `attachJob`
  // (issue-admission-store.ts) is itself best-effort, a disclosed crash window that this ticket
  // does not (and cannot) close. The actual invariant (as of C016) was narrower and absolute:
  // *every `paused` pipeline outcome this process itself produces must be durably persisted here
  // before the handler that produced it ever returns to its caller* -- see `handlers.ts`'s own
  // comment on its `state === "paused"` write for why (the durable-claim `dispatch resolve` escape
  // hatch is useless against a job it can never find).
  //
  // C018 fix: generalizes C016's invariant to every outcome, not just `paused` -- *once a job's
  // admission claim has `jobId` attached (`attachJob`, issue-admission-store.ts, called before
  // `dispatchOnce` ever returns `kind:"dispatched"`), every `agent-team run` code path that can
  // still return for that job must, before returning, either durably persist a job-progress
  // record `dispatch resolve` can find and act on, or -- never applicable to any code past this
  // point, since `jobId` is already attached -- release the claim directly.* C016 only closed the
  // gap for the one outcome shape (`paused`) the real incident that ticket investigated happened
  // to hit; C018 closes every other `return` in `handlers.ts`'s `case "dispatched"` block that
  // used to leave the claim with nothing to resolve against (`requires_manual`, `stage:"dispatch"`
  // above, is what those exits now write -- see `handlers.ts`'s own header comment on this same
  // invariant for the full enumerated list).
  z
    .object({
      kind: z.literal("paused"),
      checkpointId: checkpointIdSchema.optional(),
      pauseReason: pauseReasonSchema.optional(),
    })
    .strict(),
  // A resume attempt found the recorded state did not match live reality (branch/head SHA/open
  // status mismatch) -- fail-closed: never guessed at, never auto-corrected, left for a human.
  // C015r decision 1: `cause` is optional -- see this file's own comment right above
  // `requiresManualCauseSchema` for exactly why (backward compatibility with un-migrated records).
  z
    .object({ kind: z.literal("requires_manual"), cause: requiresManualCauseSchema.optional() })
    .strict(),
  // C015o decision 2: `ReviewerPipeline.run()`/`CiRecoveryPipeline.run()` returned `state:"failed"`
  // with a *retryable* `DomainError` (timeout/unavailable/rate_limited/quota_unknown/interrupted)
  // at a provider-invocation stage -- not a state mismatch, not a permission/invariant/conflict
  // error, which still go straight to `requires_manual`. Resumable (see `resumableStageKinds`
  // below) up to a fixed attempt cap tracked by `retries`; the cap itself is enforced by
  // resume-composition.ts, which transitions to `requires_manual` once exhausted.
  z
    .object({
      kind: z.literal("review_pending_retry"),
      retries: providerRetryCountSchema,
      lastErrorCode: lastErrorCodeSchema,
    })
    .strict(),
  // Symmetric to `review_pending_retry`, for `CiRecoveryPipeline.run()`'s own retryable
  // `provider_start`/`provider_run` failures -- named to pair visibly with its reviewer sibling.
  z
    .object({
      kind: z.literal("ci_pending_retry"),
      retries: providerRetryCountSchema,
      lastErrorCode: lastErrorCodeSchema,
    })
    .strict(),
  // C015o decision 4: an explicit, human-issued terminal verdict via `agent-team dispatch resolve`
  // -- this job's own work is being abandoned in favor of `supersededByJobId` (a different job that
  // now owns this issue, e.g. after a duplicate-dispatch incident). Never written automatically.
  z.object({ kind: z.literal("superseded"), supersededByJobId: jobIdSchema }).strict(),
  // C015o decision 4: an explicit, human-issued terminal verdict via `agent-team dispatch resolve`
  // -- this job's work is abandoned outright, no successor job. Never written automatically.
  z.object({ kind: z.literal("cancelled") }).strict(),
  // C015r decision 4: a `report`-stage failure (reviewer output didn't satisfy the report contract
  // even after decision 3's deterministic syntax tolerance) that has not yet exhausted the
  // *dedicated*, separately-capped report-contract retry limit (1, see resume-composition.ts's
  // `reportContractRetryLimit`) -- deliberately never shares C015o's `review_pending_retry`/
  // `providerRetryLimit` (that counter is for the provider failing to *run at all*; this one is for
  // the provider running to completion but the output failing the contract -- codex's C015q review
  // named these as distinct failure semantics that must not share a counter). `lastCategory` is the
  // fixed classification fed back into the next attempt's directive as a sentence -- never the
  // provider's raw invalid text (see reviewer-model.ts's `ReportContractFailureCategory`).
  z
    .object({
      kind: z.literal("review_report_pending_retry"),
      retries: providerRetryCountSchema,
      lastCategory: reportContractFailureCategorySchema,
    })
    .strict(),
]);

export type JobProgressStage = z.infer<typeof jobProgressStageSchema>;

export const protectedRegionHandoffSchema = z
  .object({
    leaseId: leaseIdSchema,
    holderId: z.string().trim().min(1).max(255),
    workflowState: z.enum(["pending", "confirmed"]),
    agentCondition: z.enum(["pending", "confirmed"]),
    comment: z.enum(["pending", "confirmed"]),
    leaseRelease: z.enum(["pending", "confirmed"]),
  })
  .strict();
export type ProtectedRegionHandoff = z.infer<typeof protectedRegionHandoffSchema>;

export const jobProviderAssignmentsSchema = z
  .object({
    execution: z
      .object({
        provider: z.literal("codex"),
        model: z.string().trim().min(1).max(255),
      })
      .strict(),
    codeReview: z
      .object({
        provider: z.literal("claude"),
        model: z.string().trim().min(1).max(255),
      })
      .strict(),
  })
  .strict();
export type JobProviderAssignments = z.infer<typeof jobProviderAssignmentsSchema>;

export const jobProgressRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    jobId: jobIdSchema,
    projectId: projectIdSchema,
    issueId: issueIdSchema,
    /** C015c item 2: the raw Linear issue id (never the derived domain `issueId` above, which is
     * a one-way `generateDeterministicIdentifier` hash -- unrecoverable from the domain id alone).
     * A resume attempt in a *fresh process* has nothing else that can look the Linear issue back
     * up to re-derive `Issue`/`RequirementSnapshot` for `CiRecoveryPipeline`/`ReviewerPipeline`. */
    externalIssueId: z.string().trim().min(1).max(255),
    /** C015c item 2: the model string the original dispatch decision selected. Not derivable from
     * anything else a fresh process has on hand (it is a runtime routing decision, not a pure
     * function of `Issue`) -- without this, a resumed job could not build a valid
     * `CiRecoveryPipelineRequest`/`ReviewerPipelineRequest`. */
    model: z.string().trim().min(1).max(255),
    /** Optional only so schema-v1 records written before ADR-009 remain readable. New model Jobs
     * write this once; resume refuses to infer a missing assignment from current settings. */
    providerAssignments: jobProviderAssignmentsSchema.optional(),
    stage: jobProgressStageSchema,
    /** Durable component receipts for the protected-region human handoff. Optional for every
     * legacy/non-policy record; when present, the stage reason below must identify this exact
     * policy so a later controller cycle can safely replay only the unfinished external writes. */
    protectedRegionHandoff: protectedRegionHandoffSchema.optional(),
    branch: z.string().trim().min(1).max(255),
    worktreePath: z.string().startsWith("/").min(2).max(1024),
    changeRequestId: changeRequestNumberSchema.optional(),
    headSha: headShaSchema.optional(),
    // C035: job-level (not stage-level) because a direct merge or uncertain mutation can leave
    // `ci_waiting`/`awaiting_review` without ever entering `merging`. Optional for legacy records.
    mergeMutations: z
      .array(
        z
          .object({
            kind: z.enum(["enable_auto_merge", "direct_squash"]),
            idempotencyKey: z.string().trim().min(1),
            attemptedAt: instantSchema,
            outcome: z.enum([
              "confirmed_enabled",
              "request_accepted_readback_unknown",
              "merged_directly",
              "rejected",
              "outcome_unknown",
            ]),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    /** C015y decision A: the authoritative base revision dispatch resolved *once*
     * (`resolveAuthoritativeBaseRevision`, authoritative-base.ts) -- written exactly once, at the
     * same moment `changeRequestId`/`headSha` above are first learned (see `handlers.ts`'s own
     * dispatch-time write), and never overwritten afterward: every `resumeUnderLease` call reads
     * this value back rather than re-deriving it from whatever the local git checkout happens to
     * be pointed at that moment (the exact bug this ticket closes -- see this module's own header
     * for why that mattered: a floating base makes the reviewer/merge-gate diff digest computed
     * against a moving target). Optional purely for backward compatibility with records written by
     * C015x and earlier (this ticket, like every prior one touching this store, is forbidden from
     * editing or migrating any existing file under `~/.agent-team/state`).
     *
     * C015z decision (P0-5): "never overwritten afterward" above used to be only a convention every
     * caller had to remember -- `#compareAndSwapLocked` below now enforces it directly: once a
     * record has a `baseRevision`, no mutation may change or omit it, fail-closed with
     * `invariant_violation`. A legacy record with none may still have one written for the first
     * time (nothing to protect yet) -- but as of C015z, `resolveLegacyBaseRevision`
     * (resume-composition.ts) itself no longer does this; a legacy record now always fails closed to
     * `requires_manual(legacy_base_revision_unrecoverable)` instead (see that reasonCode's own
     * header, and `resolveLegacyBaseRevision`'s). */
    baseRevision: headShaSchema.optional(),
    updatedAt: instantSchema,
  })
  .strict()
  .superRefine((record, context) => {
    const protectedReason =
      record.stage.kind === "requires_manual" &&
      record.stage.cause?.stage === "dispatch" &&
      record.stage.cause.reasonCode === "protected_region_requires_human";
    if ((record.protectedRegionHandoff !== undefined) !== protectedReason) {
      context.addIssue({
        code: "custom",
        path: ["protectedRegionHandoff"],
        message: "protected-region handoff receipts must match the protected dispatch reason",
      });
    }
  });

export type JobProgressRecord = z.infer<typeof jobProgressRecordSchema>;
/** The caller never supplies `schemaVersion` (always `1`, stamped by the store itself -- see
 * `compareAndSwap`) nor `revision`/`updatedAt` (computed by the store on every write). */
export type JobProgressRecordMutation = Omit<
  JobProgressRecord,
  "schemaVersion" | "revision" | "updatedAt"
>;

function isNotFound(error: DomainError): boolean {
  return error.code === "not_found";
}

/**
 * Mirrors `FileRegistrationProbeJournalStore` (src/adapters/registration/proactive-probe-journal.ts)
 * line for line in shape -- see this file's own header for why. `clock` stamps `updatedAt` on every
 * `compareAndSwap` (the caller never supplies it directly, so every record's timestamp reflects
 * when the store actually wrote it, not when the caller happened to compute the mutation).
 */
export class FileJobProgressStore {
  readonly #directory: string;
  readonly #store: AtomicFileStore;
  readonly #clock: Clock;

  constructor(
    directory: string,
    store: AtomicFileStore = new AtomicFileStore(),
    clock: Clock = createClock(),
  ) {
    if (!isAbsolute(directory)) throw new Error("job_progress_root_must_be_absolute");
    this.#directory = directory;
    this.#store = store;
    this.#clock = clock;
  }

  #path(jobId: string): string {
    return join(this.#directory, `${jobId}.json`);
  }

  #lockPath(jobId: string): string {
    return `${this.#path(jobId)}.lock`;
  }

  async load(
    jobId: string,
    options: ReadOptions = {},
  ): Promise<Result<JobProgressRecord | undefined, DomainError>> {
    if (!isValidJobId(jobId) || options.signal?.aborted === true) {
      return err(domainError("invariant_violation"));
    }
    const loaded = await readJsonWithSchema(this.#path(jobId), jobProgressRecordSchema);
    if (!loaded.ok) return isNotFound(loaded.error) ? ok(undefined) : loaded;
    return ok(loaded.value);
  }

  async compareAndSwap(
    jobId: string,
    expectedRevision: number | null,
    next: JobProgressRecordMutation,
    options: ReadOptions = {},
  ): Promise<Result<JobProgressRecord, DomainError>> {
    if (!isValidJobId(jobId) || next.jobId !== jobId || options.signal?.aborted === true) {
      return err(domainError("invariant_violation"));
    }
    const acquired = await acquireRecoverableFileLock(
      this.#lockPath(jobId),
      `job-progress:${String(process.pid)}:${randomUUID()}`,
    );
    if (!acquired.ok) return acquired;
    const result = await this.#compareAndSwapLocked(jobId, expectedRevision, next);
    const released = await acquired.value.release();
    return !released.ok && result.ok ? released : result;
  }

  async #compareAndSwapLocked(
    jobId: string,
    expectedRevision: number | null,
    next: JobProgressRecordMutation,
  ): Promise<Result<JobProgressRecord, DomainError>> {
    const current = await readJsonWithSchema(this.#path(jobId), jobProgressRecordSchema);
    const normalizedCurrent = !current.ok && isNotFound(current.error) ? ok(undefined) : current;
    if (!normalizedCurrent.ok) return normalizedCurrent;
    if (expectedRevision === null) {
      if (normalizedCurrent.value !== undefined) return err(domainError("conflict"));
    } else if (normalizedCurrent.value?.revision !== expectedRevision) {
      return err(domainError("conflict"));
    }

    // C015z decision (P0-5): `baseRevision`'s own field header above documents this as a
    // write-once invariant -- enforced here, the one place every CAS write funnels through,
    // rather than left as a convention each call site must remember (which is exactly how
    // C015y/C015z's `resolveLegacyBaseRevision` bug class happened: nothing would have stopped a
    // future caller from silently overwriting or dropping an already-authoritative value). Only
    // applies once a prior record genuinely has the field -- a legacy record establishing it for
    // the first time is not a violation, there is nothing yet to protect.
    if (
      normalizedCurrent.value?.baseRevision !== undefined &&
      next.baseRevision !== normalizedCurrent.value.baseRevision
    ) {
      return err(domainError("invariant_violation"));
    }
    if (
      normalizedCurrent.value?.providerAssignments !== undefined &&
      JSON.stringify(next.providerAssignments) !==
        JSON.stringify(normalizedCurrent.value.providerAssignments)
    ) {
      return err(domainError("invariant_violation"));
    }

    const candidate = {
      ...next,
      schemaVersion: 1 as const,
      revision: (normalizedCurrent.value?.revision ?? -1) + 1,
      updatedAt: this.#clock.now(),
    };
    const validated = jobProgressRecordSchema.safeParse(candidate);
    if (!validated.success) return err(domainError("invariant_violation"));

    const written = await writeJsonWithSchema(
      this.#store,
      this.#path(jobId),
      jobProgressRecordSchema,
      validated.data,
      { visibility: "private" },
    );
    if (!written.ok) return written;
    if (written.value.durability !== "confirmed" || !written.value.readBack.ok) {
      return err(domainError("external_failure"));
    }
    return ok(written.value.readBack.value);
  }

  /** Returns every progress record for a project, any stage -- deliberately not pre-filtered to
   * "resumable" stages: that is a scheduling decision for the caller (item 2's composition), not
   * this store's job. */
  async listForProject(
    projectId: string,
    options: ReadOptions = {},
  ): Promise<Result<readonly JobProgressRecord[], DomainError>> {
    const parsedProjectId = parseIdentifier("project", projectId);
    if (!parsedProjectId.ok || options.signal?.aborted === true) {
      return err(domainError("invariant_violation"));
    }

    const all = await this.listAll(options);
    if (!all.ok) return all;
    return ok(Object.freeze(all.value.filter((record) => record.projectId === projectId)));
  }

  /**
   * Returns one global, read-only snapshot of every durable progress record. Classification is
   * deliberately left to the reconcile/dispatch caller: the store validates persistence shape and
   * filename identity, but does not decide which stages are resumable or terminal.
   */
  async listAll(
    options: ReadOptions = {},
  ): Promise<Result<readonly JobProgressRecord[], DomainError>> {
    if (options.signal?.aborted === true) return err(domainError("invariant_violation"));
    let entries: string[];
    try {
      entries = (await readdir(this.#directory)).filter((name) => name.endsWith(".json"));
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return ok(Object.freeze([]));
      }
      return err(domainError("external_failure"));
    }

    const records: JobProgressRecord[] = [];
    for (const entry of entries.sort()) {
      const loaded = await readJsonWithSchema(
        join(this.#directory, entry),
        jobProgressRecordSchema,
      );
      // Once `readdir` included an entry, losing it before read-back invalidates this snapshot.
      // Silently skipping it could turn unresolved durable work into an empty, false-green result.
      if (!loaded.ok) return loaded;
      if (`${loaded.value.jobId}.json` !== entry) return err(domainError("invariant_violation"));
      records.push(loaded.value);
    }
    return ok(Object.freeze(records));
  }
}

function isValidJobId(jobId: string): boolean {
  return parseIdentifier("job", jobId).ok;
}
