import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createSettingsUseCase,
  FileSettingsStore,
  renderSettingsContent,
  serializeUserSettingsYaml,
  userSettingsSchema,
  type UserSettings,
} from "../../src/ui/features/settings/index.js";
import { privateFileMode } from "../../src/infrastructure/files/index.js";

const temporaryDirectories: string[] = [];

const settings: UserSettings = Object.freeze({
  schemaVersion: 1,
  webhook: Object.freeze({ runtimeBaseUrl: null }),
  concurrency: Object.freeze({
    globalModelJobs: 2,
    perProviderModelJobs: Object.freeze({ codex: 1, claude: 1, gemini: 1 }),
    perProjectModelJobs: 2,
    perRepositoryIntegrationJobs: 1,
  }),
});

function percentEncodeAll(value: string): string {
  return [...Buffer.from(value, "utf8")]
    .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
    .join("");
}

function percentEncode(value: string, passes: number): string {
  let encoded = value;
  for (let pass = 0; pass < passes; pass += 1) encoded = percentEncodeAll(encoded);
  return encoded;
}

function markerUrls(): readonly Readonly<{ marker: string; url: string }>[] {
  const markers = [
    ["github", "_pat_", "abcdefghijklmnopqrstuvwxyz"].join(""),
    ["lin", "_api_", "abcdefghijklmnopqrstuv"].join(""),
    ["AI", "za", "abcdefghijklmnopqrstuvwxyz123456789"].join(""),
    ["eyJ", "abcdefghijk", ".", "abcdefghijkl", ".", "abcdefghijkl"].join(""),
  ];
  return markers.flatMap((marker) => {
    return [
      ...[0, 1, 2, 3].map((passes) =>
        Object.freeze({
          marker,
          url: `https://hooks.example.test/discard/${percentEncode(marker, passes)}/../safe`,
        }),
      ),
      Object.freeze({
        marker,
        url: `https://hooks.example.test/discard%2f${percentEncode(marker, 1)}%2f%2e%2e%2fsafe`,
      }),
      Object.freeze({
        marker,
        url: `https://hooks.example.test/discard%5c${percentEncode(marker, 1)}%5c%2e%2e%5csafe`,
      }),
      Object.freeze({
        marker,
        url: `https://hooks.example.test/discard/${percentEncode(marker, 1)}/%2e%2e/safe`,
      }),
      Object.freeze({
        marker,
        url: `https://hooks.example.test/discard%252f${percentEncode(marker, 2)}%252f%252e%252e%252fsafe`,
      }),
    ];
  });
}

async function temporaryStore(): Promise<
  Readonly<{ root: string; path: string; store: FileSettingsStore }>
