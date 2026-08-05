import { describe, expect, it } from "vitest";

import {
  createGitHubRegistrationPolicy,
  type GitHubRegistrationInventory,
  type GitHubRegistrationPolicyPort,
} from "../../src/application/registration/index.js";
import { domainError, err, ok } from "../../src/domain/foundation/index.js";

const target = Object.freeze({ repository: "owner/repository", defaultBranch: "main" });
const key = Buffer.alloc(32, 7);

function inventory(
  overrides: Partial<GitHubRegistrationInventory> = {},
): GitHubRegistrationInventory {
  return Object.freeze({
    revision: "a".repeat(64),
    permission: "admin",
    rulesets: "supported",
    autoMerge: "supported",
    autoMergeEnabled: false,
    activeRequiredChecks: Object.freeze([]),
    managedRulesetCollision: false,
    ...overrides,
  });
}

function fakePort(initial: GitHubRegistrationInventory): GitHubRegistrationPolicyPort & {
  readonly calls: unknown[];
  setInventory(value: GitHubRegistrationInventory): void;
} {
  let current = initial;
  const calls: unknown[] = [];
  return {
    calls,
    setInventory: (value) => {
      current = value;
    },
    inspect: () => Promise.resolve(ok(current)),
    provision: (request, options) => {
      calls.push({ request, options });
      current = inventory({
        revision: "b".repeat(64),
        autoMergeEnabled: true,
        activeRequiredChecks: Object.freeze(["CI", "agent-team/review", "security-scan"]),
      });
      return Promise.resolve(ok(Object.freeze({ changed: true })));
    },
  };
}

describe("O004 GitHub registration policy", () => {
  it("previews additive required checks and auto-merge with a signed confirmation", async () => {
    const port = fakePort(inventory());
    const useCase = createGitHubRegistrationPolicy({ port, confirmationKey: key });

    const preview = await useCase.preview(target);

    expect(preview).toMatchObject({
      state: "ready",
      setupState: "configuration_incomplete",
      expectedRevision: "a".repeat(64),
      changes: ["ensure_required_checks", "enable_auto_merge"],
    });
    if (preview.state !== "ready") throw new Error("expected ready preview");
    expect(preview.confirmationToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(port.calls).toEqual([]);
  });

  it("applies only an exact signed preview, then requires authoritative read-back", async () => {
    const port = fakePort(inventory());
    const useCase = createGitHubRegistrationPolicy({ port, confirmationKey: key });
    const preview = await useCase.preview(target);
    if (preview.state !== "ready") throw new Error("expected ready preview");

    const applied = await useCase.apply({
      ...target,
      expectedRevision: preview.expectedRevision,
      confirmationToken: preview.confirmationToken,
    });

    expect(applied).toEqual({
      state: "configured",
      setupState: "configuration_incomplete",
      changed: true,
      gates: { github_review_status: "passed", github_auto_merge: "passed" },
    });
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]).toMatchObject({
      request: {
        target,
        expectedRevision: "a".repeat(64),
        requiredChecks: ["CI", "agent-team/review"],
        enableAutoMerge: true,
      },
    });
    expect(JSON.stringify(port.calls[0])).not.toContain(preview.confirmationToken);
  });

  it("rejects forged confirmation and CAS drift without mutation", async () => {
    const port = fakePort(inventory());
    const useCase = createGitHubRegistrationPolicy({ port, confirmationKey: key });
    const preview = await useCase.preview(target);
    if (preview.state !== "ready") throw new Error("expected ready preview");

    expect(
      await useCase.apply({
        ...target,
        expectedRevision: preview.expectedRevision,
        confirmationToken: `${preview.confirmationToken.slice(0, -1)}${preview.confirmationToken.endsWith("x") ? "y" : "x"}`,
      }),
    ).toMatchObject({ state: "blocked", reason: "confirmation_invalid" });
    port.setInventory(inventory({ revision: "c".repeat(64) }));
    expect(
      await useCase.apply({
        ...target,
        expectedRevision: preview.expectedRevision,
        confirmationToken: preview.confirmationToken,
      }),
    ).toMatchObject({ state: "blocked", reason: "inventory_changed" });
    expect(port.calls).toEqual([]);
  });

  it("fails closed for insufficient permission, unsupported APIs, and foreign name collision", async () => {
    for (const [overrides, reason] of [
      [{ permission: "read_only" as const }, "permission_required"],
      [{ rulesets: "unsupported" as const }, "rulesets_unsupported"],
      [{ autoMerge: "unsupported" as const }, "auto_merge_unsupported"],
      [{ managedRulesetCollision: true }, "managed_ruleset_collision"],
    ] as const) {
      const port = fakePort(inventory(overrides));
      expect(
        await createGitHubRegistrationPolicy({ port, confirmationKey: key }).preview(target),
      ).toMatchObject({
        state: "blocked",
        setupState: "configuration_incomplete",
        reason,
      });
      expect(port.calls).toEqual([]);
    }
  });

  it("preserves stronger existing checks and is idempotent when already configured", async () => {
    const port = fakePort(
      inventory({
        autoMergeEnabled: true,
        activeRequiredChecks: Object.freeze([
          "CI",
          "agent-team/review",
          "security-scan",
          "license-check",
        ]),
      }),
    );
    const useCase = createGitHubRegistrationPolicy({ port, confirmationKey: key });

    expect(await useCase.preview(target)).toEqual({
      state: "configured",
      setupState: "configuration_incomplete",
      changes: [],
      gates: { github_review_status: "passed", github_auto_merge: "passed" },
    });
    expect(port.calls).toEqual([]);
  });

  it("does not claim configured when mutation succeeds but read-back is incomplete", async () => {
    let reads = 0;
    const port: GitHubRegistrationPolicyPort = {
      inspect: () => {
        reads += 1;
        return Promise.resolve(
          ok(
            reads <= 2
              ? inventory()
              : inventory({ revision: "b".repeat(64), autoMergeEnabled: true }),
          ),
        );
      },
      provision: () => Promise.resolve(ok({ changed: true })),
    };
    const useCase = createGitHubRegistrationPolicy({ port, confirmationKey: key });
    const preview = await useCase.preview(target);
    if (preview.state !== "ready") throw new Error("expected ready preview");

    expect(
      await useCase.apply({
        ...target,
        expectedRevision: preview.expectedRevision,
        confirmationToken: preview.confirmationToken,
      }),
    ).toMatchObject({ state: "blocked", reason: "read_back_incomplete" });
  });

  it("maps provider failures without exposing external text", async () => {
    const port: GitHubRegistrationPolicyPort = {
      inspect: () => Promise.resolve(err(domainError("permission_denied"))),
      provision: () => Promise.resolve(err(domainError("external_failure"))),
    };
    const result = await createGitHubRegistrationPolicy({ port, confirmationKey: key }).preview(
      target,
    );
    expect(result).toEqual({
      state: "blocked",
      setupState: "configuration_incomplete",
      reason: "permission_required",
      changes: [],
    });
  });
});
