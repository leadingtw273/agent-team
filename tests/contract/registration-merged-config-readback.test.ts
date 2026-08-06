import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  GitHubRegistrationMergedConfigReadBackAdapter,
  maximumGitHubTrustedConfigBytes,
} from "../../src/adapters/registration/index.js";
import type { GhJsonTransport } from "../../src/adapters/github/adapter.js";
import type { ReadOptions } from "../../src/application/ports/index.js";
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

const setupHeadSha = "b".repeat(40);
const mergeSha = "c".repeat(40);
const defaultTipSha = "d".repeat(40);
const project = projectSchema.parse({
  schemaVersion: 1,
  id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  displayName: "Sandbox",
  localRepositoryPath: "/definitely/not/a/local/repository",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "workspace", projectId: "linear-project" },
  sourceControl: { provider: "github", repository: "owner/repository" },
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
const serializedResult = serializeTrustedProjectConfig(config);
if (!serializedResult.ok) throw new Error(serializedResult.error.code);
const serialized = serializedResult.value;

interface TransportStep {
  readonly value?: unknown;
  readonly error?: DomainError;
  readonly assert?: (arguments_: readonly string[]) => void;
}

class ScriptedTransport implements GhJsonTransport {
  readonly calls: readonly string[][] = [];
  readonly #steps: TransportStep[];

  constructor(steps: readonly TransportStep[]) {
    this.#steps = [...steps];
  }

  readonly requestJson = <Output>(
    arguments_: readonly string[],
    schema: z.ZodType<Output>,
  ): Promise<Result<Output, DomainError>> => {
    (this.calls as string[][]).push([...arguments_]);
    const step = this.#steps.shift();
    if (step === undefined) return Promise.resolve(err(domainError("external_failure")));
    step.assert?.(arguments_);
    if (step.error !== undefined) return Promise.resolve(err(step.error));
    const parsed = schema.safeParse(step.value);
    return Promise.resolve(parsed.success ? ok(parsed.data) : err(domainError("external_failure")));
  };
}

interface RawTransportStep {
  readonly response: unknown;
  readonly beforeReturn?: () => void;
}

class RawTransport implements GhJsonTransport {
  readonly calls: string[][] = [];
  readonly #steps: RawTransportStep[];

  constructor(steps: readonly RawTransportStep[]) {
    this.#steps = [...steps];
  }

  readonly requestJson = <Output>(
    arguments_: readonly string[],
  ): Promise<Result<Output, DomainError>> => {
    this.calls.push([...arguments_]);
    const step = this.#steps.shift();
    if (step === undefined) return Promise.resolve(err(domainError("external_failure")));
    step.beforeReturn?.();
    return Promise.resolve(step.response as Result<Output, DomainError>);
  };
}

type TransportHazard = "non_result" | "reject" | "sync_throw" | "throwing_then";

class HazardTransport implements GhJsonTransport {
  readonly calls: string[][] = [];
  readonly #hazard: TransportHazard;
  readonly #hazardIndex: number;
  readonly #steps = rawSuccessfulSteps();

  constructor(hazard: TransportHazard, hazardIndex: number) {
    this.#hazard = hazard;
    this.#hazardIndex = hazardIndex;
  }

  readonly requestJson = <Output>(
    arguments_: readonly string[],
  ): Promise<Result<Output, DomainError>> => {
    this.calls.push([...arguments_]);
    const index = this.calls.length - 1;
    if (index === this.#hazardIndex) {
      if (this.#hazard === "sync_throw") throw new Error("secret synchronous provider failure");
      if (this.#hazard === "reject") {
        return Promise.reject(new Error("secret rejected provider failure"));
      }
      if (this.#hazard === "throwing_then") {
        const thenable = Object.defineProperty(Object.create(null) as object, "then", {
          get: () => {
            throw new Error("secret throwing then getter");
          },
        });
        return thenable as unknown as Promise<Result<Output, DomainError>>;
      }
      return 42 as unknown as Promise<Result<Output, DomainError>>;
    }
    const step = this.#steps[index];
    if (step === undefined) return Promise.resolve(err(domainError("external_failure")));
    return Promise.resolve(step.response as Result<Output, DomainError>);
  };
}

function poisonSafeParse(schema: z.ZodType): void {
  const original = Object.getOwnPropertyDescriptor(schema, "safeParse");
  Object.defineProperty(schema, "safeParse", {
    configurable: true,
    value: () => {
      if (original === undefined) Reflect.deleteProperty(schema, "safeParse");
      else Object.defineProperty(schema, "safeParse", original);
      throw new Error("secret poisoned provider schema");
    },
  });
}

class SchemaPoisonTransport implements GhJsonTransport {
  readonly calls: string[][] = [];
  readonly #poisonIndex: number;
  readonly #steps = rawSuccessfulSteps();

  constructor(poisonIndex: number) {
    this.#poisonIndex = poisonIndex;
  }

  readonly requestJson = <Output>(
    arguments_: readonly string[],
    schema: z.ZodType<Output>,
  ): Promise<Result<Output, DomainError>> => {
    this.calls.push([...arguments_]);
    const index = this.calls.length - 1;
    if (index === this.#poisonIndex) poisonSafeParse(schema);
    const step = this.#steps[index];
    if (step === undefined) return Promise.resolve(err(domainError("external_failure")));
    return Promise.resolve(step.response as Result<Output, DomainError>);
  };
}

class ConcurrentIsolationTransport implements GhJsonTransport {
  readonly argumentsReferences: (readonly string[])[] = [];
  readonly optionsReferences: ReadOptions[] = [];
  readonly schemaReferences: z.ZodType[] = [];
  readonly argumentMutationResults: boolean[] = [];
  readonly optionsMutationResults: boolean[] = [];
  readonly #shared = {
    repository: repository(),
    pullRequest: pullRequest(),
    commit: { sha: defaultTipSha },
    compare: compare(),
    contents: contents(),
  };

  readonly requestJson = <Output>(
    arguments_: readonly string[],
    schema: z.ZodType<Output>,
    options: ReadOptions = {},
  ): Promise<Result<Output, DomainError>> => {
    this.argumentsReferences.push(arguments_);
    this.schemaReferences.push(schema);
    this.optionsReferences.push(options);
    this.argumentMutationResults.push(Reflect.set(arguments_, "0", "poison"));
    this.optionsMutationResults.push(Reflect.set(options, "signal", undefined));
    poisonSafeParse(schema);
    const route = arguments_[1] ?? "";
    const value =
      route === "graphql" || route.includes("/pulls/")
        ? this.#shared.pullRequest
        : route.includes("/compare/")
          ? this.#shared.compare
          : route.includes("/contents/")
            ? this.#shared.contents
            : route.includes("/commits/")
              ? this.#shared.commit
              : this.#shared.repository;
    return Promise.resolve(ok(value) as Result<Output, DomainError>);
  };

  poisonSharedProjections(): void {
    Reflect.set(this.#shared.repository, "defaultBranch", "develop");
    Reflect.set(this.#shared.pullRequest, "headSha", "e".repeat(40));
    Reflect.set(this.#shared.commit, "sha", "e".repeat(40));
    Reflect.set(this.#shared.compare, "status", "diverged");
    Reflect.set(this.#shared.contents, "content", "%%%%");
  }
}

function blobSha(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1")
    .update(`blob ${String(bytes.byteLength)}\0`, "utf8")
    .update(bytes)
    .digest("hex");
}

function repository(overrides: Readonly<Record<string, unknown>> = {}) {
  return { repository: project.sourceControl.repository, defaultBranch: "main", ...overrides };
}

function pullRequest(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: "PR_node_42",
    repository: project.sourceControl.repository,
    number: 42,
    state: "closed",
    merged: true,
    baseBranch: "main",
    headSha: setupHeadSha,
    mergeCommitSha: mergeSha,
    ...overrides,
  };
}

function compare(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    status: "ahead",
    aheadBy: 1,
    behindBy: 0,
    totalCommits: 1,
    baseCommitSha: mergeSha,
    mergeBaseSha: mergeSha,
    commits: [defaultTipSha],
    ...overrides,
  };
}

function contents(content = serialized.content, overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    type: "file",
    path: trustedProjectConfigPath,
    sha: blobSha(content),
    size: Buffer.byteLength(content, "utf8"),
    encoding: "base64",
    content: Buffer.from(content, "utf8").toString("base64"),
    target: null,
    submoduleGitUrl: null,
    ...overrides,
  };
}

function command(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    project,
    changeRequestId: "42",
    expectedHeadSha: setupHeadSha,
    defaultBranch: "main",
    path: trustedProjectConfigPath,
    ...overrides,
  };
}

function boxedString(value: string): object {
  return Reflect.construct(String, [value]);
}

function successfulSteps(
  overrides: {
    readonly repository?: unknown;
    readonly pullRequest?: unknown;
    readonly defaultTip?: unknown;
    readonly compare?: unknown;
    readonly contents?: unknown;
    readonly confirmedRepository?: unknown;
    readonly confirmedDefaultTip?: unknown;
  } = {},
): readonly TransportStep[] {
  return [
    { value: overrides.repository ?? repository() },
    { value: overrides.pullRequest ?? pullRequest() },
    { value: overrides.defaultTip ?? { sha: defaultTipSha } },
    { value: overrides.compare ?? compare() },
    { value: overrides.contents ?? contents() },
    { value: overrides.confirmedRepository ?? overrides.repository ?? repository() },
    { value: overrides.confirmedDefaultTip ?? overrides.defaultTip ?? { sha: defaultTipSha } },
  ];
}

function rawSuccessfulSteps(): {
  response: Result<unknown, DomainError>;
  beforeReturn?: () => void;
}[] {
  return successfulSteps().map((step) => ({ response: ok(structuredClone(step.value)) }));
}

function poisonProjection(index: number, value: unknown): void {
  if (typeof value !== "object" || value === null) throw new Error("expected projection object");
  const mutations = [
    ["defaultBranch", "develop"],
    ["headSha", "e".repeat(40)],
    ["sha", "e".repeat(40)],
    ["status", "diverged"],
    ["content", "%%%%"],
    ["defaultBranch", "develop"],
    ["sha", "e".repeat(40)],
  ] as const;
  const mutation = mutations[index];
  if (mutation === undefined || !Reflect.set(value, mutation[0], mutation[1])) {
    throw new Error("unable to poison projection");
  }
}

describe("GitHub API-only registration merged-config read-back", () => {
  it("binds REST repository, PR, exact tip, compare, and merge-SHA Contents into the receipt", async () => {
    const transport = new ScriptedTransport(
      successfulSteps().map((step, index) => ({
        ...step,
        assert: (arguments_: readonly string[]) => {
          if (index === 0) expect(arguments_[1]).toBe("repos/owner/repository");
          if (index === 1) expect(arguments_[1]).toBe("repos/owner/repository/pulls/42");
          if (index === 2) expect(arguments_[1]).toBe("repos/owner/repository/commits/main");
          if (index === 3) {
            expect(arguments_[1]).toBe(
              `repos/owner/repository/compare/${mergeSha}...${defaultTipSha}`,
            );
          }
          if (index === 4) {
            expect(arguments_[1]).toBe("repos/owner/repository/contents/.agent-team/project.json");
            expect(arguments_).toContain(`ref=${mergeSha}`);
            expect(arguments_).not.toContain(`ref=${defaultTipSha}`);
          }
          if (index === 5) expect(arguments_[1]).toBe("repos/owner/repository");
          if (index === 6) expect(arguments_[1]).toBe("repos/owner/repository/commits/main");
        },
      })),
    );

    const result = await new GitHubRegistrationMergedConfigReadBackAdapter(transport).read(
      command(),
    );

    expect(result).toEqual(
      ok({
        schemaVersion: 1,
        source: "source_control_default_branch",
        projectId: project.id,
        repository: project.sourceControl.repository,
        changeRequestId: "42",
        setupHeadSha,
        mergeCommitSha: mergeSha,
        defaultBranch: "main",
        authoritativeRevision: mergeSha,
        path: trustedProjectConfigPath,
        configDigest: serialized.contentDigest,
        config,
      }),
    );
    expect(transport.calls).toHaveLength(7);
    expect(maximumGitHubTrustedConfigBytes).toBe(256 * 1024);
  });

  it("uses a GraphQL variable for an opaque PR node ID without interpolating it into the query", async () => {
    const steps = successfulSteps({ pullRequest: pullRequest({ state: "merged" }) });
    const transport = new ScriptedTransport([
      steps[0] ?? {},
      {
        ...steps[1],
        assert: (arguments_) => {
          expect(arguments_).toContain("graphql");
          expect(arguments_).toContain("pullRequestId=PR_node_42");
          const query = arguments_.find((argument) => argument.startsWith("query="));
          expect(query).toContain("query($pullRequestId:ID!)");
          expect(query).not.toContain("PR_node_42");
        },
      },
      ...steps.slice(2),
    ]);

    const result = await new GitHubRegistrationMergedConfigReadBackAdapter(transport).read(
      command({ changeRequestId: "PR_node_42" }),
    );

    expect(result.ok && result.value.changeRequestId).toBe("PR_node_42");
  });

  it.each([
    ["wrong repository", { repository: repository({ repository: "owner/other" }) }],
    ["wrong default branch", { repository: repository({ defaultBranch: "develop" }) }],
    ["wrong PR repository", { pullRequest: pullRequest({ repository: "owner/other" }) }],
    ["wrong PR number", { pullRequest: pullRequest({ number: 43 }) }],
    ["wrong PR base", { pullRequest: pullRequest({ baseBranch: "develop" }) }],
    ["wrong setup head", { pullRequest: pullRequest({ headSha: "4".repeat(40) }) }],
    ["not merged", { pullRequest: pullRequest({ merged: false }) }],
    ["open", { pullRequest: pullRequest({ state: "open" }) }],
    ["missing merge SHA", { pullRequest: pullRequest({ mergeCommitSha: null }) }],
  ])("rejects %s before tip/compare/contents", async (_label, overrides) => {
    const transport = new ScriptedTransport(successfulSteps(overrides));
    const result = await new GitHubRegistrationMergedConfigReadBackAdapter(transport).read(
      command(),
    );

    expect(result.ok).toBe(false);
    expect(transport.calls.length).toBeLessThanOrEqual(2);
  });

  it.each([
    ["diverged", compare({ status: "diverged", aheadBy: 2, behindBy: 1 })],
    ["behind", compare({ status: "behind", aheadBy: 0, behindBy: 1, commits: [] })],
    ["merge-base mismatch", compare({ mergeBaseSha: "e".repeat(40) })],
    ["base mismatch", compare({ baseCommitSha: "e".repeat(40) })],
    ["commit omission", compare({ aheadBy: 2, totalCommits: 2, commits: [defaultTipSha] })],
    ["tip omission", compare({ commits: ["e".repeat(40)] })],
  ])("rejects compare %s before Contents", async (_label, compareValue) => {
    const transport = new ScriptedTransport(successfulSteps({ compare: compareValue }));
    const result = await new GitHubRegistrationMergedConfigReadBackAdapter(transport).read(
      command(),
    );

    expect(result.ok).toBe(false);
    expect(transport.calls).toHaveLength(4);
  });

  it("accepts the identical merge/default-tip relation only with an exact zero compare", async () => {
    const identical = {
      status: "identical",
      aheadBy: 0,
      behindBy: 0,
      totalCommits: 0,
      baseCommitSha: mergeSha,
      mergeBaseSha: mergeSha,
      commits: [],
    };
    const transport = new ScriptedTransport(
      successfulSteps({ defaultTip: { sha: mergeSha }, compare: identical }),
    );

    await expect(
      new GitHubRegistrationMergedConfigReadBackAdapter(transport).read(command()),
    ).resolves.toMatchObject({ ok: true, value: { authoritativeRevision: mergeSha } });
  });

  it.each(["not_found", "rate_limited", "unavailable"] as const)(
    "propagates a fail-closed %s transport result without a receipt",
    async (code) => {
      const steps = [...successfulSteps()];
      steps[4] = { error: domainError(code) };
      const result = await new GitHubRegistrationMergedConfigReadBackAdapter(
        new ScriptedTransport(steps),
      ).read(command());

      expect(result).toEqual(err(domainError(code)));
    },
  );

  it.each([
    { expectedHeadSha: "A".repeat(40) },
    { defaultBranch: "--upload-pack=evil" },
    { changeRequestId: "PR_node\n-f query=evil" },
    { project: { ...project, sourceControl: { provider: "github", repository: "../evil" } } },
  ])("rejects non-strict command identity before transport", async (overrides) => {
    const transport = new ScriptedTransport([]);
    const result = await new GitHubRegistrationMergedConfigReadBackAdapter(transport).read(
      command(overrides),
    );

    expect(result.ok).toBe(false);
    expect(transport.calls).toEqual([]);
  });

  it.each([
    ["boxed change request", command({ changeRequestId: boxedString("42") })],
    ["boxed expected head", command({ expectedHeadSha: boxedString(setupHeadSha) })],
    ["boxed default branch", command({ defaultBranch: boxedString("main") })],
    ["boxed config path", command({ path: boxedString(trustedProjectConfigPath) })],
    [
      "boxed provider",
      command({
        project: {
          ...project,
          sourceControl: { ...project.sourceControl, provider: boxedString("github") },
        },
      }),
    ],
    [
      "boxed repository",
      command({
        project: {
          ...project,
          sourceControl: {
            ...project.sourceControl,
            repository: boxedString("owner/repository"),
          },
        },
      }),
    ],
  ] as const)("rejects %s command input without invoking transport", async (_label, input) => {
    const transport = new ScriptedTransport([]);
    const result = await new GitHubRegistrationMergedConfigReadBackAdapter(transport).read(input);

    expect(result.ok).toBe(false);
    expect(transport.calls).toEqual([]);
  });

  it("rejects accessors and proxies without evaluating their code", async () => {
    let getterCount = 0;
    const accessor = Object.defineProperty(command(), "changeRequestId", {
      enumerable: true,
      get: () => {
        getterCount += 1;
        return "42";
      },
    });
    let proxyTrapCount = 0;
    const proxy = new Proxy(command(), {
      get: () => {
        proxyTrapCount += 1;
        throw new Error("proxy get trap must not run");
      },
      getOwnPropertyDescriptor: () => {
        proxyTrapCount += 1;
        throw new Error("proxy descriptor trap must not run");
      },
      getPrototypeOf: () => {
        proxyTrapCount += 1;
        throw new Error("proxy prototype trap must not run");
      },
      ownKeys: () => {
        proxyTrapCount += 1;
        throw new Error("proxy ownKeys trap must not run");
      },
    });
    const transport = new ScriptedTransport([]);
    const adapter = new GitHubRegistrationMergedConfigReadBackAdapter(transport);

    await expect(adapter.read(accessor)).resolves.toMatchObject({ ok: false });
    await expect(adapter.read(proxy)).resolves.toMatchObject({ ok: false });
    expect(getterCount).toBe(0);
    expect(proxyTrapCount).toBe(0);
    expect(transport.calls).toEqual([]);
  });

  it("snapshots an invalid command before reading a replaced transport getter", async () => {
    const commandValue = command({ changeRequestId: boxedString("42") });
    const transport = new ScriptedTransport([]);
    const adapter = new GitHubRegistrationMergedConfigReadBackAdapter(transport);
    let transportGetterCount = 0;
    Object.defineProperty(adapter, "transport", {
      configurable: true,
      enumerable: true,
      get: () => {
        transportGetterCount += 1;
        Reflect.set(commandValue, "changeRequestId", "42");
        return transport;
      },
    });

    await expect(adapter.read(commandValue)).resolves.toMatchObject({ ok: false });
    expect(transportGetterCount).toBe(0);
    expect(transport.calls).toEqual([]);
  });

  it("rejects proxied, accessor, inherited, and non-function requestJson transports", () => {
    let getterCount = 0;
    let proxyTrapCount = 0;
    const inherited = Object.create({
      requestJson: () => Promise.resolve(ok(repository())),
    }) as Record<string, unknown>;
    const accessor = Object.defineProperty({}, "requestJson", {
      enumerable: true,
      get: () => {
        getterCount += 1;
        return () => Promise.resolve(ok(repository()));
      },
    });
    const proxy = new Proxy(
      { requestJson: () => Promise.resolve(ok(repository())) },
      {
        getOwnPropertyDescriptor: () => {
          proxyTrapCount += 1;
          throw new Error("transport proxy descriptor trap must not run");
        },
      },
    );

    expect(
      () =>
        new GitHubRegistrationMergedConfigReadBackAdapter(inherited as unknown as GhJsonTransport),
    ).toThrow(TypeError);
    expect(
      () => new GitHubRegistrationMergedConfigReadBackAdapter(accessor as GhJsonTransport),
    ).toThrow(TypeError);
    expect(
      () => new GitHubRegistrationMergedConfigReadBackAdapter(proxy as unknown as GhJsonTransport),
    ).toThrow(TypeError);
    expect(
      () =>
        new GitHubRegistrationMergedConfigReadBackAdapter({
          requestJson: true,
        } as unknown as GhJsonTransport),
    ).toThrow(TypeError);
    expect(getterCount).toBe(0);
    expect(proxyTrapCount).toBe(0);
  });

  it.each([
    ["renamed default branch", { value: repository({ defaultBranch: "develop" }) }],
    ["malformed metadata", { value: { repository: project.sourceControl.repository } }],
    ["metadata error", { error: domainError("unavailable") }],
  ] as const)("returns no receipt for %s on the final metadata read", async (_label, finalStep) => {
    const transport = new ScriptedTransport([...successfulSteps().slice(0, 5), finalStep]);
    const result = await new GitHubRegistrationMergedConfigReadBackAdapter(transport).read(
      command(),
    );

    expect(result.ok).toBe(false);
    expect(transport.calls).toHaveLength(6);
  });

  it("uses an immutable entry snapshot after the caller mutates every command identifier", async () => {
    const mutable = command() as ReturnType<typeof command> & {
      changeRequestId: string;
      expectedHeadSha: string;
      defaultBranch: string;
      path: string;
      project: typeof project;
    };
    const steps = successfulSteps().map((step, index) => ({
      ...step,
      assert: () => {
        if (index !== 0) return;
        mutable.changeRequestId = "99";
        mutable.expectedHeadSha = "e".repeat(40);
        mutable.defaultBranch = "develop";
        mutable.path = ".agent-team/other.json";
        mutable.project = projectSchema.parse({
          ...project,
          id: "project_118f47d2-77a4-7cc1-8ef2-0123456789ab",
          defaultBranch: "develop",
          sourceControl: { provider: "github", repository: "attacker/other" },
        });
      },
    }));
    const transport = new ScriptedTransport(steps);

    const result = await new GitHubRegistrationMergedConfigReadBackAdapter(transport).read(mutable);

    expect(result).toEqual(
      ok({
        schemaVersion: 1,
        source: "source_control_default_branch",
        projectId: project.id,
        repository: project.sourceControl.repository,
        changeRequestId: "42",
        setupHeadSha,
        mergeCommitSha: mergeSha,
        defaultBranch: "main",
        authoritativeRevision: mergeSha,
        path: trustedProjectConfigPath,
        configDigest: serialized.contentDigest,
        config,
      }),
    );
    expect(transport.calls.at(-2)?.[1]).toBe("repos/owner/repository");
    expect(transport.calls.at(-1)?.[1]).toBe("repos/owner/repository/commits/main");
  });

  it.each([
    ["initial repository", 0],
    ["pull request", 1],
    ["initial tip", 2],
    ["compare", 3],
    ["contents", 4],
    ["confirmed repository", 5],
    ["confirmed tip", 6],
  ] as const)(
    "rejects an extra field in the %s response before another request",
    async (_label, index) => {
      const steps = rawSuccessfulSteps();
      const response = steps[index]?.response;
      if (response?.ok !== true || typeof response.value !== "object" || response.value === null) {
        throw new Error("expected raw success projection");
      }
      Reflect.set(response.value, "unexpected", true);
      const transport = new RawTransport(steps);

      await expect(
        new GitHubRegistrationMergedConfigReadBackAdapter(transport).read(command()),
      ).resolves.toMatchObject({ ok: false });
      expect(transport.calls).toHaveLength(index + 1);
    },
  );

  it.each([
    [
      "own enumerable __proto__",
      () =>
        Object.defineProperty(repository(), "__proto__", {
          configurable: true,
          enumerable: true,
          value: { polluted: true },
          writable: true,
        }),
    ],
    [
      "symbol key",
      () =>
        Object.defineProperty(repository(), Symbol("unexpected"), { enumerable: true, value: 1 }),
    ],
    [
      "non-enumerable key",
      () => Object.defineProperty(repository(), "hidden", { enumerable: false, value: 1 }),
    ],
    [
      "prototype inheritance",
      () => {
        const inherited = Object.create({ inherited: true }) as Record<string, unknown>;
        return Object.assign(inherited, repository());
      },
    ],
  ] as const)("rejects a first repository response with %s", async (_label, buildResponse) => {
    const steps = rawSuccessfulSteps();
    steps[0] = { response: ok(buildResponse()) };
    const transport = new RawTransport(steps);

    await expect(
      new GitHubRegistrationMergedConfigReadBackAdapter(transport).read(command()),
    ).resolves.toEqual(err(domainError("external_failure")));
    expect(transport.calls).toHaveLength(1);
  });

  it.each([0, 1, 2, 3, 4, 5] as const)(
    "keeps response %s immutable when the provider mutates it during the next await",
    async (index) => {
      const steps = rawSuccessfulSteps();
      const response = steps[index]?.response;
      if (response?.ok !== true) throw new Error("expected raw success projection");
      const next = steps[index + 1];
      if (next === undefined) throw new Error("expected next transport step");
      steps[index + 1] = {
        ...next,
        beforeReturn: () => {
          poisonProjection(index, response.value);
        },
      };

      const result = await new GitHubRegistrationMergedConfigReadBackAdapter(
        new RawTransport(steps),
      ).read(command());

      expect(result).toEqual(
        ok({
          schemaVersion: 1,
          source: "source_control_default_branch",
          projectId: project.id,
          repository: project.sourceControl.repository,
          changeRequestId: "42",
          setupHeadSha,
          mergeCommitSha: mergeSha,
          defaultBranch: "main",
          authoritativeRevision: mergeSha,
          path: trustedProjectConfigPath,
          configDigest: serialized.contentDigest,
          config,
        }),
      );
    },
  );

  it("rejects provider accessors, proxies, boxed primitives, and result-envelope extras", async () => {
    let getterCount = 0;
    const accessor = Object.defineProperty(repository(), "defaultBranch", {
      enumerable: true,
      get: () => {
        getterCount += 1;
        return "main";
      },
    });
    let proxyTrapCount = 0;
    const proxy = new Proxy(
      { sha: defaultTipSha },
      {
        get: () => {
          proxyTrapCount += 1;
          throw new Error("provider proxy trap must not run");
        },
        getOwnPropertyDescriptor: () => {
          proxyTrapCount += 1;
          throw new Error("provider proxy descriptor trap must not run");
        },
        getPrototypeOf: () => {
          proxyTrapCount += 1;
          throw new Error("provider proxy prototype trap must not run");
        },
        ownKeys: () => {
          proxyTrapCount += 1;
          throw new Error("provider proxy ownKeys trap must not run");
        },
      },
    );
    const cases = [
      [ok(accessor), 0],
      [ok({ ...repository(), defaultBranch: boxedString("main") }), 0],
      [ok(proxy), 2],
      [{ ok: true, value: repository(), unexpected: true }, 0],
    ] as const;

    for (const [response, responseIndex] of cases) {
      const steps = rawSuccessfulSteps();
      steps[responseIndex] = { response };
      const transport = new RawTransport(steps);
      await expect(
        new GitHubRegistrationMergedConfigReadBackAdapter(transport).read(command()),
      ).resolves.toMatchObject({ ok: false });
      expect(transport.calls).toHaveLength(responseIndex + 1);
    }
    expect(getterCount).toBe(0);
    expect(proxyTrapCount).toBe(0);
  });

  it.each(
    (["sync_throw", "throwing_then", "reject"] as const).flatMap((hazard) =>
      [0, 1, 2, 3, 4, 5, 6].map((index) => [hazard, index] as const),
    ),
  )("contains provider %s at request %i", async (hazard, index) => {
    const transport = new HazardTransport(hazard, index);

    const result = await new GitHubRegistrationMergedConfigReadBackAdapter(transport).read(
      command(),
    );

    expect(result).toEqual(err(domainError("external_failure")));
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(transport.calls).toHaveLength(index + 1);
  });

  it.each([0, 4] as const)("rejects a non-Result provider value at request %i", async (index) => {
    const transport = new HazardTransport("non_result", index);

    await expect(
      new GitHubRegistrationMergedConfigReadBackAdapter(transport).read(command()),
    ).resolves.toEqual(err(domainError("external_failure")));
    expect(transport.calls).toHaveLength(index + 1);
  });

  it.each([0, 1, 2, 3, 4, 5, 6] as const)(
    "keeps the private validator isolated from schema poison at request %i",
    async (index) => {
      const transport = new SchemaPoisonTransport(index);

      const result = await new GitHubRegistrationMergedConfigReadBackAdapter(transport).read(
        command(),
      );

      expect(result).toMatchObject({ ok: true, value: { authoritativeRevision: mergeSha } });
      expect(transport.calls).toHaveLength(7);
    },
  );

  it("isolates per-call inputs and shared projections across concurrent reads", async () => {
    const transport = new ConcurrentIsolationTransport();
    const adapter = new GitHubRegistrationMergedConfigReadBackAdapter(transport);

    const [first, second] = await Promise.all([adapter.read(command()), adapter.read(command())]);

    expect(first).toMatchObject({ ok: true, value: { authoritativeRevision: mergeSha } });
    expect(second).toMatchObject({ ok: true, value: { authoritativeRevision: mergeSha } });
    expect(transport.argumentsReferences).toHaveLength(14);
    expect(new Set(transport.argumentsReferences).size).toBe(14);
    expect(new Set(transport.optionsReferences).size).toBe(14);
    expect(new Set(transport.schemaReferences).size).toBe(14);
    expect(transport.argumentsReferences.every((value) => Object.isFrozen(value))).toBe(true);
    expect(transport.optionsReferences.every((value) => Object.isFrozen(value))).toBe(true);
    expect(transport.argumentMutationResults).toEqual(Array.from({ length: 14 }, () => false));
    expect(transport.optionsMutationResults).toEqual(Array.from({ length: 14 }, () => false));

    transport.poisonSharedProjections();
    expect(first).toMatchObject({
      ok: true,
      value: { repository: project.sourceControl.repository, setupHeadSha },
    });
    expect(second).toMatchObject({
      ok: true,
      value: { repository: project.sourceControl.repository, setupHeadSha },
    });
  });

  it("reconstructs a canonical DomainError without exposing the provider alias", async () => {
    const providerError = { ...domainError("rate_limited") };
    const steps = rawSuccessfulSteps();
    steps[3] = { response: { ok: false, error: providerError } };

    const result = await new GitHubRegistrationMergedConfigReadBackAdapter(
      new RawTransport(steps),
    ).read(command());

    expect(result).toEqual(err(domainError("rate_limited")));
    if (result.ok) throw new Error("expected canonical error");
    expect(result.error).not.toBe(providerError);
  });
});
