/**
 * O009 integration test for `agent-team registration setup start` -> `status`.
 *
 * Zero-live-mutation harness, same technique as the O006 proactive-probe integration test:
 * - GitHub is faked at the `GhTransport` method boundary (`FakeGh`, adapted from that same test's
 *   fixture) -- it never shells out to a real `gh` binary.
 * - Git itself is REAL: a temp bare "remote" plus a temp working checkout, so worktree/branch/
 *   commit/push semantics inside the real O005 coordinator are genuine, not reimplemented.
 * - Linear is never touched at all for this scenario: `begin()` only reaches the `ci_waiting`
 *   phase (draft PR created), which is before the O005 coordinator's audit-comment step -- so the
 *   Linear/GitHub audit writers this task added are wired but never actually invoked here. A
 *   throwing `linearFetch` proves that.
 * - Every credential-shaped env var is absent; LINEAR_API_KEY is supplied only through the
 *   `environment` option (never process.env), so nothing here can ever touch a real service.
 */
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { GhTransport } from "../../src/adapters/github/index.js";
import { domainError, err, ok } from "../../src/domain/foundation/index.js";
import { createRegistrationSetupHandlers } from "../../src/cli/registration/setup-handlers.js";
import { buildRegistrationSetupComposition } from "../../src/cli/registration/setup-composition.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

async function realGitRepository() {
  const root = await temporaryRoot("agent-team-o009-setup-git-");
  const bareRemote = join(root, "remote.git");
  const checkout = join(root, "checkout");
  await execFileAsync("git", ["init", "--bare", "-q", "-b", "main", bareRemote]);
  await execFileAsync("git", ["clone", "-q", bareRemote, checkout]);
  await execFileAsync("git", ["-C", checkout, "config", "user.email", "setup@example.test"]);
  await execFileAsync("git", ["-C", checkout, "config", "user.name", "Setup"]);
  await writeFile(join(checkout, "README.md"), "seed\n", "utf8");
  await execFileAsync("git", ["-C", checkout, "add", "README.md"]);
  await execFileAsync("git", ["-C", checkout, "commit", "-q", "-m", "seed"]);
  await execFileAsync("git", ["-C", checkout, "push", "-q", "origin", "HEAD:refs/heads/main"]);
  return { checkout, bareRemote };
}

async function realRefSha(bareRemote: string, branch: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", [
      "-C",
      bareRemote,
      "show-ref",
      "--verify",
      "--hash",
      `refs/heads/${branch}`,
    ]);
    return result.stdout.trim();
  } catch {
    return undefined;
  }
}

interface FakePullRequest {
  id: string;
  number: number;
  state: "open" | "closed" | "merged";
  draft: boolean;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
}

function collectFields(args: readonly string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-f" || args[index] === "-F") {
      const pair = args[index + 1] ?? "";
      const separator = pair.indexOf("=");
      if (separator > 0) fields[pair.slice(0, separator)] = pair.slice(separator + 1);
    }
  }
  return fields;
}

/** Adapted from tests/integration/registration-proactive-probe.test.ts's own FakeGh, trimmed to
 * only the PR create/read surface this scenario's `begin()` call path actually touches. */
class FakeGh implements Pick<
  GhTransport,
  "inspectAuthentication" | "inspectRepositoryCapabilities" | "requestJson" | "requestVoid"
