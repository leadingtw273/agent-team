import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createClaudeQuotaRefresher } from "../../src/adapters/providers/claude/index.js";
import { ChildProcessRunner } from "../../src/adapters/process/index.js";
import { createClock } from "../../src/domain/foundation/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Claude quota refresher PTY integration", () => {
  it("observes a fake interactive response, sends Ctrl-D, and exits cleanly", async () => {
    const root = await mkdtemp(join(tmpdir(), "quota-refresh-pty-"));
    roots.push(root);
    const snapshotPath = join(root, "latest.json");
    const fakeClaude = join(root, "fake-claude.mjs");
    await writeFile(
      fakeClaude,
      `#!/usr/bin/env node
import { writeFileSync, utimesSync } from "node:fs";
const seconds = Math.floor(Date.now() / 1000);
writeFileSync(${JSON.stringify(snapshotPath)}, JSON.stringify({
  schema: 1,
  probe_ts: seconds,
  session_id: "fake-session",
  rate_limits: {
    five_hour: { used_percentage: 10, resets_at: seconds + 3600 },
    seven_day: { used_percentage: 20, resets_at: seconds + 86400 }
  }
}), { mode: 0o600 });
utimesSync(${JSON.stringify(snapshotPath)}, seconds, seconds);
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  if ([...chunk].includes(4)) process.exit(0);
});
setTimeout(() => process.exit(2), 5000);
`,
      { mode: 0o700 },
    );
    await chmod(fakeClaude, 0o700);

    const refresher = createClaudeQuotaRefresher({
      process: new ChildProcessRunner(),
      claudeExecutable: fakeClaude,
      workingDirectory: root,
      clock: createClock(),
      timeoutMs: 10_000,
      pollIntervalMs: 25,
    });

    await expect(
      refresher.refresh({
        statusSnapshotPath: snapshotPath,
        expectedCliVersion: "2.1.231",
        maxSampleAgeMs: 60_000,
      }),
    ).resolves.toEqual({ state: "refreshed", reason: "snapshot_refreshed" });
  });
});
