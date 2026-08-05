import { createHash } from "node:crypto";

import { z } from "zod";

import {
  githubRegistrationDesiredPolicy,
  githubRegistrationManagedRulesetName,
  githubRegistrationRequiredChecks,
  type GitHubRegistrationCreateRulesetRequest,
  type GitHubRegistrationEnableAutoMergeRequest,
  type GitHubRegistrationInventory,
  type GitHubRegistrationPolicyPort,
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

const projectIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$/u;
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
const requiredStatusCheckRuleSchema = z
  .object({
    contexts: z.array(z.string().min(1).max(100)).max(1_000),
    strictRequiredStatusChecksPolicy: z.boolean(),
    doNotEnforceOnCreate: z.boolean(),
  })
  .strict();
const rulesetDetailSchema = z
  .object({
    id: z.union([z.number().int().positive(), z.string().regex(ruleIdPattern)]),
    name: z.string().min(1).max(100),
    target: z.string().max(50),
    enforcement: z.string().max(50),
    conditionIncludes: z.array(z.string().min(1).max(255)).max(1_000),
    conditionExcludes: z.array(z.string().min(1).max(255)).max(1_000),
    bypassActors: z.array(z.unknown()).max(1_000),
    requiredStatusCheckRules: z.array(requiredStatusCheckRuleSchema).max(100),
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
  '{id,name,target,enforcement,conditionIncludes:.conditions.ref_name.include,conditionExcludes:.conditions.ref_name.exclude,bypassActors:.bypass_actors,requiredStatusCheckRules:[.rules[]|select(.type=="required_status_checks")|{contexts:[.parameters.required_status_checks[].context],strictRequiredStatusChecksPolicy:.parameters.strict_required_status_checks_policy,doNotEnforceOnCreate:.parameters.do_not_enforce_on_create}]}';

export interface GitHubRegistrationJsonTransport {
  requestJson<Output>(
    arguments_: readonly string[],
    schema: z.ZodType<Output>,
    options?: ReadOptions,
  ): Promise<Result<Output, DomainError>>;
}

interface InventoryRead {
  readonly inventory: GitHubRegistrationInventory;
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
    projectIdPattern.test(target.projectId) &&
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
    managedRulesetExact: false,
  } as const;
  return Object.freeze({ revision: revision(projected), ...projected });
}

function normalizedRule(rule: z.infer<typeof rulesetDetailSchema>) {
  return Object.freeze({
    id: String(rule.id),
    name: rule.name,
    target: rule.target,
    enforcement: rule.enforcement,
    conditionIncludes: Object.freeze([...rule.conditionIncludes]),
    conditionExcludes: Object.freeze([...rule.conditionExcludes]),
    bypassActors: Object.freeze([...rule.bypassActors]),
    requiredStatusCheckRules: Object.freeze(
      rule.requiredStatusCheckRules.map((entry) =>
        Object.freeze({
          contexts: Object.freeze([...entry.contexts]),
          strictRequiredStatusChecksPolicy: entry.strictRequiredStatusChecksPolicy,
          doNotEnforceOnCreate: entry.doNotEnforceOnCreate,
        }),
      ),
    ),
  });
}

function providerFailure<Value>(code: DomainError["code"]): Result<Value, DomainError> {
  return err(domainError(code));
}

function exactStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function exactManagedRule(rule: ReturnType<typeof normalizedRule>): boolean {
  const required = rule.requiredStatusCheckRules[0];
  return (
    rule.name === githubRegistrationManagedRulesetName &&
    rule.target === githubRegistrationDesiredPolicy.ruleset.target &&
    rule.enforcement === githubRegistrationDesiredPolicy.ruleset.enforcement &&
    exactStrings(
      rule.conditionIncludes,
      githubRegistrationDesiredPolicy.ruleset.conditions.include,
    ) &&
    exactStrings(
      rule.conditionExcludes,
      githubRegistrationDesiredPolicy.ruleset.conditions.exclude,
    ) &&
    rule.bypassActors.length === 0 &&
    rule.requiredStatusCheckRules.length === 1 &&
    required !== undefined &&
    exactStrings(required.contexts, githubRegistrationRequiredChecks) &&
    required.strictRequiredStatusChecksPolicy &&
    !required.doNotEnforceOnCreate
  );
}

function applicableRule(rule: ReturnType<typeof normalizedRule>): boolean {
  return (
    rule.target === "branch" &&
    rule.enforcement === "active" &&
    rule.conditionIncludes.includes("~DEFAULT_BRANCH") &&
    !rule.conditionExcludes.includes("~DEFAULT_BRANCH") &&
    rule.bypassActors.length === 0
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
    "conditions[ref_name][include][]=~DEFAULT_BRANCH",
    "-f",
    "conditions[ref_name][exclude][]=refs/heads/__agent_team_never__",
    "-f",
    "rules[][type]=required_status_checks",
    "-f",
    `rules[][parameters][required_status_checks][][context]=${githubRegistrationRequiredChecks[0]}`,
    "-f",
    `rules[][parameters][required_status_checks][][context]=${githubRegistrationRequiredChecks[1]}`,
    "-F",
    "rules[][parameters][strict_required_status_checks_policy]=true",
    "-F",
    "rules[][parameters][do_not_enforce_on_create]=false",
    "--jq",
    "{id}",
  ]);
}

/** Additive-only GitHub adapter; durable idempotency is owned by the application journal. */
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
    if (repository.value.defaultBranch !== target.defaultBranch) return providerFailure("conflict");
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
      return list.error.code === "not_found"
        ? ok(Object.freeze({ inventory: asUnsupportedInventory(repository.value) }))
        : list;
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
    const applicable = details.filter(applicableRule);
    const activeRequiredChecks = Object.freeze(
      [
        ...new Set(
          applicable.flatMap((rule) =>
            rule.requiredStatusCheckRules.flatMap((entry) => entry.contexts),
          ),
        ),
      ].sort(),
    );
    const reserved = details.filter((rule) => rule.name === githubRegistrationManagedRulesetName);
    const exact = reserved.filter(exactManagedRule);
    const managedRulesetCollision =
      reserved.length > 1 || (reserved.length === 1 && exact.length !== 1);
    const managedRulesetExact = exact.length === 1 && !managedRulesetCollision;
    const projection = Object.freeze({
      repository: Object.freeze({
        defaultBranch: repository.value.defaultBranch,
        allowAutoMerge: repository.value.allowAutoMerge,
        admin: repository.value.admin,
      }),
      rules: Object.freeze(details),
    });
    const inventory: GitHubRegistrationInventory = Object.freeze({
      revision: revision(projection),
      permission: repository.value.admin ? "admin" : "read_only",
      rulesets: "supported",
      autoMerge: "supported",
      autoMergeEnabled: repository.value.allowAutoMerge,
      activeRequiredChecks,
      managedRulesetCollision,
      managedRulesetExact,
      ...(managedRulesetExact && exact[0] !== undefined ? { managedRulesetId: exact[0].id } : {}),
    });
    return ok(Object.freeze({ inventory }));
  }

  async inspect(
    target: GitHubRegistrationTarget,
    options: ReadOptions = {},
  ): Promise<Result<GitHubRegistrationInventory, DomainError>> {
    const result = await this.read(target, options);
    return result.ok ? ok(result.value.inventory) : result;
  }

  async createManagedRuleset(
    request: GitHubRegistrationCreateRulesetRequest,
    options: MutationOptions,
  ): Promise<Result<Readonly<{ rulesetId: string }>, DomainError>> {
    if (
      !validTarget(request.target) ||
      !revisionPattern.test(request.expectedRevision) ||
      JSON.stringify(request.desiredPolicy) !==
        JSON.stringify(githubRegistrationDesiredPolicy.ruleset)
    ) {
      return providerFailure("invariant_violation");
    }
    const current = await this.read(request.target, options);
    if (!current.ok) return current;
    if (current.value.inventory.revision !== request.expectedRevision)
      return providerFailure("conflict");
    if (current.value.inventory.permission !== "admin") return providerFailure("permission_denied");
    if (
      current.value.inventory.rulesets !== "supported" ||
      current.value.inventory.managedRulesetCollision ||
      current.value.inventory.managedRulesetExact
    ) {
      return providerFailure("conflict");
    }
    const created = await this.transport.requestJson(
      createRulesetArguments(request.target),
      createdRulesetSchema,
      options,
    );
    return created.ok ? ok(Object.freeze({ rulesetId: String(created.value.id) })) : created;
  }

  async enableAutoMerge(
    request: GitHubRegistrationEnableAutoMergeRequest,
    options: MutationOptions,
  ): Promise<Result<Readonly<{ changed: boolean }>, DomainError>> {
    if (!validTarget(request.target)) return providerFailure("invariant_violation");
    const current = await this.read(request.target, options);
    if (!current.ok) return current;
    if (current.value.inventory.permission !== "admin") return providerFailure("permission_denied");
    if (current.value.inventory.autoMergeEnabled) return ok(Object.freeze({ changed: false }));
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
    return enabled.ok ? ok(Object.freeze({ changed: true })) : enabled;
  }
}
