import { describe, expect, it } from "vitest";

import {
  createGitHubRegistrationPolicy,
  createInMemoryGitHubPolicyOperationStore,
  type GitHubPolicyOperationStore,
  type GitHubRegistrationInventory,
  type GitHubRegistrationPolicyPort,
} from "../../src/application/registration/index.js";
import { domainError, err, ok } from "../../src/domain/foundation/index.js";

const target = Object.freeze({
  projectId: "project-o004-a",
  repository: "owner/repository",
  defaultBranch: "main",
});
const key = Buffer.alloc(32, 7);
const authorityDigest = "7".repeat(64);

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
    managedRulesetExact: false,
    ...overrides,
  });
}

function fakePort(initial: GitHubRegistrationInventory): GitHubRegistrationPolicyPort & {
  readonly calls: Readonly<{ kind: "create" | "auto_merge"; value: unknown }>[];
  setInventory(value: GitHubRegistrationInventory): void;
} {
  let current = initial;
  const calls: Readonly<{ kind: "create" | "auto_merge"; value: unknown }>[] = [];
  return {
    calls,
    setInventory: (value) => {
      current = value;
    },
    inspect: () => Promise.resolve(ok(current)),
    createManagedRuleset: (request, options) => {
      calls.push(Object.freeze({ kind: "create", value: { request, options } }));
      current = inventory({
        revision: "b".repeat(64),
        activeRequiredChecks: Object.freeze(["CI", "agent-team/review", "security-scan"]),
        managedRulesetExact: true,
        managedRulesetId: "99",
      });
      return Promise.resolve(ok(Object.freeze({ rulesetId: "99" })));
    },
    enableAutoMerge: (request, options) => {
      calls.push(Object.freeze({ kind: "auto_merge", value: { request, options } }));
      current = Object.freeze({
        ...current,
        revision: "c".repeat(64),
        autoMergeEnabled: true,
      });
      return Promise.resolve(ok(Object.freeze({ changed: true })));
    },
  };
}

function policy(
  port: GitHubRegistrationPolicyPort,
  operationStore: GitHubPolicyOperationStore = createInMemoryGitHubPolicyOperationStore(),
) {
  return createGitHubRegistrationPolicy({
    port,
    operationStore,
    confirmationKey: key,
    confirmationContext: Object.freeze({ authorityDigest }),
  });
}

async function readyCommand(useCase: ReturnType<typeof policy>) {
  const preview = await useCase.preview(target);
  if (preview.state !== "ready") throw new Error("expected ready preview");
  return Object.freeze({
    ...target,
    operation: "apply_github_policy" as const,
    confirmationText: "套用 GitHub 合併保護" as const,
    expectedRevision: preview.expectedRevision,
    confirmationToken: preview.confirmationToken,
  });
}

