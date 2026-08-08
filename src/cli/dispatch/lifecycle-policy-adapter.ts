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
 * `NoOpAutoMergePauseAdapter` below still has **zero real pause capability**, unchanged by E116cap
 * -- it is kept exactly as C015v left it (same class, same behavior, same unit test in
 * tests/unit/dispatch-lifecycle-policy-adapter.test.ts) so its documented "not_applicable" contract
 * never regresses. E116cap's real scope is `FileAutoMergePauseAdapter` below, which *is* the
 * previously-deferred backing capability this file's own header used to promise did not exist yet
 * (see that class's own header for what changed and why "not_applicable" is no longer production's
 * answer). `buildLifecyclePipeline` (lifecycle-composition.ts) now wires `FileAutoMergePauseAdapter`
 * in production; `NoOpAutoMergePauseAdapter` remains available for any context that genuinely has no
 * project-scoped persistence to write to (e.g. a future ephemeral/dry-run composition).
 */
import { domainError, err, ok } from "../../domain/foundation/index.js";
import type { LifecyclePolicyPort } from "../../application/pipelines/index.js";
import type { FileAutoMergePauseStore } from "../../adapters/dispatch/auto-merge-pause-store.js";

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

/**
 * E116cap: the real backing capability `NoOpAutoMergePauseAdapter`'s own header (above) has always
 * disclosed as missing. Writes/confirms the project-level pause flag
 * (`FileAutoMergePauseStore.pause`, src/adapters/dispatch/auto-merge-pause-store.ts) every time
 * `LifecyclePipeline.#handleMerge` invokes this port -- which, per that method's own documented
 * contract (lifecycle.ts), only ever happens immediately after it has itself confirmed the change
 * request is `merged` out-of-process. Unlike `NoOpAutoMergePauseAdapter`, this adapter always has a
 * real, applicable action to perform (pause the *project*, not the already-merged PR) -- so it
 * deliberately never returns `"not_applicable"`: doing so now would misreport "nothing happened"
 * when a real, durable write just did. `"not_applicable"`'s documented meaning ("no live auto-merge
 * left to cancel on *this* PR") remains true as a fact and remains `NoOpAutoMergePauseAdapter`'s own
 * unchanged answer -- this class simply answers a different, additional question ("is the project
 * now quarantined against future auto-merge") that C015v never had the capability to act on.
 *
 * Only two outcomes are reachable: `"paused"` (the store write durably confirmed -- either newly
 * transitioning the project to paused, or finding it already paused, both are "paused" from this
 * call's honest point of view) and `"unknown"` (the store write itself failed -- `LifecyclePipeline`
 * fails closed exactly as C015c originally intended for a genuine capability failure).
 */
export class FileAutoMergePauseAdapter implements LifecyclePolicyPort {
  readonly #store: Pick<FileAutoMergePauseStore, "pause">;

  /** `store` is `Pick<FileAutoMergePauseStore, "pause">`, not the concrete class -- the same
   * "Pick over a concrete class" convention `IssueAdmissionPort` already established
   * (issue-admission-store.ts's own header) -- so a unit test can inject a fake `pause` without
   * needing a real, disk-backed `FileAutoMergePauseStore` instance. */
  constructor(options: Readonly<{ store: Pick<FileAutoMergePauseStore, "pause"> }>) {
    this.#store = options.store;
  }

  async pauseAutoMerge(
    request: Parameters<LifecyclePolicyPort["pauseAutoMerge"]>[0],
    options: Parameters<LifecyclePolicyPort["pauseAutoMerge"]>[1],
  ): ReturnType<LifecyclePolicyPort["pauseAutoMerge"]> {
    const paused = await this.#store.pause(
      request.project.id,
      { changeRequestId: request.changeRequestId, mergedHeadSha: request.mergedHeadSha },
      options.signal === undefined ? {} : { signal: options.signal },
    );
    if (!paused.ok) {
      return ok(Object.freeze({ state: "unknown" as const, durability: "unknown" as const }));
    }
    if (paused.value.status.state !== "paused") {
      // Structurally unreachable through `FileAutoMergePauseStore.pause`'s own documented contract
      // (it only ever returns `state:"active"` on a genuine internal invariant break) -- fails
      // closed rather than silently reporting a false `"paused"`.
      return err(domainError("invariant_violation"));
    }
    return ok(Object.freeze({ state: "paused" as const, durability: "confirmed" as const }));
  }
}
