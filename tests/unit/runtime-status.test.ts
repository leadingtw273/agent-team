import { describe, expect, it } from "vitest";

import {
  fixtureRuntimeStatusReadModel,
  renderRuntimeStatusPage,
  type RuntimeStatusReadModel,
} from "../../src/ui/features/runtime-status/index.js";

describe("runtime status read model", () => {
  it("covers Crash, quota, danger approval, and unknown blockers with safe summaries", () => {
    const statuses = fixtureRuntimeStatusReadModel.listRuntimeStatuses();

    expect(statuses.map((status) => status.block?.kind)).toEqual([
      "crash",
      "quota",
      "danger_approval",
      "unknown",
    ]);
    const quotaBlock = statuses.find((status) => status.block?.kind === "quota")?.block;
    if (quotaBlock?.kind !== "quota") throw new Error("The quota fixture is missing.");
    expect(quotaBlock.quotaWindows).toEqual(["weekly", "five_hour"]);
    expect(statuses.map((status) => status.lastEffectiveProgress?.kind)).toEqual([
      "checkpoint_created",
      "test_or_build_milestone",
      "controlled_git_diff",
      "narrowing_error_evidence",
    ]);
  });

  it("renders the operational fields without raw command, secret, or hidden reasoning data", () => {
    const first = fixtureRuntimeStatusReadModel.listRuntimeStatuses()[0];
    if (first === undefined)
      throw new Error("The runtime status fixture is missing its first entry.");
    const firstProgress = first.lastEffectiveProgress;
    if (firstProgress === undefined) {
      throw new Error("The runtime status fixture must show effective progress.");
    }

    const unsafeReadModel: RuntimeStatusReadModel = Object.freeze({
      source: "runtime",
      listRuntimeStatuses: () =>
        Object.freeze([
          Object.freeze({
            ...first,
            lastEffectiveProgress: Object.freeze({
              ...firstProgress,
              summary:
                "curl https://runtime.invalid --header 'Authorization: Bearer fixture-secret'",
            }),
            rawCommand: "rm -rf /dangerous-path",
            secret: "fixture-secret",
            hiddenReasoning: "internal chain of thought",
          }),
        ]),
    });

    const html = renderRuntimeStatusPage(unsafeReadModel);

    expect(html).toContain("工作 ID");
    expect(html).toContain("租約");
    expect(html).toContain("嘗試次數");
    expect(html).toContain("最後有效進度");
    expect(html).toContain("45 分鐘檢查");
    expect(html).toContain("60 分鐘硬邊界");
    expect(html).toContain("Checkpoint");
    expect(html).toContain("實作者");
    expect(html).toContain("Codex");
    expect(html).toContain("已隱藏不安全的原始內容");
    expect(html).not.toContain("curl https://runtime.invalid");
    expect(html).not.toContain("fixture-secret");
    expect(html).not.toContain("rm -rf /dangerous-path");
    expect(html).not.toContain("internal chain of thought");
  });

  it("presents danger approval as unavailable read-only state until U006 is connected", () => {
    const html = renderRuntimeStatusPage(fixtureRuntimeStatusReadModel);

    expect(html).toContain("安全核可功能尚未接入，本頁僅呈現等待狀態，現在不可操作。");
    expect(html).not.toContain("在安全頁確認類別、目的與範圍後核可或拒絕");
    expect(html).not.toContain("等待使用者在本機安全頁做出核可或拒絕");
    expect(html).not.toContain('href="/security"');
  });
});