describe("O004 GitHub registration policy", () => {
  it("binds confirmations to the server project even for the same session and repository", async () => {
    const port = fakePort(inventory());
    const useCase = policy(port);
    const otherTarget = Object.freeze({ ...target, projectId: "project-o004-b" });
    const first = await useCase.preview(target);
    const second = await useCase.preview(otherTarget);
    if (first.state !== "ready" || second.state !== "ready") {
      throw new Error("expected ready previews");
    }

    expect(first.confirmationToken).not.toBe(second.confirmationToken);
    expect(
      await useCase.apply({
        ...otherTarget,
        operation: "apply_github_policy",
        confirmationText: "套用 GitHub 合併保護",
        expectedRevision: first.expectedRevision,
        confirmationToken: first.confirmationToken,
      }),
    ).toMatchObject({ state: "blocked", reason: "inventory_changed" });
    expect(port.calls).toEqual([]);
  });

  it("allows only one POST across concurrent use-case instances sharing one operation store", async () => {
    const port = fakePort(inventory());
    const operationStore = createInMemoryGitHubPolicyOperationStore();
    const first = policy(port, operationStore);
    const second = policy(port, operationStore);
    const command = await readyCommand(first);

    await Promise.all([first.apply(command), second.apply(command)]);

    expect(port.calls.filter((call) => call.kind === "create")).toHaveLength(1);
  });

  it("does not issue a second POST after an unknown outcome and process restart", async () => {
    const operationStore = createInMemoryGitHubPolicyOperationStore();
    let postCount = 0;
    const port: GitHubRegistrationPolicyPort = {
      inspect: () => Promise.resolve(ok(inventory())),
      createManagedRuleset: () => {
        postCount += 1;
        return Promise.resolve(err(domainError("external_failure")));
      },
      enableAutoMerge: () => Promise.resolve(ok({ changed: true })),
    };
    const first = policy(port, operationStore);
    const command = await readyCommand(first);
    expect(await first.apply(command)).toMatchObject({
      state: "blocked",
      reason: "operation_recovery_required",
    });

    const restarted = policy(port, operationStore);
    expect(await restarted.apply(command)).toMatchObject({
      state: "blocked",
      reason: "operation_recovery_required",
    });
    expect(postCount).toBe(1);
  });

  it("previews the complete desired policy with a signed confirmation", async () => {
    const port = fakePort(inventory());
    const preview = await policy(port).preview(target);

    expect(preview).toMatchObject({
      state: "ready",
      setupState: "configuration_incomplete",
      expectedRevision: "a".repeat(64),
      changes: ["ensure_required_checks", "enable_auto_merge"],
    });
    if (preview.state !== "ready") throw new Error("expected ready preview");
    expect(preview.confirmationToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u);
    const encoded = preview.confirmationToken.split(".")[0];
    if (encoded === undefined) throw new Error("confirmation payload missing");
    const decoded: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    expect(decoded).toMatchObject({
      authorityDigest,
      operation: "apply_github_policy",
      projectId: target.projectId,
      repository: target.repository,
      defaultBranch: target.defaultBranch,
      desiredPolicy: {
        ruleset: {
          target: "branch",
          enforcement: "active",
          conditions: {
            include: ["~DEFAULT_BRANCH"],
            exclude: ["refs/heads/__agent_team_never__"],
          },
          bypassActors: [],
          requiredStatusChecks: {
            contexts: ["CI", "agent-team/review"],
            strictRequiredStatusChecksPolicy: true,
            doNotEnforceOnCreate: false,
          },
        },
        autoMerge: true,
      },
      inventoryRevision: "a".repeat(64),
      storeRevision: 0,
    });
    if (typeof decoded !== "object" || decoded === null || !("bindingRevision" in decoded)) {
      throw new Error("confirmation binding revision missing");
    }
    expect(decoded.bindingRevision).toMatch(/^[a-f0-9]{64}$/u);
    expect(port.calls).toEqual([]);
  });

  it("journals additive creation and auto-merge before exact authoritative read-back", async () => {
    const port = fakePort(inventory());
    const useCase = policy(port);

    const applied = await useCase.apply(await readyCommand(useCase));

    expect(applied).toEqual({
      state: "configured",
      setupState: "configuration_incomplete",
      changed: true,
      gates: { github_review_status: "passed", github_auto_merge: "passed" },
    });
    expect(port.calls.map((call) => call.kind)).toEqual(["create", "auto_merge"]);
    expect(port.calls[0]).toMatchObject({
      value: {
        request: {
          target,
          expectedRevision: "a".repeat(64),
          desiredPolicy: {
            target: "branch",
            enforcement: "active",
            requiredStatusChecks: {
              contexts: ["CI", "agent-team/review"],
              strictRequiredStatusChecksPolicy: true,
              doNotEnforceOnCreate: false,
            },
          },
        },
      },
    });
  });

  it("rejects forged confirmation and inventory drift without mutation", async () => {
    const port = fakePort(inventory());
    const useCase = policy(port);
    const command = await readyCommand(useCase);

    expect(
      await useCase.apply({
        ...command,
        confirmationToken: `${command.confirmationToken.slice(0, -1)}${command.confirmationToken.endsWith("x") ? "y" : "x"}`,
      }),
    ).toMatchObject({ state: "blocked", reason: "confirmation_invalid" });
    port.setInventory(inventory({ revision: "d".repeat(64) }));
    expect(await useCase.apply(command)).toMatchObject({
      state: "blocked",
      reason: "inventory_changed",
    });
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
      expect(await policy(port).preview(target)).toMatchObject({
        state: "blocked",
        setupState: "configuration_incomplete",
        reason,
      });
      expect(port.calls).toEqual([]);
    }
  });

  it("preserves stronger foreign checks but requires one exact managed Ruleset", async () => {
    const stronger = inventory({
      autoMergeEnabled: true,
      activeRequiredChecks: Object.freeze([
        "CI",
        "agent-team/review",
        "security-scan",
        "license-check",
      ]),
    });
    expect(await policy(fakePort(stronger)).preview(target)).toMatchObject({
      state: "ready",
      changes: ["ensure_required_checks"],
    });

    const exact = inventory({
      ...stronger,
      managedRulesetExact: true,
      managedRulesetId: "44",
    });
    expect(await policy(fakePort(exact)).preview(target)).toEqual({
      state: "configured",
      setupState: "configuration_incomplete",
      changes: [],
      gates: { github_review_status: "passed", github_auto_merge: "passed" },
    });
  });

  it("does not claim configured when post-read drifts or is incomplete", async () => {
    let reads = 0;
    const port: GitHubRegistrationPolicyPort = {
      inspect: () => {
        reads += 1;
        return Promise.resolve(
          ok(
            reads <= 3
              ? inventory()
              : inventory({
                  revision: "b".repeat(64),
                  managedRulesetExact: true,
                  managedRulesetId: "different-id",
                  autoMergeEnabled: true,
                }),
          ),
        );
      },
      createManagedRuleset: () => Promise.resolve(ok({ rulesetId: "99" })),
      enableAutoMerge: () => Promise.resolve(ok({ changed: true })),
    };
    const useCase = policy(port);
    expect(await useCase.apply(await readyCommand(useCase))).toMatchObject({
      state: "blocked",
      reason: "read_back_incomplete",
    });
  });

  it("does not report success when completion CAS loses a post-read race", async () => {
    const delegate = createInMemoryGitHubPolicyOperationStore();
    const conflictingStore: GitHubPolicyOperationStore = {
      read: (operationId) => delegate.read(operationId),
      compareAndSwap: (change) =>
        change.next.phase === "completed"
          ? Promise.resolve(err(domainError("conflict")))
          : delegate.compareAndSwap(change),
    };
    const port = fakePort(inventory());
    const useCase = policy(port, conflictingStore);

    expect(await useCase.apply(await readyCommand(useCase))).toMatchObject({
      state: "blocked",
      reason: "inventory_changed",
    });
  });

  it("reconciles an unknown auto-merge response from read-back without another mutation", async () => {
    const operationStore = createInMemoryGitHubPolicyOperationStore();
    let current = inventory();
    let postCount = 0;
    let patchCount = 0;
    const port: GitHubRegistrationPolicyPort = {
      inspect: () => Promise.resolve(ok(current)),
      createManagedRuleset: () => {
        postCount += 1;
        current = inventory({
          revision: "b".repeat(64),
          managedRulesetExact: true,
          managedRulesetId: "99",
        });
        return Promise.resolve(ok({ rulesetId: "99" }));
      },
      enableAutoMerge: () => {
        patchCount += 1;
        current = Object.freeze({
          ...current,
          revision: "c".repeat(64),
          autoMergeEnabled: true,
        });
        return Promise.resolve(err(domainError("timeout")));
      },
    };
    const first = policy(port, operationStore);
    expect(await first.apply(await readyCommand(first))).toMatchObject({
      state: "blocked",
      reason: "mutation_outcome_unknown",
    });

    const restarted = policy(port, operationStore);
    const retry = await restarted.preview(target);
    expect(retry).toMatchObject({ state: "ready", changes: [] });
    if (retry.state !== "ready") throw new Error("expected verification retry");
    expect(
      await restarted.apply({
        ...target,
        operation: "apply_github_policy",
        confirmationText: "套用 GitHub 合併保護",
        expectedRevision: retry.expectedRevision,
        confirmationToken: retry.confirmationToken,
      }),
    ).toMatchObject({ state: "configured", changed: true });
    expect(postCount).toBe(1);
    expect(patchCount).toBe(1);
  });

  it("never repeats auto-merge after an attempted PATCH remains false across restart", async () => {
    const operationStore = createInMemoryGitHubPolicyOperationStore();
    let current = inventory();
    let patchCount = 0;
    const port: GitHubRegistrationPolicyPort = {
      inspect: () => Promise.resolve(ok(current)),
      createManagedRuleset: () => {
        current = inventory({
          revision: "b".repeat(64),
          managedRulesetExact: true,
          managedRulesetId: "99",
        });
        return Promise.resolve(ok({ rulesetId: "99" }));
      },
      enableAutoMerge: () => {
        patchCount += 1;
        return Promise.resolve(err(domainError("timeout")));
      },
    };
    const first = policy(port, operationStore);
    const command = await readyCommand(first);
    expect(await first.apply(command)).toMatchObject({
      state: "blocked",
      reason: "mutation_outcome_unknown",
    });

    const restarted = policy(port, operationStore);
    expect(await restarted.preview(target)).toMatchObject({
      state: "blocked",
      reason: "mutation_outcome_unknown",
    });
    expect(await restarted.apply(command)).toMatchObject({
      state: "blocked",
      reason: "mutation_outcome_unknown",
    });
    expect(patchCount).toBe(1);
  });

  it("never enters provider mutation after a journal publication has an unknown outcome", async () => {
    const delegate = createInMemoryGitHubPolicyOperationStore();
    const unknownPublication: GitHubPolicyOperationStore = {
      read: (operationId) => delegate.read(operationId),
      compareAndSwap: async (change) => {
        const stored = await delegate.compareAndSwap(change);
        return change.next.phase === "reserved" && stored.ok
          ? err(domainError("external_failure"))
          : stored;
      },
    };
    const port = fakePort(inventory());
    const useCase = policy(port, unknownPublication);

    expect(await useCase.apply(await readyCommand(useCase))).toMatchObject({
      state: "blocked",
      reason: "inventory_changed",
    });
    expect(port.calls).toEqual([]);
  });

  it("maps provider failures without exposing external text", async () => {
    const port: GitHubRegistrationPolicyPort = {
      inspect: () => Promise.resolve(err(domainError("permission_denied"))),
      createManagedRuleset: () => Promise.resolve(err(domainError("external_failure"))),
      enableAutoMerge: () => Promise.resolve(err(domainError("external_failure"))),
    };
    expect(await policy(port).preview(target)).toEqual({
      state: "blocked",
      setupState: "configuration_incomplete",
      reason: "permission_required",
      changes: [],
    });
  });
});
