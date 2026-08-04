import type {
  ChildProcessHandle,
  ProcessPort,
  ProviderCapabilities,
  ProviderEvent,
  ProviderPort,
  ProviderRunCompletion,
  ProviderRunHandle,
  ProviderRunRequest,
  ReadOptions,
} from "../../../application/ports/index.js";
import {
  buildProviderJobContext,
  type ProviderTextRedactor,
} from "../../../application/provider-job/index.js";
import {
  createClock,
  domainError,
  err,
  ok,
  type Clock,
  type DomainError,
  type Result,
} from "../../../domain/foundation/index.js";

const pinnedCliVersion = "2.1.221";
const knownEventTypes = new Set(["system", "assistant", "user", "result", "rate_limit_event"]);

class ProviderEventLog implements AsyncIterable<ProviderEvent> {
  readonly #events: ProviderEvent[] = [];
  readonly #waiters = new Set<() => void>();
  #closed = false;

  append(event: ProviderEvent): void {
    if (this.#closed) return;
    this.#events.push(Object.freeze(event));
    this.#wake();
  }

  close(): void {
    this.#closed = true;
    this.#wake();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
    let index = 0;
    for (;;) {
      const event = this.#events[index];
      if (event !== undefined) {
        index += 1;
        yield event;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#waiters.add(resolve);
      });
    }
  }

  #wake(): void {
    for (const resolve of this.#waiters) resolve();
    this.#waiters.clear();
  }
}

function asRecord(input: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Readonly<Record<string, unknown>>)
    : undefined;
}

function waitWithSignal<Value>(
  promise: Promise<Result<Value, DomainError>>,
  options: ReadOptions,
): Promise<Result<Value, DomainError>> {
  const signal = options.signal;
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.resolve(err(domainError("interrupted")));
  return new Promise((resolve) => {
    const abort = () => {
      resolve(err(domainError("interrupted")));
    };
    signal.addEventListener("abort", abort, { once: true });
    void promise.then((result) => {
      signal.removeEventListener("abort", abort);
      resolve(result);
    });
  });
}

function toolsForRole(role: ProviderRunRequest["role"]): string {
  return role === "implementer" || role === "integration_engineer"
    ? "Read,Write,Edit,Bash"
    : "Read";
}

interface ParsedResult {
  readonly isError: boolean;
  readonly text: string;
  readonly sessionId?: string;
  readonly permissionDenials: readonly Readonly<Record<string, unknown>>[];
}

class ClaudeRun implements ProviderRunHandle {
  readonly runId: string;
  readonly events: AsyncIterable<ProviderEvent>;
  readonly #process: ChildProcessHandle;
  readonly #request: ProviderRunRequest;
  readonly #redactor: ProviderTextRedactor;
  readonly #clock: Clock;
  readonly #eventLog = new ProviderEventLog();
  readonly #completion: Promise<Result<ProviderRunCompletion, DomainError>>;
  #controllerInterrupted = false;
  #checkpointEmitted = false;
  #finished = false;

  constructor(
    process: ChildProcessHandle,
    request: ProviderRunRequest,
    redactor: ProviderTextRedactor,
    clock: Clock,
  ) {
    this.runId = `${request.job.id}:claude`;
    this.events = this.#eventLog;
    this.#process = process;
    this.#request = request;
    this.#redactor = redactor;
    this.#clock = clock;
    this.#eventLog.append({ kind: "started", observedAt: clock.now() });
    this.#completion = this.#execute();
  }

