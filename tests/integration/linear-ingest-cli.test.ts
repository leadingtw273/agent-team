import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const cli = resolve("dist/cli/index.js");
const secret = Buffer.from("compiled-linear-webhook-secret", "utf8");

function body(timestamp = Date.now()): Buffer {
  return Buffer.from(
    JSON.stringify({
      action: "update",
      type: "Issue",
      webhookTimestamp: timestamp,
      data: { id: "compiled-linear-issue-1" },
    }),
    "utf8",
  );
}

async function setup(rawBody: Buffer, signatureBody = rawBody) {
  const root = await mkdtemp(join(tmpdir(), "agent-team-compiled-linear-ingest-"));
  roots.push(root);
  const secretFile = join(root, "secrets", "linear-webhook-secret");
  const headersFile = join(root, "headers.json");
  await mkdir(join(root, "secrets"), { recursive: true });
  await writeFile(secretFile, secret, { mode: 0o600 });
  await chmod(secretFile, 0o600);
  await writeFile(
    headersFile,
    JSON.stringify({
      "content-type": "application/json",
      "linear-signature": createHmac("sha256", secret).update(signatureBody).digest("hex"),
      "linear-delivery": "compiled-linear-delivery-1",
      "linear-event": "UnknownFutureEvent",
    }),
  );
  return { root, headersFile };
}

function run(root: string, headersFile: string, rawBody: Buffer) {
  return spawnSync(process.execPath, [cli, "ingest", "linear", "--headers-file", headersFile], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: rawBody,
    timeout: 10_000,
    env: { ...process.env, AGENT_TEAM_HOME: root },
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("compiled Linear ingest CLI", () => {
  it("accepts stdin bytes, preserves unknown events, deduplicates, and persists privately", async () => {
    const rawBody = body();
    const fixture = await setup(rawBody);
    const accepted = run(fixture.root, fixture.headersFile, rawBody);
    const duplicate = run(fixture.root, fixture.headersFile, rawBody);
    const inboxDirectory = join(fixture.root, "state", "inbox");

    expect(accepted.error).toBeUndefined();
    expect(accepted.status).toBe(0);
    expect(JSON.parse(accepted.stdout)).toMatchObject({
      accepted: true,
      classification: "accepted",
      eventType: "UnknownFutureEvent",
    });
    expect(accepted.stderr).toBe("");
    expect(duplicate.status).toBe(0);
    expect(JSON.parse(duplicate.stdout)).toMatchObject({
      accepted: true,
      classification: "duplicate",
    });
    const entries = (await readdir(inboxDirectory)).filter((name) => name.endsWith(".json"));
    expect(entries).toHaveLength(1);
    const recordPath = join(inboxDirectory, entries[0] ?? "");
    expect((await stat(recordPath)).mode & 0o777).toBe(0o600);
    const record = JSON.parse(await readFile(recordPath, "utf8")) as { bodyBase64: string };
    expect(Buffer.from(record.bodyBase64, "base64")).toEqual(rawBody);
  });

  it("returns exit 1 for a stale timestamp and leaves Inbox absent", async () => {
    const rawBody = body(Date.now() - 120_000);
    const fixture = await setup(rawBody);
    const rejected = run(fixture.root, fixture.headersFile, rawBody);

    expect(rejected.error).toBeUndefined();
    expect(rejected.status).toBe(1);
    expect(rejected.stdout).toBe("");
    expect(JSON.parse(rejected.stderr)).toEqual({
      accepted: false,
      statusCode: 401,
      reason: "stale_timestamp",
    });
    await expect(readdir(join(fixture.root, "state", "inbox"))).rejects.toBeDefined();
  });

  it("verifies the exact raw bytes rather than a reserialized equivalent", async () => {
    const original = body();
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(original.toString()), null, 2));
    const fixture = await setup(reserialized, original);
    const rejected = run(fixture.root, fixture.headersFile, reserialized);

    expect(rejected.error).toBeUndefined();
    expect(rejected.status).toBe(1);
    expect(JSON.parse(rejected.stderr)).toMatchObject({ reason: "invalid_signature" });
  });
});
