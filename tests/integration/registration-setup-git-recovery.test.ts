import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { GitPreflight, LocalGitAdapter } from "../../src/adapters/git/index.js";
import {
  FileRegistrationSetupExecutionStore,
  FileRegistrationSetupJournalStore,
  FileRegistrationSetupSessionStore,
  LocalRegistrationSetupFileAdapter,
} from "../../src/adapters/registration/index.js";
import {
  createRegistrationSetupPreview,
  RegistrationSetupCoordinator,
  type RegistrationSetupBeginRequest,
  type RegistrationSetupJournalPort,
  type RegistrationSetupPorts,
} from "../../src/application/registration/index.js";
import {
  serializeTrustedProjectConfig,
  trustedProjectConfigSchema,
} from "../../src/application/projects/index.js";
import { domainError, err, ok, parseInstant } from "../../src/domain/foundation/index.js";
import { projectSchema } from "../../src/domain/project/index.js";

const run = promisify(execFile);
const roots: string[] = [];

async function git(cwd: string, arguments_: readonly string[]): Promise<string> {
  const result = await run("git", [...arguments_], { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class CrashAfterGitEffectJournal implements RegistrationSetupJournalPort {
  #crash = true;

  constructor(
    readonly durable: FileRegistrationSetupJournalStore,
    readonly step: "stage" | "commit",
  ) {}

  load(...parameters: Parameters<RegistrationSetupJournalPort["load"]>) {
    return this.durable.load(...parameters);
  }

  async save(
    ...parameters: Parameters<RegistrationSetupJournalPort["save"]>
  ): ReturnType<RegistrationSetupJournalPort["save"]> {
    const [expectedRevision, draft, options] = parameters;
    const current = await this.durable.load(draft.setupSessionId);
    if (
      this.#crash &&
      current.ok &&
      current.value?.pending?.step === this.step &&
      draft.pending === undefined
    ) {
      this.#crash = false;
      return err(domainError("external_failure"));
    }
    return this.durable.save(expectedRevision, draft, options);
  }
}

interface RecoveryFixture {
  readonly root: string;
  readonly repository: string;
  readonly worktreePath: string;
  readonly baseSha: string;
  readonly request: RegistrationSetupBeginRequest;
  readonly journal: CrashAfterGitEffectJournal;
  readonly coordinator: RegistrationSetupCoordinator;
  readonly mutationCounts: { stage: number; commit: number };
}

async function fixture(crashStep: "stage" | "commit"): Promise<RecoveryFixture> {
  const root = await mkdtemp(join(tmpdir(), "agent-team-setup-git-recovery-"));
  roots.push(root);
  const repository = join(root, "repository");
  const remote = join(root, "remote.git");
  const worktreePath = join(root, "worktrees", "setup");
  const stateRoot = join(root, "state");
  await mkdir(repository, { recursive: true });
  await mkdir(join(root, "worktrees"), { recursive: true });
  await mkdir(stateRoot, { mode: 0o700 });
  await git(repository, ["init", "-b", "main"]);
  await git(repository, ["config", "user.email", "agent-team@example.invalid"]);
  await git(repository, ["config", "user.name", "Agent Team Recovery Fixture"]);
  await writeFile(join(repository, "README.md"), "fixture\n", "utf8");
  await git(repository, ["add", "README.md"]);
  await git(repository, ["commit", "-m", "initial"]);
  await git(root, ["init", "--bare", "--initial-branch=main", remote]);
  await git(repository, ["remote", "add", "origin", remote]);
  await git(repository, ["push", "-u", "origin", "main"]);
  const baseSha = await git(repository, ["rev-parse", "HEAD"]);
  const project = projectSchema.parse({
    schemaVersion: 1,
    id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    displayName: "Registration Git recovery",
    localRepositoryPath: repository,
    defaultBranch: "main",
    workManagement: { provider: "linear", containerId: "workspace", projectId: "team" },
    sourceControl: { provider: "github", repository: "owner/repository" },
  });
  const config = trustedProjectConfigSchema.parse({
    schemaVersion: 1,
    projectId: project.id,
    defaultBranch: "main",
    platforms: {
      workManagement: project.workManagement,
      sourceControl: project.sourceControl,
    },
    projectRules: ["Keep registration exact."],
    roleInstructions: { implementer: ["Stay in scope."] },
    commands: { quality: [{ executable: "pnpm", arguments: ["test"] }], visualReview: [] },
  });
  const preview = createRegistrationSetupPreview({
    schemaVersion: 1,
    setupSessionId: `setup-git-${crashStep}`,
    project,
    config,
    baseRevision: baseSha,
    worktreePath,
    branch: "agent-team/setup",
    remote: "origin",
  });
  if (!preview.ok) throw new Error(preview.error.code);
  const serialized = serializeTrustedProjectConfig(config);
  if (!serialized.ok) throw new Error(serialized.error.code);
  const updatedAt = parseInstant("2026-08-06T00:00:00.000Z");
  if (!updatedAt.ok) throw new Error(updatedAt.error.code);

  const localGit = new LocalGitAdapter();
  const mutationCounts = { stage: 0, commit: 0 };
  const durableJournal = new FileRegistrationSetupJournalStore(stateRoot);
  const journal = new CrashAfterGitEffectJournal(durableJournal, crashStep);
  const gitPorts: RegistrationSetupPorts["git"] = {
    createWorktree: localGit.createWorktree.bind(localGit),
    inspectWorkingTree: localGit.inspectWorkingTree.bind(localGit),
    getEffectiveTreeDiff: localGit.getEffectiveTreeDiff.bind(localGit),
    getStagedTreeDiff: localGit.getStagedTreeDiff.bind(localGit),
    inspectCommit: localGit.inspectCommit.bind(localGit),
    push: localGit.push.bind(localGit),
    stagePaths: async (...parameters) => {
      mutationCounts.stage += 1;
      return localGit.stagePaths(...parameters);
    },
    commit: async (...parameters) => {
      mutationCounts.commit += 1;
      return localGit.commit(...parameters);
    },
  };
  const ports: RegistrationSetupPorts = {
    git: gitPorts,
    preflight: new GitPreflight(localGit),
    previewConfirmation: { verify: () => Promise.resolve(ok({ state: "verified" as const })) },
    setupFiles: new LocalRegistrationSetupFileAdapter(),
    journal,
    execution: new FileRegistrationSetupExecutionStore(stateRoot),
    sessions: new FileRegistrationSetupSessionStore(stateRoot),
    sourceControl: {
      createDraftChangeRequest: async () => {
        const headSha = await git(worktreePath, ["rev-parse", "HEAD"]);
        return ok({
          id: "PR_setup_git_recovery",
          number: 42,
          url: "https://github.test/owner/repository/pull/42",
          state: "open" as const,
          draft: true,
          baseBranch: "main",
          headBranch: "agent-team/setup",
          headSha,
          mergeability: "mergeable" as const,
          autoMergeEnabled: false,
          updatedAt: updatedAt.value,
        });
      },
      getChangeRequest: () => Promise.resolve(err(domainError("unavailable"))),
      getCommitChecks: () => Promise.resolve(err(domainError("unavailable"))),
      getCommitStatuses: () => Promise.resolve(err(domainError("unavailable"))),
      markChangeRequestReady: () => Promise.resolve(err(domainError("unavailable"))),
      enableAutoMerge: () => Promise.resolve(err(domainError("unavailable"))),
    },
    finalApproval: {
      issue: () => Promise.resolve(ok({ state: "rejected" as const })),
      verifyAndConsume: () => Promise.resolve(ok({ state: "rejected" as const })),
    },
    mergedConfig: { read: () => Promise.resolve(err(domainError("unavailable"))) },
  };
  const request: RegistrationSetupBeginRequest = {
    preview: preview.value,
    confirmation: {
      source: "local_ui",
      explicit: true,
      tokenId: "confirmation-1",
      setupSessionId: preview.value.setupSessionId,
      projectId: project.id,
      previewDigest: preview.value.previewDigest,
    },
    idempotencyKeyPrefix: `integration:${crashStep}`,
  };
  return {
    root,
    repository,
    worktreePath,
    baseSha,
    request,
    journal,
    coordinator: new RegistrationSetupCoordinator(ports),
    mutationCounts,
  };
}

async function pendingJournal(test: RecoveryFixture) {
  const loaded = await test.journal.load(test.request.preview.setupSessionId);
  if (!loaded.ok || loaded.value === undefined) throw new Error("journal unavailable");
  return loaded.value;
}

describe("registration setup recovery with real linked Git worktrees", () => {
  it("recovers a git-add-to-receipt crash without staging or committing twice", async () => {
    const test = await fixture("stage");

    await expect(test.coordinator.begin(test.request)).resolves.toMatchObject({
      state: "failed",
      stage: "session",
    });
    expect((await pendingJournal(test)).pending).toMatchObject({ step: "stage" });
    expect(await git(test.worktreePath, ["diff", "--cached", "--name-only"])).toBe(
      ".agent-team/project.json",
    );
    expect(await git(test.worktreePath, ["rev-parse", "HEAD"])).toBe(test.baseSha);

    await expect(test.coordinator.begin(test.request)).resolves.toMatchObject({
      state: "ci_waiting",
    });
    expect(test.mutationCounts).toEqual({ stage: 1, commit: 1 });
    expect(await git(test.worktreePath, ["rev-list", "--count", `${test.baseSha}..HEAD`])).toBe(
      "1",
    );
  });

  it("recovers a git-commit-to-receipt crash only for the operation-bound commit", async () => {
    const test = await fixture("commit");

    await expect(test.coordinator.begin(test.request)).resolves.toMatchObject({
      state: "failed",
      stage: "session",
    });
    expect((await pendingJournal(test)).pending).toMatchObject({ step: "commit" });
    expect(await git(test.worktreePath, ["rev-list", "--count", `${test.baseSha}..HEAD`])).toBe(
      "1",
    );

    await expect(test.coordinator.begin(test.request)).resolves.toMatchObject({
      state: "ci_waiting",
    });
    expect(test.mutationCounts).toEqual({ stage: 1, commit: 1 });
    expect(await git(test.worktreePath, ["rev-list", "--count", `${test.baseSha}..HEAD`])).toBe(
      "1",
    );
  });

  it("fails closed when a foreign staged path appears during stage recovery", async () => {
    const test = await fixture("stage");
    await test.coordinator.begin(test.request);
    await writeFile(join(test.worktreePath, "foreign.txt"), "foreign\n", "utf8");
    await git(test.worktreePath, ["add", "foreign.txt"]);

    await expect(test.coordinator.begin(test.request)).resolves.toMatchObject({
      state: "failed",
      stage: "stage",
    });
    expect(test.mutationCounts).toEqual({ stage: 1, commit: 0 });
    expect((await pendingJournal(test)).pending).toMatchObject({ step: "stage" });
  });

  it("fails closed for an external commit with the right tree but the wrong operation message", async () => {
    const test = await fixture("commit");
    await test.coordinator.begin(test.request);
    await git(test.worktreePath, ["commit", "--amend", "--no-gpg-sign", "-m", "foreign commit"]);

    await expect(test.coordinator.begin(test.request)).resolves.toMatchObject({
      state: "failed",
      stage: "commit",
    });
    expect(test.mutationCounts).toEqual({ stage: 1, commit: 1 });
    expect((await pendingJournal(test)).pending).toMatchObject({ step: "commit" });
  });
});
