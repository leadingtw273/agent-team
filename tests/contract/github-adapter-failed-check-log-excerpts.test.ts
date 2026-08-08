/**
 * C017: `GitHubAdapter.getFailedCheckLogExcerpts` -- the adapter-only capability (never added to
 * the shared `SourceControlPort`, same precedent as `getRepositoryMetadata`/
 * `squashMergeChangeRequest`) that CI-recovery uses to stop flying blind on *why* a check failed.
 * Mirrors github-adapter.test.ts's own `ScriptedTransport` convention, extended with a scripted
 * `requestText` for the plain-text `.../actions/jobs/{id}/logs` endpoint `requestJson` cannot
 * parse as JSON.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  GitHubAdapter,
  type GhJsonTransport,
  type GhTextTransport,
} from "../../src/adapters/github/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../src/domain/foundation/index.js";
import { projectSchema, type Project } from "../../src/domain/project/index.js";

const sha = "0123456789abcdef0123456789abcdef01234567";

const project: Project = projectSchema.parse({
  schemaVersion: 1,
  id: "project_12345678-1234-1234-9234-123456789abc",
  displayName: "Fixture",
  localRepositoryPath: "/tmp/fixture",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "team", projectId: "project" },
  sourceControl: { provider: "github", repository: "owner/repository" },
});

interface JsonStep {
  readonly value?: unknown;
  readonly error?: DomainError["code"];
}

interface TextStep {
  readonly value?: string;
  readonly error?: DomainError["code"];
}

class ScriptedTransport implements GhJsonTransport, GhTextTransport {
  readonly jsonCalls: string[][] = [];
  readonly textCalls: string[][] = [];
  #jsonSteps: JsonStep[];
  #textSteps: TextStep[];

  constructor(jsonSteps: readonly JsonStep[], textSteps: readonly TextStep[] = []) {
    this.#jsonSteps = [...jsonSteps];
    this.#textSteps = [...textSteps];
  }

  requestJson<Output>(
    arguments_: readonly string[],
    schema: z.ZodType<Output>,
  ): Promise<Result<Output, DomainError>> {
    this.jsonCalls.push([...arguments_]);
    const step = this.#jsonSteps.shift();
    if (step === undefined) return Promise.resolve(err(domainError("external_failure")));
    if (step.error !== undefined) return Promise.resolve(err(domainError(step.error)));
    const parsed = schema.safeParse(step.value);
    return Promise.resolve(parsed.success ? ok(parsed.data) : err(domainError("external_failure")));
  }

  requestText(arguments_: readonly string[]): Promise<Result<string, DomainError>> {
    this.textCalls.push([...arguments_]);
    const step = this.#textSteps.shift();
    if (step === undefined) return Promise.resolve(err(domainError("external_failure")));
    if (step.error !== undefined) return Promise.resolve(err(domainError(step.error)));
    return Promise.resolve(ok(step.value ?? ""));
  }
}

/** A transport that satisfies `GhJsonTransport` but genuinely has no `requestText` at all --
 * the shape every pre-C017 test double across the rest of this codebase already is. */
class JsonOnlyTransport implements GhJsonTransport {
  readonly calls: string[][] = [];

  requestJson<Output>(
    arguments_: readonly string[],
    schema: z.ZodType<Output>,
  ): Promise<Result<Output, DomainError>> {
    this.calls.push([...arguments_]);
    const parsed = schema.safeParse({ totalCount: 0, checks: [] });
    return Promise.resolve(parsed.success ? ok(parsed.data) : err(domainError("external_failure")));
  }
}

function checkRunPage(
  checks: readonly Readonly<{
    id: number;
    name: string;
    status: "queued" | "in_progress" | "completed";
    conclusion: "success" | "failure" | "cancelled" | "skipped" | null;
  }>[],
): Readonly<Record<string, unknown>> {
  return { totalCount: checks.length, checks };
}

