/**
 * C015o decision 3 unit tests: `dispatchOnce`'s (src/cli/dispatch/composition.ts) admission-claim
 * wiring -- the durable, per-issue guard against dispatching a second `Job` for an issue that
 * already has one unresolved (see issue-admission-store.ts's own header, and this file's sibling
 * `dispatch-issue-admission-store.test.ts` for the store's own CAS-atomicity tests in isolation).
 * Real, file-backed `FileLeaseRepository`/`FileJobRepository`/`FileIssueAdmissionStore` against a
 * temp state root -- the exact ports shape `dispatchOnce` builds for a genuine (non-dry-run) run.
 *
 * Covers: (1) a pre-existing active claim (simulating a job that reached `requires_manual` after
 * its lease was already released -- acceptance criterion "lease TTL 過期後仍被 admission 擋下")
 * blocks a fresh dispatch attempt for the same issue entirely, reported via `admissionSkipped`,
 * and the engine's `Dispatcher` never creates a second `Job`; (2) a successful dispatch attaches
 * the real job id to its claim; (3) two genuinely concurrent `dispatchOnce` calls for the same
 * single candidate -- only one wins the claim and dispatches (acceptance criterion "兩個
 * dispatcher 競爭時最多一個 claim 成功", exercised here at the composition level, not just the
 * store's own already-tested atomicity); (4) a call that dispatches nothing releases every claim
 * it tentatively made, leaving the issue claimable again.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { dispatchOnce, type DispatchCompositionReady } from "../../src/cli/dispatch/composition.js";
import { FileIssueAdmissionStore } from "../../src/adapters/dispatch/issue-admission-store.js";
import type { LinearDiscoveryReadModel } from "../../src/adapters/dispatch/linear-discovery.js";
import {
  buildLinearReadCatalog,
  linearAgentRoleNames,
  linearAgentStatusNames,
  linearBlockingReasonNames,
  linearReviewRequirementNames,
  linearWorkStatusNames,
  type LinearLabelRecord,
  type LinearProjectContext,
  type LinearWorkflowStateRecord,
} from "../../src/adapters/linear/model.js";
import { LeaseCoordinator } from "../../src/application/leases/index.js";
import type { ProjectRegistrySnapshot } from "../../src/application/projects/index.js";
import { trustedProjectConfigSchema } from "../../src/application/projects/index.js";
import type { ModelRoutingConfig } from "../../src/application/routing/index.js";
import {
  ok,
  parseIdentifier,
  parseInstant,
  type Identifier,
  type Instant,
} from "../../src/domain/foundation/index.js";
import type { ProcessPort } from "../../src/application/ports/index.js";
import {
  agentRoleSchema,
  projectSchema,
  reviewRequirementSchema,
  type Project,
} from "../../src/domain/project/index.js";
import { agentStatuses, blockingReasons } from "../../src/domain/workflow/index.js";
import { readyGateTemplateHeadings } from "../../src/application/registration/linear-provision-model.js";
import { FileJobRepository } from "../../src/infrastructure/jobs/index.js";
import { FileLeaseRepository } from "../../src/infrastructure/leases/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryStateRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-dispatch-once-admission-"));
  temporaryDirectories.push(directory);
  return directory;
}

function id<Scope extends string>(scope: Scope, value: string): Identifier<Scope> {
  const parsed = parseIdentifier(scope, value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function instant(value: string): Instant {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const projectId = id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const now = instant("2026-08-07T12:00:00.000Z");

function project(): Project {
  return projectSchema.parse({
    schemaVersion: 1,
    id: projectId,
    displayName: "Sandbox",
    localRepositoryPath: "/tmp/sandbox",
    defaultBranch: "main",
    workManagement: { provider: "linear", containerId: "team-1", projectId: "linear-proj-1" },
    sourceControl: { provider: "github", repository: "owner/sandbox" },
  });
}

function registry(): ProjectRegistrySnapshot {
  const projectValue = project();
  const config = trustedProjectConfigSchema.parse({
    schemaVersion: 1,
    projectId,
    defaultBranch: "main",
    platforms: {
      workManagement: projectValue.workManagement,
      sourceControl: projectValue.sourceControl,
    },
    projectRules: [],
    roleInstructions: {},
    commands: { quality: [{ executable: "pnpm", arguments: ["test"] }], visualReview: [] },
  });
  return {
    ready: [{ state: "ready", project: projectValue, config, revisionSha: "a".repeat(40) }],
    rejected: [],
  };
}

// `modelRoutingConfigSchema` requires exactly one route per agent role (all five) -- only the
// `implementer` route matters for this fixture's single model-work candidate, but the schema
// itself fails closed if any role is missing. Must route `implementer` to claude/opus, matching
// `ready.claude.config.models` (["opus"]) -- `observeClaudeRouteCandidates` (composition.ts)
// only ever produces observations for provider "claude".
const routingConfig: ModelRoutingConfig = {
  schemaVersion: 1,
  routes: [
    { role: "team_lead", candidates: [{ provider: "codex", model: "lead" }] },
    { role: "implementer", candidates: [{ provider: "claude", model: "opus" }] },
    { role: "code_reviewer", candidates: [{ provider: "codex", model: "review" }] },
    { role: "visual_reviewer", candidates: [{ provider: "gemini", model: "visual" }] },
    { role: "integration_engineer", candidates: [{ provider: "claude", model: "integrate" }] },
  ],
};

/** Same technique as tests/integration/dispatch-run-end-to-end.test.ts's own `linearProjectContext`. */
function linearProjectContext(): LinearProjectContext {
  const states: LinearWorkflowStateRecord[] = Object.entries(linearWorkStatusNames).map(
    ([status, name], index) => ({ id: `state-${status}-${String(index)}`, name, type: status }),
  );
  function group(groupName: string, groupId: string): LinearLabelRecord {
    return { id: groupId, name: groupName, isGroup: true, parentId: null };
  }
  function child(name: string, parentId: string, childId: string): LinearLabelRecord {
    return { id: childId, name, isGroup: false, parentId };
  }
  const groupIds = {
    agentRole: "label-group-agent-role",
    reviewRequirement: "label-group-review-requirement",
    agentStatus: "label-group-agent-status",
    blockingReason: "label-group-blocking-reason",
  };
  const labels: LinearLabelRecord[] = [
    group("Agent 角色", groupIds.agentRole),
    ...agentRoleSchema.options.map((key, index) =>
      child(linearAgentRoleNames[key], groupIds.agentRole, `label-agent-role-${String(index)}`),
    ),
    group("審查需求", groupIds.reviewRequirement),
    ...reviewRequirementSchema.options.map((key, index) =>
      child(
        linearReviewRequirementNames[key],
        groupIds.reviewRequirement,
        `label-review-requirement-${String(index)}`,
      ),
    ),
    group("Agent 狀態", groupIds.agentStatus),
    ...agentStatuses.map((key, index) =>
      child(
        linearAgentStatusNames[key],
        groupIds.agentStatus,
        `label-agent-status-${String(index)}`,
      ),
    ),
    group("阻塞原因", groupIds.blockingReason),
    ...blockingReasons.map((key, index) =>
      child(
        linearBlockingReasonNames[key],
        groupIds.blockingReason,
        `label-blocking-reason-${String(index)}`,
      ),
    ),
  ];
  const catalog = buildLinearReadCatalog(states, labels);
  if (!catalog.ok) throw new Error("fixture invariant violated: catalog must build cleanly");
  return Object.freeze({
    team: Object.freeze({ id: "team-1", name: "Team", key: "TM" }),
    project: Object.freeze({ id: "linear-proj-1", name: "Project" }),
    catalog: catalog.value,
  });
}

