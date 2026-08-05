import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileLocalUiPreviewConfirmationAuthority } from "../../src/adapters/registration/index.js";
import { parseInstant, type Clock } from "../../src/domain/foundation/index.js";
import { projectIdSchema } from "../../src/domain/project/index.js";
import { sha256Digest } from "../../src/domain/review/index.js";

const authorityDigest = "a".repeat(64);
const projectId = projectIdSchema.parse("project_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const previewDigest = sha256Digest("preview");
if (!previewDigest.ok) throw new Error(previewDigest.error.code);
const binding = Object.freeze({
  setupSessionId: "setup-session-authority-1",
  projectId,
  previewDigest: previewDigest.value,
});

function clock(initial = "2026-08-06T12:00:00.000Z") {
  let instant = initial;
  const value: Clock = {
    now: () => {
      const parsed = parseInstant(instant);
      if (!parsed.ok) throw new Error(parsed.error.code);
      return parsed.value;
    },
  };
  return { value, set: (next: string) => (instant = next) };
}

describe("durable local-UI preview confirmation authority", () => {
  it("persists, consumes once, and permits only the same idempotent recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-preview-authority-"));
    const time = clock();
    const issued = await new FileLocalUiPreviewConfirmationAuthority(root, time.value).issue(
      binding,
      authorityDigest,
      { idempotencyKey: "preview:issue:1" },
    );
    expect(issued).toMatchObject({ ok: true, value: { state: "issued" } });
    if (!issued.ok || issued.value.state !== "issued") return;

    const restarted = new FileLocalUiPreviewConfirmationAuthority(root, time.value);
    await expect(
      restarted.verify(issued.value.grant.confirmation, authorityDigest, {
        idempotencyKey: "preview:consume:1",
      }),
    ).resolves.toEqual({ ok: true, value: { state: "verified" } });
    await expect(
      restarted.verify(issued.value.grant.confirmation, authorityDigest, {
        idempotencyKey: "preview:consume:1",
      }),
    ).resolves.toEqual({ ok: true, value: { state: "verified" } });
    await expect(
      restarted.verify(issued.value.grant.confirmation, authorityDigest, {
        idempotencyKey: "preview:consume:replay",
      }),
    ).resolves.toEqual({ ok: true, value: { state: "rejected" } });
  });

  it("rejects authority/session/preview drift and expiry without consuming another grant", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-preview-authority-negative-"));
    const time = clock();
    const authority = new FileLocalUiPreviewConfirmationAuthority(root, time.value);
    const issued = await authority.issue(binding, authorityDigest, {
      idempotencyKey: "preview:issue:negative",
    });
    if (!issued.ok || issued.value.state !== "issued") throw new Error("grant not issued");
    const token = issued.value.grant.confirmation;

    await expect(
      authority.verify(token, "c".repeat(64), { idempotencyKey: "preview:wrong-authority" }),
    ).resolves.toEqual({ ok: true, value: { state: "rejected" } });
    await expect(
      authority.verify({ ...token, setupSessionId: "setup-session-forged" }, authorityDigest, {
        idempotencyKey: "preview:wrong-session",
      }),
    ).resolves.toEqual({ ok: true, value: { state: "rejected" } });
    const driftDigest = sha256Digest("drift");
    if (!driftDigest.ok) throw new Error(driftDigest.error.code);
    await expect(
      authority.verify({ ...token, previewDigest: driftDigest.value }, authorityDigest, {
        idempotencyKey: "preview:wrong-digest",
      }),
    ).resolves.toEqual({ ok: true, value: { state: "rejected" } });

    time.set("2026-08-06T12:05:00.001Z");
    await expect(
      authority.verify(token, authorityDigest, { idempotencyKey: "preview:expired" }),
    ).resolves.toEqual({ ok: true, value: { state: "rejected" } });
  });
});
