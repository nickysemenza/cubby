import { McpServer } from "@modelcontextprotocol/server";
import { fromAny } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { withErrorReporting } from "~/server/errors/report-error";

import { handleMcpHttpRequest } from "./http-handler";
import { callMcpTool, registerTestTool } from "./mcp-test-utils";

/**
 * Failures that used to reach the connector proxy as no valid JSON-RPC
 * response at all ("Invalid content from server"): a call that outlives the
 * platform, a throw outside the tool error path, and output that fails its own
 * schema. Each must come back naming the tool, the cause, and the request id.
 */

const RAY = "8c1f00d5e2a1-SJC";
const rayHeaders = () => new Headers({ "cf-ray": RAY });
const deadlines = { query: 30, mutation: 60 };

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
    expect(text).toContain(`Cubby request ${RAY}`);
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
        },
      },
    });
    expect(signal?.aborted).toBe(true);
    expect(capture).toHaveBeenCalledOnce();
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
      "The write may have completed; re-read the affected records before retrying.",
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
  it("answers a throw outside the tool error path with a JSON-RPC error", async () => {
    const request = new Request("https://cubby.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-ray": RAY },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "spending_classification_read",
          arguments: { action: "preview" },
        },
      }),
    });

    const response = await handleMcpHttpRequest(
      request,
      async (served, authenticated) => {
        await served.text();
        authenticated();
        throw new TypeError("Do not know how to serialize a BigInt");
      },
    );

    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 7,
      error: {
        code: -32603,
        message: expect.stringContaining(
          "spending_classification_read.preview failed: Do not know how to serialize a BigInt",
        ),
        data: {
          requestId: RAY,
          diagnostics: { operation: "mcp", stage: "dispatch", cfRayId: RAY },
        },
      },
    });
  });
});
