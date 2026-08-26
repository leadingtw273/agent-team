import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { skillRelativePathSchema } from "./model.js";

export interface SkillTreeIntegrity {
  readonly treeDigest: string;
  readonly fileDigests: Readonly<Record<string, string>>;
}

function failure(): Result<never, DomainError<"invariant_violation">> {
  return err(domainError("invariant_violation"));
}

async function regularFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error("symlink");
      if (stat.isDirectory()) await walk(path);
      else if (stat.isFile()) files.push(path);
      else throw new Error("non-regular");
    }
  }
  await walk(root);
  return files.sort((left, right) => {
    const a = relative(root, left).split(sep).join("/");
    const b = relative(root, right).split(sep).join("/");
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export async function computeSkillTreeIntegrity(
  root: string,
): Promise<Result<SkillTreeIntegrity, DomainError<"invariant_violation">>> {
  try {
    if (!isAbsolute(root)) return failure();
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return failure();
    const canonicalRoot = await realpath(root);
    const hash = createHash("sha256");
    const fileDigests: Record<string, string> = {};
    for (const path of await regularFiles(root)) {
      const canonicalPath = await realpath(path);
      if (!canonicalPath.startsWith(`${canonicalRoot}${sep}`)) return failure();
      const relativePath = relative(root, path).split(sep).join("/");
      if (!skillRelativePathSchema.safeParse(relativePath).success) return failure();
      const bytes = await readFile(path);
      fileDigests[relativePath] = createHash("sha256").update(bytes).digest("hex");
      hash.update(Buffer.from(relativePath, "utf8"));
      hash.update(Buffer.from([0]));
      hash.update(Buffer.from(String(bytes.length), "ascii"));
      hash.update(Buffer.from([0]));
      hash.update(bytes);
    }
    return ok(
      Object.freeze({
        treeDigest: hash.digest("hex"),
        fileDigests: Object.freeze(fileDigests),
      }),
    );
  } catch {
    return failure();
  }
}

export async function verifySkillReferences(
  input: Readonly<{
    root: string;
    expectedFileDigests: Readonly<Record<string, string>>;
    allowedReferences: readonly string[];
  }>,
): Promise<Result<void, DomainError<"invariant_violation">>> {
  try {
    if (!isAbsolute(input.root)) return failure();
    const rootStat = await lstat(input.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return failure();
    const canonicalRoot = await realpath(input.root);
    for (const path of input.allowedReferences) {
      if (!skillRelativePathSchema.safeParse(path).success || !path.startsWith("references/")) {
        return failure();
      }
      const expected = input.expectedFileDigests[path];
      if (expected === undefined || !/^[0-9a-f]{64}$/u.test(expected)) return failure();
      const candidate = resolve(input.root, path);
      const stat = await lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) return failure();
      const canonicalPath = await realpath(candidate);
      if (!canonicalPath.startsWith(`${canonicalRoot}${sep}`)) return failure();
      const actual = createHash("sha256")
        .update(await readFile(candidate))
        .digest("hex");
      if (actual !== expected) return failure();
    }
    return ok(undefined);
  } catch {
    return failure();
  }
}
