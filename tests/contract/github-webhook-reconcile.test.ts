import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { ReadOptions } from "../../src/application/ports/common.js";
import type { WebhookReadBackRequest } from "../../src/application/reconcile/webhook-model.js";
import { parseProviderRevisionIdentity } from "../../src/application/reconcile/provider-revision.js";
import {
  GitHubWebhookReadBackAdapter,
  type GitHubWebhookReadBackAdapterOptions,
} from "../../src/adapters/github/webhook-reconcile.js";
import type { GhJsonTransport } from "../../src/adapters/github/adapter.js";
import {
  domainError,
  err,
  ok,
  parseInstant,
  type DomainError,
  type Instant,
  type Result,
} from "../../src/domain/foundation/index.js";
import { projectSchema, type Project } from "../../src/domain/project/index.js";

const sha = "0123456789abcdef0123456789abcdef01234567";
const nextSha = "fedcba9876543210fedcba9876543210fedcba98";

const project: Project = projectSchema.parse({
  schemaVersion: 1,
  id: "project_12345678-1234-1234-9234-123456789abc",
  displayName: "GitHub webhook reconcile fixture",
  localRepositoryPath: "/tmp/github-webhook-reconcile-fixture",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "team", projectId: "project" },
  sourceControl: { provider: "github", repository: "owner/repository" },
});

interface ScriptStep {
  readonly assert?: (arguments_: readonly string[], options: ReadOptions | undefined) => void;
  readonly value?: unknown;
  readonly error?: DomainError["code"];
}

class ScriptedTransport implements GhJsonTransport {
  readonly calls: string[][] = [];
  #steps: ScriptStep[];

  constructor(steps: readonly ScriptStep[]) {
    this.#steps = [...steps];
  }

  requestJson<Output>(
    arguments_: readonly string[],
    schema: z.ZodType<Output>,
    options?: ReadOptions,
  ): Promise<Result<Output, DomainError>> {
    this.calls.push([...arguments_]);
    const step = this.#steps.shift();
    if (step === undefined) return Promise.resolve(err(domainError("external_failure")));
    step.assert?.(arguments_, options);
    if (step.error !== undefined) return Promise.resolve(err(domainError(step.error)));
    const parsed = schema.safeParse(step.value);
    return Promise.resolve(parsed.success ? ok(parsed.data) : err(domainError("external_failure")));
  }