function readyGateDescription(): string {
  return `## ${readyGateTemplateHeadings.goal}
確保 admission claim 阻擋重複派工。

## ${readyGateTemplateHeadings.background}
C015o 決策 3 驗收。

## ${readyGateTemplateHeadings.acceptanceCriteria}
- 只建立一次 job

## ${readyGateTemplateHeadings.inScope}
- src/feature

## ${readyGateTemplateHeadings.outOfScope}
- reviewer pipeline

## ${readyGateTemplateHeadings.dependencies}
無

## ${readyGateTemplateHeadings.estimatedMinutes}
30

## ${readyGateTemplateHeadings.constraints}

## ${readyGateTemplateHeadings.risks}

## ${readyGateTemplateHeadings.changeRegions}
- src/feature/index.ts
`;
}

function readModel(externalIssueId: string): LinearDiscoveryReadModel {
  return {
    readContext: () => Promise.resolve(ok(linearProjectContext())),
    listIssueIdsInState: () => Promise.resolve(ok([externalIssueId])),
    readIssue: () =>
      Promise.resolve(
        ok({
          id: externalIssueId,
          identifier: "SBX-1",
          title: "Ship the thing",
          description: readyGateDescription(),
          updatedAt: now,
          teamId: "team-1",
          projectId: "linear-proj-1",
          workStatus: "ready" as const,
          agentRole: "implementer" as const,
          reviewRequirement: "code_review" as const,
          priority: "high" as const,
          otherLabelIds: [],
          relations: [],
          comments: [],
        }),
      ),
  };
}

