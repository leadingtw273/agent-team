import { describe, expect, it } from "vitest";

import { CodexRunner } from "../../src/adapters/providers/codex/index.js";
import type {
  ChildProcessHandle,
  ProcessExit,
  ProcessOutputChunk,
  ProcessPort,
  ProcessSpawnRequest,
  ProviderEvent,
  ProviderRunRequest,
} from "../../src/application/ports/index.js";
import { checkpointSchema } from "../../src/domain/checkpoint/index.js";
import {
  createFixedClock,
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

class OutputQueue implements AsyncIterable<ProcessOutputChunk> {
  readonly #chunks: ProcessOutputChunk[] = [];
  readonly #waiters = new Set<() => void>();
  #closed = false;

  append(chunk: ProcessOutputChunk): void {
    this.#chunks.push(chunk);
    this.#wake();
  }

  close(): void {
    this.#closed = true;
    this.#wake();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ProcessOutputChunk> {
    let index = 0;
    for (;;) {
      const chunk = this.#chunks[index];
      if (chunk !== undefined) {
        index += 1;
        yield chunk;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => this.#waiters.add(resolve));
    }
  }

  #wake(): void {
    for (const resolve of this.#waiters) resolve();
    this.#waiters.clear();
  }
}

class FakeCodexProcess implements ChildProcessHandle {
  readonly pid = 1234;
  readonly outputQueue = new OutputQueue();
  readonly output = this.outputQueue;
  readonly writes: Record<string, unknown>[] = [];
  #sequence = 0;
  #resolveExit: ((result: Result<ProcessExit, DomainError>) => void) | undefined;
  readonly #exit = new Promise<Result<ProcessExit, DomainError>>((resolve) => {
    this.#resolveExit = resolve;
  });

  writeStdin(bytes: Uint8Array): Promise<Result<void, DomainError>> {
    const message = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;
    this.writes.push(message);
    const method = message["method"];
    const id = message["id"];
    if (typeof id === "number" && method === "initialize") this.emit({ id, result: {} });
    if (typeof id === "number" && method === "thread/start") {
      this.emit({ id, result: { thread: { id: "thread-test" } } });
    }
    if (typeof id === "number" && method === "turn/start") {
      this.emit({ id, result: { turn: { id: "turn-test" } } });
    }
    if (typeof id === "number" && method === "turn/interrupt") this.emit({ id, result: {} });
    return Promise.resolve(ok(undefined));
  }

  closeStdin(): Promise<Result<void, DomainError>> {
    this.exit(0, null);
    return Promise.resolve(ok(undefined));
  }

  wait(): Promise<Result<ProcessExit, DomainError>> {
    return this.#exit;
  }

  sendSignal(): Promise<Result<void, DomainError>> {
    this.exit(null, "SIGTERM");
    return Promise.resolve(ok(undefined));
  }

  emit(message: unknown, stream: "stdout" | "stderr" = "stdout"): void {
    this.#sequence += 1;
    this.outputQueue.append({
      sequence: this.#sequence,
      stream,
      bytes: Buffer.from(
        stream === "stdout" ? `${JSON.stringify(message)}\n` : String(message),
        "utf8",
      ),
      observedAt: instant("2026-08-04T12:01:00.000Z"),
    });
  }

  exit(exitCode: number | null, signal: "SIGTERM" | null): void {
    this.outputQueue.close();
    this.#resolveExit?.(
      ok({
        exitCode,
        signal,
        startedAt: instant("2026-08-04T12:00:00.000Z"),
        exitedAt: instant("2026-08-04T12:02:00.000Z"),
        outputTruncated: false,
      }),
    );
  }
}

class FakeProcessPort implements ProcessPort {
  readonly child = new FakeCodexProcess();
  request: ProcessSpawnRequest | undefined;

  spawn(request: ProcessSpawnRequest): Promise<Result<ChildProcessHandle, DomainError>> {
    this.request = request;
    return Promise.resolve(ok(this.child));
  }
}

function runRequest(withCheckpoint = false): ProviderRunRequest {
  const issue = issueSchema.parse({
    schemaVersion: 1,
    id: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    projectId: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    externalId: "ENG-123",
    title: "Run Codex",
    acceptanceCriteria: ["Structured Codex turn completes."],
    agentRole: "implementer",
  });
  const snapshot = createRequirementSnapshot(issue, instant("2026-08-04T12:00:00.000Z"));
  if (!snapshot.ok) throw new Error(snapshot.error.code);
  const job = jobSchema.parse({
    schemaVersion: 1,
    id: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    projectId: issue.projectId,
    issueId: issue.id,
    createdAt: "2026-08-04T12:00:01.000Z",
    watchdogExtensionGranted: false,
    attempts: { processRecoveries: 0, ciFixRounds: 0, reviewerFixRounds: 0, reviewRuns: 0 },
  });
  const checkpoint = checkpointSchema.parse({
    schemaVersion: 1,
    id: "checkpoint_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    projectId: issue.projectId,
    issueId: issue.id,
    jobId: job.id,
    createdAt: "2026-08-04T12:10:00.000Z",
    reason: "process_crash",
    completedItems: ["Context built"],
    remainingItems: ["Resume provider turn"],
    tests: [{ commandSummary: "pnpm test", status: "not_run" }],
    nextSteps: ["Resume from external checkpoint"],
    blockers: ["Provider process crashed"],
    requirementSnapshot: snapshot.value,
    model: { provider: "codex", model: "gpt-5.6-sol" },
    worktree: {
      path: "/tmp/provider-worktree",
      branch: "task/ENG-123",
      commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      pushed: false,
    },
  });
  return {
    job,
    role: "implementer",
    model: "gpt-5.6-sol",
    workingDirectory: "/tmp/provider-worktree",
    requirementSnapshot: snapshot.value,
    controllerDirective: "Implement the approved issue.",
    projectRules: ["Never merge from the provider."],
    externalData: [
      {
        kind: "text",
        source: "github-comment",
        mediaType: "text/plain",
        content: "authorization=do-not-leak",
      },
    ],
    ...(withCheckpoint ? { checkpoint } : {}),
    deadlineAt: instant("2026-08-04T12:30:00.000Z"),
  };
}

