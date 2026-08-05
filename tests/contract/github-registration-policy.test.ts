import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  GitHubRegistrationPolicyAdapter,
  type GitHubRegistrationJsonTransport,
} from "../../src/adapters/registration/index.js";
import {
  githubRegistrationDesiredPolicy,
  githubRegistrationManagedRulesetName,
  githubRegistrationRequiredChecks,
} from "../../src/application/registration/index.js";
import type { ReadOptions } from "../../src/application/ports/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../src/domain/foundation/index.js";

interface Rule {
  readonly id: number;
  readonly name: string;
  readonly target: string;
  readonly enforcement: string;
  readonly conditionIncludes: readonly string[];
  readonly conditionExcludes: readonly string[];
  readonly bypassActors: readonly unknown[];
  readonly requiredStatusCheckRules: readonly Readonly<{
    contexts: readonly string[];
    strictRequiredStatusChecksPolicy: boolean;
    doNotEnforceOnCreate: boolean;
  }>[];
}

function rule(overrides: Partial<Rule> = {}): Rule {
  return Object.freeze({
    id: 1,
    name: "Existing policy",
    target: "branch",
    enforcement: "active",
    conditionIncludes: Object.freeze(["~DEFAULT_BRANCH"]),
    conditionExcludes: Object.freeze(["refs/heads/__agent_team_never__"]),
    bypassActors: Object.freeze([]),
    requiredStatusCheckRules: Object.freeze([
      Object.freeze({
        contexts: Object.freeze(["CI"]),
        strictRequiredStatusChecksPolicy: true,
        doNotEnforceOnCreate: false,
      }),
    ]),
    ...overrides,
  });
}

function exactManagedRule(id = 99): Rule {
  return rule({
    id,
    name: githubRegistrationManagedRulesetName,
    requiredStatusCheckRules: Object.freeze([
      Object.freeze({
        contexts: githubRegistrationRequiredChecks,
        strictRequiredStatusChecksPolicy: true,
        doNotEnforceOnCreate: false,
      }),
    ]),
  });
}

class FakeGitHubTransport implements GitHubRegistrationJsonTransport {
  readonly calls: string[][] = [];
  autoMerge = false;
  admin = true;
  listError: DomainError | undefined;
  detailOverride: unknown;
  rules: Rule[] = [];

  requestJson<Output>(
    arguments_: readonly string[],
    schema: z.ZodType<Output>,
    options?: ReadOptions,
  ): Promise<Result<Output, DomainError>> {
    void options;
    this.calls.push([...arguments_]);
    const endpoint = arguments_[1] ?? "";
    const methodIndex = arguments_.indexOf("--method");
    const method = methodIndex < 0 ? "GET" : arguments_[methodIndex + 1];
    let value: unknown;
    if (endpoint.endsWith("?includes_parents=false&per_page=100")) {
      if (this.listError !== undefined) return Promise.resolve(err(this.listError));
      value = this.rules.map((entry) => ({ id: entry.id }));
    } else if (/\/rulesets\/[1-9][0-9]*$/u.test(endpoint)) {
      const id = Number(endpoint.split("/").at(-1));
      value = this.detailOverride ?? this.rules.find((entry) => entry.id === id);
      if (value === undefined) return Promise.resolve(err(domainError("not_found")));
    } else if (endpoint.endsWith("/rulesets") && method === "POST") {
      const created = exactManagedRule(99);
      this.rules.push(created);
      value = { id: created.id };
    } else if (method === "PATCH") {
      this.autoMerge = true;
      value = { allowAutoMerge: true };
    } else {
      value = {
        defaultBranch: "main",
        allowAutoMerge: this.autoMerge,
        admin: this.admin,
      };
    }
    const parsed = schema.safeParse(value);
    return Promise.resolve(parsed.success ? ok(parsed.data) : err(domainError("external_failure")));
  }
}

const target = Object.freeze({
  projectId: "project-o004-contract",
  repository: "owner/repository",
  defaultBranch: "main",
});

