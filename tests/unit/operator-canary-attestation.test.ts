import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FileOperatorCanaryAttestationStore,
  operatorCanaryScopeDigest,
} from "../../src/adapters/dispatch/operator-canary-attestation-store.js";
import type { DispatcherCandidate } from "../../src/application/dispatch/index.js";
import type {
  ProcessOutputChunk,
  ProcessPort,
  ProcessSpawnRequest,
} from "../../src/application/ports/index.js";
import type { ModelRoutingConfig } from "../../src/application/routing/index.js";
import {
  createFixedClock,
  ok,
  parseInstant,
  type Instant,
} from "../../src/domain/foundation/index.js";
import { issueSchema } from "../../src/domain/project/index.js";
import {
  consumeExactOperatorCanaryCandidate,
  createOperatorCanaryCliHandlers,
  operatorCanaryConfirmationPhrase,
  operatorCanaryMaximumStdinBytes,
  type OperatorCanaryPrerequisites,
} from "../../src/cli/dispatch/operator-canary-attestation.js";

const roots: string[] = [];
const projectId = "project_018f47d2-77a4-7cc1-8ef2-0123456789ab";
const externalIssueId = "b9567572-6a20-41e2-b20f-0123456789ab";
const otherExternalIssueId = "c9567572-6a20-41e2-b20f-0123456789ab";
const claudeVersion = "claude 2.1.0";
const account = "private-operator-account";
const executable = "/private/path/claude";

function instant(value: string): Instant {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const now = instant("2026-08-12T12:00:00.000Z");
const clock = createFixedClock(now);

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-team-operator-canary-unit-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function* stdin(value: string | Uint8Array): AsyncIterable<string | Uint8Array> {
  await Promise.resolve();
  yield value;
}

function message(result: Readonly<{ readonly message?: string }>): Record<string, unknown> {
  if (result.message === undefined) throw new Error("expected JSON result message");
  return JSON.parse(result.message) as Record<string, unknown>;
}

function versionProcess(
  output: Uint8Array = new TextEncoder().encode(`${claudeVersion}\n`),
): ProcessPort & { readonly requests: ProcessSpawnRequest[] } {
  const requests: ProcessSpawnRequest[] = [];
  return {
    requests,
    spawn(request) {
      requests.push(request);
      const chunk: ProcessOutputChunk = {
        sequence: 0,
        stream: "stdout",
        bytes: output,
        observedAt: now,
      };
      return Promise.resolve(
        ok({
          pid: 42,
          output: (async function* () {
            await Promise.resolve();
            yield chunk;
          })(),
          writeStdin: () => Promise.resolve(ok(undefined)),
          closeStdin: () => Promise.resolve(ok(undefined)),
          sendSignal: () => Promise.resolve(ok(undefined)),
          wait: () =>
            Promise.resolve(
              ok({
                exitCode: 0,
                signal: null,
                startedAt: now,
                exitedAt: now,
                outputTruncated: false,
              }),
            ),
        }),
      );
    },
  };
}

function prerequisites(
  store: FileOperatorCanaryAttestationStore,
  process: ProcessPort,
  loadedProjectId = projectId,
): OperatorCanaryPrerequisites {
  return {
    projectId: loadedProjectId,
    localRepositoryPath: "/tmp/operator-canary-repository",
    config: { executable, models: ["opus"], account },
    process,
    store,
  };
}

function confirmInput(extra: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    projectId,
    linearExternalIssueId: externalIssueId,
    confirmation: operatorCanaryConfirmationPhrase,
    ...extra,
  });
}

function statusInput(): string {
  return JSON.stringify({ schemaVersion: 1, projectId, linearExternalIssueId: externalIssueId });
}

function candidate(
  id: string,
  externalId: string,
  role: "implementer" | "integration_engineer" = "implementer",
  candidateProjectId = projectId,
): DispatcherCandidate {
  return {
    issue: issueSchema.parse({
      schemaVersion: 1,
      id,
      projectId: candidateProjectId,
      externalId,
      title: "Canary exact candidate",
      goal: "Verify exact candidate scoping.",
      background: "Q01 unit test.",
      acceptanceCriteria: ["one exact candidate"],
      inScope: ["tests/unit/operator-canary-attestation.test.ts"],
      outOfScope: ["provider quota policy"],
      dependencies: { kind: "none" },
      priority: "high",
      agentRole: role,
      reviewRequirement: "code_review",
      estimatedMinutes: 15,
      changeRegions: [{ path: "src", coverage: "subtree" }],
    }),
    readyAt: now,
    stage: "implementation",
    workKind: "model",
  };
}

const routingConfig: ModelRoutingConfig = {
  schemaVersion: 1,
  routes: [
    { role: "team_lead", candidates: [{ provider: "codex", model: "lead" }] },
    { role: "implementer", candidates: [{ provider: "codex", model: "gpt-5.6-terra" }] },
    { role: "code_reviewer", candidates: [{ provider: "claude", model: "opus" }] },
    { role: "visual_reviewer", candidates: [{ provider: "gemini", model: "visual" }] },
    { role: "integration_engineer", candidates: [{ provider: "codex", model: "integrate" }] },
  ],
};

