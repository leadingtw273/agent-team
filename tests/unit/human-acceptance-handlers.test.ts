import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileHumanAcceptanceStore } from "../../src/adapters/dispatch/index.js";
import { createHumanAcceptanceHandlers } from "../../src/cli/dispatch/human-acceptance-handlers.js";
import {
  createFixedClock,
  ok,
  parseIdentifier,
  parseInstant,
} from "../../src/domain/foundation/index.js";
import { issueSchema, projectSchema } from "../../src/domain/project/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function instant(value: string) {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const now = instant("2026-08-21T04:00:00.000Z");
const mergedAt = instant("2026-08-21T03:59:00.000Z");
const projectId = "project_018f47d2-77a4-7cc1-8ef2-0123456789ab" as const;
const issueId = "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab" as const;
const externalIssueId = "linear-issue-1";
const jobId = (() => {
  const parsed = parseIdentifier("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab");
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
})();

const project = projectSchema.parse({
  schemaVersion: 1,
  id: projectId,
  displayName: "Sandbox",
  localRepositoryPath: "/tmp/sandbox",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "team-1", projectId: "linear-project-1" },
  sourceControl: { provider: "github", repository: "owner/sandbox" },
});

const issue = issueSchema.parse({
  schemaVersion: 1,
  id: issueId,
  projectId,
  externalId: externalIssueId,
  title: "可操作坦克前進與轉向",
  humanSummary: {
    objective: "加入坦克基本移動。",
    outcome: "玩家可以前進、倒車與轉向。",
    acceptance: "在 Godot 實機操作。",
  },
  humanAcceptanceRequirement: "required",
  verificationLevel: "standard",
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-human-acceptance-handler-"));
  temporaryDirectories.push(directory);
  const store = new FileHumanAcceptanceStore(directory, undefined, createFixedClock(now));
  const created = await store.createPending({
    identity: {
      projectId: project.id,
      issueId: issue.id,
      jobId,
      requirementDigest: "a".repeat(64),
      mergeCommit: "b".repeat(40),
    },
    externalIssueId,
    changeRequest: {
      url: "https://github.com/owner/sandbox/pull/1",
      number: 1,
      headSha: "c".repeat(40),
    },
    humanSummaryDigest: "d".repeat(64),
    mergedAt,
  });
  if (!created.ok) throw new Error(created.error.code);

  let workStatus: "in_review" | "ready" | "completed" = "in_review";
  let setWorkStatusCalls = 0;
  const comments = new Map<string, string>();
  const workManagement = {
    getIssue: () =>
      Promise.resolve(
        ok({
          issue,
          workStatus,
          updatedAt: now,
          revision: "revision-1",
        }),
      ),
    setWorkStatus: (_reference: unknown, status: "ready" | "completed") => {
      setWorkStatusCalls += 1;
      workStatus = status;
      return Promise.resolve(
        ok({
          issue,
          workStatus,
          updatedAt: now,
          revision: `revision-${String(setWorkStatusCalls + 1)}`,
        }),
      );
    },
    appendComment: (_reference: unknown, body: string, options: { idempotencyKey: string }) => {
      comments.set(options.idempotencyKey, body);
      return Promise.resolve(ok({ id: options.idempotencyKey, body, createdAt: now }));
    },
  };
  return {
    store,
    created: created.value,
    comments,
    setWorkStatusCalls: () => setWorkStatusCalls,
    handlers: createHumanAcceptanceHandlers({
      store,
      runtime: () => Promise.resolve(ok({ project, workManagement })),
    }),
  };
}

describe("human acceptance MVP handlers", () => {
  it("列出 pending，接受後冪等補齊 Linear Done 與單一留言", async () => {
    const test = await fixture();

    const listed = await test.handlers.humanAcceptanceList({ projectId });
    expect(listed).toMatchObject({ state: "success" });
    expect(JSON.parse(listed.message ?? "{}")).toMatchObject({ count: 1 });

    await expect(
      test.handlers.humanAcceptanceAccept({ projectId, externalIssueId }),
    ).resolves.toMatchObject({ state: "success" });
    await expect(
      test.handlers.humanAcceptanceAccept({ projectId, externalIssueId }),
    ).resolves.toMatchObject({ state: "success" });

    expect(test.setWorkStatusCalls()).toBe(1);
    expect(test.comments.size).toBe(1);
    await expect(test.store.listPending(projectId)).resolves.toEqual({ ok: true, value: [] });
    await expect(test.store.listForIssue(projectId, externalIssueId)).resolves.toMatchObject({
      ok: true,
      value: [{ state: "accepted" }],
    });
  });

  it("要求調整後關閉舊 checkpoint，並讓同一張工單回到待執行", async () => {
    const test = await fixture();

    await expect(
      test.handlers.humanAcceptanceRequestAdjustment({ projectId, externalIssueId }),
    ).resolves.toMatchObject({ state: "success" });
    await expect(
      test.handlers.humanAcceptanceRequestAdjustment({ projectId, externalIssueId }),
    ).resolves.toMatchObject({ state: "success" });

    expect(test.comments.size).toBe(1);
    expect(test.setWorkStatusCalls()).toBe(1);
    await expect(test.store.listPending(projectId)).resolves.toEqual({ ok: true, value: [] });
    await expect(test.store.listForIssue(projectId, externalIssueId)).resolves.toMatchObject({
      ok: true,
      value: [
        {
          identityDigest: test.created.identityDigest,
          state: "invalidated",
          decisions: [{ decision: "request_adjustment" }],
          invalidation: { reason: "reopened" },
        },
      ],
    });
  });
});
