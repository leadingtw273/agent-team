import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { fixtureArtifact } from "./fixtures.js";
import { LiveArtifactWriter, replayLiveArtifactFile, serializeLiveArtifact } from "./writer.js";

const roots: string[] = [];

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-t09-writer-"));
  roots.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("T09 artifact writer and file replay", () => {
  it("canonicalizes, atomically writes, reads back, and replays a green artifact", async () => {
    const directory = await root();
    const artifact = fixtureArtifact();
    const clone = structuredClone(artifact);
    expect(
      Buffer.from(serializeLiveArtifact(artifact) ?? []).equals(
        Buffer.from(serializeLiveArtifact(clone) ?? []),
      ),
    ).toBe(true);
    const writer = new LiveArtifactWriter(directory);
    await expect(writer.write("artifact.json", artifact)).resolves.toEqual({ state: "written" });
    await expect(replayLiveArtifactFile(directory, "artifact.json")).resolves.toMatchObject({
      state: "replayed",
      report: { overall: "pass" },
    });
  });

  it("does not skip missing, unsafe, malformed, or red artifacts", async () => {
    const directory = await root();
    const writer = new LiveArtifactWriter(directory);
    await expect(replayLiveArtifactFile(directory, "missing.json")).resolves.toEqual({
      state: "failed",
      reasonCode: "artifact_not_found",
    });
    await expect(replayLiveArtifactFile(directory, "../escape.json")).resolves.toEqual({
      state: "failed",
      reasonCode: "target_invalid",
    });
    await expect(replayLiveArtifactFile(directory, "/tmp/escape.json")).resolves.toEqual({
      state: "failed",
      reasonCode: "target_invalid",
    });
    await mkdir(join(directory, "directory.json"));
    await expect(replayLiveArtifactFile(directory, "directory.json")).resolves.toEqual({
      state: "failed",
      reasonCode: "read_failed",
    });
    await symlink(join(directory, "missing-target"), join(directory, "link.json"));
    await expect(replayLiveArtifactFile(directory, "link.json")).resolves.toEqual({
      state: "failed",
      reasonCode: "read_failed",
    });
    await writeFile(join(directory, "invalid.json"), "not-json");
    await expect(replayLiveArtifactFile(directory, "invalid.json")).resolves.toEqual({
      state: "failed",
      reasonCode: "parse_failed",
    });
    await writeFile(join(directory, "proto.json"), '{"__proto__":{"polluted":true}}');
    await expect(replayLiveArtifactFile(directory, "proto.json")).resolves.toEqual({
      state: "failed",
      reasonCode: "parse_failed",
    });
    await writeFile(
      join(directory, "unknown.json"),
      JSON.stringify({ ...fixtureArtifact(), extra: true }),
    );
    await expect(replayLiveArtifactFile(directory, "unknown.json")).resolves.toEqual({
      state: "failed",
      reasonCode: "parse_failed",
    });
    await writeFile(join(directory, "oversized.json"), "x".repeat(2 * 1024 * 1024 + 1));
    await expect(replayLiveArtifactFile(directory, "oversized.json")).resolves.toEqual({
      state: "failed",
      reasonCode: "read_failed",
    });
    const red = fixtureArtifact();
    red.authorities.git = { status: "missing", reasonCode: "not_found" };
    await expect(writer.write("red.json", red)).resolves.toEqual({
      state: "failed",
      reasonCode: "replay_failed",
    });
  });

  it("fails closed before writing prototype-shaped input or through a symlink root", async () => {
    const directory = await root();
    const ownProto: unknown = JSON.parse('{"__proto__":{"polluted":true}}');
    await expect(new LiveArtifactWriter(directory).write("unsafe.json", ownProto)).resolves.toEqual(
      { state: "failed", reasonCode: "write_failed" },
    );
    const linkRoot = join(directory, "linked-root");
    await symlink(directory, linkRoot);
    await expect(
      new LiveArtifactWriter(linkRoot).write("artifact.json", fixtureArtifact()),
    ).resolves.toEqual({ state: "failed", reasonCode: "target_invalid" });
    const fileRoot = join(directory, "not-a-directory");
    await writeFile(fileRoot, "x");
    await expect(
      new LiveArtifactWriter(fileRoot).write("artifact.json", fixtureArtifact()),
    ).resolves.toEqual({ state: "failed", reasonCode: "target_invalid" });
  });

  it("does not treat a post-write byte tamper as replay success", async () => {
    const directory = await root();
    const writer = new LiveArtifactWriter(directory);
    await expect(writer.write("artifact.json", fixtureArtifact())).resolves.toEqual({
      state: "written",
    });
    const tampered = fixtureArtifact();
    tampered.authorities.git = { status: "missing", reasonCode: "not_found" };
    await writeFile(join(directory, "artifact.json"), JSON.stringify(tampered));
    await expect(replayLiveArtifactFile(directory, "artifact.json")).resolves.toEqual({
      state: "failed",
      reasonCode: "replay_failed",
    });
  });
});
