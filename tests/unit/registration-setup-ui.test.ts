import { describe, expect, it } from "vitest";

import type {
  RegistrationSetupControllerActionResult,
  RegistrationSetupControllerReadModel,
  RegistrationSetupControllerUseCase,
} from "../../src/application/registration/index.js";
import {
  createRegistrationSetupUiContribution,
  registrationSetupApiPath,
  registrationSetupCssPath,
  registrationSetupScriptPath,
} from "../../src/ui/features/registration-setup/index.js";
import type { UiRequest } from "../../src/ui/server/index.js";

const authorityDigest = "a".repeat(64);
const previewDigest = "b".repeat(64);
const setupSessionId = `setup-${"c".repeat(64)}`;
const previewModel: RegistrationSetupControllerReadModel = Object.freeze({
  state: "preview_ready",
  evidence: Object.freeze([
    Object.freeze({ code: "merge_w3b_unwired", message: "merge remains unavailable" }),
  ]),
  nextStep: "Confirm the server-side preview.",
  preview: Object.freeze({
    setupSessionId,
    projectId: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    projectName: "Sandbox",
    repository: "owner/sandbox",
    defaultBranch: "main",
    baseRevision: "d".repeat(40),
    previewDigest,
    requirementsDigest: "e".repeat(64),
    linearAuditIssueId: "LINEAR-AUDIT-1",
  }),
});

function request(
  method: string,
  auth: UiRequest["auth"]["kind"],
  body?: UiRequest["body"],
): UiRequest {
  return Object.freeze({
    method,
    url: registrationSetupApiPath,
    headers: Object.freeze({}),
    auth: Object.freeze({ kind: auth }),
    ...(body === undefined ? {} : { body }),
  });
}

function fixture() {
  const calls: unknown[] = [];
  const accepted: RegistrationSetupControllerActionResult = Object.freeze({
    state: "preview_confirmation_issued",
    setupSessionId,
    previewDigest,
    tokenId: "preview-token-1",
    expiresAt: "2026-08-06T12:05:00.000Z",
  });
  const controller: RegistrationSetupControllerUseCase = {
    read: (context) => {
      calls.push(["read", context]);
      return Promise.resolve(previewModel);
    },
    confirmPreview: (command, context) => {
      calls.push(["confirm", command, context]);
      return Promise.resolve(accepted);
    },
    start: (command, context) => {
      calls.push(["start", command, context]);
      return Promise.resolve(
        Object.freeze({ state: "blocked" as const, reason: "not_found" as const }),
      );
    },
    refresh: (command, context) => {
      calls.push(["refresh", command, context]);
      return Promise.resolve(
        Object.freeze({ state: "blocked" as const, reason: "not_found" as const }),
      );
    },
    resume: (command, context) => {
      calls.push(["resume", command, context]);
      return Promise.resolve(
        Object.freeze({ state: "blocked" as const, reason: "not_found" as const }),
      );
    },
    issueLocalUiApprovalIntent: (command, context) => {
      calls.push(["approval", command, context]);
      return Promise.resolve(
        Object.freeze({ state: "blocked" as const, reason: "not_found" as const }),
      );
    },
    approveAndMergeLocalUi: (command, context) => {
      calls.push(["merge", command, context]);
      return Promise.resolve(
        Object.freeze({ state: "blocked" as const, reason: "not_found" as const }),
      );
    },
  };
  return { contribution: createRegistrationSetupUiContribution(controller), calls };
}

