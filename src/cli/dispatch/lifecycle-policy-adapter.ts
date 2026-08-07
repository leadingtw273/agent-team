/**
 * C015c item 5, self-resolved third open question (per the decision layer's own closing
 * instruction: "若還有第三個待裁決問題未被以上覆蓋，先依「最小、fail-closed、不動引擎」原則選擇
 * 並在回報揭露"): `LifecyclePolicyPort.pauseAutoMerge` has no real backing capability anywhere in
 * this codebase. `SourceControlPort` (src/application/ports/source-control.ts) has no
 * `disableAutoMerge` method -- confirmed by direct inspection of the interface -- and no adapter
 * anywhere exposes GitHub's repository-level auto-merge toggle. This branch only fires when
 * `LifecyclePipeline` observes a change request merged *without* a matching
 * `mergeAuthorizationHeadSha` (an out-of-process merge) -- a genuinely peripheral path this
 * ticket's own primary (in-process, authorized-merge) E2E scenario never exercises.
 *
 * C015c acceptance review (round 1, observation 1): reporting `{durability:"confirmed"}`
 * unconditionally is a false success signal at *runtime*, not just an honestly-worded comment --
 * it told `LifecyclePipeline` a mutation happened that never did. The port's own receipt type
 * already has the honest word for this: `AsyncPortResult<Readonly<{durability:"confirmed" |
 * "unknown"}>>` -- `"unknown"` means exactly "not confirmed to have durably happened", which is
 * the truth here. Returning it (rather than `"confirmed"`) makes `LifecyclePipeline` itself take
 * its own existing fail-closed branch (`lifecycle.ts`: `if (paused.value.durability !==
 * "confirmed") return failed("policy", domainError("external_failure"))`) -- the out-of-process-
 * merge path now correctly reports `failed`/`requires_manual` (via C015c's own resume orchestration,
 * `finishMerged`'s `outcome.state !== "completed"` branch) instead of silently completing
 * bookkeeping for a pause that never happened. No port type change; no engine change.
 */
import { ok } from "../../domain/foundation/index.js";
import type { LifecyclePolicyPort } from "../../application/pipelines/index.js";

export class NoOpAutoMergePauseAdapter implements LifecyclePolicyPort {
  pauseAutoMerge(
    _request: Parameters<LifecyclePolicyPort["pauseAutoMerge"]>[0],
    _options: Parameters<LifecyclePolicyPort["pauseAutoMerge"]>[1],
  ): ReturnType<LifecyclePolicyPort["pauseAutoMerge"]> {
    void _request;
    void _options;
    return Promise.resolve(ok(Object.freeze({ durability: "unknown" as const })));
  }
}
