import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { z } from "zod";

import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { AtomicFileStore, type AtomicWriteOptions, type AtomicWriteReceipt } from "./atomic.js";

export interface JsonWriteReceipt<Value> extends AtomicWriteReceipt {
  readonly readBack: Result<Value, DomainError>;
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

export async function readJsonWithSchema<Value>(
  filePath: string,
  schema: z.ZodType<Value>,
): Promise<Result<Value, DomainError>> {
  if (!isAbsolute(filePath)) return err(domainError("invariant_violation"));

  try {
    const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const text = await handle.readFile("utf8");
      const parsedJson: unknown = JSON.parse(text);
      const parsed = schema.safeParse(parsedJson);
      return parsed.success ? ok(parsed.data) : err(domainError("invariant_violation"));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) return err(domainError("not_found"));
    if (error instanceof SyntaxError) return err(domainError("invariant_violation"));
    return err(domainError("external_failure"));
  }
}

export async function writeJsonWithSchema<Value>(
  store: AtomicFileStore,
  filePath: string,
  schema: z.ZodType<Value>,
  value: unknown,
  options: AtomicWriteOptions = {},
): Promise<Result<JsonWriteReceipt<Value>, DomainError>> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return err(domainError("invariant_violation"));

  let serialized: string;
  try {
    serialized = `${JSON.stringify(parsed.data, null, 2)}\n`;
  } catch {
    return err(domainError("invariant_violation"));
  }

  const written = await store.write(filePath, Buffer.from(serialized, "utf8"), options);
  if (!written.ok) return written;
  const readBack = await readJsonWithSchema(filePath, schema);
  return ok(Object.freeze({ durability: written.value.durability, readBack }));
}
