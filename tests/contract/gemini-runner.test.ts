import { describe, expect, it } from "vitest";

import { GeminiRunner } from "../../src/adapters/providers/gemini/index.js";
import type {
  ChildProcessHandle,
  ProcessExit,
  ProcessOutputChunk,
  ProcessPort,
  ProcessSpawnRequest,
  ProviderEvent,
  ProviderRunRequest,
} from "../../src/application/ports/index.js";
import {
  createFixedClock,
  domainError,
  err,
  ok,
  parseInstant,
  type DomainError,
  type Instant,
  type Result,
} from "../../src/domain/foundation/index.js";
import { jobSchema } from "../../src/domain/jobs/index.js";
import { issueSchema } from "../../src/domain/project/index.js";
import { createRequirementSnapshot } from "../../src/domain/review/index.js";
import { Redactor } from "../../src/infrastructure/redaction/index.js";

function instant(value: string): Instant {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

class FakeGeminiProcess implements ChildProcessHandle {
  readonly pid = 3456;
  readonly output: AsyncIterable<ProcessOutputChunk>;
  readonly #exit: Result<ProcessExit, DomainError>;

  constructor(payload: unknown, exitCode = 0, outputTruncated = false) {
    const bytes = Buffer.from(JSON.stringify(payload), "utf8");
    this.output = (async function* () {
      await Promise.resolve();
      yield {
        sequence: 1,
        stream: "stdout" as const,
        bytes,
        observedAt: instant("2026-08-04T12:01:00.000Z"),
      };
    })();
    this.#exit = ok({
      exitCode,
      signal: null,
      startedAt: instant("2026-08-04T12:00:00.000Z"),
      exitedAt: instant("2026-08-04T12:02:00.000Z"),
      outputTruncated,
    });
  }

  writeStdin(): Promise<Result<void, DomainError>> {
    return Promise.resolve(err(domainError("conflict")));
  }

  closeStdin(): Promise<Result<void, DomainError>> {
    return Promise.resolve(ok(undefined));
  }

  wait(): Promise<Result<ProcessExit, DomainError>> {
    return Promise.resolve(this.#exit);
  }

  sendSignal(): Promise<Result<void, DomainError>> {
    return Promise.resolve(ok(undefined));
  }
}

class FakeProcessPort implements ProcessPort {
  readonly child: FakeGeminiProcess;
  request: ProcessSpawnRequest | undefined;

  constructor(payload: unknown, exitCode = 0, outputTruncated = false) {
    this.child = new FakeGeminiProcess(payload, exitCode, outputTruncated);
  }

  spawn(request: ProcessSpawnRequest): Promise<Result<ChildProcessHandle, DomainError>> {
    this.request = request;
    return Promise.resolve(ok(this.child));
  }
}

