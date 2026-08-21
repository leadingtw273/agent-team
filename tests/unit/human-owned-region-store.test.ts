import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileHumanOwnedRegionReservationStore } from "../../src/adapters/dispatch/human-owned-region-store.js";
import { createFixedClock, parseInstant } from "../../src/domain/foundation/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-human-owned-region-"));
  temporaryDirectories.push(directory);
  return directory;
}

function instant(value: string) {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const now = instant("2026-08-21T03:00:00.000Z");
const projectId = "project_018f47d2-77a4-7cc1-8ef2-0123456789ab";
const otherProjectId = "project_018f47d2-77a4-7cc1-8ef2-1123456789ab";
const repositoryId = "github:owner/repository";
const baselineRevision = "a".repeat(40);
const baselineWorkingTreeDigest = "b".repeat(64);

function input(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    reservationId: "018f47d2-77a4-7cc1-8ef2-0123456789ab",
    projectId,
    owner: "leadi",
    repositoryId,
    regions: [{ path: "scenes/main.tscn", coverage: "exact" as const }],
    baselineRevision,
    baselineWorkingTreeDigest,
    ...overrides,
  };
}

async function fixture() {
  const directory = await temporaryDirectory();
  return {
    directory,
    store: new FileHumanOwnedRegionReservationStore(directory, undefined, createFixedClock(now)),
  };
}

describe("FileHumanOwnedRegionReservationStore", () => {
  it("stores canonical regions privately and replays an identical reservation idempotently", async () => {
    const { directory, store } = await fixture();
    const reserved = await store.reserve(
      input({
        regions: [
          { path: "scenes/z.tscn", coverage: "exact" },
          { path: "scenes/a.tscn", coverage: "exact" },
        ],
      }),
    );
    expect(reserved).toMatchObject({
      ok: true,
      value: {
        revision: 0,
        state: "active",
        regions: [
          { path: "scenes/a.tscn", coverage: "exact" },
          { path: "scenes/z.tscn", coverage: "exact" },
        ],
      },
    });
    expect(
      await store.reserve(input({ regions: reserved.ok ? reserved.value.regions : [] })),
    ).toEqual(reserved);
    const stat = await (
      await import("node:fs/promises")
    ).stat(join(directory, `${projectId}.json`));
    expect(stat.mode & 0o077).toBe(0);
  });

  it("rejects ambiguous or internally overlapping regions", async () => {
    const { store } = await fixture();
    await expect(
      store.reserve(
        input({
          regions: [
            { path: "scenes", coverage: "subtree" },
            { path: "scenes/main.tscn", coverage: "exact" },
          ],
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: "invariant_violation" } });
  });

  it("prevents overlapping active reservations and permits disjoint regions", async () => {
    const { store } = await fixture();
    await store.reserve(input({ regions: [{ path: "scenes", coverage: "subtree" }] }));
    await expect(
      store.reserve(
        input({
          reservationId: "018f47d2-77a4-7cc1-8ef2-1123456789ab",
          regions: [{ path: "scenes/main.tscn", coverage: "exact" }],
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: "conflict" } });
    await expect(
      store.reserve(
        input({
          reservationId: "018f47d2-77a4-7cc1-8ef2-2123456789ab",
          regions: [{ path: "scripts/tank.gd", coverage: "exact" }],
        }),
      ),
    ).resolves.toMatchObject({ ok: true, value: { state: "active" } });
  });

  it("blocks admission on overlap or baseline drift and allows a disjoint candidate", async () => {
    const { store } = await fixture();
    await store.reserve(input());
    await expect(
      store.checkAdmission({
        projectId,
        repositoryId,
        currentRevision: baselineRevision,
        regions: [{ path: "scenes/main.tscn", coverage: "exact" }],
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { state: "blocked", reason: "human_owned_region_overlap" },
    });
    await expect(
      store.checkAdmission({
        projectId,
        repositoryId,
        currentRevision: "c".repeat(40),
        regions: [{ path: "scripts/tank.gd", coverage: "exact" }],
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { state: "blocked", reason: "reservation_identity_drift" },
    });
    await expect(
      store.checkAdmission({
        projectId,
        repositoryId,
        currentRevision: baselineRevision,
        regions: [{ path: "scripts/tank.gd", coverage: "exact" }],
      }),
    ).resolves.toEqual({ ok: true, value: { state: "allowed" } });
  });

  it("releases with CAS and keeps project inventories isolated", async () => {
    const { store } = await fixture();
    const reserved = await store.reserve(input());
    if (!reserved.ok) throw new Error(reserved.error.code);
    await store.reserve(
      input({
        reservationId: "018f47d2-77a4-7cc1-8ef2-1123456789ab",
        projectId: otherProjectId,
      }),
    );
    await expect(store.listActive(projectId)).resolves.toMatchObject({
      ok: true,
      value: [{ projectId }],
    });
    const released = await store.release(
      projectId,
      reserved.value.reservationId,
      reserved.value.revision,
      "received",
    );
    expect(released).toMatchObject({
      ok: true,
      value: { revision: 1, state: "released", releaseReason: "received" },
    });
    expect(await store.release(projectId, reserved.value.reservationId, 0, "received")).toEqual(
      released,
    );
    await expect(store.listActive(projectId)).resolves.toEqual({ ok: true, value: [] });
  });

  it("fails closed on corrupted state without overwriting it", async () => {
    const { directory, store } = await fixture();
    const path = join(directory, `${projectId}.json`);
    await writeFile(path, '{"schemaVersion":2,"rawDiff":"must-stay"}\n', { mode: 0o600 });
    const before = await readFile(path, "utf8");
    await expect(store.listActive(projectId)).resolves.toMatchObject({
      ok: false,
      error: { code: "invariant_violation" },
    });
    await expect(store.reserve(input())).resolves.toMatchObject({
      ok: false,
      error: { code: "invariant_violation" },
    });
    expect(await readFile(path, "utf8")).toBe(before);
  });
});
