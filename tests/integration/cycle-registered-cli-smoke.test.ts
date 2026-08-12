import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileRegistrationSetupActivationRegistry,
  FileRegistrationSetupExecutionStore,
  FileRegistrationSetupFinalApprovalAuthority,
  FileRegistrationSetupSessionStore,
} from "../../src/adapters/registration/index.js";
import {
  serializeTrustedProjectConfig,
  trustedProjectConfigPath,
  trustedProjectConfigSchema,
} from "../../src/application/projects/index.js";
import {
  createRegistrationSetupPreview,
  registrationSetupBranchFor,
  type RegistrationSetupApprovalBinding,
  type RegistrationSetupExecutionLease,
  type RegistrationSetupSessionDraft,
} from "../../src/application/registration/index.js";
import { parseInstant } from "../../src/domain/foundation/index.js";
import { projectSchema } from "../../src/domain/project/index.js";
import { sha256Digest, type Sha256Digest } from "../../src/domain/review/index.js";

const cli = resolve("dist/cli/index.js");
const roots: string[] = [];
const projectId = "project_00000000-0000-4000-8000-0000000000c3";
const setupSessionId = "compiled-registered-project-c03";
const authorityDigest = "1".repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function isolatedEnvironment(): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), "agent-team-cycle-registered-smoke-"));
  roots.push(root);
  const { LINEAR_API_KEY: _linearApiKey, ...environment } = process.env;
  void _linearApiKey;
  return { ...environment, AGENT_TEAM_HOME: join(root, ".agent-team") };
}

function run(arguments_: readonly string[], environment: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [cli, ...arguments_], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 10_000,
    env: environment,
  });
}

function runGit(arguments_: readonly string[], cwd: string): string {
  const result = spawnSync("git", arguments_, { cwd, encoding: "utf8", timeout: 10_000 });
  if (result.error !== undefined || result.status !== 0)
    throw new Error("compiled_fixture_git_failed");
  return result.stdout.trim();
}

