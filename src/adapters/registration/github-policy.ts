import { createHash } from "node:crypto";

import { z } from "zod";

import {
  githubRegistrationManagedRulesetName,
  githubRegistrationRequiredChecks,
  type GitHubRegistrationInventory,
  type GitHubRegistrationPolicyPort,
  type GitHubRegistrationProvisionRequest,
  type GitHubRegistrationTarget,
} from "../../application/registration/index.js";
import type { MutationOptions, ReadOptions } from "../../application/ports/index.js";
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
const revisionPattern = /^[a-f0-9]{64}$/u;
const ruleIdPattern = /^[1-9][0-9]{0,19}$/u;
const repositorySchema = z
  .object({
    defaultBranch: z.string().min(1),
    allowAutoMerge: z.boolean(),
    admin: z.boolean(),
  })
  .strict();
const rulesetListSchema = z
  .array(
    z
      .object({
        id: z.union([z.number().int().positive(), z.string().regex(ruleIdPattern)]),
      })
      .strict(),
  )
  .max(1_000);
const rulesetDetailSchema = z
  .object({
    id: z.union([z.number().int().positive(), z.string().regex(ruleIdPattern)]),
    name: z.string().min(1).max(100),
    target: z.string().max(50),
    enforcement: z.string().max(50),
    includesDefaultBranch: z.boolean(),
    excludesDefaultBranch: z.boolean(),
    requiredChecks: z.array(z.string().min(1).max(100)).max(1_000),
  })
  .strict();
const createdRulesetSchema = z
  .object({ id: z.union([z.number().int().positive(), z.string().regex(ruleIdPattern)]) })
  .strict();
const autoMergeSchema = z.object({ allowAutoMerge: z.literal(true) }).strict();

const repositoryProjection =
  "{defaultBranch:.default_branch,allowAutoMerge:.allow_auto_merge,admin:.permissions.admin}";
const rulesetListProjection = "[add[]|{id}]";
const rulesetDetailProjection =
  '{id,name,target,enforcement,includesDefaultBranch:((.conditions.ref_name.include // [])|index("~DEFAULT_BRANCH")!=null),excludesDefaultBranch:((.conditions.ref_name.exclude // [])|index("~DEFAULT_BRANCH")!=null),requiredChecks:[.rules[]?|select(.type=="required_status_checks")|.parameters.required_status_checks[]?.context]}';

export interface GitHubRegistrationJsonTransport {
  requestJson<Output>(
    arguments_: readonly string[],
    schema: z.ZodType<Output>,
    options?: ReadOptions,
  ): Promise<Result<Output, DomainError>>;
}

interface InventoryRead {
  readonly inventory: GitHubRegistrationInventory;
  readonly missingRequiredChecks: boolean;
}

