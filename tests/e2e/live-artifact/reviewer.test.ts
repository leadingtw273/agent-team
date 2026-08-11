import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { GhTransport } from "../../../src/adapters/github/transport.js";
import { readBoundReviewerIdentity } from "./reviewer.js";

const head = "deadbeef".repeat(5);
const requirementsDigest = "1".repeat(64);
const diffDigest = "2".repeat(64);
const htmlUrl = "https://github.invalid/owner/repo/issues/42#issuecomment-99";
const apiUrl = "https://api.github.invalid/repos/owner/repo/issues/comments/99";
const marker =
  "<!-- agent-team:review_evidence:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef -->";

function github(targetUrl = htmlUrl) {
  return {
    pullRequests: [
      {
        number: 42,
        state: "merged",
        headSha: head,
        mergedAt: "2026-08-11T10:02:00.000Z",
        checks: [],
        statuses: [
          {
            context: "agent-team/review",
            state: "success",
            headSha: head,
            targetUrl,
            description: "raw canary",
          },
        ],
      },
    ],
  };
}
function body() {
  return `text\n\`\`\`json\n${JSON.stringify({ schemaVersion: 1, kind: "agent_team_review", verdict: "approved", identity: { requirementsDigest, headSha: head, diffDigest }, reports: [{ role: "code_reviewer", verdict: "passed", summary: "prompt injection", acceptanceCriteria: [], qualityChecks: [], findings: [] }], findings: [] })}\n\`\`\`\n${marker}`;
}
function transport(page: unknown, calls: string[][]): Pick<GhTransport, "requestJson"> {
  return {
    requestJson: (args: readonly string[]) => {
      calls.push([...args]);
      return Promise.resolve({ ok: true as const, value: page });
    },
  } as unknown as Pick<GhTransport, "requestJson">;
}