function readyComposition(stateRoot: string, externalIssueId: string): DispatchCompositionReady {
  return {
    leases: new FileLeaseRepository(join(stateRoot, "leases.json"), join(stateRoot, "leases.lock")),
    jobs: new FileJobRepository(join(stateRoot, "jobs.json"), join(stateRoot, "jobs.lock")),
    registry: registry(),
    routingConfig,
    discovery: {
      teamId: "team-1",
      linearProjectId: "linear-proj-1",
      readModel: readModel(externalIssueId) as never,
      mutationClient: {} as never,
    },
    project: project(),
    trustedConfig: registry().ready[0]?.config as never,
    claude: {
      config: { executable: "claude", models: ["opus"], account: "default" },
      process: new ReadyClaudeProcessPort(),
    },
  };
}

/** `dispatchOnce` genuinely calls `observeClaudeRouteCandidates`, a real (non-tripwire) probe --
 * same fixture technique as tests/integration/dispatch-run-end-to-end.test.ts's own
 * `ReadyClaudeProcessPort`, reports the Claude capability probe as alive without spawning any
 * real process. */
class ReadyClaudeProcessPort implements ProcessPort {
  spawn(): ReturnType<ProcessPort["spawn"]> {
    return Promise.resolve(
      ok({
        pid: 1,
        output: (async function* () {
          await Promise.resolve();
        })(),
        writeStdin: () => Promise.resolve(ok(undefined)),
        closeStdin: () => Promise.resolve(ok(undefined)),
        sendSignal: () => Promise.resolve(ok(undefined)),
        wait: () =>
          Promise.resolve(
            ok({
              exitCode: 0,
              signal: null,
              startedAt: now,
              exitedAt: now,
              outputTruncated: false,
            }),
          ),
      } as never),
    );
  }
}

function buildPorts(stateRoot: string) {
  const leases = new FileLeaseRepository(
    join(stateRoot, "leases.json"),
    join(stateRoot, "leases.lock"),
  );
  const jobs = new FileJobRepository(join(stateRoot, "jobs.json"), join(stateRoot, "jobs.lock"));
  const admission = new FileIssueAdmissionStore(join(stateRoot, "admission"));
  return { leases: new LeaseCoordinator(leases), jobs, admission };
}

