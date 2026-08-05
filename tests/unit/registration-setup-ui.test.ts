import { describe, expect, it } from "vitest";

import {
  createRegistrationSetupUiFeatureRegistration,
  registrationSetupApprovalApiPath,
  registrationSetupApprovalPagePath,
  type RegistrationSetupApprovalUiUseCase,
} from "../../src/ui/features/registration-setup/index.js";
import type { UiRequest } from "../../src/ui/server/index.js";

const binding = Object.freeze({
  approvalId: "approval-grant-1",
  expectedSetupRevision: 2,
  setupSessionId: "setup-session-1",
  projectId: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  previewDigest: "a".repeat(64),
  changeRequestId: "PR_node_1",
  headSha: "b".repeat(40),
  requirementsDigest: "c".repeat(64),
  diffDigest: "d".repeat(64),
});

function request(
  method: string,
  auth: UiRequest["auth"]["kind"],
  body?: UiRequest["body"],
): UiRequest {
  return Object.freeze({
    method,
    url: registrationSetupApprovalApiPath,
    headers: Object.freeze({}),
    auth: Object.freeze({ kind: auth }),
    ...(body === undefined ? {} : { body }),
  });
}

function fixture() {
  const commands: unknown[] = [];
  const useCase: RegistrationSetupApprovalUiUseCase = {
    read: () =>
      Promise.resolve(
        Object.freeze({
          state: "waiting",
          projectName: "Sandbox",
          pullRequestUrl: "https://github.test/pr/42",
          ...binding,
        }),
      ),
    approve: (command) => {
      commands.push(command);
      return Promise.resolve(Object.freeze({ state: "accepted" as const }));
    },
  };
  return { registration: createRegistrationSetupUiFeatureRegistration(useCase), commands };
}

describe("O005 registration Setup approval UI contribution", () => {
  it("owns an independent registration page and bounded mutation route", async () => {
    const { registration } = fixture();
    expect(registration).toMatchObject({
      id: "registration-setup-approval",
      slot: "registration",
      page: { path: registrationSetupApprovalPagePath },
    });
    expect(registration.routes.map((route) => route.contract)).toEqual([
      expect.objectContaining({
        path: registrationSetupApprovalApiPath,
        allowedMethods: ["GET", "PUT"],
        mutationBody: "bounded-json",
      }),
    ]);
    const html = await registration.page.render({});
    expect(html).toContain("CI 與 Fresh Review 已綁定");
    expect(html).toContain(binding.headSha);
    expect(html).not.toMatch(/<(?:html|head|body|main|script)\b/iu);
  });

  it("requires authenticated localhost session and an exact confirmation phrase", async () => {
    const { registration, commands } = fixture();
    const handler = registration.routes[0]?.handler;
    if (handler === undefined) throw new Error("missing handler");
    const validBody = {
      approvalId: binding.approvalId,
      expectedSetupRevision: binding.expectedSetupRevision,
      confirmation: "APPROVE SETUP MERGE",
    };

    expect(await handler(request("PUT", "public", validBody), {})).toMatchObject({
      statusCode: 403,
    });
    expect(
      await handler(request("PUT", "session", { ...validBody, confirmation: "yes" }), {}),
    ).toMatchObject({ statusCode: 422 });
    expect(
      await handler(request("PUT", "session", { ...validBody, source: "linear_comment" }), {}),
    ).toMatchObject({ statusCode: 422 });
    expect(commands).toEqual([]);

    expect(await handler(request("PUT", "session", validBody), {})).toMatchObject({
      statusCode: 202,
    });
    expect(commands).toEqual([
      {
        approvalId: binding.approvalId,
        expectedSetupRevision: binding.expectedSetupRevision,
        userConfirmed: true,
      },
    ]);
  });
});
