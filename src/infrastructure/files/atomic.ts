import { randomUUID } from "node:crypto";
import { renameSync, type MakeDirectoryOptions, type Mode } from "node:fs";
import { chmod, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { privateDirectoryMode, projectDirectoryMode } from "./layout.js";

export const privateFileMode = 0o600;
export const projectFileMode = 0o644;

export interface AtomicFileOperations {
  readonly chmod: (path: string, mode: number) => Promise<void>;
  readonly mkdir: (path: string, options: MakeDirectoryOptions) => Promise<string | undefined>;
  readonly open: (path: string, flags: string | number, mode?: Mode) => Promise<FileHandle>;
  readonly rename: (oldPath: string, newPath: string) => Promise<void>;
  readonly renameSync?: (oldPath: string, newPath: string) => void;
  readonly unlink: (path: string) => Promise<void>;
}

const nodeFileOperations: AtomicFileOperations = { chmod, mkdir, open, rename, renameSync, unlink };

export interface AtomicWriteOptions {
  readonly visibility?: "private" | "project";
  /** Runs after the temporary file is complete and fsynced, immediately before publication. */
  readonly commitGuard?: () => Result<void, DomainError> | Promise<Result<void, DomainError>>;
  /**
   * Synchronous security boundary. No event-loop turn occurs between this guard returning and
   * the synchronous rename that publishes the file.
   */
  readonly publicationGuard?: () => Result<void, DomainError>;
}

export interface AtomicWriteReceipt {
  readonly durability: "confirmed" | "unknown";
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  if (handle === undefined) return;
  try {
    await handle.close();
  } catch {
    // The original write failure remains authoritative.
  }
}

async function unlinkQuietly(operations: AtomicFileOperations, path: string): Promise<void> {
  try {
    await operations.unlink(path);
  } catch {
    // A crash may leave a temp file; it can never replace the authoritative target by itself.
  }
}

export async function syncDirectory(
  directory: string,
  operations: AtomicFileOperations = nodeFileOperations,
): Promise<void> {
  const handle = await operations.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class AtomicFileStore {
  readonly #operations: AtomicFileOperations;

  constructor(operations: AtomicFileOperations = nodeFileOperations) {
    this.#operations = operations;
  }

  async write(
    targetPath: string,
    content: Uint8Array,
    options: AtomicWriteOptions = {},
  ): Promise<Result<AtomicWriteReceipt, DomainError>> {
    if (!isAbsolute(targetPath)) return err(domainError("invariant_violation"));

    const stableContent = Uint8Array.from(content);
    const visibility = options.visibility ?? "private";
    const fileMode = visibility === "private" ? privateFileMode : projectFileMode;
    const directoryMode = visibility === "private" ? privateDirectoryMode : projectDirectoryMode;
    const directory = dirname(targetPath);
    const temporaryPath = join(directory, `.${basename(targetPath)}.${randomUUID()}.tmp`);
    let handle: FileHandle | undefined;
    let renamed = false;

    try {
      await this.#operations.mkdir(directory, { recursive: true, mode: directoryMode });
      await this.#operations.chmod(directory, directoryMode);
      handle = await this.#operations.open(temporaryPath, "wx", fileMode);
      await handle.writeFile(stableContent);
      await handle.chmod(fileMode);
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (options.commitGuard !== undefined) {
        const guarded = await options.commitGuard();
        if (!guarded.ok) {
          await unlinkQuietly(this.#operations, temporaryPath);
          return guarded;
        }
      }
      if (options.publicationGuard !== undefined) {
        if (this.#operations.renameSync === undefined) {
          await unlinkQuietly(this.#operations, temporaryPath);
          return err(domainError("external_failure"));
        }
        const guarded = options.publicationGuard();
        if (!guarded.ok) {
          await unlinkQuietly(this.#operations, temporaryPath);
          return guarded;
        }
        this.#operations.renameSync(temporaryPath, targetPath);
      } else {
        await this.#operations.rename(temporaryPath, targetPath);
      }
      renamed = true;
      await syncDirectory(directory, this.#operations);
      return ok(Object.freeze({ durability: "confirmed" as const }));
    } catch {
      await closeQuietly(handle);
      if (!renamed) await unlinkQuietly(this.#operations, temporaryPath);
      if (renamed) return ok(Object.freeze({ durability: "unknown" as const }));
      return err(domainError("external_failure"));
    }
  }
}