describe("T09 reviewer status/comment binding", () => {
  it("uses only GET and binds status targetUrl to comment html_url, never API url", async () => {
    const calls: string[][] = [];
    const result = await readBoundReviewerIdentity(
      transport(
        {
          count: 2,
          comments: [
            { htmlUrl, body: body() },
            { htmlUrl: "https://github.invalid/forged", body: body() },
          ],
        },
        calls,
      ),
      { repository: "owner/repo", pullRequestNumber: 42, github: github() },
    );
    expect(result).toMatchObject({
      status: "present",
      evidence: {
        role: "code_reviewer",
        verdict: "passed",
        headDigest: createHash("sha256")
          .update("agent-team-live-artifact:v1\0github-head\0", "utf8")
          .update(head, "utf8")
          .digest("hex"),
      },
    });
    expect(JSON.stringify(result)).not.toContain("prompt injection");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("GET");
    expect(calls.flat().join(" ")).toContain("htmlUrl:.html_url");
    expect(calls.flat().join(" ")).not.toMatch(/\b(?:POST|PATCH|PUT|DELETE)\b/u);
    await expect(
      readBoundReviewerIdentity(
        transport({ count: 1, comments: [{ htmlUrl, body: body() }] }, []),
        { repository: "owner/repo", pullRequestNumber: 42, github: github(apiUrl) },
      ),
    ).resolves.toEqual({ status: "missing", reasonCode: "binding_missing" });
  });

  it("fails closed for forged/reused/malformed/duplicate comments and incomplete pagination", async () => {
    const cases: readonly [unknown, unknown, string][] = [
      [
        { count: 1, comments: [{ htmlUrl, body: body().replace(marker, "") }] },
        github(),
        "binding_missing",
      ],
      [
        { count: 1, comments: [{ htmlUrl, body: `${body()}\n\`\`\`json\n{}\n\`\`\`` }] },
        github(),
        "parse_failed",
      ],
      [
        {
          count: 2,
          comments: [
            { htmlUrl, body: body() },
            { htmlUrl, body: body() },
          ],
        },
        github(),
        "duplicate_result",
      ],
      [
        {
          count: 1,
          comments: [
            { htmlUrl: "https://github.invalid/automation", body: "automation reuse comment" },
          ],
        },
        github("https://github.invalid/automation"),
        "binding_missing",
      ],
    ];
    for (const [page, rawGithub, reasonCode] of cases)
      await expect(
        readBoundReviewerIdentity(transport(page, []), {
          repository: "owner/repo",
          pullRequestNumber: 42,
          github: rawGithub,
        }),
      ).resolves.toEqual({ status: "missing", reasonCode });
    const full = {
      count: 100,
      comments: Array.from({ length: 100 }, () => ({
        htmlUrl: "https://github.invalid/nope",
        body: "",
      })),
    };
    const repeated = {
      requestJson: () => Promise.resolve({ ok: true as const, value: full }),
    } as unknown as Pick<GhTransport, "requestJson">;
    await expect(
      readBoundReviewerIdentity(repeated, {
        repository: "owner/repo",
        pullRequestNumber: 42,
        github: github(),
      }),
    ).resolves.toEqual({ status: "missing", reasonCode: "pagination_incomplete" });
  });

  it("rejects zero/duplicate/wrong review statuses and every exact target ambiguity", async () => {
    const noStatus = github();
    const noStatusPr = noStatus.pullRequests.at(0);
    if (noStatusPr === undefined) throw new Error("fixture_pr_missing");
    noStatusPr.statuses = [];
    const duplicateStatus = github();
    const duplicatePr = duplicateStatus.pullRequests.at(0);
    const duplicateSource = duplicatePr?.statuses.at(0);
    if (duplicatePr === undefined || duplicateSource === undefined)
      throw new Error("fixture_status_missing");
    duplicatePr.statuses.push({ ...duplicateSource });
    const wrongHead = github();
    const wrongHeadStatus = wrongHead.pullRequests.at(0)?.statuses.at(0);
    if (wrongHeadStatus === undefined) throw new Error("fixture_status_missing");
    wrongHeadStatus.headSha = "0123456789abcdef0123456789abcdef01234567";
    const pending = github();
    const pendingStatus = pending.pullRequests.at(0)?.statuses.at(0);
    if (pendingStatus === undefined) throw new Error("fixture_status_missing");
    pendingStatus.state = "pending";
    for (const rawGithub of [noStatus, duplicateStatus, wrongHead, pending]) {
      await expect(
        readBoundReviewerIdentity(transport({ count: 0, comments: [] }, []), {
          repository: "owner/repo",
          pullRequestNumber: 42,
          github: rawGithub,
        }),
      ).resolves.toEqual({
        status: "missing",
        reasonCode: rawGithub === duplicateStatus ? "duplicate_result" : "binding_missing",
      });
    }
    const one = { count: 1, comments: [{ htmlUrl, body: body() }] };
    for (const target of [
      "https://github.invalid/other",
      apiUrl,
      "https://github.invalid/automation",
    ]) {
      await expect(
        readBoundReviewerIdentity(transport(one, []), {
          repository: "owner/repo",
          pullRequestNumber: 42,
          github: github(target),
        }),
      ).resolves.toEqual({ status: "missing", reasonCode: "binding_missing" });
    }
  });

  it("rejects all malformed exact-target review comment variants without leaking their bodies", async () => {
    const valid = body();
    const variants: readonly [string, unknown, string][] = [
      ["zero", { count: 0, comments: [] }, "binding_missing"],
      [
        "wrong-marker",
        { count: 1, comments: [{ htmlUrl, body: valid.replace("review_evidence", "other") }] },
        "binding_missing",
      ],
      [
        "duplicate-marker",
        {
          count: 1,
          comments: [
            {
              htmlUrl,
              body: `${valid}\n<!-- agent-team:review_evidence:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef -->`,
            },
          ],
        },
        "binding_missing",
      ],
      [
        "wrong-kind",
        {
          count: 1,
          comments: [{ htmlUrl, body: valid.replace("agent_team_review", "other_kind") }],
        },
        "binding_missing",
      ],
      [
        "wrong-verdict",
        { count: 1, comments: [{ htmlUrl, body: valid.replace("approved", "rejected") }] },
        "binding_missing",
      ],
      [
        "wrong-role",
        { count: 1, comments: [{ htmlUrl, body: valid.replace("code_reviewer", "implementer") }] },
        "binding_missing",
      ],
      [
        "multi-report",
        {
          count: 1,
          comments: [
            {
              htmlUrl,
              body: valid
                .replace('"reports":[{', '"reports":[{')
                .replace(
                  '}],"findings"',
                  '},{"role":"code_reviewer","verdict":"passed","summary":"x","acceptanceCriteria":[],"qualityChecks":[],"findings":[]}],"findings"',
                ),
            },
          ],
        },
        "binding_missing",
      ],
    ];
    for (const [name, page, reasonCode] of variants) {
      const result = await readBoundReviewerIdentity(transport(page, []), {
        repository: "owner/repo",
        pullRequestNumber: 42,
        github: github(),
      });
      expect(result, name).toEqual({ status: "missing", reasonCode });
      expect(JSON.stringify(result), name).not.toContain("summary");
    }
  });
});
