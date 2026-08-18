import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileWorkStatusCapabilityStore,
  createWorkStatusCapabilitySnapshot,
  workStatusCapabilityRecordSchema,
} from "../../src/adapters/dispatch/work-status-capability-store.js";
import {
  buildLinearReadCatalog,
  type LinearProjectContext,
} from "../../src/adapters/linear/index.js";
import { createFixedClock, parseIdentifier } from "../../src/domain/foundation/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-work-status-capability-"));
  temporaryDirectories.push(directory);
  return directory;
}

function projectId(): string {
  const parsed = parseIdentifier("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab");
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function context(): LinearProjectContext {
  const stateNames = ["待辦", "待執行", "需人工", "進行中", "審查中", "已完成", "已取消"];
  const groupDefinitions = [
    ["Agent 角色", ["團隊管理者", "開發工程師", "代碼審查者", "視覺審查者", "整合工程師"]],
    ["審查需求", ["代碼審查", "視覺審查", "雙重審查"]],
    ["Agent 狀態", ["排隊中", "執行中", "等待中", "已暫停", "已阻塞"]],
    [
      "阻塞原因",
      [
        "等待依賴",
        "週額度不足",
        "5 小時額度限制",
        "額度資訊無法確認",
        "等待危險操作核可",
        "整合異常",
        "合併衝突",
        "變更請求已關閉",
        "未知錯誤",
      ],
    ],
  ] as const;
  const labels = groupDefinitions.flatMap(([groupName, children], groupIndex) => {
    const groupId = `group-${String(groupIndex)}`;
    return [
      { id: groupId, name: groupName, isGroup: true, parentId: null },
      ...children.map((name, childIndex) => ({
        id: `label-${String(groupIndex)}-${String(childIndex)}`,
        name,
        isGroup: false,
        parentId: groupId,
      })),
    ];
  });
  const catalog = buildLinearReadCatalog(
    stateNames.map((name, index) => ({ id: `state-${String(index)}`, name, type: "started" })),
    labels,
  );
  if (!catalog.ok) throw new Error(catalog.error.code);
  return {
    team: { id: "linear-team", key: "LEA", name: "Agent Team" },
    project: { id: "linear-project", name: "Sandbox" },
    catalog: catalog.value,
  };
}

describe("work-status capability snapshot", () => {
  it("binds the verified state and controlled-label IDs to one stable canonical digest", () => {
    const first = createWorkStatusCapabilitySnapshot(context());
    const second = createWorkStatusCapabilitySnapshot(context());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value).toEqual(second.value);
    expect(first.value.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(new Set(Object.keys(first.value.identity.workStateIds))).toEqual(
      new Set([
        "backlog",
        "canceled",
        "completed",
        "in_progress",
        "in_review",
        "ready",
        "requires_manual",
      ]),
    );
    expect(first.value.identity.agentStatus.groupId).toBe("group-2");
    expect(first.value.identity.blockingReason.groupId).toBe("group-3");
  });

  it("changes the digest when a runtime mutation ID drifts", () => {
    const original = context();
    const first = createWorkStatusCapabilitySnapshot(original);
    const drifted = createWorkStatusCapabilitySnapshot({
      ...original,
      catalog: {
        ...original.catalog,
        stateIdByWorkStatus: { ...original.catalog.stateIdByWorkStatus, in_progress: "drifted" },
        workStatusByStateId: {
          ...original.catalog.workStatusByStateId,
          drifted: "in_progress",
        },
      },
    });
    expect(first.ok && drifted.ok && first.value.digest !== drifted.value.digest).toBe(true);
  });
});

describe("FileWorkStatusCapabilityStore", () => {
  it("atomically persists private read-back evidence and advances revision", async () => {
    const directory = await temporaryDirectory();
    const now = "2026-08-18T00:00:00.000Z" as never;
    const store = new FileWorkStatusCapabilityStore(directory, undefined, createFixedClock(now));
    const snapshot = createWorkStatusCapabilitySnapshot(context());
    if (!snapshot.ok) throw new Error(snapshot.error.code);

    const first = await store.save(projectId(), snapshot.value);
    expect(first.ok && first.value.revision).toBe(0);
    const second = await store.save(projectId(), snapshot.value);
    expect(second.ok && second.value.revision).toBe(1);
    expect(await store.load(projectId())).toEqual(second);

    const path = join(directory, `${projectId()}.json`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    expect(workStatusCapabilityRecordSchema.safeParse(raw).success).toBe(true);
  });

  it("rejects a forged digest without writing evidence", async () => {
    const directory = await temporaryDirectory();
    const store = new FileWorkStatusCapabilityStore(directory);
    const snapshot = createWorkStatusCapabilitySnapshot(context());
    if (!snapshot.ok) throw new Error(snapshot.error.code);
    const result = await store.save(projectId(), {
      ...snapshot.value,
      digest: "0".repeat(64) as never,
    });
    expect(result.ok ? "ok" : result.error.code).toBe("invariant_violation");
    expect(await store.load(projectId())).toEqual({ ok: true, value: undefined });
  });
});
