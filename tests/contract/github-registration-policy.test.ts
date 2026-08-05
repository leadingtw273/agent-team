import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  GitHubRegistrationPolicyAdapter,
  type GitHubRegistrationJsonTransport,
} from "../../src/adapters/registration/index.js";
import {
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
  readonly includesDefaultBranch: boolean;
  readonly excludesDefaultBranch: boolean;
  readonly requiredChecks: readonly string[];
}

class FakeGitHubTransport implements GitHubRegistrationJsonTransport {
  readonly calls: string[][] = [];
  autoMerge = false;
  admin = true;
  listError: DomainError | undefined;
  rules: Rule[] = [];

  requestJson<Output>(
    arguments_: readonly string[],
    _schema: z.ZodType<Output>,
    _options?: ReadOptions,
  ): Promise<Result<Output, DomainError>> {
    void _options;
    this.calls.push([...arguments_]);
    const endpoint = arguments_[1] ?? "";
    const methodIndex = arguments_.indexOf("--method");
    const method = methodIndex < 0 ? "GET" : arguments_[methodIndex + 1];
    let value: unknown;
    if (endpoint.endsWith("?includes_parents=false&per_page=100")) {
      if (this.listError !== undefined) return Promise.resolve(err(this.listError));
      value = this.rules.map((rule) => ({ id: rule.id }));
    } else if (/\/rulesets\/[1-9][0-9]*$/u.test(endpoint)) {
      const id = Number(endpoint.split("/").at(-1));
      value = this.rules.find((rule) => rule.id === id);
      if (value === undefined) return Promise.resolve(err(domainError("not_found")));
    } else if (endpoint.endsWith("/rulesets") && method === "POST") {
      const rule: Rule = {
        id: 99,
        name: githubRegistrationManagedRulesetName,
        target: "branch",
        enforcement: "active",
        includesDefaultBranch: true,
        excludesDefaultBranch: false,
        requiredChecks: [...githubRegistrationRequiredChecks],
      };
      this.rules.push(rule);
      value = { id: rule.id };
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
    const parsed = _schema.safeParse(value);
    return Promise.resolve(parsed.success ? ok(parsed.data) : err(domainError("external_failure")));
  }
}

const target = Object.freeze({ repository: "owner/repository", defaultBranch: "main" });

describe("O004 GitHub registration adapter", () => {
  it("reads all applicable active Rulesets and preserves stronger existing checks", async () => {
    const transport = new FakeGitHubTransport();
    transport.autoMerge = true;
    transport.rules = [
      {
        id: 1,
        name: "Existing stronger policy",
        target: "branch",
        enforcement: "active",
        includesDefaultBranch: true,
        excludesDefaultBranch: false,
        requiredChecks: ["CI", "agent-team/review", "security-scan"],
      },
      {
        id: 2,
        name: "Evaluate only",
        target: "branch",
        enforcement: "evaluate",
        includesDefaultBranch: true,
        excludesDefaultBranch: false,
        requiredChecks: ["untrusted-evaluate-check"],
      },
    ];

    const result = await new GitHubRegistrationPolicyAdapter(transport).inspect(target);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.revision).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.value).toMatchObject({
      permission: "admin",
      rulesets: "supported",
      autoMerge: "supported",
      autoMergeEnabled: true,
      activeRequiredChecks: ["CI", "agent-team/review", "security-scan"],
      managedRulesetCollision: false,
    });
    expect(JSON.stringify(result)).not.toContain("untrusted-evaluate-check");
  });

