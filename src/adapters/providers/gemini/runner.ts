import { isAbsolute } from "node:path";

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

const pinnedCliVersion = "0.52.0";
const readTools = new Set(["read_file", "read_many_files"]);

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

function finiteCount(input: unknown): number | undefined {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0 ? input : undefined;
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

interface ValidatedGeminiResult {
  readonly response: string;
  readonly actualModels: readonly string[];
}

function validateGeminiResult(
  input: unknown,
  requestedModel: string,
  actualModelAllowlist: Readonly<Record<string, readonly string[]>>,
): Result<ValidatedGeminiResult, DomainError> {
  const payload = asRecord(input);
  const stats = asRecord(payload?.["stats"]);
  const models = asRecord(stats?.["models"]);
  const toolsStats = asRecord(stats?.["tools"]);
  const toolStats = asRecord(toolsStats?.["byName"]);
  const fileStats = asRecord(stats?.["files"]);
  const response = payload?.["response"];
  if (
    payload === undefined ||
    payload["error"] !== undefined ||
    typeof response !== "string" ||
    response.trim().length === 0 ||
    models === undefined ||
    toolStats === undefined ||
    fileStats === undefined
  ) {
    return err(domainError("external_failure"));
  }

  const actualModels = Object.keys(models);
  const allowed = actualModelAllowlist[requestedModel];
  if (
    actualModels.length === 0 ||
    (requestedModel !== "auto" &&
      (allowed === undefined || actualModels.some((model) => !allowed.includes(model))))
  ) {
    return err(domainError("unavailable"));
  }

  // A whitelisted read tool that the sandbox correctly refused (for example a `read_file` on a
  // path outside the worktree) is not the same thing as an unauthorized capability succeeding --
  // the admin policy, not this count, is the actual enforcement boundary for what the CLI may
  // touch. So a `fail` count on a whitelisted read tool is tolerated here as long as its own
  // count/success/fail triple is internally consistent. Any tool name outside the read-only
  // whitelist is still rejected unconditionally, because merely *requesting* an unauthorized
  // capability (whether it succeeded or was refused) is itself a signal this report is untrusted.
  let readSucceeded = false;
  let observedCount = 0;
  let observedSuccess = 0;
  let observedFail = 0;
  for (const [name, value] of Object.entries(toolStats)) {
    const tool = asRecord(value);
    const count = finiteCount(tool?.["count"]);
    const success = finiteCount(tool?.["success"]);
    const fail = finiteCount(tool?.["fail"]);
    if (
      !readTools.has(name) ||
      count === undefined ||
      success === undefined ||
      fail === undefined ||
      count === 0 ||
      success + fail !== count
    ) {
      return err(domainError("permission_denied"));
    }
    if (success > 0) readSucceeded = true;
    observedCount += count;
    observedSuccess += success;
    observedFail += fail;
  }

  // Aggregate totals must be reported and must equal the sum of the per-tool byName entries --
  // this closes off a report that pads or omits byName entries to make the per-tool checks above
  // pass while the aggregate (or vice versa) tells a different story.
  const totalCalls = finiteCount(toolsStats?.["totalCalls"]);
  const totalSuccess = finiteCount(toolsStats?.["totalSuccess"]);
  const totalFail = finiteCount(toolsStats?.["totalFail"]);
  if (
    !readSucceeded ||
    totalCalls === undefined ||
    totalSuccess === undefined ||
    totalFail === undefined ||
    totalCalls !== observedCount ||
    totalSuccess !== observedSuccess ||
    totalFail !== observedFail ||
    finiteCount(fileStats["totalLinesAdded"]) !== 0 ||
    finiteCount(fileStats["totalLinesRemoved"]) !== 0
  ) {
    return err(domainError("permission_denied"));
  }
  return ok(
    Object.freeze({
      response: response.trim(),
      actualModels: Object.freeze(actualModels),
    }),
  );
}

class GeminiRun implements ProviderRunHandle {
  readonly runId: string;
  readonly events: AsyncIterable<ProviderEvent>;
  readonly #process: ChildProcessHandle;
  readonly #request: ProviderRunRequest;
  readonly #redactor: ProviderTextRedactor;
  readonly #clock: Clock;
  readonly #actualModelAllowlist: Readonly<Record<string, readonly string[]>>;
  readonly #eventLog = new ProviderEventLog();
  readonly #completion: Promise<Result<ProviderRunCompletion, DomainError>>;
  #checkpointEmitted = false;
  #controllerInterrupted = false;
  #finished = false;

  constructor(
    process: ChildProcessHandle,
    request: ProviderRunRequest,
    redactor: ProviderTextRedactor,
    clock: Clock,
    actualModelAllowlist: Readonly<Record<string, readonly string[]>>,
  ) {
    this.runId = `${request.job.id}:gemini`;
    this.events = this.#eventLog;
    this.#process = process;
    this.#request = request;
    this.#redactor = redactor;
    this.#clock = clock;
    this.#actualModelAllowlist = actualModelAllowlist;
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
    let stdout = "";
    for await (const chunk of this.#process.output) {
      const text = Buffer.from(chunk.bytes).toString("utf8");
      if (chunk.stream === "stdout") stdout += text;
      else {
        this.#eventLog.append({
          kind: "output",
          observedAt: chunk.observedAt,
          stream: "stderr",
          text: this.#redactor.redactText(text),
        });
      }
    }
    const exit = await this.#process.wait();
    if (this.#controllerInterrupted) return this.#finish(ok({ outcome: "interrupted" }));
    if (
      !exit.ok ||
      exit.value.exitCode !== 0 ||
      exit.value.signal !== null ||
      exit.value.outputTruncated
    ) {
      return this.#fail(exit.ok ? domainError("unavailable") : exit.error);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(stdout);
    } catch {
      return this.#fail(domainError("external_failure"));
    }
    const validated = validateGeminiResult(
      payload,
      this.#request.model,
      this.#actualModelAllowlist,
    );
    if (!validated.ok) return this.#fail(validated.error);
    this.#eventLog.append({
      kind: "model_selected",
      observedAt: this.#clock.now(),
      requestedModel: this.#request.model,
      actualModels: validated.value.actualModels,
    });
    this.#eventLog.append({
      kind: "output",
      observedAt: this.#clock.now(),
      stream: "stdout",
      text: this.#redactor.redactText(validated.value.response),
    });
    this.#eventLog.append({ kind: "completed", observedAt: this.#clock.now() });
    return this.#finish(ok({ outcome: "completed" }));
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
    result: Result<ProviderRunCompletion, DomainError>,
  ): Result<ProviderRunCompletion, DomainError> {
    this.#finished = true;
    this.#eventLog.close();
    return result;
  }
}