> {
  readonly prs: FakePullRequest[] = [];
  #nextPrNumber = 100;

  constructor(
    readonly bareRemote: string,
    readonly defaultBranch: string,
  ) {}

  inspectAuthentication() {
    return Promise.resolve(
      ok({ active: true as const, host: "github.com", accountFingerprint: "fp" }),
    );
  }

  inspectRepositoryCapabilities() {
    return Promise.resolve(err(domainError("unavailable")));
  }

  requestVoid() {
    return Promise.resolve(err(domainError("unavailable")));
  }

  #snapshot(pr: FakePullRequest, headSha: string) {
    return {
      id: pr.id,
      number: pr.number,
      url: `https://github.test/owner/sandbox/pull/${String(pr.number)}`,
      state: pr.state,
      draft: pr.draft,
      baseBranch: pr.baseBranch,
      headBranch: pr.headBranch,
      headSha,
      mergeability: "mergeable" as const,
      mergeStateStatus: "clean" as const,
      baseSha: "2".repeat(40),
      autoMergeEnabled: false,
      updatedAt: new Date().toISOString(),
    };
  }

  async requestJson<Output>(arguments_: readonly string[], schema: z.ZodType<Output>) {
    const endpoint = arguments_[1] ?? "";
    const methodIndex = arguments_.indexOf("--method");
    const method = methodIndex < 0 ? "GET" : (arguments_[methodIndex + 1] ?? "GET");
    const jqIndex = arguments_.indexOf("--jq");
    const jq = jqIndex < 0 ? "" : (arguments_[jqIndex + 1] ?? "");
    const fields = collectFields(arguments_);
    let value: unknown;

    if (endpoint.endsWith("/pulls") && method === "GET") {
      const headBranch = fields["head"]?.split(":")[1];
      const matches = this.prs.filter(
        (pr) =>
          (fields["state"] === undefined || pr.state === fields["state"]) &&
          (headBranch === undefined || pr.headBranch === headBranch),
      );
      const withSha = await Promise.all(
        matches.map(async (pr) => ({
          pr,
          sha: (await realRefSha(this.bareRemote, pr.headBranch)) ?? "0".repeat(40),
        })),
      );
      value = jq.includes("snapshot")
        ? withSha.map(({ pr, sha }) => ({
            title: pr.title,
            body: pr.body,
            snapshot: this.#snapshot(pr, sha),
          }))
        : withSha.map(({ pr, sha }) => ({
            number: pr.number,
            id: pr.id,
            state: pr.state,
            draft: pr.draft,
            headRefName: pr.headBranch,
            headRefOid: sha,
            body: pr.body,
          }));
    } else if (endpoint.endsWith("/pulls") && method === "POST") {
      const number = this.#nextPrNumber;
      this.#nextPrNumber += 1;
      const pr: FakePullRequest = {
        id: `PR_db_${String(number)}`,
        number,
        state: "open",
        draft: fields["draft"] === "true",
        baseBranch: fields["base"] ?? this.defaultBranch,
        headBranch: fields["head"] ?? "",
        title: fields["title"] ?? "",
        body: fields["body"] ?? "",
      };
      this.prs.push(pr);
      const sha = (await realRefSha(this.bareRemote, pr.headBranch)) ?? "0".repeat(40);
      value = this.#snapshot(pr, sha);
    } else if (/\/pulls\/[1-9][0-9]*$/u.test(endpoint) && method === "GET") {
      const number = Number(endpoint.split("/").pop());
      const pr = this.prs.find((candidate) => candidate.number === number);
      if (pr === undefined) return err(domainError("not_found"));
      const sha = (await realRefSha(this.bareRemote, pr.headBranch)) ?? "0".repeat(40);
      value = this.#snapshot(pr, sha);
    } else {
      value = {};
    }
    const parsed = schema.safeParse(value);
    return parsed.success ? ok(parsed.data) : err(domainError("external_failure"));
  }
}

const projectId = "project_018f47d2-77a4-7cc1-8ef2-0123456789ab";