function instant(value: string) {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function digest(value: unknown) {
  const result = sha256Digest(value);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function operationDigest(idempotencyKey: string): Sha256Digest {
  return createHash("sha256").update(idempotencyKey, "utf8").digest("hex") as Sha256Digest;
}

async function withExecution<Value>(
  stateRoot: string,
  action: (lease: RegistrationSetupExecutionLease) => Promise<Value>,
): Promise<Value> {
  const result = await new FileRegistrationSetupExecutionStore(stateRoot).runExclusive(
    setupSessionId,
    action,
  );
  if (!result.ok || result.value.state !== "completed") {
    throw new Error("compiled_fixture_execution_failed");
  }
  return result.value.value;
}

async function createRegisteredProjectFixture(
  agentTeamHome: string,
  options: Readonly<{ includeRejectedDraft?: boolean }> = {},
): Promise<string> {
  const stateRoot = join(agentTeamHome, "state");
  const repository = join(agentTeamHome, "registered-project-repository");
  const project = projectSchema.parse({
    schemaVersion: 1,
    id: projectId,
    displayName: "Compiled registered fixture",
    localRepositoryPath: repository,
    defaultBranch: "main",
    workManagement: { provider: "linear", containerId: "workspace", projectId: "linear-project" },
    sourceControl: { provider: "github", repository: "fixture/compiled-c03" },
  });
  const config = trustedProjectConfigSchema.parse({
    schemaVersion: 1,
    projectId: project.id,
    defaultBranch: project.defaultBranch,
    platforms: { workManagement: project.workManagement, sourceControl: project.sourceControl },
    projectRules: ["Run quality checks."],
    roleInstructions: { implementer: ["Stay in scope."] },
    commands: { quality: [{ executable: "pnpm", arguments: ["test"] }], visualReview: [] },
  });
  const serialized = serializeTrustedProjectConfig(config);
  if (!serialized.ok) throw new Error(serialized.error.code);

  await mkdir(join(repository, ".agent-team"), { recursive: true, mode: 0o700 });
  await writeFile(join(repository, trustedProjectConfigPath), serialized.value.content, {
    mode: 0o600,
  });
  runGit(["init"], repository);
  runGit(["config", "user.email", "fixture@example.test"], repository);
  runGit(["config", "user.name", "C03 fixture"], repository);
  runGit(["add", trustedProjectConfigPath], repository);
  runGit(["commit", "-m", "trusted project config"], repository);
  runGit(["branch", "-M", "main"], repository);
  const revisionSha = runGit(["rev-parse", "HEAD"], repository);

  const preview = createRegistrationSetupPreview({
    schemaVersion: 1,
    setupSessionId,
    project,
    config,
    baseRevision: revisionSha,
    worktreePath: repository,
    branch: registrationSetupBranchFor(setupSessionId),
    remote: "origin",
    linearAuditIssueId: "LINEAR-C03-COMPILED",
  });
  if (!preview.ok) throw new Error(preview.error.code);

  const diffDigest = digest({ kind: "compiled_c03_registration_diff" });
  const gateBinding = {
    schemaVersion: 1 as const,
    source: "source_control" as const,
    projectId: project.id,
    repository: project.sourceControl.repository,
    changeRequestId: "42",
    headSha: revisionSha,
    requirementsDigest: preview.value.requirementsDigest,
    diffDigest,
    ciChecksDigest: diffDigest,
    reviewContext: "agent-team/review" as const,
    reviewEvidenceUrl: "https://fixture.invalid/c03-review",
  };
  const gateEvidenceReceipt = Object.freeze({
    ...gateBinding,
    evidenceDigest: digest({ kind: "registration_setup_gate_evidence", ...gateBinding }),
  });
  const binding: RegistrationSetupApprovalBinding = {
    schemaVersion: 1,
    setupSessionId,
    setupSessionRevision: 1,
    projectId: project.id,
    previewDigest: preview.value.previewDigest,
    changeRequestId: "42",
    headSha: revisionSha,
    requirementsDigest: preview.value.requirementsDigest,
    diffDigest,
    linearAuditIssueId: "LINEAR-C03-COMPILED",
    gateEvidenceDigest: gateEvidenceReceipt.evidenceDigest,
  };
  const localAuthority = Object.freeze({ issuer: "local_ui" as const, authorityDigest });
  const approvalAuthority = new FileRegistrationSetupFinalApprovalAuthority(stateRoot);
  const issueKey = "compiled-c03-registration-approval-issue";
  const issued = await approvalAuthority.issue(binding, localAuthority, {
    idempotencyKey: issueKey,
  });
  if (!issued.ok || issued.value.state !== "issued") {
    throw new Error("compiled_fixture_approval_issue_failed");
  }
  const consumeKey = "compiled-c03-registration-approval-consume";
  const consumed = await approvalAuthority.verifyAndConsume(
    {
      approvalId: issued.value.grant.approvalId,
      userConfirmed: true,
      expectedSetupRevision: 1,
    },
    binding,
    localAuthority,
    { idempotencyKey: consumeKey },
  );
  if (!consumed.ok || consumed.value.state !== "verified_and_consumed") {
    throw new Error("compiled_fixture_approval_consume_failed");
  }
  const approvalReceipt = consumed.value.receipt;

  const updatedAt = instant("2026-08-12T00:00:00.000Z");
  const auditReceipt = (destination: "linear" | "pull_request") => {
    const body = [
      "Agent Team registration Setup PR is waiting for explicit user approval.",
      `project=${project.id}`,
      `setup_session=${setupSessionId}`,
      `preview_digest=${preview.value.previewDigest}`,
      "change_request=PR_node_compiled_c03",
      `head_sha=${revisionSha}`,
      `requirements_digest=${preview.value.requirementsDigest}`,
      `diff_digest=${diffDigest}`,
      "linear_audit_issue=LINEAR-C03-COMPILED",
      `gate_evidence_digest=${gateEvidenceReceipt.evidenceDigest}`,
      `review_evidence=${gateEvidenceReceipt.reviewEvidenceUrl}`,
      "merge=squash",
      "authority=local UI or trusted current-user conversation only",
    ].join("\n");
    const idempotencyKey = `setup-audit:${setupSessionId}:${gateEvidenceReceipt.evidenceDigest.slice(
      0,
      16,
    )}:${destination}`;
    return Object.freeze({
      schemaVersion: 1 as const,
      destination,
      setupSessionId,
      projectId: project.id,
      repository: project.sourceControl.repository,
      linearAuditIssueId: "LINEAR-C03-COMPILED",
      changeRequestId: "42",
      headSha: revisionSha,
      requirementsDigest: preview.value.requirementsDigest,
      diffDigest,
      evidenceDigest: gateEvidenceReceipt.evidenceDigest,
      bodyDigest: digest(body),
      externalCommentId: `${destination}-comment-c03`,
      idempotencyKeyDigest: digest(idempotencyKey),
      createdAt: updatedAt,
      reused: false,
    });
  };
  const approvalReferenceDigest = digest({
    schemaVersion: 1,
    kind: "registration_setup_approval_reference",
    approvalId: approvalReceipt.approvalId,
  });
  const mergeIdempotencyKey = `setup-merge:${setupSessionId}:${approvalReferenceDigest.slice(0, 16)}`;
  const mergeIntentBinding = {
    schemaVersion: 1 as const,
    projectId: project.id,
    repository: project.sourceControl.repository,
    changeRequestId: "42",
    expectedHeadSha: revisionSha,
    mergeMethod: "SQUASH" as const,
    idempotencyKey: mergeIdempotencyKey,
  };
  const mergeIntent = Object.freeze({
    ...mergeIntentBinding,
    mergeIntentDigest: digest({ kind: "registration_setup_merge_intent", ...mergeIntentBinding }),
  });
  const { idempotencyKey: _mergeKey, ...mergeReceiptBinding } = mergeIntent;
  void _mergeKey;
  const mergeReceipt = Object.freeze({
    ...mergeReceiptBinding,
    state: "merged" as const,
    idempotencyKeyDigest: digest(mergeIdempotencyKey),
  });
  const evidence = [
    "setup_user_approval_consumed",
    "setup_merge_verified",
    "trusted_config_activated",
  ] as const;
  const sessionDraft = (phase: "ci_waiting" | "activated"): RegistrationSetupSessionDraft => ({
    schemaVersion: 1,
    phase,
    setupSessionId,
    project,
    config,
    baseRevision: revisionSha,
    worktree: {
      repositoryRoot: repository,
      path: repository,
      branch: registrationSetupBranchFor(setupSessionId),
      headSha: revisionSha,
    },
    remote: "origin",
    previewDigest: preview.value.previewDigest,
    requirementsDigest: preview.value.requirementsDigest,
    diffDigest,
    configDigest: serialized.value.contentDigest,
    headSha: revisionSha,
    changeRequest: {
      id: "PR_node_compiled_c03",
      number: 42,
      url: "https://github.test/fixture/compiled-c03/pull/42",
      state: phase === "activated" ? "merged" : "open",
      draft: phase !== "activated",
      baseBranch: "main",
      headBranch: registrationSetupBranchFor(setupSessionId),
      headSha: revisionSha,
      mergeability: "mergeable",
      autoMergeEnabled: phase === "activated",
      updatedAt,
    },
    linearAuditIssueId: "LINEAR-C03-COMPILED",
    ...(phase === "activated"
      ? {
          gateEvidenceReceipt,
          audit: {
            linearReceipt: auditReceipt("linear"),
            pullRequestReceipt: auditReceipt("pull_request"),
          },
          evidence: evidence.map((code) => ({
            code,
            projectId: project.id,
            setupSessionId,
            previewDigest: preview.value.previewDigest,
            requirementsDigest: preview.value.requirementsDigest,
            headSha: revisionSha,
            diffDigest,
            changeRequestId: "42",
          })),
          approvalReferenceDigest,
          approvalConsumeOperationDigest: operationDigest(consumeKey),
          approvalNonceDigest: approvalReceipt.approvalNonceDigest,
          approvalAuthorityDigest: approvalReceipt.authorityDigest,
          approvalSource: approvalReceipt.issuer,
          approvalSetupRevision: approvalReceipt.setupSessionRevision,
          mergeIntent,
          mergeReceipt,
          mergedConfigReceipt: {
            schemaVersion: 1 as const,
            source: "source_control_default_branch" as const,
            projectId: project.id,
            repository: project.sourceControl.repository,
            changeRequestId: "42",
            setupHeadSha: revisionSha,
            mergeCommitSha: revisionSha,
            defaultBranch: project.defaultBranch,
            authoritativeRevision: revisionSha,
            path: trustedProjectConfigPath,
            configDigest: serialized.value.contentDigest,
            config,
          },
          activatedRevisionSha: revisionSha,
        }
      : { evidence: [] }),
  });
  const sessions = new FileRegistrationSetupSessionStore(stateRoot);
  const initial = await withExecution(stateRoot, (lease) =>
    sessions.save(undefined, sessionDraft("ci_waiting"), {
      idempotencyKey: "compiled-c03-registration-session-save",
      executionFence: lease.fence,
    }),
  );
  if (!initial.ok || initial.value.durability !== "confirmed") {
    throw new Error("compiled_fixture_initial_session_failed");
  }
  const activated = await withExecution(stateRoot, (lease) =>
    sessions.activate(initial.value.session.revision, sessionDraft("activated"), revisionSha, {
      idempotencyKey: "compiled-c03-registration-session-activate",
      executionFence: lease.fence,
    }),
  );
  if (!activated.ok || activated.value.durability !== "confirmed") {
    throw new Error("compiled_fixture_activation_failed");
  }
  const published = await new FileRegistrationSetupActivationRegistry(stateRoot).publish(
    activated.value.marker,
    { idempotencyKey: "compiled-c03-registration-publish" },
  );
  if (!published.ok || published.value.state !== "confirmed") {
    throw new Error("compiled_fixture_publish_failed");
  }

  const draftDirectory = join(agentTeamHome, "config", "registration");
  await mkdir(draftDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(draftDirectory, `${project.id}.draft.json`),
    `${JSON.stringify({ schemaVersion: 1, project, config, linearAuditIssueId: "LINEAR-C03-COMPILED" })}\n`,
    { mode: 0o600 },
  );
  if (options.includeRejectedDraft === true) {
    await writeFile(join(draftDirectory, "rejected-draft.draft.json"), '{"schemaVersion":1}\n', {
      mode: 0o600,
    });
  }
  return project.id;
}

describe("C03 compiled registered-project cycle smoke", () => {
  it("discovers a durably registered project and sends it once through the existing fail-closed run gate", async () => {
    const environment = await isolatedEnvironment();
    const agentTeamHome = environment["AGENT_TEAM_HOME"];
    if (agentTeamHome === undefined) throw new Error("missing isolated home");
    const fixtureProjectId = await createRegisteredProjectFixture(agentTeamHome);

    const first = run(["cycle", "--all"], environment);
    const replay = run(["cycle", "--all"], environment);

    const expected = {
      operation: "controller_cycle",
      state: "degraded",
      stageCounts: { completed: 2, degraded: 2, failed: 0 },
      stageOutcomes: [
        { stage: "webhook_health", state: "degraded" },
        {
          stage: "inbox",
          state: "completed",
          counts: { discovered: 0, processed: 0, alreadyCompleted: 0, failed: 0 },
          failures: [],
        },
        { stage: "reconcile", state: "completed" },
        {
          stage: "projects",
          state: "degraded",
          counts: { registered: 1, attempted: 1, completed: 0, degraded: 1, failed: 0 },
          projects: [{ projectId: fixtureProjectId, state: "degraded", reasonCode: "run_blocked" }],
        },
      ],
    };
    for (const result of [first, replay]) {
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(3);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toEqual(expected);
      expect(result.stderr).not.toContain("fixture/compiled-c03");
      expect(result.stderr).not.toContain("registered-project-repository");
      expect(result.stderr).not.toContain("https://");
    }
    expect(existsSync(join(agentTeamHome, "state", "jobs.json"))).toBe(false);
    expect(existsSync(join(agentTeamHome, "state", "leases.json"))).toBe(false);
  });

  it("fails closed before the run gate when a rejected draft accompanies a trusted registered project", async () => {
    const environment = await isolatedEnvironment();
    const agentTeamHome = environment["AGENT_TEAM_HOME"];
    if (agentTeamHome === undefined) throw new Error("missing isolated home");
    await createRegisteredProjectFixture(agentTeamHome, { includeRejectedDraft: true });

    const result = run(["cycle", "--all"], environment);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      operation: "controller_cycle",
      state: "failed",
      reasonCode: "stage_failed",
      stageCounts: { completed: 2, degraded: 1, failed: 1 },
      stageOutcomes: [
        { stage: "webhook_health", state: "degraded" },
        {
          stage: "inbox",
          state: "completed",
          counts: { discovered: 0, processed: 0, alreadyCompleted: 0, failed: 0 },
          failures: [],
        },
        { stage: "reconcile", state: "completed" },
        {
          stage: "projects",
          state: "failed",
          counts: { registered: 0, attempted: 0, completed: 0, degraded: 0, failed: 0 },
          projects: [],
          reasonCode: "inventory_invalid",
        },
      ],
    });
    expect(result.stderr).not.toContain("rejected-draft");
    expect(result.stderr).not.toContain("fixture/compiled-c03");
    expect(result.stderr).not.toContain("registered-project-repository");
    expect(result.stderr).not.toContain("https://");
    expect(existsSync(join(agentTeamHome, "state", "jobs.json"))).toBe(false);
    expect(existsSync(join(agentTeamHome, "state", "leases.json"))).toBe(false);
  });
});
