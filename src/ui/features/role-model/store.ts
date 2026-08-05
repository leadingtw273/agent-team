import type {
  ActiveModelAssignment,
  ModelRoutingConfig,
} from "../../../application/routing/index.js";
import { defaultRoleModelRoutingConfig } from "./catalog.js";
import {
  cloneActiveModelAssignment,
  cloneRoleModelRoutingConfig,
  validateRoleModelSettings,
} from "./schema.js";

export interface RoleModelSettingsStore {
  read: () => Promise<unknown>;
  replace: (config: ModelRoutingConfig) => Promise<void>;
}

export interface ActiveModelAssignmentReader {
  read: () => Promise<readonly unknown[]>;
}

export class InMemoryRoleModelSettingsStore implements RoleModelSettingsStore {
  #value: ModelRoutingConfig;

  constructor(initial: unknown = defaultRoleModelRoutingConfig()) {
    const parsed = validateRoleModelSettings(initial);
    if (!parsed.ok) throw new TypeError("Invalid initial role model settings.");
    this.#value = parsed.value;
  }

  read(): Promise<unknown> {
    return Promise.resolve(cloneRoleModelRoutingConfig(this.#value));
  }

  replace(config: ModelRoutingConfig): Promise<void> {
    const parsed = validateRoleModelSettings(config);
    if (!parsed.ok) throw new TypeError("Invalid role model settings.");
    this.#value = parsed.value;
    return Promise.resolve();
  }
}

export class InMemoryActiveModelAssignmentReader implements ActiveModelAssignmentReader {
  #value: readonly ActiveModelAssignment[];

  constructor(assignments: readonly ActiveModelAssignment[] = []) {
    this.#value = Object.freeze(assignments.map(cloneActiveModelAssignment));
  }

  read(): Promise<readonly unknown[]> {
    return Promise.resolve(Object.freeze(this.#value.map(cloneActiveModelAssignment)));
  }
}
