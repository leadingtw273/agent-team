import type { ModelRoutingConfig } from "../../../application/routing/index.js";
import type { UiFeatureRegistration } from "../../registry/index.js";
import { createRoleModelUiFeatureRegistration } from "./registration.js";
import {
  InMemoryActiveModelAssignmentReader,
  InMemoryRoleModelSettingsStore,
  type ActiveModelAssignmentReader,
  type RoleModelSettingsStore,
} from "./store.js";
import { RoleModelSettingsUseCase, type RoleModelSettingsSnapshot } from "./use-case.js";
import { renderRoleModelPage } from "./view.js";

export interface CreateRoleModelFeatureOptions {
  readonly settingsStore?: RoleModelSettingsStore;
  readonly activeAssignments?: ActiveModelAssignmentReader;
}

export class RoleModelFeature {
  readonly #useCase: RoleModelSettingsUseCase;

  constructor(useCase: RoleModelSettingsUseCase) {
    this.#useCase = useCase;
  }

  read() {
    return this.#useCase.read();
  }

  save(input: unknown) {
    return this.#useCase.save(input);
  }

  async render(): Promise<string> {
    const result = await this.read();
    if (!result.ok) {
      return '<section class="card ui-panel"><div class="card-body"><h2>無法讀取角色與模型設定</h2><p class="mb-0">設定保持未變更；請稍後重新整理或檢查本機設定儲存體。</p></div></section>';
    }
    return renderRoleModelPage(result.value);
  }

  async readSnapshot(): Promise<RoleModelSettingsSnapshot | undefined> {
    const result = await this.read();
    return result.ok ? result.value : undefined;
  }

  uiFeatureRegistration(): UiFeatureRegistration {
    return createRoleModelUiFeatureRegistration(this);
  }
}

export function createRoleModelFeature(
  options: CreateRoleModelFeatureOptions = {},
): RoleModelFeature {
  return new RoleModelFeature(
    new RoleModelSettingsUseCase({
      settingsStore: options.settingsStore ?? new InMemoryRoleModelSettingsStore(),
      activeAssignments:
        options.activeAssignments ??
        new InMemoryActiveModelAssignmentReader([
          {
            jobId: "job-running-implementer",
            role: "implementer",
            candidate: { provider: "claude", model: "sonnet" },
            candidateIndex: 1,
          },
        ]),
    }),
  );
}

export type RoleModelSaveInput = ModelRoutingConfig;
