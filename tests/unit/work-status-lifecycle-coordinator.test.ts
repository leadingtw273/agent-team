import { describe, expect, it } from "vitest";

import { WorkStatusLifecycleCoordinator } from "../../src/application/pipelines/work-status-lifecycle-coordinator.js";
import type {
  IssueScopeLockPort,
  WorkStatusLifecycleCheckpoint,
  WorkStatusLifecycleLedgerPort,
  WorkStatusLifecycleRequest,
} from "../../src/application/pipelines/work-status-lifecycle-model.js";
import type {
  WorkManagementIssueSnapshot,
  WorkStatusMutationOptions,
} from "../../src/application/ports/index.js";
import {
  createFixedClock,
  domainError,
  err,
  ok,
  parseIdentifier,
  parseInstant,
  type DomainError,
  type Identifier,
  type Instant,
} from "../../src/domain/foundation/index.js";
import { issueSchema, projectSchema } from "../../src/domain/project/index.js";
import {
  createAgentCondition,
  transitionWorkStatus,
  type WorkStatus,
} from "../../src/domain/workflow/index.js";

function id<Scope extends string>(scope: Scope, value: string): Identifier<Scope> {
  const parsed = parseIdentifier(scope, value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const project = projectSchema.parse({
  schemaVersion: 1,
  id: id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab"),
  displayName: "Sandbox",
  localRepositoryPath: "/tmp/sandbox",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "team-1", projectId: "linear-project" },
  sourceControl: { provider: "github", repository: "owner/sandbox" },
});
const issue = issueSchema.parse({
  schemaVersion: 1,
  id: id("issue", "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab"),
  projectId: project.id,
  externalId: "linear-53",
  title: "Lifecycle test",
});
function instant(value: string): Instant {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}
const now = instant("2026-08-18T01:00:00.000Z");
const jobId = "job_018f47d2-77a4-7cc1-8ef2-0123456789ab";

function snapshot(
  workStatus: WorkStatus = "ready",
  agentCondition = createAgentCondition("queued"),
  revision = "linear-revision-1",
): WorkManagementIssueSnapshot {
  return {
    issue,
    workStatus,
    agentCondition,
    updatedAt: now,
    revision,
  };
}

class FakeWorkManagement {
  current = snapshot();
  getCalls = 0;
  setStatusCalls = 0;
  statusCauses: WorkStatusMutationOptions["cause"][] = [];
  setAgentCalls = 0;
  clearAgentCalls = 0;
  getError: DomainError | undefined;
  statusError: DomainError | undefined;
  agentError: DomainError | undefined;
  mutateBeforeStatusError = false;
  enforceDomainTransitions = false;

  getIssue() {
    this.getCalls += 1;
    return Promise.resolve(this.getError === undefined ? ok(this.current) : err(this.getError));
  }

  setWorkStatus(_reference: unknown, status: WorkStatus, options: WorkStatusMutationOptions) {
    this.setStatusCalls += 1;
    this.statusCauses.push(options.cause);
    if (this.statusError !== undefined) {
      if (this.mutateBeforeStatusError) {
        this.current = { ...this.current, workStatus: status, revision: "linear-revision-mutated" };
      }
      return Promise.resolve(err(this.statusError));
    }
    if (this.enforceDomainTransitions) {
      if (options.cause === undefined) return Promise.resolve(err(domainError("conflict")));
      const transition = transitionWorkStatus(this.current.workStatus, {
        target: status,
        cause: options.cause,
      });
      if (!transition.ok) return Promise.resolve(err(transition.error));
    }
    this.current = { ...this.current, workStatus: status, revision: "linear-revision-2" };
    return Promise.resolve(ok(this.current));
  }

  setAgentCondition(
    _reference: unknown,
    condition: NonNullable<WorkManagementIssueSnapshot["agentCondition"]>,
  ) {
    this.setAgentCalls += 1;
    if (this.agentError !== undefined) return Promise.resolve(err(this.agentError));
    this.current = { ...this.current, agentCondition: condition, revision: "linear-revision-3" };
    return Promise.resolve(ok(this.current));
  }

  clearAgentCondition() {
    this.clearAgentCalls += 1;
    const { agentCondition: _condition, ...withoutCondition } = this.current;
    void _condition;
    this.current = { ...withoutCondition, revision: "linear-revision-4" };
    return Promise.resolve(ok(this.current));
  }
}

class FakeLedger implements WorkStatusLifecycleLedgerPort {
  revision = 0;
  checkpoint: WorkStatusLifecycleCheckpoint;
  saveCalls = 0;
  conflictOnSave?: number;

  constructor(mode: "observe" | "enforce" = "enforce") {
    this.checkpoint = {
      admissionMode: mode,
      capabilityDigest: "c".repeat(64),
      phase: "work_start",
      transitions: [],
    };
  }

  load() {
    return Promise.resolve(ok({ revision: this.revision, checkpoint: this.checkpoint }));
  }

  compareAndSwap(
    _jobId: string,
    expectedRevision: number,
    checkpoint: WorkStatusLifecycleCheckpoint,
  ) {
    this.saveCalls += 1;
    if (this.conflictOnSave === this.saveCalls || expectedRevision !== this.revision) {
      return Promise.resolve(err(domainError("conflict")));
    }
    this.revision += 1;
    this.checkpoint = structuredClone(checkpoint);
    return Promise.resolve(ok({ revision: this.revision, checkpoint: this.checkpoint }));
  }
}

class FakeLock implements IssueScopeLockPort {
  acquireCalls = 0;
  releaseCalls = 0;
  conflict = false;

  acquire(_scope: unknown, holderId: string) {
    this.acquireCalls += 1;
    if (this.conflict) return Promise.resolve(err(domainError("conflict")));
    return Promise.resolve(
      ok({
        scopeDigest: "d".repeat(64),
        holderId,
        release: () => {
          this.releaseCalls += 1;
          return Promise.resolve(ok(undefined));
        },
      }),
    );
  }
}

function request(overrides: Partial<WorkStatusLifecycleRequest> = {}): WorkStatusLifecycleRequest {
  return {
    jobId,
    reference: { project, externalIssueId: issue.externalId },
    holderId: "dispatch:job-53",
    mode: "enforce",
    capabilityDigest: "c".repeat(64),
    phase: "work_start",
    step: "work_start",
    transitionInstance: "a".repeat(64),
    invocationDigest: "1".repeat(64),
    mainTarget: "in_progress",
    allowedMainSources: ["ready"],
    agentTarget: { kind: "set", status: "executing" },
    ...overrides,
  };
}

function harness(mode: "observe" | "enforce" = "enforce") {
  const workManagement = new FakeWorkManagement();
  const ledger = new FakeLedger(mode);
  const locks = new FakeLock();
  const coordinator = new WorkStatusLifecycleCoordinator({
    workManagement,
    ledger,
    locks,
    clock: createFixedClock(now),
  });
  return { workManagement, ledger, locks, coordinator };
}

describe("WorkStatusLifecycleCoordinator", () => {
  it("off mode still takes the shared Issue lock but performs zero probe, ledger, or Linear mutation", async () => {
    const test = harness();
    const { capabilityDigest: _capabilityDigest, ...offRequest } = request({ mode: "off" });
    void _capabilityDigest;
    const result = await test.coordinator.transition(offRequest);
    expect(result).toEqual({
      state: "permitted",
      mode: "off",
      main: "not_required",
      agent: "not_required",
    });
    expect(test.locks.acquireCalls).toBe(1);
    expect(test.locks.releaseCalls).toBe(1);
    expect(test.workManagement.getCalls + test.workManagement.setStatusCalls).toBe(0);
    expect(test.ledger.saveCalls).toBe(0);
  });

  it("observe records authoritative observations with zero Linear mutation and does not gate work", async () => {
    const test = harness("observe");
    const result = await test.coordinator.transition(request({ mode: "observe" }));
    expect(result).toMatchObject({
      state: "permitted",
      mode: "observe",
      main: "observed",
      agent: "observed",
    });
    expect(test.workManagement.getCalls).toBe(1);
    expect(test.workManagement.setStatusCalls + test.workManagement.setAgentCalls).toBe(0);
    expect(test.ledger.checkpoint.transitions[0]).toMatchObject({
      main: { state: "observed" },
      agent: { state: "observed" },
    });
  });

  it("observe remains telemetry-only when the provider read fails", async () => {
    const test = harness("observe");
    test.workManagement.getError = domainError("unavailable");

    await expect(test.coordinator.transition(request({ mode: "observe" }))).resolves.toEqual({
      state: "permitted",
      mode: "observe",
      main: "not_required",
      agent: "not_required",
    });
    expect(test.workManagement.setStatusCalls + test.workManagement.setAgentCalls).toBe(0);
  });

  it("observe permits work without a capability digest and ignores a telemetry CAS failure", async () => {
    const test = harness("observe");
    test.ledger.conflictOnSave = 1;
    const { capabilityDigest: _capabilityDigest, ...withoutCapability } = request({
      mode: "observe",
    });
    void _capabilityDigest;

    await expect(test.coordinator.transition(withoutCapability)).resolves.toMatchObject({
      state: "permitted",
      mode: "observe",
      main: "not_required",
      agent: "not_required",
    });
    expect(test.workManagement.setStatusCalls + test.workManagement.setAgentCalls).toBe(0);
  });

  it("enforce confirms main before permitting Provider work and retries the same transition without another mutation", async () => {
    const test = harness();
    const first = await test.coordinator.transition(request());
    const replay = await test.coordinator.transition(request({ invocationDigest: "2".repeat(64) }));
    expect(first).toMatchObject({ state: "permitted", main: "confirmed", agent: "confirmed" });
    expect(replay).toMatchObject({ state: "permitted", main: "confirmed", agent: "confirmed" });
    expect(test.workManagement.setStatusCalls).toBe(1);
    expect(test.workManagement.statusCauses).toEqual(["work_started"]);
    expect(test.workManagement.setAgentCalls).toBe(1);
    expect(test.ledger.checkpoint.transitions[0]).toMatchObject({
      main: { state: "confirmed" },
      agent: { state: "confirmed" },
    });
  });

  it("uses changes_requested authority for the in-review to in-progress fix transition", async () => {
    const test = harness();
    test.workManagement.current = snapshot("in_review", createAgentCondition("waiting"));

    const result = await test.coordinator.transition(
      request({
        phase: "fixing",
        step: "fix_start",
        mainTarget: "in_progress",
        allowedMainSources: ["in_review", "in_progress"],
        agentTarget: { kind: "set", status: "executing" },
      }),
    );

    expect(result).toMatchObject({ state: "permitted", main: "confirmed", agent: "confirmed" });
    expect(test.workManagement.statusCauses).toEqual(["changes_requested"]);
  });

  it("a post-mutation checkpoint CAS conflict never returns Provider permission", async () => {
    const test = harness();
    test.ledger.conflictOnSave = 2;
    const result = await test.coordinator.transition(request());
    expect(result).toMatchObject({ state: "blocked", reason: "ledger_unavailable" });
    expect(test.workManagement.setStatusCalls).toBe(1);
    expect(test.workManagement.setAgentCalls).toBe(0);
  });

  it("a label failure remains observable but does not revoke a confirmed main-state gate", async () => {
    const test = harness();
    test.workManagement.agentError = domainError("external_failure");
    const result = await test.coordinator.transition(request());
    expect(result).toMatchObject({ state: "permitted", main: "confirmed", agent: "pending" });
    expect(test.ledger.checkpoint.transitions[0]).toMatchObject({
      main: { state: "confirmed" },
      agentFailures: { count: 1 },
    });
  });

  it("never clears a recognized Agent condition without a confirmed Controller ownership receipt", async () => {
    const test = harness();
    test.workManagement.current = snapshot("completed", createAgentCondition("queued"));

    const result = await test.coordinator.transition(
      request({
        phase: "terminal",
        step: "complete",
        mainTarget: "completed",
        allowedMainSources: ["completed"],
        agentTarget: { kind: "clear" },
      }),
    );

    expect(result).toMatchObject({ state: "permitted", main: "confirmed", agent: "pending" });
    expect(test.workManagement.clearAgentCalls).toBe(0);
  });

  it("clears the exact Agent condition previously confirmed as Controller-owned", async () => {
    const test = harness();
    await test.coordinator.transition(request());

    const result = await test.coordinator.transition(
      request({
        phase: "terminal",
        step: "complete",
        transitionInstance: "b".repeat(64),
        invocationDigest: "2".repeat(64),
        mainTarget: "completed",
        allowedMainSources: ["in_progress", "completed"],
        agentTarget: { kind: "clear" },
      }),
    );

    expect(result).toMatchObject({ state: "permitted", main: "confirmed", agent: "confirmed" });
    expect(test.workManagement.clearAgentCalls).toBe(1);
  });

  it("uses the ready-gate cause when clearing an exact requires-manual condition", async () => {
    const test = harness();
    test.workManagement.current = {
      ...snapshot("requires_manual", createAgentCondition("blocked", ["integration_failure"])),
    };
    test.ledger.checkpoint.transitions.push({
      step: "requires_manual",
      instance: "e".repeat(64),
      mainTarget: "requires_manual",
      allowedMainSources: ["in_progress"],
      agentTarget: {
        kind: "set",
        status: "blocked",
        blockingReason: "integration_failure",
      },
      main: {
        state: "confirmed",
        idempotencyKey: "manual:main",
        confirmedAt: now,
        observedRevision: "linear-manual",
      },
      agent: {
        state: "confirmed",
        idempotencyKey: "manual:agent",
        confirmedAt: now,
        observedRevision: "linear-manual",
      },
      mainFailures: { count: 0 },
      agentFailures: { count: 0 },
    });

    const result = await test.coordinator.transition(
      request({
        phase: "work_start",
        step: "clear_condition",
        transitionInstance: "f".repeat(64),
        mainTarget: "ready",
        allowedMainSources: ["requires_manual"],
        agentTarget: { kind: "clear" },
      }),
    );

    expect(result).toMatchObject({ state: "permitted", main: "confirmed", agent: "confirmed" });
    expect(test.workManagement.statusCauses).toEqual(["ready_gate_passed"]);
    expect(test.workManagement.clearAgentCalls).toBe(1);
  });

  it("restores a Controller-owned requires-manual issue to review after observing its GitHub merge", async () => {
    const test = harness();
    test.workManagement.enforceDomainTransitions = true;
    test.workManagement.current = snapshot(
      "requires_manual",
      createAgentCondition("blocked", ["unknown_error"]),
    );
    test.ledger.checkpoint.transitions.push({
      step: "requires_manual",
      instance: "e".repeat(64),
      mainTarget: "requires_manual",
      allowedMainSources: ["in_review"],
      agentTarget: { kind: "set", status: "blocked", blockingReason: "unknown_error" },
      main: {
        state: "confirmed",
        idempotencyKey: "manual:main",
        confirmedAt: now,
        observedRevision: "linear-manual",
      },
      agent: {
        state: "confirmed",
        idempotencyKey: "manual:agent",
        confirmedAt: now,
        observedRevision: "linear-manual",
      },
      mainFailures: { count: 0 },
      agentFailures: { count: 0 },
    });

    const result = await test.coordinator.transition(
      request({
        phase: "terminal",
        step: "complete",
        transitionInstance: "f".repeat(64),
        mainTarget: "in_review",
        allowedMainSources: ["in_progress", "in_review", "requires_manual"],
        agentTarget: { kind: "clear" },
      }),
    );

    expect(result).toMatchObject({ state: "permitted", main: "confirmed", agent: "confirmed" });
    expect(test.workManagement.statusCauses).toEqual(["github_merge_observed"]);
    expect(test.workManagement.clearAgentCalls).toBe(1);
  });

  it("fails closed on human main-status drift without any mutation", async () => {
    const test = harness();
    test.workManagement.current = snapshot("backlog");
    const result = await test.coordinator.transition(request());
    expect(result).toMatchObject({ state: "blocked", reason: "human_status_drift" });
    expect(test.workManagement.setStatusCalls).toBe(0);
    expect(test.ledger.checkpoint.incident).toEqual({
      reasonCode: "human_status_drift",
      channel: "main",
    });
  });

  it("bounds per-transition mutation failures at six and deduplicates the same invocation", async () => {
    const test = harness();
    test.workManagement.statusError = domainError("external_failure");
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const result = await test.coordinator.transition(
        request({ invocationDigest: attempt.toString(16).padStart(64, "0") }),
      );
      expect(result).toMatchObject({
        state: "blocked",
        reason: attempt === 6 ? "retry_exhausted" : "main_unconfirmed",
      });
    }
    const duplicate = await test.coordinator.transition(
      request({ invocationDigest: "6".padStart(64, "0") }),
    );
    expect(duplicate).toMatchObject({ state: "blocked", reason: "retry_exhausted" });
    expect(test.workManagement.setStatusCalls).toBe(6);
    expect(test.ledger.checkpoint.transitions[0]?.mainFailures.count).toBe(6);
  });

  it("does not charge per-issue retries when Linear reports a provider-wide outage", async () => {
    const test = harness();
    test.workManagement.statusError = domainError("unavailable");
    const result = await test.coordinator.transition(request());
    expect(result).toMatchObject({ state: "blocked", reason: "provider_outage" });
    expect(test.ledger.checkpoint.transitions[0]?.mainFailures.count).toBe(0);
  });

  it("keeps sent_unknown authority-ambiguous even when read-first sees the target", async () => {
    const test = harness();
    test.workManagement.statusError = domainError("timeout");
    test.workManagement.mutateBeforeStatusError = true;
    const first = await test.coordinator.transition(request());
    expect(first).toMatchObject({ state: "blocked", reason: "main_unconfirmed" });
    expect(test.ledger.checkpoint.transitions[0]?.main.state).toBe("sent_unknown");

    test.workManagement.statusError = undefined;
    const settled = await test.coordinator.transition(
      request({ invocationDigest: "2".repeat(64) }),
    );
    expect(settled).toMatchObject({ state: "blocked", reason: "authority_ambiguous" });
    expect(test.ledger.checkpoint.transitions[0]?.main.state).toBe("sent_unknown");
    expect(test.workManagement.setStatusCalls).toBe(1);
  });

  it("lock conflict rejects all reads and mutations", async () => {
    const test = harness();
    test.locks.conflict = true;
    const result = await test.coordinator.transition(request());
    expect(result).toMatchObject({ state: "blocked", reason: "lock_conflict" });
    expect(test.workManagement.getCalls).toBe(0);
    expect(test.ledger.saveCalls).toBe(0);
  });
});
