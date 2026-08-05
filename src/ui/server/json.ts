import type { IncomingMessage } from "node:http";

export type UiJsonPrimitive = boolean | number | string | null;
export type UiJsonValue = UiJsonPrimitive | UiJsonObject | UiJsonArray;
export type UiJsonArray = readonly UiJsonValue[];
export interface UiJsonObject {
  readonly [key: string]: UiJsonValue;
}

type JsonMutationFailure = Readonly<{
  ok: false;
  statusCode: 400 | 411 | 413 | 415;
  responseBody:
    "Bad Request\n" | "Length Required\n" | "Payload Too Large\n" | "Unsupported Media Type\n";
}>;

export type JsonMutationReadResult =
  Readonly<{ ok: true; body: UiJsonObject }> | JsonMutationFailure;

const acceptedContentTypePattern =
  /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8")\s*)?$/iu;
const dangerousObjectKeys = new Set([
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
  "constructor",
  "prototype",
]);
const maximumJsonDepth = 64;

function failure(
  statusCode: 400 | 411 | 413 | 415,
  responseBody: JsonMutationFailure["responseBody"],
): JsonMutationFailure {
  return Object.freeze({ ok: false, statusCode, responseBody });
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const values = request.headersDistinct[name];
  return values?.length === 1 ? values[0] : undefined;
}

class StrictJsonParser {
  private offset = 0;

  constructor(private readonly source: string) {}

  parseObjectRoot(): UiJsonObject {
    this.skipWhitespace();
    if (this.source[this.offset] !== "{") throw new SyntaxError("JSON root must be an object.");
    const value = this.parseObject(0);
    this.skipWhitespace();
    if (this.offset !== this.source.length) throw new SyntaxError("Trailing JSON data.");
    return value;
  }

  private parseValue(depth: number): UiJsonValue {
    if (depth > maximumJsonDepth) throw new SyntaxError("JSON nesting is too deep.");
    this.skipWhitespace();
    const character = this.source[this.offset];
    if (character === "{") return this.parseObject(depth);
    if (character === "[") return this.parseArray(depth);
    if (character === '"') return this.parseString();
    if (this.source.startsWith("true", this.offset)) {
      this.offset += 4;
      return true;
    }
    if (this.source.startsWith("false", this.offset)) {
      this.offset += 5;
      return false;
    }
    if (this.source.startsWith("null", this.offset)) {
      this.offset += 4;
      return null;
    }
    return this.parseNumber();
  }

  private parseObject(depth: number): UiJsonObject {
    this.expect("{");
    this.skipWhitespace();
    const object = Object.create(null) as Record<string, UiJsonValue>;
    const keys = new Set<string>();
    if (this.source[this.offset] === "}") {
      this.offset += 1;
      return Object.freeze(object);
    }
    for (;;) {
      this.skipWhitespace();
      if (this.source[this.offset] !== '"') throw new SyntaxError("Object key expected.");
      const key = this.parseString();
      if (dangerousObjectKeys.has(key) || keys.has(key)) {
        throw new SyntaxError("Unsafe or duplicate object key.");
      }
      keys.add(key);
      this.skipWhitespace();
      this.expect(":");
      object[key] = this.parseValue(depth + 1);
      this.skipWhitespace();
      const delimiter = this.source[this.offset];
      if (delimiter === "}") {
        this.offset += 1;
        return Object.freeze(object);
      }
      this.expect(",");
    }
  }

  private parseArray(depth: number): readonly UiJsonValue[] {
    this.expect("[");
    this.skipWhitespace();
    const values: UiJsonValue[] = [];
    if (this.source[this.offset] === "]") {
      this.offset += 1;
      return Object.freeze(values);
    }
    for (;;) {
      values.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      const delimiter = this.source[this.offset];
      if (delimiter === "]") {
        this.offset += 1;
        return Object.freeze(values);
      }
      this.expect(",");
    }
  }

  private parseString(): string {
    const start = this.offset;
    this.expect('"');
    let escaped = false;
    while (this.offset < this.source.length) {
      const character = this.source[this.offset];
      this.offset += 1;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') {
        const parsed = JSON.parse(this.source.slice(start, this.offset)) as unknown;
        if (typeof parsed !== "string") throw new SyntaxError("String expected.");
        return parsed;
      }
    }
    throw new SyntaxError("Unterminated string.");
  }

  private parseNumber(): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(
      this.source.slice(this.offset),
    );
    const token = match?.[0];
    if (token === undefined) throw new SyntaxError("JSON value expected.");
    this.offset += token.length;
    const value = Number(token);
    if (!Number.isFinite(value)) throw new SyntaxError("JSON number is out of range.");
    return value;
  }

  private skipWhitespace(): void {
    while (/^[\t\n\r ]$/u.test(this.source[this.offset] ?? "")) this.offset += 1;
  }

  private expect(character: string): void {
    if (this.source[this.offset] !== character) throw new SyntaxError("Malformed JSON.");
    this.offset += 1;
  }
}

function parseContentLength(
  request: IncomingMessage,
  maximumBytes: number,
): Readonly<{ ok: true; length: number }> | Extract<JsonMutationReadResult, { ok: false }> {
  if (request.headersDistinct["transfer-encoding"] !== undefined) {
    return failure(400, "Bad Request\n");
  }
  const value = singleHeader(request, "content-length");
  if (value === undefined) return failure(411, "Length Required\n");
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) return failure(400, "Bad Request\n");
  const length = Number(value);
  if (!Number.isSafeInteger(length)) return failure(413, "Payload Too Large\n");
  if (length > maximumBytes) return failure(413, "Payload Too Large\n");
  return Object.freeze({ ok: true, length });
}

export async function readBoundedJsonMutation(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<JsonMutationReadResult> {
  const contentType = singleHeader(request, "content-type");
  if (contentType === undefined || !acceptedContentTypePattern.test(contentType)) {
    return failure(415, "Unsupported Media Type\n");
  }
  const length = parseContentLength(request, maximumBytes);
  if (!length.ok) return length;
  if (length.length === 0) return failure(400, "Bad Request\n");

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for await (const sourceChunk of request) {
      const chunk = Buffer.isBuffer(sourceChunk) ? sourceChunk : Buffer.from(sourceChunk);
      byteLength += chunk.byteLength;
      if (byteLength > maximumBytes || byteLength > length.length) {
        return failure(
          byteLength > maximumBytes ? 413 : 400,
          byteLength > maximumBytes ? "Payload Too Large\n" : "Bad Request\n",
        );
      }
      chunks.push(chunk);
    }
  } catch {
    return failure(400, "Bad Request\n");
  }
  if (!request.complete || byteLength !== length.length) {
    return failure(400, "Bad Request\n");
  }

  try {
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const body = new StrictJsonParser(source).parseObjectRoot();
    return Object.freeze({ ok: true, body });
  } catch {
    return failure(400, "Bad Request\n");
  }
}
