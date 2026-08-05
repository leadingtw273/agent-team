import { z } from "zod";

import type {
  RegistrationContinuousIntegrationReadOnlyProbePort,
  RegistrationGitHubReadOnlyProbePort,
  ReadOptions,
} from "../../application/ports/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { GhTransport } from "../github/index.js";

const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/u;
const branchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u;
const repositorySummarySchema = z.object({ defaultBranch: z.string().min(1) }).strict();
const workflowSummarySchema = z
  .object({ activeWorkflowCount: z.number().int().nonnegative() })
  .strict();
const workflowConclusionSchema = z.enum([
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
  "success",
  "timed_out",
]);
const workflowRunSummarySchema = z
  .object({
    runCount: z.number().int().nonnegative(),
    latest: z
      .object({
        headBranch: z.string().min(1),
        status: z.literal("completed"),
        conclusion: workflowConclusionSchema.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export interface GitHubRegistrationContinuousIntegrationSnapshot {
  readonly actualDefaultBranch: string;
  readonly activeWorkflowCount: number;
  readonly latest: Readonly<{
    readonly headBranch: string;
    readonly status: "completed";
    readonly conclusion: z.infer<typeof workflowConclusionSchema> | null;
  }> | null;
}

export interface GitHubRegistrationReadOnlyClient {
  readonly inspectRepository: (
    repository: string,
    branch: string,
    options?: ReadOptions,
  ) => Promise<Result<Readonly<{ readable: boolean; actualDefaultBranch: string }>, DomainError>>;
  readonly inspectContinuousIntegration: (
    repository: string,
    branch: string,
    options?: ReadOptions,
  ) => Promise<Result<GitHubRegistrationContinuousIntegrationSnapshot, DomainError>>;
}

export interface GitHubRegistrationReadOnlyProbeOptions {
  readonly repository?: string;
  readonly defaultBranch?: string;
  readonly client?: GitHubRegistrationReadOnlyClient;
  readonly now?: () => string;
}

export interface GitHubRegistrationReadOnlyProbes {
  readonly github: RegistrationGitHubReadOnlyProbePort;
  readonly continuousIntegration: RegistrationContinuousIntegrationReadOnlyProbePort;
}

function observedAt(clock: () => string): string {
  const candidate = clock();
  return Number.isFinite(Date.parse(candidate)) ? candidate : new Date().toISOString();
}

function validRepository(value: string | undefined): value is string {
  const parts = value?.split("/") ?? [];
  return (
    value !== undefined &&
    repositoryPattern.test(value) &&
    parts.length === 2 &&
    parts.every((part) => part !== "." && part !== "..")
  );
}

function validBranch(value: string | undefined): value is string {
  return (
    value !== undefined &&
    branchPattern.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.endsWith(".") &&
    !value.endsWith("/") &&
    !value.endsWith(".lock")
  );
}

function encodedRepository(repository: string): string {
  return repository
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

/** Reuses GhTransport's GET-only capability read-back without exposing its identity or credential. */
export class GhRegistrationReadOnlyClient implements GitHubRegistrationReadOnlyClient {
  constructor(
    readonly transport: Pick<
      GhTransport,
      "inspectAuthentication" | "inspectRepositoryCapabilities" | "requestJson"
    > = new GhTransport(),
  ) {}

  async inspectRepository(
    repository: string,
    branch: string,
    options: ReadOptions = {},
  ): Promise<Result<Readonly<{ readable: boolean; actualDefaultBranch: string }>, DomainError>> {
    if (!validRepository(repository) || !validBranch(branch))
      return err(domainError("external_failure"));
    const [identity, capability] = await Promise.all([
      this.transport.inspectAuthentication("github.com", options),
      this.transport.inspectRepositoryCapabilities(repository, branch, options),
    ]);
    if (!identity.ok) return identity;
    if (!capability.ok) return capability;
    return ok(
      Object.freeze({
        readable: capability.value.permissions.pull,
        actualDefaultBranch: capability.value.defaultBranch,
      }),
    );
  }

  async inspectContinuousIntegration(
    repository: string,
    branch: string,
    options: ReadOptions = {},
  ): Promise<Result<GitHubRegistrationContinuousIntegrationSnapshot, DomainError>> {
    if (!validRepository(repository) || !validBranch(branch)) {
      return err(domainError("external_failure"));
    }
    const encoded = encodedRepository(repository);
    const [repositoryRead, workflowRead, runRead] = await Promise.all([
      this.transport.requestJson(
        ["api", `repos/${encoded}`, "--method", "GET", "--jq", "{defaultBranch:.default_branch}"],
        repositorySummarySchema,
        options,
      ),
      this.transport.requestJson(
        [
          "api",
          `repos/${encoded}/actions/workflows`,
          "--method",
          "GET",
          "--jq",
          '{activeWorkflowCount:([.workflows[] | select(.state == "active")] | length)}',
        ],
        workflowSummarySchema,
        options,
      ),
      this.transport.requestJson(
        [
          "api",
          `repos/${encoded}/actions/runs`,
          "--method",
          "GET",
          "-f",
          `branch=${branch}`,
          "-f",
          "status=completed",
          "-F",
          "per_page=1",
          "--jq",
          "{runCount:.total_count,latest:(if (.workflow_runs|length)>0 then (.workflow_runs[0]|{headBranch:.head_branch,status,conclusion}) else null end)}",
        ],
        workflowRunSummarySchema,
        options,
      ),
    ]);
    if (!repositoryRead.ok) return repositoryRead;
    if (!workflowRead.ok) return workflowRead;
    if (!runRead.ok) return runRead;
    if ((runRead.value.runCount === 0) !== (runRead.value.latest === null)) {
      return err(domainError("external_failure"));
    }
    return ok(
      Object.freeze({
        actualDefaultBranch: repositoryRead.value.defaultBranch,
        activeWorkflowCount: workflowRead.value.activeWorkflowCount,
        latest: runRead.value.latest,
      }),
    );
  }
}

/**
 * Concrete GitHub and CI probes. When no target repository is configured they
 * deliberately avoid invoking `gh`, so missing configuration remains unknown
 * instead of becoming a misleading failed external call.
 */
export class GitHubRegistrationReadOnlyProbeAdapter implements GitHubRegistrationReadOnlyProbes {
  readonly github: RegistrationGitHubReadOnlyProbePort;
  readonly continuousIntegration: RegistrationContinuousIntegrationReadOnlyProbePort;

  readonly #repository: string | undefined;
  readonly #defaultBranch: string | undefined;
  readonly #client: GitHubRegistrationReadOnlyClient;
  readonly #now: () => string;

  constructor(options: GitHubRegistrationReadOnlyProbeOptions = {}) {
    this.#repository = options.repository;
    this.#defaultBranch = options.defaultBranch;
    this.#client = options.client ?? new GhRegistrationReadOnlyClient();
    this.#now = options.now ?? (() => new Date().toISOString());
    this.github = Object.freeze({
      inspect: (readOptions?: ReadOptions) => this.inspectGitHub(readOptions),
    });
    this.continuousIntegration = Object.freeze({
      inspect: (readOptions?: ReadOptions) => this.inspectContinuousIntegration(readOptions),
    });
  }

  private async inspectGitHub(
    options: ReadOptions = {},
  ): ReturnType<RegistrationGitHubReadOnlyProbePort["inspect"]> {
    const at = observedAt(this.#now);
    if (!validRepository(this.#repository) || !validBranch(this.#defaultBranch)) {
      return ok({
        state: "unknown",
        evidence: Object.freeze(["尚未設定有效的 GitHub Repository 與預設分支。"]),
        provenance: "github_read_only",
        observedAt: at,
      });
    }
    if (options.signal?.aborted === true) return err(domainError("interrupted"));
    const read = await this.#client.inspectRepository(
      this.#repository,
      this.#defaultBranch,
      options,
    );
    if (!read.ok) return read;
    const matchesDefaultBranch = read.value.actualDefaultBranch === this.#defaultBranch;
    const passed = read.value.readable && matchesDefaultBranch;
    return ok({
      state: passed ? "passed" : "failed",
      evidence: Object.freeze([
        passed
          ? "已以 GitHub read-only capability query 確認 Repository 可讀取。"
          : !read.value.readable
            ? "GitHub read-only query 已完成，但目前身分沒有 Repository 讀取權限。"
            : "GitHub read-only query 顯示實際預設分支與設定不一致。",
      ]),
      provenance: "github_read_only",
      observedAt: at,
    });
  }

  private async inspectContinuousIntegration(
    options: ReadOptions = {},
  ): ReturnType<RegistrationContinuousIntegrationReadOnlyProbePort["inspect"]> {
    const at = observedAt(this.#now);
    if (!validRepository(this.#repository) || !validBranch(this.#defaultBranch)) {
      return ok({
        state: "unknown",
        evidence: Object.freeze([
          "尚未設定有效的 GitHub Repository 與預設分支，無法讀取 CI 摘要。",
        ]),
        provenance: "ci_read_only",
        observedAt: at,
      });
    }
    if (options.signal?.aborted === true) return err(domainError("interrupted"));
    const read = await this.#client.inspectContinuousIntegration(
      this.#repository,
      this.#defaultBranch,
      options,
    );
    if (!read.ok) return read;
    const snapshot = read.value;
    let state: "passed" | "failed" | "unknown";
    let evidence: string;
    if (snapshot.actualDefaultBranch !== this.#defaultBranch) {
      state = "failed";
      evidence = "GitHub Actions read-only query 顯示實際預設分支與設定不一致。";
    } else if (snapshot.activeWorkflowCount === 0) {
      state = "failed";
      evidence = "GitHub Actions read-only query 未找到啟用中的 workflow。";
    } else if (snapshot.latest === null) {
      state = "unknown";
      evidence = "GitHub Actions read-only query 尚無預設分支的已完成執行紀錄。";
    } else if (snapshot.latest.headBranch !== this.#defaultBranch) {
      state = "unknown";
      evidence = "GitHub Actions 最近執行摘要無法對應設定的預設分支。";
    } else if (snapshot.latest.conclusion === "success") {
      state = "passed";
      evidence = "已確認啟用中的 workflow，且預設分支最近一次已完成執行成功。";
    } else if (snapshot.latest.conclusion === null) {
      state = "unknown";
      evidence = "GitHub Actions 最近執行尚無可驗證的完成結論。";
    } else {
      state = "failed";
      evidence = "GitHub Actions 預設分支最近一次已完成執行未成功。";
    }
    return ok({
      state,
      evidence: Object.freeze([evidence]),
      provenance: "ci_read_only",
      observedAt: at,
    });
  }
}
