import { writeFile } from "node:fs/promises";

import {
  checkpointJsonSchema,
  visualManifestJsonSchema,
} from "../dist/domain/checkpoint/schema.js";
import { eventEnvelopeV1JsonSchema } from "../dist/domain/events/schema.js";
import { jobJsonSchema, leaseJsonSchema } from "../dist/domain/jobs/schema.js";
import { issueJsonSchema, projectJsonSchema } from "../dist/domain/project/schema.js";

const schemas = [
  ["project-v1.json", projectJsonSchema],
  ["issue-v1.json", issueJsonSchema],
  ["event-v1.json", eventEnvelopeV1JsonSchema],
  ["job-v1.json", jobJsonSchema],
  ["lease-v1.json", leaseJsonSchema],
  ["checkpoint-v1.json", checkpointJsonSchema],
  ["visual-manifest-v1.json", visualManifestJsonSchema],
];

await Promise.all(
  schemas.map(([filename, schema]) =>
    writeFile(
      new URL(`../schemas/${filename}`, import.meta.url),
      `${JSON.stringify(schema, null, 2)}\n`,
    ),
  ),
);