describe("operator canary CLI handlers", () => {
  it.each([
    ["wrong confirmation", confirmInput({ confirmation: "wrong" })],
    ["caller supplied provider", confirmInput({ provider: "claude" })],
    ["caller supplied version", confirmInput({ claudeCliVersion: claudeVersion })],
    ["caller supplied ttl", confirmInput({ ttlMs: 900_000 })],
    ["caller supplied source", confirmInput({ source: "operator_canary" })],
    ["caller supplied account fingerprint", confirmInput({ accountFingerprint: "forbidden" })],
    ["oversized stdin", new Uint8Array(operatorCanaryMaximumStdinBytes + 1)],
  ])("rejects %s before any prerequisite, process, or store activity", async (_name, input) => {
    const root = await home();
    const store = new FileOperatorCanaryAttestationStore(root, { clock });
    const process = versionProcess();
    const load = vi.fn(() => Promise.resolve(prerequisites(store, process)));
    const handlers = createOperatorCanaryCliHandlers({
      agentTeamHome: root,
      stdin: stdin(input),
      clock,
      loadPrerequisites: load,
    });

    const result = await handlers.canaryConfirm();
    expect(result.state).toBe("rejected");
    expect(message(result)).toMatchObject({
      operation: "operator_canary_confirm",
      state: "rejected",
      reason: "invalid_confirmation_input",
    });
    expect(load).not.toHaveBeenCalled();
    expect(process.requests).toHaveLength(0);
    await expect(
      store.inspect({ projectId, linearExternalIssueId: externalIssueId }),
    ).resolves.toEqual({
      ok: true,
      value: { state: "absent" },
    });
  });

  it("writes, fsync-readbacks, and reports only digests after exact host confirmation", async () => {
    const root = await home();
    const store = new FileOperatorCanaryAttestationStore(root, { clock });
    const process = versionProcess();
    const handlers = createOperatorCanaryCliHandlers({
      agentTeamHome: root,
      stdin: stdin(confirmInput()),
      clock,
      loadPrerequisites: () => Promise.resolve(prerequisites(store, process)),
    });

    const result = await handlers.canaryConfirm();
    expect(result.state).toBe("success");
    const payload = message(result);
    expect(payload).toMatchObject({
      operation: "operator_canary_confirm",
      state: "issued",
      source: "operator_canary",
      provider: "claude",
      ttlSeconds: 900,
      expiresAt: "2026-08-12T12:15:00.000Z",
    });
    expect(payload["scopeDigest"]).toBe(
      operatorCanaryScopeDigest({ projectId, linearExternalIssueId: externalIssueId }),
    );
    for (const secret of [
      projectId,
      externalIssueId,
      operatorCanaryConfirmationPhrase,
      claudeVersion,
      account,
      executable,
    ]) {
      expect(result.message).not.toContain(secret);
    }
    expect(process.requests).toEqual([
      expect.objectContaining({ executable, arguments: ["--version"], maxOutputBytes: 4096 }),
    ]);
    await expect(
      store.inspect({ projectId, linearExternalIssueId: externalIssueId }),
    ).resolves.toMatchObject({
      ok: true,
      value: { state: "issued", attestation: { claudeCliVersion: claudeVersion } },
    });
  });

  it("status requires the same exact live version and never emits raw scope or version values", async () => {
    const root = await home();
    const store = new FileOperatorCanaryAttestationStore(root, { clock });
    const issued = await store.issue({
      projectId,
      linearExternalIssueId: externalIssueId,
      claudeCliVersion: claudeVersion,
    });
    if (!issued.ok) throw new Error(issued.error.code);
    const matching = versionProcess();
    const success = await createOperatorCanaryCliHandlers({
      agentTeamHome: root,
      stdin: stdin(statusInput()),
      clock,
      loadPrerequisites: () => Promise.resolve(prerequisites(store, matching)),
    }).canaryStatus();
    expect(success.state).toBe("success");
    expect(message(success)).toMatchObject({
      operation: "operator_canary_status",
      state: "issued",
      remainingSeconds: 900,
    });
    for (const secret of [projectId, externalIssueId, claudeVersion, account, executable]) {
      expect(success.message).not.toContain(secret);
    }

    const mismatched = versionProcess(new TextEncoder().encode("claude 2.1.1\n"));
    const failure = await createOperatorCanaryCliHandlers({
      agentTeamHome: root,
      stdin: stdin(statusInput()),
      clock,
      loadPrerequisites: () => Promise.resolve(prerequisites(store, mismatched)),
    }).canaryStatus();
    expect(failure.state).toBe("blocked");
    expect(message(failure)).toMatchObject({
      operation: "operator_canary_status",
      state: "blocked",
      reason: "attestation_unavailable",
    });
  });

  it("fails closed when a prerequisite resolves a different project", async () => {
    const root = await home();
    const store = new FileOperatorCanaryAttestationStore(root, { clock });
    const process = versionProcess();
    const result = await createOperatorCanaryCliHandlers({
      agentTeamHome: root,
      stdin: stdin(confirmInput()),
      clock,
      loadPrerequisites: () =>
        Promise.resolve(
          prerequisites(store, process, "project_018f47d2-77a4-7cc1-8ef2-9999999999ab"),
        ),
    }).canaryConfirm();
    expect(result.state).toBe("blocked");
    expect(process.requests).toHaveLength(0);
    await expect(
      store.inspect({ projectId, linearExternalIssueId: externalIssueId }),
    ).resolves.toEqual({
      ok: true,
      value: { state: "absent" },
    });
  });
});

