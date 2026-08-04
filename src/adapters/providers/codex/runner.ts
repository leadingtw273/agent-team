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

const pinnedCliVersion = "0.146.0";
const requestTimeoutMs = 10_000;

interface JsonRpcMessage {
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

interface PendingRequest {
  readonly resolve: (result: Result<unknown, DomainError>) => void;
  readonly timer: NodeJS.Timeout;
}

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
      await new Promise<void>((resolve) => this.#waiters.add(resolve));
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

function nestedString(input: unknown, ...path: readonly string[]): string | undefined {
  let current: unknown = input;
  for (const key of path) current = asRecord(current)?.[key];
  return typeof current === "string" ? current : undefined;
}

function providerFailure(error: unknown): DomainError {
  let encoded = "";
  try {
    if (typeof error === "string") encoded = error;
    else if (typeof error === "object" && error !== null) encoded = JSON.stringify(error);
  } catch {
    // Malformed or cyclic provider errors are external failures, never success.
  }
  return encoded.includes("UsageLimitExceeded")
    ? domainError("rate_limited")
    : domainError("external_failure");
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

class CodexRun implements ProviderRunHandle {
  readonly runId: string;
  readonly events: AsyncIterable<ProviderEvent>;
  readonly #process: ChildProcessHandle;
  readonly #request: ProviderRunRequest;
  readonly #clock: Clock;
  readonly #redactor: ProviderTextRedactor;
  readonly #eventLog = new ProviderEventLog();
  readonly #pending = new Map<string | number, PendingRequest>();
  readonly #approvalRequests = new Map<string, string | number>();
  readonly #completion: Promise<Result<ProviderRunCompletion, DomainError>>;
  #resolveCompletion: ((result: Result<ProviderRunCompletion, DomainError>) => void) | undefined;
  #nextId = 1;
  #threadId: string | undefined;
  #turnId: string | undefined;
  #finished = false;

  constructor(
    process: ChildProcessHandle,
    request: ProviderRunRequest,
    clock: Clock,
    redactor: ProviderTextRedactor,
  ) {
    this.runId = `${request.job.id}:codex`;
    this.events = this.#eventLog;
    this.#process = process;
    this.#request = request;
    this.#clock = clock;
    this.#redactor = redactor;
    this.#completion = new Promise((resolve) => {
      this.#resolveCompletion = resolve;
    });
    void this.#consumeOutput();
    void this.#watchProcess();
  }

  async start(context: string): Promise<Result<void, DomainError>> {
    const initialized = await this.#rpcRequest("initialize", {
      clientInfo: { name: "agent_team", title: "Agent Team", version: "0.1.0" },
    });
    if (!initialized.ok) return initialized;
    const notified = await this.#send({ method: "initialized", params: {} });
    if (!notified.ok) return notified;

