import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import * as Sentry from "@sentry/tanstackstart-react";
import { fromAny } from "@total-typescript/shoehorn";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { withErrorReporting } from "~/server/errors/report-error";

import { handleMcpHttpRequest, type McpServe } from "./http-handler";
import {
  callMcpTool,
  registerTestTool,
  withTestClient,
} from "./mcp-test-utils";

/**
 * Failures that used to reach the connector proxy as no valid JSON-RPC
 * response at all ("Invalid content from server"): a call that outlives the
 * platform, a throw outside the tool error path, and output that fails its own
 * schema. Each must come back naming the tool, the cause, and the request id.
 */

const RAY = "8c1f00d5e2a1-SJC";
const rayHeaders = () => new Headers({ "cf-ray": RAY });
const deadlines = { read: 30, modelRead: 60, write: 60 };

const errorText = (result: Awaited<ReturnType<typeof callMcpTool>>) =>
  z.array(z.object({ text: z.string() })).parse(result.content)[0]!.text;

describe("MCP tool deadline", () => {
  it("answers a read that outlives its budget with a timeout error and aborts its signal", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    let signal: AbortSignal | undefined;
    const capture = vi.fn(() => "sentry-event-1");
    registerTestTool(
      server,
      {
        name: "slow_read",
        kind: "query",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        run: (context) => {
          signal = context.signal;
          return new Promise<{ ok: boolean }>(() => {});
        },
      },
      { markCalendarDirty: vi.fn(), toolDeadlineMs: deadlines },
    );

    const result = await withErrorReporting(
      () => callMcpTool(server, "slow_read", { action: "run" }),
      rayHeaders(),
      capture,
    );

    expect(result.isError).toBe(true);
    const text = errorText(result);
    expect(text).toContain("slow_read.run did not finish within 0.03s");
    expect(text).toMatch(
      new RegExp(
        `\\(answered after [\\d.]+s; Cubby request ${RAY}; Sentry sentry-event-1\\)\\. The work may still be running`,
        "u",
      ),
    );
    expect(text).toContain("Try a narrower request or the web app");
    expect(text).not.toContain("re-read");
    expect(result._meta).toMatchObject({
      "cubby/error": {
        code: "INTERNAL_SERVER_ERROR",
        reason: "MCP_TOOL_DEADLINE_EXCEEDED",
        requestId: RAY,
        diagnostics: {
          operation: "slow_read.run",
          stage: "run",
          cfRayId: RAY,
          sentryEventId: "sentry-event-1",
          sentryUrl: expect.stringContaining("sentry-event-1"),
        },
      },
    });
    expect(signal?.aborted).toBe(true);
    expect(capture).toHaveBeenCalledOnce();
  });

  it("drops a forged ray id from a timeout answer", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerTestTool(
      server,
      {
        name: "slow_forged_ray",
        kind: "query",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        run: () => new Promise<{ ok: boolean }>(() => {}),
      },
      { markCalendarDirty: vi.fn(), toolDeadlineMs: deadlines },
    );

    const result = await withErrorReporting(
      () => callMcpTool(server, "slow_forged_ray", { action: "run" }),
      new Headers({ "cf-ray": "token=fixture-ray-secret" }),
      vi.fn(() => "sentry-event-5"),
    );

    expect(errorText(result)).toContain("slow_forged_ray.run did not finish");
    expect(JSON.stringify(result)).not.toContain("fixture-ray-secret");
    expect(errorText(result)).not.toContain("Cubby request");
  });

  it("tells the caller a timed-out write may have committed", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const recordDatabaseWrite = vi.fn(async () => {});
    const markCalendarDirty = vi.fn();
    registerTestTool(
      server,
      {
        name: "slow_write",
        kind: "mutation",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        run: () => new Promise<{ ok: boolean }>(() => {}),
      },
      { markCalendarDirty, recordDatabaseWrite, toolDeadlineMs: deadlines },
    );

    const result = await withErrorReporting(
      () => callMcpTool(server, "slow_write", { action: "run" }),
      rayHeaders(),
      vi.fn(() => "sentry-event-2"),
    );

    expect(result.isError).toBe(true);
    const text = errorText(result);
    expect(text).toContain("slow_write.run did not finish within 0.06s");
    expect(text).toContain(
      `; Sentry sentry-event-2). The write may have completed; re-read the affected records before retrying.`,
    );
    expect(result._meta).toMatchObject({
      "cubby/error": { reason: "MCP_TOOL_DEADLINE_EXCEEDED", requestId: RAY },
    });
    expect(recordDatabaseWrite).toHaveBeenCalledWith("mcp.slow_write.run");
    expect(markCalendarDirty).not.toHaveBeenCalled();
  });

  it("gives a write a longer budget than a read", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerTestTool(
      server,
      {
        name: "write_between_budgets",
        kind: "mutation",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return { ok: true };
        },
      },
      { markCalendarDirty: vi.fn(), toolDeadlineMs: deadlines },
    );

    const result = await callMcpTool(server, "write_between_budgets", {
      action: "run",
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ ok: true });
  });
});

