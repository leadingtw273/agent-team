import { describe, expect, it } from "vitest";

import { selectModelRoute } from "../../src/application/routing/index.js";
import {
  InMemoryActiveModelAssignmentReader,
  InMemoryRoleModelSettingsStore,
  RoleModelSettingsUseCase,
  defaultRoleModelRoutingConfig,
  renderRoleModelPage,
  type RoleModelSettingsStore,
} from "../../src/ui/features/role-model/index.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function reorderedImplementerConfig(): ReturnType<typeof defaultRoleModelRoutingConfig> {
  const input = clone(defaultRoleModelRoutingConfig());
  return {
    ...input,
    routes: input.routes.map((route) =>
      route.role === "implementer"
        ? { ...route, candidates: [...route.candidates].reverse() }
        : route,
    ),
  };
}

function reorderedTeamLeadConfig(): ReturnType<typeof defaultRoleModelRoutingConfig> {
  const input = clone(defaultRoleModelRoutingConfig());
  return {
    ...input,
    routes: input.routes.map((route) =>
      route.role === "team_lead"
        ? { ...route, candidates: [...route.candidates].reverse() }
        : route,
    ),
  };
}

class CountingStore implements RoleModelSettingsStore {
  readonly #inner: InMemoryRoleModelSettingsStore;
  writes = 0;

  constructor(initial = defaultRoleModelRoutingConfig()) {
    this.#inner = new InMemoryRoleModelSettingsStore(initial);
  }

  read() {
    return this.#inner.read();
  }

  replace(config: Parameters<InMemoryRoleModelSettingsStore["replace"]>[0]) {
    this.writes += 1;
    return this.#inner.replace(config);
  }
}

class MismatchingReadBackStore implements RoleModelSettingsStore {
  readonly replacements: Parameters<RoleModelSettingsStore["replace"]>[0][] = [];
  readonly #readBack: ReturnType<typeof defaultRoleModelRoutingConfig>;

  constructor(readBack = reorderedTeamLeadConfig()) {
    this.#readBack = clone(readBack);
  }

  read(): Promise<unknown> {
    return Promise.resolve(clone(this.#readBack));
  }

  replace(config: Parameters<RoleModelSettingsStore["replace"]>[0]): Promise<void> {
    this.replacements.push(clone(config));
    return Promise.resolve();
  }
}

function createUseCase(store: RoleModelSettingsStore = new InMemoryRoleModelSettingsStore()) {
  return new RoleModelSettingsUseCase({
    settingsStore: store,
    activeAssignments: new InMemoryActiveModelAssignmentReader([
      {
        jobId: "job-running-implementer",
        role: "implementer",
        candidate: { provider: "claude", model: "sonnet" },
        candidateIndex: 1,
      },
    ]),
  });
}

describe("role model settings use case", () => {
  it("reads every standard role with an ordered, known candidate catalogue", async () => {
    const result = await createUseCase().read();

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value.routes.map((route) => route.role)).toEqual([
      "team_lead",
      "implementer",
      "code_reviewer",
      "visual_reviewer",
      "integration_engineer",
    ]);
    const candidates = result.value.routes.flatMap((route) => route.candidates);
    const codex = candidates.find(
      (candidate) => candidate.provider === "codex" && candidate.model === "gpt-5.6-sol",
    );
    const gemini = candidates.find(
      (candidate) => candidate.provider === "gemini" && candidate.model === "auto",
    );
    expect(codex?.providerLabel).toBe("Codex");
    expect(codex?.capabilities).toContain("架構與整合");
    expect(gemini?.providerLabel).toBe("Gemini");
    expect(gemini?.capabilities).toContain("視覺審查");
  });

  it("saves the reordered configuration by read-back and leaves active assignments unchanged", async () => {
    const useCase = createUseCase();
    const next = reorderedImplementerConfig();

    const saved = await useCase.save(next);

    expect(saved).toMatchObject({ ok: true });
    if (!saved.ok) return;
    const implementer = saved.value.routes.find((route) => route.role === "implementer");
    expect(
      implementer?.candidates.map((candidate) => `${candidate.provider}:${candidate.model}`),
    ).toEqual(["claude:sonnet", "codex:gpt-5.6-terra"]);
    expect(saved.value.activeAssignments).toEqual([
      {
        jobId: "job-running-implementer",
        role: "implementer",
        candidate: { provider: "claude", model: "sonnet" },
        candidateIndex: 1,
      },
    ]);

    const nextJob = selectModelRoute(saved.value.config, "implementer", [
      { provider: "codex", model: "gpt-5.6-terra", state: "ready" },
      { provider: "claude", model: "sonnet", state: "ready" },
    ]);
    expect(nextJob).toMatchObject({
      kind: "selected",
      candidate: { provider: "claude", model: "sonnet" },
      candidateIndex: 0,
    });

    const reread = await useCase.read();
    expect(reread).toEqual(saved);
  });

  it("reports a read-back mismatch after one write without attempting an unsafe rollback", async () => {
    const conflictingReadBack = reorderedTeamLeadConfig();
    const store = new MismatchingReadBackStore(conflictingReadBack);
    const next = reorderedImplementerConfig();

    const result = await createUseCase(store).save(next);

    expect(result).toEqual({ ok: false, error: { code: "read_back_mismatch" } });
    expect(store.replacements).toEqual([next]);
    expect(await store.read()).toEqual(conflictingReadBack);
  });

  it("renders action labels for enabled SSR controls and boundary labels only when disabled", async () => {
    const result = await createUseCase().read();
    if (!result.ok) throw new Error(result.error.code);

    const page = renderRoleModelPage(result.value);

    expect(page).toMatch(
      /data-role-model-move="up" aria-label="Codex \/ gpt-5\.6-sol 已在最上" disabled>已在最上<\/button>/u,
    );
    expect(page).toMatch(
      /data-role-model-move="down" aria-label="將 Codex \/ gpt-5\.6-sol 下移">下移<\/button>/u,
    );
  });

  it.each([
    [
      "invalid model route schema",
      {
        schemaVersion: 1,
        routes: [],
      },
      "invalid_input",
    ],
    [
      "duplicate candidate",
      (() => {
        const input = clone(defaultRoleModelRoutingConfig());
        const firstRoute = input.routes[0];
        if (firstRoute === undefined) throw new Error("expected a team lead route");
        input.routes[0] = {
          ...firstRoute,
          candidates: [
            { provider: "codex", model: "gpt-5.6-sol" },
            { provider: "codex", model: "gpt-5.6-sol" },
          ],
        };
        return input;
      })(),
      "invalid_input",
    ],
    [
      "unknown candidate",
      (() => {
        const input = clone(defaultRoleModelRoutingConfig());
        const firstRoute = input.routes[0];
        if (firstRoute === undefined) throw new Error("expected a team lead route");
        input.routes[0] = {
          ...firstRoute,
          candidates: [{ provider: "codex", model: "not-a-known-model" }],
        };
        return input;
      })(),
      "unknown_candidate",
    ],
  ] as const)(
    "fails closed for %s without overwriting the stored setting",
    async (_name, input, code) => {
      const store = new CountingStore();
      const useCase = createUseCase(store);
      const before = await useCase.read();

      const result = await useCase.save(input);

      expect(result).toMatchObject({ ok: false, error: { code } });
      expect(store.writes).toBe(0);
      expect(await useCase.read()).toEqual(before);
    },
  );
});
