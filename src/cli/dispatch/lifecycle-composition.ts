/**
 * C015c item 5: production composition root for `LifecyclePipeline`
 * (src/application/pipelines/lifecycle.ts). `sourceControl` needs no adapter -- `GitHubAdapter`
 * already satisfies `Pick<SourceControlPort, "getChangeRequest" | "closeChangeRequest">` directly
 * (it implements the full `SourceControlPort`). The other ports are the adapters this ticket and
 * E115cap built: `work-management-adapter.ts` (real Linear read/write), `lifecycle-policy-
 * adapter.ts`, and `lifecycle-cancellation-adapter.ts`'s two classes (both disclosed, see that
 * file's own header for the judgment calls each makes).
 *
 * E115cap: `checkpoint` and `leases` are new here -- `JobProgressLifecycleCancellationAdapter` now
 * really persists an F008 `Checkpoint` on cancellation (mirrors `ci-recovery-composition.ts`'s own
 * `LocalYamlCheckpointStore` construction under `${agentTeamHome}/state/checkpoints`, the same
 * directory every other checkpoint-writing pipeline in this codebase already uses), and
 * `LeaseCoordinatorLifecycleLeaseReleaseAdapter` needs a real `LeaseCoordinator` to release a
 * cancelled issue's lease.
 */
import { join } from "node:path";

import { GhTransport, GitHubAdapter, type GhJsonTransport } from "../../adapters/github/index.js";
import { LocalYamlCheckpointStore } from "../../adapters/checkpoint/index.js";
import { LifecyclePipeline } from "../../application/pipelines/index.js";
import type { LeaseCoordinator } from "../../application/leases/index.js";
import type { FileJobProgressStore } from "../../adapters/dispatch/index.js";
import type { LinearReadModel } from "../../adapters/linear/read.js";
import {
  JobProgressLifecycleCancellationAdapter,
  LeaseCoordinatorLifecycleLeaseReleaseAdapter,
} from "./lifecycle-cancellation-adapter.js";
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
  readonly agentTeamHome: string;
  readonly leases: LeaseCoordinator;
  /** Injectable for tests; production defaults to a real `GhTransport`. */
  readonly githubTransport?: GhJsonTransport;
}

export function buildLifecyclePipeline(options: BuildLifecyclePipelineOptions): LifecyclePipeline {
  const github = new GitHubAdapter(options.githubTransport ?? new GhTransport());
  const checkpointDirectory = join(options.agentTeamHome, "state", "checkpoints");
  return new LifecyclePipeline({
    sourceControl: github,
    workManagement: new LinearWorkManagementAdapter({
      readModel: options.readModel,
      mutationClient: options.mutationClient,
      teamId: options.teamId,
      linearProjectId: options.linearProjectId,
    }),
    policy: new NoOpAutoMergePauseAdapter(),
    cancellation: new JobProgressLifecycleCancellationAdapter({
      progress: options.progress,
      store: new LocalYamlCheckpointStore(checkpointDirectory),
    }),
    leaseRelease: new LeaseCoordinatorLifecycleLeaseReleaseAdapter({ leases: options.leases }),
  });
}