function encodedRepository(target: GitHubRegistrationTarget): string {
  return target.repository
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function validTarget(target: GitHubRegistrationTarget): boolean {
  const parts = target.repository.split("/");
  return (
    repositoryPattern.test(target.repository) &&
    parts.length === 2 &&
    parts.every((part) => part !== "." && part !== "..") &&
    branchPattern.test(target.defaultBranch) &&
    !target.defaultBranch.includes("..") &&
    !target.defaultBranch.includes("//") &&
    !target.defaultBranch.endsWith(".") &&
    !target.defaultBranch.endsWith("/") &&
    !target.defaultBranch.endsWith(".lock")
  );
}

function revision(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function asUnsupportedInventory(
  repository: z.infer<typeof repositorySchema>,
): GitHubRegistrationInventory {
  const projected = {
    permission: repository.admin ? "admin" : "read_only",
    rulesets: "unsupported",
    autoMerge: "supported",
    autoMergeEnabled: repository.allowAutoMerge,
    activeRequiredChecks: [] as string[],
    managedRulesetCollision: false,
  } as const;
  return Object.freeze({ revision: revision(projected), ...projected });
}

function normalizedRule(rule: z.infer<typeof rulesetDetailSchema>) {
  return Object.freeze({
    id: String(rule.id),
    name: rule.name,
    target: rule.target,
    enforcement: rule.enforcement,
    includesDefaultBranch: rule.includesDefaultBranch,
    excludesDefaultBranch: rule.excludesDefaultBranch,
    requiredChecks: Object.freeze([...new Set(rule.requiredChecks)].sort()),
  });
}

function providerFailure<Value>(code: DomainError["code"]): Result<Value, DomainError> {
  return err(domainError(code));
}

function exactRequiredChecks(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === githubRegistrationRequiredChecks.length &&
    value.every((context, index) => context === githubRegistrationRequiredChecks[index])
  );
}

function createRulesetArguments(target: GitHubRegistrationTarget): readonly string[] {
  const endpoint = `repos/${encodedRepository(target)}/rulesets`;
  return Object.freeze([
    "api",
    endpoint,
    "--method",
    "POST",
    "-f",
    `name=${githubRegistrationManagedRulesetName}`,
    "-f",
    "target=branch",
    "-f",
    "enforcement=active",
    "-f",
    "conditions[ref_name][include][0]=~DEFAULT_BRANCH",
    "-f",
    "conditions[ref_name][exclude][0]=refs/heads/__agent_team_never__",
    "-f",
    "rules[0][type]=required_status_checks",
    "-f",
    `rules[0][parameters][required_status_checks][0][context]=${githubRegistrationRequiredChecks[0]}`,
    "-f",
    `rules[0][parameters][required_status_checks][1][context]=${githubRegistrationRequiredChecks[1]}`,
    "-F",
    "rules[0][parameters][strict_required_status_checks_policy]=true",
    "--jq",
    "{id}",
  ]);
}

/**
 * Registration-only adapter. Its mutation surface is monotonic by construction:
 * create a dedicated active Ruleset and set allow_auto_merge=true. It has no
 * update/delete/disable operation for existing protections.
 */
export class GitHubRegistrationPolicyAdapter implements GitHubRegistrationPolicyPort {
  constructor(readonly transport: GitHubRegistrationJsonTransport = new GhTransport()) {}

  private async read(
    target: GitHubRegistrationTarget,
    options: ReadOptions = {},
  ): Promise<Result<InventoryRead, DomainError>> {
    if (!validTarget(target)) return providerFailure("external_failure");
    const endpoint = `repos/${encodedRepository(target)}`;
    const repository = await this.transport.requestJson(
      ["api", endpoint, "--method", "GET", "--jq", repositoryProjection],
      repositorySchema,
      options,
    );
    if (!repository.ok) return repository;
    if (repository.value.defaultBranch !== target.defaultBranch) {
      return providerFailure("conflict");
    }
    const list = await this.transport.requestJson(
      [
        "api",
        `${endpoint}/rulesets?includes_parents=false&per_page=100`,
        "--method",
        "GET",
        "--paginate",
        "--slurp",
        "--jq",
        rulesetListProjection,
      ],
      rulesetListSchema,
      options,
    );
    if (!list.ok) {
      if (list.error.code === "not_found") {
        const unsupported = asUnsupportedInventory(repository.value);
        return ok(Object.freeze({ inventory: unsupported, missingRequiredChecks: true }));
      }
      return list;
    }
    const details: ReturnType<typeof normalizedRule>[] = [];
    for (const item of list.value) {
      const detail = await this.transport.requestJson(
        [
          "api",
          `${endpoint}/rulesets/${String(item.id)}`,
          "--method",
          "GET",
          "--jq",
          rulesetDetailProjection,
        ],
        rulesetDetailSchema,
        options,
      );
      if (!detail.ok) return detail;
      if (String(detail.value.id) !== String(item.id)) return providerFailure("external_failure");
      details.push(normalizedRule(detail.value));
    }
    details.sort((left, right) => left.id.localeCompare(right.id));
    const applicable = details.filter(
      (rule) =>
        rule.target === "branch" &&
        rule.enforcement === "active" &&
        rule.includesDefaultBranch &&
        !rule.excludesDefaultBranch,
    );
    const activeRequiredChecks = Object.freeze(
      [...new Set(applicable.flatMap((rule) => rule.requiredChecks))].sort(),
    );
    const activeSet = new Set(activeRequiredChecks);
    const missingRequiredChecks = githubRegistrationRequiredChecks.some(
      (context) => !activeSet.has(context),
    );
    const managedRulesetCollision = details.some(
      (rule) =>
        rule.name === githubRegistrationManagedRulesetName &&
        !(
          rule.target === "branch" &&
          rule.enforcement === "active" &&
          rule.includesDefaultBranch &&
          !rule.excludesDefaultBranch &&
          githubRegistrationRequiredChecks.every((context) => rule.requiredChecks.includes(context))
        ),
    );
    const projection = Object.freeze({
      repository: Object.freeze({
        defaultBranch: repository.value.defaultBranch,
        allowAutoMerge: repository.value.allowAutoMerge,
        admin: repository.value.admin,
      }),
      rules: Object.freeze(details),
    });
    const inventory = Object.freeze({
      revision: revision(projection),
      permission: repository.value.admin ? ("admin" as const) : ("read_only" as const),
      rulesets: "supported" as const,
      autoMerge: "supported" as const,
      autoMergeEnabled: repository.value.allowAutoMerge,
      activeRequiredChecks,
      managedRulesetCollision,
    });
    return ok(Object.freeze({ inventory, missingRequiredChecks }));
  }

  async inspect(
    target: GitHubRegistrationTarget,
    options: ReadOptions = {},
  ): Promise<Result<GitHubRegistrationInventory, DomainError>> {
    const result = await this.read(target, options);
    return result.ok ? ok(result.value.inventory) : result;
  }

  async provision(
    request: GitHubRegistrationProvisionRequest,
    options: MutationOptions,
  ): Promise<Result<Readonly<{ changed: boolean }>, DomainError>> {
    if (
      !validTarget(request.target) ||
      !revisionPattern.test(request.expectedRevision) ||
      options.idempotencyKey.trim().length === 0 ||
      (request as { readonly enableAutoMerge?: unknown }).enableAutoMerge !== true ||
      !exactRequiredChecks((request as { readonly requiredChecks?: unknown }).requiredChecks)
    ) {
      return providerFailure("invariant_violation");
    }
    const current = await this.read(request.target, options);
    if (!current.ok) return current;
    if (current.value.inventory.revision !== request.expectedRevision) {
      return providerFailure("conflict");
    }
    if (
      current.value.inventory.permission !== "admin" ||
      current.value.inventory.rulesets !== "supported" ||
      current.value.inventory.autoMerge !== "supported"
    ) {
      return providerFailure("permission_denied");
    }
    if (current.value.inventory.managedRulesetCollision) return providerFailure("conflict");

    let changed = false;
    if (current.value.missingRequiredChecks) {
      const created = await this.transport.requestJson(
        createRulesetArguments(request.target),
        createdRulesetSchema,
        options,
      );
      if (!created.ok) return created;
      changed = true;
    }
    if (!current.value.inventory.autoMergeEnabled) {
      const endpoint = `repos/${encodedRepository(request.target)}`;
      const enabled = await this.transport.requestJson(
        [
          "api",
          endpoint,
          "--method",
          "PATCH",
          "-F",
          "allow_auto_merge=true",
          "--jq",
          "{allowAutoMerge:.allow_auto_merge}",
        ],
        autoMergeSchema,
        options,
      );
      if (!enabled.ok) return enabled;
      changed = true;
    }
    return ok(Object.freeze({ changed }));
  }
}
