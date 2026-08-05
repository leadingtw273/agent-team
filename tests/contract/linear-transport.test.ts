import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  LinearGraphqlTransport,
  mapLinearGraphqlErrors,
  mapLinearHttpStatus,
  type LinearFetch,
} from "../../src/adapters/linear/index.js";

const failureFixture = new URL(
  "../../fixtures/providers/linear/graphql-failures.json",
  import.meta.url,
);

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestVariables(init: RequestInit | undefined): Readonly<Record<string, unknown>> {
  if (typeof init?.body !== "string") throw new Error("expected_string_request_body");
  const parsed: unknown = JSON.parse(init.body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("expected_object_request_body");
  }
  const variables = (parsed as Readonly<Record<string, unknown>>)["variables"];
  if (typeof variables !== "object" || variables === null || Array.isArray(variables)) {
    throw new Error("expected_object_variables");
  }
  return variables as Readonly<Record<string, unknown>>;
}

describe("Linear GraphQL transport contract", () => {
  it("sends Personal API Key auth and a structured GraphQL request", async () => {
    const fetch = vi
      .fn<LinearFetch>()
      .mockResolvedValue(response({ data: { viewer: { id: "v" } } }));
    const transport = new LinearGraphqlTransport({
      apiKey: "linear-test-key",
      endpoint: "https://linear.example.test/graphql",
      fetch,
    });

    const result = await transport.request<{ viewer: { id: string } }, { enabled: boolean }>({
      operationName: "Viewer",
      query: "query Viewer($enabled: Boolean!) { viewer @include(if: $enabled) { id } }",
      variables: { enabled: true },
    });

    expect(result).toEqual({ ok: true, value: { viewer: { id: "v" } } });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://linear.example.test/graphql");
    expect(init).toEqual(
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "linear-test-key",
          "content-type": "application/json",
        },
      }),
    );
    expect(requestVariables(init)).toEqual({ enabled: true });
    expect(init?.body).toBe(
      JSON.stringify({
        operationName: "Viewer",
        query: "query Viewer($enabled: Boolean!) { viewer @include(if: $enabled) { id } }",
        variables: { enabled: true },
      }),
    );
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps fixture HTTP failures and GraphQL partial data fail-closed", async () => {
    const fixture = JSON.parse(await readFile(failureFixture, "utf8")) as {
      cases: readonly { status: number; body: unknown; expectedError: string }[];
      nonJsonCases: readonly { status: number; expectedError: string }[];
    };
    const expectedCodes: Readonly<Record<string, string>> = {
      http_401: "permission_denied",
      http_429: "rate_limited",
      graphql_partial_error: "external_failure",
      graphql_error: "external_failure",
      graphql_forbidden: "permission_denied",
      graphql_notfound: "not_found",
    };

    for (const fixtureCase of fixture.cases) {
      const transport = new LinearGraphqlTransport({
        apiKey: "linear-test-key",
        fetch: vi
          .fn<LinearFetch>()
          .mockResolvedValue(response(fixtureCase.body, fixtureCase.status)),
      });
      const result = await transport.request<unknown, Record<string, never>>({
        query: "query Fixture { viewer { id } }",
        variables: {},
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(expectedCodes[fixtureCase.expectedError]);
    }
    for (const fixtureCase of fixture.nonJsonCases) {
      const transport = new LinearGraphqlTransport({
        apiKey: "linear-test-key",
        fetch: vi
          .fn<LinearFetch>()
          .mockResolvedValue(new Response("not-json", { status: fixtureCase.status })),
      });
      const result = await transport.request<unknown, Record<string, never>>({
        query: "query Fixture { viewer { id } }",
        variables: {},
      });
      expect(fixtureCase.expectedError).toBe(`http_${String(fixtureCase.status)}_non_json`);
      expect(result.ok ? "ok" : result.error.code).toBe("unavailable");
    }
    expect(mapLinearHttpStatus(503).code).toBe("unavailable");
    expect(mapLinearGraphqlErrors([{ extensions: { code: "RATELIMITED" } }]).code).toBe(
      "rate_limited",
    );
  });

  it("fails closed on malformed JSON, malformed envelopes, and network failures", async () => {
    const malformedJson = new LinearGraphqlTransport({
      apiKey: "linear-test-key",
      fetch: vi.fn<LinearFetch>().mockResolvedValue(new Response("not-json")),
    });
    const malformedEnvelope = new LinearGraphqlTransport({
      apiKey: "linear-test-key",
      fetch: vi.fn<LinearFetch>().mockResolvedValue(response({ data: null })),
    });
    const networkFailure = new LinearGraphqlTransport({
      apiKey: "linear-test-key",
      fetch: vi.fn<LinearFetch>().mockRejectedValue(new Error("network detail")),
    });
    const request = { query: "query Test { viewer { id } }", variables: {} } as const;

    const malformedJsonResult = await malformedJson.request(request);
    const malformedEnvelopeResult = await malformedEnvelope.request(request);
    const networkResult = await networkFailure.request(request);
    expect(malformedJsonResult.ok ? "ok" : malformedJsonResult.error.code).toBe("external_failure");
    expect(malformedEnvelopeResult.ok ? "ok" : malformedEnvelopeResult.error.code).toBe(
      "external_failure",
    );
    expect(networkResult.ok ? "ok" : networkResult.error.code).toBe("unavailable");
    expect(JSON.stringify(networkResult)).not.toContain("network detail");
  });

  it("enforces its deadline even when fetch ignores AbortSignal", async () => {
    const never = new Promise<Response>(() => undefined);
    const transport = new LinearGraphqlTransport({
      apiKey: "linear-test-key",
      timeoutMs: 10,
      fetch: () => never,
    });
    const started = Date.now();
    const result = await transport.request({
      query: "query Slow { viewer { id } }",
      variables: {},
    });

    expect(result.ok ? "ok" : result.error.code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("keeps the response body under the same deadline", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // Deliberately leave the body open to exercise the transport deadline.
      },
      cancel() {
        cancelled = true;
      },
    });
    const transport = new LinearGraphqlTransport({
      apiKey: "linear-test-key",
      timeoutMs: 10,
      fetch: vi.fn<LinearFetch>().mockResolvedValue(new Response(stream)),
    });

    const result = await transport.request({
      query: "query SlowBody { viewer { id } }",
      variables: {},
    });
    expect(result.ok ? "ok" : result.error.code).toBe("timeout");
    expect(cancelled).toBe(true);
  });

  it("distinguishes caller interruption from transport timeout", async () => {
    const controller = new AbortController();
    const transport = new LinearGraphqlTransport({
      apiKey: "linear-test-key",
      timeoutMs: 1_000,
      fetch: () => new Promise<Response>(() => undefined),
    });
    const pending = transport.request(
      { query: "query Interrupted { viewer { id } }", variables: {} },
      { signal: controller.signal },
    );
    controller.abort();

    const result = await pending;
    expect(result.ok ? "ok" : result.error.code).toBe("interrupted");
  });

  it("rejects an oversized declared Content-Length before reading and cancels the body", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // The precheck must reject before this body is consumed.
      },
      cancel() {
        cancelled = true;
      },
    });
    const transport = new LinearGraphqlTransport({
      apiKey: "linear-test-key",
      maxResponseBytes: 32,
      fetch: vi.fn<LinearFetch>().mockResolvedValue(
        new Response(stream, {
          headers: { "content-length": "33", "content-type": "application/json" },
        }),
      ),
    });

    const result = await transport.request({
      query: "query Oversized { viewer { id } }",
      variables: {},
    });

    expect(result.ok ? "ok" : result.error.code).toBe("external_failure");
    expect(cancelled).toBe(true);
  });

  it("caps a chunked response by cumulative bytes and cancels the stream", async () => {
    const encoder = new TextEncoder();
    const chunks = [encoder.encode('{"data":{"value":"'), encoder.encode("a".repeat(24))];
    let index = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index];
        index += 1;
        if (chunk !== undefined) controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const transport = new LinearGraphqlTransport({
      apiKey: "linear-test-key",
      maxResponseBytes: 32,
      fetch: vi.fn<LinearFetch>().mockResolvedValue(new Response(stream)),
    });

    const result = await transport.request({
      query: "query Chunked { viewer { id } }",
      variables: {},
    });

    expect(result.ok ? "ok" : result.error.code).toBe("external_failure");
    expect(cancelled).toBe(true);
  });

  it("counts multibyte UTF-8 payload bytes rather than JavaScript characters", async () => {
    const body = JSON.stringify({ data: { value: "🙂🙂🙂" } });
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(body.length);
    const transport = new LinearGraphqlTransport({
      apiKey: "linear-test-key",
      maxResponseBytes: body.length,
      fetch: vi.fn<LinearFetch>().mockResolvedValue(new Response(body)),
    });

    const result = await transport.request({
      query: "query Multibyte { viewer { id } }",
      variables: {},
    });

    expect(result.ok ? "ok" : result.error.code).toBe("external_failure");
  });

  it("paginates by cursor without duplicating or silently truncating nodes", async () => {
    const fetch = vi
      .fn<LinearFetch>()
      .mockResolvedValueOnce(
        response({
          data: {
            teams: { nodes: [{ id: "a" }], pageInfo: { hasNextPage: true, endCursor: "c1" } },
          },
        }),
      )
      .mockResolvedValueOnce(
        response({
          data: {
            teams: { nodes: [{ id: "b" }], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        }),
      );
    const transport = new LinearGraphqlTransport({ apiKey: "linear-test-key", fetch });
    const result = await transport.paginate<
      {
        teams: {
          nodes: readonly { id: string }[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      },
      { id: string }
    >({
      query:
        "query Teams($after: String) { teams(after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }",
      selectConnection: (data) => data.teams,
    });

    expect(result).toEqual({ ok: true, value: [{ id: "a" }, { id: "b" }] });
    expect(fetch.mock.calls.map((call) => requestVariables(call[1])["after"])).toEqual([
      null,
      "c1",
    ]);
  });

  it("fails closed on missing, repeated, or over-limit pagination cursors", async () => {
    const page = (endCursor: string | null) =>
      response({
        data: { items: { nodes: [], pageInfo: { hasNextPage: true, endCursor } } },
      });
    const run = async (responses: readonly Response[], maxPages = 3) => {
      const fetch = vi.fn<LinearFetch>();
      for (const item of responses) fetch.mockResolvedValueOnce(item);
      const transport = new LinearGraphqlTransport({ apiKey: "linear-test-key", fetch });
      return transport.paginate<
        {
          items: {
            nodes: readonly never[];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        },
        never
      >({
        query:
          "query Items($after: String) { items(after: $after) { nodes pageInfo { hasNextPage endCursor } } }",
        maxPages,
        selectConnection: (data) => data.items,
      });
    };

    for (const result of [
      await run([page(null)]),
      await run([page("same"), page("same")]),
      await run([page("one")], 1),
    ]) {
      expect(result.ok ? "ok" : result.error.code).toBe("external_failure");
    }
  });
});
