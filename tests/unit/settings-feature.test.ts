import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_USER_SETTINGS,
  createSettingsUseCase,
  parseUserSettingsYaml,
  renderSettingsPage,
  serializeUserSettingsYaml,
  userSettingsSchema,
  type SettingsStore,
  type StoredUserSettings,
} from "../../src/ui/features/settings/index.js";
import { domainError, err, ok } from "../../src/domain/foundation/index.js";

const configuredSettings = Object.freeze({
  schemaVersion: 1 as const,
  webhook: Object.freeze({ runtimeBaseUrl: "https://hooks.example.test/agent-team" }),
  concurrency: Object.freeze({
    globalModelJobs: 2,
    perProviderModelJobs: Object.freeze({ codex: 1, claude: 1, gemini: 1 }),
    perProjectModelJobs: 2,
    perRepositoryIntegrationJobs: 1 as const,
  }),
});

function withWebhookRuntimeUrl(runtimeBaseUrl: string) {
  return Object.freeze({ ...configuredSettings, webhook: Object.freeze({ runtimeBaseUrl }) });
}

function percentEncode(value: string, passes: number): string {
  let encoded = value;
  for (let pass = 0; pass < passes; pass += 1) {
    encoded = [...Buffer.from(encoded, "utf8")]
      .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
      .join("");
  }
  return encoded;
}

function storedSettings(revision = "a".repeat(64)): StoredUserSettings {
  const rawYaml = serializeUserSettingsYaml(configuredSettings);
  return Object.freeze({ settings: configuredSettings, rawYaml, revision });
}

