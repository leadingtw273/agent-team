import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type {
  CheckpointPersistencePort,
  CheckpointPersistenceReceipt,
} from "../../application/checkpoint/index.js";
import type { MutationOptions } from "../../application/ports/common.js";
import { checkpointSchema, type Checkpoint } from "../../domain/checkpoint/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { AtomicFileStore } from "../../infrastructure/files/index.js";
import { Redactor } from "../../infrastructure/redaction/index.js";

function scalar(value: string | number | boolean | null): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  return String(value);
}

function yamlLines(value: unknown, indentation: number): readonly string[] {
  const prefix = " ".repeat(indentation);
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [`${prefix}${scalar(value)}`];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${prefix}[]`];
    return value.flatMap((entry) => {
      const nested = yamlLines(entry, indentation + 2);
      return [`${prefix}-`, ...nested];
    });
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return [`${prefix}{}`];
    return entries.flatMap(([key, entry]) => {
      if (entry === null || ["string", "number", "boolean"].includes(typeof entry)) {
        return `${prefix}${key}: ${scalar(entry as string | number | boolean | null)}`;
      }
      return [`${prefix}${key}:`, ...yamlLines(entry, indentation + 2)];
    });
  }
  throw new TypeError("unsupported_yaml_value");
}

export function serializeCheckpointYaml(checkpoint: Checkpoint): string {
  const parsed = checkpointSchema.parse(checkpoint);
  return `${yamlLines(parsed, 0).join("\n")}\n`;
}

function digest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readNoFollow(path: string): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

export class LocalYamlCheckpointStore implements CheckpointPersistencePort {
  readonly #directory: string;

  constructor(
    directory: string,
    readonly files: AtomicFileStore = new AtomicFileStore(),
  ) {
    if (!isAbsolute(directory)) throw new Error("checkpoint_directory_must_be_absolute");
    this.#directory = resolve(directory);
  }

  async persist(
    checkpoint: Checkpoint,
    options: MutationOptions,
  ): Promise<Result<CheckpointPersistenceReceipt, DomainError>> {
    if (options.idempotencyKey.trim().length === 0) return err(domainError("invariant_violation"));
    const parsed = checkpointSchema.safeParse(checkpoint);
    if (!parsed.success) return err(domainError("invariant_violation"));
    const target = join(this.#directory, `${parsed.data.id}.yaml`);
    let content: Uint8Array;
    try {
      content = Buffer.from(serializeCheckpointYaml(parsed.data), "utf8");
    } catch {
      return err(domainError("invariant_violation"));
    }
    const serialized = Buffer.from(content).toString("utf8");
    if (new Redactor().redactText(serialized) !== serialized) {
      return err(domainError("permission_denied"));
    }
    try {
      const existing = await readNoFollow(target);
      if (!Buffer.from(existing).equals(Buffer.from(content))) return err(domainError("conflict"));
      return ok(
        Object.freeze({
          path: target,
          sha256: digest(existing),
          durability: "confirmed" as const,
        }),
      );
    } catch (error) {
      if (!hasNodeErrorCode(error, "ENOENT")) return err(domainError("external_failure"));
    }
    const written = await this.files.write(target, content, { visibility: "private" });
    if (!written.ok) return written;
    try {
      const readBack = await readNoFollow(target);
      if (!Buffer.from(readBack).equals(Buffer.from(content))) {
        return err(domainError("external_failure"));
      }
      return ok(
        Object.freeze({
          path: target,
          sha256: digest(readBack),
          durability: written.value.durability,
        }),
      );
    } catch {
      return err(domainError("external_failure"));
    }
  }
}