> {
  const root = await mkdtemp(join(tmpdir(), "agent-team-settings-"));
  temporaryDirectories.push(root);
  const path = join(root, "config", "user-settings.yaml");
  await mkdir(join(root, "config"), { mode: 0o700 });
  return Object.freeze({ root, path, store: new FileSettingsStore(path) });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe("U008 atomic private settings store", () => {
  it("writes private canonical YAML, reads it back, and removes temp/lock files", async () => {
    const fixture = await temporaryStore();

    const saved = await fixture.store.save(null, settings);

    expect(saved.state).toBe("saved");
    if (saved.state !== "saved") throw new Error("expected confirmed save");
    expect(saved.stored.settings).toEqual(settings);
    expect(saved.stored.rawYaml).toBe(serializeUserSettingsYaml(settings));
    expect(saved.stored.revision).toMatch(/^[a-f0-9]{64}$/u);
    expect((await stat(fixture.path)).mode & 0o777).toBe(privateFileMode);
    expect((await stat(join(fixture.root, "config"))).mode & 0o777).toBe(0o700);
    const names = await readdir(join(fixture.root, "config"));
    expect(names).toEqual([basename(fixture.path)]);
    await expect(fixture.store.read()).resolves.toEqual({ ok: true, value: saved.stored });
  });

  it("uses expected-revision CAS so stale and racing writers cannot overwrite", async () => {
    const fixture = await temporaryStore();
    const initial = await fixture.store.save(null, settings);
    if (initial.state !== "saved") throw new Error("expected initial save");
    const firstUpdate: UserSettings = {
      ...settings,
      concurrency: { ...settings.concurrency, globalModelJobs: 3 },
    };
    const secondUpdate: UserSettings = {
      ...settings,
      concurrency: { ...settings.concurrency, globalModelJobs: 4 },
    };

    const [first, second] = await Promise.all([
      fixture.store.save(initial.stored.revision, firstUpdate),
      fixture.store.save(initial.stored.revision, secondUpdate),
    ]);

    expect([first.state, second.state].sort()).toEqual(["conflict", "saved"]);
    const stored = await fixture.store.read();
    if (!stored.ok) throw new Error(stored.error.code);
    const winner = first.state === "saved" ? firstUpdate : secondUpdate;
    expect(stored.value.settings).toEqual(winner);
  });

  it.each([
    ["malformed", "schemaVersion: nope\n"],
    ["unknown", `${serializeUserSettingsYaml(settings)}unknown: true\n`],
    ["secret-looking", "schemaVersion: 1\npassword: do-not-read-back\n"],
  ])("fails closed when the authoritative file is %s", async (_name, rawYaml) => {
    const fixture = await temporaryStore();
    await writeFile(fixture.path, rawYaml, { encoding: "utf8", mode: 0o600 });

    const read = await fixture.store.read();

    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("invalid config must fail closed");
    expect(read.error.code).toBe("invariant_violation");
  });

  it("does not overwrite the previous file when a candidate is invalid", async () => {
    const fixture = await temporaryStore();
    const initial = await fixture.store.save(null, settings);
    if (initial.state !== "saved") throw new Error("expected initial save");
    const before = await readFile(fixture.path, "utf8");

    const invalid = await fixture.store.save(initial.stored.revision, {
      ...settings,
      concurrency: { ...settings.concurrency, perRepositoryIntegrationJobs: 2 },
    });

    expect(invalid).toEqual({ state: "rejected" });
    await expect(readFile(fixture.path, "utf8")).resolves.toBe(before);
  });

  it("restores private directory permissions before writing", async () => {
    const fixture = await temporaryStore();
    await fixture.store.save(null, settings);
    await chmod(join(fixture.root, "config"), 0o777);

    const current = await fixture.store.read();
    if (!current.ok) throw new Error(current.error.code);
    const saved = await fixture.store.save(current.value.revision, settings);

    expect(saved.state).toBe("saved");
    expect((await stat(join(fixture.root, "config"))).mode & 0o777).toBe(0o700);
  });

  it("fails closed instead of reading a settings file exposed to other users", async () => {
    const fixture = await temporaryStore();
    await writeFile(fixture.path, serializeUserSettingsYaml(settings), {
      encoding: "utf8",
      mode: 0o644,
    });

    const read = await fixture.store.read();

    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("non-private settings must fail closed");
    expect(read.error.code).toBe("invariant_violation");
  });

  it.each(markerUrls())(
    "does not save, read, or render a raw/encoded credential URL $url",
    async ({ marker, url }) => {
      const fixture = await temporaryStore();
      const initial = await fixture.store.save(null, settings);
      if (initial.state !== "saved") throw new Error("expected initial settings");
      const useCase = createSettingsUseCase(fixture.store);
      const candidate: UserSettings = {
        ...settings,
        webhook: { runtimeBaseUrl: url },
      };

      const saved = await useCase.saveRaw({
        expectedRevision: initial.stored.revision,
        rawYaml: [
          "schemaVersion: 1",
          "webhook:",
          `  runtimeBaseUrl: ${JSON.stringify(url)}`,
          "concurrency:",
          "  globalModelJobs: 2",
          "  perProviderModelJobs:",
          "    codex: 1",
          "    claude: 1",
          "    gemini: 1",
          "  perProjectModelJobs: 2",
          "  perRepositoryIntegrationJobs: 1",
          "",
        ].join("\n"),
      });
      const readModel = await useCase.read();
      const html = renderSettingsContent(readModel);
      const authoritative = await readFile(fixture.path, "utf8");

      expect(userSettingsSchema.safeParse(candidate).success).toBe(false);
      expect(saved).toEqual({ state: "rejected", reason: "invalid_settings" });
      expect(authoritative).toBe(initial.stored.rawYaml);
      expect(JSON.stringify(readModel)).not.toContain(marker);
      expect(JSON.stringify(readModel)).not.toContain(url);
      expect(html).not.toContain(marker);
      expect(html).not.toContain(url);
    },
  );
});
