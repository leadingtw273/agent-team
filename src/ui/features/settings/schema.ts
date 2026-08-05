import { BlockList, isIP } from "node:net";

import { z } from "zod";

import {
  DEFAULT_DISPATCH_SLOT_LIMITS,
  dispatchSlotLimitsSchema,
} from "../../../application/dispatch/index.js";
import { containsSensitiveValue } from "../../../infrastructure/redaction/index.js";

const maximumDecodedUrlLength = 4_096;
const maximumDecodePasses = 3;
const loopbackAddresses = new BlockList();
loopbackAddresses.addSubnet("127.0.0.0", 8, "ipv4");
loopbackAddresses.addAddress("::1", "ipv6");
loopbackAddresses.addSubnet("::ffff:127.0.0.0", 104, "ipv6");

function decodedUrlRepresentations(value: string): readonly string[] | undefined {
  if (value.length > maximumDecodedUrlLength) return undefined;
  const representations = [value];
  let current = value;
  for (let pass = 0; pass < maximumDecodePasses; pass += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return undefined;
    }
    if (decoded === current) return Object.freeze(representations);
    if (decoded.length > maximumDecodedUrlLength || /[\u0000\r\n]/u.test(decoded)) {
      return undefined;
    }
    representations.push(decoded);
    current = decoded;
  }
  return /%[a-fA-F0-9]{2}/u.test(current) ? undefined : Object.freeze(representations);
}

function isLoopbackHostname(hostname: string): boolean {
  const unbracketed = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  const withoutTrailingDots = unbracketed.replace(/\.+$/u, "");
  if (withoutTrailingDots.split(".").includes("localhost")) return true;
  const family = isIP(withoutTrailingDots);
  return family === 4
    ? loopbackAddresses.check(withoutTrailingDots, "ipv4")
    : family === 6
      ? loopbackAddresses.check(withoutTrailingDots, "ipv6")
      : false;
}

function safeWebhookRuntimeUrl(value: string): boolean {
  const decodedUrls = decodedUrlRepresentations(value);
  if (
    decodedUrls === undefined ||
    decodedUrls.some((representation) => containsSensitiveValue(representation))
  ) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.search.length === 0 &&
      url.hash.length === 0 &&
      url.hostname.length > 0 &&
      !isLoopbackHostname(url.hostname)
    );
  } catch {
    return false;
  }
}

const webhookRuntimeUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine(safeWebhookRuntimeUrl, "Webhook Runtime URL must be a credential-free HTTPS URL.");

export const userSettingsSchema = z
  .object({
    schemaVersion: z.literal(1),
    webhook: z
      .object({
        runtimeBaseUrl: webhookRuntimeUrlSchema.nullable(),
      })
      .strict(),
    concurrency: dispatchSlotLimitsSchema,
  })
  .strict()
  .superRefine((settings, context) => {
    if (settings.concurrency.perProjectModelJobs > settings.concurrency.globalModelJobs) {
      context.addIssue({
        code: "custom",
        path: ["concurrency", "perProjectModelJobs"],
        message: "Per-project model jobs cannot exceed the global model job limit.",
      });
    }
    for (const [provider, limit] of Object.entries(settings.concurrency.perProviderModelJobs)) {
      if (limit > settings.concurrency.globalModelJobs) {
        context.addIssue({
          code: "custom",
          path: ["concurrency", "perProviderModelJobs", provider],
          message: "Per-provider model jobs cannot exceed the global model job limit.",
        });
      }
    }
  });

export type UserSettings = z.infer<typeof userSettingsSchema>;

export const DEFAULT_USER_SETTINGS: UserSettings = Object.freeze({
  schemaVersion: 1,
  webhook: Object.freeze({ runtimeBaseUrl: null }),
  concurrency: DEFAULT_DISPATCH_SLOT_LIMITS,
});

export function rawSettingsLooksSensitive(value: string): boolean {
  return (
    containsSensitiveValue(value) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/iu.test(value) ||
    /(?:api[-_]?key|access[-_]?token|password|secret)\s*[=:]/iu.test(value) ||
    /(?:^|\n)\s*(?:authorization|credential|password|secret|token)\s*:/iu.test(value)
  );
}
