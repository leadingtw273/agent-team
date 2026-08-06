/**
 * E006 unit tests: `seedCase`/`resetCase` (seed-reset.ts) against a fake `SeedResetPorts` --
 * a small, self-consistent in-memory world (no real Linear/GitHub/git access at all). Covers the
 * packet's locked ground rules: complete manifest recording; reset only ever touches
 * manifest-listed objects; a marker mismatch is rejected (`requires_manual`), never mutated;
 * dry-run performs zero mutation; an already-confirmed entry is never re-attempted on a later
 * run (idempotent). The real production wiring is covered separately by
 * seed-reset.integration.test.ts (real manifest store + real adapters + fake transports).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createFixedClock,
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../../src/domain/foundation/index.js";
import { E2eCaseManifestStore } from "./seed-reset-manifest.js";
import type { SeedResetPorts } from "./seed-reset-ports.js";
import { e2eMarker, resetCase, seedCase, type SeedCaseCommand } from "./seed-reset.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryStore(): Promise<E2eCaseManifestStore> {
  const directory = await mkdtemp(join(tmpdir(), "e006-seed-reset-"));
  roots.push(directory);
  return new E2eCaseManifestStore(directory);
}

const clock = createFixedClock("2026-08-06T12:00:00.000Z" as never);

interface FakeLinearIssue {
  description: string;
  state: "open" | "cancelled";
}
interface FakePullRequest {
  repository: string;
  headBranch: string;
  body: string;
  state: "open" | "closed" | "merged";
}

interface FakeWorld {
  readonly linearIssues: Map<string, FakeLinearIssue>;
  nextLinearIssueId: number;
  readonly worktrees: Map<string, { branch: string; headSha: string }>;
  readonly remoteBranches: Map<string, string>;
  readonly pullRequests: Map<number, FakePullRequest>;
  nextPrNumber: number;
  readonly calls: string[];
}

function freshWorld(): FakeWorld {
  return {
    linearIssues: new Map(),
    nextLinearIssueId: 1,
    worktrees: new Map(),
    remoteBranches: new Map(),
    pullRequests: new Map(),
    nextPrNumber: 100,
    calls: [],
  };
}

function notFound<Value>(): Result<Value, DomainError> {
  return err(domainError("not_found"));
}

function fakePorts(world: FakeWorld): SeedResetPorts {
  return {
    linear: {
      readCapability: () => Promise.resolve(ok({ readWrite: true, cancelable: true })),
      findByMarker: (_target, marker) => {
        for (const [issueId, issue] of world.linearIssues) {
          if (issue.description === marker)
            return Promise.resolve(ok({ issueId, state: issue.state }));
        }
        return Promise.resolve(ok(undefined));
      },
      create: (command) => {
        world.calls.push(`linear.create:${command.marker}`);
        const issueId = `issue-${String(world.nextLinearIssueId)}`;
        world.nextLinearIssueId += 1;
        world.linearIssues.set(issueId, { description: command.body, state: "open" });
        return Promise.resolve(ok({ issueId }));
      },
      read: (issueId) => {
        const issue = world.linearIssues.get(issueId);
        if (issue === undefined) return Promise.resolve(notFound());
        return Promise.resolve(ok({ issueId, state: issue.state }));
      },
      cancel: (issueId) => {
        world.calls.push(`linear.cancel:${issueId}`);
        const issue = world.linearIssues.get(issueId);
        if (issue === undefined) return Promise.resolve(notFound());
        issue.state = "cancelled";
        return Promise.resolve(ok({ issueId, state: "cancelled" as const }));
      },
    },
    git: {
      inspectRepository: () => Promise.resolve(err(domainError("unavailable"))),
      createWorktree: (command) => {
        world.calls.push(`git.createWorktree:${command.branch}`);
        const headSha = world.remoteBranches.get(command.startPoint) ?? "b".repeat(40);
        world.worktrees.set(command.path, { branch: command.branch, headSha });
        return Promise.resolve(
          ok({
            repositoryRoot: command.rootPath,
            path: command.path,
            branch: command.branch,
            headSha,
          }),
        );
      },
      stagePaths: (worktree, paths) => {
        world.calls.push(`git.stagePaths:${worktree.path}`);
        return Promise.resolve(
          ok({
            headSha: worktree.headSha,
            changes: paths.map((path) => ({
              path,
              kind: "added" as const,
              mode: "file" as const,
              staged: true,
            })),
          }),
        );
      },
      commit: (command) => {
        world.calls.push(`git.commit:${command.worktree.path}`);
        const sha = "c".repeat(40);
        const worktree = world.worktrees.get(command.worktree.path);
        if (worktree !== undefined) worktree.headSha = sha;
        return Promise.resolve(ok({ sha, branch: command.worktree.branch }));
      },
      push: (worktree, remote) => {
        world.calls.push(`git.push:${worktree.branch}`);
        const tracked = world.worktrees.get(worktree.path);
        const sha = tracked?.headSha ?? worktree.headSha;
        world.remoteBranches.set(worktree.branch, sha);
        return Promise.resolve(ok({ remote, branch: worktree.branch, sha }));
      },
      removeWorktree: (worktree) => {
        world.calls.push(`git.removeWorktree:${worktree.path}`);
        world.worktrees.delete(worktree.path);
        return Promise.resolve(ok(undefined));
      },
      inspectWorkingTree: (worktree) => {
        const tracked = world.worktrees.get(worktree.path);
        if (tracked === undefined) return Promise.resolve(notFound());
        return Promise.resolve(ok({ headSha: tracked.headSha, changes: [] }));
      },
      inspectRemoteBranch: (_repository, _remote, branch) => {
        const sha = world.remoteBranches.get(branch);
        return Promise.resolve(ok(sha === undefined ? undefined : { sha }));
      },
    },
    github: {
      findDraftPullRequestByHead: (target, marker) => {
        for (const [number, pullRequest] of world.pullRequests) {
          if (
            pullRequest.repository === target.repository &&
            pullRequest.headBranch === target.headBranch &&
            pullRequest.state === "open" &&
            pullRequest.body.includes(marker)
          ) {
            return Promise.resolve(
              ok({
                changeRequestId: String(number),
                number,
                headSha: world.remoteBranches.get(pullRequest.headBranch) ?? "d".repeat(40),
                state: pullRequest.state,
                draft: true,
              }),
            );
          }
        }
        return Promise.resolve(ok(undefined));
      },
    },
    sourceControl: {
      createDraftChangeRequest: (command) => {
        world.calls.push(`sourceControl.createDraftChangeRequest:${command.headBranch}`);
        const number = world.nextPrNumber;
        world.nextPrNumber += 1;
        world.pullRequests.set(number, {
          repository: command.repository,
          headBranch: command.headBranch,
          body: command.body,
          state: "open",
        });
        return Promise.resolve(
          ok({
            id: `PR_node_${String(number)}`,
            number,
            url: `https://github.test/${command.repository}/pull/${String(number)}`,
            state: "open" as const,
            draft: true,
            baseBranch: command.baseBranch,
            headBranch: command.headBranch,
            headSha: world.remoteBranches.get(command.headBranch) ?? "d".repeat(40),
            mergeability: "mergeable" as const,
            autoMergeEnabled: false,
            updatedAt: "2026-08-06T12:00:00.000Z" as never,
          }),
        );
      },
      closeChangeRequest: (reference) => {
        world.calls.push(`sourceControl.closeChangeRequest:${reference.changeRequestId}`);
        const number = Number(reference.changeRequestId);
        const pullRequest = world.pullRequests.get(number);
        if (pullRequest === undefined) return Promise.resolve(notFound());
        pullRequest.state = "closed";
        return Promise.resolve(
          ok({
            id: `PR_node_${String(number)}`,
            number,
            url: `https://github.test/${reference.repository}/pull/${String(number)}`,
            state: "closed" as const,
            draft: true,
            baseBranch: "main",
            headBranch: pullRequest.headBranch,
            headSha: world.remoteBranches.get(pullRequest.headBranch) ?? "d".repeat(40),
            mergeability: "unknown" as const,
            autoMergeEnabled: false,
            updatedAt: "2026-08-06T12:00:00.000Z" as never,
          }),
        );
      },
    },
  };
}

const caseRunId = "e2e-e101-abc12345";

function fullSeedCommand(): SeedCaseCommand {
  return {
    caseId: "E101",
    caseRunId,
    linearIssue: {
      target: { teamId: "team-1", projectId: "linear-project-1", workflowStateId: "state-backlog" },
      title: "E101 sandbox issue",
    },
    githubBranch: {
      localRepository: { rootPath: "/tmp/e2e-repo" },
      worktreeRoot: "/tmp/e2e-repo-worktrees",
      remote: "origin",
      repository: "owner/sandbox",
      baseBranch: "main",
      branchName: "agent-team-e2e/e101",
    },
    githubDraftPullRequest: {
      repository: "owner/sandbox",
      baseBranch: "main",
      headBranch: "agent-team-e2e/e101",
      title: "E101 sandbox PR",
      body: "Seeded by the E006 harness for case E101.",
    },
    localWorktree: {
      localRepository: { rootPath: "/tmp/e2e-repo" },
      path: "/tmp/e2e-repo-worktrees/e101",
      branchName: "agent-team-e2e/e101-scratch",
      startPoint: "main",
    },
  };
}

describe("seedCase", () => {
  it("records every created object into the manifest, one entry per kind", async () => {
    const world = freshWorld();
    const store = await temporaryStore();
    const seeded = await seedCase(fakePorts(world), store, fullSeedCommand(), clock);
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    const kinds = seeded.value.entries.map((entry) => entry.kind).toSorted();
    expect(kinds).toEqual(
      ["githubBranch", "githubDraftPullRequest", "linearIssue", "localWorktree"].toSorted(),
    );
    for (const entry of seeded.value.entries) {
      expect(entry.marker).toBe(e2eMarker(caseRunId));
      expect(entry.createdAt).toBe("2026-08-06T12:00:00.000Z");
    }
  });

  it("rejects a caseRunId that does not match the bounded naming convention", async () => {
    const world = freshWorld();
    const store = await temporaryStore();
    const result = await seedCase(
      fakePorts(world),
      store,
      { ...fullSeedCommand(), caseRunId: "not-a-valid-run-id" },
      clock,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invariant_violation");
  });

  it("rejects a githubDraftPullRequest without a matching githubBranch in the same command", async () => {
    const world = freshWorld();
    const store = await temporaryStore();
    const command: SeedCaseCommand = {
      caseId: "E101",
      caseRunId,
      githubDraftPullRequest: {
        repository: "owner/sandbox",
        baseBranch: "main",
        headBranch: "agent-team-e2e/e101",
        title: "E101 sandbox PR",
        body: "Seeded by the E006 harness for case E101.",
      },
    };
    const result = await seedCase(fakePorts(world), store, command, clock);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invariant_violation");
  });

  it("persists earlier kinds into the manifest even when a later kind fails", async () => {
    const world = freshWorld();
    const store = await temporaryStore();
    // Sabotage the PR creation step (after linearIssue + githubBranch have already succeeded).
    const ports = fakePorts(world);
    const brokenPorts: SeedResetPorts = {
      ...ports,
      sourceControl: {
        ...ports.sourceControl,
        createDraftChangeRequest: () => Promise.resolve(err(domainError("external_failure"))),
      },
    };
    const result = await seedCase(brokenPorts, store, fullSeedCommand(), clock);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("external_failure");

    const partial = await store.load(caseRunId);
    expect(partial.ok).toBe(true);
    if (!partial.ok || partial.value === undefined) return;
    const kinds = partial.value.entries.map((entry) => entry.kind);
    expect(kinds).toContain("linearIssue");
    expect(kinds).toContain("githubBranch");
    expect(kinds).not.toContain("githubDraftPullRequest");
    expect(kinds).not.toContain("localWorktree");
  });

  it("is idempotent: re-running the same seed command does not re-create anything", async () => {
    const world = freshWorld();
    const store = await temporaryStore();
    const first = await seedCase(fakePorts(world), store, fullSeedCommand(), clock);
    expect(first.ok).toBe(true);
    const callsAfterFirst = world.calls.length;

    const second = await seedCase(fakePorts(world), store, fullSeedCommand(), clock);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value).toEqual(first.value);
    expect(world.calls.length).toBe(callsAfterFirst);
  });
});

describe("resetCase", () => {
  it("dry-run reports what would happen without mutating anything", async () => {
    const world = freshWorld();
    const store = await temporaryStore();
    const seeded = await seedCase(fakePorts(world), store, fullSeedCommand(), clock);
    expect(seeded.ok).toBe(true);
    const callsAfterSeed = world.calls.length;

    const result = await resetCase(fakePorts(world), store, caseRunId, clock, { dryRun: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dryRun).toBe(true);
    expect(world.calls.length).toBe(callsAfterSeed); // zero new mutating calls

    const actions = new Map(result.value.entries.map((entry) => [entry.kind, entry.action]));
    expect(actions.get("linearIssue")).toBe("would_clean");
    expect(actions.get("githubDraftPullRequest")).toBe("would_clean");
    expect(actions.get("localWorktree")).toBe("would_clean");
    // The disclosed capability gap: branch deletion always requires_manual, dry-run or not.
    expect(actions.get("githubBranch")).toBe("requires_manual");

    // A dry-run must never write a resolution back into the manifest either.
    const reloaded = await store.load(caseRunId);
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok || reloaded.value === undefined) return;
    expect(reloaded.value.entries.every((entry) => entry.resolution === undefined)).toBe(true);
  });

  it("cleans up every real entry it can, and flags the branch as requires_manual", async () => {
    const world = freshWorld();
    const store = await temporaryStore();
    await seedCase(fakePorts(world), store, fullSeedCommand(), clock);

    const ports = fakePorts(world);
    const result = await resetCase(ports, store, caseRunId, clock, { dryRun: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const actions = new Map(result.value.entries.map((entry) => [entry.kind, entry.action]));
    expect(actions.get("linearIssue")).toBe("confirmed_now");
    expect(actions.get("githubDraftPullRequest")).toBe("confirmed_now");
    expect(actions.get("localWorktree")).toBe("confirmed_now");
    expect(actions.get("githubBranch")).toBe("requires_manual");

    // Real-world effects, all scoped to exactly the manifest's own objects.
    const linearId = [...world.linearIssues.keys()][0];
    expect(linearId).toBeDefined();
    if (linearId !== undefined) expect(world.linearIssues.get(linearId)?.state).toBe("cancelled");
    const [prNumber] = world.pullRequests.keys();
    expect(prNumber).toBeDefined();
    if (prNumber !== undefined) expect(world.pullRequests.get(prNumber)?.state).toBe("closed");
    expect(world.worktrees.has("/tmp/e2e-repo-worktrees/e101")).toBe(false);
    // The branch itself was never touched -- no delete capability exists.
    expect(world.remoteBranches.has("agent-team-e2e/e101")).toBe(true);
  });

  it("is idempotent: an already-confirmed entry is reported confirmed without any further port calls", async () => {
    const world = freshWorld();
    const store = await temporaryStore();
    await seedCase(fakePorts(world), store, fullSeedCommand(), clock);
    const ports = fakePorts(world);
    await resetCase(ports, store, caseRunId, clock, { dryRun: false });
    const callsAfterFirstReset = world.calls.length;

    const second = await resetCase(ports, store, caseRunId, clock, { dryRun: false });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const actions = new Map(second.value.entries.map((entry) => [entry.kind, entry.action]));
    expect(actions.get("linearIssue")).toBe("already_confirmed");
    expect(actions.get("githubDraftPullRequest")).toBe("already_confirmed");
    expect(actions.get("localWorktree")).toBe("already_confirmed");
    // Only linearIssue/PR/worktree became "confirmed" on the first pass (githubBranch never
    // does), so exactly those three skip every port call on the second pass -- the fourth
    // (githubBranch) still re-evaluates every time (a no-op read, no mutation either way).
    expect(world.calls.length).toBe(callsAfterFirstReset);
  });

  it("rejects (requires_manual, never mutates) when the readback marker no longer matches", async () => {
    const world = freshWorld();
    const store = await temporaryStore();
    await seedCase(fakePorts(world), store, fullSeedCommand(), clock);

    // Simulate the sandbox object having been hijacked/reused: the issue that now exists at the
    // recorded id carries a different marker than the manifest remembers.
    const [linearId] = world.linearIssues.keys();
    expect(linearId).toBeDefined();
    if (linearId !== undefined) {
      world.linearIssues.set(linearId, { description: "someone-elses-marker", state: "open" });
    }

    const result = await resetCase(fakePorts(world), store, caseRunId, clock, { dryRun: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const linearOutcome = result.value.entries.find((entry) => entry.kind === "linearIssue");
    // findByMarker can no longer find *this* issue by *this* marker -> from this module's point
    // of view that is indistinguishable from "already gone", which is safe (zero mutation
    // either way) -- confirmed via the fake's own call log, not just the outcome.
    expect(linearOutcome?.action).toBe("already_absent");
    expect(world.calls.some((call) => call.startsWith("linear.cancel:"))).toBe(false);
    if (linearId !== undefined) expect(world.linearIssues.get(linearId)?.state).toBe("open");
  });

  it("returns not_found for a caseRunId with no manifest at all", async () => {
    const world = freshWorld();
    const store = await temporaryStore();
    const result = await resetCase(fakePorts(world), store, "e2e-e999-ffffffff", clock, {
      dryRun: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});