describe("O005 Registration Setup Wizard contribution", () => {
  it("contributes routes and assets without declaring a second top-level slot", async () => {
    const { contribution } = fixture();
    expect(contribution).not.toHaveProperty("slot");
    expect(contribution.styles).toEqual([registrationSetupCssPath]);
    expect(contribution.scripts).toEqual([registrationSetupScriptPath]);
    expect(contribution.routes.map((route) => route.contract.path)).toEqual([
      registrationSetupCssPath,
      registrationSetupScriptPath,
      registrationSetupApiPath,
    ]);
    const html = await contribution.render({ session: { authorityDigest } });
    expect(html).toContain("可信設定 Setup");
    expect(html).toContain("CREATE SETUP DRAFT PR");
    expect(html).toContain("merge_w3b_unwired");
    expect(html).not.toMatch(/<(?:html|head|body|main|script)\b/iu);
  });

  it("takes authority only from trusted context and rejects body path/config injection", async () => {
    const { contribution, calls } = fixture();
    const handler = contribution.routes[2]?.handler;
    if (handler === undefined) throw new Error("missing setup API handler");
    const body = {
      action: "confirm_preview",
      setupSessionId,
      previewDigest,
      confirmation: "CREATE SETUP DRAFT PR",
      operationId: "operation-1",
    };

    await expect(handler(request("PUT", "public", body), {})).resolves.toMatchObject({
      statusCode: 403,
    });
    await expect(
      handler(request("PUT", "session", { ...body, repositoryPath: "/tmp/forged" }), {
        session: { authorityDigest },
      }),
    ).resolves.toMatchObject({ statusCode: 422 });
    for (const injected of [
      { source: "current_user_conversation" },
      { authorityDigest: "f".repeat(64) },
      { webhookComment: "APPROVE SETUP MERGE" },
    ]) {
      await expect(
        handler(request("PUT", "session", { ...body, ...injected }), {
          session: { authorityDigest },
        }),
      ).resolves.toMatchObject({ statusCode: 422 });
    }
    expect(calls).toEqual([]);

    await expect(
      handler(request("PUT", "session", body), { session: { authorityDigest } }),
    ).resolves.toMatchObject({ statusCode: 202 });
    expect(calls).toEqual([
      [
        "confirm",
        {
          setupSessionId,
          previewDigest,
          confirmation: "CREATE SETUP DRAFT PR",
          idempotencyKey: "ui:operation-1:confirm-preview",
        },
        { authorityDigest },
      ],
    ]);
  });

  it("accepts only a durable approval ID for the second local-UI merge step", async () => {
    const { contribution, calls } = fixture();
    const handler = contribution.routes[2]?.handler;
    if (handler === undefined) throw new Error("missing setup API handler");
    const body = {
      action: "approve_and_merge",
      setupSessionId,
      expectedSetupRevision: 7,
      approvalId: "approval-1",
      operationId: "operation-merge-1",
    };
    for (const injected of [
      { confirmation: "APPROVE SETUP MERGE" },
      { source: "current_user_conversation" },
      { pullRequestComment: "APPROVE SETUP MERGE" },
    ]) {
      await expect(
        handler(request("PUT", "session", { ...body, ...injected }), {
          session: { authorityDigest },
        }),
      ).resolves.toMatchObject({ statusCode: 422 });
    }
    await expect(
      handler(request("PUT", "session", body), { session: { authorityDigest } }),
    ).resolves.toMatchObject({ statusCode: 409 });
    expect(calls).toEqual([
      [
        "merge",
        {
          setupSessionId,
          expectedSetupRevision: 7,
          approvalId: "approval-1",
          idempotencyKeyPrefix: "ui:operation-merge-1:approve-merge",
        },
        { authorityDigest },
      ],
    ]);
  });

  it("accepts resume only as an exact POST without a client-selected target or approval secret", async () => {
    const { contribution, calls } = fixture();
    const handler = contribution.routes[2]?.handler;
    if (handler === undefined) throw new Error("missing setup API handler");
    const body = { action: "resume", operationId: "operation-resume-1" };

    for (const rejected of [
      request("PUT", "session", body),
      request("POST", "session", { ...body, setupSessionId }),
      request("POST", "session", { ...body, approvalId: "approval-1" }),
      request("POST", "session", { ...body, authorityDigest }),
    ]) {
      await expect(handler(rejected, { session: { authorityDigest } })).resolves.toMatchObject({
        statusCode: 422,
      });
    }
    expect(calls).toEqual([]);

    await expect(
      handler(request("POST", "session", body), { session: { authorityDigest } }),
    ).resolves.toMatchObject({ statusCode: 409 });
    expect(calls).toEqual([
      ["resume", { idempotencyKeyPrefix: "ui:operation-resume-1:resume" }, { authorityDigest }],
    ]);
  });
});
