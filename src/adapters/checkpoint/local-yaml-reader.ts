import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  checkpointIdSchema,
  checkpointSchema,
  type Checkpoint,
} from "../../domain/checkpoint/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";

const maximumCheckpointBytes = 2 * 1024 * 1024;
const objectLine = /^([A-Za-z][A-Za-z0-9]*):(.*)$/u;
const numberScalar = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u;

interface ParsedLine {
  readonly indent: number;
  readonly content: string;
}

interface ParsedNode {
  readonly value: unknown;
  readonly next: number;
}

export interface CheckpointReadReceipt {
  readonly checkpoint: Checkpoint;
  readonly sha256: string;
}

function parseScalar(value: string): unknown {
  if (value.startsWith('"')) return JSON.parse(value) as unknown;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (numberScalar.test(value)) return Number(value);
  throw new TypeError("unsupported_checkpoint_yaml_scalar");
}

function parseNode(lines: readonly ParsedLine[], index: number, indent: number): ParsedNode {
  const first = lines[index];
  if (first?.indent !== indent) {
    throw new TypeError("checkpoint_yaml_indentation_invalid");
  }
  if (first.content === "[]") return { value: [], next: index + 1 };
  if (first.content === "{}") return { value: {}, next: index + 1 };
  if (first.content === "-") {
    const values: unknown[] = [];
    let cursor = index;
    while (lines[cursor]?.indent === indent && lines[cursor]?.content === "-") {
      const nested = parseNode(lines, cursor + 1, indent + 2);
      values.push(nested.value);
      cursor = nested.next;
    }
    return { value: values, next: cursor };
  }
  const firstObject = objectLine.exec(first.content);
  if (firstObject !== null) {
    const value: Record<string, unknown> = {};
    let cursor = index;
    while (lines[cursor]?.indent === indent) {
      const match = objectLine.exec(lines[cursor]?.content ?? "");
      if (match === null) break;
      const key = match[1];
      const remainder = match[2];
      if (key === undefined || remainder === undefined || Object.hasOwn(value, key)) {
        throw new TypeError("checkpoint_yaml_object_invalid");
      }
      if (remainder.length === 0) {
        const nested = parseNode(lines, cursor + 1, indent + 2);
        value[key] = nested.value;
        cursor = nested.next;
      } else {
        if (!remainder.startsWith(" ")) {
          throw new TypeError("checkpoint_yaml_object_invalid");
        }
        value[key] = parseScalar(remainder.slice(1));
        cursor += 1;
      }
    }
    return { value, next: cursor };
  }
  return { value: parseScalar(first.content), next: index + 1 };
}

export function parseSerializedCheckpointYaml(
  yaml: string,
): Result<Checkpoint, DomainError<"invariant_violation">> {
  try {
    if (
      yaml.length === 0 ||
      Buffer.byteLength(yaml, "utf8") > maximumCheckpointBytes ||
      !yaml.endsWith("\n") ||
      /[\u0000\r\t]/u.test(yaml)
    ) {
      return err(domainError("invariant_violation"));
    }
    const rawLines = yaml.slice(0, -1).split("\n");
    if (rawLines.some((line) => line.length === 0)) {
      return err(domainError("invariant_violation"));
    }
    const lines = rawLines.map((line): ParsedLine => {
      const content = line.trimStart();
      const indent = line.length - content.length;
      if (indent % 2 !== 0) throw new TypeError("checkpoint_yaml_indentation_invalid");
      return { indent, content };
    });
    const parsed = parseNode(lines, 0, 0);
    if (parsed.next !== lines.length) return err(domainError("invariant_violation"));
    const checkpoint = checkpointSchema.safeParse(parsed.value);
    return checkpoint.success ? ok(checkpoint.data) : err(domainError("invariant_violation"));
  } catch {
    return err(domainError("invariant_violation"));
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

export class LocalYamlCheckpointReader {
  readonly #directory: string;

  constructor(directory: string) {
    if (!isAbsolute(directory)) throw new Error("checkpoint_directory_must_be_absolute");
    this.#directory = resolve(directory);
  }

  async load(checkpointId: string): Promise<Result<CheckpointReadReceipt, DomainError>> {
    if (!checkpointIdSchema.safeParse(checkpointId).success) {
      return err(domainError("invariant_violation"));
    }
    try {
      const handle = await open(
        join(this.#directory, `${checkpointId}.yaml`),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const bytes = await handle.readFile();
        if (bytes.byteLength > maximumCheckpointBytes) {
          return err(domainError("invariant_violation"));
        }
        const parsed = parseSerializedCheckpointYaml(bytes.toString("utf8"));
        if (!parsed.ok) return parsed;
        if (parsed.value.id !== checkpointId) return err(domainError("invariant_violation"));
        return ok({
          checkpoint: parsed.value,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      } finally {
        await handle.close();
      }
    } catch (error) {
      return err(domainError(hasNodeErrorCode(error, "ENOENT") ? "not_found" : "external_failure"));
    }
  }
}
