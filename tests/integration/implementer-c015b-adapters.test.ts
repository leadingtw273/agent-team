/**
 * C015b integration tests (task packet item 6's remaining required scenarios, beyond the
 * dispatch-to-ci_waiting happy path already covered by dispatch-run-end-to-end.test.ts):
 *
 * 1. Scope overrun -> the real `ScopeOverrunCheckpointAdapter` + real `LocalYamlCheckpointStore`
 *    (task packet: "真檔案 repos/checkpoint store") persist a genuine `Checkpoint` YAML file, the
 *    pipeline reports `paused/scope_overrun`, and -- the specific property that matters -- no
 *    push ever reaches the real bare remote.
 * 2. A dangerous-looking tool request -> the real `FailClosedToolDecisionAdapter` declines and
 *    pauses unconditionally, never returning `"approve"`, regardless of what R008's classifier
 *    thinks of the payload. Uses a well-behaved fake `ProviderRunHandle` whose
 *    `respondToToolRequest` succeeds (unlike the real `ClaudeRunner`, which the completion report
 *    discloses always fails that call) -- this test's job is to prove the *adapter's own decision*
 *    is correctly fail-closed, independent of that separately-disclosed provider-specific gap.
 *
 * Both use a real temporary Git repository + bare remote (same technique as
 * tests/integration/implementer-pipeline.test.ts) so "no push happened" can be verified against a
 * real remote ref, not just a fake's own bookkeeping.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { GitPreflight, LocalGitAdapter } from "../../src/adapters/git/index.js";
import { LocalYamlCheckpointStore } from "../../src/adapters/checkpoint/index.js";
import { ScopeOverrunCheckpointAdapter } from "../../src/cli/dispatch/scope-checkpoint.js";
import { FailClosedToolDecisionAdapter } from "../../src/cli/dispatch/tool-decision.js";
import {
  ImplementerPipeline,
  type ImplementerPipelinePorts,
} from "../../src/application/pipelines/index.js";
import { ok, parseInstant, type Instant } from "../../src/domain/foundation/index.js";
import { jobSchema, emptyAttemptCounters } from "../../src/domain/jobs/index.js";
import { issueSchema, projectSchema } from "../../src/domain/project/index.js";
import { createRequirementSnapshot } from "../../src/domain/review/index.js";
import { trustedProjectConfigSchema } from "../../src/application/projects/index.js";
import type { ProviderRunHandle } from "../../src/application/ports/index.js";

const run = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, arguments_: readonly string[]): Promise<string> {
  const result = await run("git", arguments_, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-c015b-adapters-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function instant(value: string): Instant {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const now = instant("2026-08-07T00:00:00.000Z");

async function setUpRepository(
  root: string,
): Promise<{ repository: string; remote: string; baseSha: string }> {
  const repository = join(root, "repository");
  const remote = join(root, "remote.git");
  await mkdir(repository, { recursive: true });
  await git(repository, ["init", "-b", "main"]);
  await git(repository, ["config", "user.email", "agent-team@example.invalid"]);
  await git(repository, ["config", "user.name", "Agent Team Fixture"]);
  await writeFile(join(repository, "README.md"), "fixture\n", "utf8");
  await git(repository, ["add", "README.md"]);
  await git(repository, ["commit", "-m", "initial"]);
  await git(root, ["init", "--bare", remote]);
  await git(repository, ["remote", "add", "origin", remote]);
  await git(repository, ["push", "-u", "origin", "main"]);
  const baseSha = await git(repository, ["rev-parse", "HEAD"]);
  return { repository, remote, baseSha };
}

function fixtureProject(repositoryPath: string) {
  return projectSchema.parse({
    schemaVersion: 1,
    id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    displayName: "Adapter fixture",
    localRepositoryPath: repositoryPath,
    defaultBranch: "main",
    workManagement: { provider: "linear", containerId: "workspace", projectId: "team" },
    sourceControl: { provider: "github", repository: "owner/repository" },
  });
}

function fixtureIssue(
  projectId: string,
  changeRegions: readonly { path: string; coverage: "exact" }[],
) {
  return issueSchema.parse({
    schemaVersion: 1,
    id: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    projectId,
    externalId: "ENG-ADAPTER",
    title: "Adapter fixture issue",
    goal: "Prove the C015b adapters fail closed.",
    background: "Task packet item 6.",
    acceptanceCriteria: ["No push on scope overrun.", "No auto-approve on tool_request."],
    inScope: ["src/feature"],
    outOfScope: ["Reviewer pipeline"],
    dependencies: { kind: "none" },
    priority: "high",
    agentRole: "implementer",
    reviewRequirement: "code_review",
    estimatedMinutes: 30,
    changeRegions,
  });
}

function fixtureConfig(project: ReturnType<typeof fixtureProject>) {
  return trustedProjectConfigSchema.parse({
    schemaVersion: 1,
    projectId: project.id,
    defaultBranch: "main",
    platforms: { workManagement: project.workManagement, sourceControl: project.sourceControl },
    projectRules: [],
    roleInstructions: {},
    commands: { quality: [{ executable: "pnpm", arguments: ["test"] }], visualReview: [] },
  });
}

function neverCalledSourceControl(): ImplementerPipelinePorts["sourceControl"] {
  return {
    createDraftChangeRequest: () =>
      Promise.reject(new Error("must never be called: no push should have happened")),
    getCommitChecks: () => Promise.reject(new Error("must never be called")),
  };
}

describe("C015b adapters wired into a real ImplementerPipeline + real Git repo", () => {
  it("scope overrun: persists a real Checkpoint via LocalYamlCheckpointStore, pauses, and never pushes", async () => {
    const root = await temporaryDirectory();
    const { repository, remote, baseSha } = await setUpRepository(root);
    const worktreePath = join(root, "worktrees", "overrun");
    await mkdir(join(root, "worktrees"), { recursive: true });
    const checkpointDirectory = join(root, "checkpoints");

    const project = fixtureProject(repository);
    // Declares only src/feature/index.ts in scope -- the provider below writes a DIFFERENT file.
    const issue = fixtureIssue(project.id, [{ path: "src/feature/index.ts", coverage: "exact" }]);
    const snapshot = createRequirementSnapshot(issue, now);
    if (!snapshot.ok) throw new Error(snapshot.error.code);
    const job = jobSchema.parse({
      schemaVersion: 1,
      id: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      projectId: project.id,
      issueId: issue.id,
      createdAt: now,
      watchdogExtensionGranted: false,
      attempts: emptyAttemptCounters(),
    });
    const config = fixtureConfig(project);
    const localGit = new LocalGitAdapter();
    const branch = "agent-team/scope-overrun";

    const providerHandle: ProviderRunHandle = {
      runId: "overrun-fixture-run",
      events: {
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
        },
      },
      completion: () => Promise.resolve(ok({ outcome: "completed" })),
      respondToToolRequest: () => Promise.reject(new Error("must never be called")),
      interrupt: () => Promise.reject(new Error("must never be called")),
    };
    const ports: ImplementerPipelinePorts = {
      git: localGit,
      preflight: new GitPreflight(localGit),
      provider: {
        inspectCapabilities: () => Promise.reject(new Error("must never be called")),
        start: async () => {
          // Out-of-scope write: the issue only declared src/feature/index.ts.
          await mkdir(join(worktreePath, "src", "unexpected"), { recursive: true });
          await writeFile(
            join(worktreePath, "src", "unexpected", "sneaky.ts"),
            "export const oops = true;\n",
            "utf8",
          );
          return ok(providerHandle);
        },
      },
      sourceControl: neverCalledSourceControl(),
      scopeCheckpoint: new ScopeOverrunCheckpointAdapter({
        store: new LocalYamlCheckpointStore(checkpointDirectory),
      }),
      toolDecisions: {
        decide: () => Promise.reject(new Error("must never be called: no tool_request here")),
      },
    };

    const outcome = await new ImplementerPipeline(ports).run({
      job,
      project,
      trustedConfig: config,
      requirementSnapshot: snapshot.value,
      role: "implementer",
      model: "fixture",
      repositoryRoot: repository,
      baseRevision: baseSha,
      worktreePath,
      branch,
      remote: "origin",
      commitMessage: "should never be committed",
      pullRequest: { title: "should never open", body: "should never open" },
      controllerDirective: "Write an unexpected out-of-scope file.",
      externalData: [],
      deadlineAt: instant("2026-08-07T00:30:00.000Z"),
      idempotencyKeyPrefix: "adapter-fixture:overrun",
    });

    if (outcome.state !== "paused") throw new Error(`expected paused: ${JSON.stringify(outcome)}`);
    expect(outcome.reason).toBe("scope_overrun");
    expect(outcome.checkpointId).toBeDefined();
    expect(outcome.findings).toEqual(
      expect.arrayContaining([{ code: "unexpected_untracked", path: "src/unexpected/sneaky.ts" }]),
    );

    // The real checkpoint file genuinely exists on disk and is schema-valid.
    const checkpointFiles = await readdir(checkpointDirectory);
    expect(checkpointFiles).toHaveLength(1);
    const checkpointFile = checkpointFiles[0];
    if (checkpointFile === undefined) throw new Error("no checkpoint file was written");
    const checkpointContent = await readFile(join(checkpointDirectory, checkpointFile), "utf8");
    expect(checkpointContent).toContain('reason: "human_handoff"');
    expect(checkpointContent).toContain("pushed: false");

    // The load-bearing assertion: no push ever reached the real remote. `main` is the only ref.
    const remoteRefs = await git(root, [
      "--git-dir",
      remote,
      "for-each-ref",
      "--format=%(refname)",
    ]);
    expect(remoteRefs.split("\n")).toEqual(["refs/heads/main"]);
  });

  it("dangerous-looking tool request: FailClosedToolDecisionAdapter declines and pauses, never approves", async () => {
    const root = await temporaryDirectory();
    const { repository, remote, baseSha } = await setUpRepository(root);
    const worktreePath = join(root, "worktrees", "danger");
    await mkdir(join(root, "worktrees"), { recursive: true });

    const project = fixtureProject(repository);
    const issue = fixtureIssue(project.id, [{ path: "src/feature/index.ts", coverage: "exact" }]);
    const snapshot = createRequirementSnapshot(issue, now);
    if (!snapshot.ok) throw new Error(snapshot.error.code);
    const job = jobSchema.parse({
      schemaVersion: 1,
      id: "job_018f47d2-77a4-7cc1-8ef2-1123456789ab",
      projectId: project.id,
      issueId: issue.id,
      createdAt: now,
      watchdogExtensionGranted: false,
      attempts: emptyAttemptCounters(),
    });
    const config = fixtureConfig(project);
    const localGit = new LocalGitAdapter();
    const branch = "agent-team/danger";

    let respondedWith: "approve" | "decline" | undefined;
    let interrupted = false;
    const providerHandle: ProviderRunHandle = {
      runId: "danger-fixture-run",
      events: {
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          yield {
            kind: "tool_request" as const,
            observedAt: now,
            requestId: "tool-req-1",
            tool: "Bash",
            payload: { command: "rm -rf /" },
          };
        },
      },
      completion: () => Promise.resolve(ok({ outcome: "interrupted" as const })),
      // Unlike the real ClaudeRunner (whose respondToToolRequest always fails -- a disclosed,
      // separate limitation), this fixture's handle succeeds, so this test genuinely isolates
      // "does the adapter's own decision ever say approve" from that other gap.
      respondToToolRequest: (_requestId, decision) => {
        respondedWith = decision;
        return Promise.resolve(ok(undefined));
      },
      interrupt: () => {
        interrupted = true;
        return Promise.resolve(ok(undefined));
      },
    };
    const ports: ImplementerPipelinePorts = {
      git: localGit,
      preflight: new GitPreflight(localGit),
      provider: {
        inspectCapabilities: () => Promise.reject(new Error("must never be called")),
        start: () => Promise.resolve(ok(providerHandle)),
      },
      sourceControl: neverCalledSourceControl(),
      scopeCheckpoint: {
        preserve: () => Promise.reject(new Error("must never be called: no scope overrun here")),
      },
      toolDecisions: new FailClosedToolDecisionAdapter(),
    };

    const outcome = await new ImplementerPipeline(ports).run({
      job,
      project,
      trustedConfig: config,
      requirementSnapshot: snapshot.value,
      role: "implementer",
      model: "fixture",
      repositoryRoot: repository,
      baseRevision: baseSha,
      worktreePath,
      branch,
      remote: "origin",
      commitMessage: "should never be committed",
      pullRequest: { title: "should never open", body: "should never open" },
      controllerDirective: "Attempt a dangerous operation.",
      externalData: [],
      deadlineAt: instant("2026-08-07T00:30:00.000Z"),
      idempotencyKeyPrefix: "adapter-fixture:danger",
    });

    if (outcome.state !== "paused") throw new Error(`expected paused: ${JSON.stringify(outcome)}`);
    expect(outcome.reason).toBe("safety_approval_required");
    expect(outcome.toolSummary).toContain("不自動核可");
    expect(respondedWith).toBe("decline");
    expect(interrupted).toBe(true);

    const remoteRefs = await git(root, [
      "--git-dir",
      remote,
      "for-each-ref",
      "--format=%(refname)",
    ]);
    expect(remoteRefs.split("\n")).toEqual(["refs/heads/main"]);
  });
});
