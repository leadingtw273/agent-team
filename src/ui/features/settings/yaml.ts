import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../../domain/foundation/index.js";
import { rawSettingsLooksSensitive, userSettingsSchema, type UserSettings } from "./schema.js";

const maximumSettingsBytes = 16_384;

export function serializeUserSettingsYaml(value: UserSettings): string {
  const parsed = userSettingsSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Invalid user settings.");
  const { concurrency, webhook } = parsed.data;
  const runtimeBaseUrl =
    webhook.runtimeBaseUrl === null ? "null" : JSON.stringify(webhook.runtimeBaseUrl);
  return [
    "schemaVersion: 1",
    "webhook:",
    `  runtimeBaseUrl: ${runtimeBaseUrl}`,
    "concurrency:",
    `  globalModelJobs: ${String(concurrency.globalModelJobs)}`,
    "  perProviderModelJobs:",
    `    codex: ${String(concurrency.perProviderModelJobs.codex)}`,
    `    claude: ${String(concurrency.perProviderModelJobs.claude)}`,
    `    gemini: ${String(concurrency.perProviderModelJobs.gemini)}`,
    `  perProjectModelJobs: ${String(concurrency.perProjectModelJobs)}`,
    `  perRepositoryIntegrationJobs: ${String(concurrency.perRepositoryIntegrationJobs)}`,
    "",
  ].join("\n");
}

function integerValue(line: string, prefix: string): number | undefined {
  if (!line.startsWith(prefix)) return undefined;
  const value = line.slice(prefix.length);
  return /^(?:0|[1-9]\d*)$/u.test(value) ? Number(value) : undefined;
}

function runtimeUrlValue(line: string): string | null | undefined {
  const prefix = "  runtimeBaseUrl: ";
  if (!line.startsWith(prefix)) return undefined;
  const scalar = line.slice(prefix.length);
  if (scalar === "null") return null;
  try {
    const value: unknown = JSON.parse(scalar);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function parseUserSettingsYaml(
  rawYaml: string,
): Result<UserSettings, DomainError<"invariant_violation">> {
  if (
    rawYaml.length === 0 ||
    Buffer.byteLength(rawYaml, "utf8") > maximumSettingsBytes ||
    /[\u0000\r]/u.test(rawYaml) ||
    rawSettingsLooksSensitive(rawYaml)
  ) {
    return err(domainError("invariant_violation"));
  }
  const normalized = rawYaml.endsWith("\n") ? rawYaml : `${rawYaml}\n`;
  const lines = normalized.slice(0, -1).split("\n");
  if (
    lines.length !== 11 ||
    lines[0] !== "schemaVersion: 1" ||
    lines[1] !== "webhook:" ||
    lines[3] !== "concurrency:" ||
    lines[5] !== "  perProviderModelJobs:"
  ) {
    return err(domainError("invariant_violation"));
  }

  const candidate = {
    schemaVersion: 1,
    webhook: { runtimeBaseUrl: runtimeUrlValue(lines[2] ?? "") },
    concurrency: {
      globalModelJobs: integerValue(lines[4] ?? "", "  globalModelJobs: "),
      perProviderModelJobs: {
        codex: integerValue(lines[6] ?? "", "    codex: "),
        claude: integerValue(lines[7] ?? "", "    claude: "),
        gemini: integerValue(lines[8] ?? "", "    gemini: "),
      },
      perProjectModelJobs: integerValue(lines[9] ?? "", "  perProjectModelJobs: "),
      perRepositoryIntegrationJobs: integerValue(
        lines[10] ?? "",
        "  perRepositoryIntegrationJobs: ",
      ),
    },
  };
  const parsed = userSettingsSchema.safeParse(candidate);
  if (!parsed.success || serializeUserSettingsYaml(parsed.data) !== normalized) {
    return err(domainError("invariant_violation"));
  }
  return ok(parsed.data);
}