async function startedRunner(withCheckpoint = false) {
  const process = new FakeProcessPort();
  const runner = new CodexRunner({
    process,
    redactor: new Redactor({ secrets: ["do-not-leak"] }),
    clock: createFixedClock(instant("2026-08-04T12:01:00.000Z")),
    models: ["gpt-5.6-sol"],
  });
  const started = await runner.start(runRequest(withCheckpoint));
  if (!started.ok) throw new Error(started.error.code);
  return { process, runner, handle: started.value };
}

async function collectEvents(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const collected: ProviderEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("Codex app-server runner", () => {
  it("starts the pinned structured protocol with explicit sandbox and bounded context", async () => {
    const { process, runner, handle } = await startedRunner();
    const capabilities = await runner.inspectCapabilities();
    expect(capabilities).toMatchObject({
      ok: true,
      value: { provider: "codex", cliVersion: "0.146.0", supportsDynamicApproval: true },
    });
    expect(process.request).toMatchObject({
      executable: "codex",
      arguments: ["app-server", "--stdio", "--strict-config"],
      workingDirectory: "/tmp",
      keepStdinOpen: true,
    });
    const threadStart = process.child.writes.find(
      (message) => message["method"] === "thread/start",
    );
    expect(threadStart?.["params"]).toMatchObject({
      approvalPolicy: "untrusted",
      sandbox: "workspace-write",
      ephemeral: true,
    });
    const turnStart = process.child.writes.find((message) => message["method"] === "turn/start");
    const context = (turnStart?.["params"] as { input: { text: string }[] }).input[0]?.text ?? "";
    expect(context).toContain("=== BEGIN EXTERNAL DATA ===");
    expect(context).not.toContain("do-not-leak");

    process.child.emit({
      method: "item/completed",
      params: { item: { type: "agentMessage", text: "CODEX_OK" } },
    });
    process.child.emit({ method: "turn/completed", params: { turn: { status: "completed" } } });
    const [events, completion] = await Promise.all([
      collectEvents(handle.events),
      handle.completion(),
    ]);
    expect(events.map((event) => event.kind)).toEqual(["started", "output", "completed"]);
    expect(completion).toMatchObject({ ok: true, value: { outcome: "completed" } });
  });

  it("surfaces approval requests and sends only the controller decision", async () => {
    const { process, handle } = await startedRunner();
    process.child.emit({
      id: 90,
      method: "item/commandExecution/requestApproval",
      params: { command: "curl", authorization: "secret-token" },
    });
    const iterator = handle.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ kind: "started" });
    const next = await iterator.next();
    if (next.done === true) throw new Error("expected tool request");
    const tool = next.value;
    expect(tool).toMatchObject({ kind: "tool_request", requestId: "90" });
    expect(JSON.stringify(tool)).not.toContain("secret-token");
    expect(await handle.respondToToolRequest("90", "decline")).toEqual({
      ok: true,
      value: undefined,
    });
    expect(process.child.writes.at(-1)).toEqual({ id: 90, result: { decision: "decline" } });
    process.child.emit({ method: "turn/completed", params: { turn: { status: "completed" } } });
    await handle.completion();
  });

  it("uses structured interrupt and reports the interrupted outcome", async () => {
    const { process, handle } = await startedRunner();
    expect(await handle.interrupt()).toEqual({ ok: true, value: undefined });
    expect(process.child.writes.at(-1)).toMatchObject({
      method: "turn/interrupt",
      params: { threadId: "thread-test", turnId: "turn-test" },
    });
    process.child.emit({ method: "turn/completed", params: { turn: { status: "interrupted" } } });
    expect(await handle.completion()).toMatchObject({
      ok: true,
      value: { outcome: "interrupted" },
    });
  });

  it("emits the external checkpoint before a process-crash failure", async () => {
    const { process, handle } = await startedRunner(true);
    const eventsPromise = collectEvents(handle.events);
    process.child.exit(1, null);
    const [events, completion] = await Promise.all([eventsPromise, handle.completion()]);
    expect(events.map((event) => event.kind)).toEqual(["started", "checkpoint", "failed"]);
    expect(completion).toMatchObject({
      ok: true,
      value: { outcome: "failed", error: { code: "external_failure" } },
    });
  });
});