describe("MCP tool deadline policy", () => {
  it("gives a declared model-backed read the model budget instead of the read budget", async () => {
    const run = async () => {
      await new Promise((resolve) => setTimeout(resolve, 45));
      return { ok: true };
    };
    const modelServer = new McpServer({ name: "test", version: "1.0.0" });
    registerTestTool(
      modelServer,
      {
        name: "model_read",
        kind: "query",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        run,
        spec: { modelBacked: true },
      },
      { markCalendarDirty: vi.fn(), toolDeadlineMs: deadlines },
    );
    const plainServer = new McpServer({ name: "test", version: "1.0.0" });
    registerTestTool(
      plainServer,
      {
        name: "plain_read",
        kind: "query",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        run,
      },
      { markCalendarDirty: vi.fn(), toolDeadlineMs: deadlines },
    );

    const modelResult = await callMcpTool(modelServer, "model_read", {
      action: "run",
    });
    const plainResult = await withErrorReporting(
      () => callMcpTool(plainServer, "plain_read", { action: "run" }),
      rayHeaders(),
      vi.fn(() => "sentry-event-4"),
    );

    expect(modelResult.isError).not.toBe(true);
    expect(modelResult.structuredContent).toEqual({ ok: true });
    expect(plainResult.isError).toBe(true);
    expect(errorText(plainResult)).toContain("plain_read.run did not finish");
  });
});

