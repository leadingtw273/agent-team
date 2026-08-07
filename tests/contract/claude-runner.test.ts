import { describe, expect, it } from "vitest";

import { ClaudeRunner } from "../../src/adapters/providers/claude/index.js";
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
  err,
  ok,
  parseInstant,
  type DomainError,
  type Instant,
  type Result,
} from "../../src/domain/foundation/index.js";
import { jobSchema } from "../../src/domain/jobs/index.js";
import { agentRoleSchema, issueSchema } from "../../src/domain/project/index.js";
import { createRequirementSnapshot } from "../../src/domain/review/index.js";
import { Redactor } from "../../src/infrastructure/redaction/index.js";

function instant(value: string): Instant {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function chunk(sequence: number, event: unknown): ProcessOutputChunk {
  return {
    sequence,
    stream: "stdout",
    bytes: Buffer.from(`${JSON.stringify(event)}\n`, "utf8"),
    observedAt: instant("2026-08-04T12:01:00.000Z"),
  };
}

class FakeClaudeProcess implements ChildProcessHandle {
  readonly pid = 2345;
  readonly output: AsyncIterable<ProcessOutputChunk>;
  readonly #exit: Result<ProcessExit, DomainError>;
  signal: string | undefined;

  constructor(events: readonly unknown[], exitCode = 0) {
    const chunks = events.map((event, index) => chunk(index + 1, event));
    this.output = (async function* () {
      await Promise.resolve();
      yield* chunks;
    })();
    this.#exit = ok({
      exitCode,
      signal: null,
      startedAt: instant("2026-08-04T12:00:00.000Z"),
      exitedAt: instant("2026-08-04T12:02:00.000Z"),
      outputTruncated: false,
    });
  }

  writeStdin(): Promise<Result<void, DomainError>> {
    return Promise.resolve(
      err({
        kind: "domain_error",
        code: "conflict",
        category: "state",
        message: "The requested change conflicts with current state.",
        retryable: false,
      }),
    );
  }

  closeStdin(): Promise<Result<void, DomainError>> {
    return Promise.resolve(ok(undefined));
  }

  wait(): Promise<Result<ProcessExit, DomainError>> {
    return Promise.resolve(this.#exit);
  }

  sendSignal(signal: string): Promise<Result<void, DomainError>> {
    this.signal = signal;
    return Promise.resolve(ok(undefined));
  }
}

/** C015f: takes already-serialized raw lines (never `JSON.stringify`s them) -- unlike `chunk()`
 * above, so a fixture can carry text that has already been through `Redactor.redactText` (i.e.
 * exactly what `ChildProcessRunner.appendText`, src/adapters/process/runner.ts, would have handed
 * `ClaudeRunner` from a real child process's stdout). */
function rawLineChunk(sequence: number, line: string): ProcessOutputChunk {
  return {
    sequence,
    stream: "stdout",
    bytes: Buffer.from(`${line}\n`, "utf8"),
    observedAt: instant("2026-08-04T12:01:00.000Z"),
  };
}

class FakeClaudeProcessFromRawLines implements ChildProcessHandle {
  readonly pid = 2346;
  readonly output: AsyncIterable<ProcessOutputChunk>;
  readonly #exit: Result<ProcessExit, DomainError>;

