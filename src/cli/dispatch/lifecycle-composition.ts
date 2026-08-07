/**
 * C015c item 5: production composition root for `LifecyclePipeline`
 * (src/application/pipelines/lifecycle.ts). `sourceControl` needs no adapter -- `GitHubAdapter`
 * already satisfies `Pick<SourceControlPort, "getChangeRequest" | "closeChangeRequest">` directly
 * (it implements the full `SourceControlPort`). The other three ports are the adapters this
 * ticket built: `work-management-adapter.ts` (real Linear read/write), `lifecycle-policy-
 * adapter.ts` and `lifecycle-cancellation-adapter.ts` (both disclosed, deliberately narrow --
 * see their own file headers for why).
 */
import { GhTransport, GitHubAdapter, type GhJsonTransport } from "../../adapters/github/index.js";
import { LifecyclePipeline } from "../../application/pipelines/index.js";
import type { FileJobProgressStore } from "../../adapters/dispatch/index.js";
import type { LinearReadModel } from "../../adapters/linear/read.js";
import { JobProgressLifecycleCancellationAdapter } from "./lifecycle-cancellation-adapter.js";
import { NoOpAutoMergePauseAdapter } from "./lifecycle-policy-adapter.js";
import {
  LinearWorkManagementAdapter,
  type LinearWorkManagementMutationClient,
} from "./work-management-adapter.js";

export interface BuildLifecyclePipelineOptions {
  readonly readModel: LinearReadModel;
  readonly mutationClient: LinearWorkManagementMutationClient;
  readonly teamId: string;
  readonly linearProjectId: string;
  readonly progress: FileJobProgressStore;
  /** Injectable for tests; production defaults to a real `GhTransport`. */
  readonly githubTransport?: GhJsonTransport;
}

export function buildLifecyclePipeline(options: BuildLifecyclePipelineOptions): LifecyclePipeline {
  const github = new GitHubAdapter(options.githubTransport ?? new GhTransport());
  return new LifecyclePipeline({
    sourceControl: github,
    workManagement: new LinearWorkManagementAdapter({
      readModel: options.readModel,
      mutationClient: options.mutationClient,
      teamId: options.teamId,
      linearProjectId: options.linearProjectId,
    }),
    policy: new NoOpAutoMergePauseAdapter(),
    cancellation: new JobProgressLifecycleCancellationAdapter({ progress: options.progress }),
  });
}
