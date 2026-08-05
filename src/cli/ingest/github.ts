import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

import { GitHubWebhookAdapter } from "../../adapters/github/index.js";
import { LinearWebhookAdapter } from "../../adapters/linear/index.js";
import type { WebhookHeaderValue, WebhookInbox } from "../../adapters/webhook/index.js";
import { createClock, type Clock } from "../../domain/foundation/index.js";
import { DurableInbox } from "../../infrastructure/events/index.js";
import type { CliHandlers } from "../program.js";

const maximumRawBodyBytes = 16 * 1024 * 1024;
const maximumHeadersBytes = 256 * 1024;
const maximumSecretBytes = 64 * 1024;
const defaultAckDeadlineMs = 2_000;

const headerValueSchema = z.union([z.string().max(4_096), z.array(z.string().max(4_096)).max(8)]);
const headersSchema = z
  .record(z.string().min(1).max(255), headerValueSchema)
  .superRefine((headers, context) => {
    if (Object.keys(headers).length > 128) {
      context.addIssue({ code: "custom", message: "Too many headers." });
    }
  });

type InputChunk = Uint8Array | string;

export interface LocalWebhookIngestOptions {
  readonly agentTeamHome?: string;
  readonly secretFile?: string;
  readonly inbox?: WebhookInbox;
  readonly stdin?: AsyncIterable<InputChunk>;
  readonly clock?: Clock;
  readonly ackDeadlineMs?: number;
}

/** @deprecated Use LocalWebhookIngestOptions for provider-neutral ingest configuration. */
export type LocalGitHubIngestOptions = LocalWebhookIngestOptions;

type ReadResult = Readonly<{ ok: true; bytes: Uint8Array; mode: number }> | Readonly<{ ok: false }>;

async function readNoFollow(filePath: string, maximumBytes: number): Promise<ReadResult> {
  if (!isAbsolute(filePath)) return Object.freeze({ ok: false });
  try {
    const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > maximumBytes) {
        return Object.freeze({ ok: false });
      }
      return Object.freeze({
        ok: true,
        bytes: Uint8Array.from(await handle.readFile()),
        mode: stat.mode & 0o777,
      });
    } finally {
      await handle.close();
    }
  } catch {
    return Object.freeze({ ok: false });
  }
}

function stripTerminalNewline(bytes: Uint8Array): Uint8Array {
  let end = bytes.byteLength;
  if (end > 0 && bytes[end - 1] === 0x0a) end -= 1;
  if (end > 0 && bytes[end - 1] === 0x0d) end -= 1;
  return bytes.slice(0, end);
}

async function readSecret(filePath: string): Promise<Uint8Array | undefined> {
  const read = await readNoFollow(filePath, maximumSecretBytes);
  if (!read.ok || (read.mode & 0o077) !== 0) return undefined;
  const secret = stripTerminalNewline(read.bytes);
  return secret.byteLength === 0 ? undefined : secret;
}

async function readHeaders(
  filePath: string,
): Promise<Readonly<Record<string, WebhookHeaderValue>> | undefined> {
  const read = await readNoFollow(filePath, maximumHeadersBytes);
  if (!read.ok) return undefined;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    const parsed = headersSchema.safeParse(JSON.parse(decoded) as unknown);
    return parsed.success ? Object.freeze(parsed.data) : undefined;
  } catch {
    return undefined;
  }
}

async function readRawBody(
  stream: AsyncIterable<InputChunk>,
): Promise<Uint8Array | "payload_too_large"> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Uint8Array.from(chunk);
    total += bytes.byteLength;
    if (total > maximumRawBodyBytes) return "payload_too_large";
    chunks.push(bytes);
  }
  return Uint8Array.from(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

async function withinDeadline<Value>(
  operation: Promise<Value>,
  deadlineMs: number,
): Promise<Value | "ack_deadline_exceeded"> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"ack_deadline_exceeded">((resolve) => {
    timer = setTimeout(() => {
      resolve("ack_deadline_exceeded");
    }, deadlineMs);
    timer.unref();
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function rejection(reason: string, statusCode: number): string {
  return JSON.stringify({ accepted: false, statusCode, reason });
}

export function createLocalWebhookIngestHandler(
  options: LocalWebhookIngestOptions = {},
): CliHandlers["ingest"] {
  const agentTeamHome = options.agentTeamHome ?? join(homedir(), ".agent-team");
  const githubSecretFile =
    options.secretFile ?? join(agentTeamHome, "secrets", "github-webhook-secret");
  const linearSecretFile =
    options.secretFile ?? join(agentTeamHome, "secrets", "linear-webhook-secret");
  const inbox = options.inbox ?? new DurableInbox(join(agentTeamHome, "state", "inbox"));
  const stream = options.stdin ?? process.stdin;
  const clock = options.clock ?? createClock();
  const ackDeadlineMs = options.ackDeadlineMs ?? defaultAckDeadlineMs;

  return async (input) => {
    if (!Number.isSafeInteger(ackDeadlineMs) || ackDeadlineMs <= 0 || ackDeadlineMs > 30_000) {
      return Object.freeze({ state: "failed", message: rejection("invalid_deadline", 500) });
    }
    const completed = await withinDeadline(
      (async () => {
        const [secret, headers, rawBody] = await Promise.all([
          readSecret(input.provider === "github" ? githubSecretFile : linearSecretFile),
          readHeaders(input.headersFile),
          readRawBody(stream),
        ]);
        if (secret === undefined) {
          return Object.freeze({
            state: "blocked" as const,
            message: `${input.provider} Webhook Secret 未配置、不是 0600，或無法安全讀取。`,
          });
        }
        if (headers === undefined) {
          return Object.freeze({
            state: "failed" as const,
            message: rejection("invalid_headers", 400),
          });
        }
        if (rawBody === "payload_too_large") {
          return Object.freeze({ state: "failed" as const, message: rejection(rawBody, 400) });
        }
        const adapter =
          input.provider === "github"
            ? new GitHubWebhookAdapter(inbox, secret)
            : new LinearWebhookAdapter(inbox, secret);
        const ingested = await adapter.ingest({
          rawBody,
          headers,
          receivedAt: clock.now(),
        });
        return Object.freeze({
          state: ingested.accepted ? ("success" as const) : ("failed" as const),
          message: JSON.stringify(ingested),
        });
      })(),
      ackDeadlineMs,
    );
    return completed === "ack_deadline_exceeded"
      ? Object.freeze({ state: "failed", message: rejection(completed, 500) })
      : completed;
  };
}
