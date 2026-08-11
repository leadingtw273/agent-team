/**
 * C015a unit tests: `buildDispatchComposition` (src/cli/dispatch/composition.ts) -- the
 * fail-closed prerequisite chain, mirroring how `probe-composition.ts` is tested: every missing-
 * config step returns `{state:"blocked", reason}` before any subsequent step runs (in particular,
 * before any real Linear network call), and only once every prerequisite is satisfied does it
 * reach `{state:"ready"}` with the correct discovery target derived from the project's
 * `workManagement.containerId`/`.projectId`.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildDispatchComposition } from "../../src/cli/dispatch/composition.js";
import {
  serializeTrustedProjectConfig,
  type TrustedProjectActivationPort,
  type TrustedProjectConfig,
  type TrustedProjectGitPort,
} from "../../src/application/projects/index.js";
import { ok } from "../../src/domain/foundation/index.js";
import { projectSchema, type Project } from "../../src/domain/project/index.js";
import { sha256Digest } from "../../src/domain/review/index.js";
import type { ModelRoutingConfig } from "../../src/application/routing/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-dispatch-composition-"));
  temporaryDirectories.push(directory);
  return directory;
}

const projectId = "project_018f47d2-77a4-7cc1-8ef2-0123456789ab";

function project(): Project {
  return projectSchema.parse({
    schemaVersion: 1,
    id: projectId,
    displayName: "Sandbox",
    localRepositoryPath: "/tmp/sandbox",
    defaultBranch: "main",
    workManagement: { provider: "linear", containerId: "team-1", projectId: "linear-proj-1" },
    sourceControl: { provider: "github", repository: "owner/sandbox" },
  });
}

function trustedConfig(value: Project): TrustedProjectConfig {
  return {
    schemaVersion: 1,
    projectId: value.id,
    defaultBranch: value.defaultBranch,
    platforms: { workManagement: value.workManagement, sourceControl: value.sourceControl },
    projectRules: [],
    roleInstructions: {},
    commands: { quality: [{ executable: "pnpm", arguments: ["test"] }], visualReview: [] },
  };
}

function digest(value: string) {
  const result = sha256Digest(value);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function gitWith(content: string): TrustedProjectGitPort {
  return {
    readTextFileAtRevision: (command) =>
      Promise.resolve(
        ok({
          revisionSha: "a".repeat(40),
          path: command.path,
          content,
          byteLength: Buffer.byteLength(content, "utf8"),
        }),
      ),
  };
}

function activationFor(value: TrustedProjectConfig): TrustedProjectActivationPort {
  const serialized = serializeTrustedProjectConfig(value);
  if (!serialized.ok) throw new Error(serialized.error.code);
  return {
    read: () =>
      Promise.resolve(
        ok({
          schemaVersion: 1 as const,
          source: "source_control_default_branch" as const,
          setupSessionId: "setup-session-1",
          projectId: value.projectId,
          repository: value.platforms.sourceControl.repository,
          changeRequestId: "PR_node_1",
          setupHeadSha: "b".repeat(40),
          mergeCommitSha: "c".repeat(40),
          authoritativeRevision: "c".repeat(40),
          defaultBranch: value.defaultBranch,
          configDigest: serialized.value.contentDigest,
          linearAuditIssueId: "LINEAR-AUDIT-1",
          gateEvidenceDigest: digest("gate"),
          auditReceiptsDigest: digest("audit"),
          approvalSource: "local_ui" as const,
          approvalReferenceDigest: digest("approval"),
          approvalConsumeOperationDigest: digest("consume-operation"),
          authorityDigest: digest("authority"),
          approvalNonceDigest: digest("nonce"),
        }),
      ),
  };
}

const validRoutingConfig: ModelRoutingConfig = {
  schemaVersion: 1,
  routes: [
    { role: "team_lead", candidates: [{ provider: "codex", model: "lead" }] },
    { role: "implementer", candidates: [{ provider: "codex", model: "build" }] },
    { role: "code_reviewer", candidates: [{ provider: "codex", model: "review" }] },
    { role: "visual_reviewer", candidates: [{ provider: "gemini", model: "visual" }] },
    { role: "integration_engineer", candidates: [{ provider: "claude", model: "integrate" }] },
  ],
};

async function writeDraft(agentTeamHome: string, value: Project): Promise<void> {
  const directory = join(agentTeamHome, "config", "registration");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${value.id}.draft.json`),
    JSON.stringify({
      schemaVersion: 1,
      project: value,
      config: trustedConfig(value),
      linearAuditIssueId: "LINEAR-AUDIT-1",
    }),
    "utf8",
  );
}

async function writeRoutingConfig(agentTeamHome: string, value: unknown): Promise<void> {
  const directory = join(agentTeamHome, "config", "dispatch");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "routing.json"), JSON.stringify(value), "utf8");
}

const validProviderConfig = {
  schemaVersion: 1,
  claude: { executable: "claude", models: ["opus"], account: "default" },
};

async function writeProviderConfig(agentTeamHome: string, value: unknown): Promise<void> {
  const directory = join(agentTeamHome, "config", "dispatch");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "providers.json"), JSON.stringify(value), "utf8");
}

describe("buildDispatchComposition", () => {
  it("blocks with draft_unavailable when no draft file exists", async () => {
    const agentTeamHome = await temporaryHome();
    const result = await buildDispatchComposition({ agentTeamHome, projectId });
    expect(result).toEqual({ state: "blocked", reason: "draft_unavailable" });
  });

  it("blocks with linear_api_key_missing before ever reading the routing config or activation", async () => {
    const agentTeamHome = await temporaryHome();
    await writeDraft(agentTeamHome, project());
    // Deliberately do not write routing.json either -- if the composition read past the missing
    // API key, this absence would surface as a *different* blocked reason, proving ordering.
    const result = await buildDispatchComposition({
      agentTeamHome,
      projectId,
      environment: {},
    });
    expect(result).toEqual({ state: "blocked", reason: "linear_api_key_missing" });
  });

  it("blocks with routing_config_unavailable when routing.json is missing or invalid", async () => {
    const agentTeamHome = await temporaryHome();
    await writeDraft(agentTeamHome, project());
    const result = await buildDispatchComposition({
      agentTeamHome,
      projectId,
      environment: { LINEAR_API_KEY: "test-key" },
    });
    expect(result).toEqual({ state: "blocked", reason: "routing_config_unavailable" });
  });

  it("blocks with routing_config_unavailable when routing.json fails schema validation", async () => {
    const agentTeamHome = await temporaryHome();
    await writeDraft(agentTeamHome, project());
    await writeRoutingConfig(agentTeamHome, { schemaVersion: 1, routes: [] });
    const result = await buildDispatchComposition({
      agentTeamHome,
      projectId,
      environment: { LINEAR_API_KEY: "test-key" },
    });
    expect(result).toEqual({ state: "blocked", reason: "routing_config_unavailable" });
  });

  it("blocks with provider_config_unavailable when providers.json is missing, before ever reading activation", async () => {
    const agentTeamHome = await temporaryHome();
    await writeDraft(agentTeamHome, project());
    await writeRoutingConfig(agentTeamHome, validRoutingConfig);
    const result = await buildDispatchComposition({
      agentTeamHome,
      projectId,
      environment: { LINEAR_API_KEY: "test-key" },
      activationPort: { read: () => Promise.reject(new Error("must never be called")) },
    });
    expect(result).toEqual({ state: "blocked", reason: "provider_config_unavailable" });
  });

  it("blocks with provider_config_unavailable when providers.json fails schema validation", async () => {
    const agentTeamHome = await temporaryHome();
    await writeDraft(agentTeamHome, project());
    await writeRoutingConfig(agentTeamHome, validRoutingConfig);
    await writeProviderConfig(agentTeamHome, {
      schemaVersion: 1,
      claude: { executable: "claude" },
    });
    const result = await buildDispatchComposition({
      agentTeamHome,
      projectId,
      environment: { LINEAR_API_KEY: "test-key" },
    });
    expect(result).toEqual({ state: "blocked", reason: "provider_config_unavailable" });
  });

  it("blocks with activation_missing when the project has never been activated", async () => {
    const agentTeamHome = await temporaryHome();
    await writeDraft(agentTeamHome, project());
    await writeRoutingConfig(agentTeamHome, validRoutingConfig);
    await writeProviderConfig(agentTeamHome, validProviderConfig);
    const config = trustedConfig(project());
    const result = await buildDispatchComposition({
      agentTeamHome,
      projectId,
      environment: { LINEAR_API_KEY: "test-key" },
      gitPort: gitWith(JSON.stringify(config)),
      activationPort: { read: () => Promise.resolve(ok(undefined)) },
    });
    expect(result).toEqual({ state: "blocked", reason: "activation_missing" });
  });

  it("blocks with trusted_config_missing when the repository has no .agent-team/project.json", async () => {
    const agentTeamHome = await temporaryHome();
    await writeDraft(agentTeamHome, project());
    await writeRoutingConfig(agentTeamHome, validRoutingConfig);
    await writeProviderConfig(agentTeamHome, validProviderConfig);
    const result = await buildDispatchComposition({
      agentTeamHome,
      projectId,
      environment: { LINEAR_API_KEY: "test-key" },
      gitPort: {
        readTextFileAtRevision: () =>
          Promise.resolve({ ok: false, error: { code: "not_found" } as never }),
      },
      activationPort: activationFor(trustedConfig(project())),
    });
    expect(result).toEqual({ state: "blocked", reason: "trusted_config_missing" });
  });

  it("reaches state:ready with the correct discovery teamId/linearProjectId once every prerequisite is satisfied", async () => {
    const agentTeamHome = await temporaryHome();
    await writeDraft(agentTeamHome, project());
    await writeRoutingConfig(agentTeamHome, validRoutingConfig);
    await writeProviderConfig(agentTeamHome, validProviderConfig);
    const config = trustedConfig(project());
    const result = await buildDispatchComposition({
      agentTeamHome,
      projectId,
      environment: { LINEAR_API_KEY: "test-key" },
      gitPort: gitWith(JSON.stringify(config)),
      activationPort: activationFor(config),
    });
    expect(result.state).toBe("ready");
    if (result.state !== "ready") return;
    expect(result.value.discovery.teamId).toBe("team-1");
    expect(result.value.discovery.linearProjectId).toBe("linear-proj-1");
    expect(result.value.routingConfig).toEqual(validRoutingConfig);
    expect(result.value.registry.ready).toHaveLength(1);
    expect(result.value.project.id).toBe(projectId);
    expect(result.value.trustedConfig).toEqual(config);
    expect(result.value.claude.config).toEqual(validProviderConfig.claude);
    await expect(result.value.quotaAdmission.resolve("claude")).resolves.toEqual({
      state: "quota_unknown",
      reason: "collector_unavailable",
    });
  });
});