  completion(options: ReadOptions = {}): Promise<Result<ProviderRunCompletion, DomainError>> {
    return waitWithSignal(this.#completion, options);
  }

  respondToToolRequest(): Promise<Result<void, DomainError>> {
    return Promise.resolve(err(domainError("conflict")));
  }

  async interrupt(options: ReadOptions = {}): Promise<Result<void, DomainError>> {
    if (options.signal?.aborted === true) return err(domainError("interrupted"));
    if (this.#finished) return err(domainError("conflict"));
    this.#controllerInterrupted = true;
    this.#emitCheckpoint();
    return this.#process.sendSignal("SIGTERM", options);
  }

  async #execute(): Promise<Result<ProviderRunCompletion, DomainError>> {
    let resultEvent: ParsedResult | undefined;
    let invalidStream = false;
    for await (const chunk of this.#process.output) {
      const text = Buffer.from(chunk.bytes).toString("utf8");
      if (chunk.stream === "stderr") {
        this.#eventLog.append({
          kind: "output",
          observedAt: chunk.observedAt,
          stream: "stderr",
          text: this.#redactor.redactText(text),
        });
        continue;
      }
      for (const line of text.split("\n")) {
        if (line.trim().length === 0) continue;
        let event: Readonly<Record<string, unknown>> | undefined;
        try {
          event = asRecord(JSON.parse(line));
        } catch {
          invalidStream = true;
          continue;
        }
        if (event === undefined) {
          invalidStream = true;
          continue;
        }
        const type = event["type"];
        if (typeof type !== "string" || !knownEventTypes.has(type)) {
          invalidStream = true;
          continue;
        }
        if (type === "assistant") this.#handleAssistant(event);
        if (type === "rate_limit_event") this.#handleRateLimit(event);
        if (type === "result") resultEvent = this.#parseResult(event);
      }
    }

    const exit = await this.#process.wait();
    if (this.#controllerInterrupted) {
      return this.#finish(ok({ outcome: "interrupted" }));
    }
    if (!exit.ok) return this.#fail(exit.error);
    if (exit.value.exitCode !== 0 || exit.value.signal !== null || invalidStream) {
      return this.#fail(domainError("external_failure"));
    }
    if (resultEvent === undefined) return this.#fail(domainError("external_failure"));
    if (resultEvent.permissionDenials.length > 0) {
      for (const [index, denial] of resultEvent.permissionDenials.entries()) {
        const tool =
          typeof denial["tool_name"] === "string"
            ? denial["tool_name"]
            : typeof denial["toolName"] === "string"
              ? denial["toolName"]
              : "unknown";
        this.#eventLog.append({
          kind: "tool_request",
          observedAt: this.#clock.now(),
          requestId: `claude-denial-${String(index + 1)}`,
          tool,
          payload: asRecord(this.#redactor.redactUnknown(denial)) ?? Object.freeze({}),
        });
      }
      this.#emitCheckpoint();
      return this.#finish(
        ok({
          outcome: "interrupted",
          ...(resultEvent.sessionId === undefined ? {} : { sessionId: resultEvent.sessionId }),
        }),
      );
    }
    if (resultEvent.isError) return this.#fail(domainError("external_failure"));
    if (resultEvent.text.length > 0) {
      this.#eventLog.append({
        kind: "output",
        observedAt: this.#clock.now(),
        stream: "stdout",
        text: resultEvent.text,
      });
    }
    this.#eventLog.append({ kind: "completed", observedAt: this.#clock.now() });
    return this.#finish(
      ok({
        outcome: "completed",
        ...(resultEvent.sessionId === undefined ? {} : { sessionId: resultEvent.sessionId }),
      }),
    );
  }

  #handleAssistant(event: Readonly<Record<string, unknown>>): void {
    const message = asRecord(event["message"]);
    const content = Array.isArray(message?.["content"]) ? message["content"] : [];
    for (const blockInput of content) {
      const block = asRecord(blockInput);
      if (block?.["type"] !== "text" || typeof block["text"] !== "string") continue;
      this.#eventLog.append({
        kind: "output",
        observedAt: this.#clock.now(),
        stream: "stdout",
        text: this.#redactor.redactText(block["text"]),
      });
    }
  }

  #handleRateLimit(event: Readonly<Record<string, unknown>>): void {
    const info = asRecord(event["rate_limit_info"] ?? event["rateLimitInfo"]);
    const status = info?.["status"];
    if (status !== "rejected" && status !== "exceeded") return;
    const bucket = info?.["rate_limit_type"] ?? info?.["rateLimitType"];
    if (bucket === "seven_day") {
      this.#eventLog.append({
        kind: "quota_boundary",
        observedAt: this.#clock.now(),
        bucket: "weekly",
      });
    } else if (bucket === "five_hour") {
      this.#eventLog.append({
        kind: "quota_boundary",
        observedAt: this.#clock.now(),
        bucket: "five_hour",
      });
    }
  }

  #parseResult(event: Readonly<Record<string, unknown>>): ParsedResult | undefined {
    if (typeof event["is_error"] !== "boolean" || typeof event["result"] !== "string") {
      return undefined;
    }
    const denials = Array.isArray(event["permission_denials"])
      ? event["permission_denials"].flatMap((denial) => {
          const record = asRecord(denial);
          return record === undefined ? [] : [record];
        })
      : [];
    return Object.freeze({
      isError: event["is_error"],
      text: this.#redactor.redactText(event["result"]),
      ...(typeof event["session_id"] === "string" ? { sessionId: event["session_id"] } : {}),
      permissionDenials: Object.freeze(denials),
    });
  }

  #emitCheckpoint(): void {
    if (this.#checkpointEmitted || this.#request.checkpoint === undefined) return;
    this.#checkpointEmitted = true;
    this.#eventLog.append({
      kind: "checkpoint",
      observedAt: this.#clock.now(),
      checkpoint: this.#request.checkpoint,
    });
  }

  #fail(error: DomainError): Result<ProviderRunCompletion, DomainError> {
    this.#emitCheckpoint();
    this.#eventLog.append({ kind: "failed", observedAt: this.#clock.now(), error });
    return this.#finish(ok({ outcome: "failed", error }));
  }

  #finish(
    completion: Result<ProviderRunCompletion, DomainError>,
  ): Result<ProviderRunCompletion, DomainError> {
    this.#finished = true;
    this.#eventLog.close();
    return completion;
  }
}