describe("MCP tool work that settles after its deadline", () => {
  const unhandled = vi.fn();
  afterEach(() => {
    process.off("unhandledRejection", unhandled);
    unhandled.mockReset();
    vi.restoreAllMocks();
  });

  /** Times out a call, then settles its handler; returns what was observed. */
  async function settleLate(settle: "resolve" | "reject") {
    process.on("unhandledRejection", unhandled);
    const sent = vi.spyOn(InMemoryTransport.prototype, "send");
    const capture = vi.fn(() => "sentry-event-late");
    const recordDatabaseWrite = vi.fn(async () => {});
    let finish: { resolve(): void; reject(): void } | undefined;
    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerTestTool(
      server,
      {
        name: "late_write",
        kind: "mutation",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        run: () =>
          new Promise<{ ok: boolean }>((resolve, reject) => {
            finish = {
              resolve: () => resolve({ ok: true }),
              reject: () =>
                reject(new Error("late failure after the deadline")),
            };
          }),
      },
      {
        markCalendarDirty: vi.fn(),
        recordDatabaseWrite,
        toolDeadlineMs: deadlines,
      },
    );

    // The transports stay open through the late settle, so a second response
    // would actually be sent and counted.
    const result = await withErrorReporting(
      () =>
        withTestClient(server, {}, {}, async (client) => {
          const answer = await client.callTool({
            name: "late_write",
            arguments: { action: "run" },
          });
          finish?.[settle]();
          await new Promise((resolve) => setTimeout(resolve, 20));
          return answer;
        }),
      rayHeaders(),
      capture,
    );

    const messages = sent.mock.calls.map(([message]) => message);
    const callIds = messages.flatMap((message) =>
      "method" in message && message.method === "tools/call" && "id" in message
        ? [message.id]
        : [],
    );
    const responses = messages.filter(
      (message) =>
        !("method" in message) &&
        "id" in message &&
        message.id !== undefined &&
        callIds.includes(message.id),
    );
    return { result, capture, recordDatabaseWrite, responses };
  }

  it("ignores a handler that resolves after its timeout answer", async () => {
    const { result, capture, recordDatabaseWrite, responses } =
      await settleLate("resolve");

    expect(errorText(result)).toContain("late_write.run did not finish");
    expect(responses).toHaveLength(1);
    expect(capture).toHaveBeenCalledOnce();
    expect(recordDatabaseWrite).toHaveBeenCalledOnce();
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("swallows a handler that rejects after its timeout answer", async () => {
    const { result, capture, responses } = await settleLate("reject");

    expect(errorText(result)).toContain("late_write.run did not finish");
    expect(responses).toHaveLength(1);
    expect(capture).toHaveBeenCalledOnce();
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe("MCP tool output validation", () => {
  it("names the failing output path instead of a generic failure", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerTestTool(server, {
      name: "drifted_output",
      kind: "query",
      input: z.object({}),
      output: z.object({ totals: z.object({ count: z.number() }) }),
      run: async () =>
        fromAny<{ totals: { count: number } }, { totals: { count: string } }>({
          totals: { count: "3" },
        }),
    });

    const result = await withErrorReporting(
      () => callMcpTool(server, "drifted_output", { action: "run" }),
      rayHeaders(),
      vi.fn(() => "sentry-event-3"),
    );

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(
      "Output does not match its schema: totals.count:",
    );
    expect(result._meta).toMatchObject({
      "cubby/error": {
        code: "INTERNAL_SERVER_ERROR",
        reason: "INVALID_OUTPUT",
        requestId: RAY,
        validationIssues: [{ path: ["totals", "count"] }],
        diagnostics: { operation: "drifted_output.run", stage: "output" },
      },
    });
  });
});

describe("MCP HTTP handler", () => {
  const toolCall = (args: Record<string, string | number>) =>
    JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "entity", arguments: args },
    });
  const post = (body: BodyInit, headers: Record<string, string> = {}) => {
    // Node requires `duplex` for a streamed body; DOM's RequestInit omits it.
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-ray": RAY,
        ...headers,
      },
      body,
      duplex: "half",
    };
    return new Request("https://cubby.test/api/mcp", init);
  };
  const rpcError = z.object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.number(), z.null()]),
    error: z.object({
      code: z.number(),
      message: z.string(),
      data: z.looseObject({
        requestId: z.string().optional(),
        elapsedMs: z.number(),
      }),
    }),
  });
  /** Authenticates, reads the body, then fails with `error`. */
  const failAfterBody =
    (error: Error): McpServe =>
    async (_request, progress) => {
      progress.authenticated();
      await progress.readBody();
      throw error;
    };
  /** Serves `request` with Sentry capture returning `eventId` ("": no event captured). */
  const handle = (request: Request, serve: McpServe, eventId = "") =>
    withErrorReporting(
      () => handleMcpHttpRequest(request, serve),
      undefined,
      vi.fn(() => eventId),
    );

  it("answers a throw after the body was read with a JSON-RPC error naming the call", async () => {
    const response = await handle(
      post(toolCall({ action: "create" })),
      failAfterBody(new TypeError("Do not know how to serialize a BigInt")),
      "sentry-event-http",
    );

    expect(response.status).toBe(500);
    const body = rpcError.parse(await response.json());
    expect(body.id).toBe(7);
    expect(body.error.code).toBe(-32603);
    expect(body.error.message).toContain(
      "entity.create failed: Do not know how to serialize a BigInt",
    );
    expect(body.error.message).toMatch(
      new RegExp(
        `\\(after \\d+ ms; Cubby request ${RAY}; Sentry sentry-event-http\\)\\. The write may have completed; re-read the affected records before retrying\\.$`,
        "u",
      ),
    );
    expect(body.error.data).toMatchObject({
      requestId: RAY,
      diagnostics: {
        operation: "mcp",
        stage: "dispatch",
        cfRayId: RAY,
        sentryEventId: "sentry-event-http",
        sentryUrl: expect.stringContaining("sentry-event-http"),
      },
    });
  });

  describe("with the real Sentry SDK", () => {
    afterEach(() => {
      Sentry.getCurrentScope().setClient(undefined);
    });

    /** Installs a client whose transport records envelopes instead of sending. */
    function installSentryClient() {
      const sent: string[] = [];
      const client = new Sentry.NodeClient({
        dsn: "https://public@o0.ingest.sentry.io/0",
        stackParser: Sentry.defaultStackParser,
        integrations: [Sentry.eventFiltersIntegration()],
        ignoreErrors: ["The client has disconnected"],
        transport: () =>
          Sentry.createTransport(
            { recordDroppedEvent: () => undefined },
            async (request) => {
              sent.push(String(request.body));
              return { statusCode: 200 };
            },
          ),
      });
      Sentry.setCurrentClient(client);
      client.init();
      return { client, sent };
    }

    it("omits the Sentry reference when no client is installed", async () => {
      expect(Sentry.getClient()).toBeUndefined();
      const response = await handleMcpHttpRequest(
        post(toolCall({ action: "create" })),
        failAfterBody(new Error("dispatch failed")),
      );

      const body = rpcError.parse(await response.json());
      expect(body.error.message).not.toContain("Sentry");
      expect(body.error.data).not.toHaveProperty("diagnostics.sentryEventId");
    });

    it("omits the Sentry reference for an error the client ignores", async () => {
      const { client, sent } = installSentryClient();
      const response = await handleMcpHttpRequest(
        post(toolCall({ action: "create" })),
        failAfterBody(new Error("The client has disconnected")),
      );
      await client.flush(1000);

      const body = rpcError.parse(await response.json());
      expect(body.error.message).not.toContain("Sentry");
      expect(body.error.data).not.toHaveProperty("diagnostics.sentryEventId");
      expect(sent).toHaveLength(0);
    });

    it("names the event a client actually sends", async () => {
      const { client, sent } = installSentryClient();
      const response = await handleMcpHttpRequest(
        post(toolCall({ action: "create" })),
        failAfterBody(new Error("dispatch failed")),
      );
      await client.flush(1000);

      const body = rpcError.parse(await response.json());
      const eventId = z
        .object({ diagnostics: z.object({ sentryEventId: z.string() }) })
        .parse(body.error.data).diagnostics.sentryEventId;
      expect(body.error.message).toContain(`; Sentry ${eventId})`);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain(eventId);
    });
  });

  it("drops a forged ray id from the message and data", async () => {
    const response = await handle(
      post(toolCall({ action: "create" }), {
        "cf-ray": "token=fixture-ray-secret",
      }),
      failAfterBody(new Error("dispatch failed")),
    );

    const text = await response.text();
    expect(text).not.toContain("fixture-ray-secret");
    const body = rpcError.parse(JSON.parse(text));
    expect(body.error.message).not.toContain("Cubby request");
    expect(body.error.message).toMatch(/after \d+ ms\)\./u);
  });

  it("keeps the request id when the tool arguments are malformed", async () => {
    const response = await handle(
      post(toolCall({ action: 42 })),
      failAfterBody(new Error("dispatch failed")),
    );

    const body = rpcError.parse(await response.json());
    expect(body.id).toBe(7);
    expect(body.error.message).toContain("entity failed: dispatch failed");
  });

  it("scrubs credential-shaped values from the assembled message and data", async () => {
    const response = await handle(
      post(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 8,
          method: "tools/call",
          params: { name: "token=fixture-secret", arguments: {} },
        }),
      ),
      failAfterBody(new Error("upstream said password=fixture-password")),
    );

    const text = await response.text();
    expect(text).not.toContain("fixture-secret");
    expect(text).not.toContain("fixture-password");
    expect(rpcError.parse(JSON.parse(text)).id).toBe(8);
  });

  const suffix =
    "The write may have completed; re-read the affected records before retrying.";

  it("keeps the elapsed time, request id, and guidance after a long cause", async () => {
    const sql = `insert into expense values ${"($1, $2, $3), ".repeat(200)} -- password=fixture-long-secret`;
    const response = await handle(
      post(toolCall({ action: "create" })),
      failAfterBody(new Error(sql)),
    );

    const body = rpcError.parse(await response.json());
    expect(body.error.message).toContain("entity.create failed: insert into");
    expect(body.error.message).toMatch(
      new RegExp(`after \\d+ ms; Cubby request ${RAY}\\)\\. ${suffix}$`, "u"),
    );
    expect(JSON.stringify(body)).not.toContain("fixture-long-secret");
  });

  it("keeps the guidance when the cause carries an authorization header", async () => {
    const response = await handle(
      post(toolCall({ action: "create" })),
      failAfterBody(
        new Error(
          "upstream rejected authorization: Bearer fixture-token-value",
        ),
      ),
    );

    const body = rpcError.parse(await response.json());
    expect(body.error.message).toContain("authorization: [REDACTED]");
    expect(body.error.message).toMatch(
      new RegExp(`after \\d+ ms; Cubby request ${RAY}\\)\\. ${suffix}$`, "u"),
    );
    expect(JSON.stringify(body)).not.toContain("fixture-token-value");
  });

  it("refuses a declared oversized body without reading it", async () => {
    const pulled = vi.fn();
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled();
          controller.enqueue(new Uint8Array(1024));
        },
      },
      { highWaterMark: 0 },
    );
    const response = await handle(
      post(stream, { "content-length": String(64 * 1024 * 1024) }),
      failAfterBody(new Error("unreachable: the body is over the limit")),
    );

    expect(response.status).toBe(413);
    const body = rpcError.parse(await response.json());
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(-32600);
    expect(body.error.message).toContain("request body is over");
    expect(pulled.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("stops reading an undeclared body once it passes the limit", async () => {
    let sentBytes = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          sentBytes += chunk.byteLength;
          controller.enqueue(chunk);
        },
      },
      { highWaterMark: 0 },
    );
    const response = await handle(
      post(stream),
      failAfterBody(new Error("unreachable: the body is over the limit")),
    );

    expect(response.status).toBe(413);
    expect(sentBytes).toBeLessThan(8 * 1024 * 1024);
  });

  it("answers a body stream that fails mid-read with a JSON-RPC error", async () => {
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.error(new Error("client connection reset"));
        },
      },
      { highWaterMark: 0 },
    );
    const response = await handle(
      post(stream),
      failAfterBody(new Error("unreachable: the body stream failed")),
    );

    const body = rpcError.parse(await response.json());
    expect(body.id).toBeNull();
    expect(body.error.message).toContain("client connection reset");
  });

  it("does not read the body before the caller is authenticated", async () => {
    const pulled = vi.fn();
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled();
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const response = await handle(post(stream), async () =>
      Response.json({ error: "Unauthorized" }, { status: 401 }),
    );

    expect(response.status).toBe(401);
    expect(pulled).not.toHaveBeenCalled();
  });
});
