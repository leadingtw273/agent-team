import type { WorkManagementPort, WorkManagementIssueSnapshot } from "../ports/index.js";
import {
  createClock,
  domainError,
  type Clock,
  type DomainError,
} from "../../domain/foundation/index.js";
import { createAgentCondition, type WorkTransitionCause } from "../../domain/workflow/index.js";
import { sha256Digest } from "../../domain/review/index.js";
import type {
  IssueScopeLockPort,
  LifecycleAgentTarget,
  WorkStatusLifecycleCheckpoint,
  WorkStatusLifecycleLedgerPort,
  WorkStatusLifecycleLedgerSnapshot,
  WorkStatusLifecycleOutcome,
  WorkStatusLifecycleRequest,
  WorkStatusLifecycleTransition,
  WorkStatusHistoryPort,
  TransitionHistoryEvidence,
} from "./work-status-lifecycle-model.js";

const digestPattern = /^[0-9a-f]{64}$/u;
const retryLimit = 6;

type LifecycleWorkManagementPort = Pick<
  WorkManagementPort,
  "getIssue" | "setWorkStatus" | "setAgentCondition" | "clearAgentCondition"
>;

export interface WorkStatusLifecycleCoordinatorDependencies {
  readonly workManagement: LifecycleWorkManagementPort;
  readonly ledger: WorkStatusLifecycleLedgerPort;
  readonly locks: IssueScopeLockPort;
  readonly history?: WorkStatusHistoryPort;
  readonly clock?: Clock;
}

function targetMatches(
  snapshot: WorkManagementIssueSnapshot,
  target: LifecycleAgentTarget,
): boolean {
  if (target.kind === "clear") return snapshot.agentCondition === undefined;
  return (
    snapshot.agentCondition?.status === target.status &&
    snapshot.agentCondition.blockingReasons[0] === target.blockingReason &&
    snapshot.agentCondition.blockingReasons.length === (target.blockingReason === undefined ? 0 : 1)
  );
}

function transitionMatches(
  transition: WorkStatusLifecycleTransition,
  request: WorkStatusLifecycleRequest,
): boolean {
  return (
    transition.step === request.step &&
    transition.instance === request.transitionInstance &&
    transition.mainTarget === request.mainTarget &&
    (transition.allowedMainSources === undefined ||
      JSON.stringify(transition.allowedMainSources) ===
        JSON.stringify(request.allowedMainSources ?? [])) &&
    JSON.stringify(transition.agentTarget) === JSON.stringify(request.agentTarget)
  );
}

function replaceTransition(
  checkpoint: WorkStatusLifecycleCheckpoint,
  transition: WorkStatusLifecycleTransition,
): WorkStatusLifecycleCheckpoint {
  return {
    ...checkpoint,
    transitions: checkpoint.transitions.map((current) =>
      current.instance === transition.instance ? transition : current,
    ),
  };
}

function failureIsProviderWide(error: DomainError): boolean {
  return (
    error.code === "rate_limited" || error.code === "quota_unknown" || error.code === "unavailable"
  );
}

function failureMayHaveMutated(error: DomainError): boolean {
  return (
    error.code === "timeout" || error.code === "interrupted" || error.code === "external_failure"
  );
}

function transitionCauseForStep(
  step: WorkStatusLifecycleRequest["step"],
): WorkTransitionCause | undefined {
  switch (step) {
    case "work_start":
      return "work_started";
    case "review_start":
    case "merge_start":
      return "review_started";
    case "fix_start":
      return "changes_requested";
    case "complete":
      return "github_merge_observed";
    case "requires_manual":
      return "policy_requires_manual";
    case "clear_condition":
      return undefined;
  }
}

function blocked(
  reason: Extract<WorkStatusLifecycleOutcome, { state: "blocked" }>["reason"],
  error?: DomainError,
): WorkStatusLifecycleOutcome {
  return Object.freeze({ state: "blocked", reason, ...(error === undefined ? {} : { error }) });
}

/**
 * Serializes and receipts one Linear lifecycle transition. A `permitted` enforce outcome means
 * the main work status has an authoritative confirmed receipt; Agent labels are observability and
 * may remain pending without authorizing or revoking Provider work.
 */
