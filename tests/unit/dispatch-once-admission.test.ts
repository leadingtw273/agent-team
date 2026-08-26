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
import {
  FileIssueAdmissionStore,
  type IssueAdmissionPort,
} from "../../src/adapters/dispatch/issue-admission-store.js";
import { FileOperatorCanaryAttestationStore } from "../../src/adapters/dispatch/operator-canary-attestation-store.js";
import { FileWorkStatusCapabilityStore } from "../../src/adapters/dispatch/work-status-capability-store.js";
import type { LinearDiscoveryReadModel } from "../../src/adapters/dispatch/linear-discovery.js";
import {
  buildLinearReadCatalog,
  linearAgentRoleNames,
  linearAgentStatusNames,
  linearBlockingReasonNames,
  linearHumanAcceptanceNames,
  linearReviewRequirementNames,
  linearVerificationLevelNames,
  linearWorkStatusNames,
  type LinearLabelRecord,
  type LinearProjectContext,
  type LinearWorkflowStateRecord,
} from "../../src/adapters/linear/model.js";
import { LeaseCoordinator, type LeaseRepository } from "../../src/application/leases/index.js";
import type { JobRepository } from "../../src/application/dispatch/index.js";
import type { ProjectRegistrySnapshot } from "../../src/application/projects/index.js";
import { trustedProjectConfigSchema } from "../../src/application/projects/index.js";
import type { ModelRoutingConfig } from "../../src/application/routing/index.js";
import {
  generateDeterministicIdentifier,
  createFixedClock,
  domainError,
  err,
  ok,
  parseIdentifier,
  parseInstant,
  type Identifier,
  type Instant,
} from "../../src/domain/foundation/index.js";
import type { ProcessPort } from "../../src/application/ports/index.js";
import {
  agentRoleSchema,
  humanAcceptanceRequirementSchema,
  projectSchema,
  reviewRequirementSchema,
  verificationLevelSchema,
  type Project,
} from "../../src/domain/project/index.js";
import { agentStatuses, blockingReasons } from "../../src/domain/workflow/index.js";
import {
  humanSummaryTemplate,
  readyGateTemplateHeadings,
} from "../../src/application/registration/linear-provision-model.js";
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
    { role: "implementer", candidates: [{ provider: "codex", model: "gpt-5.6-terra" }] },
    { role: "code_reviewer", candidates: [{ provider: "claude", model: "opus" }] },
    { role: "visual_reviewer", candidates: [{ provider: "gemini", model: "visual" }] },
    { role: "integration_engineer", candidates: [{ provider: "codex", model: "integrate" }] },
  ],
};