  it("uses additive POST plus true-only PATCH and is idempotent after read-back", async () => {
    const transport = new FakeGitHubTransport();
    const adapter = new GitHubRegistrationPolicyAdapter(transport);
    const before = await adapter.inspect(target);
    if (!before.ok) throw new Error(before.error.code);

    expect(
      await adapter.provision(
        {
          target,
          expectedRevision: before.value.revision,
          requiredChecks: githubRegistrationRequiredChecks,
          enableAutoMerge: true,
        },
        { idempotencyKey: "test:additive" },
      ),
    ).toEqual({ ok: true, value: { changed: true } });

    const mutationCalls = transport.calls.filter(
      (call) => call.includes("POST") || call.includes("PATCH"),
    );
    expect(mutationCalls).toHaveLength(2);
    expect(mutationCalls[0]?.join(" ")).toContain(
      "rules[0][parameters][required_status_checks][0][context]=CI",
    );
    expect(mutationCalls[0]?.join(" ")).toContain("agent-team/review");
    expect(mutationCalls[1]?.join(" ")).toContain("allow_auto_merge=true");
    expect(mutationCalls.flat()).not.toContain("DELETE");
    expect(mutationCalls.flat()).not.toContain("PUT");
    expect(mutationCalls.join(" ")).not.toContain("allow_auto_merge=false");

    const after = await adapter.inspect(target);
    if (!after.ok) throw new Error(after.error.code);
    const callCount = transport.calls.length;
    expect(
      await adapter.provision(
        {
          target,
          expectedRevision: after.value.revision,
          requiredChecks: githubRegistrationRequiredChecks,
          enableAutoMerge: true,
        },
        { idempotencyKey: "test:idempotent" },
      ),
    ).toEqual({ ok: true, value: { changed: false } });
    expect(
      transport.calls
        .slice(callCount)
        .every((call) => !call.includes("POST") && !call.includes("PATCH")),
    ).toBe(true);
  });

  it("rejects stale CAS and insufficient permission before any mutation", async () => {
    const staleTransport = new FakeGitHubTransport();
    const staleAdapter = new GitHubRegistrationPolicyAdapter(staleTransport);
    const stale = await staleAdapter.provision(
      {
        target,
        expectedRevision: "0".repeat(64),
        requiredChecks: githubRegistrationRequiredChecks,
        enableAutoMerge: true,
      },
      { idempotencyKey: "test:stale" },
    );
    expect(stale.ok ? "ok" : stale.error.code).toBe("conflict");
    expect(
      staleTransport.calls.some((call) => call.includes("POST") || call.includes("PATCH")),
    ).toBe(false);

    const deniedTransport = new FakeGitHubTransport();
    deniedTransport.admin = false;
    const deniedAdapter = new GitHubRegistrationPolicyAdapter(deniedTransport);
    const deniedRead = await deniedAdapter.inspect(target);
    if (!deniedRead.ok) throw new Error(deniedRead.error.code);
    const denied = await deniedAdapter.provision(
      {
        target,
        expectedRevision: deniedRead.value.revision,
        requiredChecks: githubRegistrationRequiredChecks,
        enableAutoMerge: true,
      },
      { idempotencyKey: "test:permission" },
    );
    expect(denied.ok ? "ok" : denied.error.code).toBe("permission_denied");
    expect(
      deniedTransport.calls.some((call) => call.includes("POST") || call.includes("PATCH")),
    ).toBe(false);
  });

  it("reports unsupported Rulesets and a reserved-name collision without taking over", async () => {
    const unsupported = new FakeGitHubTransport();
    unsupported.listError = domainError("not_found");
    const unsupportedRead = await new GitHubRegistrationPolicyAdapter(unsupported).inspect(target);
    expect(unsupportedRead).toMatchObject({ ok: true, value: { rulesets: "unsupported" } });

    const collision = new FakeGitHubTransport();
    collision.rules = [
      {
        id: 4,
        name: githubRegistrationManagedRulesetName,
        target: "branch",
        enforcement: "disabled",
        includesDefaultBranch: true,
        excludesDefaultBranch: false,
        requiredChecks: [],
      },
    ];
    const collisionRead = await new GitHubRegistrationPolicyAdapter(collision).inspect(target);
    expect(collisionRead).toMatchObject({
      ok: true,
      value: { managedRulesetCollision: true },
    });
  });
});