function runRequest(
  role: ProviderRunRequest["role"] = "visual_reviewer",
  model = "auto",
): ProviderRunRequest {
  const issue = issueSchema.parse({
    schemaVersion: 1,
    id: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    projectId: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    externalId: "ART-125",
    title: "Review visual evidence",
    acceptanceCriteria: ["The image contains no clipping."],
    agentRole: role,
  });
  const snapshot = createRequirementSnapshot(issue, instant("2026-08-04T12:00:00.000Z"));
  if (!snapshot.ok) throw new Error(snapshot.error.code);
  return {
    job: jobSchema.parse({
      schemaVersion: 1,
      id: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      projectId: issue.projectId,
      issueId: issue.id,
      createdAt: "2026-08-04T12:00:01.000Z",
      watchdogExtensionGranted: false,
      attempts: { processRecoveries: 0, ciFixRounds: 0, reviewerFixRounds: 0, reviewRuns: 0 },
    }),
    role,
    model,
    workingDirectory: "/tmp/visual-review-worktree",
    requirementSnapshot: snapshot.value,
    controllerDirective: "Review the supplied visual evidence.",
    projectRules: ["Do not modify the repository."],
    externalData: [
      {
        kind: "file",
        source: "visual-manifest",
        mediaType: "image/png",
        path: "/tmp/visual-review-worktree/evidence.png",
        sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ],
    deadlineAt: instant("2026-08-04T12:30:00.000Z"),
  };
}

function successPayload(model = "gemini-3.1-pro-preview-customtools") {
  return {
    response: "No clipping found; secret=do-not-leak",
    stats: {
      models: { [model]: { tokens: {} } },
      tools: {
        byName: { read_file: { count: 1, success: 1, fail: 0 } },
      },
      files: { totalLinesAdded: 0, totalLinesRemoved: 0 },
    },
  };
}

function runner(
  process: ProcessPort,
  actualModelAllowlist: Readonly<Record<string, readonly string[]>> = {},
): GeminiRunner {
  return new GeminiRunner({
    process,
    redactor: new Redactor({ secrets: ["do-not-leak"] }),
    adminPolicyPath: "/etc/agent-team/gemini-read-only.toml",
    actualModelAllowlist,
    clock: createFixedClock(instant("2026-08-04T12:01:00.000Z")),
    models: ["auto", "gemini-pro"],
  });
}

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const collected: ProviderEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("Gemini visual-review runner", () => {
  it("uses JSON, plan mode, and an external admin policy while preserving actual model evidence", async () => {
    const process = new FakeProcessPort(successPayload());
    const started = await runner(process).start(runRequest());
    if (!started.ok) throw new Error(started.error.code);
    const [events, completion] = await Promise.all([
      collect(started.value.events),
      started.value.completion(),
    ]);

    expect(process.request?.arguments).toEqual([
      "-p",
      "Follow the Agent Team Provider Job Protocol supplied on stdin.",
      "--skip-trust",
      "--approval-mode",
      "plan",
      "--admin-policy",
      "/etc/agent-team/gemini-read-only.toml",
      "--output-format",
      "json",
      "--model",
      "auto",
    ]);
    expect(process.request?.arguments).not.toContain("--yolo");
    expect(Buffer.from(process.request?.stdin ?? []).toString("utf8")).toContain(
      "=== BEGIN EXTERNAL DATA ===",
    );
    expect(events).toEqual([
      expect.objectContaining({ kind: "started" }),
      expect.objectContaining({
        kind: "model_selected",
        requestedModel: "auto",
        actualModels: ["gemini-3.1-pro-preview-customtools"],
      }),
      expect.objectContaining({ kind: "output" }),
      expect.objectContaining({ kind: "completed" }),
    ]);
    expect(JSON.stringify(events)).not.toContain("do-not-leak");
    expect(completion).toMatchObject({ ok: true, value: { outcome: "completed" } });
  });

  it("rejects every non-visual role before spawning a process", async () => {
    const process = new FakeProcessPort(successPayload());
    const result = await runner(process).start(runRequest("implementer"));
    expect(result).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    expect(process.request).toBeUndefined();
  });

  it("requires configured actual-model evidence for an explicitly selected model", async () => {
    const actual = "gemini-3.1-pro-preview-customtools";
    const rejected = new FakeProcessPort(successPayload(actual));
    const rejectedRun = await runner(rejected).start(runRequest("visual_reviewer", "gemini-pro"));
    if (!rejectedRun.ok) throw new Error(rejectedRun.error.code);
    expect(await rejectedRun.value.completion()).toMatchObject({
      ok: true,
      value: { outcome: "failed", error: { code: "unavailable" } },
    });

    const accepted = new FakeProcessPort(successPayload(actual));
    const acceptedRun = await runner(accepted, { "gemini-pro": [actual] }).start(
      runRequest("visual_reviewer", "gemini-pro"),
    );
    if (!acceptedRun.ok) throw new Error(acceptedRun.error.code);
    expect(await acceptedRun.value.completion()).toMatchObject({
      ok: true,
      value: { outcome: "completed" },
    });
  });

  it("fails closed on tool failures, repository changes, truncation, and unavailable exits", async () => {
    const cases = [
      new FakeProcessPort({
        ...successPayload(),
        stats: {
          ...successPayload().stats,
          tools: { byName: { write_file: { count: 1, success: 0, fail: 1 } } },
        },
      }),
      new FakeProcessPort({
        ...successPayload(),
        stats: { ...successPayload().stats, files: { totalLinesAdded: 1, totalLinesRemoved: 0 } },
      }),
      new FakeProcessPort(successPayload(), 0, true),
      new FakeProcessPort({}, 1),
    ];
    for (const process of cases) {
      const started = await runner(process).start(runRequest());
      if (!started.ok) throw new Error(started.error.code);
      expect(await started.value.completion()).toMatchObject({
        ok: true,
        value: { outcome: "failed" },
      });
    }
  });

  it("reports visual-only capability without dynamic approval or resume claims", async () => {
    expect(await runner(new FakeProcessPort(successPayload())).inspectCapabilities()).toMatchObject(
      {
        ok: true,
        value: {
          provider: "gemini",
          cliVersion: "0.52.0",
          supportsResume: false,
          supportsDynamicApproval: false,
          supportsVisualInput: true,
        },
      },
    );
  });
});