export interface GeminiRunnerOptions {
  readonly process: ProcessPort;
  readonly redactor: ProviderTextRedactor;
  readonly adminPolicyPath: string;
  readonly actualModelAllowlist?: Readonly<Record<string, readonly string[]>>;
  readonly clock?: Clock;
  readonly executable?: string;
  readonly models?: readonly string[];
  readonly cliVersion?: string;
}

export class GeminiRunner implements ProviderPort {
  readonly #process: ProcessPort;
  readonly #redactor: ProviderTextRedactor;
  readonly #adminPolicyPath: string;
  readonly #actualModelAllowlist: Readonly<Record<string, readonly string[]>>;
  readonly #clock: Clock;
  readonly #executable: string;
  readonly #models: readonly string[];
  readonly #cliVersion: string;

  constructor(options: GeminiRunnerOptions) {
    this.#process = options.process;
    this.#redactor = options.redactor;
    this.#adminPolicyPath = options.adminPolicyPath;
    this.#actualModelAllowlist = Object.freeze({ ...(options.actualModelAllowlist ?? {}) });
    this.#clock = options.clock ?? createClock();
    this.#executable = options.executable ?? "gemini";
    this.#models = Object.freeze([...(options.models ?? [])]);
    this.#cliVersion = options.cliVersion ?? pinnedCliVersion;
  }

  inspectCapabilities(): Promise<Result<ProviderCapabilities, DomainError>> {
    return Promise.resolve(
      ok({
        provider: "gemini",
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
    if (request.role !== "visual_reviewer" || !isAbsolute(this.#adminPolicyPath)) {
      return err(domainError("permission_denied"));
    }
    const context = buildProviderJobContext(request, this.#redactor);
    if (!context.ok) return context;
    const spawned = await this.#process.spawn(
      {
        executable: this.#executable,
        arguments: [
          "-p",
          "Follow the Agent Team Provider Job Protocol supplied on stdin.",
          "--skip-trust",
          "--approval-mode",
          "plan",
          "--admin-policy",
          this.#adminPolicyPath,
          "--output-format",
          "json",
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
    return ok(
      new GeminiRun(
        spawned.value,
        request,
        this.#redactor,
        this.#clock,
        this.#actualModelAllowlist,
      ),
    );
  }
}
