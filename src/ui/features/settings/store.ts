import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../../domain/foundation/index.js";
import {
  acquireFileLock,
  AtomicFileStore,
  type AtomicWriteReceipt,
} from "../../../infrastructure/files/index.js";
import { userSettingsSchema, type UserSettings } from "./schema.js";
import { parseUserSettingsYaml, serializeUserSettingsYaml } from "./yaml.js";

const maximumSettingsBytes = 16_384;
const revisionPattern = /^[a-f0-9]{64}$/u;

export interface StoredUserSettings {
  readonly settings: UserSettings;
  readonly rawYaml: string;
  readonly revision: string;
}

export type SettingsStoreSaveResult =
  | Readonly<{ state: "saved"; stored: StoredUserSettings }>
  | Readonly<{ state: "conflict" | "failed" | "rejected" | "unconfirmed" }>;

export interface SettingsStore {
  readonly read: () => Promise<Result<StoredUserSettings, DomainError>>;
  readonly save: (
    expectedRevision: string | null,
    settings: unknown,
  ) => Promise<SettingsStoreSaveResult>;
}

interface AtomicSettingsWriter {
  write(
    targetPath: string,
    content: Uint8Array,
    options: Readonly<{ visibility: "private" }>,
  ): Promise<Result<AtomicWriteReceipt, DomainError>>;
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function revision(rawYaml: string): string {
  return createHash("sha256").update(rawYaml, "utf8").digest("hex");
}

async function readSettingsFile(
  filePath: string,
): Promise<Result<StoredUserSettings, DomainError>> {
  try {
    const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (
        !metadata.isFile() ||
        (metadata.mode & 0o077) !== 0 ||
        metadata.size <= 0 ||
        metadata.size > maximumSettingsBytes
      ) {
        return err(domainError("invariant_violation"));
      }
      const bytes = await handle.readFile();
      const rawYaml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const parsed = parseUserSettingsYaml(rawYaml);
      return parsed.ok
        ? ok(Object.freeze({ settings: parsed.value, rawYaml, revision: revision(rawYaml) }))
        : parsed;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) return err(domainError("not_found"));
    if (error instanceof TypeError) return err(domainError("invariant_violation"));
    return err(domainError("external_failure"));
  }
}

export class FileSettingsStore implements SettingsStore {
  readonly #filePath: string;
  readonly #lockPath: string;
  readonly #writer: AtomicSettingsWriter;

  constructor(filePath: string, writer: AtomicSettingsWriter = new AtomicFileStore()) {
    if (!isAbsolute(filePath)) throw new TypeError("Settings path must be absolute.");
    this.#filePath = filePath;
    this.#lockPath = `${filePath}.lock`;
    this.#writer = writer;
  }

  read(): Promise<Result<StoredUserSettings, DomainError>> {
    return readSettingsFile(this.#filePath);
  }

  async save(expectedRevision: string | null, settings: unknown): Promise<SettingsStoreSaveResult> {
    if (expectedRevision !== null && !revisionPattern.test(expectedRevision)) {
      return Object.freeze({ state: "rejected" });
    }
    const parsed = userSettingsSchema.safeParse(settings);
    if (!parsed.success) return Object.freeze({ state: "rejected" });

    const lock = await acquireFileLock(
      this.#lockPath,
      `ui-settings:${String(process.pid)}`,
      undefined,
      { repairPermissions: true },
    );
    if (!lock.ok) {
      return Object.freeze({ state: lock.error.code === "conflict" ? "conflict" : "failed" });
    }

    let writeAttempted = false;
    let outcome: SettingsStoreSaveResult = Object.freeze({ state: "failed" });
    try {
      const current = await this.read();
      const currentRevision = current.ok
        ? current.value.revision
        : current.error.code === "not_found"
          ? null
          : undefined;
      if (currentRevision === undefined) {
        outcome = Object.freeze({ state: "failed" });
      } else if (currentRevision !== expectedRevision) {
        outcome = Object.freeze({ state: "conflict" });
      } else {
        const rawYaml = serializeUserSettingsYaml(parsed.data);
        writeAttempted = true;
        const written = await this.#writer.write(this.#filePath, Buffer.from(rawYaml, "utf8"), {
          visibility: "private",
        });
        if (!written.ok) {
          outcome = Object.freeze({ state: "failed" });
        } else {
          const readBack = await this.read();
          outcome =
            readBack.ok &&
            readBack.value.rawYaml === rawYaml &&
            readBack.value.revision === revision(rawYaml) &&
            written.value.durability === "confirmed"
              ? Object.freeze({ state: "saved", stored: readBack.value })
              : Object.freeze({ state: "unconfirmed" });
        }
      }
    } catch {
      outcome = Object.freeze({ state: writeAttempted ? "unconfirmed" : "failed" });
    }
    const released = await lock.value.release();
    if (!released.ok) return Object.freeze({ state: writeAttempted ? "unconfirmed" : "failed" });
    return outcome;
  }
}