describe("O004 GitHub registration adapter", () => {
  it("fails closed when exact detail is omitted or has weak required-check parameters", async () => {
    const omitted = new FakeGitHubTransport();
    omitted.rules = [exactManagedRule(3)];
    omitted.detailOverride = {
      id: 3,
      name: githubRegistrationManagedRulesetName,
      target: "branch",
      enforcement: "active",
    };
    expect((await new GitHubRegistrationPolicyAdapter(omitted).inspect(target)).ok).toBe(false);
    omitted.detailOverride = { ...exactManagedRule(3), unknownProviderField: true };
    expect((await new GitHubRegistrationPolicyAdapter(omitted).inspect(target)).ok).toBe(false);

    for (const requiredStatusCheckRules of [
      [
        {
          contexts: githubRegistrationRequiredChecks,
          strictRequiredStatusChecksPolicy: false,
          doNotEnforceOnCreate: false,
        },
      ],
      [
        {
          contexts: githubRegistrationRequiredChecks,
          strictRequiredStatusChecksPolicy: true,
          doNotEnforceOnCreate: true,
        },
      ],
    ] as const) {
      const weak = new FakeGitHubTransport();
      weak.autoMerge = true;
      weak.rules = [exactManagedRule(4)];
      weak.detailOverride = { ...exactManagedRule(4), requiredStatusCheckRules };
      expect(await new GitHubRegistrationPolicyAdapter(weak).inspect(target)).toMatchObject({
        ok: true,
        value: { managedRulesetCollision: true, managedRulesetExact: false },
      });
    }
  });

  it("reads all applicable active Rulesets but only one full managed rule is exact", async () => {
    const transport = new FakeGitHubTransport();
    transport.autoMerge = true;
    transport.rules = [
      rule({
        id: 1,
        name: "Existing stronger policy",
        requiredStatusCheckRules: Object.freeze([
          Object.freeze({
            contexts: Object.freeze(["CI", "agent-team/review", "security-scan"]),
            strictRequiredStatusChecksPolicy: true,
            doNotEnforceOnCreate: false,
          }),
        ]),
      }),
      rule({ id: 2, name: "Evaluate only", enforcement: "evaluate" }),
    ];

    const result = await new GitHubRegistrationPolicyAdapter(transport).inspect(target);

    expect(result).toMatchObject({
      ok: true,
      value: {
        autoMergeEnabled: true,
        activeRequiredChecks: ["CI", "agent-team/review", "security-scan"],
        managedRulesetCollision: false,
        managedRulesetExact: false,
      },
    });
  });

  it("uses additive POST plus true-only PATCH and exact read-back", async () => {
    const transport = new FakeGitHubTransport();
    const adapter = new GitHubRegistrationPolicyAdapter(transport);
    const before = await adapter.inspect(target);
    if (!before.ok) throw new Error(before.error.code);

    expect(
      await adapter.createManagedRuleset(
        {
          target,
          expectedRevision: before.value.revision,
          desiredPolicy: githubRegistrationDesiredPolicy.ruleset,
        },
        { idempotencyKey: "journal-owned-operation" },
      ),
    ).toEqual({ ok: true, value: { rulesetId: "99" } });
    expect(
      await adapter.enableAutoMerge({ target }, { idempotencyKey: "journal-owned-auto-merge" }),
    ).toEqual({ ok: true, value: { changed: true } });

    const mutationCalls = transport.calls.filter(
      (call) => call.includes("POST") || call.includes("PATCH"),
    );
    expect(mutationCalls).toHaveLength(2);
    expect(mutationCalls[0]?.join(" ")).toContain(
      "rules[][parameters][strict_required_status_checks_policy]=true",
    );
    expect(mutationCalls[0]?.join(" ")).toContain(
      "rules[][parameters][do_not_enforce_on_create]=false",
    );
    expect(mutationCalls[1]?.join(" ")).toContain("allow_auto_merge=true");
    expect(mutationCalls.flat()).not.toContain("DELETE");
    expect(mutationCalls.flat()).not.toContain("PUT");

    expect(await adapter.inspect(target)).toMatchObject({
      ok: true,
      value: {
        autoMergeEnabled: true,
        managedRulesetExact: true,
        managedRulesetId: "99",
      },
    });
  });

  it("rejects stale CAS and insufficient permission before any POST", async () => {
    const staleTransport = new FakeGitHubTransport();
    const staleAdapter = new GitHubRegistrationPolicyAdapter(staleTransport);
    expect(
      await staleAdapter.createManagedRuleset(
        {
          target,
          expectedRevision: "0".repeat(64),
          desiredPolicy: githubRegistrationDesiredPolicy.ruleset,
        },
        { idempotencyKey: "stale" },
      ),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });

    const deniedTransport = new FakeGitHubTransport();
    deniedTransport.admin = false;
    const deniedAdapter = new GitHubRegistrationPolicyAdapter(deniedTransport);
    const deniedRead = await deniedAdapter.inspect(target);
    if (!deniedRead.ok) throw new Error(deniedRead.error.code);
    expect(
      await deniedAdapter.createManagedRuleset(
        {
          target,
          expectedRevision: deniedRead.value.revision,
          desiredPolicy: githubRegistrationDesiredPolicy.ruleset,
        },
        { idempotencyKey: "denied" },
      ),
    ).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    expect(
      [...staleTransport.calls, ...deniedTransport.calls].some((call) => call.includes("POST")),
    ).toBe(false);
  });

  it("reports unsupported, bypass, and reserved-name collision without takeover", async () => {
    const unsupported = new FakeGitHubTransport();
    unsupported.listError = domainError("not_found");
    expect(await new GitHubRegistrationPolicyAdapter(unsupported).inspect(target)).toMatchObject({
      ok: true,
      value: { rulesets: "unsupported" },
    });

    for (const collisionRule of [
      rule({
        id: 4,
        name: githubRegistrationManagedRulesetName,
        bypassActors: Object.freeze([{ actor_id: 1 }]),
      }),
      rule({
        id: 5,
        name: githubRegistrationManagedRulesetName,
        conditionExcludes: Object.freeze([]),
      }),
      rule({
        id: 6,
        name: githubRegistrationManagedRulesetName,
        conditionIncludes: Object.freeze(["~DEFAULT_BRANCH", "refs/heads/release"]),
      }),
      rule({
        id: 7,
        name: githubRegistrationManagedRulesetName,
        requiredStatusCheckRules: Object.freeze([
          Object.freeze({
            contexts: Object.freeze(["CI"]),
            strictRequiredStatusChecksPolicy: true,
            doNotEnforceOnCreate: false,
          }),
          Object.freeze({
            contexts: Object.freeze(["agent-team/review"]),
            strictRequiredStatusChecksPolicy: true,
            doNotEnforceOnCreate: false,
          }),
        ]),
      }),
    ]) {
      const collision = new FakeGitHubTransport();
      collision.rules = [collisionRule];
      expect(await new GitHubRegistrationPolicyAdapter(collision).inspect(target)).toMatchObject({
        ok: true,
        value: { managedRulesetCollision: true, managedRulesetExact: false },
      });
    }
  });
});
