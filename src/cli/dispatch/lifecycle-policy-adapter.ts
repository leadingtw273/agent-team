/**
 * C015c item 5, self-resolved third open question (per the decision layer's own closing
 * instruction: "若還有第三個待裁決問題未被以上覆蓋，先依「最小、fail-closed、不動引擎」原則選擇
 * 並在回報揭露"): `LifecyclePolicyPort.pauseAutoMerge` has no real backing capability anywhere in
 * this codebase. `SourceControlPort` (src/application/ports/source-control.ts) has no
 * `disableAutoMerge` method -- confirmed by direct inspection of the interface -- and no adapter
 * anywhere exposes GitHub's repository-level auto-merge toggle. This branch only fires when
 * `LifecyclePipeline` observes a change request merged *without* a matching
 * `mergeAuthorizationHeadSha` (an out-of-process merge).
 *
 * C015v decision 1 (supersedes the C015c reasoning below, which is kept for history): the original
 * fix made this adapter honestly report `{durability:"unknown"}` unconditionally, correctly closing
 * a false-success hole -- but that made `LifecyclePipeline.#handleMerge` fail-closed on *every*
 * out-of-process merge, including the overwhelming common case where the change request being
 * processed is already `merged` and there is structurally nothing left to pause (a real E101 job
 * deadlocked on exactly this). This adapter's *only* caller, `#handleMerge`, only ever invokes
 * `pauseAutoMerge` with `reason: "out_of_process_merge"` immediately after its own authoritative
 * readback has already confirmed `changeRequestId` is `merged` at `mergedHeadSha` -- the request
 * shape itself is the caller's proof of that fact, not something this adapter independently
 * observes or guesses. Given that documented contract, `"not_applicable"` is not a guess: it is the
 * only honest answer a capability-less adapter can give for "pause auto-merge on a change request
 * that is already merged" -- there is no live, cancellable auto-merge left on a merged PR, by
 * construction, regardless of what capability this adapter does or does not have.
 *
 * This adapter still has **zero real pause capability** -- it cannot durably confirm `"paused"` for
 * any request, and it must never be changed to claim otherwise without first building a real
 * backing capability (E116's own, separate, deliberately-deferred scope; see lifecycle.ts's own
 * header). If a future call site ever invokes this port from a context that is *not* already known
 * to be an already-merged change request, this adapter must not be reused as-is for that case --
 * `"not_applicable"` is only ever correct because of the exact, narrow contract described above.
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
    return Promise.resolve(
      ok(
        Object.freeze({
          state: "not_applicable" as const,
          reason: "change_request_already_merged" as const,
          observedState: "merged" as const,
        }),
      ),
    );
  }
}