describe("exact operator canary candidate gate", () => {
  it("does not consume a Claude execution canary after implementer routing becomes Codex-only", async () => {
    const root = await home();
    const store = new FileOperatorCanaryAttestationStore(root, { clock });
    const issued = await store.issue({
      projectId,
      linearExternalIssueId: externalIssueId,
      claudeCliVersion: claudeVersion,
    });
    if (!issued.ok) throw new Error(issued.error.code);
    const process = versionProcess();
    const exact = candidate("issue_018f47d2-77a4-7cc1-8ef2-0123456789ab", externalIssueId);
    const other = candidate("issue_018f47d2-77a4-7cc1-8ef2-9999999999ab", otherExternalIssueId);

    const result = await consumeExactOperatorCanaryCandidate({
      store,
      projectId,
      candidates: [exact, other],
      routingConfig,
      claude: {
        config: { executable, models: ["opus"], account },
        process,
        workingDirectory: "/tmp/operator-canary-repository",
      },
      clock,
    });
    expect(result).toEqual({ state: "unavailable" });
    expect(process.requests).toHaveLength(0);
    await expect(
      store.inspect({ projectId, linearExternalIssueId: externalIssueId }),
    ).resolves.toMatchObject({
      ok: true,
      value: { state: "issued" },
    });
    await expect(
      store.inspect({ projectId, linearExternalIssueId: otherExternalIssueId }),
    ).resolves.toEqual({
      ok: true,
      value: { state: "absent" },
    });
  });

  it("fails closed without a version probe when scope matching is zero or ambiguous", async () => {
    const root = await home();
    const store = new FileOperatorCanaryAttestationStore(root, { clock });
    const process = versionProcess();
    const exact = candidate("issue_018f47d2-77a4-7cc1-8ef2-0123456789ab", externalIssueId);
    const other = candidate("issue_018f47d2-77a4-7cc1-8ef2-9999999999ab", otherExternalIssueId);
    const input = {
      store,
      projectId,
      candidates: [exact, other],
      routingConfig,
      claude: {
        config: { executable, models: ["opus"], account },
        process,
        workingDirectory: "/tmp/operator-canary-repository",
      },
      clock,
    };

    await expect(consumeExactOperatorCanaryCandidate(input)).resolves.toEqual({
      state: "unavailable",
    });
    expect(process.requests).toHaveLength(0);

    const one = await store.issue({
      projectId,
      linearExternalIssueId: externalIssueId,
      claudeCliVersion: claudeVersion,
    });
    const two = await store.issue({
      projectId,
      linearExternalIssueId: otherExternalIssueId,
      claudeCliVersion: claudeVersion,
    });
    if (!one.ok || !two.ok) throw new Error("fixture attestation issue failed");
    await expect(consumeExactOperatorCanaryCandidate(input)).resolves.toEqual({
      state: "unavailable",
    });
    expect(process.requests).toHaveLength(0);
    await expect(
      store.inspect({ projectId, linearExternalIssueId: externalIssueId }),
    ).resolves.toMatchObject({
      ok: true,
      value: { state: "issued" },
    });
    await expect(
      store.inspect({ projectId, linearExternalIssueId: otherExternalIssueId }),
    ).resolves.toMatchObject({
      ok: true,
      value: { state: "issued" },
    });
  });

  it("fails closed when discovery hands the gate a candidate from a different project", async () => {
    const root = await home();
    const store = new FileOperatorCanaryAttestationStore(root, { clock });
    const issued = await store.issue({
      projectId,
      linearExternalIssueId: externalIssueId,
      claudeCliVersion: claudeVersion,
    });
    if (!issued.ok) throw new Error(issued.error.code);
    const process = versionProcess();
    const otherProjectCandidate = candidate(
      "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      externalIssueId,
      "implementer",
      "project_018f47d2-77a4-7cc1-8ef2-9999999999ab",
    );

    await expect(
      consumeExactOperatorCanaryCandidate({
        store,
        projectId,
        candidates: [otherProjectCandidate],
        routingConfig,
        claude: {
          config: { executable, models: ["opus"], account },
          process,
          workingDirectory: "/tmp/operator-canary-repository",
        },
        clock,
      }),
    ).resolves.toEqual({ state: "unavailable" });
    expect(process.requests).toHaveLength(0);
    await expect(
      store.inspect({ projectId, linearExternalIssueId: externalIssueId }),
    ).resolves.toMatchObject({ ok: true, value: { state: "issued" } });
  });
});