  constructor(lines: readonly string[]) {
    const chunks = lines.map((line, index) => rawLineChunk(index + 1, line));
    this.output = (async function* () {
      await Promise.resolve();
      yield* chunks;
    })();
    this.#exit = ok({
      exitCode: 0,
      signal: null,
      startedAt: instant("2026-08-04T12:00:00.000Z"),
      exitedAt: instant("2026-08-04T12:02:00.000Z"),
      outputTruncated: false,
    });
  }

  writeStdin(): Promise<Result<void, DomainError>> {
    return Promise.resolve(ok(undefined));
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

class FakeProcessPortFromRawLines implements ProcessPort {
  readonly child: FakeClaudeProcessFromRawLines;
  request: ProcessSpawnRequest | undefined;

  constructor(lines: readonly string[]) {
    this.child = new FakeClaudeProcessFromRawLines(lines);
  }

  spawn(request: ProcessSpawnRequest): Promise<Result<ChildProcessHandle, DomainError>> {
    this.request = request;
    return Promise.resolve(ok(this.child));
  }
}

class FakeProcessPort implements ProcessPort {
  readonly child: FakeClaudeProcess;
  request: ProcessSpawnRequest | undefined;

  constructor(events: readonly unknown[], exitCode = 0) {
    this.child = new FakeClaudeProcess(events, exitCode);
  }

  spawn(request: ProcessSpawnRequest): Promise<Result<ChildProcessHandle, DomainError>> {
    this.request = request;
    return Promise.resolve(ok(this.child));
  }
}

function runRequest(role: ProviderRunRequest["role"], withCheckpoint = false): ProviderRunRequest {
  const issue = issueSchema.parse({
    schemaVersion: 1,
    id: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    projectId: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    externalId: "ENG-124",
    title: "Run Claude",
    acceptanceCriteria: ["Claude result is structurally verified."],
    agentRole: role,
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
    reason: "safety_pause",
    completedItems: ["Context built"],
    remainingItems: ["Resume after approval"],
    tests: [{ commandSummary: "pnpm test", status: "not_run" }],
    nextSteps: ["Resume with narrowed permissions"],
    blockers: ["Permission denied"],
    requirementSnapshot: snapshot.value,
    model: { provider: "claude", model: "opus" },
    worktree: {
      path: "/tmp/provider-worktree",
      branch: "task/ENG-124",
      commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      pushed: false,
    },
  });
  return {
    job,
    role,
    model: "opus",
    workingDirectory: "/tmp/provider-worktree",
    requirementSnapshot: snapshot.value,
    controllerDirective: "Review the approved issue.",
    projectRules: ["Do not merge."],
    externalData: [
      {
        kind: "text",
        source: "linear-comment",
        mediaType: "text/plain",
        content: "authorization=do-not-leak",
      },
    ],
    ...(withCheckpoint ? { checkpoint } : {}),
    deadlineAt: instant("2026-08-04T12:30:00.000Z"),
  };
}

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const collected: ProviderEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function runner(process: ProcessPort): ClaudeRunner {
  return new ClaudeRunner({
    process,
    redactor: new Redactor({ secrets: ["do-not-leak", "secret-token"] }),
    clock: createFixedClock(instant("2026-08-04T12:01:00.000Z")),
    models: ["opus"],
  });
}

describe("Claude stream-json runner", () => {
  it("runs reviewers in safe mode with only Read and requires a valid result event", async () => {
    const process = new FakeProcessPort([
      { type: "system", session_id: "private-session" },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Reviewed safely" }] },
      },
      {
        type: "result",
        is_error: false,
        result: "CLAUDE_REVIEW_OK",
        permission_denials: [],
      },
    ]);
    const started = await runner(process).start(runRequest("code_reviewer"));
    if (!started.ok) throw new Error(started.error.code);
    const [events, completion] = await Promise.all([
      collect(started.value.events),
      started.value.completion(),
    ]);

    expect(process.request?.arguments).toEqual([
      "-p",
      "--safe-mode",
      "--verbose",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "dontAsk",
      "--tools",
      "Read",
      "--allowedTools",
      "Read(./*)",
      "Read(./**)",
      "--no-session-persistence",
      "--model",
      "opus",
    ]);
    const stdin = Buffer.from(process.request?.stdin ?? []).toString("utf8");
    expect(stdin).toContain("=== BEGIN EXTERNAL DATA ===");
    expect(stdin).not.toContain("do-not-leak");
    expect(events.map((event) => event.kind)).toEqual(["started", "output", "output", "completed"]);
    expect(completion).toMatchObject({ ok: true, value: { outcome: "completed" } });
  });

  it("classifies permission denial before exit zero and is_error false", async () => {
    const process = new FakeProcessPort([
      { type: "assistant", message: { content: [{ type: "text", text: "Attempted tool" }] } },
      {
        type: "result",
        is_error: false,
        result: "looks successful",
        permission_denials: [{ tool_name: "Bash", authorization: "secret-token" }],
      },
    ]);
    const started = await runner(process).start(runRequest("implementer", true));
    if (!started.ok) throw new Error(started.error.code);
    const [events, completion] = await Promise.all([
      collect(started.value.events),
      started.value.completion(),
    ]);

    // C015h-1: implementer's `--tools` never includes Bash (see toolsForRole's own header for
    // why); the tool list is exactly "Read,Write,Edit".
    expect(process.request?.arguments).toContain("Read,Write,Edit");
    expect(process.request?.arguments).not.toContain("Read,Write,Edit,Bash");
    expect(events.map((event) => event.kind)).toEqual([
      "started",
      "output",
      "tool_request",
      "checkpoint",
    ]);
    expect(JSON.stringify(events)).not.toContain("secret-token");
    expect(completion).toMatchObject({ ok: true, value: { outcome: "interrupted" } });
    expect(await started.value.respondToToolRequest("claude-denial-1", "approve")).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
  });

  it("fails closed on unknown events, missing results, and process failure", async () => {
    for (const process of [
      new FakeProcessPort([{ type: "future_event" }]),
      new FakeProcessPort([{ type: "assistant", message: { content: [] } }]),
      new FakeProcessPort(
        [{ type: "result", is_error: false, result: "not enough", permission_denials: [] }],
        1,
      ),
    ]) {
      const started = await runner(process).start(runRequest("implementer", true));
      if (!started.ok) throw new Error(started.error.code);
      const [events, completion] = await Promise.all([
        collect(started.value.events),
        started.value.completion(),
      ]);
      expect(events.map((event) => event.kind)).toContain("checkpoint");
      expect(completion).toMatchObject({
        ok: true,
        value: { outcome: "failed", error: { code: "external_failure" } },
      });
    }
  });

  it("reports capabilities honestly without claiming dynamic approval or persisted resume", async () => {
    const capabilities = await runner(new FakeProcessPort([])).inspectCapabilities();
    expect(capabilities).toMatchObject({
      ok: true,
      value: {
        provider: "claude",
        cliVersion: "2.1.221",
        supportsResume: false,
        supportsDynamicApproval: false,
        supportsStructuredEvents: true,
      },
    });
  });

  /**
   * C015f: real Claude Code `stream-json` output carries a `signature` field on every
   * "thinking" content block (a real Anthropic API integrity value, not a secret). This field
   * only ever reaches `ClaudeRunner` *after* `ChildProcessRunner.appendText`
   * (src/adapters/process/runner.ts) has already run the raw stdout text through
   * `Redactor.redactText` -- so this test builds the fixture the same way: serialize a realistic
   * "thinking" event to a raw line, run it through the *real* `Redactor` class (the same one
   * production wires up), and feed the resulting (post-redaction) line to `ClaudeRunner` via a
   * fake process whose chunks are never re-serialized. Before C015f's fix, this line's `signature`
   * value came back unquoted (`"signature":[REDACTED]`), which is not valid JSON --
   * `ClaudeRunner`'s own `JSON.parse` (runner.ts) would throw, `invalidStream` would be set, and
   * the run would fail with `external_failure` even though every other line (including the final
   * `result` event asserted below) was perfectly valid. This is the exact bug path E101's third
   * live run hit.
   */
  it("does not invalidate the stream on a redacted thinking-block signature line (C015f real bug path)", async () => {
    const rawThinkingLine = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "thinking",
            thinking: "",
            signature: "abcXYZ123-real-looking-base64-signature-value==",
          },
        ],
      },
    });
    // The exact redaction step `ChildProcessRunner.appendText` applies to every raw stdout chunk
    // before `ClaudeRunner` ever sees it -- using the real `Redactor` class, not a stand-in.
    const redactedThinkingLine = new Redactor().redactText(rawThinkingLine);
    // Sanity-check the fixture is genuinely exercising the redaction path, not accidentally
    // leaving the line untouched (which would make this test pass for the wrong reason).
    expect(redactedThinkingLine).not.toBe(rawThinkingLine);
    expect(redactedThinkingLine).toContain("[REDACTED]");

    const process = new FakeProcessPortFromRawLines([
      redactedThinkingLine,
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Done thinking, here is the result." }] },
      }),
      JSON.stringify({
        type: "result",
        is_error: false,
        result: "CLAUDE_RUN_OK",
        permission_denials: [],
      }),
    ]);

    const started = await runner(process).start(runRequest("implementer"));
    if (!started.ok) throw new Error(started.error.code);
    const [events, completion] = await Promise.all([
      collect(started.value.events),
      started.value.completion(),
    ]);

    expect(events.map((event) => event.kind)).not.toContain("failed");
    expect(completion).toMatchObject({ ok: true, value: { outcome: "completed" } });
  });

  /**
   * C015h-1 (security-critical): pins the exact `--tools`/`--allowedTools` argument shape this
   * ticket exists to get right. See `toolsForRole`/`allowedToolsForRole`'s own header comments
   * (src/adapters/providers/claude/runner.ts) for the full rationale -- summarized here as three
   * hard requirements this test suite must never let regress:
   *
   * 1. Bash is never available (`--tools`) and never granted (`--allowedTools`) for *any* role.
   *    A real-world experiment proved Claude Code's own `Bash(<pattern>)` allowlist syntax does
   *    not reject shell-metacharacter chaining -- even the exact, zero-wildcard pattern
   *    `Bash(pnpm test)` still let `pnpm test ; whoami` execute the chained `whoami` with zero
   *    denial. `--safe-mode` (required, never removable) also disables Claude Code's own hooks,
   *    so there is no CLI-side place left to validate a command's shape before it runs. The
   *    task's own Linear issue description is untrusted external data -- a real prompt-injection
   *    surface for smuggling a chained dangerous command past any allowlist pattern.
   * 2. Every `Write`/`Edit` grant in `--allowedTools` uses Claude Code's own `Tool(pattern)`
   *    syntax scoped to the working directory (`./*`, `./**`) -- never a bare tool name. A bare
   *    grant has no path boundary at all (also proven experimentally: it can write anywhere the
   *    OS permits, not just inside the worktree `--workingDirectory` points at).
   * 3. Read-only roles (`team_lead`/`code_reviewer`/`visual_reviewer`) get no `Write`/`Edit`
   *    grant of any kind -- their zero-mutation guarantee is unchanged from before this ticket.
   * 4. (C015h-1 acceptance review, round 1) `Read` is scoped exactly like `Write`/`Edit`
   *    (`Read(./*)`, `Read(./**)`), for *every* role including read-only ones -- never a bare
   *    `Read`. A bare `Read` grant was proven, with a real Claude CLI 2.1.223 run against a
   *    canary file placed outside the worktree, to read arbitrary files anywhere the OS permits
   *    with zero `permission_denials` signal. On this host that is a real exfiltration path:
   *    same-uid, 0600 secrets live under `~/.agent-team/secrets/` and
   *    `~/.agent-team/config/dispatch/providers.json`, the task's own Linear issue description is
   *    untrusted external data (a prompt-injection surface), and `Redactor` only scrubs
   *    known-shaped secrets (`sk-ant-*`, `lin_api_*`, JWTs, ...) -- never a random-byte webhook
   *    secret. Removing Bash does not close this path; only scoping `Read` does.
   */
  describe("tool authorization shape (C015h-1)", () => {
    const writeCapableRoles = ["implementer", "integration_engineer"] as const;
    const readOnlyRoles = agentRoleSchema.options.filter(
      (role) => !writeCapableRoles.includes(role as (typeof writeCapableRoles)[number]),
    );

    it.each(writeCapableRoles)(
      "grants %s exactly Read + directory-scoped Write/Edit patterns, never Bash, never a bare Write/Edit",
      async (role) => {
        const process = new FakeProcessPort([
          { type: "result", is_error: false, result: "ok", permission_denials: [] },
        ]);
        const started = await runner(process).start(runRequest(role));
        if (!started.ok) throw new Error(started.error.code);
        await started.value.completion();

        expect(process.request?.arguments).toEqual([
          "-p",
          "--safe-mode",
          "--verbose",
          "--output-format",
          "stream-json",
          "--permission-mode",
          "dontAsk",
          "--tools",
          "Read,Write,Edit",
          "--allowedTools",
          "Read(./*)",
          "Read(./**)",
          "Write(./*)",
          "Write(./**)",
          "Edit(./*)",
          "Edit(./**)",
          "--no-session-persistence",
          "--model",
          "opus",
        ]);
        const arguments_ = process.request?.arguments ?? [];
        expect(arguments_.join(" ")).not.toMatch(/\bBash\b/u);
        expect(arguments_).not.toContain("Write");
        expect(arguments_).not.toContain("Edit");
        expect(arguments_).not.toContain("Read");
      },
    );

    it.each(readOnlyRoles)(
      "grants %s only directory-scoped Read -- no Write/Edit/Bash tool, no bare Read/Write/Edit/Bash grant",
      async (role) => {
        const process = new FakeProcessPort([
          { type: "result", is_error: false, result: "ok", permission_denials: [] },
        ]);
        const started = await runner(process).start(runRequest(role));
        if (!started.ok) throw new Error(started.error.code);
        await started.value.completion();

        expect(process.request?.arguments).toEqual([
          "-p",
          "--safe-mode",
          "--verbose",
          "--output-format",
          "stream-json",
          "--permission-mode",
          "dontAsk",
          "--tools",
          "Read",
          "--allowedTools",
          "Read(./*)",
          "Read(./**)",
          "--no-session-persistence",
          "--model",
          "opus",
        ]);
      },
    );

    it("never emits a bare Read/Write/Edit/Bash token in --allowedTools for any role", async () => {
      for (const role of agentRoleSchema.options) {
        const process = new FakeProcessPort([
          { type: "result", is_error: false, result: "ok", permission_denials: [] },
        ]);
        const started = await runner(process).start(runRequest(role));
        if (!started.ok) throw new Error(started.error.code);
        await started.value.completion();

        const arguments_ = process.request?.arguments ?? [];
        const allowedToolsIndex = arguments_.indexOf("--allowedTools");
        expect(allowedToolsIndex).toBeGreaterThanOrEqual(0);
        const noSessionIndex = arguments_.indexOf("--no-session-persistence");
        expect(noSessionIndex).toBeGreaterThan(allowedToolsIndex);
        const grants = arguments_.slice(allowedToolsIndex + 1, noSessionIndex);
        expect(grants.length).toBeGreaterThan(0);
        for (const grant of grants) {
          expect(["Read", "Write", "Edit", "Bash"]).not.toContain(grant);
        }
      }
    });
  });
});
