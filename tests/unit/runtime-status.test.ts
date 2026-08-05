import { describe, expect, it } from "vitest";

import {
  createRuntimeStatusUiFeatureRegistration,
  fixtureRuntimeStatusReadModel,
  renderRuntimeStatusPage,
  runtimeStatusCssPath,
  runtimeStatusPagePath,
  safeRuntimeIdentifier,
  safeRuntimeLabel,
  safeRuntimeSummary,
  safeRuntimeTimestamp,
  type RuntimeStatusReadModel,
} from "../../src/ui/features/runtime-status/index.js";

function joined(...parts: readonly string[]): string {
  return parts.join("");
}

describe("runtime status read model", () => {
  it("declares content-only registration in the running slot with a feature-owned stylesheet", () => {
    const registration = createRuntimeStatusUiFeatureRegistration(fixtureRuntimeStatusReadModel);
    const content = registration.page.render();

    expect(registration.id).toBe("runtime-status");
    expect(registration.slot).toBe("running");
    expect(registration.page.path).toBe(runtimeStatusPagePath);
    expect(registration.page.styles).toEqual([runtimeStatusCssPath]);
    expect(registration.page.scripts).toBeUndefined();
    expect(registration.routes.map((route) => route.contract.path)).toEqual([runtimeStatusCssPath]);
    expect(registration.routes[0]?.contract.allowedMethods).toEqual(["GET"]);
    expect(content).toContain("Runtime 工作狀態");
    expect(content).not.toContain("<html");
    expect(content).not.toContain("ui-sidebar");
  });

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

  it("uses shared redactor detection for Runtime summaries and labels without hiding normal Chinese", () => {
    const providerToken = joined("github", "_pat_", "abcdefghijklmnopqrstuvwxyz");
    const jwt = joined("eyJ", "abcdefghijk", ".", "abcdefghijkl", ".", "abcdefghijkl");
    const header = "Authorization: Bearer header-secret-value";
    const credentialUrl = "https://user-name:password-value@example.test/runtime";
    const nestedProviderSummary = `巢狀阻塞摘要：${providerToken}`;
    const longSummary = `摘要：${"可讀狀態".repeat(80)}`;
    const bareBearer = "Bearer opaque-value";
    const privateKeyMarker = "-----BEGIN PRIVATE KEY----- private-material";
    const embeddedCommand = "診斷摘要 git reset --hard";

    for (const value of [
      providerToken,
      jwt,
      header,
      credentialUrl,
      nestedProviderSummary,
      longSummary,
      "git reset --hard",
      bareBearer,
      privateKeyMarker,
      embeddedCommand,
    ]) {
      expect(safeRuntimeSummary(value)).toBe("已隱藏不安全的原始內容");
    }
    for (const value of [providerToken, jwt]) {
      expect(safeRuntimeLabel(value)).toBe("未提供安全摘要");
    }
    expect(safeRuntimeIdentifier(providerToken)).toBe("已隱藏不安全的識別資訊");
    expect(safeRuntimeTimestamp(header)).toBe("未提供安全時間");
    expect(safeRuntimeSummary("週額度不足，等待 5 小時後再檢查。 ")).toBe(
      "週額度不足，等待 5 小時後再檢查。",
    );
    expect(safeRuntimeLabel("實作者 模型摘要")).toBe("實作者 模型摘要");
    const longSafeIdentifier = `job_${"safe-identifier-".repeat(40)}`;
    expect(safeRuntimeIdentifier(longSafeIdentifier)).toBe(longSafeIdentifier);
  });

  it("fails closed before rendering unsafe external Runtime fields", () => {
    const first = fixtureRuntimeStatusReadModel.listRuntimeStatuses()[0];
    if (first === undefined)
      throw new Error("The runtime status fixture is missing its first entry.");
    const firstProgress = first.lastEffectiveProgress;
    if (firstProgress === undefined) {
      throw new Error("The runtime status fixture must show effective progress.");
    }
    const firstBlock = first.block;
    if (firstBlock === undefined) throw new Error("The runtime status fixture must show a block.");
    const providerToken = joined("sk", "-ant-", "abcdefghijklmnopqrstuv");
    const jwt = joined("eyJ", "abcdefghijk", ".", "abcdefghijkl", ".", "abcdefghijkl");
    const header = "Authorization: Bearer header-secret-value";
    const credentialUrl = "https://user-name:password-value@example.test/runtime";
    const longSummary = `下一步：${"可讀狀態".repeat(80)}`;

    const unsafeReadModel: RuntimeStatusReadModel = Object.freeze({
      source: "runtime",
      listRuntimeStatuses: () =>
        Object.freeze([
          Object.freeze({
            ...first,
            job: Object.freeze({
              ...first.job,
              issueId: providerToken as typeof first.job.issueId,
            }),
            roleModel: Object.freeze({
              ...first.roleModel,
              provider: providerToken,
              model: jwt,
            }),
            lastEffectiveProgress: Object.freeze({
              ...firstProgress,
              summary: `巢狀有效進度：${providerToken}`,
            }),
            block: Object.freeze({
              ...firstBlock,
              summary: credentialUrl,
              nextStep: header,
            }),
            ...(first.checkpoint === undefined
              ? {}
              : {
                  checkpoint: Object.freeze({
                    ...first.checkpoint,
                    nextStep: longSummary,
                  }),
                }),
            nextStep: `curl https://runtime.invalid --header '${header}'`,
            rawCommand: "rm -rf /dangerous-path",
            secret: "header-secret-value",
            hiddenReasoning: "internal chain of thought",
          }),
        ]),
    });

    const html = renderRuntimeStatusPage(unsafeReadModel);

    expect(html).toContain("Job ID");
    expect(html).toContain("Lease");
    expect(html).toContain("嘗試次數");
    expect(html).toContain("最後有效進度");
    expect(html).toContain("45 分鐘檢查");
    expect(html).toContain("60 分鐘硬邊界");
    expect(html).toContain("Checkpoint");
    expect(html).toContain("實作者");
    expect(html).toContain("已隱藏不安全的原始內容");
    expect(html).toContain("未提供安全摘要");
    expect(html).toContain("已隱藏不安全的識別資訊");
    expect(html).not.toContain("curl https://runtime.invalid");
    expect(html).not.toContain(providerToken);
    expect(html).not.toContain(jwt);
    expect(html).not.toContain("header-secret-value");
    expect(html).not.toContain("user-name");
    expect(html).not.toContain("password-value");
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
