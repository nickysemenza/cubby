import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { BatchResult } from "@cubby/schemas/batch";
import superjson from "superjson";
import { describe, expect, it } from "vitest";
import type {
  StartOperationResult,
  UnparsedStartOperationData,
} from "~/server/operation-runtime/start-operation.contract";

import {
  measureOperationRead,
  summarizeOperationReads,
} from "./read-performance-operations";

const operation = "entityReport.getMany";
const item = { operation, input: { entityId: "synthetic-record" } };
const success = {
  ok: true,
  data: { privateValue: "synthetic-private-body" },
} as const;
const failure = {
  ok: false,
  error: {
    code: "INTERNAL_SERVER_ERROR",
    message: "synthetic-private-diagnostic",
  },
} as const;
const line = (
  i: number,
  value: BatchResult<StartOperationResult<UnparsedStartOperationData>>,
) => JSON.stringify({ i, r: superjson.serialize(value) }) + "\n";

async function serve<T>(
  respond: (response: ServerResponse) => void,
  run: (origin: URL) => Promise<T>,
) {
  const server = createServer((_request, response) => respond(response));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test server address");
  try {
    return await run(new URL(`http://127.0.0.1:${address.port}`));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("operation performance evidence", () => {
  it("records an RPC failure inside HTTP success without retaining input, payload or diagnostic text", async () => {
    const sample = await serve(
      (response) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(superjson.serialize(failure)));
      },
      (origin) => measureOperationRead(item, origin, new Headers()),
    );
    expect(sample.failure).toBeNull();
    expect(sample.results).toMatchObject([
      {
        operation,
        ok: false,
        errorKind: "operation",
        errorCode: "INTERNAL_SERVER_ERROR",
      },
    ]);
    expect(sample.success).toBe(false);
    const report = summarizeOperationReads([sample]);
    expect(report.requests.rpcFailures).toBe(1);
    expect(report.requests.successfulCompleteMedianMs).toBeNull();
    expect(report.summary[0]?.successfulSettledMedianMs).toBeNull();
    expect(JSON.stringify(report)).not.toContain("INTERNAL_SERVER_ERROR");
    expect(JSON.stringify(sample)).not.toMatch(/synthetic-(?:record|private)/);
  });

  it("checks both batch settlement and operation success, retaining index order and per-item timing", async () => {
    const sample = await serve(
      (response) => {
        response.setHeader("content-type", "application/x-ndjson");
        response.setHeader(
          "server-timing",
          'db-query;dur=0;desc="n=0 max=0 conc=0"',
        );
        response.write(line(2, { ok: true, value: success }));
        response.write(line(0, { ok: true, value: failure }));
        response.end(
          line(1, { ok: false, message: "synthetic-private-diagnostic" }),
        );
      },
      (origin) =>
        measureOperationRead(
          { batch: [item, item, item] },
          origin,
          new Headers(),
        ),
    );
    expect(
      sample.results.map((result) => [result.ok, result.errorKind]),
    ).toEqual([
      [false, "operation"],
      [false, "batch"],
      [true, null],
    ]);
    expect(sample.results.every((result) => result.settledMs !== null)).toBe(
      true,
    );
    expect(sample.results[2]?.settledMs).toBeLessThan(sample.completeMs);
    expect(sample.sqlCount).toBeNull();
    expect(sample.success).toBe(false);
    expect(JSON.stringify(sample)).not.toContain("synthetic-private");
  });

  it.each([
    { name: "missing item", body: line(0, { ok: true, value: success }) },
    {
      name: "duplicate index",
      body:
        line(0, { ok: true, value: success }) +
        line(0, { ok: true, value: success }),
    },
    { name: "out-of-range index", body: line(4, { ok: true, value: success }) },
    { name: "unterminated tail", body: '{"i":0,"r":' },
  ])("rejects $name batch results", async ({ body }) => {
    const sample = await serve(
      (response) => {
        response.setHeader("content-type", "application/x-ndjson");
        response.end(body);
      },
      (origin) =>
        measureOperationRead({ batch: [item, item] }, origin, new Headers()),
    );
    expect(sample.failure).toBe("protocol");
    expect(sample.success).toBe(false);
  });

  it("does not send unknown operations, mutations or subscriptions", async () => {
    let requests = 0;
    await serve(
      (response) => {
        requests++;
        response.end();
      },
      async (origin) => {
        for (const name of [
          "unknown.operation",
          "ai.applyFinanceCategorySuggestion",
          "ai.backfillLocationDescriptions",
        ]) {
          await expect(
            measureOperationRead(
              { operation: name, input: {} },
              origin,
              new Headers(),
            ),
          ).rejects.toThrow("Only registered queries can be measured");
        }
      },
    );
    expect(requests).toBe(0);
  });

  it("does not treat a successful envelope in an HTTP error as success", async () => {
    const sample = await serve(
      (response) => {
        response.statusCode = 503;
        response.end(JSON.stringify(superjson.serialize(success)));
      },
      (origin) => measureOperationRead(item, origin, new Headers()),
    );
    expect(sample.failure).toBe("http");
    expect(sample.success).toBe(false);
  });
});
