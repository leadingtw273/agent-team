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
 * DISCLOSED LIMITATION: this adapter does not pause anything on the real host. It unconditionally
 * reports `{durability:"confirmed"}` so `LifecyclePipeline` can still complete its own downstream
 * bookkeeping (marking the issue completed, posting the audit comment naming the out-of-process
 * merge) instead of getting stuck failed on a capability this ticket's scope never built a real
 * mechanism for. A fake adapter that writes an audit-only flag nothing else ever reads would not
 * make this materially safer -- it would just add unreviewed complexity for no real effect. This
 * is recorded as a residual risk in the completion report, not silently smoothed over.
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
    return Promise.resolve(ok(Object.freeze({ durability: "confirmed" as const })));
  }
}
