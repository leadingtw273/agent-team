import { describe, expect, it } from "vitest";

import type {
  ProviderEvent,
  ProviderPort,
  ProviderRunCompletion,
  ProviderRunHandle,
  ProviderRunRequest,
} from "../../src/application/ports/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../src/domain/foundation/index.js";
import { LimitedProvider, ModelExecutionLimiter } from "../../src/cli/dispatch/provider-limiter.js";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const request = {} as ProviderRunRequest;

class BarrierProvider implements ProviderPort {
  readonly completions: ReturnType<typeof deferred<Result<ProviderRunCompletion, DomainError>>>[] =
    [];
  started = 0;
  inFlight = 0;
  peak = 0;

  inspectCapabilities() {
    return Promise.resolve(err(domainError("unavailable")));
  }

  start(): Promise<Result<ProviderRunHandle, DomainError>> {
    const completion = deferred<Result<ProviderRunCompletion, DomainError>>();
    this.completions.push(completion);
    this.started += 1;
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    void completion.promise.then(() => {
      this.inFlight -= 1;
    });
    return Promise.resolve(
      ok({
        runId: `run-${String(this.started)}`,
        events: (async function* () {
          await Promise.resolve();
        })(),
        completion: () => completion.promise,
        respondToToolRequest: () => Promise.resolve(ok(undefined)),
        interrupt: () => Promise.resolve(ok(undefined)),
      }),
    );
  }
}

function limiter() {
  return new ModelExecutionLimiter({
    global: 4,
    providers: { codex: 3, claude: 1, gemini: 1 },
  });
}

describe("bounded Provider execution", () => {
  it("runs three Codex and one Claude call together while a fourth Codex waits", async () => {
    const shared = limiter();
    const codexDelegate = new BarrierProvider();
    const claudeDelegate = new BarrierProvider();
    const codex = new LimitedProvider("codex", codexDelegate, shared);
    const claude = new LimitedProvider("claude", claudeDelegate, shared);

    const starts = [
      codex.start(request),
      codex.start(request),
      codex.start(request),
      codex.start(request),
      claude.start(request),
    ];
    await Promise.resolve();
    await Promise.resolve();

    expect(codexDelegate.started).toBe(3);
    expect(claudeDelegate.started).toBe(1);
    expect(codexDelegate.inFlight + claudeDelegate.inFlight).toBe(4);

    codexDelegate.completions[0]?.resolve(ok({ outcome: "completed" }));
    const handles = await Promise.all(starts);
    expect(handles.every((entry) => entry.ok)).toBe(true);
    expect(codexDelegate.started).toBe(4);
    expect(codexDelegate.peak).toBe(3);
    expect(claudeDelegate.peak).toBe(1);

    for (const completion of codexDelegate.completions.slice(1)) {
      completion.resolve(ok({ outcome: "completed" }));
    }
    claudeDelegate.completions[0]?.resolve(ok({ outcome: "completed" }));
  });

  it("releases exactly once after interrupt so the next request can start", async () => {
    const shared = new ModelExecutionLimiter({
      global: 1,
      providers: { codex: 1, claude: 1, gemini: 1 },
    });
    const delegate = new BarrierProvider();
    const provider = new LimitedProvider("codex", delegate, shared);
    const first = await provider.start(request);
    const secondPromise = provider.start(request);
    await Promise.resolve();
    expect(delegate.started).toBe(1);
    if (!first.ok) throw new Error(first.error.code);

    await first.value.interrupt();
    await first.value.interrupt();
    const second = await secondPromise;
    expect(second.ok).toBe(true);
    expect(delegate.started).toBe(2);
    delegate.completions.forEach((completion) => {
      completion.resolve(ok({ outcome: "completed" }));
    });
  });

  it("releases after an events iterator throws and after delegate start failure", async () => {
    const shared = new ModelExecutionLimiter({
      global: 1,
      providers: { codex: 1, claude: 1, gemini: 1 },
    });
    let attempts = 0;
    const throwingEvents: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        throw new Error("event stream failed");
      },
    };
    const delegate: ProviderPort = {
      inspectCapabilities: () => Promise.resolve(err(domainError("unavailable"))),
      start: () => {
        attempts += 1;
        if (attempts === 1) return Promise.resolve(err(domainError("external_failure")));
        return Promise.resolve(
          ok({
            runId: "throwing-events",
            events: throwingEvents,
            completion: () => new Promise(() => undefined),
            respondToToolRequest: () => Promise.resolve(ok(undefined)),
            interrupt: () => Promise.resolve(ok(undefined)),
          }),
        );
      },
    };
    const provider = new LimitedProvider("codex", delegate, shared);

    expect(await provider.start(request)).toEqual(err(domainError("external_failure")));
    const second = await provider.start(request);
    if (!second.ok) throw new Error(second.error.code);
    await expect(async () => {
      for await (const _event of second.value.events) void _event;
    }).rejects.toThrow("event stream failed");
    const third = await provider.start(request);
    expect(third.ok).toBe(true);
  });
});
