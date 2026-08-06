import { execFile } from "node:child_process";

import type {
  GitPort,
  GitRepositoryRef,
  ReadOptions,
  RegistrationProbeGitPort,
} from "../../application/ports/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { LocalGitAdapter } from "../git/index.js";

const defaultTimeoutMs = 30_000;
const remotePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;
const branchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u;
const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

function isValidBranchName(value: string): boolean {
  return (
    branchPattern.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.endsWith(".") &&
    !value.endsWith("/") &&
    !value.endsWith(".lock")
  );
}

function commandError(error: unknown): DomainError {
  if (typeof error === "object" && error !== null) {
    const name = "name" in error ? error.name : undefined;
    const code = "code" in error ? error.code : undefined;
    const killed = "killed" in error ? error.killed : undefined;
    if (name === "AbortError") return domainError("interrupted");
    if (code === "ENOENT") return domainError("unavailable");
    if (killed === true) return domainError("timeout");
  }
  return domainError("external_failure");
}

export interface RegistrationProbeGitAdapterOptions {
  readonly delegate?: Pick<
    GitPort,
    | "createWorktree"
    | "stagePaths"
    | "commit"
    | "inspectWorkingTree"
    | "push"
    | "removeWorktree"
    | "inspectRepository"
  >;
  readonly executable?: string;
  readonly timeoutMs?: number;
}

/**
 * Delegates every mutating/inspecting operation to `LocalGitAdapter` (or an injected
 * equivalent) and adds only one new read-only capability -- a `git ls-remote` readback of a
 * remote branch's current head -- needed for crash-recovery in the probe coordinator. It never
 * mutates the remote.
 */
export class RegistrationProbeGitAdapter implements RegistrationProbeGitPort {
  readonly #delegate: NonNullable<RegistrationProbeGitAdapterOptions["delegate"]>;
  readonly #executable: string;
  readonly #timeoutMs: number;

  constructor(options: RegistrationProbeGitAdapterOptions = {}) {
    this.#delegate = options.delegate ?? new LocalGitAdapter();
    this.#executable = options.executable ?? "git";
    this.#timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? defaultTimeoutMs));
  }

  inspectRepository(...args: Parameters<RegistrationProbeGitPort["inspectRepository"]>) {
    return this.#delegate.inspectRepository(...args);
  }

  createWorktree(...args: Parameters<RegistrationProbeGitPort["createWorktree"]>) {
    return this.#delegate.createWorktree(...args);
  }

  stagePaths(...args: Parameters<RegistrationProbeGitPort["stagePaths"]>) {
    return this.#delegate.stagePaths(...args);
  }

  commit(...args: Parameters<RegistrationProbeGitPort["commit"]>) {
    return this.#delegate.commit(...args);
  }

  inspectWorkingTree(...args: Parameters<RegistrationProbeGitPort["inspectWorkingTree"]>) {
    return this.#delegate.inspectWorkingTree(...args);
  }

  push(...args: Parameters<RegistrationProbeGitPort["push"]>) {
    return this.#delegate.push(...args);
  }

  removeWorktree(...args: Parameters<RegistrationProbeGitPort["removeWorktree"]>) {
    return this.#delegate.removeWorktree(...args);
  }

  async inspectRemoteBranch(
    repository: GitRepositoryRef,
    remote: string,
    branch: string,
    options: ReadOptions = {},
  ): Promise<Result<Readonly<{ sha: string }> | undefined, DomainError>> {
    if (!remotePattern.test(remote) || !isValidBranchName(branch)) {
      return err(domainError("external_failure"));
    }
    if (options.signal?.aborted === true) return err(domainError("interrupted"));
    return new Promise((resolve) => {
      execFile(
        this.#executable,
        [
          "-c",
          "protocol.ext.allow=never",
          "ls-remote",
          "--exit-code",
          remote,
          `refs/heads/${branch}`,
        ],
        {
          cwd: repository.rootPath,
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
          timeout: this.#timeoutMs,
          windowsHide: true,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
        (error, stdout) => {
          if (error !== null) {
            const code: unknown = "code" in error ? error.code : undefined;
            // `ls-remote --exit-code` exits 2 when the ref does not exist remotely.
            if (code === 2) {
              resolve(ok(undefined));
              return;
            }
            resolve(err(commandError(error)));
            return;
          }
          const trimmed = stdout.trim();
          if (trimmed.length === 0) {
            resolve(ok(undefined));
            return;
          }
          const sha = trimmed.split(/\s+/u)[0];
          resolve(
            sha !== undefined && shaPattern.test(sha)
              ? ok({ sha })
              : err(domainError("external_failure")),
          );
        },
      );
    });
  }
}
