import type {
  ProviderEvent,
  ProviderPort,
  ProviderRunCompletion,
  ProviderRunHandle,
  ProviderRunRequest,
  ReadOptions,
} from "../../application/ports/index.js";
import { domainError, err, type DomainError, type Result } from "../../domain/foundation/index.js";
import type { ModelProvider } from "../../application/routing/index.js";

interface Waiter {
  readonly provider: ModelProvider;
  readonly resolve: (result: Result<() => void, DomainError>) => void;
  readonly signal?: AbortSignal;
  abort?: () => void;
}

export interface ModelExecutionLimits {
  readonly global: number;
  readonly providers: Readonly<Record<ModelProvider, number>>;
}

/** One-process scheduler for real Provider calls. It skips a blocked provider queue entry so a
 * free Claude slot cannot sit idle behind a fourth Codex request. */
export class ModelExecutionLimiter {
  readonly #limits: ModelExecutionLimits;
  readonly #activeByProvider: Record<ModelProvider, number> = {
    codex: 0,
    claude: 0,
    gemini: 0,
  };
  readonly #queue: Waiter[] = [];
  #activeGlobal = 0;

  constructor(limits: ModelExecutionLimits) {
    this.#limits = limits;
  }

  acquire(
    provider: ModelProvider,
    options: ReadOptions = {},
  ): Promise<Result<() => void, DomainError>> {
    if (options.signal?.aborted === true) {
      return Promise.resolve(err(domainError("interrupted")));
    }
    return new Promise((resolve) => {
      const waiter: Waiter = {
        provider,
        resolve,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      };
      if (options.signal !== undefined) {
        waiter.abort = () => {
          const index = this.#queue.indexOf(waiter);
          if (index >= 0) this.#queue.splice(index, 1);
          resolve(err(domainError("interrupted")));
        };
        options.signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.#queue.push(waiter);
      this.#drain();
    });
  }

  #drain(): void {
    while (this.#activeGlobal < this.#limits.global) {
      const index = this.#queue.findIndex(
        (waiter) =>
          waiter.signal?.aborted !== true &&
          this.#activeByProvider[waiter.provider] < this.#limits.providers[waiter.provider],
      );
      if (index < 0) return;
      const waiter = this.#queue.splice(index, 1)[0];
      if (waiter === undefined) return;
      if (waiter.abort !== undefined && waiter.signal !== undefined) {
        waiter.signal.removeEventListener("abort", waiter.abort);
      }
      this.#activeGlobal += 1;
      this.#activeByProvider[waiter.provider] += 1;
      let released = false;
      waiter.resolve({
        ok: true,
        value: () => {
          if (released) return;
          released = true;
          this.#activeGlobal -= 1;
          this.#activeByProvider[waiter.provider] -= 1;
          this.#drain();
        },
      });
    }
  }
}

function waitForCompletion(
  completion: Promise<Result<ProviderRunCompletion, DomainError>>,
  options: ReadOptions,
): Promise<Result<ProviderRunCompletion, DomainError>> {
  if (options.signal?.aborted === true) return Promise.resolve(err(domainError("interrupted")));
  if (options.signal === undefined) return completion;
  return new Promise((resolve) => {
    const aborted = (): void => {
      resolve(err(domainError("interrupted")));
    };
    options.signal?.addEventListener("abort", aborted, { once: true });
    void completion.then((result) => {
      options.signal?.removeEventListener("abort", aborted);
      resolve(result);
    });
  });
}

export class LimitedProvider implements ProviderPort {
  constructor(
    readonly provider: ModelProvider,
    readonly delegate: ProviderPort,
    readonly limiter: ModelExecutionLimiter,
  ) {}

  inspectCapabilities(options?: ReadOptions) {
    return this.delegate.inspectCapabilities(options);
  }

  async start(
    request: ProviderRunRequest,
    options: ReadOptions = {},
  ): Promise<Result<ProviderRunHandle, DomainError>> {
    const acquired = await this.limiter.acquire(this.provider, options);
    if (!acquired.ok) return acquired;
    const release = acquired.value;
    const started = await this.delegate.start(request, options);
    if (!started.ok) {
      release();
      return started;
    }

    const delegate = started.value;
    let released = false;
    const releaseOnce = (): void => {
      if (released) return;
      released = true;
      release();
    };
    const completion = delegate.completion().then(
      (result) => {
        releaseOnce();
        return result;
      },
      () => {
        releaseOnce();
        return err(domainError("external_failure"));
      },
    );
    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        try {
          yield* delegate.events;
        } catch (error) {
          releaseOnce();
          throw error;
        }
      },
    };

    return {
      ok: true,
      value: Object.freeze({
        runId: delegate.runId,
        events,
        completion: (completionOptions: ReadOptions = {}) =>
          waitForCompletion(completion, completionOptions),
        respondToToolRequest: (...args: Parameters<ProviderRunHandle["respondToToolRequest"]>) =>
          delegate.respondToToolRequest(...args),
        interrupt: async (interruptOptions: ReadOptions = {}) => {
          try {
            return await delegate.interrupt(interruptOptions);
          } finally {
            releaseOnce();
          }
        },
      }),
    };
  }
}

export const defaultModelExecutionLimiter = new ModelExecutionLimiter({
  global: 4,
  providers: { codex: 3, claude: 1, gemini: 1 },
});
