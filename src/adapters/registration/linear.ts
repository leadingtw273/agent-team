import type {
  RegistrationLinearReadOnlyProbePort,
  ReadOptions,
} from "../../application/ports/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { LinearReadModel } from "../linear/index.js";

export interface LinearRegistrationReadOnlyClient {
  readonly readContext: (
    teamId: string,
    projectId: string,
    options?: ReadOptions,
  ) => Promise<Result<unknown, DomainError>>;
}

export interface LinearRegistrationReadOnlyProbeOptions {
  readonly teamId?: string;
  readonly projectId?: string;
  readonly client?: LinearRegistrationReadOnlyClient;
  readonly now?: () => string;
}

function observedAt(clock: () => string): string {
  const candidate = clock();
  return Number.isFinite(Date.parse(candidate)) ? candidate : new Date().toISOString();
}

function configuredIdentifier(value: string | undefined): value is string {
  return value !== undefined && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value);
}

/**
 * Reuses LinearReadModel's GraphQL query path. The concrete transport and its
 * credential remain injected outside the UI, and O002 never invokes a mutation.
 */
export class LinearRegistrationReadOnlyProbeAdapter implements RegistrationLinearReadOnlyProbePort {
  readonly #teamId: string | undefined;
  readonly #projectId: string | undefined;
  readonly #client: LinearRegistrationReadOnlyClient | undefined;
  readonly #now: () => string;

  constructor(options: LinearRegistrationReadOnlyProbeOptions = {}) {
    this.#teamId = options.teamId;
    this.#projectId = options.projectId;
    this.#client = options.client;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async inspect(
    options: ReadOptions = {},
  ): ReturnType<RegistrationLinearReadOnlyProbePort["inspect"]> {
    const at = observedAt(this.#now);
    if (!configuredIdentifier(this.#teamId) || !configuredIdentifier(this.#projectId)) {
      return ok({
        state: "unknown",
        evidence: Object.freeze(["尚未設定 Linear Team 與 Project 的 read-only 目標。"]),
        provenance: "linear_read_only",
        observedAt: at,
      });
    }
    if (this.#client === undefined) {
      return ok({
        state: "unknown",
        evidence: Object.freeze(["尚未注入 Linear read-only adapter，因此未發出外部查詢。"]),
        provenance: "linear_read_only",
        observedAt: at,
      });
    }
    if (options.signal?.aborted === true) return err(domainError("interrupted"));
    const context = await this.#client.readContext(this.#teamId, this.#projectId, options);
    if (!context.ok) return context;
    return ok({
      state: "passed",
      evidence: Object.freeze(["已以 Linear read-only query 確認指定 Team 與 Project。"]),
      provenance: "linear_read_only",
      observedAt: at,
    });
  }
}

/** Allows Runtime composition to pass the existing adapter without exposing its transport. */
export function asLinearRegistrationReadOnlyClient(
  readModel: Pick<LinearReadModel, "readContext">,
): LinearRegistrationReadOnlyClient {
  return Object.freeze({
    readContext: (teamId: string, projectId: string, options?: ReadOptions) =>
      readModel.readContext(teamId, projectId, options),
  });
}