describe("GitHubAdapter.getFailedCheckLogExcerpts", () => {
  it("fetches a log excerpt only for the failing check run, skipping the successful one", async () => {
    const transport = new ScriptedTransport(
      [
        {
          value: checkRunPage([
            { id: 1, name: "build", status: "completed", conclusion: "success" },
            { id: 2, name: "test", status: "completed", conclusion: "failure" },
          ]),
        },
      ],
      [{ value: "2026-08-08T00:00:00.0000000Z error: assertion failed at line 12\n" }],
    );
    const adapter = new GitHubAdapter(transport);

    const result = await adapter.getFailedCheckLogExcerpts({ project }, sha);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ available: true });
    if (!result.value.available) return;
    expect(result.value.excerpts).toHaveLength(1);
    expect(result.value.excerpts[0]).toMatchObject({ checkName: "test", truncated: false });
    expect(result.value.excerpts[0]?.text).toContain("assertion failed at line 12");
    expect(
      transport.textCalls[0]?.some((argument) => argument.includes("actions/jobs/2/logs")),
    ).toBe(true);
  });

  it("reports unavailable, without any log fetch, when every check run passed or was skipped", async () => {
    const transport = new ScriptedTransport([
      {
        value: checkRunPage([
          { id: 1, name: "build", status: "completed", conclusion: "success" },
          { id: 2, name: "docs", status: "completed", conclusion: "skipped" },
        ]),
      },
    ]);
    const adapter = new GitHubAdapter(transport);

    const result = await adapter.getFailedCheckLogExcerpts({ project }, sha);

    expect(result).toEqual({ ok: true, value: { available: false, reason: "no_failing_checks" } });
    expect(transport.textCalls).toEqual([]);
  });

  it("reports unavailable, and still succeeds as a read, when the log endpoint itself errors", async () => {
    const transport = new ScriptedTransport(
      [
        {
          value: checkRunPage([
            { id: 9, name: "test", status: "completed", conclusion: "failure" },
          ]),
        },
      ],
      [{ error: "not_found" }],
    );
    const adapter = new GitHubAdapter(transport);

    const result = await adapter.getFailedCheckLogExcerpts({ project }, sha);

    expect(result).toEqual({ ok: true, value: { available: false, reason: "log_fetch_failed" } });
  });

  it("reports unavailable without attempting any check-run fetch when the transport cannot fetch text at all", async () => {
    const transport = new JsonOnlyTransport();
    const adapter = new GitHubAdapter(transport);

    const result = await adapter.getFailedCheckLogExcerpts({ project }, sha);

    expect(result).toEqual({
      ok: true,
      value: { available: false, reason: "log_transport_unavailable" },
    });
    expect(transport.calls).toEqual([]);
  });

  it("inspects at most a small, bounded number of failing check runs even when many fail at once", async () => {
    const failing = Array.from({ length: 6 }, (_, index) => ({
      id: index + 1,
      name: `job-${String(index)}`,
      status: "completed" as const,
      conclusion: "failure" as const,
    }));
    const transport = new ScriptedTransport(
      [{ value: checkRunPage(failing) }],
      failing.map(() => ({ value: "error: boom\n" })),
    );
    const adapter = new GitHubAdapter(transport);

    const result = await adapter.getFailedCheckLogExcerpts({ project }, sha);

    expect(result.ok).toBe(true);
    expect(transport.textCalls.length).toBeLessThan(failing.length);
    expect(transport.textCalls.length).toBeGreaterThan(0);
  });

  it("rejects an invalid head SHA before making any call, like every other read on this adapter", async () => {
    const transport = new ScriptedTransport([]);
    const adapter = new GitHubAdapter(transport);

    const result = await adapter.getFailedCheckLogExcerpts({ project }, "not-a-sha");

    expect(result.ok ? "ok" : result.error.code).toBe("external_failure");
    expect(transport.jsonCalls).toEqual([]);
  });
});
