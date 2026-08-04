import { z } from "zod";

import { domainError, err, type DomainError, type Result } from "../foundation/index.js";
import { repositoryRelativePathSchema } from "../project/index.js";
import { canonicalSerialize, sha256Digest, type Sha256Digest } from "./canonical.js";

export const gitFileModeSchema = z.enum(["100644", "100755", "120000", "160000"]);
export type GitFileMode = z.infer<typeof gitFileModeSchema>;

export const gitObjectIdSchema = z.discriminatedUnion("algorithm", [
  z.object({ algorithm: z.literal("sha1"), value: z.string().regex(/^[0-9a-f]{40}$/u) }).strict(),
  z.object({ algorithm: z.literal("sha256"), value: z.string().regex(/^[0-9a-f]{64}$/u) }).strict(),
]);

export type GitObjectId = z.infer<typeof gitObjectIdSchema>;

export const treeEntrySchema = z
  .object({
    path: repositoryRelativePathSchema,
    mode: gitFileModeSchema,
    objectId: gitObjectIdSchema,
  })
  .strict();

export type TreeEntry = z.infer<typeof treeEntrySchema>;

export const effectiveTreeChangeSchema = z
  .object({
    before: treeEntrySchema.nullable(),
    after: treeEntrySchema.nullable(),
  })
  .strict()
  .superRefine((change, context) => {
    if (change.before === null && change.after === null) {
      context.addIssue({ code: "custom", message: "A tree change cannot be empty." });
      return;
    }
    if (
      change.before !== null &&
      change.after !== null &&
      change.before.path === change.after.path &&
      change.before.mode === change.after.mode &&
      change.before.objectId.algorithm === change.after.objectId.algorithm &&
      change.before.objectId.value === change.after.objectId.value
    ) {
      context.addIssue({ code: "custom", message: "A tree change cannot be a no-op." });
    }
  });

export type EffectiveTreeChange = z.infer<typeof effectiveTreeChangeSchema>;

export const effectiveTreeDiffSchema = z
  .array(effectiveTreeChangeSchema)
  .max(100_000)
  .superRefine((changes, context) => {
    const beforePaths = new Set<string>();
    const afterPaths = new Set<string>();
    const deletedPaths = new Set<string>();
    const addedPaths = new Set<string>();
    for (const [index, change] of changes.entries()) {
      if (change.before !== null) {
        if (beforePaths.has(change.before.path)) {
          context.addIssue({
            code: "custom",
            message: "Duplicate before path.",
            path: [index, "before"],
          });
        }
        beforePaths.add(change.before.path);
        if (change.after === null) deletedPaths.add(change.before.path);
      }
      if (change.after !== null) {
        if (afterPaths.has(change.after.path)) {
          context.addIssue({
            code: "custom",
            message: "Duplicate after path.",
            path: [index, "after"],
          });
        }
        afterPaths.add(change.after.path);
        if (change.before === null) addedPaths.add(change.after.path);
      }
    }
    for (const path of deletedPaths) {
      if (addedPaths.has(path)) {
        context.addIssue({
          code: "custom",
          message: "A same-path delete and add must be represented as one modification.",
        });
      }
    }
  });

export function createDiffDigest(
  changesInput: readonly EffectiveTreeChange[],
): Result<Sha256Digest, DomainError<"invariant_violation">> {
  const changes = effectiveTreeDiffSchema.safeParse(changesInput);
  if (!changes.success) return err(domainError("invariant_violation"));

  const sortable = changes.data.map((change) => {
    const serialized = canonicalSerialize(change);
    if (!serialized.ok) return undefined;
    return { change, key: serialized.value };
  });
  if (sortable.some((item) => item === undefined)) return err(domainError("invariant_violation"));

  const ordered = sortable
    .filter((item): item is NonNullable<typeof item> => item !== undefined)
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .map((item) => item.change);
  return sha256Digest(ordered);
}
