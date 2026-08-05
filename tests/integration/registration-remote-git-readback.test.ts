import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  GitHubRegistrationMergedConfigReadBackAdapter,
  maximumGitHubTrustedConfigBytes,
} from "../../src/adapters/registration/index.js";
import type { GhJsonTransport } from "../../src/adapters/github/adapter.js";
import {
  serializeTrustedProjectConfig,
  trustedProjectConfigPath,
  trustedProjectConfigSchema,
} from "../../src/application/projects/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../src/domain/foundation/index.js";
import { projectSchema } from "../../src/domain/project/index.js";

function compileOnlyMissingTransport(): void {
  // @ts-expect-error Production construction requires an explicitly injected transport.
  new GitHubRegistrationMergedConfigReadBackAdapter();
}
void compileOnlyMissingTransport;

const setupHeadSha = "b".repeat(40);
const mergeSha = "c".repeat(40);
const observedDefaultTipSha = "d".repeat(40);
const laterDefaultTipSha = "e".repeat(40);
const project = projectSchema.parse({
  schemaVersion: 1,
  id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  displayName: "Sandbox",
  localRepositoryPath: "/path/that/does/not/exist/and/must/not/be-read",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "workspace", projectId: "linear-project" },
  sourceControl: { provider: "github", repository: "owner/repository" },
});

function trustedConfig(rule: string) {
  return trustedProjectConfigSchema.parse({
    schemaVersion: 1,
    projectId: project.id,
    defaultBranch: project.defaultBranch,
    platforms: { workManagement: project.workManagement, sourceControl: project.sourceControl },
    projectRules: [rule],
    roleInstructions: { implementer: ["Stay in scope."] },
    commands: { quality: [{ executable: "pnpm", arguments: ["test"] }], visualReview: [] },
  });
}

function serialized(rule = "authoritative merge content") {
  const value = serializeTrustedProjectConfig(trustedConfig(rule));
  if (!value.ok) throw new Error(value.error.code);
  return value.value;
}

function blobSha(content: string | Uint8Array): string {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  return createHash("sha1")
    .update(`blob ${String(bytes.byteLength)}\0`, "utf8")
    .update(bytes)
    .digest("hex");
}

function repository() {
  return { repository: project.sourceControl.repository, defaultBranch: "main" };
}

function pullRequest() {
  return {
    id: "PR_node_42",
    repository: project.sourceControl.repository,
    number: 42,
    state: "closed",
    merged: true,
    baseBranch: "main",
    headSha: setupHeadSha,
    mergeCommitSha: mergeSha,
  };
}

function compare() {
  return {
    status: "ahead",
    aheadBy: 1,
    behindBy: 0,
    totalCommits: 1,
    baseCommitSha: mergeSha,
    mergeBaseSha: mergeSha,
    commits: [observedDefaultTipSha],
  };
}

function contentsFromBytes(bytes: Uint8Array, overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    type: "file",
    path: trustedProjectConfigPath,
    sha: blobSha(bytes),
    size: bytes.byteLength,
    encoding: "base64",
    content: Buffer.from(bytes).toString("base64"),
    target: null,
    submoduleGitUrl: null,
    ...overrides,
  };
}

function contents(
  content = serialized().content,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return contentsFromBytes(Buffer.from(content, "utf8"), overrides);
}

interface Step {
  readonly value?: unknown;
  readonly error?: DomainError;
  readonly respond?: (arguments_: readonly string[]) => unknown;
  readonly assert?: (arguments_: readonly string[]) => void;
}

class FakeGitHubTransport implements GhJsonTransport {
  readonly calls: string[][] = [];
  readonly #steps: Step[];

  constructor(steps: readonly Step[]) {
    this.#steps = [...steps];
  }

  readonly requestJson = <Output>(
    arguments_: readonly string[],
    schema: z.ZodType<Output>,
  ): Promise<Result<Output, DomainError>> => {
    this.calls.push([...arguments_]);
    const step = this.#steps.shift();
    if (step === undefined) return Promise.resolve(err(domainError("external_failure")));
    step.assert?.(arguments_);
    if (step.error !== undefined) return Promise.resolve(err(step.error));
    const parsed = schema.safeParse(step.respond?.(arguments_) ?? step.value);
    return Promise.resolve(parsed.success ? ok(parsed.data) : err(domainError("external_failure")));
  };
}

