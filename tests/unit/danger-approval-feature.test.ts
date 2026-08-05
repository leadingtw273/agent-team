import { describe, expect, it } from "vitest";

import {
  createDangerApprovalUseCase,
  createDangerUiFeatureRegistration,
  InMemoryDangerApprovalStore,
  renderDangerPage,
  type DangerApprovalRequest,
} from "../../src/ui/features/danger/index.js";

const request: DangerApprovalRequest = Object.freeze({
  requestId: "danger-001",
  projectId: "project-alpha",
  projectName: "Alpha",
  category: "deployment",
  purpose: "更新測試環境",
  scope: "namespace agent-team-test",
  revision: "a".repeat(64),
});

describe("U006 dangerous operation approval", () => {
  it("registers content-only security UI with independently owned assets and API", async () => {
    const useCase = createDangerApprovalUseCase(new InMemoryDangerApprovalStore([request]));
    const registration = createDangerUiFeatureRegistration(useCase);
    const content = await registration.page.render();

    expect(registration).toMatchObject({
      id: "danger",
      slot: "security",
      page: {
        path: "/security",
        styles: ["/assets/danger.css"],
        scripts: ["/assets/danger.js"],
      },
    });
    expect(registration.routes.map((route) => route.contract.path)).toEqual([
      "/assets/danger.css",
      "/assets/danger.js",
      "/api/danger",
    ]);
    expect(content).toContain('class="danger-page"');
    expect(content).not.toMatch(/<(?:!doctype|html|head|body|main|aside|nav)\b/iu);
  });

  it("renders unknown requests with reject as their only decision", () => {
    const unknown = { ...request, requestId: "danger-unknown", category: "unknown" as const };
    const html = renderDangerPage(
      createDangerApprovalUseCase(new InMemoryDangerApprovalStore([unknown])).read(),
    );

    expect(html).toContain("未知類別只能拒絕");
    expect(html).toContain('data-decision="reject"');
    expect(html).not.toContain('data-decision="approve_once"');
    expect(html).not.toContain('data-decision="allow_project_category"');
  });

  it("binds a localhost decision to exact request, project, category, and revision CAS", () => {
    const store = new InMemoryDangerApprovalStore([request]);
    const useCase = createDangerApprovalUseCase(store);

    for (const mismatch of [
      { requestId: "danger-other" },
      { projectId: "project-other" },
      { category: "external_write" as const },
      { expectedRevision: "b".repeat(64) },
    ]) {
      expect(
        useCase.decide({
          requestId: request.requestId,
          projectId: request.projectId,
          category: request.category,
          expectedRevision: request.revision,
          decision: "approve_once",
          ...mismatch,
        }),
      ).toEqual({ state: "conflict" });
    }
    expect(useCase.read().waiting).toEqual([request]);

    expect(
      useCase.decide({
        requestId: request.requestId,
        projectId: request.projectId,
        category: request.category,
        expectedRevision: request.revision,
        decision: "approve_once",
      }),
    ).toEqual({ state: "saved" });
    expect(useCase.read().waiting).toEqual([]);
    expect(useCase.read().audit).toEqual([
      expect.objectContaining({ kind: "approved_once", requestId: request.requestId }),
    ]);
  });

  it("fails closed for unknown and never treats Linear text as authority", () => {
    const unknown = { ...request, requestId: "danger-unknown", category: "unknown" as const };
    const useCase = createDangerApprovalUseCase(new InMemoryDangerApprovalStore([unknown]));

    expect(
      useCase.decide({
        requestId: unknown.requestId,
        projectId: unknown.projectId,
        category: unknown.category,
        expectedRevision: unknown.revision,
        decision: "allow_project_category",
      }),
    ).toEqual({ state: "rejected" });
    expect(useCase.applyLinearComment("approve danger-unknown")).toEqual({ state: "ignored" });
    expect(useCase.read().waiting).toHaveLength(1);
    expect(
      useCase.decide({
        requestId: unknown.requestId,
        projectId: unknown.projectId,
        category: unknown.category,
        expectedRevision: unknown.revision,
        decision: "reject",
      }),
    ).toEqual({ state: "saved" });
    expect(useCase.read().audit).toEqual([
      expect.objectContaining({ kind: "rejected", category: "unknown" }),
    ]);
  });

  it("records the long-term decision and every matching hit", () => {
    const store = new InMemoryDangerApprovalStore([request]);
    const useCase = createDangerApprovalUseCase(store);
    expect(
      useCase.decide({
        requestId: request.requestId,
        projectId: request.projectId,
        category: request.category,
        expectedRevision: request.revision,
        decision: "allow_project_category",
      }),
    ).toEqual({ state: "saved" });
    const next = { ...request, requestId: "danger-002", revision: "c".repeat(64) };
    expect(useCase.recordLongTermHit({ ...next, projectId: "project-other" })).toEqual({
      state: "not_allowed",
    });
    expect(useCase.recordLongTermHit({ ...next, category: "external_write" })).toEqual({
      state: "not_allowed",
    });
    expect(useCase.recordLongTermHit(next)).toEqual({ state: "authorized" });
    expect(
      useCase.recordLongTermHit({ ...next, requestId: "danger-003", revision: "d".repeat(64) }),
    ).toEqual({ state: "authorized" });
    expect(useCase.read().audit.map((event) => event.kind)).toEqual([
      "project_category_allowed",
      "project_category_hit",
      "project_category_hit",
    ]);
  });
});
