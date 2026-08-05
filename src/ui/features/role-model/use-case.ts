import type {
  ActiveModelAssignment,
  ModelRoutingConfig,
} from "../../../application/routing/index.js";
import { err, ok, type Result } from "../../../domain/foundation/index.js";
import { findRoleModelCandidate, findRoleModelRole } from "./catalog.js";
import {
  cloneActiveModelAssignment,
  cloneRoleModelRoutingConfig,
  validateActiveModelAssignments,
  validateRoleModelSettings,
  type RoleModelSettingsError,
} from "./schema.js";
import type { ActiveModelAssignmentReader, RoleModelSettingsStore } from "./store.js";

export interface RoleModelCandidateView {
  readonly provider: "codex" | "claude" | "gemini";
  readonly model: string;
  readonly providerLabel: "Codex" | "Claude" | "Gemini";
  readonly capabilities: readonly string[];
}

export interface RoleModelRouteView {
  readonly role:
    "team_lead" | "implementer" | "code_reviewer" | "visual_reviewer" | "integration_engineer";
  readonly label: string;
  readonly description: string;
  readonly candidates: readonly RoleModelCandidateView[];
}

export interface RoleModelSettingsSnapshot {
  readonly config: ModelRoutingConfig;
  readonly routes: readonly RoleModelRouteView[];
  readonly activeAssignments: readonly ActiveModelAssignment[];
}

export interface RoleModelSettingsUseCasePorts {
  readonly settingsStore: RoleModelSettingsStore;
  readonly activeAssignments: ActiveModelAssignmentReader;
}

type RoleModelResult = Result<RoleModelSettingsSnapshot, RoleModelSettingsError>;

function sameConfig(left: ModelRoutingConfig, right: ModelRoutingConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function routesFor(config: ModelRoutingConfig): readonly RoleModelRouteView[] {
  return Object.freeze(
    config.routes.map((route) => {
      const definition = findRoleModelRole(route.role);
      return Object.freeze({
        role: route.role,
        label: definition.label,
        description: definition.description,
        candidates: Object.freeze(
          route.candidates.map((candidate) => {
            const known = findRoleModelCandidate(candidate);
            if (known === undefined) throw new TypeError("Unknown candidate reached view model.");
            return Object.freeze({
              provider: known.provider,
              model: known.model,
              providerLabel: known.providerLabel,
              capabilities: Object.freeze([...known.capabilities]),
            });
          }),
        ),
      });
    }),
  );
}

export class RoleModelSettingsUseCase {
  readonly #settingsStore: RoleModelSettingsStore;
  readonly #activeAssignments: ActiveModelAssignmentReader;

  constructor(ports: RoleModelSettingsUseCasePorts) {
    this.#settingsStore = ports.settingsStore;
    this.#activeAssignments = ports.activeAssignments;
  }

  async read(): Promise<RoleModelResult> {
    const config = await this.#readStoredConfig();
    if (!config.ok) return config;
    return this.#snapshot(config.value);
  }

  async save(input: unknown): Promise<RoleModelResult> {
    const next = validateRoleModelSettings(input);
    if (!next.ok) return next;

    const current = await this.#readStoredConfig();
    if (!current.ok) return current;

    try {
      await this.#settingsStore.replace(next.value);
    } catch {
      return err(Object.freeze({ code: "store_unavailable" }));
    }

    const readBack = await this.#readStoredConfig();
    if (!readBack.ok) return readBack;
    if (!sameConfig(next.value, readBack.value)) {
      return err(Object.freeze({ code: "read_back_mismatch" }));
    }
    return this.#snapshot(readBack.value);
  }

  async #readStoredConfig(): Promise<Result<ModelRoutingConfig, RoleModelSettingsError>> {
    try {
      const stored = await this.#settingsStore.read();
      const parsed = validateRoleModelSettings(stored);
      return parsed.ok ? parsed : err(Object.freeze({ code: "stored_config_invalid" }));
    } catch {
      return err(Object.freeze({ code: "store_unavailable" }));
    }
  }

  async #snapshot(config: ModelRoutingConfig): Promise<RoleModelResult> {
    try {
      const assignments = await this.#activeAssignments.read();
      const parsed = validateActiveModelAssignments(assignments);
      if (!parsed.ok) return parsed;
      return ok(
        Object.freeze({
          config: cloneRoleModelRoutingConfig(config),
          routes: routesFor(config),
          activeAssignments: Object.freeze(parsed.value.map(cloneActiveModelAssignment)),
        }),
      );
    } catch {
      return err(Object.freeze({ code: "store_unavailable" }));
    }
  }
}
