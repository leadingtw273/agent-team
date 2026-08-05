import type { DispatchSlotLimits } from "../../../application/dispatch/index.js";
import { containsSensitiveValue } from "../../../infrastructure/redaction/index.js";
import { parseUserSettingsYaml, serializeUserSettingsYaml } from "./yaml.js";
import { DEFAULT_USER_SETTINGS, userSettingsSchema, type UserSettings } from "./schema.js";
import type { SettingsStore, StoredUserSettings } from "./store.js";

export type SettingsReadModel =
  | Readonly<{
      state: "ready";
      source: "defaults" | "persisted";
      revision: string | null;
      webhookRuntimeBaseUrl: string | null;
      concurrency: DispatchSlotLimits;
      rawYaml: string;
      saveEnabled: false;
    }>
  | Readonly<{ state: "error"; message: string }>;

export type SaveRawSettingsResult =
  | Readonly<{ state: "saved"; model: Extract<SettingsReadModel, { state: "ready" }> }>
  | Readonly<{
      state: "rejected";
      reason: "conflict" | "invalid_settings" | "store_failure" | "write_unconfirmed";
    }>;

export interface SettingsUseCase {
  readonly read: () => Promise<SettingsReadModel>;
  readonly saveRaw: (command: unknown) => Promise<SaveRawSettingsResult>;
}

function readyModel(
  settings: UserSettings,
  source: "defaults" | "persisted",
  revision: string | null,
  rawYaml: string,
): SettingsReadModel {
  const validated = userSettingsSchema.safeParse(settings);
  const parsedYaml = parseUserSettingsYaml(rawYaml);
  if (
    !validated.success ||
    !parsedYaml.ok ||
    serializeUserSettingsYaml(validated.data) !== serializeUserSettingsYaml(parsedYaml.value) ||
    containsSensitiveValue(rawYaml) ||
    (settings.webhook.runtimeBaseUrl !== null &&
      containsSensitiveValue(settings.webhook.runtimeBaseUrl))
  ) {
    return Object.freeze({ state: "error", message: "設定目前無法安全讀取。" });
  }
  return Object.freeze({
    state: "ready",
    source,
    revision,
    webhookRuntimeBaseUrl: settings.webhook.runtimeBaseUrl,
    concurrency: settings.concurrency,
    rawYaml,
    saveEnabled: false,
  });
}

function persistedModel(stored: StoredUserSettings): SettingsReadModel {
  return readyModel(stored.settings, "persisted", stored.revision, stored.rawYaml);
}

function saveCommand(
  value: unknown,
): Readonly<{ expectedRevision: string | null; rawYaml: string }> | undefined {
  if (typeof value !== "object" || value === null || Object.keys(value).length !== 2) {
    return undefined;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const expectedRevision = record["expectedRevision"];
  const rawYaml = record["rawYaml"];
  if (
    (expectedRevision !== null &&
      (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/u.test(expectedRevision))) ||
    typeof rawYaml !== "string"
  ) {
    return undefined;
  }
  return Object.freeze({ expectedRevision, rawYaml });
}

export function createSettingsUseCase(store: SettingsStore): SettingsUseCase {
  const read = async (): Promise<SettingsReadModel> => {
    const stored = await store.read();
    if (stored.ok) return persistedModel(stored.value);
    if (stored.error.code === "not_found") {
      return readyModel(
        DEFAULT_USER_SETTINGS,
        "defaults",
        null,
        serializeUserSettingsYaml(DEFAULT_USER_SETTINGS),
      );
    }
    return Object.freeze({ state: "error", message: "設定目前無法安全讀取。" });
  };

  const saveRaw = async (input: unknown): Promise<SaveRawSettingsResult> => {
    const command = saveCommand(input);
    if (command === undefined) {
      return Object.freeze({ state: "rejected", reason: "invalid_settings" });
    }
    const parsed = parseUserSettingsYaml(command.rawYaml);
    if (!parsed.ok) return Object.freeze({ state: "rejected", reason: "invalid_settings" });
    const saved = await store.save(command.expectedRevision, parsed.value);
    switch (saved.state) {
      case "saved": {
        const model = persistedModel(saved.stored);
        return model.state === "ready"
          ? Object.freeze({ state: "saved", model })
          : Object.freeze({ state: "rejected", reason: "write_unconfirmed" });
      }
      case "conflict":
        return Object.freeze({ state: "rejected", reason: "conflict" });
      case "unconfirmed":
        return Object.freeze({ state: "rejected", reason: "write_unconfirmed" });
      case "failed":
      case "rejected":
        return Object.freeze({ state: "rejected", reason: "store_failure" });
    }
  };

  return Object.freeze({ read, saveRaw });
}
