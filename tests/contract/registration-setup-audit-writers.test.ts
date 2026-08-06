/**
 * Contract tests for the two O009 production `RegistrationSetupAuditPort` writers added to close
 * the O005 gap surfaced by the O009 escalation trigger: neither `LinearAuditCommentWriter` nor
 * `PullRequestAuditCommentWriter` had ever had a production implementation before this. Both
 * writers here are thin field-mapping adapters over already-existing, already-tested production
 * clients (`SourceControlPort.appendChangeRequestComment` / `LinearMutationClient.appendComment`
 * + `LinearReadModel.readContext`) -- these tests exercise only the mapping/pass-through logic
 * this task adds, not the delegates' own internals (those already have their own contract
 * tests).
 */
import { describe, expect, it, vi } from "vitest";

import type { MutationOptions, SourceControlPort } from "../../src/application/ports/index.js";
import {
  GitHubPullRequestAuditCommentWriter,
  LinearIssueAuditCommentWriter,
} from "../../src/adapters/registration/index.js";
import type { LinearMutationClient, LinearReadModel } from "../../src/adapters/linear/index.js";
import type { LinearProjectContext } from "../../src/adapters/linear/model.js";
import { domainError, err, ok, parseInstant } from "../../src/domain/foundation/index.js";

function instant(value: string) {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

describe("GitHubPullRequestAuditCommentWriter (O009 production adapter)", () => {
  const headSha = "a".repeat(40);
  const changeRequest = Object.freeze({
    projectId: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    repository: "owner/sandbox",
    changeRequestId: "42",
  });
  const options: MutationOptions = Object.freeze({ idempotencyKey: "audit:pr:1" });

  it("maps a successful upstream comment into the external audit receipt shape, fixing kind to automation", async () => {
    const appendChangeRequestComment = vi.fn<SourceControlPort["appendChangeRequestComment"]>();
    appendChangeRequestComment.mockResolvedValue(
      ok({
        id: "comment-1",
        url: "https://github.test/owner/sandbox/pull/42#comment-1",
        createdAt: instant("2026-08-06T00:00:00.000Z"),
      }),
    );
    const writer = new GitHubPullRequestAuditCommentWriter({ appendChangeRequestComment });

    const result = await writer.appendChangeRequestComment(
      changeRequest,
      headSha,
      "audit body from the engine",
      options,
    );

    expect(result).toEqual(
      ok({
        id: "comment-1",
        body: "audit body from the engine",
        createdAt: instant("2026-08-06T00:00:00.000Z"),
        reused: false,
      }),
    );
    expect(appendChangeRequestComment).toHaveBeenCalledTimes(1);
    const command = appendChangeRequestComment.mock.calls[0]?.[0];
    const forwardedOptions = appendChangeRequestComment.mock.calls[0]?.[1];
    expect(command).toMatchObject({
      changeRequest: {
        project: { sourceControl: { provider: "github", repository: "owner/sandbox" } },
        changeRequestId: "42",
      },
      expectedHeadSha: headSha,
      kind: "automation",
      body: "audit body from the engine",
    });
    expect(forwardedOptions).toBe(options);
  });

  it("propagates an upstream rejection unchanged rather than manufacturing a receipt", async () => {
    const upstreamError = err(domainError("conflict"));
    const appendChangeRequestComment = vi.fn<SourceControlPort["appendChangeRequestComment"]>();
    appendChangeRequestComment.mockResolvedValue(upstreamError);
    const writer = new GitHubPullRequestAuditCommentWriter({ appendChangeRequestComment });

    const result = await writer.appendChangeRequestComment(
      changeRequest,
      headSha,
      "audit body",
      options,
    );

    expect(result).toEqual(upstreamError);
  });

  it("passes the caller's idempotencyKey through unchanged", async () => {
    const appendChangeRequestComment = vi.fn<SourceControlPort["appendChangeRequestComment"]>();
    appendChangeRequestComment.mockResolvedValue(
      ok({
        id: "comment-2",
        url: "https://github.test/pull/42#comment-2",
        createdAt: instant("2026-08-06T00:00:00.000Z"),
      }),
    );
    const writer = new GitHubPullRequestAuditCommentWriter({ appendChangeRequestComment });
    const distinctOptions: MutationOptions = { idempotencyKey: "audit:pr:distinct-key" };

    await writer.appendChangeRequestComment(changeRequest, headSha, "body", distinctOptions);

    expect(appendChangeRequestComment.mock.calls[0]?.[1]?.idempotencyKey).toBe(
      "audit:pr:distinct-key",
    );
  });
});

describe("LinearIssueAuditCommentWriter (O009 production adapter)", () => {
  const target = Object.freeze({ teamId: "team-1", projectId: "linear-project-1" });
  const context = Object.freeze({
    team: Object.freeze({ id: "team-1", name: "Sandbox", key: "SBX" }),
    project: Object.freeze({ id: "linear-project-1", name: "Sandbox Project" }),
    catalog: Object.freeze({}),
  }) as unknown as LinearProjectContext;

  it("resolves the context by exact team/project id and maps a successful comment into the receipt shape", async () => {
    const readContext = vi.fn<LinearReadModel["readContext"]>();
    readContext.mockResolvedValue(ok(context));
    const appendComment = vi.fn<LinearMutationClient["appendComment"]>();
    appendComment.mockResolvedValue(
      ok({
        id: "issue-comment-1",
        body: "audit body",
        createdAt: instant("2026-08-06T00:00:00.000Z"),
        reused: false,
      }),
    );
    const writer = new LinearIssueAuditCommentWriter({ readContext }, { appendComment }, target);

    const result = await writer.appendComment("LINEAR-AUDIT-1", "audit body", "audit:linear:1");

    expect(readContext).toHaveBeenCalledWith("team-1", "linear-project-1");
    expect(appendComment).toHaveBeenCalledWith(
      context,
      "LINEAR-AUDIT-1",
      "audit body",
      "audit:linear:1",
    );
    expect(result).toEqual(
      ok({
        id: "issue-comment-1",
        body: "audit body",
        createdAt: instant("2026-08-06T00:00:00.000Z"),
        reused: false,
      }),
    );
  });

  it("fails closed on an unresolved context and never calls the mutation client", async () => {
    const readContext = vi.fn<LinearReadModel["readContext"]>();
    readContext.mockResolvedValue(err(domainError("not_found")));
    const appendComment = vi.fn<LinearMutationClient["appendComment"]>();
    appendComment.mockResolvedValue(
      ok({
        id: "unused",
        body: "unused",
        createdAt: instant("2026-08-06T00:00:00.000Z"),
        reused: false,
      }),
    );
    const writer = new LinearIssueAuditCommentWriter({ readContext }, { appendComment }, target);

    const result = await writer.appendComment("LINEAR-AUDIT-1", "audit body", "audit:linear:2");

    expect(result).toEqual(err(domainError("not_found")));
    expect(appendComment).not.toHaveBeenCalled();
  });

  it("propagates an upstream mutation rejection unchanged", async () => {
    const readContext = vi.fn<LinearReadModel["readContext"]>();
    readContext.mockResolvedValue(ok(context));
    const upstreamError = err(domainError("conflict"));
    const appendComment = vi.fn<LinearMutationClient["appendComment"]>();
    appendComment.mockResolvedValue(upstreamError);
    const writer = new LinearIssueAuditCommentWriter({ readContext }, { appendComment }, target);

    const result = await writer.appendComment("LINEAR-AUDIT-1", "audit body", "audit:linear:3");

    expect(result).toEqual(upstreamError);
  });

  it("passes the caller's idempotencyKey through unchanged", async () => {
    const readContext = vi.fn<LinearReadModel["readContext"]>();
    readContext.mockResolvedValue(ok(context));
    const appendComment = vi.fn<LinearMutationClient["appendComment"]>();
    appendComment.mockResolvedValue(
      ok({
        id: "issue-comment-3",
        body: "audit body",
        createdAt: instant("2026-08-06T00:00:00.000Z"),
        reused: true,
      }),
    );
    const writer = new LinearIssueAuditCommentWriter({ readContext }, { appendComment }, target);

    await writer.appendComment("LINEAR-AUDIT-1", "audit body", "audit:linear:distinct-key");

    expect(appendComment.mock.calls[0]?.[3]).toBe("audit:linear:distinct-key");
  });
});
