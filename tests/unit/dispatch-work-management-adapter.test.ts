/**
 * C015c item 5 unit tests: `LinearWorkManagementAdapter`
 * (src/cli/dispatch/work-management-adapter.ts) -- the `WorkManagementPort` slice
 * `LifecyclePipeline` needs (`getIssue`/`setWorkStatus`/`setAgentCondition`/`appendComment`),
 * against fake `readModel`/`mutationClient` (no real Linear network access). Covers: `getIssue`
 * field mapping (deterministic id derivation, workStatus/agentCondition passthrough);
 * `setWorkStatus` narrowed to "completed" only (any other target fails closed *without* ever
 * calling the mutation client); `setAgentCondition` narrowed to a single blocking reason (more
 * than one fails closed without calling the mutation client); `appendComment` delegation and
 * result mapping; upstream `readContext` failure propagation.
 */
import { describe, expect, it } from "vitest";

import {
  LinearWorkManagementAdapter,
  type LinearWorkManagementMutationClient,
  type LinearWorkManagementReadModel,
} from "../../src/cli/dispatch/work-management-adapter.js";
import {
  buildLinearReadCatalog,
  linearAgentRoleNames,
  linearAgentStatusNames,
  linearBlockingReasonNames,
  linearReviewRequirementNames,
  linearWorkStatusNames,
  type LinearIssueSnapshot,
  type LinearLabelRecord,
  type LinearProjectContext,
  type LinearWorkflowStateRecord,
} from "../../src/adapters/linear/model.js";
import {
  domainError,
  err,
  generateDeterministicIdentifier,
  ok,
  parseIdentifier,
  type Identifier,
} from "../../src/domain/foundation/index.js";
import {
  agentRoleSchema,
  reviewRequirementSchema,
  projectSchema,
  type Project,
} from "../../src/domain/project/index.js";
import {
  agentStatuses,
  blockingReasons,
  createAgentCondition,
} from "../../src/domain/workflow/index.js";

function id<Scope extends string>(scope: Scope, value: string): Identifier<Scope> {
  const parsed = parseIdentifier(scope, value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function project(): Project {
  return projectSchema.parse({
    schemaVersion: 1,
    id: id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab"),
    displayName: "Sandbox",
    localRepositoryPath: "/tmp/sandbox",
    defaultBranch: "main",
    workManagement: { provider: "linear", containerId: "team-1", projectId: "proj-1" },
    sourceControl: { provider: "github", repository: "owner/sandbox" },
  });
}

/** Same fixture technique as tests/unit/dispatch-linear-discovery.test.ts's own `context()` -- a
 * genuinely complete, `buildLinearReadCatalog`-validated catalog, exactly as strict as the real
 * `LinearReadModel.readContext` would produce. */
function context(): LinearProjectContext {
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
    project: Object.freeze({ id: "proj-1", name: "Project" }),
    catalog: catalog.value,
  });
}

function snapshot(overrides: Partial<LinearIssueSnapshot> = {}): LinearIssueSnapshot {
  return Object.freeze({
    id: "linear-issue-1",
    identifier: "SBX-1",
    title: "Ship the thing",
    updatedAt: "2026-08-07T00:00:00.000Z" as never,
    teamId: "team-1",
    projectId: "proj-1",
    workStatus: "in_review" as const,
    otherLabelIds: [],
    relations: [],
    comments: [],
    ...overrides,
  });
}

class FakeReadModel implements LinearWorkManagementReadModel {
  contextCalls = 0;
  readonly contextOptions: unknown[] = [];
  readonly issueOptions: unknown[] = [];
  constructor(
    private readonly ctx = context(),
    private readonly issue = snapshot(),
    private readonly failContext = false,
  ) {}

  readContext(
    ...args: Parameters<LinearWorkManagementReadModel["readContext"]>
  ): ReturnType<LinearWorkManagementReadModel["readContext"]> {
    this.contextCalls += 1;
    this.contextOptions.push(args[2]);
    return Promise.resolve(this.failContext ? err(domainError("external_failure")) : ok(this.ctx));
  }

  readIssue(
    ...args: Parameters<LinearWorkManagementReadModel["readIssue"]>
  ): ReturnType<LinearWorkManagementReadModel["readIssue"]> {
    this.issueOptions.push(args[2]);
    return Promise.resolve(ok(this.issue));
  }
}

class FakeMutationClient implements LinearWorkManagementMutationClient {
  observeGithubMergeCalls = 0;
  setAgentConditionCalls: unknown[] = [];
  appendCommentCalls: unknown[] = [];
  constructor(private readonly result: LinearIssueSnapshot = snapshot()) {}

  observeGithubMerge(): ReturnType<LinearWorkManagementMutationClient["observeGithubMerge"]> {
    this.observeGithubMergeCalls += 1;
    return Promise.resolve(ok(this.result));
  }

  setAgentCondition(
    _context: LinearProjectContext,
    _issueId: string,
    condition: Parameters<LinearWorkManagementMutationClient["setAgentCondition"]>[2],
  ): ReturnType<LinearWorkManagementMutationClient["setAgentCondition"]> {
    this.setAgentConditionCalls.push(condition);
    return Promise.resolve(ok({ ...this.result, agentCondition: condition } as never));
  }