/** Same technique as tests/integration/dispatch-run-end-to-end.test.ts's own `linearProjectContext`. */
function linearProjectContext(humanWorkflowProvisioned = false): LinearProjectContext {
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
    humanAcceptance: "label-group-human-acceptance",
    verificationLevel: "label-group-verification-level",
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
    ...(humanWorkflowProvisioned
      ? [
          group("人類驗收", groupIds.humanAcceptance),
          ...humanAcceptanceRequirementSchema.options.map((key, index) =>
            child(
              linearHumanAcceptanceNames[key],
              groupIds.humanAcceptance,
              `label-human-acceptance-${String(index)}`,
            ),
          ),
          group("驗證強度", groupIds.verificationLevel),
          ...verificationLevelSchema.options.map((key, index) =>
            child(
              linearVerificationLevelNames[key],
              groupIds.verificationLevel,
              `label-verification-level-${String(index)}`,
            ),
          ),
        ]
      : []),
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

function readModel(externalIssueInput: string | readonly string[]): LinearDiscoveryReadModel {
  const externalIssueIds =
    typeof externalIssueInput === "string" ? [externalIssueInput] : [...externalIssueInput];
  return {
    readContext: () => Promise.resolve(ok(linearProjectContext())),
    listIssueIdsInState: () => Promise.resolve(ok(externalIssueIds)),
    readIssue: (_context, externalIssueId) =>
      Promise.resolve(
        ok({
          id: externalIssueId,
          identifier: `SBX-${String(externalIssueIds.indexOf(externalIssueId) + 1)}`,
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

function readyComposition(
  stateRoot: string,
  externalIssueId: string | readonly string[],
): DispatchCompositionReady {
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
      linearTransport: {} as never,
    },
    project: project(),
    trustedConfig: registry().ready[0]?.config as never,
    claude: {
      config: { executable: "claude", models: ["opus"], account: "default" },
      process: new ReadyClaudeProcessPort(),
    },
    codex: {
      config: { executable: "codex", models: ["gpt-5.6-terra"], account: "default" },
      process: new ReadyClaudeProcessPort(),
    },
    quotaAdmission: {
      resolve: () => Promise.resolve({ state: "ready" as const, reason: "test_fixture" }),
    },
  };
}

/** `dispatchOnce` genuinely calls `observeClaudeRouteCandidates`, a real (non-tripwire) probe --
 * same fixture technique as tests/integration/dispatch-run-end-to-end.test.ts's own
 * `ReadyClaudeProcessPort`, reports the Claude capability probe as alive without spawning any
 * real process. */
class ReadyClaudeProcessPort implements ProcessPort {
  calls = 0;

  spawn(): ReturnType<ProcessPort["spawn"]> {
    this.calls += 1;
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

/** Q01's exact-version gate drains stdout, unlike the pre-existing normal liveness probe above.
 * This fake is deliberately separate so old route-liveness assertions keep proving their original
 * behavior while canary tests can prove the persisted version is measured from the CLI itself. */
class VersionedClaudeProcessPort implements ProcessPort {
  calls = 0;

  constructor(private readonly version = "claude 2.1.0") {}

  spawn(): ReturnType<ProcessPort["spawn"]> {
    this.calls += 1;
    const output = new TextEncoder().encode(`${this.version}\n`);
    return Promise.resolve(
      ok({
        pid: 2,
        output: (async function* () {
          await Promise.resolve();
          yield {
            sequence: 0,
            stream: "stdout" as const,
            bytes: output,
            observedAt: now,
          };
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
  return {
    leases: new LeaseCoordinator(leases),
    jobs,
    admission,
    humanAcceptance: { listPending: () => Promise.resolve(ok([])) },
  };
}

describe("dispatchOnce admission-claim wiring (C015o decision 3)", () => {
  it("已有待人工驗收 checkpoint 時，零 quota、provider、claim、Lease 與 Job", async () => {
    const stateRoot = await temporaryStateRoot();
    const externalIssueId = "linear-issue-human-acceptance-pending";
    const issueId = generateDeterministicIdentifier("issue", externalIssueId);
    if (!issueId.ok) throw new Error("fixture invariant violated: issue id");
    const baseReady = readyComposition(stateRoot, externalIssueId);
    const process = new ReadyClaudeProcessPort();
    let quotaCalls = 0;
    const fullDescription = `## ${humanSummaryTemplate.heading}
- ${humanSummaryTemplate.objective}：加入坦克移動
- ${humanSummaryTemplate.outcome}：可以操作坦克前進
- ${humanSummaryTemplate.acceptance}：在 Godot 實機操作

${readyGateDescription()}`;
    const ready: DispatchCompositionReady = {
      ...baseReady,
      discovery: {
        ...baseReady.discovery,
        readModel: {
          ...readModel(externalIssueId),
          readContext: () => Promise.resolve(ok(linearProjectContext(true))),
          readIssue: () =>
            Promise.resolve(
              ok({
                id: externalIssueId,
                identifier: "SBX-1",
                title: "加入坦克移動",
                description: fullDescription,
                updatedAt: now,
                teamId: "team-1",
                projectId: "linear-proj-1",
                workStatus: "ready" as const,
                agentRole: "implementer" as const,
                reviewRequirement: "code_review" as const,
                humanAcceptanceRequirement: "required" as const,
                verificationLevel: "standard" as const,
                priority: "high" as const,
                otherLabelIds: [],
                relations: [],
                comments: [],
              }),
            ),
        } as never,
      },
      codex: { ...baseReady.codex, process },
      quotaAdmission: {
        resolve: () => {
          quotaCalls += 1;
          return Promise.resolve({ state: "ready" as const, reason: "test_fixture" });
        },
      },
    };
    const ports = {
      ...buildPorts(stateRoot),
      humanAcceptance: {
        listPending: () =>
          Promise.resolve(
            ok([
              {
                identity: { issueId: issueId.value },
              } as never,
            ]),
          ),
      },
    };

    const outcome = await dispatchOnce(ready, ports, "holder-human-acceptance-pending");

    expect(outcome.outcome).toBe("ran");
    if (outcome.outcome !== "ran") return;
    expect(outcome.admissionSkipped).toEqual([
      { issueId: issueId.value, reason: "human_acceptance_pending" },
    ]);
    expect(quotaCalls).toBe(0);
    expect(process.calls).toBe(0);
    expect(await ports.jobs.readAll()).toEqual({ ok: true, value: [] });
    expect(await ports.leases.repository.readAll()).toEqual({ ok: true, value: [] });
    await expect(ports.admission.load(ready.project.id, issueId.value)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("新工作流已 provisioning 但新單缺契約時，零 provider、claim、Lease 與 Job", async () => {
    const stateRoot = await temporaryStateRoot();
    const baseReady = readyComposition(stateRoot, "linear-issue-missing-human-contract");
    const process = new ReadyClaudeProcessPort();
    const legacyReadModel = readModel("linear-issue-missing-human-contract");
    const ready: DispatchCompositionReady = {
      ...baseReady,
      discovery: {
        ...baseReady.discovery,
        readModel: {
          ...legacyReadModel,
          readContext: () => Promise.resolve(ok(linearProjectContext(true))),
        } as never,
      },
      codex: { ...baseReady.codex, process },
    };
    const ports = buildPorts(stateRoot);

    const outcome = await dispatchOnce(ready, ports, "holder-missing-human-contract");

    expect(outcome.outcome).toBe("ran");
    if (outcome.outcome !== "ran") return;
    expect(outcome.candidates).toEqual([]);
    expect(outcome.discoverySkipped).toEqual([
      {
        externalIssueId: "linear-issue-missing-human-contract",
        reason: { code: "missing_human_summary" },
      },
    ]);
    expect(process.calls).toBe(0);
    expect(await ports.jobs.readAll()).toEqual({ ok: true, value: [] });
    expect(await ports.leases.repository.readAll()).toEqual({ ok: true, value: [] });
  });

  it("quota unknown performs zero claim, lease, Job, or Claude liveness process mutation", async () => {
    const stateRoot = await temporaryStateRoot();
    const baseReady = readyComposition(stateRoot, "linear-issue-quota-unknown");
    const process = new ReadyClaudeProcessPort();
    let quotaCalls = 0;
    const ready: DispatchCompositionReady = {
      ...baseReady,
      claude: { ...baseReady.claude, process },
      quotaAdmission: {
        resolve: () => {
          quotaCalls += 1;
          return Promise.resolve({ state: "quota_unknown", reason: "fixture_unknown" });
        },
      },
    };
    const ports = buildPorts(stateRoot);

    const outcome = await dispatchOnce(ready, ports, "holder-quota-unknown");

    expect(outcome.outcome).toBe("ran");
    if (outcome.outcome !== "ran") return;
    expect(outcome.result).toMatchObject({
      kind: "waiting",
      reason: "no_dispatchable_candidate",
    });
    expect(outcome.admissionSkipped).toEqual([
      { issueId: outcome.candidates[0]?.issue.id, reason: "quota_unknown" },
    ]);
    expect(quotaCalls).toBe(1);
    expect(process.calls).toBe(0);

    const jobs = await ports.jobs.readAll();
    const leases = await ports.leases.repository.readAll();
    expect(jobs).toEqual({ ok: true, value: [] });
    expect(leases).toEqual({ ok: true, value: [] });
    const issueId = outcome.candidates[0]?.issue.id;
    if (issueId === undefined) throw new Error("fixture invariant violated: missing issue id");
    await expect(ports.admission.load(ready.project.id, issueId)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("never crosses from an unavailable Codex execution route to a Claude fallback", async () => {
    const stateRoot = await temporaryStateRoot();
    const baseReady = readyComposition(stateRoot, "linear-issue-quota-fallback");
    const providerCalls = new Map<string, number>();
    const ready: DispatchCompositionReady = {
      ...baseReady,
      routingConfig: {
        ...routingConfig,
        routes: routingConfig.routes.map((route) =>
          route.role === "implementer"
            ? {
                ...route,
                candidates: [
                  { provider: "codex" as const, model: "gpt" },
                  { provider: "claude" as const, model: "opus" },
                ],
              }
            : route,
        ),
      },
      quotaAdmission: {
        resolve: (provider) => {
          providerCalls.set(provider, (providerCalls.get(provider) ?? 0) + 1);
          return Promise.resolve({ state: "ready", reason: "test_fixture" });
        },
      },
    };

    const outcome = await dispatchOnce(ready, buildPorts(stateRoot), "holder-fallback");

    expect(outcome.outcome).toBe("ran");
    if (outcome.outcome !== "ran") return;
    expect(outcome.result.kind).toBe("waiting");
    expect(outcome.admissionSkipped).toHaveLength(1);
    // Admission pre-observes both candidates before the routing schema rejects this deliberately
    // invalid cross-provider route. No job is claimed or dispatched through the Claude fallback.
    expect(providerCalls).toEqual(
      new Map([
        ["codex", 1],
        ["claude", 1],
      ]),
    );
  });

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

  it("public authority blocks a fresh claim and Job before local admission", async () => {
    const stateRoot = await temporaryStateRoot();
    const ready = readyComposition(stateRoot, "linear-issue-public-owner");
    const ports = buildPorts(stateRoot);
    let authorityReads = 0;

    const outcome = await dispatchOnce(
      ready,
      {
        ...ports,
        publicAdmissionAuthority: {
          check: () => {
            authorityReads += 1;
            return Promise.resolve(ok("existing_job_or_pr" as const));
          },
        },
      },
      "holder-public-owner",
    );

    expect(outcome.outcome).toBe("ran");
    if (outcome.outcome !== "ran") return;
    expect(authorityReads).toBe(1);
    expect(outcome.admissionSkipped).toEqual([
      { issueId: outcome.candidates[0]?.issue.id, reason: "public_authority_active" },
    ]);
    expect(await ports.jobs.readAll()).toEqual({ ok: true, value: [] });
    expect(await ports.leases.repository.readAll()).toEqual({ ok: true, value: [] });
    const issueId = outcome.candidates[0]?.issue.id;
    if (issueId === undefined) throw new Error("fixture invariant violated: missing issue id");
    await expect(ports.admission.load(ready.project.id, issueId)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("fails admission closed when public authority cannot be read", async () => {
    const stateRoot = await temporaryStateRoot();
    const ready = readyComposition(stateRoot, "linear-issue-public-unavailable");
    const ports = buildPorts(stateRoot);

    const outcome = await dispatchOnce(
      ready,
      {
        ...ports,
        publicAdmissionAuthority: {
          check: () => Promise.resolve(err(domainError("unavailable"))),
        },
      },
      "holder-public-unavailable",
    );

    expect(outcome.outcome).toBe("ran");
    if (outcome.outcome !== "ran") return;
    expect(outcome.admissionSkipped).toEqual([
      { issueId: outcome.candidates[0]?.issue.id, reason: "public_authority_unavailable" },
    ]);
    expect(await ports.jobs.readAll()).toEqual({ ok: true, value: [] });
    expect(await ports.leases.repository.readAll()).toEqual({ ok: true, value: [] });
  });

  it("serializes admission on the shared Issue lock and creates zero claim or Job on contention", async () => {
    const stateRoot = await temporaryStateRoot();
    const ready = readyComposition(stateRoot, "linear-issue-admission-lock");
    const base = buildPorts(stateRoot);

    const outcome = await dispatchOnce(
      ready,
      {
        ...base,
        locks: { acquire: () => Promise.resolve(err(domainError("conflict"))) },
      },
      "holder-lock-contention",
    );

    expect(outcome.outcome).toBe("ran");
    if (outcome.outcome !== "ran") return;
    expect(outcome.result.kind).toBe("waiting");
    expect(outcome.admissionSkipped).toEqual([
      { issueId: outcome.candidates[0]?.issue.id, reason: "issue_scope_lock_unavailable" },
    ]);
    expect(await base.jobs.readAll()).toEqual({ ok: true, value: [] });
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

  it("LWS02 confirms durable bootstrap before attaching the selected claim", async () => {
    const stateRoot = await temporaryStateRoot();
    const ready = readyComposition(stateRoot, "linear-issue-bootstrap-order");
    const base = buildPorts(stateRoot);
    const events: string[] = [];
    const admission: IssueAdmissionPort = {
      load: (...args) => base.admission.load(...args),
      claim: (...args) => base.admission.claim(...args),
      attachJob: (...args) => {
        events.push("attach");
        return base.admission.attachJob(...args);
      },
      release: (...args) => base.admission.release(...args),
    };
    const outcome = await dispatchOnce(
      ready,
      {
        ...base,
        admission,
        bootstrap: () => {
          events.push("bootstrap");
          return Promise.resolve(ok(undefined));
        },
      },
      "holder-bootstrap-order",
    );
    expect(outcome).toMatchObject({ outcome: "ran", bootstrap: { state: "confirmed" } });
    expect(events).toEqual(["bootstrap", "attach"]);
  });

  it("LWS02 leaves a safe active jobless claim when bootstrap fails and never attempts attach", async () => {
    const stateRoot = await temporaryStateRoot();
    const ready = readyComposition(stateRoot, "linear-issue-bootstrap-fail");
    const base = buildPorts(stateRoot);
    let attachCalls = 0;
    const admission: IssueAdmissionPort = {
      load: (...args) => base.admission.load(...args),
      claim: (...args) => base.admission.claim(...args),
      attachJob: (...args) => {
        attachCalls += 1;
        return base.admission.attachJob(...args);
      },
      release: (...args) => base.admission.release(...args),
    };
    const outcome = await dispatchOnce(
      ready,
      {
        ...base,
        admission,
        bootstrap: () => Promise.resolve(err(domainError("permission_denied"))),
      },
      "holder-bootstrap-fail",
    );
    expect(outcome).toMatchObject({
      outcome: "ran",
      result: { kind: "dispatched" },
      bootstrap: { state: "blocked", reason: "job_progress_write_failed" },
    });
    expect(attachCalls).toBe(0);
    if (outcome.outcome !== "ran" || outcome.result.kind !== "dispatched") return;
    const claim = await base.admission.load(ready.project.id, outcome.result.job.issueId);
    expect(claim).toMatchObject({ ok: true, value: { state: "active" } });
    if (claim.ok) expect(claim.value).not.toHaveProperty("jobId");
  });

  it("LWS02 preserves confirmed progress and a jobless claim when selected-claim attach loses CAS", async () => {
    const stateRoot = await temporaryStateRoot();
    const ready = readyComposition(stateRoot, "linear-issue-attach-fail");
    const base = buildPorts(stateRoot);
    let bootstrapCalls = 0;
    const admission: IssueAdmissionPort = {
      load: (...args) => base.admission.load(...args),
      claim: (...args) => base.admission.claim(...args),
      attachJob: () => Promise.resolve(err(domainError("conflict"))),
      release: (...args) => base.admission.release(...args),
    };
    const outcome = await dispatchOnce(
      ready,
      {
        ...base,
        admission,
        bootstrap: () => {
          bootstrapCalls += 1;
          return Promise.resolve(ok(undefined));
        },
      },
      "holder-attach-fail",
    );
    expect(outcome).toMatchObject({
      outcome: "ran",
      bootstrap: { state: "blocked", reason: "claim_attach_failed" },
    });
    expect(bootstrapCalls).toBe(1);
  });

  it("LWS00/LWS02 enforce capability failure creates zero claim, Lease, or Job", async () => {
    const stateRoot = await temporaryStateRoot();
    const base = readyComposition(stateRoot, "linear-issue-capability-fail");
    const ready: DispatchCompositionReady = {
      ...base,
      trustedConfig: trustedProjectConfigSchema.parse({
        ...base.trustedConfig,
        workStatusLifecycleMode: "enforce",
      }),
      // Deliberately no capability store: enforce must fail before discovery admission.
    };
    const ports = buildPorts(stateRoot);
    const outcome = await dispatchOnce(ready, ports, "holder-capability-fail");
    expect(outcome).toMatchObject({
      outcome: "capability_failed",
      error: { code: "unavailable" },
    });
    expect(await ports.jobs.readAll()).toEqual({ ok: true, value: [] });
    expect(await ports.leases.repository.readAll()).toEqual({ ok: true, value: [] });
  });

  it("LWS01 observe capability failure stays fail-open and still admits the Job", async () => {
    const stateRoot = await temporaryStateRoot();
    const base = readyComposition(stateRoot, "linear-issue-capability-observe");
    const ready: DispatchCompositionReady = {
      ...base,
      trustedConfig: trustedProjectConfigSchema.parse({
        ...base.trustedConfig,
        workStatusLifecycleMode: "observe",
      }),
      // Missing capability storage is telemetry loss only in observe mode.
    };
    const ports = buildPorts(stateRoot);

    const outcome = await dispatchOnce(ready, ports, "holder-capability-observe");

    expect(outcome).toMatchObject({ outcome: "ran", result: { kind: "dispatched" } });
    const jobs = await ports.jobs.readAll();
    expect(jobs.ok).toBe(true);
    if (jobs.ok) expect(jobs.value).toHaveLength(1);
  });

  it("LWS00 stores an enforce capability digest before allowing admission", async () => {
    const stateRoot = await temporaryStateRoot();
    const base = readyComposition(stateRoot, "linear-issue-capability-ok");
    const store = new FileWorkStatusCapabilityStore(join(stateRoot, "capability"));
    const ready: DispatchCompositionReady = {
      ...base,
      trustedConfig: trustedProjectConfigSchema.parse({
        ...base.trustedConfig,
        workStatusLifecycleMode: "enforce",
      }),
      workStatusCapability: { store },
    };
    const outcome = await dispatchOnce(ready, buildPorts(stateRoot), "holder-capability-ok");
    expect(outcome).toMatchObject({ outcome: "ran", result: { kind: "dispatched" } });
    const evidence = await store.load(projectId);
    expect(evidence.ok ? evidence.value?.capability.digest : evidence.error.code).toMatch(
      /^[0-9a-f]{64}$/u,
    );
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

  it("Q01 cannot bypass the fixed Codex execution policy", async () => {
    const stateRoot = await temporaryStateRoot();
    const events: string[] = [];
    const canaryClock = createFixedClock(now);
    const canaryStore = new FileOperatorCanaryAttestationStore(stateRoot, { clock: canaryClock });
    const issued = await canaryStore.issue({
      projectId,
      linearExternalIssueId: "linear-issue-canary-exact",
      claudeCliVersion: "claude 2.1.0",
    });
    if (!issued.ok) throw new Error(issued.error.code);
    const originalConsume = canaryStore.consume.bind(canaryStore);
    (canaryStore as { consume: typeof canaryStore.consume }).consume = async (input) => {
      const consumed = await originalConsume(input);
      events.push("consume.end");
      return consumed;
    };

    const base = readyComposition(stateRoot, [
      "linear-issue-canary-exact",
      "linear-issue-canary-other",
    ]);
    const process = new VersionedClaudeProcessPort();
    const ready: DispatchCompositionReady = {
      ...base,
      claude: { ...base.claude, process },
      quotaAdmission: {
        resolve: () => Promise.resolve({ state: "quota_unknown" as const, reason: "no_collector" }),
      },
      operatorCanary: { store: canaryStore },
    };
    const leaseStore = new FileLeaseRepository(
      join(stateRoot, "ordered-leases.json"),
      join(stateRoot, "ordered-leases.lock"),
    );
    const leases: LeaseRepository = {
      readAll: () => leaseStore.readAll(),
      transact: (holder, mutate) => {
        events.push("lease.acquire.begin");
        return leaseStore.transact(holder, mutate);
      },
    };
    const jobStore = new FileJobRepository(
      join(stateRoot, "ordered-jobs.json"),
      join(stateRoot, "ordered-jobs.lock"),
    );
    const jobs: JobRepository = {
      create: (job) => {
        events.push("job.create.begin");
        return jobStore.create(job);
      },
    };
    const admissionStore = new FileIssueAdmissionStore(join(stateRoot, "ordered-admission"));
    const admission: IssueAdmissionPort = {
      load: (...input) => admissionStore.load(...input),
      claim: (...input) => {
        events.push("admission.claim.begin");
        return admissionStore.claim(...input);
      },
      attachJob: (...input) => admissionStore.attachJob(...input),
      release: (...input) => admissionStore.release(...input),
    };

    const ports = { leases: new LeaseCoordinator(leases), jobs, admission };
    const outcome = await dispatchOnce(ready, ports, "holder-canary-order", {
      allowOperatorCanary: true,
    });
    expect(outcome.outcome).toBe("ran");
    if (outcome.outcome !== "ran") return;
    expect(outcome.result.kind).toBe("waiting");
    expect(events).toEqual([]);
    expect(process.calls).toBe(0);
    const exactCandidate = outcome.candidates.find(
      (candidate) => candidate.issue.externalId === "linear-issue-canary-exact",
    );
    const otherCandidate = outcome.candidates.find(
      (candidate) => candidate.issue.externalId === "linear-issue-canary-other",
    );
    if (exactCandidate === undefined || otherCandidate === undefined) {
      throw new Error("fixture must discover both candidates");
    }
    expect(outcome.admissionSkipped).toHaveLength(2);
    await expect(admissionStore.load(projectId, otherCandidate.issue.id)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(
      canaryStore.inspect({ projectId, linearExternalIssueId: "linear-issue-canary-exact" }),
    ).resolves.toMatchObject({ ok: true, value: { state: "issued" } });

    const replay = await dispatchOnce(ready, ports, "holder-canary-replay", {
      allowOperatorCanary: true,
    });
    expect(replay).toMatchObject({
      outcome: "ran",
      result: { kind: "waiting", reason: "no_dispatchable_candidate" },
    });
    expect(events).toEqual([]);
    expect(process.calls).toBe(0);
    await expect(jobStore.readAll()).resolves.toMatchObject({
      ok: true,
      value: [],
    });
  });

  it("Q01 leaves an active record untouched when a normal quota-ready route is admissible", async () => {
    const stateRoot = await temporaryStateRoot();
    const canaryStore = new FileOperatorCanaryAttestationStore(stateRoot, {
      clock: createFixedClock(now),
    });
    const issued = await canaryStore.issue({
      projectId,
      linearExternalIssueId: "linear-issue-normal-priority",
      claudeCliVersion: "claude 2.1.0",
    });
    if (!issued.ok) throw new Error(issued.error.code);
    const base = readyComposition(stateRoot, "linear-issue-normal-priority");
    const ready: DispatchCompositionReady = {
      ...base,
      claude: { ...base.claude, process: new VersionedClaudeProcessPort() },
      operatorCanary: { store: canaryStore },
    };

    const outcome = await dispatchOnce(ready, buildPorts(stateRoot), "holder-normal-priority", {
      allowOperatorCanary: true,
    });
    expect(outcome).toMatchObject({ outcome: "ran", result: { kind: "dispatched" } });
    await expect(
      canaryStore.inspect({ projectId, linearExternalIssueId: "linear-issue-normal-priority" }),
    ).resolves.toMatchObject({ ok: true, value: { state: "issued" } });
  });

  it("Q01 leaves quota unknown with zero claim when the exact issue or live version does not match", async () => {
    const stateRoot = await temporaryStateRoot();
    const canaryStore = new FileOperatorCanaryAttestationStore(stateRoot, {
      clock: createFixedClock(now),
    });
    const issued = await canaryStore.issue({
      projectId,
      linearExternalIssueId: "different-linear-issue",
      claudeCliVersion: "claude 2.1.0",
    });
    if (!issued.ok) throw new Error(issued.error.code);
    const process = new VersionedClaudeProcessPort("claude 2.1.1");
    const base = readyComposition(stateRoot, "linear-issue-version-mismatch");
    const ready: DispatchCompositionReady = {
      ...base,
      claude: { ...base.claude, process },
      quotaAdmission: {
        resolve: () => Promise.resolve({ state: "quota_unknown" as const, reason: "no_collector" }),
      },
      operatorCanary: { store: canaryStore },
    };
    const ports = buildPorts(stateRoot);

    const noExact = await dispatchOnce(ready, ports, "holder-no-exact", {
      allowOperatorCanary: true,
    });
    expect(noExact).toMatchObject({ outcome: "ran", result: { kind: "waiting" } });
    expect(process.calls).toBe(0);
    if (noExact.outcome !== "ran") throw new Error("fixture discovery must succeed");
    const candidateId = noExact.candidates[0]?.issue.id;
    if (candidateId === undefined) throw new Error("fixture candidate must exist");
    await expect(ports.admission.load(projectId, candidateId)).resolves.toEqual({
      ok: true,
      value: undefined,
    });

    const versionIssued = await canaryStore.issue({
      projectId,
      linearExternalIssueId: "linear-issue-version-mismatch",
      claudeCliVersion: "claude 2.1.0",
    });
    if (!versionIssued.ok) throw new Error(versionIssued.error.code);
    const mismatch = await dispatchOnce(ready, ports, "holder-version-mismatch", {
      allowOperatorCanary: true,
    });
    expect(mismatch).toMatchObject({ outcome: "ran", result: { kind: "waiting" } });
    expect(process.calls).toBe(0);
    await expect(ports.admission.load(projectId, candidateId)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(
      canaryStore.inspect({ projectId, linearExternalIssueId: "linear-issue-version-mismatch" }),
    ).resolves.toMatchObject({ ok: true, value: { state: "issued" } });
  });

  it("Q01 never revives a consumed record when Job creation fails after admission", async () => {
    const stateRoot = await temporaryStateRoot();
    const canaryStore = new FileOperatorCanaryAttestationStore(stateRoot, {
      clock: createFixedClock(now),
    });
    const issued = await canaryStore.issue({
      projectId,
      linearExternalIssueId: "linear-issue-consumed-after-job-failure",
      claudeCliVersion: "claude 2.1.0",
    });
    if (!issued.ok) throw new Error(issued.error.code);
    const base = readyComposition(stateRoot, "linear-issue-consumed-after-job-failure");
    const ready: DispatchCompositionReady = {
      ...base,
      claude: { ...base.claude, process: new VersionedClaudeProcessPort() },
      quotaAdmission: {
        resolve: () => Promise.resolve({ state: "quota_unknown" as const, reason: "no_collector" }),
      },
      operatorCanary: { store: canaryStore },
    };
    const failedJobs: JobRepository = {
      create: () => Promise.resolve(err(domainError("external_failure"))),
    };
    const ports = {
      leases: new LeaseCoordinator(
        new FileLeaseRepository(
          join(stateRoot, "failed-leases.json"),
          join(stateRoot, "failed-leases.lock"),
        ),
      ),
      jobs: failedJobs,
      admission: new FileIssueAdmissionStore(join(stateRoot, "failed-admission")),
    };

    const outcome = await dispatchOnce(ready, ports, "holder-job-failure", {
      allowOperatorCanary: true,
    });
    expect(outcome).toMatchObject({ outcome: "ran", result: { kind: "waiting" } });
    await expect(
      canaryStore.inspect({
        projectId,
        linearExternalIssueId: "linear-issue-consumed-after-job-failure",
      }),
    ).resolves.toMatchObject({ ok: true, value: { state: "issued" } });
  });
});
