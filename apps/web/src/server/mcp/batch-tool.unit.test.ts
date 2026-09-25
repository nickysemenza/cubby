import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { withErrorReporting } from "~/server/errors/report-error";

import { callMcpTool } from "./mcp-test-utils";
import { registerBatchTool, WRITE_CLOSED } from "./tools/_shared";

const itemInputSchema = z.object({
  id: z.string(),
  fail: z.boolean().optional(),
});
const itemOutputSchema = z.object({
  id: z.string(),
  value: z.number(),
});
const batchResultSchema = z.object({
  summary: z.object({
    requested: z.number(),
    succeeded: z.number(),
    failed: z.number(),
  }),
  results: z.array(
    z.discriminatedUnion("status", [
      z.object({
        index: z.number(),
        status: z.literal("succeeded"),
        reference: z.string(),
        item: itemOutputSchema.optional(),
      }),
      z.object({
        index: z.number(),
        status: z.literal("failed"),
        error: z.object({
          message: z.string(),
          code: z.string().optional(),
          reason: z.string().optional(),
        }),
      }),
    ]),
  ),
});

function createBatchServer(): McpServer {
  const server = new McpServer({ name: "batch-test", version: "1.0.0" });
  registerBatchTool(server, {
    name: "process_items",
    description: "Process fixture items",
    itemInputSchema,
    itemOutputSchema,
    projectReference: (item) => item.id,
    annotations: WRITE_CLOSED,
    run: async (item) => {
      if (item.fail) throw new Error(`Cannot process ${item.id}`);
      return { id: `result-${item.id}`, value: item.id.length };
    },
  });
  return server;
}

describe("registerBatchTool", () => {
  it("preserves distinct capture references through the MCP batch output schema", async () => {
    const capture = vi.fn(() => crypto.randomUUID());
    const response = await withErrorReporting(
      () =>
        callMcpTool(
          createBatchServer(),
          "process_items",
          {
            items: [
              { id: "first", fail: true },
              { id: "second", fail: true },
            ],
          },
          {},
        ),
      new Headers({ "cf-ray": "batch-test-ray" }),
      capture,
    );
    const result = z
      .object({
        results: z.array(
          z.object({
            error: z.object({
              requestId: z.string(),
              diagnostics: z.object({
                sentryEventId: z.string(),
                batchIndex: z.number(),
                cfRayId: z.string(),
              }),
            }),
          }),
        ),
      })
      .parse(response.structuredContent);
    expect(
      result.results.map((item) => item.error.diagnostics.batchIndex),
    ).toEqual([0, 1]);
    expect(
      new Set(
        result.results.map((item) => item.error.diagnostics.sentryEventId),
      ).size,
    ).toBe(2);
    expect(
      result.results.every(
        (item) => item.error.diagnostics.cfRayId === "batch-test-ray",
      ),
    ).toBe(true);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("returns stable references and nested per-item failures", async () => {
    const response = await callMcpTool(
      createBatchServer(),
      "process_items",
      {
        items: [{ id: "a" }, { id: "blocked", fail: true }, { id: "ccc" }],
      },
      {},
    );

    expect(batchResultSchema.parse(response.structuredContent)).toEqual({
      summary: { requested: 3, succeeded: 2, failed: 1 },
      results: [
        { index: 0, status: "succeeded", reference: "result-a" },
        {
          index: 1,
          status: "failed",
          error: {
            message: "Cannot process blocked",
            code: "INTERNAL_SERVER_ERROR",
            reason: "UNKNOWN_ERROR",
          },
        },
        { index: 2, status: "succeeded", reference: "result-ccc" },
      ],
    });
  });

  it("includes each parsed item only when full detail is requested", async () => {
    const response = await callMcpTool(
      createBatchServer(),
      "process_items",
      { items: [{ id: "abcd" }], resultDetail: "full" },
      {},
    );

    expect(batchResultSchema.parse(response.structuredContent)).toEqual({
      summary: { requested: 1, succeeded: 1, failed: 0 },
      results: [
        {
          index: 0,
          status: "succeeded",
          reference: "result-abcd",
          item: { id: "result-abcd", value: 4 },
        },
      ],
    });
  });
});