function command() {
  return {
    project,
    changeRequestId: "42",
    expectedHeadSha: setupHeadSha,
    defaultBranch: "main",
    path: trustedProjectConfigPath,
  } as const;
}

function steps(contentsValue: unknown = contents()): readonly Step[] {
  return [
    { value: repository() },
    { value: pullRequest() },
    { value: { sha: observedDefaultTipSha } },
    { value: compare() },
    { value: contentsValue },
    { value: repository() },
    { value: { sha: observedDefaultTipSha } },
  ];
}

describe("registration GitHub API-only authoritative read-back", () => {
  it("has no production process, Git executable, local repository, remote URL, or TMPDIR path", async () => {
    const source = await readFile(
      new URL("../../src/adapters/registration/merged-config.ts", import.meta.url),
      "utf8",
    );
    for (const forbidden of [
      "node:child_process",
      "node:fs",
      "execFile",
      "mkdtemp",
      "TMPDIR",
      "LocalRegistrationRemoteGitReader",
      "GhTransport",
      'from "../github/transport.js"',
      "git fetch",
      "remote.origin.url",
    ]) {
      expect(source).not.toContain(forbidden);
    }

    const result = await new GitHubRegistrationMergedConfigReadBackAdapter(
      new FakeGitHubTransport(steps()),
    ).read(command());
    expect(result).toMatchObject({ ok: true, value: { authoritativeRevision: mergeSha } });
    expect(
      () => new (GitHubRegistrationMergedConfigReadBackAdapter as unknown as new () => unknown)(),
    ).toThrow(TypeError);
  });

  it("uses private runtime transport state when a public shadow field is added", async () => {
    const sequence = steps();
    const replacement = new FakeGitHubTransport(sequence);
    const reference: { adapter?: GitHubRegistrationMergedConfigReadBackAdapter } = {};
    const original = new FakeGitHubTransport([
      {
        ...sequence[0],
        assert: () => {
          if (reference.adapter === undefined) throw new Error("adapter missing");
          expect(Reflect.set(reference.adapter, "transport", replacement)).toBe(true);
        },
      },
      ...sequence.slice(1),
    ]);
    const adapter = new GitHubRegistrationMergedConfigReadBackAdapter(original);
    reference.adapter = adapter;

    const result = await adapter.read(command());

    expect(result).toMatchObject({ ok: true, value: { authoritativeRevision: mergeSha } });
    expect(original.calls).toHaveLength(7);
    expect(replacement.calls).toEqual([]);
  });

  it("fails closed when the default tip changes after compare and Contents read-back", async () => {
    const mergeContent = serialized("merge commit content");
    const defaultContent = serialized("later default branch content");
    const transport = new FakeGitHubTransport([
      { value: repository() },
      { value: pullRequest() },
      { value: { sha: observedDefaultTipSha } },
      {
        assert: (arguments_) => {
          expect(arguments_[1]).toContain(`${mergeSha}...${observedDefaultTipSha}`);
          expect(arguments_[1]).not.toContain(laterDefaultTipSha);
        },
        value: compare(),
      },
      {
        respond: (arguments_) =>
          arguments_.includes(`ref=${mergeSha}`)
            ? contents(mergeContent.content)
            : contents(defaultContent.content),
        assert: (arguments_) => {
          expect(arguments_).toContain(`ref=${mergeSha}`);
          expect(arguments_).not.toContain("ref=main");
          expect(arguments_).not.toContain(`ref=${observedDefaultTipSha}`);
        },
      },
      { value: repository() },
      { value: { sha: laterDefaultTipSha } },
    ]);

    const result = await new GitHubRegistrationMergedConfigReadBackAdapter(transport).read(
      command(),
    );

    expect(result.ok).toBe(false);
    expect(transport.calls).toHaveLength(7);
    expect(transport.calls[5]?.[1]).toBe("repos/owner/repository");
    expect(transport.calls[6]).toEqual([
      "api",
      "repos/owner/repository/commits/main",
      "--method",
      "GET",
      "--jq",
      "{sha:.sha}",
    ]);
  });

  it.each([
    ["malformed", { value: { sha: "A".repeat(40) } }],
    ["abbreviated", { value: { sha: "e".repeat(12) } }],
    ["transport error", { error: domainError("unavailable") }],
  ] as const)("returns no receipt for a %s second-tip read", async (_label, finalStep) => {
    const result = await new GitHubRegistrationMergedConfigReadBackAdapter(
      new FakeGitHubTransport([...steps().slice(0, 6), finalStep]),
    ).read(command());

    expect(result.ok).toBe(false);
  });

  it.each([
    ["default branch rename", { value: { ...repository(), defaultBranch: "develop" } }],
    ["malformed second metadata", { value: { repository: project.sourceControl.repository } }],
    ["second metadata error", { error: domainError("unavailable") }],
  ] as const)(
    "fails closed on %s while the original main tip is unchanged",
    async (_label, step) => {
      const transport = new FakeGitHubTransport([...steps().slice(0, 5), step]);
      const result = await new GitHubRegistrationMergedConfigReadBackAdapter(transport).read(
        command(),
      );

      expect(result.ok).toBe(false);
      expect(transport.calls).toHaveLength(6);
    },
  );

  it.each([
    ["invalid encoding", contents(undefined, { encoding: "none" })],
    ["size mismatch", contents(undefined, { size: Buffer.byteLength(serialized().content) + 1 })],
    ["invalid base64", contents(undefined, { content: "%%%%" })],
    ["wrong path", contents(undefined, { path: ".agent-team/other.json" })],
    ["directory", contents(undefined, { type: "dir" })],
    ["symlink", contents(undefined, { type: "symlink", target: "../../outside" })],
    ["submodule", contents(undefined, { submoduleGitUrl: "https://example.invalid/other.git" })],
    ["wrong blob SHA", contents(undefined, { sha: "f".repeat(40) })],
    ["oversized declaration", contents(undefined, { size: maximumGitHubTrustedConfigBytes + 1 })],
  ])("rejects Contents %s", async (_label, contentsValue) => {
    const transport = new FakeGitHubTransport(steps(contentsValue));
    const result = await new GitHubRegistrationMergedConfigReadBackAdapter(transport).read(
      command(),
    );

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("content");
  });

  it.each([
    [
      "LFS pointer",
      "version https://git-lfs.github.com/spec/v1\noid sha256:" + "1".repeat(64) + "\nsize 10\n",
    ],
    [
      "recognizable secret",
      serialized().content.replace(
        '"authoritative merge content"',
        '"ghp_abcdefghijklmnopqrstuvwxyz123456"',
      ),
    ],
    ["non-canonical JSON", `${serialized().content}\n`],
    ["schema drift", serialized().content.replace('"schemaVersion":1', '"schemaVersion":2')],
  ])("rejects decoded %s without returning bytes", async (_label, content) => {
    const result = await new GitHubRegistrationMergedConfigReadBackAdapter(
      new FakeGitHubTransport(steps(contents(content))),
    ).read(command());

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
  });

  it("rejects malformed UTF-8 even when base64, size, and blob SHA are internally consistent", async () => {
    const invalidUtf8 = Uint8Array.from([0xff, 0xfe, 0xfd]);
    const result = await new GitHubRegistrationMergedConfigReadBackAdapter(
      new FakeGitHubTransport(steps(contentsFromBytes(invalidUtf8))),
    ).read(command());

    expect(result.ok).toBe(false);
  });

  it.each([
    ["compare omission", { ...compare(), commits: undefined }],
    ["unknown compare", { ...compare(), status: "unknown" }],
    ["truncated compare commits", { ...compare(), aheadBy: 2, totalCommits: 2 }],
  ])("fails closed on %s", async (_label, compareValue) => {
    const customSteps = [...steps()];
    customSteps[3] = { value: compareValue };
    const result = await new GitHubRegistrationMergedConfigReadBackAdapter(
      new FakeGitHubTransport(customSteps),
    ).read(command());

    expect(result.ok).toBe(false);
    expect(customSteps).toHaveLength(7);
  });

  it.each(["not_found", "rate_limited", "unavailable", "external_failure"] as const)(
    "returns no receipt for Contents %s",
    async (code) => {
      const customSteps = [...steps()];
      customSteps[4] = { error: domainError(code) };
      const result = await new GitHubRegistrationMergedConfigReadBackAdapter(
        new FakeGitHubTransport(customSteps),
      ).read(command());

      expect(result).toEqual(err(domainError(code)));
    },
  );
});