describe("dispatchOnce admission-claim wiring (C015o decision 3)", () => {
  it("a pre-existing active claim blocks a fresh dispatch attempt for the same issue entirely", async () => {
    const stateRoot = await temporaryStateRoot();
    const ready = readyComposition(stateRoot, "linear-issue-admission-1");
    const ports = buildPorts(stateRoot);

    // Discover the issue's domain id independently (same derivation discovery itself uses) so we
    // can pre-seed an admission claim for it -- simulating a prior job that reached
    // `requires_manual` after its own lease was already released (lease TTL long expired, no
    // durable guard left except this admission claim).
    const preview = await dispatchOnce(
      ready,
      buildPorts(await temporaryStateRoot()),
      "preview-holder",
    );
    if (preview.outcome !== "ran" || preview.candidates.length !== 1) {
      throw new Error(`expected exactly one discovered candidate: ${JSON.stringify(preview)}`);
    }
    const issueId = preview.candidates[0]?.issue.id;
    if (issueId === undefined) throw new Error("fixture invariant violated: missing issue id");
    const preClaim = await ports.admission.claim(ready.project.id, issueId);
    if (!preClaim.ok) throw new Error(preClaim.error.code);

    const outcome = await dispatchOnce(ready, ports, "holder-1");
    expect(outcome.outcome).toBe("ran");
    if (outcome.outcome !== "ran") return;
    expect(outcome.admissionSkipped).toEqual([{ issueId, reason: "issue_claim_active" }]);
    expect(outcome.result.kind).toBe("waiting");

    const allJobs = await ports.jobs.readAll();
    expect(allJobs.ok).toBe(true);
    if (allJobs.ok) expect(allJobs.value).toHaveLength(0);
  });

  it("a successful dispatch attaches the real job id to its admission claim", async () => {
    const stateRoot = await temporaryStateRoot();
    const ready = readyComposition(stateRoot, "linear-issue-admission-2");
    const ports = buildPorts(stateRoot);

    const outcome = await dispatchOnce(ready, ports, "holder-1");
    expect(outcome.outcome).toBe("ran");
    if (outcome.outcome !== "ran") return;
    expect(outcome.result.kind).toBe("dispatched");
    if (outcome.result.kind !== "dispatched") return;

    const claim = await ports.admission.load(ready.project.id, outcome.result.job.issueId);
    expect(claim.ok).toBe(true);
    if (claim.ok) {
      expect(claim.value).toMatchObject({ state: "active", jobId: outcome.result.job.id });
    }
  });

  it("exactly one of two genuinely concurrent dispatchOnce calls for the same candidate dispatches", async () => {
    const stateRoot = await temporaryStateRoot();
    const readyA = readyComposition(stateRoot, "linear-issue-admission-3");
    const readyB = readyComposition(stateRoot, "linear-issue-admission-3");
    const ports = buildPorts(stateRoot);

    const [first, second] = await Promise.all([
      dispatchOnce(readyA, ports, "holder-race-1"),
      dispatchOnce(readyB, ports, "holder-race-2"),
    ]);

    const dispatched = [first, second].filter(
      (outcome) => outcome.outcome === "ran" && outcome.result.kind === "dispatched",
    );
    const skippedByAdmission = [first, second].filter(
      (outcome) => outcome.outcome === "ran" && outcome.admissionSkipped.length > 0,
    );
    expect(dispatched).toHaveLength(1);
    expect(skippedByAdmission).toHaveLength(1);

    const jobs = new FileJobRepository(join(stateRoot, "jobs.json"), join(stateRoot, "jobs.lock"));
    const allJobs = await jobs.readAll();
    expect(allJobs.ok).toBe(true);
    if (allJobs.ok) expect(allJobs.value).toHaveLength(1);
  });

  it("releases every tentatively-claimed candidate when nothing ends up dispatched, leaving the issue claimable again", async () => {
    const stateRoot = await temporaryStateRoot();
    const ready = readyComposition(stateRoot, "linear-issue-admission-4");
    const ports = buildPorts(stateRoot);

    // Force "nothing dispatched" without pre-claiming: exhaust the only routing candidate by
    // acquiring its lease out from under this call before dispatchOnce runs, so Dispatcher itself
    // reports `waiting` (lease_conflict) even though this call's own admission claim succeeded.
    const preview = await dispatchOnce(
      ready,
      buildPorts(await temporaryStateRoot()),
      "preview-holder",
    );
    if (preview.outcome !== "ran" || preview.candidates.length !== 1) {
      throw new Error(`expected exactly one discovered candidate: ${JSON.stringify(preview)}`);
    }
    const issueId = preview.candidates[0]?.issue.id;
    if (issueId === undefined) throw new Error("fixture invariant violated: missing issue id");
    const leases = new LeaseCoordinator(
      new FileLeaseRepository(join(stateRoot, "leases.json"), join(stateRoot, "leases.lock")),
    );
    const heldLease = await leases.acquire({
      jobId: id("job", "job_018f47d2-77a4-7cc1-8ef2-9999999999ab"),
      issueId,
      holderId: "someone-else",
    });
    if (!heldLease.ok) throw new Error(heldLease.error.code);

    const outcome = await dispatchOnce(ready, ports, "holder-1");
    expect(outcome.outcome).toBe("ran");
    if (outcome.outcome !== "ran") return;
    expect(outcome.result.kind).toBe("waiting");
    expect(outcome.admissionSkipped).toHaveLength(0);

    const claim = await ports.admission.load(ready.project.id, issueId);
    expect(claim.ok).toBe(true);
    if (claim.ok) {
      expect(claim.value).toMatchObject({ state: "released", releaseReason: "not_dispatched" });
    }
    // Released, not stuck -- a later attempt (once the lease is freed) can claim it again.
    const reclaimed = await ports.admission.claim(ready.project.id, issueId);
    expect(reclaimed.ok).toBe(true);
  });
});
