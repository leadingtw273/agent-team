import { z } from "zod";

import type {
  MutationOptions,
  RegistrationProbeBranchCleanupCommand,
  RegistrationProbeBranchCleanupPort,
} from "../../application/ports/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { GhTransport } from "../github/index.js";

const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/u;
const branchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u;
const shaPattern = /^[0-9a-f]{40}$/iu;

const refSchema = z
  .object({ object: z.object({ sha: z.string().regex(shaPattern) }).strict() })
  .strict();
const commitSchema = z.object({ commit: z.object({ message: z.string() }).strict() }).strict();

function failure<Value>(
  code: DomainError["code"] = "external_failure",
): Result<Value, DomainError> {
  return err(domainError(code));
}

function validRepository(value: string): boolean {
  const parts = value.split("/");
  return (
    repositoryPattern.test(value) &&
    parts.length === 2 &&
    parts.every((part) => part !== "." && part !== "..")
  );
}

function validBranch(value: string): boolean {
  return (
    branchPattern.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.endsWith(".") &&
    !value.endsWith("/") &&
    !value.endsWith(".lock")
  );
}

function encodedRepository(repository: string): string {
  return repository
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function mutationAllowed(options: MutationOptions): boolean {
  return options.idempotencyKey.trim().length > 0 && options.signal?.aborted !== true;
}

/**
 * Never trusts the caller's claim about a probe branch. Before deleting `refs/heads/<branch>` it
 * re-reads the branch's current remote head directly from the GitHub API and re-reads the commit
 * message at that head to confirm the exact run marker is present -- both independent of whatever
 * the coordinator's own journal says -- and only deletes when every one of repository, exact head
 * SHA, and marker match. It then reads the ref back once more to confirm the deletion actually
 * took, rather than trusting the mutation response alone.
 */
export class RegistrationProbeBranchCleanupAdapter implements RegistrationProbeBranchCleanupPort {
  readonly #transport: Pick<GhTransport, "requestJson" | "requestVoid">;

  constructor(transport: Pick<GhTransport, "requestJson" | "requestVoid"> = new GhTransport()) {
    this.#transport = transport;
  }

  async deleteOwnedBranch(
    command: RegistrationProbeBranchCleanupCommand,
    options: MutationOptions,
  ): Promise<Result<Readonly<{ state: "deleted" | "not_found" }>, DomainError>> {
    if (
      !mutationAllowed(options) ||
      !validRepository(command.repository) ||
      !validBranch(command.branch) ||
      !shaPattern.test(command.expectedHeadSha) ||
      command.marker.length === 0
    ) {
      return failure("invariant_violation");
    }
    const repository = encodedRepository(command.repository);
    const encodedBranch = command.branch
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");

    const ref = await this.#transport.requestJson(
      [
        "api",
        `repos/${repository}/git/ref/heads/${encodedBranch}`,
        "--jq",
        "{object:{sha:.object.sha}}",
      ],
      refSchema,
      options,
    );
    if (!ref.ok) {
      // Already gone: cleanup of a probe branch is idempotent.
      return ref.error.code === "not_found"
        ? ok(Object.freeze({ state: "not_found" as const }))
        : ref;
    }
    if (ref.value.object.sha.toLowerCase() !== command.expectedHeadSha.toLowerCase()) {
      return failure("conflict");
    }

    const commit = await this.#transport.requestJson(
      [
        "api",
        `repos/${repository}/commits/${ref.value.object.sha}`,
        "--jq",
        "{commit:{message:.commit.message}}",
      ],
      commitSchema,
      options,
    );
    if (!commit.ok) return commit;
    if (!commit.value.commit.message.includes(command.marker)) {
      return failure("conflict");
    }

    const deleted = await this.#transport.requestVoid(
      ["api", `repos/${repository}/git/refs/heads/${encodedBranch}`, "--method", "DELETE"],
      options,
    );
    if (!deleted.ok) return deleted;

    const readBack = await this.#transport.requestJson(
      [
        "api",
        `repos/${repository}/git/ref/heads/${encodedBranch}`,
        "--jq",
        "{object:{sha:.object.sha}}",
      ],
      refSchema,
      options,
    );
    if (readBack.ok) return failure();
    return readBack.error.code === "not_found"
      ? ok(Object.freeze({ state: "deleted" as const }))
      : readBack;
  }
}
