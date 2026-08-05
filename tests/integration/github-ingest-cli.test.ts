import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const cli = resolve("dist/cli/index.js");
const body = Buffer.from('{"repository":{"id":42}}', "utf8");
const secret = Buffer.from("compiled-github-webhook-secret", "utf8");

async function setup(signatureSecret = secret) {
  const root = await mkdtemp(join(tmpdir(), "agent-team-compiled-ingest-"));
  roots.push(root);
  const secretFile = join(root, "secrets", "github-webhook-secret");
  const headersFile = join(root, "headers.json");
  await mkdir(join(root, "secrets"), { recursive: true });
  await writeFile(secretFile, secret, { mode: 0o600 });
  await chmod(secretFile, 0o600);
  await writeFile(
    headersFile,
    JSON.stringify({
      "content-type": "application/json",
      "x-hub-signature-256": `sha256=${createHmac("sha256", signatureSecret).update(body).digest("hex")}`,
      "x-github-delivery": "compiled-delivery-1",
      "x-github-event": "push",
    }),
  );
  return { root, headersFile };
}

function run(root: string, headersFile: string) {
  return spawnSync(process.execPath, [cli, "ingest", "github", "--headers-file", headersFile], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: body,
    timeout: 10_000,
    env: { ...process.env, AGENT_TEAM_HOME: root },
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("compiled GitHub ingest CLI", () => {
  it("accepts exact stdin bytes, exits 0, and persists one private Inbox record", async () => {
    const fixture = await setup();
    const accepted = run(fixture.root, fixture.headersFile);
    const duplicate = run(fixture.root, fixture.headersFile);
    const inboxDirectory = join(fixture.root, "state", "inbox");

    expect(accepted.error).toBeUndefined();
    expect(accepted.status).toBe(0);
    expect(JSON.parse(accepted.stdout)).toMatchObject({
      accepted: true,
      classification: "accepted",
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
    const record = JSON.parse(await readFile(recordPath, "utf8")) as {
      bodyBase64: string;
    };
    expect(Buffer.from(record.bodyBase64, "base64")).toEqual(body);
  });

  it("returns exit 1 for an invalid signature and leaves Inbox absent", async () => {
    const fixture = await setup(Buffer.from("wrong-secret"));
    const rejected = run(fixture.root, fixture.headersFile);

    expect(rejected.error).toBeUndefined();
    expect(rejected.status).toBe(1);
    expect(rejected.stdout).toBe("");
    expect(JSON.parse(rejected.stderr)).toEqual({
      accepted: false,
      statusCode: 401,
      reason: "invalid_signature",
    });
    await expect(readdir(join(fixture.root, "state", "inbox"))).rejects.toBeDefined();
  });
});
