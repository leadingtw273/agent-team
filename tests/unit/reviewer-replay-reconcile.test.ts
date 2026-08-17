import { describe, expect, it, vi } from "vitest";

import { createReviewerReplayReconcileHandler } from "../../src/cli/reconcile/reviewer-replay-reconcile.js";
import { ok } from "../../src/domain/foundation/index.js";

const jobId = "job_018f47d2-77a4-7cc1-8ef2-0123456789ab";

function record(checkpoint: boolean) {
  return {
    jobId,
    stage: {
      kind: "requires_manual",
      cause: {
        stage: "review",
        reasonCode: "review_report_contract",
        attempts: { count: 2 },
      },
    },
    ...(checkpoint
      ? {
          reviewerReplay: {
            state: "review_succeeded",
          },
        }
      : {}),
  } as never;
}

describe("reviewer-replay reconcile bridge", () => {
  it("AC7/AC14 invokes only exact successful checkpoints and never bare requires_manual jobs", async () => {
    const replay = vi.fn(() =>
      Promise.resolve({
        state: "success" as const,
        message: JSON.stringify({ state: "continued" }),
      }),
    );
    const handler = createReviewerReplayReconcileHandler({
      base: () => Promise.resolve({ state: "success" }),
      progress: { listAll: () => Promise.resolve(ok([record(false), record(true)])) },
      replay,
    });

    const result = await handler({ all: true });
    expect(result.state).toBe("success");
    expect(replay).toHaveBeenCalledTimes(1);
    expect(replay).toHaveBeenCalledWith({ jobId });
  });
});
