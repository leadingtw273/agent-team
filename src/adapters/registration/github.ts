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
const workflowSummarySchema = z.object({ workflowCount: z.number().int().nonnegative() }).strict();

export interface GitHubRegistrationReadOnlyClient {
  readonly inspectRepository: (
    repository: string,
    branch: string,
    options?: ReadOptions,
  ) => Promise<Result<Readonly<{ readable: boolean }>, DomainError>>;
  readonly inspectContinuousIntegration: (
    repository: string,
    options?: ReadOptions,
  ) => Promise<Result<Readonly<{ workflowCount: number }>, DomainError>>;
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
  constructor(readonly transport: GhTransport = new GhTransport()) {}

  async inspectRepository(
    repository: string,
    branch: string,
    options: ReadOptions = {},
  ): Promise<Result<Readonly<{ readable: boolean }>, DomainError>> {
    if (!validRepository(repository) || !validBranch(branch))
      return err(domainError("external_failure"));
    const [identity, capability] = await Promise.all([
      this.transport.inspectAuthentication("github.com", options),
      this.transport.inspectRepositoryCapabilities(repository, branch, options),
    ]);
    if (!identity.ok) return identity;
    if (!capability.ok) return capability;
    return ok(Object.freeze({ readable: capability.value.permissions.pull }));
  }

  async inspectContinuousIntegration(
    repository: string,
    options: ReadOptions = {},
  ): Promise<Result<Readonly<{ workflowCount: number }>, DomainError>> {
    if (!validRepository(repository)) return err(domainError("external_failure"));
    return this.transport.requestJson(
      [
        "api",
        `repos/${encodedRepository(repository)}/actions/workflows`,
        "--method",
        "GET",
        "--jq",
        "{workflowCount:.total_count}",
      ],
      workflowSummarySchema,
      options,
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
    return ok({
      state: read.value.readable ? "passed" : "failed",
      evidence: Object.freeze([
        read.value.readable
          ? "已以 GitHub read-only capability query 確認 Repository 可讀取。"
          : "GitHub read-only query 已完成，但目前身分沒有 Repository 讀取權限。",
      ]),
      provenance: "github_read_only",
      observedAt: at,
    });
  }

  private async inspectContinuousIntegration(
    options: ReadOptions = {},
  ): ReturnType<RegistrationContinuousIntegrationReadOnlyProbePort["inspect"]> {
    const at = observedAt(this.#now);
    if (!validRepository(this.#repository)) {
      return ok({
        state: "unknown",
        evidence: Object.freeze(["尚未設定有效的 GitHub Repository，無法讀取 CI workflow 摘要。"]),
        provenance: "ci_read_only",
        observedAt: at,
      });
    }
    if (options.signal?.aborted === true) return err(domainError("interrupted"));
    const read = await this.#client.inspectContinuousIntegration(this.#repository, options);
    if (!read.ok) return read;
    return ok({
      state: read.value.workflowCount > 0 ? "passed" : "failed",
      evidence: Object.freeze([
        read.value.workflowCount > 0
          ? "已以 GitHub Actions read-only query 確認至少一個 workflow。"
          : "GitHub Actions read-only query 未找到任何 workflow。",
      ]),
      provenance: "ci_read_only",
      observedAt: at,
    });
  }
}
