import { readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import { format, resolveConfig } from "prettier";

import {
  checkpointJsonSchema,
  visualManifestJsonSchema,
} from "../dist/domain/checkpoint/schema.js";
import { eventEnvelopeV1JsonSchema } from "../dist/domain/events/schema.js";
import { jobJsonSchema, leaseJsonSchema } from "../dist/domain/jobs/schema.js";
import { issueJsonSchema, projectJsonSchema } from "../dist/domain/project/schema.js";
import { registrationStateSnapshotJsonSchema } from "../dist/application/registration/schema.js";

const schemas = [
  ["project-v1.json", projectJsonSchema],
  ["issue-v1.json", issueJsonSchema],
  ["event-v1.json", eventEnvelopeV1JsonSchema],
  ["job-v1.json", jobJsonSchema],
  ["lease-v1.json", leaseJsonSchema],
  ["checkpoint-v1.json", checkpointJsonSchema],
  ["visual-manifest-v1.json", visualManifestJsonSchema],
  ["registration-state-v1.json", registrationStateSnapshotJsonSchema],
];

const schemaFormattingOptions = {
  ...(await resolveConfig(new URL("../.prettierrc", import.meta.url))),
  parser: "json",
};

async function writeSchemaIfChanged(filename, schema) {
  const destination = new URL(`../schemas/${filename}`, import.meta.url);
  try {
    const existing = JSON.parse(await readFile(destination, "utf8"));
    if (isDeepStrictEqual(existing, schema)) return;
  } catch {
    // A missing or malformed generated file must be replaced by the source schema.
  }

  const formattedSchema = await format(
    `${JSON.stringify(schema, null, 2)}\n`,
    schemaFormattingOptions,
  );
  await writeFile(destination, formattedSchema);
}

await Promise.all(schemas.map(([filename, schema]) => writeSchemaIfChanged(filename, schema)));
