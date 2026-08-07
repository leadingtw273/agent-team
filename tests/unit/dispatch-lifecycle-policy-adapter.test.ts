/**
 * C015c item 5 unit test: `NoOpAutoMergePauseAdapter`
 * (src/cli/dispatch/lifecycle-policy-adapter.ts) -- the disclosed, deliberately no-op
 * `LifecyclePolicyPort.pauseAutoMerge` implementation (see that file's header for why: no adapter
 * anywhere exposes a real "disable auto-merge" host capability). This test only pins down the
 * one contract `LifecyclePipeline` actually depends on: an unconditional `{durability:
 * "confirmed"}` so the out-of-process-merge branch can still complete its own bookkeeping.
 */
import { describe, expect, it } from "vitest";

import { NoOpAutoMergePauseAdapter } from "../../src/cli/dispatch/lifecycle-policy-adapter.js";
import { projectSchema } from "../../src/domain/project/index.js";

describe("NoOpAutoMergePauseAdapter", () => {
  it("always reports durability confirmed, regardless of request contents", async () => {
    const adapter = new NoOpAutoMergePauseAdapter();
    const project = projectSchema.parse({
      schemaVersion: 1,
      id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      displayName: "Sandbox",
      localRepositoryPath: "/tmp/sandbox",
      defaultBranch: "main",
      workManagement: { provider: "linear", containerId: "team-1", projectId: "proj-1" },
      sourceControl: { provider: "github", repository: "owner/sandbox" },
    });

    const result = await adapter.pauseAutoMerge(
      {
        project,
        reason: "out_of_process_merge",
        changeRequestId: "42",
        mergedHeadSha: "a".repeat(40),
      },
      { idempotencyKey: "pause-1" },
    );
    expect(result).toEqual({ ok: true, value: { durability: "confirmed" } });
  });
});
