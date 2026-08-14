import type {
  ProviderCapabilities,
  ProviderPort,
  ProviderRunHandle,
  ProviderRunRequest,
  ReadOptions,
} from "../../application/ports/index.js";
import type { AgentRole } from "../../domain/project/index.js";
import { domainError, err, type DomainError, type Result } from "../../domain/foundation/index.js";
import type { ModelProvider } from "../../application/routing/index.js";

export class PolicyBoundProvider implements ProviderPort {
  readonly #delegate: ProviderPort;
  readonly #provider: ModelProvider;
  readonly #models: ReadonlySet<string>;
  readonly #roles: ReadonlySet<AgentRole>;

  constructor(options: {
    readonly delegate: ProviderPort;
    readonly provider: ModelProvider;
    readonly models: readonly string[];
    readonly roles: readonly AgentRole[];
  }) {
    this.#delegate = options.delegate;
    this.#provider = options.provider;
    this.#models = new Set(options.models);
    this.#roles = new Set(options.roles);
  }

  async inspectCapabilities(): Promise<Result<ProviderCapabilities, DomainError>> {
    const inspected = await this.#delegate.inspectCapabilities();
    if (!inspected.ok) return inspected;
    if (
      inspected.value.provider !== this.#provider ||
      [...this.#models].some((model) => !inspected.value.models.includes(model))
    ) {
      return err(domainError("invariant_violation"));
    }
    return inspected;
  }

  async start(
    request: ProviderRunRequest,
    options: ReadOptions = {},
  ): Promise<Result<ProviderRunHandle, DomainError>> {
    if (!this.#roles.has(request.role)) return err(domainError("permission_denied"));
    if (!this.#models.has(request.model)) return err(domainError("invariant_violation"));
    const inspected = await this.inspectCapabilities();
    if (!inspected.ok || !inspected.value.models.includes(request.model)) {
      return inspected.ok ? err(domainError("invariant_violation")) : inspected;
    }
    return this.#delegate.start(request, options);
  }
}
