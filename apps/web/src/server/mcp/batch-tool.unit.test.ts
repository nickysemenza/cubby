import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

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
    run: async (_caller, item) => {
      if (item.fail) throw new Error(`Cannot process ${item.id}`);
      return { id: `result-${item.id}`, value: item.id.length };
    },
  });
  return server;
}

describe("registerBatchTool", () => {
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
          error: { message: "Cannot process blocked" },
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