    const thread = await this.#rpcRequest("thread/start", {
      model: this.#request.model,
      cwd: this.#request.workingDirectory,
      approvalPolicy: "untrusted",
      sandbox:
        this.#request.role === "code_reviewer" || this.#request.role === "visual_reviewer"
          ? "read-only"
          : "workspace-write",
      ephemeral: true,
      serviceName: "agent_team",
    });
    if (!thread.ok) return thread;
    this.#threadId = nestedString(thread.value, "thread", "id");
    if (this.#threadId === undefined) return err(domainError("external_failure"));
    this.#eventLog.append({
      kind: "started",
      observedAt: this.#clock.now(),
      sessionId: this.#threadId,
    });

    const turn = await this.#rpcRequest("turn/start", {
      threadId: this.#threadId,
      input: [{ type: "text", text: context }],
    });
    if (!turn.ok) return turn;
    this.#turnId = nestedString(turn.value, "turn", "id");
    return this.#turnId === undefined ? err(domainError("external_failure")) : ok(undefined);
  }

  completion(options: ReadOptions = {}): Promise<Result<ProviderRunCompletion, DomainError>> {
    return waitWithSignal(this.#completion, options);
  }

  async respondToToolRequest(
    requestId: string,
    decision: "approve" | "decline",
    options: ReadOptions = {},
  ): Promise<Result<void, DomainError>> {
    if (options.signal?.aborted === true) return err(domainError("interrupted"));
    const rpcId = this.#approvalRequests.get(requestId);
    if (rpcId === undefined || this.#finished) return err(domainError("conflict"));
    this.#approvalRequests.delete(requestId);
    return this.#send({ id: rpcId, result: { decision } });
  }

  async interrupt(options: ReadOptions = {}): Promise<Result<void, DomainError>> {
    if (options.signal?.aborted === true) return err(domainError("interrupted"));
    if (this.#threadId === undefined || this.#turnId === undefined || this.#finished) {
      return err(domainError("conflict"));
    }
    const interrupted = await this.#rpcRequest("turn/interrupt", {
      threadId: this.#threadId,
      turnId: this.#turnId,
    });
    return interrupted.ok ? ok(undefined) : interrupted;
  }

  async #rpcRequest(method: string, params: unknown): Promise<Result<unknown, DomainError>> {
    if (this.#finished) return err(domainError("conflict"));
    const id = this.#nextId;
    this.#nextId += 1;
    const response = new Promise<Result<unknown, DomainError>>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve(err(domainError("timeout")));
      }, requestTimeoutMs);
      timer.unref();
      this.#pending.set(id, { resolve, timer });
    });
    const sent = await this.#send({ id, method, params });
    if (!sent.ok) {
      const pending = this.#pending.get(id);
      if (pending !== undefined) clearTimeout(pending.timer);
      this.#pending.delete(id);
      return sent;
    }
    return response;
  }

  async #send(message: JsonRpcMessage): Promise<Result<void, DomainError>> {
    const line = `${JSON.stringify(message)}\n`;
    return this.#process.writeStdin(Buffer.from(line, "utf8"));
  }

  async #consumeOutput(): Promise<void> {
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
        let message: JsonRpcMessage;
        try {
          message = JSON.parse(line) as JsonRpcMessage;
        } catch {
          this.#fail(domainError("external_failure"));
          return;
        }
        this.#handleMessage(message);
      }
    }
  }

  #handleMessage(message: JsonRpcMessage): void {
    if (message.method === undefined) {
      if (message.id === undefined) return;
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      pending.resolve(
        message.error === undefined ? ok(message.result) : err(providerFailure(message.error)),
      );
      return;
    }

    if (message.method === "item/commandExecution/requestApproval" && message.id !== undefined) {
      const requestId = String(message.id);
      const payload = asRecord(this.#redactor.redactUnknown(message.params)) ?? Object.freeze({});
      this.#approvalRequests.set(requestId, message.id);
      this.#eventLog.append({
        kind: "tool_request",
        observedAt: this.#clock.now(),
        requestId,
        tool: "command_execution",
        payload,
      });
      return;
    }
    if (message.id !== undefined) {
      void this.#send({
        id: message.id,
        error: { code: -32_601, message: "Unsupported server request" },
      });
      return;
    }
    if (message.method === "item/completed") {
      const item = asRecord(asRecord(message.params)?.["item"]);
      if (item?.["type"] === "agentMessage" && typeof item["text"] === "string") {
        this.#eventLog.append({
          kind: "output",
          observedAt: this.#clock.now(),
          stream: "stdout",
          text: this.#redactor.redactText(item["text"]),
        });
      }
      return;
    }
    if (message.method === "turn/completed") {
      const turn = asRecord(asRecord(message.params)?.["turn"]);
      const status = turn?.["status"];
      if (status === "completed") {
        this.#finish(
          ok({
            outcome: "completed",
            ...(this.#threadId === undefined ? {} : { sessionId: this.#threadId }),
          }),
        );
      } else if (status === "interrupted") {
        this.#finish(
          ok({
            outcome: "interrupted",
            ...(this.#threadId === undefined ? {} : { sessionId: this.#threadId }),
          }),
        );
      } else this.#fail(providerFailure(turn?.["error"]));
    }
  }

  async #watchProcess(): Promise<void> {
    const exit = await this.#process.wait();
    if (this.#finished) return;
    if (!exit.ok) this.#fail(exit.error);
    else this.#fail(domainError("external_failure"));
  }

  #fail(error: DomainError): void {
    if (this.#finished) return;
    if (this.#request.checkpoint !== undefined) {
      this.#eventLog.append({
        kind: "checkpoint",
        observedAt: this.#clock.now(),
        checkpoint: this.#request.checkpoint,
      });
    }
    this.#eventLog.append({ kind: "failed", observedAt: this.#clock.now(), error });
    this.#finish(
      ok({
        outcome: "failed",
        ...(this.#threadId === undefined ? {} : { sessionId: this.#threadId }),
        error,
      }),
    );
  }

  #finish(result: Result<ProviderRunCompletion, DomainError>): void {
    if (this.#finished) return;
    this.#finished = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(err(domainError("external_failure")));
    }
    this.#pending.clear();
    if (result.ok && result.value.outcome === "completed") {
      this.#eventLog.append({ kind: "completed", observedAt: this.#clock.now() });
    }
    this.#eventLog.close();
    this.#resolveCompletion?.(result);
    void this.#process.closeStdin();
  }
}

export interface CodexRunnerOptions {
  readonly process: ProcessPort;
  readonly redactor: ProviderTextRedactor;
  readonly clock?: Clock;
  readonly executable?: string;
  readonly models?: readonly string[];
  readonly cliVersion?: string;
}

export class CodexRunner implements ProviderPort {
  readonly #process: ProcessPort;
  readonly #redactor: ProviderTextRedactor;
  readonly #clock: Clock;
  readonly #executable: string;
  readonly #models: readonly string[];
  readonly #cliVersion: string;

  constructor(options: CodexRunnerOptions) {
    this.#process = options.process;
    this.#redactor = options.redactor;
    this.#clock = options.clock ?? createClock();
    this.#executable = options.executable ?? "codex";
    this.#models = Object.freeze([...(options.models ?? [])]);
    this.#cliVersion = options.cliVersion ?? pinnedCliVersion;
  }

  inspectCapabilities(): Promise<Result<ProviderCapabilities, DomainError>> {
    return Promise.resolve(
      ok({
        provider: "codex",
        cliVersion: this.#cliVersion,
        models: this.#models,
        supportsResume: true,
        supportsStructuredEvents: true,
        supportsDynamicApproval: true,
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
        arguments: ["app-server", "--stdio", "--strict-config"],
        workingDirectory: "/tmp",
        keepStdinOpen: true,
        deadlineAt: request.deadlineAt,
        maxOutputBytes: context.value.protocol.limits.maxOutputBytes,
      },
      options,
    );
    if (!spawned.ok) return spawned;
    const run = new CodexRun(spawned.value, request, this.#clock, this.#redactor);
    const started = await run.start(context.value.context);
    if (!started.ok) {
      await spawned.value.sendSignal("SIGTERM");
      return started;
    }
    return ok(run);
  }
}
