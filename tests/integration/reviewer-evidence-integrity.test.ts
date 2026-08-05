import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalReviewerEvidenceIntegrity } from "../../src/adapters/evidence/index.js";
import type { ReviewEvidenceBlock } from "../../src/application/pipelines/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-review-evidence-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function evidence(path: string, sha256: string): Extract<ReviewEvidenceBlock, { kind: "file" }> {
  return {
    kind: "file",
    category: "visual_artifact",
    source: "artifact:screen",
    mediaType: "image/png",
    path,
    sha256,
    repositoryPath: "evidence/screen.png",
  };
}

describe("LocalReviewerEvidenceIntegrity", () => {
  it("hashes a stable regular file and rejects a mismatched digest", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "screen.png");
    const bytes = Buffer.from("fixture-image-bytes", "utf8");
    await writeFile(path, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const verifier = new LocalReviewerEvidenceIntegrity();

    await expect(verifier.verify(evidence(path, sha256))).resolves.toEqual({
      ok: true,
      value: { verified: true, byteLength: bytes.length },
    });
    await expect(verifier.verify(evidence(path, "0".repeat(64)))).resolves.toEqual({
      ok: true,
      value: { verified: false, byteLength: bytes.length },
    });
  });

  it("rejects symbolic links and relative paths", async () => {
    const root = await temporaryDirectory();
    const target = join(root, "target.png");
    const link = join(root, "link.png");
    const bytes = Buffer.from("fixture", "utf8");
    await writeFile(target, bytes);
    await symlink(target, link);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const verifier = new LocalReviewerEvidenceIntegrity();

    await expect(verifier.verify(evidence(link, sha256))).resolves.toMatchObject({
      ok: true,
      value: { verified: false },
    });
    const relative = await verifier.verify(evidence("screen.png", sha256));
    expect(relative.ok).toBe(false);
    if (!relative.ok) expect(relative.error.code).toBe("invariant_violation");
  });

  it("honors an already-aborted read", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await new LocalReviewerEvidenceIntegrity().verify(
      evidence("/tmp/unused.png", "0".repeat(64)),
      { signal: controller.signal },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("interrupted");
  });
});
