import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

import { z } from "zod";

import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import type { ReadOptions } from "../../application/ports/common.js";

const defaultTimeoutMs = 30_000;
const defaultMaxOutputBytes = 16 * 1024 * 1024;
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/u;
const branchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u;

const authenticationSchema = z.object({ login: z.string().min(1), id: z.number().int() }).strict();
const repositorySchema = z
  .object({
    visibility: z.enum(["public", "private", "internal"]),
    private: z.boolean(),
    defaultBranch: z.string().min(1),
    allowAutoMerge: z.boolean(),
    deleteBranchOnMerge: z.boolean(),
    permissions: z
      .object({
        admin: z.boolean(),
        maintain: z.boolean(),
        pull: z.boolean(),
        push: z.boolean(),
      })
      .strict(),
  })
  .strict();
const countSchema = z.object({ count: z.number().int().nonnegative() }).strict();
const configuredSchema = z.object({ configured: z.literal(true) }).strict();

export interface GhTransportOptions {
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly environment?: Readonly<Record<string, string>>;
}

export interface GhAuthenticationSnapshot {
  readonly active: true;
  readonly host: string;
  readonly accountFingerprint: string;
}

export interface GhCapabilityAvailability {
  readonly available: boolean;
  readonly failure?: "permission_denied" | "not_found_or_not_configured";
}

export interface GhRepositoryCapabilities {
  readonly visibility: "public" | "private" | "internal";
  readonly private: boolean;
  readonly defaultBranch: string;
  readonly allowAutoMerge: boolean;
  readonly deleteBranchOnMerge: boolean;
  readonly permissions: {
    readonly admin: boolean;
    readonly maintain: boolean;
    readonly pull: boolean;
    readonly push: boolean;
  };
  readonly rulesets: GhCapabilityAvailability & { readonly count?: number };
  readonly branchProtection: GhCapabilityAvailability;
  readonly requiredMergeGate: "unconfigured" | "unverified";
}

function failure<Value>(code: DomainError["code"]): Result<Value, DomainError> {
  return err(domainError(code));
}

function mapGhError(error: unknown, stderr: string): DomainError {
  if (typeof error === "object" && error !== null) {
    const name = "name" in error ? error.name : undefined;
    const code = "code" in error ? error.code : undefined;
    const killed = "killed" in error ? error.killed : undefined;
    if (name === "AbortError") return domainError("interrupted");
    if (code === "ENOENT") return domainError("unavailable");
    if (killed === true) return domainError("timeout");
  }
  const normalized = stderr.toLowerCase();
  if (
    normalized.includes("not logged into") ||
    normalized.includes("authentication") ||
    normalized.includes("http 401") ||
    normalized.includes("http 403") ||
    normalized.includes("forbidden")
  ) {
    return domainError("permission_denied");
  }
  if (normalized.includes("http 404") || normalized.includes("not found")) {
    return domainError("not_found");
  }
  if (normalized.includes("rate limit") || normalized.includes("http 429")) {
    return domainError("rate_limited");
  }
  if (normalized.includes("timed out") || normalized.includes("deadline exceeded")) {
    return domainError("timeout");
  }
  if (
    normalized.includes("could not resolve host") ||
    normalized.includes("connection refused") ||
    normalized.includes("connection reset") ||
    normalized.includes("network")
  ) {
    return domainError("unavailable");
  }
  return domainError("external_failure");
}

function validArguments(arguments_: readonly string[]): boolean {
  return (
    arguments_.length > 0 &&
    arguments_[0] === "api" &&
    arguments_.length <= 1_000 &&
    arguments_.every(
      (argument) =>
        argument.length <= 100_000 && !argument.includes("\u0000") && !/[\r\n]/u.test(argument),
    ) &&
    !arguments_.some(
      (argument) =>
        argument === "--input" ||
        argument.startsWith("--input=") ||
        argument === "-F" ||
        argument.startsWith("-F"),
    ) &&
    arguments_.reduce((total, argument) => total + argument.length, 0) <= 1_000_000
  );
}

function capabilityFailure(error: DomainError): GhCapabilityAvailability["failure"] | undefined {
  if (error.code === "permission_denied") return "permission_denied";
  if (error.code === "not_found") return "not_found_or_not_configured";
  return undefined;
}

export class GhTransport {
  readonly #executable: string;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;
  readonly #environment: NodeJS.ProcessEnv;

  constructor(options: GhTransportOptions = {}) {
    this.#executable = options.executable ?? "gh";
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.#timeoutMs =
      Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 5 * 60_000
        ? timeoutMs
        : defaultTimeoutMs;
    const maxOutputBytes = options.maxOutputBytes ?? defaultMaxOutputBytes;
    this.#maxOutputBytes =
      Number.isSafeInteger(maxOutputBytes) &&
      maxOutputBytes >= 1_024 &&
      maxOutputBytes <= 64 * 1024 * 1024
        ? maxOutputBytes
        : defaultMaxOutputBytes;
    this.#environment = { ...process.env, ...(options.environment ?? {}) };
  }

