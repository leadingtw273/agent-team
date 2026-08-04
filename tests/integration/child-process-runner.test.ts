import { afterEach, describe, expect, it } from "vitest";

import { ChildProcessRunner } from "../../src/adapters/process/index.js";
import { instantFromDate, type Instant } from "../../src/domain/foundation/index.js";
import type { ChildProcessHandle, ProcessSpawnRequest } from "../../src/application/ports/index.js";

const activeHandles = new Set<ChildProcessHandle>();

function deadline(milliseconds = 2_000): Instant {
  const parsed = instantFromDate(new Date(Date.now() + milliseconds));
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function request(
  script: string,
  overrides: Partial<ProcessSpawnRequest> = {},
): ProcessSpawnRequest {
  return {
    executable: "/bin/sh",
    arguments: ["-c", script],
    workingDirectory: process.cwd(),
    deadlineAt: deadline(),
    maxOutputBytes: 64 * 1024,
    ...overrides,
  };
}

async function collect(handle: ChildProcessHandle): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of handle.output) {
    chunks.push(
      `${String(chunk.sequence)}:${chunk.stream}:${Buffer.from(chunk.bytes).toString("utf8")}`,
    );
  }
  return chunks.join("");
}

async function spawned(
  runner: ChildProcessRunner,
  input: ProcessSpawnRequest,
): Promise<ChildProcessHandle> {
  const result = await runner.spawn(input);
  if (!result.ok) throw new Error(result.error.code);
  activeHandles.add(result.value);
  return result.value;
}

afterEach(async () => {
  for (const handle of activeHandles) {
    const completion = await Promise.race([
      handle.wait(),
      new Promise<undefined>((resolve) =>
        setTimeout(() => {
          resolve(undefined);
        }, 5),
      ),
    ]);
    if (completion === undefined) await handle.sendSignal("SIGKILL");
    await handle.wait();
  }
  activeHandles.clear();
});

describe("child process runner", () => {
  it("captures sequenced stdout/stderr, exit, and the direct parent relationship", async () => {
    const handle = await spawned(
      new ChildProcessRunner(),
      request('printf "parent=%s\\n" "$PPID"; printf "warning\\n" >&2; exit 7'),
    );
    const [output, exit] = await Promise.all([collect(handle), handle.wait()]);

    expect(output).toContain(`stdout:parent=${String(process.pid)}\n`);
    expect(output).toContain("stderr:warning\n");
    expect(exit).toMatchObject({
      ok: true,
      value: { exitCode: 7, signal: null, outputTruncated: false },
    });
  });

  it("writes stdin and redacts sensitive environment values across stream chunks", async () => {
    const secret = "environment-secret-value";
    const handle = await spawned(
      new ChildProcessRunner(),
      request(
        'IFS= read -r body; printf "%.8s" "$TEST_SECRET"; sleep 0.01; rest=${TEST_SECRET#????????}; printf "%s\\nstdin=%s\\n" "$rest" "$body"',
        {
          environment: { TEST_SECRET: secret },
          sensitiveEnvironmentKeys: ["TEST_SECRET"],
          stdin: Buffer.from("hello", "utf8"),
        },
      ),
    );
    const [output, exit] = await Promise.all([collect(handle), handle.wait()]);

    expect(exit.ok && exit.value.exitCode).toBe(0);
    expect(output).toContain("stdin=hello");
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain(secret);
  });

  it("reports a child crash signal and supports an exact-PID explicit signal", async () => {
    const crashed = await spawned(new ChildProcessRunner(), request("kill -TERM $$"));
    const crashExit = await crashed.wait();
    expect(crashExit).toMatchObject({ ok: true, value: { exitCode: null, signal: "SIGTERM" } });

    const signaled = await spawned(new ChildProcessRunner(), request("while :; do :; done"));
    const sent = await signaled.sendSignal("SIGINT");
    const signalExit = await signaled.wait();
    expect(sent.ok).toBe(true);
    expect(signalExit).toMatchObject({ ok: true, value: { exitCode: null, signal: "SIGINT" } });
  });

  it("uses SIGTERM at deadline and escalates an ignoring child to SIGKILL", async () => {
    const runner = new ChildProcessRunner({ killGraceMs: 25 });
    const graceful = await spawned(
      runner,
      request("while :; do :; done", { deadlineAt: deadline(100) }),
    );
    expect(await graceful.wait()).toMatchObject({
      ok: true,
      value: { exitCode: null, signal: "SIGTERM" },
    });

    const forced = await spawned(
      runner,
      request('trap "" TERM; while :; do :; done', {
        deadlineAt: deadline(100),
      }),
    );
    expect(await forced.wait()).toMatchObject({
      ok: true,
      value: { exitCode: null, signal: "SIGKILL" },
    });
  });

  it("caps combined output while continuing to drain the child", async () => {
    const handle = await spawned(
      new ChildProcessRunner(),
      request('printf "%04096d" 0; printf "%04096d" 0 >&2', {
        maxOutputBytes: 1_024,
      }),
    );
    const [output, exit] = await Promise.all([collect(handle), handle.wait()]);

    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(1_100);
    expect(exit).toMatchObject({ ok: true, value: { exitCode: 0, outputTruncated: true } });
  });

  it("allows a wait caller to abort without abandoning or killing the child", async () => {
    const handle = await spawned(new ChildProcessRunner(), request("sleep 0.1"));
    const controller = new AbortController();
    controller.abort();
    const interrupted = await handle.wait({ signal: controller.signal });
    const eventual = await handle.wait();

    expect(interrupted.ok ? "ok" : interrupted.error.code).toBe("interrupted");
    expect(eventual).toMatchObject({ ok: true, value: { exitCode: 0, signal: null } });
  });

  it("does not retain the spawn AbortSignal after returning a handle", async () => {
    const controller = new AbortController();
    const result = await new ChildProcessRunner().spawn(request("sleep 0.05"), {
      signal: controller.signal,
    });
    if (!result.ok) throw new Error(result.error.code);
    activeHandles.add(result.value);
    controller.abort();

    expect(await result.value.wait()).toMatchObject({
      ok: true,
      value: { exitCode: 0, signal: null },
    });
  });

  it("maps missing executables and rejects unsafe or expired requests before spawn", async () => {
    const runner = new ChildProcessRunner();
    const missing = await runner.spawn(
      request("exit 0", { executable: "/definitely/missing/agent-team-executable" }),
    );
    const unsafe = await runner.spawn(request("exit 0", { arguments: ["bad\u0000arg"] }));
    const expired = await runner.spawn(request("exit 0", { deadlineAt: deadline(-1) }));
    const ambiguousDeadline = await runner.spawn(
      request("exit 0", { deadlineAt: "2026-08-04 12:00:00Z" as Instant }),
    );

    expect(missing.ok ? "ok" : missing.error.code).toBe("unavailable");
    expect(unsafe.ok ? "ok" : unsafe.error.code).toBe("external_failure");
    expect(expired.ok ? "ok" : expired.error.code).toBe("timeout");
    expect(ambiguousDeadline.ok ? "ok" : ambiguousDeadline.error.code).toBe("external_failure");
  });
});
