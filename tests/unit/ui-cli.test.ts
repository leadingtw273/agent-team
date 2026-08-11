import { describe, expect, it, vi } from "vitest";

import { createUiCliHandler, type UiSignalSource } from "../../src/cli/ui/index.js";
import type { LocalUiServerHandle, UiServerStatus } from "../../src/ui/server/index.js";

class TestSignals implements UiSignalSource {
  readonly #listeners = new Set<() => void>();

  once(event: "SIGINT", listener: () => void): void {
    this.#listeners.add(listener);
  }

  off(event: "SIGINT", listener: () => void): void {
    this.#listeners.delete(listener);
  }

  interrupt(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }
}

function server(close = vi.fn((): Promise<void> => Promise.resolve())): LocalUiServerHandle {
  return Object.freeze({
    baseUrl: "http://127.0.0.1:43123",
    sessionToken: "a".repeat(43),
    close,
    status: (): UiServerStatus => Object.freeze({ state: "active", idleDeadlineMs: 1 }),
  });
}

function projectModel() {
  return Object.freeze({
    read: () =>
      Promise.resolve(Object.freeze({ state: "success" as const, payload: Object.freeze({}) })),
  });
}

describe("T06 agent-team ui lifecycle", () => {
  it("binds only loopback ephemeral, writes one fragment URL, and closes once on SIGINT", async () => {
    const signals = new TestSignals();
    const close = vi.fn((): Promise<void> => Promise.resolve());
    const handle = server(close);
    const startServer = vi.fn(() => Promise.resolve(handle));
    const writeOut = vi.fn();
    const handler = createUiCliHandler({
      agentTeamHome: "/tmp/t06-ui-home",
      createProjectModel: () => projectModel(),
      startServer,
      writeOut,
      signals,
    });

    const pending = handler();
    await vi.waitFor(() => {
      expect(writeOut).toHaveBeenCalledTimes(1);
      expect(signals.listenerCount).toBe(1);
    });
    signals.interrupt();
    signals.interrupt();
    const outcome = await pending;

    expect(startServer).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ host: "127.0.0.1", port: 0 }),
    );
    expect(writeOut).toHaveBeenCalledWith(
      `Agent Team UI：http://127.0.0.1:43123/#${"a".repeat(43)}\n`,
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(signals.listenerCount).toBe(0);
    expect(outcome).toEqual({ state: "interrupted", message: "Agent Team UI 已中斷。" });
  });

  it("collapses startup and output failures to fixed messages without raw errors or a token", async () => {
    const rawStartupError = "T06-internal-startup-error";
    const noOutput = vi.fn();
    const startupFailure = await createUiCliHandler({
      agentTeamHome: "/tmp/t06-ui-home",
      createProjectModel: () => projectModel(),
      startServer: () => Promise.reject(new Error(rawStartupError)),
      writeOut: noOutput,
      signals: new TestSignals(),
    })();

    const close = vi.fn((): Promise<void> => Promise.resolve());
    const outputFailure = await createUiCliHandler({
      agentTeamHome: "/tmp/t06-ui-home",
      createProjectModel: () => projectModel(),
      startServer: () => Promise.resolve(server(close)),
      writeOut: () => {
        throw new Error("T06-internal-writer-error");
      },
      signals: new TestSignals(),
    })();

    expect(noOutput).not.toHaveBeenCalled();
    expect(startupFailure).toEqual({ state: "failed", message: "無法啟動 Agent Team UI。" });
    expect(outputFailure).toEqual({ state: "failed", message: "無法輸出 Agent Team UI 位址。" });
    expect(JSON.stringify([startupFailure, outputFailure])).not.toContain(rawStartupError);
    expect(JSON.stringify([startupFailure, outputFailure])).not.toContain("a".repeat(43));
    expect(close).toHaveBeenCalledTimes(1);
  });
});