describe("U008 user settings schema and controlled YAML", () => {
  it("accepts the established webhook and dispatch concurrency shape", () => {
    expect(userSettingsSchema.parse(configuredSettings)).toEqual(configuredSettings);
    expect(userSettingsSchema.parse(DEFAULT_USER_SETTINGS)).toEqual(DEFAULT_USER_SETTINGS);
  });

  it.each([
    { ...configuredSettings, extra: true },
    { ...configuredSettings, webhook: { runtimeBaseUrl: "http://hooks.example.test" } },
    { ...configuredSettings, webhook: { runtimeBaseUrl: "https://user:password@example.test" } },
    { ...configuredSettings, webhook: { runtimeBaseUrl: "https://example.test/?token=secret" } },
    {
      ...configuredSettings,
      concurrency: { ...configuredSettings.concurrency, perRepositoryIntegrationJobs: 2 },
    },
    {
      ...configuredSettings,
      concurrency: {
        ...configuredSettings.concurrency,
        globalModelJobs: 1,
        perProjectModelJobs: 2,
      },
    },
  ])("fails closed for invalid, unknown, or secret-looking input", (input) => {
    expect(userSettingsSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    "https://localhost/hooks",
    "https://localhost./hooks",
    "https://localhost.example.test/hooks",
    "https://example.localhost/hooks",
    "https://127.0.0.1/hooks",
    "https://127.255.255.254/hooks",
    "https://127.1/hooks",
    "https://2130706433/hooks",
    "https://0x7f000001/hooks",
    "https://[::1]/hooks",
    "https://[0:0:0:0:0:0:0:1]/hooks",
    "https://[::ffff:127.0.0.1]/hooks",
    "https://[::ffff:7f00:1]/hooks",
    "https://ｌｏｃａｌｈｏｓｔ/hooks",
  ])("rejects localhost and loopback URL representation %s", (runtimeBaseUrl) => {
    expect(userSettingsSchema.safeParse(withWebhookRuntimeUrl(runtimeBaseUrl)).success).toBe(false);
  });

  const normalizationMarker = ["github", "_pat_", "abcdefghijklmnopqrstuvwxyz"].join("");
  it.each([
    `https://hooks.example.test/discard/${normalizationMarker}/../safe`,
    `https://hooks.example.test/discard/${percentEncode(normalizationMarker, 1)}/../safe`,
    `https://hooks.example.test/discard/${percentEncode(normalizationMarker, 2)}/../safe`,
    `https://hooks.example.test/discard/${percentEncode(normalizationMarker, 3)}/../safe`,
    `https://hooks.example.test/discard%2f${percentEncode(normalizationMarker, 1)}%2f%2e%2e%2fsafe`,
    `https://hooks.example.test/discard%5c${percentEncode(normalizationMarker, 1)}%5c%2e%2e%5csafe`,
    `https://hooks.example.test/discard/${percentEncode(normalizationMarker, 1)}/%2e%2e/safe`,
    `https://hooks.example.test/discard%252f${percentEncode(normalizationMarker, 2)}%252f%252e%252e%252fsafe`,
  ])("rejects a credential erased or obscured by URL normalization %s", (runtimeBaseUrl) => {
    expect(userSettingsSchema.safeParse(withWebhookRuntimeUrl(runtimeBaseUrl)).success).toBe(false);
  });

  it.each([
    "https://hooks.example.test/agent-team",
    "https://bücher.example/hooks",
    "https://[2001:db8::1]/hooks",
    "https://local-host.example/hooks",
    "https://localhostish.example/hooks",
  ])("accepts an external HTTPS parser boundary %s", (runtimeBaseUrl) => {
    expect(userSettingsSchema.safeParse(withWebhookRuntimeUrl(runtimeBaseUrl)).success).toBe(true);
  });

  it.each([
    "https://hooks.example.test/%ZZ",
    "https://hooks.example.test/%",
    "https://hooks.example.test/%25252525252541",
  ])("rejects malformed or over-encoded path %s", (runtimeBaseUrl) => {
    expect(userSettingsSchema.safeParse(withWebhookRuntimeUrl(runtimeBaseUrl)).success).toBe(false);
  });

  it("round-trips only the canonical schema-owned YAML subset", () => {
    const rawYaml = serializeUserSettingsYaml(configuredSettings);

    expect(rawYaml).toBe(
      'schemaVersion: 1\nwebhook:\n  runtimeBaseUrl: "https://hooks.example.test/agent-team"\nconcurrency:\n  globalModelJobs: 2\n  perProviderModelJobs:\n    codex: 1\n    claude: 1\n    gemini: 1\n  perProjectModelJobs: 2\n  perRepositoryIntegrationJobs: 1\n',
    );
    expect(parseUserSettingsYaml(rawYaml)).toEqual({ ok: true, value: configuredSettings });
  });

  it.each([
    "schemaVersion: 1\nunknown: true\n",
    "schemaVersion: 1\nschemaVersion: 1\n",
    "schemaVersion: 1\nsecret: ghp_never-store-this\n",
    "schemaVersion: 1\nwebhook:\n  runtimeBaseUrl: !env WEBHOOK_URL\n",
    "schemaVersion: 1\nwebhook: &webhook\n",
    'schemaVersion: 1\nwebhook:\n  runtimeBaseUrl: "https://example.test/?api_key=secret"\n',
  ])("rejects uncontrolled, duplicate, tagged, anchored, or secret-looking YAML", (rawYaml) => {
    const parsed = parseUserSettingsYaml(rawYaml);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("unsafe YAML must fail closed");
    expect(parsed.error.code).toBe("invariant_violation");
  });
});

describe("U008 settings use case", () => {
  it("renders defaults without claiming persisted configuration", async () => {
    const store: SettingsStore = {
      read: vi.fn(() => Promise.resolve(err(domainError("not_found")))),
      save: vi.fn(),
    };
    const useCase = createSettingsUseCase(store);

    const model = await useCase.read();

    expect(model).toMatchObject({
      state: "ready",
      source: "defaults",
      revision: null,
      webhookRuntimeBaseUrl: null,
      concurrency: DEFAULT_USER_SETTINGS.concurrency,
      saveEnabled: false,
    });
    expect(model.state === "ready" ? model.rawYaml : "").not.toMatch(
      /(?:secret|token|password|authorization)/iu,
    );
  });

  it("saves schema-valid canonical YAML with expected-revision CAS", async () => {
    const current = storedSettings();
    const next = Object.freeze({ ...current, revision: "b".repeat(64) });
    const store: SettingsStore = {
      read: vi.fn(() => Promise.resolve(ok(current))),
      save: vi.fn(() => Promise.resolve(Object.freeze({ state: "saved" as const, stored: next }))),
    };
    const useCase = createSettingsUseCase(store);

    const result = await useCase.saveRaw({
      expectedRevision: current.revision,
      rawYaml: current.rawYaml,
    });

    expect(result.state).toBe("saved");
    if (result.state !== "saved") throw new Error("expected saved settings");
    expect(result.model.revision).toBe(next.revision);
    expect(store.save).toHaveBeenCalledWith(current.revision, configuredSettings);
  });

  it.each([
    ["unknown key", `${serializeUserSettingsYaml(configuredSettings)}unknown: true\n`],
    ["secret-looking", "schemaVersion: 1\npassword: never-store-this\n"],
    ["malformed", "schemaVersion: nope\n"],
  ])("does not call the store or overwrite on %s raw YAML", async (_name, rawYaml) => {
    const store: SettingsStore = {
      read: vi.fn(() => Promise.resolve(ok(storedSettings()))),
      save: vi.fn(),
    };
    const useCase = createSettingsUseCase(store);

    const result = await useCase.saveRaw({ expectedRevision: "a".repeat(64), rawYaml });

    expect(result).toEqual({ state: "rejected", reason: "invalid_settings" });
    expect(store.save).not.toHaveBeenCalled();
  });

  it("does not claim a CAS conflict or unconfirmed write completed", async () => {
    const store: SettingsStore = {
      read: vi.fn(() => Promise.resolve(ok(storedSettings()))),
      save: vi
        .fn()
        .mockResolvedValueOnce(Object.freeze({ state: "conflict" }))
        .mockResolvedValueOnce(Object.freeze({ state: "unconfirmed" })),
    };
    const useCase = createSettingsUseCase(store);
    const command = {
      expectedRevision: "a".repeat(64),
      rawYaml: serializeUserSettingsYaml(configuredSettings),
    };

    await expect(useCase.saveRaw(command)).resolves.toEqual({
      state: "rejected",
      reason: "conflict",
    });
    await expect(useCase.saveRaw(command)).resolves.toEqual({
      state: "rejected",
      reason: "write_unconfirmed",
    });
  });

  it("does not propagate a credential marker from a compromised store into the read model", async () => {
    const marker = ["lin", "_api_", "abcdefghijklmnopqrstuv"].join("");
    const compromised = Object.freeze({
      settings: withWebhookRuntimeUrl(`https://hooks.example.test/${marker}`),
      rawYaml: `${serializeUserSettingsYaml(DEFAULT_USER_SETTINGS)}# ${marker}\n`,
      revision: "a".repeat(64),
    });
    const store: SettingsStore = {
      read: vi.fn(() => Promise.resolve(ok(compromised))),
      save: vi.fn(),
    };

    const model = await createSettingsUseCase(store).read();

    expect(model).toEqual({ state: "error", message: "設定目前無法安全讀取。" });
    expect(JSON.stringify(model)).not.toContain(marker);
  });
});

describe("U008 settings view", () => {
  it("renders a real settings page with read-only raw YAML and disabled save", async () => {
    const store: SettingsStore = {
      read: vi.fn(() => Promise.resolve(ok(storedSettings()))),
      save: vi.fn(),
    };
    const model = await createSettingsUseCase(store).read();

    const html = renderSettingsPage(model);

    expect(html).toContain('<html lang="zh-Hant">');
    expect(html).toContain("設定｜Agent Team");
    expect(html).toContain("Webhook Runtime URL");
    expect(html).toContain("全域模型工作");
    expect(html).toContain("進階 Raw YAML（唯讀）");
    expect(html).toContain('wrap="off"');
    expect(html).toContain("readonly");
    expect(html).toContain("disabled");
    expect(html).toContain("預設為唯讀；切換至受控編輯後才會送出");
    expect(html).toContain('<script src="/assets/settings.js" defer>');
    expect(html).not.toContain("<script>");
    expect(html).not.toMatch(/(?:--token|--secret|api[_-]?key|authorization:|bearer\s)/iu);
  });

  it("escapes read-model values and never renders invalid store content", () => {
    const html = renderSettingsPage(
      Object.freeze({ state: "error", message: '<script data-secret="token">bad</script>' }),
    );

    expect(html).not.toContain('<script data-secret="token">');
    expect(html).not.toContain("data-secret");
    expect(html).toContain("設定目前無法安全讀取");
    expect(html).not.toContain("<textarea");
  });

  it("does not render a credential marker from a forged ready read model", () => {
    const marker = ["github", "_pat_", "abcdefghijklmnopqrstuvwxyz"].join("");
    const html = renderSettingsPage(
      Object.freeze({
        state: "ready",
        source: "persisted",
        revision: "a".repeat(64),
        webhookRuntimeBaseUrl: `https://hooks.example.test/${marker}`,
        concurrency: DEFAULT_USER_SETTINGS.concurrency,
        rawYaml: `${serializeUserSettingsYaml(DEFAULT_USER_SETTINGS)}# ${marker}\n`,
        saveEnabled: false,
      }),
    );

    expect(html).not.toContain(marker);
    expect(html).toContain("設定目前無法安全讀取");
    expect(html).not.toContain("<textarea");
  });
});
