import { performance } from "node:perf_hooks";

import {
  attachFileFields,
  attachFileResponse,
  createFileUploadInput,
  createFileUploadResponse,
} from "@cubby/schemas/image";
import { testShortcode } from "@cubby/schemas/testing";
import { parseShortcode } from "@cubby/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createCallerWithOverrides,
  type McpTestCaller,
} from "~/server/mcp/mcp-test-utils";
import { createMcpServer } from "~/server/mcp/server";
import {
  type Caller,
  getCaller,
  registerMcpTool,
  WRITE_CLOSED,
} from "~/server/mcp/tools/_shared";

type WireMetric = {
  requestBytes: number;
  responseBytes: number;
  elapsedMs: number;
};

const encoder = new TextEncoder();

function bytes<Value>(value: Value): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

/**
 * Measures the actual registered MCP tools over the SDK's in-memory JSON-RPC
 * transport. File storage is the only fake seam; no database, R2, or deployed
 * URL is contacted. This is a synthetic harness result, not end-to-end timing.
 */
async function callMeasuredTool(
  name: string,
  args: Parameters<Client["callTool"]>[0]["arguments"],
  caller: McpTestCaller,
  createServer: () => McpServer = createMcpServer,
): Promise<{
  metric: WireMetric;
  result: Awaited<ReturnType<Client["callTool"]>>;
}> {
  const server = createServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-file-benchmark", version: "1.0" });
  let requestBytes = 0;
  let responseBytes = 0;

  const sendClient = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    sendClient(message, {
      ...options,
      authInfo: {
        token: "",
        clientId: "benchmark",
        scopes: [],
        extra: { caller: createCallerWithOverrides(caller) },
      },
    }).then((value) => {
      if ("method" in message && message.method === "tools/call")
        requestBytes += bytes(message);
      return value;
    });
  const sendServer = serverTransport.send.bind(serverTransport);
  serverTransport.send = (message, options) => {
    if ("id" in message && ("result" in message || "error" in message)) {
      responseBytes += bytes(message);
    }
    return sendServer(message, options);
  };

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  // Initialization is transport setup, outside the measured tools/call exchange.
  requestBytes = 0;
  responseBytes = 0;
  const startedAt = performance.now();
  try {
    const result = await client.callTool({ name, arguments: args });
    return {
      metric: {
        requestBytes,
        responseBytes,
        elapsedMs: performance.now() - startedAt,
      },
      result,
    };
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

/** Reproduces the pre-cutover singleton contracts using the old tool schemas. */
function createServerWithLegacyImageAdapters(): McpServer {
  const server = createMcpServer();
  const { entityType: _entityType, ...entityless } = attachFileFields;
  const inputSchema = z.object({
    ...entityless,
    entityId: entityless.entityId,
  });
  registerMcpTool(server, {
    name: "create_file_upload",
    description: "Pre-cutover singleton adapter",
    inputSchema: createFileUploadInput,
    outputSchema: createFileUploadResponse,
    annotations: WRITE_CLOSED,
    handler: async (params, extra) =>
      await getCaller(extra).image.createFileUpload(params),
  });
  registerMcpTool(server, {
    name: "attach_file",
    description: "Pre-cutover singleton adapter",
    inputSchema,
    outputSchema: attachFileResponse,
    annotations: WRITE_CLOSED,
    handler: async (params, extra) => {
      const type = attachFileFields.entityType.safeParse(
        parseShortcode(params.entityId)?.type,
      );
      if (!type.success) throw new Error("Synthetic target was not attachable");
      return await getCaller(extra).image.attachFile({
        ...params,
        entityType: type.data,
      });
    },
  });
  return server;
}

function summarize(metrics: readonly WireMetric[]) {
  return {
    toolCalls: metrics.length,
    requestBytes: metrics.reduce((sum, metric) => sum + metric.requestBytes, 0),
    responseBytes: metrics.reduce(
      (sum, metric) => sum + metric.responseBytes,
      0,
    ),
    elapsedMs: metrics.reduce((sum, metric) => sum + metric.elapsedMs, 0),
  };
}

describe("MCP file workflow benchmark", () => {
  it("measures real batch registration for local stages and hosted downloads", async () => {
    const productId = testShortcode("product", "benchmark-product");
    const purchaseIds = ["one", "two", "three"].map((name) =>
      testShortcode("purchase", `benchmark-purchase-${name}`),
    );
    const uploadIds = ["one", "two", "three"].map((suffix) =>
      testShortcode("image", `benchmark-upload-${suffix}`),
    );
    const createFileUpload = vi.fn(async (input: { filename: string }) => {
      const index = ["one.pdf", "two.pdf", "three.pdf"].indexOf(input.filename);
      const uploadId = uploadIds[index]!;
      return {
        uploadId,
        uploadUrl: `https://uploads.example.test/${uploadId}`,
      };
    });
    const attachFile = vi.fn(
      async (input: Parameters<Caller["image"]["attachFile"]>[0]) => ({
        imageId: testShortcode("image", input.uploadId ?? "benchmark-hosted"),
        url: "https://images.example.test/benchmark.jpg",
        filename: input.documentKind ? "receipt.pdf" : "benchmark.jpg",
        contentType: input.documentKind ? "application/pdf" : "image/jpeg",
        kind: input.documentKind ? ("document" as const) : ("image" as const),
        entityType: input.entityType,
        entityId: input.entityId,
        reused: false,
      }),
    );
    const caller = { image: { createFileUpload, attachFile } };
    const files = ["one", "two", "three"].map((name, index) => ({
      entityId: purchaseIds[index],
      filename: `${name}.pdf`,
      contentType: "application/pdf",
      size: 10 + index,
    }));

    const before: WireMetric[] = [];
    for (const [index, file] of files.entries()) {
      const stage = await callMeasuredTool(
        "create_file_upload",
        file,
        caller,
        createServerWithLegacyImageAdapters,
      );
      const attach = await callMeasuredTool(
        "attach_file",
        {
          entityId: purchaseIds[index],
          documentKind: "receipt",
          uploadId: uploadIds[index],
          idempotencyKey: `benchmark-local-${index}`,
        },
        caller,
        createServerWithLegacyImageAdapters,
      );
      expect(stage.result.isError).not.toBe(true);
      expect(attach.result.isError).not.toBe(true);
      before.push(stage.metric, attach.metric);
    }
    const localStage = await callMeasuredTool(
      "create_file_uploads",
      { items: files },
      caller,
    );
    const localAttach = await callMeasuredTool(
      "attach_files",
      {
        items: uploadIds.map((uploadId, index) => ({
          entityId: purchaseIds[index],
          documentKind: "receipt",
          uploadId,
          idempotencyKey: `benchmark-local-${index}`,
        })),
      },
      caller,
    );
    const hostedAttach = await callMeasuredTool(
      "attach_files",
      {
        items: [
          {
            entityId: productId,
            expectedImageCount: 0,
            url: "https://files.example.test/benchmark.jpg",
            idempotencyKey: "benchmark-hosted",
          },
        ],
      },
      caller,
    );

    for (const sample of [localStage, localAttach, hostedAttach]) {
      expect(sample.metric.requestBytes).toBeGreaterThan(0);
      expect(sample.metric.responseBytes).toBeGreaterThan(0);
      expect(sample.metric.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(sample.result.isError).not.toBe(true);
    }
    expect(localStage.result.structuredContent).toMatchObject({
      summary: { requested: 3, succeeded: 3, failed: 0 },
    });
    expect(localAttach.result.structuredContent).toMatchObject({
      summary: { requested: 3, succeeded: 3, failed: 0 },
    });
    expect(hostedAttach.result.structuredContent).toMatchObject({
      summary: { requested: 1, succeeded: 1, failed: 0 },
    });
    expect(attachFile).toHaveBeenCalledTimes(7);
    process.stdout.write(
      `${JSON.stringify({
        benchmark: "synthetic-mcp-upload-wire",
        scope: "in-memory SDK harness, not deployed end-to-end",
        localReceipts: {
          before: summarize(before),
          after: summarize([localStage.metric, localAttach.metric]),
        },
        hostedUrlBatch: summarize([hostedAttach.metric]),
        retries: 0,
      })}\n`,
    );
  });
});
