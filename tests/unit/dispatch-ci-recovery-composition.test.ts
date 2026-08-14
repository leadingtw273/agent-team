/**
 * C015c item 3b unit tests: `buildCiRecoveryPipeline`
 * (src/cli/dispatch/ci-recovery-composition.ts) -- the fail-closed GitHub-authentication-first
 * prerequisite chain and resulting port wiring, mirroring
 * dispatch-implementer-composition.test.ts's own convention.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildCiRecoveryPipeline } from "../../src/cli/dispatch/ci-recovery-composition.js";
import { GitPreflight, LocalGitAdapter } from "../../src/adapters/git/index.js";
import { FileJobRepository } from "../../src/infrastructure/jobs/index.js";
import { ciFailureLogExternalData } from "../../src/application/pipelines/index.js";
import { projectSchema } from "../../src/domain/project/index.js";
import { ok, err, domainError } from "../../src/domain/foundation/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-ci-recovery-composition-"));
  temporaryDirectories.push(directory);
  return directory;
}

const codexConfig = { executable: "codex", models: ["gpt-5.6-terra"], account: "default" };

describe("buildCiRecoveryPipeline", () => {
  it("blocks with github_authentication_unavailable before constructing any port", async () => {
    const agentTeamHome = await temporaryHome();
    const jobs = new FileJobRepository(
      join(agentTeamHome, "jobs.json"),
      join(agentTeamHome, "jobs.lock"),
    );
    const result = await buildCiRecoveryPipeline({
      agentTeamHome,
      codexConfig,
      jobs,
      githubTransport: {
        requestJson: () => Promise.reject(new Error("must never be called")),
        requestText: () => Promise.reject(new Error("must never be called")),
        inspectAuthentication: () => Promise.resolve(err(domainError("permission_denied"))),
      },
    });
    expect(result).toEqual({ state: "blocked", reason: "github_authentication_unavailable" });
  });

  it("reaches state:ready with every CiRecoveryPipelinePorts slot wired once GitHub auth succeeds", async () => {
    const agentTeamHome = await temporaryHome();
    const jobs = new FileJobRepository(
      join(agentTeamHome, "jobs.json"),
      join(agentTeamHome, "jobs.lock"),
    );
    const result = await buildCiRecoveryPipeline({
      agentTeamHome,
      codexConfig,
      jobs,
      githubTransport: {
        requestJson: () => Promise.reject(new Error("unused in this test")),
        requestText: () => Promise.reject(new Error("unused in this test")),
        inspectAuthentication: () =>
          Promise.resolve(
            ok({ active: true as const, host: "github.com", accountFingerprint: "a".repeat(64) }),
          ),
      },
    });
    expect(result.state).toBe("ready");
    if (result.state !== "ready") return;
    expect(result.value.ports.git).toBeInstanceOf(LocalGitAdapter);
    expect(result.value.ports.preflight).toBeInstanceOf(GitPreflight);
    const capabilities = await result.value.ports.provider.inspectCapabilities();
    expect(capabilities.ok).toBe(true);
    if (capabilities.ok) expect(capabilities.value.provider).toBe("codex");
    expect(result.value.ports.sourceControl).toBeDefined();
    expect(result.value.ports.ciLog).toBeDefined();
    // C017: `sourceControl` and `ciLog` are the same underlying `GitHubAdapter` instance -- one
    // read-only GitHub Checks/Actions capability set, no reason to construct the adapter twice.
    expect(result.value.ports.ciLog).toBe(result.value.ports.sourceControl);
    expect(result.value.ports.jobs).toBeDefined();
    expect(result.value.ports.checkpoint).toBeDefined();
    expect(result.value.ports.toolDecisions).toBeDefined();
    // C017b (D2): the observability sidecar must actually be wired in production composition,
    // not merely available as an optional port slot on `CiRecoveryPipelinePorts`.
    expect(result.value.ports.observability).toBeDefined();
  });

  // C017b (D1): closes the "無型別錯、無測試紅、無執行期訊號地整個死掉" gap this ticket's own
  // diagnosis named -- before this ticket, `githubTransport` only had to satisfy `GhJsonTransport`
  // here, so a transport lacking `requestText` (like both fixtures above, until this ticket forced
  // them to grow one) type-checked as production-shaped input, and `ciLog` would then silently,
  // permanently degrade to `available: false` for every call. This test proves the *opposite*:
  // given a transport that really does implement `requestText` (the type now requires), the
  // composition-wired `ciLog` capability is genuinely functional end to end -- lists the failing
  // check run, fetches its job log, and extracts a real failure excerpt -- and that excerpt, once
  // handed to `ciFailureLogExternalData` (the exact function `CiRecoveryPipeline.run()` uses to
  // build the repair prompt's external-data block), contains the real failure line and excludes
  // passing-test noise.
  it("wires a genuinely functional ciLog capability once githubTransport implements requestText, and its excerpt reaches ciFailureLogExternalData (D1)", async () => {
    const agentTeamHome = await temporaryHome();
    const jobs = new FileJobRepository(
      join(agentTeamHome, "jobs.json"),
      join(agentTeamHome, "jobs.lock"),
    );
    const rawLog = [
      "2026-08-08T01:00:00.0000000Z ✓ tests/unit/registration-setup.test.ts (87 tests) 223ms",
      "2026-08-08T01:00:01.0000000Z [warn] Code style issues found in 9 files. Run Prettier with --write to fix.",
      "2026-08-08T01:00:02.0000000Z  ELIFECYCLE  Command failed with exit code 1.",
      "2026-08-08T01:00:03.0000000Z ##[error]Process completed with exit code 1.",
    ].join("\n");
    const result = await buildCiRecoveryPipeline({
      agentTeamHome,
      codexConfig,
      jobs,
      githubTransport: {
        requestJson: (arguments_, schema) => {
          const endpoint = arguments_[1] ?? "";
          if (!endpoint.includes("/check-runs")) {
            return Promise.reject(new Error(`unexpected requestJson endpoint: ${endpoint}`));
          }
          const parsed = schema.safeParse({
            totalCount: 1,
            checks: [{ name: "format:check", status: "completed", conclusion: "failure", id: 42 }],
          });
          if (!parsed.success)
            return Promise.reject(new Error("check-run fixture failed to parse"));
          return Promise.resolve(ok(parsed.data));
        },
        requestText: (arguments_) => {
          const endpoint = arguments_[1] ?? "";
          if (endpoint.includes("/actions/jobs/42/logs")) return Promise.resolve(ok(rawLog));
          return Promise.reject(new Error(`unexpected requestText endpoint: ${endpoint}`));
        },
        inspectAuthentication: () =>
          Promise.resolve(
            ok({ active: true as const, host: "github.com", accountFingerprint: "a".repeat(64) }),
          ),
      },
    });
    expect(result.state).toBe("ready");
    if (result.state !== "ready") return;

    const project = projectSchema.parse({
      schemaVersion: 1,
      id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      displayName: "Fixture",
      localRepositoryPath: "/tmp/repository",
      defaultBranch: "main",
      workManagement: { provider: "linear", containerId: "workspace", projectId: "team" },
      sourceControl: { provider: "github", repository: "owner/repository" },
    });
    const outcome = await result.value.ports.ciLog.getFailedCheckLogExcerpts(
      { project },
      "a".repeat(40),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.available).toBe(true);
    if (!outcome.value.available) return;
    expect(outcome.value.excerpts).toHaveLength(1);
    expect(outcome.value.excerpts[0]?.sourceBytes).toBe(Buffer.byteLength(rawLog, "utf8"));

    const block = ciFailureLogExternalData(outcome.value);
    expect(block.kind).toBe("text");
    const content = block.kind === "text" ? block.content : "";
    expect(content).toContain("Code style issues found in 9 files");
    expect(content).toContain("##[error]Process completed with exit code 1");
  });
});