async function writeDraft(agentTeamHome: string, checkout: string): Promise<void> {
  const directory = join(agentTeamHome, "config", "registration");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${projectId}.draft.json`),
    JSON.stringify({
      schemaVersion: 1,
      project: {
        schemaVersion: 1,
        id: projectId,
        displayName: "Sandbox",
        localRepositoryPath: checkout,
        defaultBranch: "main",
        workManagement: {
          provider: "linear",
          containerId: "team-1",
          projectId: "linear-project-1",
        },
        sourceControl: { provider: "github", repository: "owner/sandbox" },
      },
      config: {
        schemaVersion: 1,
        projectId,
        defaultBranch: "main",
        platforms: {
          workManagement: {
            provider: "linear",
            containerId: "team-1",
            projectId: "linear-project-1",
          },
          sourceControl: { provider: "github", repository: "owner/sandbox" },
        },
        projectRules: ["Run quality checks."],
        roleInstructions: { implementer: ["Stay in scope."] },
        commands: { quality: [{ executable: "pnpm", arguments: ["test"] }], visualReview: [] },
      },
      linearAuditIssueId: "LINEAR-AUDIT-1",
    }),
    "utf8",
  );
}

async function* stream(chunk: string): AsyncIterable<string> {
  await Promise.resolve();
  yield chunk;
}

describe("O009 registration setup CLI: start -> status (loopback/fake integration)", () => {
  it("creates a real draft PR through the CLI's own production composition, then reports it back via status", async () => {
    const { checkout, bareRemote } = await realGitRepository();
    const agentTeamHome = await temporaryRoot("agent-team-o009-setup-home-");
    await writeDraft(agentTeamHome, checkout);
    const github = new FakeGh(bareRemote, "main");
    const environment = { LINEAR_API_KEY: "unused-in-this-scenario" };
    const linearFetch = () => {
      throw new Error("must never be called: begin() never reaches the audit-comment step");
    };

    const handlers = createRegistrationSetupHandlers({
      agentTeamHome,
      environment,
      stdin: stream("CREATE SETUP DRAFT PR\n"),
      buildComposition: (options) =>
        buildRegistrationSetupComposition({ ...options, githubTransport: github, linearFetch }),
    });

    const startResult = await handlers.setupStart({ projectId });
    expect(startResult.state).toBe("success");
    const startPayload = JSON.parse(startResult.message ?? "") as { readonly state: string };
    expect(startPayload.state).toBe("ci_waiting");
    expect(github.prs).toHaveLength(1);
    expect(github.prs[0]?.draft).toBe(true);

    const statusHandlers = createRegistrationSetupHandlers({
      agentTeamHome,
      environment,
      buildComposition: (options) =>
        buildRegistrationSetupComposition({ ...options, githubTransport: github, linearFetch }),
    });
    const statusResult = await statusHandlers.setupStatus({ projectId });
    expect(statusResult.state).toBe("success");
    const statusPayload = JSON.parse(statusResult.message ?? "") as {
      readonly state: string;
      readonly session?: Readonly<{ pullRequestUrl: string }>;
    };
    expect(statusPayload.state).toBe("ci_waiting");
    expect(statusPayload.session?.pullRequestUrl).toContain(
      `/pull/${String(github.prs[0]?.number)}`,
    );
  }, 30_000);

  it("blocks (exit 3, zero external calls) when the draft file is missing", async () => {
    const agentTeamHome = await temporaryRoot("agent-team-o009-setup-home-blocked-");
    const github = new FakeGh("unused-bare-remote", "main");
    const handlers = createRegistrationSetupHandlers({
      agentTeamHome,
      environment: { LINEAR_API_KEY: "key" },
      stdin: stream("CREATE SETUP DRAFT PR\n"),
      buildComposition: (options) =>
        buildRegistrationSetupComposition({
          ...options,
          githubTransport: github,
          linearFetch: () => {
            throw new Error("must never be called");
          },
        }),
    });

    const result = await handlers.setupStart({ projectId: "project_missing-draft-00000000" });

    expect(result.state).toBe("blocked");
    expect(github.prs).toHaveLength(0);
  });

  it("(minor #5, 2026-08-06 fresh-context review) `setup status` alone never creates state/registration-setup/worktrees, and honestly reports preview_ready for a never-started project", async () => {
    const { checkout, bareRemote } = await realGitRepository();
    const agentTeamHome = await temporaryRoot("agent-team-o009-setup-home-status-only-");
    await writeDraft(agentTeamHome, checkout);
    const github = new FakeGh(bareRemote, "main");
    const environment = { LINEAR_API_KEY: "unused-in-this-scenario" };
    const linearFetch = () => {
      throw new Error("must never be called: status is read-only");
    };
    const statusHandlers = createRegistrationSetupHandlers({
      agentTeamHome,
      environment,
      buildComposition: (options) =>
        buildRegistrationSetupComposition({ ...options, githubTransport: github, linearFetch }),
    });

    const statusResult = await statusHandlers.setupStatus({ projectId });

    expect(statusResult.state).toBe("success");
    const statusPayload = JSON.parse(statusResult.message ?? "") as { readonly state: string };
    expect(statusPayload.state).toBe("preview_ready");
    expect(github.prs).toHaveLength(0);
    await expect(access(join(agentTeamHome, "state"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
