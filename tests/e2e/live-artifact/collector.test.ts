import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { GhTransport } from "../../../src/adapters/github/transport.js";
import { collectProductionLiveArtifact, type ExternalAuthorityPorts } from "./collector.js";
import {
  createLocalHomeFixture,
  fixtureExternalIssueId,
  fixtureGit,
  fixtureGithub,
  fixtureJobId,
  fixtureLinear,
  fixtureProjectId,
  fixtureProvenance,
  fixtureReviewerBody,
  fixtureReviewHtmlUrl,
} from "./fixtures.js";
import { replayLiveArtifact } from "./validator.js";
import { serializeLiveArtifact } from "./writer.js";

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function comments(): Pick<GhTransport, "requestJson"> {
  return {
    requestJson: () =>
      Promise.resolve({
        ok: true as const,
        value: {
          count: 1,
          comments: [{ htmlUrl: fixtureReviewHtmlUrl, body: fixtureReviewerBody() }],
        },
      }),
  } as unknown as Pick<GhTransport, "requestJson">;
}

function input(home: string) {
  return {
    provenance: fixtureProvenance(),
    projectId: fixtureProjectId,
    expectedLinearIssueId: fixtureExternalIssueId,
    expectedCanaryJobId: fixtureJobId,
    repository: "owner/repository",
    pullRequestNumber: 42,
    agentTeamHome: home,
  };
}

function ports(attempts: string[], turns: readonly number[] = []): ExternalAuthorityPorts {
  const wait = async (index: number, value: unknown): Promise<unknown> => {
    for (let turn = 0; turn < (turns[index] ?? 0); turn += 1) await Promise.resolve();
    return value;
  };
  return {
    linear: {
      read: () => {
        attempts.push("linear");
        return wait(0, { state: "present", value: fixtureLinear() });
      },
    },
    github: {
      read: () => {
        attempts.push("github");
        return wait(1, { state: "present", value: fixtureGithub() });
      },
    },
    git: {
      read: () => {
        attempts.push("git");
        return wait(2, { state: "present", value: fixtureGit() });
      },
    },
    githubComments: comments(),
  };
}