export class WorkStatusLifecycleCoordinator {
  readonly #workManagement: LifecycleWorkManagementPort;
  readonly #ledger: WorkStatusLifecycleLedgerPort;
  readonly #locks: IssueScopeLockPort;
  readonly #history: WorkStatusHistoryPort | undefined;
  readonly #clock: Clock;

  constructor(dependencies: WorkStatusLifecycleCoordinatorDependencies) {
    this.#workManagement = dependencies.workManagement;
    this.#ledger = dependencies.ledger;
    this.#locks = dependencies.locks;
    this.#history = dependencies.history;
    this.#clock = dependencies.clock ?? createClock();
  }

  async transition(request: WorkStatusLifecycleRequest): Promise<WorkStatusLifecycleOutcome> {
    if (
      !digestPattern.test(request.transitionInstance) ||
      !digestPattern.test(request.invocationDigest) ||
      (request.mode === "enforce" &&
        (request.capabilityDigest === undefined || !digestPattern.test(request.capabilityDigest)))
    ) {
      return blocked("checkpoint_identity_mismatch", domainError("invariant_violation"));
    }
    const acquired = await this.#locks.acquire(
      {
        projectId: request.reference.project.id,
        externalIssueId: request.reference.externalIssueId,
      },
      request.holderId,
    );
    if (!acquired.ok) {
      return blocked(
        acquired.error.code === "conflict" ? "lock_conflict" : "ledger_unavailable",
        acquired.error,
      );
    }
    const outcome = await this.#underLock(request);
    const released = await acquired.value.release();
    return !released.ok && outcome.state === "permitted"
      ? blocked("ledger_unavailable", released.error)
      : outcome;
  }

  /**
   * Narrow composition seam for a coordinator that already owns the canonical IssueScope lock.
   * It prevents release/reacquire race windows; callers must pass the exact acquired handle.
   */
  async transitionWhileLockHeld(
    request: WorkStatusLifecycleRequest,
    handle: Readonly<{ holderId: string; scopeDigest: string }>,
  ): Promise<WorkStatusLifecycleOutcome> {
    if (handle.holderId !== request.holderId || !/^[0-9a-f]{64}$/u.test(handle.scopeDigest)) {
      return blocked("lock_conflict", domainError("conflict"));
    }
    return this.#underLock(request);
  }

  async #underLock(request: WorkStatusLifecycleRequest): Promise<WorkStatusLifecycleOutcome> {
    if (request.mode === "off") {
      return Object.freeze({
        state: "permitted",
        mode: "off",
        main: "not_required",
        agent: "not_required",
      });
    }
    const loaded = await this.#ledger.load(request.jobId);
    if (!loaded.ok || loaded.value === undefined) {
      return blocked("ledger_unavailable", loaded.ok ? domainError("not_found") : loaded.error);
    }
    if (
      loaded.value.checkpoint.admissionMode !== request.mode ||
      (request.mode === "enforce" &&
        loaded.value.checkpoint.capabilityDigest !== request.capabilityDigest)
    ) {
      return blocked("checkpoint_identity_mismatch", domainError("conflict"));
    }
    return request.mode === "observe"
      ? this.#observe(request, loaded.value)
      : this.#enforce(request, loaded.value);
  }

  async #observe(
    request: WorkStatusLifecycleRequest,
    ledger: WorkStatusLifecycleLedgerSnapshot,
  ): Promise<WorkStatusLifecycleOutcome> {
    const read = await this.#workManagement.getIssue(request.reference);
    // Observe is telemetry-only: no read/history/ledger failure may change Provider eligibility.
    if (!read.ok) {
      return Object.freeze({
        state: "permitted",
        mode: "observe",
        main: "not_required",
        agent: "not_required",
      });
    }
    const existing = ledger.checkpoint.transitions.find(
      (transition) => transition.instance === request.transitionInstance,
    );
    if (existing !== undefined && !transitionMatches(existing, request)) {
      return Object.freeze({
        state: "permitted",
        mode: "observe",
        main: "not_required",
        agent: "not_required",
        snapshot: read.value,
      });
    }
    if (existing === undefined) {
      const historyEvidence = await this.#historyEvidence(request, read.value);
      if (historyEvidence === "unavailable") {
        return Object.freeze({
          state: "permitted",
          mode: "observe",
          main: "not_required",
          agent: "not_required",
          snapshot: read.value,
        });
      }
      const observedAt = this.#clock.now();
      const transition: WorkStatusLifecycleTransition = {
        step: request.step,
        instance: request.transitionInstance,
        ...(request.mainTarget === undefined ? {} : { mainTarget: request.mainTarget }),
        ...(request.allowedMainSources === undefined
          ? {}
          : { allowedMainSources: [...request.allowedMainSources] }),
        ...(request.agentTarget === undefined ? {} : { agentTarget: request.agentTarget }),
        main:
          request.mainTarget === undefined
            ? { state: "not_required" }
            : { state: "observed", observedAt, observedRevision: read.value.revision },
        agent:
          request.agentTarget === undefined
            ? { state: "not_required" }
            : { state: "observed", observedAt, observedRevision: read.value.revision },
        mainFailures: { count: 0 },
        agentFailures: { count: 0 },
        ...(historyEvidence === undefined ? {} : { historyEvidence }),
      };
      const saved = await this.#ledger.compareAndSwap(request.jobId, ledger.revision, {
        ...ledger.checkpoint,
        phase: request.phase,
        transitions: [...ledger.checkpoint.transitions, transition],
      });
      if (!saved.ok) {
        return Object.freeze({
          state: "permitted",
          mode: "observe",
          main: "not_required",
          agent: "not_required",
          snapshot: read.value,
        });
      }
    }
    return Object.freeze({
      state: "permitted",
      mode: "observe",
      main: request.mainTarget === undefined ? "not_required" : "observed",
      agent: request.agentTarget === undefined ? "not_required" : "observed",
      snapshot: read.value,
    });
  }

  async #enforce(
    request: WorkStatusLifecycleRequest,
    initialLedger: WorkStatusLifecycleLedgerSnapshot,
  ): Promise<WorkStatusLifecycleOutcome> {
    let ledger = initialLedger;
    let transition = ledger.checkpoint.transitions.find(
      (candidate) => candidate.instance === request.transitionInstance,
    );
    if (transition !== undefined && !transitionMatches(transition, request)) {
      return blocked("checkpoint_identity_mismatch", domainError("conflict"));
    }
    let initialSnapshot: WorkManagementIssueSnapshot | undefined;
    if (transition === undefined) {
      const initialRead = await this.#workManagement.getIssue(request.reference);
      if (!initialRead.ok) return blocked("provider_outage", initialRead.error);
      initialSnapshot = initialRead.value;
      const historyEvidence = await this.#historyEvidence(request, initialRead.value);
      if (historyEvidence === "unavailable") {
        return blocked("ledger_unavailable", domainError("external_failure"));
      }
      transition = {
        step: request.step,
        instance: request.transitionInstance,
        ...(request.mainTarget === undefined ? {} : { mainTarget: request.mainTarget }),
        ...(request.allowedMainSources === undefined
          ? {}
          : { allowedMainSources: [...request.allowedMainSources] }),
        ...(request.agentTarget === undefined ? {} : { agentTarget: request.agentTarget }),
        main:
          request.mainTarget === undefined
            ? { state: "not_required" }
            : {
                state: "intent",
                idempotencyKey: this.#idempotencyKey(request, "main"),
              },
        agent:
          request.agentTarget === undefined
            ? { state: "not_required" }
            : {
                state: "intent",
                idempotencyKey: this.#idempotencyKey(request, "agent"),
              },
        mainFailures: { count: 0 },
        agentFailures: { count: 0 },
        ...(historyEvidence === undefined ? {} : { historyEvidence }),
      };
      const saved = await this.#ledger.compareAndSwap(request.jobId, ledger.revision, {
        ...ledger.checkpoint,
        phase: request.phase,
        transitions: [...ledger.checkpoint.transitions, transition],
      });
      if (!saved.ok) return blocked("ledger_unavailable", saved.error);
      ledger = saved.value;
    }
    const read =
      initialSnapshot === undefined
        ? await this.#workManagement.getIssue(request.reference)
        : ({ ok: true as const, value: initialSnapshot } as const);
    if (!read.ok) return this.#mainReadFailure(request, ledger, transition, read.error);
    let snapshot = read.value;
    if (request.mainTarget !== undefined) {
      if (transition.main.state === "confirmed") {
        if (snapshot.workStatus !== request.mainTarget) {
          return blocked("human_status_drift", domainError("conflict"));
        }
      } else if (snapshot.workStatus === request.mainTarget) {
        if (transition.main.state === "sent_unknown") {
          const operatorAuthorized = ledger.checkpoint.recoveries?.some(
            (receipt) =>
              receipt.sourceTransitionInstance === transition?.instance &&
              receipt.disposition === "target_observed",
          );
          if (operatorAuthorized === true) {
            return Object.freeze({
              state: "permitted",
              mode: "enforce",
              main: "operator_authorized",
              agent: request.agentTarget === undefined ? "not_required" : "pending",
              snapshot,
            });
          }
          return blocked("authority_ambiguous", domainError("conflict"));
        }
        const confirmed = await this.#confirmChannel(
          request,
          ledger,
          transition,
          "main",
          snapshot.revision,
        );
        if (!confirmed.ok) return blocked("ledger_unavailable", confirmed.error);
        ledger = confirmed.ledger;
        transition = confirmed.transition;
      } else if (!(request.allowedMainSources ?? []).includes(snapshot.workStatus)) {
        const incident = await this.#ledger.compareAndSwap(request.jobId, ledger.revision, {
          ...ledger.checkpoint,
          incident: { reasonCode: "human_status_drift", channel: "main" },
        });
        return blocked("human_status_drift", incident.ok ? undefined : incident.error);
      } else {
        if (transition.mainFailures.lastInvocation === request.invocationDigest) {
          return blocked(
            transition.mainFailures.count >= retryLimit ? "retry_exhausted" : "main_unconfirmed",
          );
        }
        const cause = transitionCauseForStep(request.step);
        if (cause === undefined) {
          return blocked("checkpoint_identity_mismatch", domainError("invariant_violation"));
        }
        const changed = await this.#workManagement.setWorkStatus(
          request.reference,
          request.mainTarget,
          {
            idempotencyKey: this.#idempotencyKey(request, "main"),
            cause,
          },
        );
        if (!changed.ok)
          return this.#mainMutationFailure(request, ledger, transition, changed.error);
        if (changed.value.workStatus !== request.mainTarget) {
          return this.#mainMutationFailure(
            request,
            ledger,
            transition,
            domainError("external_failure"),
          );
        }
        snapshot = changed.value;
        const confirmed = await this.#confirmChannel(
          request,
          ledger,
          transition,
          "main",
          snapshot.revision,
        );
        if (!confirmed.ok) return blocked("ledger_unavailable", confirmed.error);
        ledger = confirmed.ledger;
        transition = confirmed.transition;
      }
    }

    if (request.agentTarget === undefined) {
      return Object.freeze({
        state: "permitted",
        mode: "enforce",
        main: request.mainTarget === undefined ? "not_required" : "confirmed",
        agent: "not_required",
        snapshot,
      });
    }
    const agent = await this.#settleAgent(request, ledger, transition, snapshot);
    return Object.freeze({
      state: "permitted",
      mode: "enforce",
      main: request.mainTarget === undefined ? "not_required" : "confirmed",
      agent: agent.confirmed ? "confirmed" : "pending",
      snapshot: agent.snapshot,
    });
  }

  async #settleAgent(
    request: WorkStatusLifecycleRequest,
    ledger: WorkStatusLifecycleLedgerSnapshot,
    transition: WorkStatusLifecycleTransition,
    snapshot: WorkManagementIssueSnapshot,
  ): Promise<{ readonly confirmed: boolean; readonly snapshot: WorkManagementIssueSnapshot }> {
    const target = request.agentTarget;
    if (target === undefined) return { confirmed: true, snapshot };
    if (transition.agent.state === "confirmed") {
      return { confirmed: targetMatches(snapshot, target), snapshot };
    }
    if (transition.agent.state === "sent_unknown") {
      return { confirmed: false, snapshot };
    }
    if (targetMatches(snapshot, target)) {
      const confirmed = await this.#confirmChannel(
        request,
        ledger,
        transition,
        "agent",
        snapshot.revision,
      );
      return { confirmed: confirmed.ok, snapshot };
    }
    if (transition.agentFailures.lastInvocation === request.invocationDigest) {
      return { confirmed: false, snapshot };
    }
    let changed;
    if (target.kind === "clear") {
      // A clear is destructive to human labels unless the ledger proves this Controller set the
      // exact condition currently visible. A recognized label name alone is never ownership.
      const controllerOwned = [...ledger.checkpoint.transitions]
        .reverse()
        .some(
          (candidate) =>
            candidate.agentTarget?.kind === "set" &&
            candidate.agent.state === "confirmed" &&
            targetMatches(snapshot, candidate.agentTarget),
        );
      if (!controllerOwned) return { confirmed: false, snapshot };
      changed = await this.#workManagement.clearAgentCondition(request.reference, {
        idempotencyKey: this.#idempotencyKey(request, "agent"),
      });
    } else {
      let condition;
      try {
        condition = createAgentCondition(
          target.status,
          target.blockingReason === undefined ? [] : [target.blockingReason],
        );
      } catch {
        return { confirmed: false, snapshot };
      }
      changed = await this.#workManagement.setAgentCondition(request.reference, condition, {
        idempotencyKey: this.#idempotencyKey(request, "agent"),
      });
    }
    if (!changed.ok || !targetMatches(changed.value, target)) {
      const error = changed.ok ? domainError("external_failure") : changed.error;
      await this.#recordFailure(request, ledger, transition, "agent", error);
      return { confirmed: false, snapshot };
    }
    const confirmed = await this.#confirmChannel(
      request,
      ledger,
      transition,
      "agent",
      changed.value.revision,
    );
    return { confirmed: confirmed.ok, snapshot: changed.value };
  }

  async #mainReadFailure(
    request: WorkStatusLifecycleRequest,
    ledger: WorkStatusLifecycleLedgerSnapshot,
    transition: WorkStatusLifecycleTransition,
    error: DomainError,
  ): Promise<WorkStatusLifecycleOutcome> {
    if (failureIsProviderWide(error)) return blocked("provider_outage", error);
    const recorded = await this.#recordFailure(request, ledger, transition, "main", error);
    if (!recorded.saved) return blocked("ledger_unavailable", recorded.error);
    return blocked(recorded.exhausted ? "retry_exhausted" : "main_unconfirmed", error);
  }

  async #mainMutationFailure(
    request: WorkStatusLifecycleRequest,
    ledger: WorkStatusLifecycleLedgerSnapshot,
    transition: WorkStatusLifecycleTransition,
    error: DomainError,
  ): Promise<WorkStatusLifecycleOutcome> {
    if (failureIsProviderWide(error)) return blocked("provider_outage", error);
    const recorded = await this.#recordFailure(request, ledger, transition, "main", error);
    if (!recorded.saved) return blocked("ledger_unavailable", recorded.error);
    return blocked(recorded.exhausted ? "retry_exhausted" : "main_unconfirmed", error);
  }

  async #recordFailure(
    request: WorkStatusLifecycleRequest,
    ledger: WorkStatusLifecycleLedgerSnapshot,
    transition: WorkStatusLifecycleTransition,
    channel: "main" | "agent",
    error: DomainError,
  ): Promise<{
    readonly saved: boolean;
    readonly exhausted: boolean;
    readonly error?: DomainError;
  }> {
    const counter = channel === "main" ? transition.mainFailures : transition.agentFailures;
    if (counter.lastInvocation === request.invocationDigest) {
      return { saved: true, exhausted: counter.count >= retryLimit };
    }
    const nextCount = Math.min(retryLimit, counter.count + 1);
    const receipt = channel === "main" ? transition.main : transition.agent;
    const nextReceipt = failureMayHaveMutated(error)
      ? {
          state: "sent_unknown" as const,
          idempotencyKey:
            receipt.state === "intent" || receipt.state === "sent_unknown"
              ? receipt.idempotencyKey
              : this.#idempotencyKey(request, channel),
          errorCode: error.code,
        }
      : receipt;
    const nextTransition: WorkStatusLifecycleTransition = {
      ...transition,
      ...(channel === "main"
        ? {
            main: nextReceipt,
            mainFailures: {
              count: nextCount,
              lastErrorCode: error.code,
              lastInvocation: request.invocationDigest,
            },
          }
        : {
            agent: nextReceipt,
            agentFailures: {
              count: nextCount,
              lastErrorCode: error.code,
              lastInvocation: request.invocationDigest,
            },
          }),
    };
    const checkpoint = replaceTransition(ledger.checkpoint, nextTransition);
    const saved = await this.#ledger.compareAndSwap(request.jobId, ledger.revision, {
      ...checkpoint,
      ...(nextCount < retryLimit
        ? {}
        : { incident: { reasonCode: "retry_exhausted" as const, channel } }),
    });
    return saved.ok
      ? { saved: true, exhausted: nextCount >= retryLimit }
      : { saved: false, exhausted: false, error: saved.error };
  }

  async #confirmChannel(
    request: WorkStatusLifecycleRequest,
    ledger: WorkStatusLifecycleLedgerSnapshot,
    transition: WorkStatusLifecycleTransition,
    channel: "main" | "agent",
    observedRevision: string,
  ): Promise<
    | Readonly<{
        ok: true;
        ledger: WorkStatusLifecycleLedgerSnapshot;
        transition: WorkStatusLifecycleTransition;
      }>
    | Readonly<{ ok: false; error: DomainError }>
  > {
    const current = channel === "main" ? transition.main : transition.agent;
    if (current.state === "confirmed") return { ok: true, ledger, transition };
    if (current.state === "not_required" || current.state === "observed") {
      return { ok: false, error: domainError("invariant_violation") };
    }
    if (current.state === "sent_unknown") {
      return { ok: false, error: domainError("conflict") };
    }
    const confirmed = {
      state: "confirmed" as const,
      idempotencyKey: current.idempotencyKey,
      confirmedAt: this.#clock.now(),
      observedRevision,
    };
    const nextTransition: WorkStatusLifecycleTransition = {
      ...transition,
      ...(channel === "main"
        ? { main: confirmed, mainFailures: { count: 0 } }
        : { agent: confirmed, agentFailures: { count: 0 } }),
    };
    const saved = await this.#ledger.compareAndSwap(
      request.jobId,
      ledger.revision,
      replaceTransition(ledger.checkpoint, nextTransition),
    );
    return saved.ok
      ? { ok: true, ledger: saved.value, transition: nextTransition }
      : { ok: false, error: saved.error };
  }

  #idempotencyKey(request: WorkStatusLifecycleRequest, channel: "main" | "agent"): string {
    return `work-status-lifecycle:${request.jobId}:${request.transitionInstance}:${channel}`;
  }

  async #historyEvidence(
    request: WorkStatusLifecycleRequest,
    snapshot: WorkManagementIssueSnapshot,
  ): Promise<TransitionHistoryEvidence | undefined | "unavailable"> {
    if (request.mainTarget === undefined || this.#history === undefined) return undefined;
    const history = await this.#history.getIssueHistory(request.reference);
    if (!history.ok) return "unavailable";
    if (
      snapshot.workStatusStateId === undefined ||
      history.value.currentStateId !== snapshot.workStatusStateId
    ) {
      return "unavailable";
    }
    const targetStateId = history.value.stateIdByWorkStatus[request.mainTarget];
    const span = [...history.value.stateSpans]
      .reverse()
      .find(
        (candidate) =>
          candidate.stateId === history.value.currentStateId && candidate.endedAt === null,
      );
    const digest = sha256Digest({ schemaVersion: 1, entries: history.value.entries });
    if (span === undefined || !digest.ok) return "unavailable";
    const tail = history.value.entries.at(-1);
    return Object.freeze({
      preStateId: history.value.currentStateId,
      targetStateId,
      observedRevision: snapshot.revision,
      historyPrefixDigest: digest.value,
      historyEntryCount: history.value.entries.length,
      ...(tail === undefined ? {} : { historyTailId: tail.id }),
      preStateSpanId: span.id,
    });
  }
}