  expectDone(): void {
    expect(this.#steps).toEqual([]);
  }
}

function instant(value: string): Instant {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function request(overrides: Partial<WebhookReadBackRequest> = {}): WebhookReadBackRequest {
  return {
    project,
    provider: "github",
    fromInclusive: instant("2026-08-05T10:00:00.000Z"),
    throughInclusive: instant("2026-08-05T12:00:00.000Z"),
    ...overrides,
  };
}

function pull(
  number: number,
  updatedAt: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    nodeId: `PR_kwDO_fixture_${String(number)}`,
    number,
    state: "open",
    draft: false,
    createdAt: "2026-08-05T09:00:00Z",
    updatedAt,
    closedAt: null,
    mergedAt: null,
    baseSha: sha,
    headSha: nextSha,
    ...overrides,
  };
}

function adapter(
  transport: GhJsonTransport,
  options: GitHubWebhookReadBackAdapterOptions = {},
): GitHubWebhookReadBackAdapter {
  return new GitHubWebhookReadBackAdapter(transport, options);
}

describe("GitHub webhook reconcile read-back adapter", () => {
  it("uses updated-desc pagination, includes both window boundaries, and emits a sorted revision snapshot", async () => {
    const transport = new ScriptedTransport([
      {
        assert: (arguments_) => {
          expect(arguments_[0]).toBe("api");
          expect(arguments_[1]).toBe(
            "repos/owner/repository/pulls?state=all&sort=updated&direction=desc&per_page=2&page=1",
          );
          expect(arguments_).toContain("GET");
          expect(arguments_).toContain("--jq");
        },
        value: [pull(3, "2026-08-05T12:00:00Z"), pull(2, "2026-08-05T11:00:00Z")],
      },
      {
        assert: (arguments_) => {
          expect(arguments_[1]).toBe(
            "repos/owner/repository/pulls?state=all&sort=updated&direction=desc&per_page=2&page=2",
          );
        },
        value: [pull(1, "2026-08-05T10:00:00Z"), pull(4, "2026-08-05T09:59:59Z")],
      },
    ]);

    const result = await adapter(transport, { perPage: 2, maxPages: 3 }).readChanges(request());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((change) => change.occurredAt)).toEqual([
      "2026-08-05T10:00:00.000Z",
      "2026-08-05T11:00:00.000Z",
      "2026-08-05T12:00:00.000Z",
    ]);
    expect(
      result.value.map((change) => parseProviderRevisionIdentity(change.providerEventId)),
    ).toEqual([
      expect.objectContaining({
        provider: "github",
        resourceType: "pull_request",
        resourceId: "PR_kwDO_fixture_1",
        updatedAt: "2026-08-05T10:00:00.000Z",
      }),
      expect.objectContaining({ resourceId: "PR_kwDO_fixture_2" }),
      expect.objectContaining({ resourceId: "PR_kwDO_fixture_3" }),
    ]);
    expect(result.value[0]).toMatchObject({
      eventType: "pull_request",
      streamKey: "github:repository:owner/repository:pull_request:1",
      payload: {
        authoritative: true,
        providerEventType: "pull_request",
        snapshot: {
          provider: "github",
          repository: "owner/repository",
          pullRequest: {
            nodeId: "PR_kwDO_fixture_1",
            updatedAt: "2026-08-05T10:00:00.000Z",
            baseSha: sha,
            headSha: nextSha,
          },
        },
      },
    });
    transport.expectDone();
  });

  it("filters the provider response locally with inclusive instant boundaries", async () => {
    const transport = new ScriptedTransport([
      {
        value: [
          pull(5, "2026-08-05T12:00:00.001Z"),
          pull(4, "2026-08-05T12:00:00Z"),
          pull(3, "2026-08-05T11:00:00Z"),
          pull(2, "2026-08-05T10:00:00Z"),
          pull(1, "2026-08-05T09:59:59.999Z"),
        ],
      },
    ]);

    const result = await adapter(transport, { perPage: 10 }).readChanges(request());

    expect(result.ok && result.value.map((change) => change.streamKey)).toEqual([
      "github:repository:owner/repository:pull_request:2",
      "github:repository:owner/repository:pull_request:3",
      "github:repository:owner/repository:pull_request:4",
    ]);
    transport.expectDone();
  });

  it("changes revision identity when authoritative content changes at the same timestamp", async () => {
    const first = await adapter(
      new ScriptedTransport([{ value: [pull(1, "2026-08-05T11:00:00Z")] }]),
    ).readChanges(request());
    const changed = await adapter(
      new ScriptedTransport([
        {
          value: [
            pull(1, "2026-08-05T11:00:00Z", {
              state: "closed",
              closedAt: "2026-08-05T11:00:00Z",
              headSha: sha,
            }),
          ],
        },
      ]),
    ).readChanges(request());

    expect(first.ok && changed.ok).toBe(true);
    if (!first.ok || !changed.ok) return;
    expect(first.value[0]?.providerEventId).not.toBe(changed.value[0]?.providerEventId);
    expect(first.value[0]?.payload).toMatchObject({
      providerEventId: first.value[0]?.providerEventId,
    });
    expect(changed.value[0]?.payload).toMatchObject({
      providerEventId: changed.value[0]?.providerEventId,
    });
  });

  it("fails closed for provider failures, schema drift, unsafe ordering, and an exhausted page cap", async () => {
    const providerFailure = await adapter(
      new ScriptedTransport([{ error: "unavailable" }]),
    ).readChanges(request());
    expect(providerFailure).toMatchObject({ ok: false, error: { code: "unavailable" } });

    const schemaDrift = await adapter(
      new ScriptedTransport([{ value: [{ nodeId: "PR_kwDO_fixture_1" }] }]),
    ).readChanges(request());
    expect(schemaDrift).toMatchObject({ ok: false, error: { code: "external_failure" } });

    const unsafeOrdering = await adapter(
      new ScriptedTransport([
        {
          value: [pull(1, "2026-08-05T10:00:00Z"), pull(2, "2026-08-05T11:00:00Z")],
        },
      ]),
      { perPage: 2 },
    ).readChanges(request());
    expect(unsafeOrdering).toMatchObject({ ok: false, error: { code: "external_failure" } });

    const cappedTransport = new ScriptedTransport([
      {
        value: [pull(2, "2026-08-05T11:00:00Z"), pull(1, "2026-08-05T10:00:00Z")],
      },
    ]);
    const capped = await adapter(cappedTransport, { perPage: 2, maxPages: 1 }).readChanges(
      request(),
    );
    expect(capped).toMatchObject({ ok: false, error: { code: "external_failure" } });
    cappedTransport.expectDone();
  });

  it("honors aborts and rejects a non-GitHub provider or project before calling gh", async () => {
    const controller = new AbortController();
    controller.abort();
    const interruptedTransport = new ScriptedTransport([]);
    const interrupted = await adapter(interruptedTransport).readChanges(request(), {
      signal: controller.signal,
    });
    expect(interrupted).toMatchObject({ ok: false, error: { code: "interrupted" } });
    expect(interruptedTransport.calls).toEqual([]);

    const mismatchTransport = new ScriptedTransport([]);
    const wrongProvider = await adapter(mismatchTransport).readChanges(
      request({ provider: "linear" }),
    );
    const wrongProject = await adapter(mismatchTransport).readChanges(
      request({
        project: projectSchema.parse({
          ...project,
          sourceControl: { provider: "gitlab", repository: "owner/repository" },
        }),
      }),
    );
    expect(wrongProvider).toMatchObject({ ok: false, error: { code: "invariant_violation" } });
    expect(wrongProject).toMatchObject({ ok: false, error: { code: "invariant_violation" } });
    expect(mismatchTransport.calls).toEqual([]);
  });
});
