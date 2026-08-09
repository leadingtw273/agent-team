/**
 * C015c item 2: bundles the four GitHub-auth-gated compositions `runResumeCycle`
 * (resume-composition.ts) needs -- `CiRecoveryPipeline` (C006), `ReviewerPipeline` (C007),
 * `ReviewStatusCoordinator`/`AutoMergeGate` (C008), `LifecyclePipeline` (C009) -- behind one
 * overridable seam, the same convention `implementer-composition.ts`'s own
 * `BuildImplementerPipelineResult` already established. Kept separate from resume-composition.ts
 * itself so that file's pure state-machine logic (already thoroughly unit tested against fakes)
 * stays free of GitHub-authentication wiring concerns.
 */
import { GhTransport, GitHubAdapter } from "../../adapters/github/index.js";
import type { FileJobProgressStore } from "../../adapters/dispatch/job-progress-store.js";
import type { FileAutoMergePauseStore } from "../../adapters/dispatch/auto-merge-pause-store.js";
import { LinearVisualPublicationCoordinator } from "../../adapters/dispatch/linear-publication.js";
import {
  FileLinearPublicationStore,
  defaultLinearPublicationDirectory,
} from "../../adapters/dispatch/linear-publication-store.js";
import type { LinearGraphqlTransport } from "../../adapters/linear/transport.js";
import { LinearUploadClient } from "../../adapters/linear/upload.js";
import type { LinearMutationClient } from "../../adapters/linear/write.js";
import type { LinearReadModel } from "../../adapters/linear/read.js";
import type { FileJobRepository } from "../../infrastructure/jobs/index.js";
import type { LeaseCoordinator } from "../../application/leases/index.js";
import { createClock } from "../../domain/foundation/index.js";
import { VisualEvidenceBuilder } from "../../application/pipelines/index.js";
import { ChildProcessRunner } from "../../adapters/process/index.js";
import type { ResumeCycleDependencies } from "./resume-composition.js";
import { buildCiRecoveryPipeline } from "./ci-recovery-composition.js";
import { buildReviewerRecoveryPipeline } from "./reviewer-recovery-composition.js";
import { buildReviewerPipeline } from "./reviewer-composition.js";
import { buildStatusMergePipelines } from "./status-merge-composition.js";
import { buildLifecyclePipeline } from "./lifecycle-composition.js";
import type { DispatchProviderConfig } from "./provider-config-store.js";

export type ResumeCompositionBlockedReason = "github_authentication_unavailable";

export interface BuildResumeCompositionOptions {
  readonly agentTeamHome: string;
  readonly claudeConfig: DispatchProviderConfig["claude"];
  /** E102-2: threaded straight through to `buildReviewerPipeline` (reviewer-composition.ts);
   * absent means no real visual-review provider is configured on this host -- see that file's own
   * header for why that fails closed per-job rather than blocking this whole composition. */
  readonly geminiConfig?: DispatchProviderConfig["gemini"];
  readonly jobs: Pick<FileJobRepository, "update">;
  readonly readModel: LinearReadModel;
  readonly mutationClient: Pick<
    LinearMutationClient,
    "observeGithubMerge" | "setAgentCondition" | "appendComment"
  >;
  readonly teamId: string;
  readonly linearProjectId: string;
  readonly progress: FileJobProgressStore;
  /** E102-5: the same transport `readModel`/`mutationClient` above already share -- used only to
   * construct a real `LinearUploadClient` (upload.ts) for `LinearVisualPublicationCoordinator`,
   * never a second, independently-configured connection. */
  readonly linearTransport: LinearGraphqlTransport;
  /** E115cap: threaded through to `buildLifecyclePipeline` so a Linear cancellation can release
   * the cancelled issue's lease -- see `lifecycle-composition.ts`'s own header. */
  readonly leases: LeaseCoordinator;
  /** E116cap: the single, shared `FileAutoMergePauseStore` instance for this process -- threaded
   * into both `buildStatusMergePipelines` (the read side, `AutoMergeGate`'s gate check) and
   * `buildLifecyclePipeline` (the write side, `FileAutoMergePauseAdapter`). See
   * `lifecycle-composition.ts`'s own header for why this is threaded rather than each composition
   * root constructing its own store from `agentTeamHome`. */
  readonly autoMergePause: Pick<FileAutoMergePauseStore, "load" | "pause">;
}

export type ResumePipelineComposition = Pick<
  ResumeCycleDependencies,
  | "sourceControl"
  | "ciRecovery"
  | "reviewerRecovery"
  | "reviewer"
  | "reviewStatus"
  | "autoMerge"
  | "lifecycle"
  | "visualEvidence"
  | "visualReviewModel"
  | "linearPublication"
  | "linearPublicationStore"
