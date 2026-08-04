import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { GhTransport } from "../../src/adapters/github/index.js";

const temporaryDirectories: string[] = [];

async function fakeGh(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-team-fake-gh-"));
  temporaryDirectories.push(root);
  const executable = join(root, "gh");
  await writeFile(
    executable,
    `#!/bin/sh
behavior="$FAKE_GH_BEHAVIOR"
[ -n "$behavior" ] || behavior="ok"
case "$behavior" in
  hang) while :; do sleep 1; done ;;
  malformed) printf 'not-json'; exit 0 ;;
  large)
    index=0
    while [ "$index" -lt 5000 ]; do printf 'x'; index=$((index + 1)); done
    exit 0
    ;;
  error:*) printf '%s' "$behavior" | cut -c 7- >&2; exit 1 ;;
esac
case " $* " in
  *" user "*) printf '{"login":"fixture-user","id":42}' ;;
  *"/rulesets "*) printf '{"count":0}' ;;
  *"/protection "*)
    if [ "$FAKE_GH_PROTECTION" = "forbidden" ]; then
      printf 'HTTP 403: forbidden' >&2
    else
      printf 'HTTP 404: Not Found' >&2
    fi
    exit 1
    ;;
  *" repos/"*) printf '{"visibility":"public","private":false,"defaultBranch":"main","allowAutoMerge":true,"deleteBranchOnMerge":false,"permissions":{"admin":true,"maintain":true,"pull":true,"push":true}}' ;;
  *) printf '{"ok":true}' ;;
esac
`,
    "utf8",
  );
  await chmod(executable, 0o755);
  return executable;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("gh transport", () => {
  it("maps authentication to a stable fingerprint without exposing login", async () => {
    const executable = await fakeGh();
    const result = await new GhTransport({ executable }).inspectAuthentication();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.active).toBe(true);
    expect(result.value.host).toBe("github.com");
    expect(result.value.accountFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(result.value)).not.toContain("fixture-user");
  });

  it("separates repository capability from unconfigured merge gates", async () => {
    const executable = await fakeGh();
    const result = await new GhTransport({ executable }).inspectRepositoryCapabilities(
      "owner/repository",
      "main",
    );
    expect(result).toEqual({
      ok: true,
      value: {
        visibility: "public",
        private: false,
        defaultBranch: "main",
        allowAutoMerge: true,
        deleteBranchOnMerge: false,
        permissions: { admin: true, maintain: true, pull: true, push: true },
        rulesets: { available: true, count: 0 },
        branchProtection: { available: false, failure: "not_found_or_not_configured" },
        requiredMergeGate: "unconfigured",
      },
    });
  });

  it("keeps merge-gate configuration unverified when protection is unreadable", async () => {
    const executable = await fakeGh();
    const result = await new GhTransport({
      executable,
      environment: { FAKE_GH_PROTECTION: "forbidden" },
    }).inspectRepositoryCapabilities("owner/repository", "main");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rulesets).toEqual({ available: true, count: 0 });
    expect(result.value.branchProtection).toEqual({
      available: false,
      failure: "permission_denied",
    });
    expect(result.value.requiredMergeGate).toBe("unverified");
  });

  it.each([
    ["HTTP 401: unauthorized", "permission_denied"],
    ["HTTP 403: forbidden", "permission_denied"],
    ["HTTP 404: Not Found", "not_found"],
    ["HTTP 429: rate limit exceeded", "rate_limited"],
    ["network connection reset", "unavailable"],
  ])("maps gh failure %s without returning stderr", async (message, code) => {
    const executable = await fakeGh();
    const result = await new GhTransport({
      executable,
      environment: { FAKE_GH_BEHAVIOR: `error:${message}` },
    }).requestJson(["api", "user"], z.unknown());
    expect(result.ok ? "ok" : result.error.code).toBe(code);
    expect(JSON.stringify(result)).not.toContain(message);
  });

  it("fails closed on malformed JSON, schema drift, oversized output, and unsafe argv", async () => {
    const executable = await fakeGh();
    const malformed = await new GhTransport({
      executable,
      environment: { FAKE_GH_BEHAVIOR: "malformed" },
    }).requestJson(["api", "user"], z.object({ ok: z.boolean() }).strict());
    expect(malformed.ok ? "ok" : malformed.error.code).toBe("external_failure");

    const drift = await new GhTransport({ executable }).requestJson(
      ["api", "user"],
      z.object({ unexpected: z.literal(true) }).strict(),
    );
    expect(drift.ok ? "ok" : drift.error.code).toBe("external_failure");

    const oversized = await new GhTransport({
      executable,
      maxOutputBytes: 1024,
      environment: { FAKE_GH_BEHAVIOR: "large" },
    }).requestJson(["api", "user"], z.unknown());
    expect(oversized.ok ? "ok" : oversized.error.code).toBe("external_failure");

    const unsafe = await new GhTransport({ executable }).requestJson(
      ["api", "user\n--show-token"],
      z.unknown(),
    );
    expect(unsafe.ok ? "ok" : unsafe.error.code).toBe("external_failure");
  });

  it("maps timeout, abort, and missing executable deterministically", async () => {
    const executable = await fakeGh();
    const timedOut = await new GhTransport({
      executable,
      timeoutMs: 10,
      environment: { FAKE_GH_BEHAVIOR: "hang" },
    }).requestJson(["api", "user"], z.unknown());
    expect(timedOut.ok ? "ok" : timedOut.error.code).toBe("timeout");

    const controller = new AbortController();
    controller.abort();
    const interrupted = await new GhTransport({ executable }).requestJson(
      ["api", "user"],
      z.unknown(),
      { signal: controller.signal },
    );
    expect(interrupted.ok ? "ok" : interrupted.error.code).toBe("interrupted");

    const unavailable = await new GhTransport({ executable: `${executable}-missing` }).requestJson(
      ["api", "user"],
      z.unknown(),
    );
    expect(unavailable.ok ? "ok" : unavailable.error.code).toBe("unavailable");
  });
});