describe("T09 production collector", () => {
  it("starts all four sources, binds the exact Linear ID, and produces a replayable projection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T10:04:00.000Z"));
    const home = await createLocalHomeFixture();
    roots.push(home);
    const attempts: string[] = [];
    const artifact = await collectProductionLiveArtifact(input(home), ports(attempts));
    expect(attempts.sort()).toEqual(["git", "github", "linear"]);
    expect(artifact.authorities).toMatchObject({
      linear: { status: "present", evidence: { issueAlias: "issue-1", issueCount: 1 } },
      github: { status: "present", evidence: { pullRequestAlias: "pr-1" } },
      local: { status: "present", evidence: { jobAlias: "job-1" } },
      git: { status: "present" },
    });
    expect(replayLiveArtifact(artifact).overall).toBe("pass");
    expect(JSON.stringify(artifact)).not.toContain(fixtureExternalIssueId);
    expect(JSON.stringify(artifact)).not.toContain(fixtureJobId);
  });

  it("settles every external read and maps rejected or malformed values to missing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T10:04:00.000Z"));
    const home = await createLocalHomeFixture();
    roots.push(home);
    const attempts: string[] = [];
    const rejected: ExternalAuthorityPorts = {
      linear: {
        read: () => {
          attempts.push("linear");
          return Promise.reject(new Error("untrusted linear error"));
        },
      },
      github: {
        read: () => {
          attempts.push("github");
          return Promise.resolve(null);
        },
      },
      git: {
        read: () => {
          attempts.push("git");
          return Promise.resolve({ state: "unknown" });
        },
      },
      githubComments: comments(),
    };
    const artifact = await collectProductionLiveArtifact(input(home), rejected);
    expect(attempts.sort()).toEqual(["git", "github", "linear"]);
    expect(artifact.authorities.linear).toEqual({ status: "missing", reasonCode: "read_failed" });
    expect(artifact.authorities.github).toEqual({ status: "missing", reasonCode: "parse_failed" });
    expect(artifact.authorities.git).toEqual({ status: "missing", reasonCode: "parse_failed" });
    expect(replayLiveArtifact(artifact).overall).toBe("fail");
    expect(JSON.stringify(artifact)).not.toContain("untrusted linear error");
  });

  it("attempts all sources even when all externally supplied values reject or are malformed", async () => {
    const attempts: string[] = [];
    const rejected: ExternalAuthorityPorts = {
      linear: {
        read: () => {
          attempts.push("linear");
          return Promise.reject(new Error("linear-canary"));
        },
      },
      github: {
        read: () => {
          attempts.push("github");
          return Promise.reject(new Error("github-canary"));
        },
      },
      git: {
        read: () => {
          attempts.push("git");
          return Promise.reject(new Error("git-canary"));
        },
      },
      githubComments: comments(),
    };
    const artifact = await collectProductionLiveArtifact(input("relative-home"), rejected);
    expect(attempts.sort()).toEqual(["git", "github", "linear"]);
    expect(Object.values(artifact.authorities).every((item) => item.status === "missing")).toBe(
      true,
    );
    expect(replayLiveArtifact(artifact).overall).toBe("fail");
    expect(JSON.stringify(artifact)).not.toMatch(/(?:linear|github|git)-canary/u);
  });

  it("has stable bytes when external completion order changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T10:04:00.000Z"));
    const firstHome = await createLocalHomeFixture();
    const secondHome = await createLocalHomeFixture();
    roots.push(firstHome, secondHome);
    const first = await collectProductionLiveArtifact(input(firstHome), ports([], [20, 1, 10]));
    const second = await collectProductionLiveArtifact(input(secondHome), ports([], [1, 20, 10]));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("fails the GitHub authority for a trusted PR number mismatch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T10:04:00.000Z"));
    const home = await createLocalHomeFixture();
    roots.push(home);
    const artifact = await collectProductionLiveArtifact(
      { ...input(home), pullRequestNumber: 43 },
      ports([]),
    );
    expect(artifact.authorities.github).toEqual({
      status: "missing",
      reasonCode: "binding_missing",
    });
  });

  it("marks duplicate Linear issues and PRs as red authority results", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T10:04:00.000Z"));
    const home = await createLocalHomeFixture();
    roots.push(home);
    const linear = fixtureLinear();
    const firstIssue = linear.issues.at(0);
    if (firstIssue === undefined) throw new Error("fixture_issue_missing");
    linear.issues.push({ ...firstIssue });
    const duplicateLinear = await collectProductionLiveArtifact(input(home), {
      ...ports([]),
      linear: { read: () => Promise.resolve({ state: "present", value: linear }) },
    });
    expect(duplicateLinear.authorities.linear).toEqual({
      status: "missing",
      reasonCode: "duplicate_result",
    });
    expect(replayLiveArtifact(duplicateLinear).overall).toBe("fail");
    const github = fixtureGithub();
    const firstPr = github.pullRequests.at(0);
    if (firstPr === undefined) throw new Error("fixture_pr_missing");
    github.pullRequests.push({ ...firstPr });
    const duplicatePr = await collectProductionLiveArtifact(input(home), {
      ...ports([]),
      github: { read: () => Promise.resolve({ state: "present", value: github }) },
    });
    expect(duplicatePr.authorities.github).toEqual({
      status: "missing",
      reasonCode: "duplicate_result",
    });
    expect(replayLiveArtifact(duplicatePr).overall).toBe("fail");
  });

  it("projects secret, path, and URL canaries out of artifact, bytes, and replay report", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T10:04:00.000Z"));
    const home = await createLocalHomeFixture();
    roots.push(home);
    const secret = "ghp_abcdefghijklmnopqrstuv";
    const path = "/tmp/private-worktree";
    const url = "https://token:secret@example.invalid/path";
    const linear = fixtureLinear();
    const issue = linear.issues.at(0);
    const event = issue?.timeline.at(0);
    if (issue === undefined || event === undefined) throw new Error("fixture_linear_missing");
    issue.title = secret;
    event.body = path;
    const github = fixtureGithub();
    const check = github.pullRequests.at(0)?.checks.at(0);
    if (check === undefined) throw new Error("fixture_check_missing");
    check.url = url;
    const rawAuthorities = JSON.stringify({ linear, github });
    expect(rawAuthorities).toContain(secret);
    expect(rawAuthorities).toContain(path);
    expect(rawAuthorities).toContain(url);
    const artifact = await collectProductionLiveArtifact(input(home), {
      ...ports([]),
      linear: { read: () => Promise.resolve({ state: "present", value: linear }) },
      github: { read: () => Promise.resolve({ state: "present", value: github }) },
    });
    const report = replayLiveArtifact(artifact);
    const bytes = Buffer.from(serializeLiveArtifact(artifact) ?? []).toString("utf8");
    for (const layer of [JSON.stringify(artifact), bytes, JSON.stringify(report)]) {
      expect(layer).not.toContain(secret);
      expect(layer).not.toContain(path);
      expect(layer).not.toContain(url);
    }
    expect(report.overall).toBe("pass");
  });
});