>;

export type BuildResumeCompositionResult =
  | Readonly<{ state: "ready"; value: ResumePipelineComposition }>
  | Readonly<{ state: "blocked"; reason: ResumeCompositionBlockedReason }>;

export async function buildResumeComposition(
  options: BuildResumeCompositionOptions,
): Promise<BuildResumeCompositionResult> {
  const ciRecovery = await buildCiRecoveryPipeline({
    agentTeamHome: options.agentTeamHome,
    claudeConfig: options.claudeConfig,
    jobs: options.jobs,
  });
  if (ciRecovery.state !== "ready") {
    return Object.freeze({ state: "blocked", reason: ciRecovery.reason });
  }
  const reviewerRecovery = await buildReviewerRecoveryPipeline({
    agentTeamHome: options.agentTeamHome,
    claudeConfig: options.claudeConfig,
    jobs: options.jobs,
  });
  const reviewer = await buildReviewerPipeline({
    agentTeamHome: options.agentTeamHome,
    claudeConfig: options.claudeConfig,
    ...(options.geminiConfig === undefined ? {} : { geminiConfig: options.geminiConfig }),
    jobs: options.jobs,
  });
  if (reviewer.state !== "ready") {
    return Object.freeze({ state: "blocked", reason: reviewer.reason });
  }
  const statusMerge = await buildStatusMergePipelines({
    autoMergePauseStore: options.autoMergePause,
  });
  if (statusMerge.state !== "ready") {
    return Object.freeze({ state: "blocked", reason: statusMerge.reason });
  }
  const lifecycle = buildLifecyclePipeline({
    readModel: options.readModel,
    mutationClient: options.mutationClient,
    teamId: options.teamId,
    linearProjectId: options.linearProjectId,
    progress: options.progress,
    agentTeamHome: options.agentTeamHome,
    leases: options.leases,
    autoMergePause: options.autoMergePause,
  });
  // E102-3: zero-arg/no-shared-state construction, the same convention every other adapter in
  // this function's own return value already follows (`new GitHubAdapter(new GhTransport())`
  // just below) -- a fresh `ChildProcessRunner`/`Clock` per composition call, never a second,
  // independently-drifting instance shared with anything else in this process.
  const visualEvidence = new VisualEvidenceBuilder({
    process: new ChildProcessRunner(),
    clock: createClock(),
  });
  // E102-3: the real Gemini model `models.visual` should request -- see
  // `ResumeCycleDependencies.visualReviewModel`'s own header (resume-composition.ts) for why this
  // is `options.geminiConfig`'s own first allowlisted model, never `record.model` (that is this
  // job's *code*-review Claude model, which a real `GeminiRunner` would reject outright).
  const visualReviewModel = options.geminiConfig?.models[0];
  // E102-5: `LinearUploadClient` (A004, upload.ts) shares `options.linearTransport` with
  // `options.mutationClient` -- never a second, independently-configured connection --
  // `options.mutationClient` itself already satisfies `LinearCommentWriter` (its own
  // `appendComment` matches that interface exactly, see `LinearVisualPublicationCoordinator`'s own
  // constructor). `FileLinearPublicationStore` is rooted at the same `agentTeamHome` every other
  // adapter in this function's return value is.
  // E102-4b: named separately (rather than only ever constructed inline inside
  // `LinearVisualPublicationCoordinator`'s own constructor call below) so this same store instance
  // can also be exposed as `linearPublicationStore` -- `resumeReview`'s pre-arm merge recheck
  // (resume-composition.ts) needs read-only `load()` access to the exact same durable receipts
  // `linearPublication.publish()` writes, never a second, independently-rooted store instance.
  const linearPublicationStore = new FileLinearPublicationStore(
    defaultLinearPublicationDirectory(options.agentTeamHome),
  );
  const linearPublication = new LinearVisualPublicationCoordinator(
    new LinearUploadClient(options.linearTransport, options.mutationClient),
    options.mutationClient,
    linearPublicationStore,
  );

  return Object.freeze({
    state: "ready",
    value: Object.freeze({
      sourceControl: new GitHubAdapter(new GhTransport()),
      ciRecovery: ciRecovery.value,
      reviewerRecovery: reviewerRecovery.value,
      reviewer: reviewer.value,
      reviewStatus: statusMerge.value.reviewStatus,
      autoMerge: statusMerge.value.autoMergeGate,
      lifecycle,
      visualEvidence,
      linearPublication,
      linearPublicationStore,
      ...(visualReviewModel === undefined ? {} : { visualReviewModel }),
    }),
  });
}