  async requestJson<Output>(
    arguments_: readonly string[],
    schema: z.ZodType<Output>,
    options: ReadOptions = {},
  ): Promise<Result<Output, DomainError>> {
    if (!validArguments(arguments_)) return failure("external_failure");
    if (options.signal?.aborted === true) return failure("interrupted");
    return new Promise((resolveResult) => {
      execFile(
        this.#executable,
        [...arguments_],
        {
          encoding: "utf8",
          env: this.#environment,
          maxBuffer: this.#maxOutputBytes,
          timeout: this.#timeoutMs,
          windowsHide: true,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
        (error, stdout, stderr) => {
          if (error !== null) {
            resolveResult(err(mapGhError(error, stderr)));
            return;
          }
          try {
            const parsed = schema.safeParse(JSON.parse(stdout) as unknown);
            resolveResult(parsed.success ? ok(parsed.data) : failure("external_failure"));
          } catch {
            resolveResult(failure("external_failure"));
          }
        },
      );
    });
  }

  async inspectAuthentication(
    host = "github.com",
    options: ReadOptions = {},
  ): Promise<Result<GhAuthenticationSnapshot, DomainError>> {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/u.test(host) || host.includes("..")) {
      return failure("external_failure");
    }
    const identity = await this.requestJson(
      ["api", "--hostname", host, "user", "--jq", "{login,id}"],
      authenticationSchema,
      options,
    );
    if (!identity.ok) return identity;
    const accountFingerprint = createHash("sha256")
      .update(`${host}:${String(identity.value.id)}:${identity.value.login}`, "utf8")
      .digest("hex");
    return ok({ active: true, host, accountFingerprint });
  }

  async inspectRepositoryCapabilities(
    repository: string,
    branch: string,
    options: ReadOptions = {},
  ): Promise<Result<GhRepositoryCapabilities, DomainError>> {
    const repositoryParts = repository.split("/");
    if (
      !repositoryPattern.test(repository) ||
      repositoryParts.some((part) => part === "." || part === "..") ||
      !branchPattern.test(branch) ||
      branch.includes("..") ||
      branch.includes("//") ||
      branch.endsWith(".") ||
      branch.endsWith("/") ||
      branch.endsWith(".lock")
    ) {
      return failure("external_failure");
    }
    const encodedRepository = repository
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
    const encodedBranch = encodeURIComponent(branch);
    const repositoryResult = await this.requestJson(
      [
        "api",
        `repos/${encodedRepository}`,
        "--jq",
        "{visibility,private,defaultBranch:.default_branch,allowAutoMerge:.allow_auto_merge,deleteBranchOnMerge:.delete_branch_on_merge,permissions:{admin:.permissions.admin,maintain:.permissions.maintain,pull:.permissions.pull,push:.permissions.push}}",
      ],
      repositorySchema,
      options,
    );
    if (!repositoryResult.ok) return repositoryResult;
    if (repositoryResult.value.private !== (repositoryResult.value.visibility !== "public")) {
      return failure("external_failure");
    }

    const [rulesetsResult, protectionResult] = await Promise.all([
      this.requestJson(
        ["api", `repos/${encodedRepository}/rulesets`, "--jq", "{count:length}"],
        countSchema,
        options,
      ),
      this.requestJson(
        [
          "api",
          `repos/${encodedRepository}/branches/${encodedBranch}/protection`,
          "--jq",
          "{configured:true}",
        ],
        configuredSchema,
        options,
      ),
    ]);
    if (!rulesetsResult.ok && capabilityFailure(rulesetsResult.error) === undefined) {
      return rulesetsResult;
    }
    if (!protectionResult.ok && capabilityFailure(protectionResult.error) === undefined) {
      return protectionResult;
    }
    const rulesets: GhRepositoryCapabilities["rulesets"] = rulesetsResult.ok
      ? { available: true, count: rulesetsResult.value.count }
      : {
          available: false,
          failure: capabilityFailure(rulesetsResult.error) ?? "permission_denied",
        };
    const branchProtection: GhRepositoryCapabilities["branchProtection"] = protectionResult.ok
      ? { available: true }
      : {
          available: false,
          failure: capabilityFailure(protectionResult.error) ?? "permission_denied",
        };
    return ok({
      ...repositoryResult.value,
      rulesets,
      branchProtection,
      requiredMergeGate:
        rulesetsResult.ok &&
        rulesetsResult.value.count === 0 &&
        !protectionResult.ok &&
        capabilityFailure(protectionResult.error) === "not_found_or_not_configured"
          ? "unconfigured"
          : "unverified",
    });
  }
}