  appendComment(
    _context: LinearProjectContext,
    _issueId: string,
    body: string,
  ): ReturnType<LinearWorkManagementMutationClient["appendComment"]> {
    this.appendCommentCalls.push(body);
    return Promise.resolve(
      ok({ id: "comment-1", body, createdAt: "2026-08-07T00:00:00.000Z" as never, reused: false }),
    );
  }
}

function reference(overrides: Partial<{ externalIssueId: string }> = {}) {
  return { project: project(), externalIssueId: "linear-issue-1", ...overrides };
}

describe("LinearWorkManagementAdapter", () => {
  it("getIssue maps a LinearIssueSnapshot into a WorkManagementIssueSnapshot with a deterministic issue id", async () => {
    const readModel = new FakeReadModel();
    const adapter = new LinearWorkManagementAdapter({
      readModel,
      mutationClient: new FakeMutationClient(),
      teamId: "team-1",
      linearProjectId: "proj-1",
    });

    const result = await adapter.getIssue(reference());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expectedId = generateDeterministicIdentifier("issue", "linear-issue-1");
    expect(expectedId.ok).toBe(true);
    if (expectedId.ok) expect(result.value.issue.id).toBe(expectedId.value);
    expect(result.value.issue.projectId).toBe(project().id);
    expect(result.value.issue.externalId).toBe("linear-issue-1");
    expect(result.value.workStatus).toBe("in_review");
  });

  it("passes the same AbortSignal through both Linear context and issue multi-read", async () => {
    const readModel = new FakeReadModel();
    const adapter = new LinearWorkManagementAdapter({
      readModel,
      mutationClient: new FakeMutationClient(),
      teamId: "team-1",
      linearProjectId: "proj-1",
    });
    const controller = new AbortController();

    const result = await adapter.getIssue(reference(), { signal: controller.signal });

    expect(result.ok).toBe(true);
    expect(readModel.contextOptions).toEqual([{ signal: controller.signal }]);
    expect(readModel.issueOptions).toEqual([{ signal: controller.signal }]);
  });

  it("propagates a readContext failure without ever reaching readIssue", async () => {
    const readModel = new FakeReadModel(context(), snapshot(), true);
    const adapter = new LinearWorkManagementAdapter({
      readModel,
      mutationClient: new FakeMutationClient(),
      teamId: "team-1",
      linearProjectId: "proj-1",
    });

    const result = await adapter.getIssue(reference());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("external_failure");
  });

  it('setWorkStatus("completed") delegates to observeGithubMerge', async () => {
    const mutationClient = new FakeMutationClient();
    const adapter = new LinearWorkManagementAdapter({
      readModel: new FakeReadModel(),
      mutationClient,
      teamId: "team-1",
      linearProjectId: "proj-1",
    });

    const result = await adapter.setWorkStatus(reference(), "completed", {
      idempotencyKey: "k",
    });
    expect(result.ok).toBe(true);
    expect(mutationClient.observeGithubMergeCalls).toBe(1);
  });

  it("setWorkStatus fails closed on any target other than completed, without calling the mutation client (narrow-scope disclosure)", async () => {
    const mutationClient = new FakeMutationClient();
    const adapter = new LinearWorkManagementAdapter({
      readModel: new FakeReadModel(),
      mutationClient,
      teamId: "team-1",
      linearProjectId: "proj-1",
    });

    const result = await adapter.setWorkStatus(reference(), "in_progress", {
      idempotencyKey: "k",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invariant_violation");
    expect(mutationClient.observeGithubMergeCalls).toBe(0);
  });

  it("setAgentCondition maps a single blocking reason through to LinearVisibleAgentCondition", async () => {
    const mutationClient = new FakeMutationClient();
    const adapter = new LinearWorkManagementAdapter({
      readModel: new FakeReadModel(),
      mutationClient,
      teamId: "team-1",
      linearProjectId: "proj-1",
    });

    const condition = createAgentCondition("blocked", ["change_request_closed"]);
    const result = await adapter.setAgentCondition(reference(), condition, { idempotencyKey: "k" });
    expect(result.ok).toBe(true);
    expect(mutationClient.setAgentConditionCalls).toEqual([
      { status: "blocked", blockingReason: "change_request_closed" },
    ]);
  });

  it("setAgentCondition fails closed with more than one blocking reason, without calling the mutation client", async () => {
    const mutationClient = new FakeMutationClient();
    const adapter = new LinearWorkManagementAdapter({
      readModel: new FakeReadModel(),
      mutationClient,
      teamId: "team-1",
      linearProjectId: "proj-1",
    });

    const condition = {
      status: "blocked" as const,
      blockingReasons: ["change_request_closed", "merge_conflict"] as const,
    };
    const result = await adapter.setAgentCondition(reference(), condition, { idempotencyKey: "k" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invariant_violation");
    expect(mutationClient.setAgentConditionCalls).toHaveLength(0);
  });

  it("appendComment delegates and maps the LinearCommentReceipt back into a WorkManagementComment", async () => {
    const mutationClient = new FakeMutationClient();
    const adapter = new LinearWorkManagementAdapter({
      readModel: new FakeReadModel(),
      mutationClient,
      teamId: "team-1",
      linearProjectId: "proj-1",
    });

    const result = await adapter.appendComment(reference(), "hello", { idempotencyKey: "k" });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value).toEqual({
        id: "comment-1",
        body: "hello",
        createdAt: "2026-08-07T00:00:00.000Z",
      });
    expect(mutationClient.appendCommentCalls).toEqual(["hello"]);
  });
});