export interface ClaudeRunnerOptions {
  readonly process: ProcessPort;
  readonly redactor: ProviderTextRedactor;
  readonly clock?: Clock;
  readonly executable?: string;
  readonly models?: readonly string[];
  readonly cliVersion?: string;
}

export class ClaudeRunner implements ProviderPort {
  readonly #process: ProcessPort;
  readonly #redactor: ProviderTextRedactor;
  readonly #clock: Clock;
  readonly #executable: string;
  readonly #models: readonly string[];
  readonly #cliVersion: string;

  constructor(options: ClaudeRunnerOptions) {
    this.#process = options.process;
    this.#redactor = options.redactor;
    this.#clock = options.clock ?? createClock();
    this.#executable = options.executable ?? "claude";
    this.#models = Object.freeze([...(options.models ?? [])]);
    this.#cliVersion = options.cliVersion ?? pinnedCliVersion;
  }

  inspectCapabilities(): Promise<Result<ProviderCapabilities, DomainError>> {
    return Promise.resolve(
      ok({
        provider: "claude",
        cliVersion: this.#cliVersion,
        models: this.#models,
        supportsResume: false,
        supportsStructuredEvents: true,
        supportsDynamicApproval: false,
        supportsVisualInput: true,
      }),
    );
  }

  async start(
    request: ProviderRunRequest,
    options: ReadOptions = {},
  ): Promise<Result<ProviderRunHandle, DomainError>> {
    if (options.signal?.aborted === true) return err(domainError("interrupted"));
    const context = buildProviderJobContext(request, this.#redactor);
    if (!context.ok) return context;
    const spawned = await this.#process.spawn(
      {
        executable: this.#executable,
        arguments: [
          "-p",
          "--safe-mode",
          "--verbose",
          "--output-format",
          "stream-json",
          "--permission-mode",
          "dontAsk",
          "--tools",
          toolsForRole(request.role),
          "--no-session-persistence",
          "--model",
          request.model,
        ],
        workingDirectory: request.workingDirectory,
        stdin: Buffer.from(context.value.context, "utf8"),
        deadlineAt: request.deadlineAt,
        maxOutputBytes: context.value.protocol.limits.maxOutputBytes,
      },
      options,
    );
    if (!spawned.ok) return spawned;
    return ok(new ClaudeRun(spawned.value, request, this.#redactor, this.#clock));
  }
}
