import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
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
  respond: (response: ServerResponse, request: IncomingMessage) => void,
  run: (origin: URL) => Promise<T>,
) {
  const server = createServer((request, response) =>
    respond(response, request),
  );
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
  it("retains duplicate query positions without repeating sample metadata", async () => {
    const request = {
      operation,
      input: { slots: ["project.budget"], id: "synthetic-private-id" },
    };
    const sample = await serve(
      (response) => {
        response.setHeader("content-type", "application/x-ndjson");
        response.end(
          line(0, { ok: true, value: success }) +
            line(1, { ok: true, value: success }),
        );
      },
      (origin) =>
        measureOperationRead(
          { batch: [request, request] },
          origin,
          new Headers(),
        ),
    );
    const report = summarizeOperationReads([sample, sample]);
    expect(report.requestedReads).toHaveLength(2);
    expect(report.requestedReads?.map((read) => read.shape)).toEqual(
      sample.requestedReads.map((read) => read.shape),
    );
  });
  it("carries only requested declaration metadata across measurement and aggregation", async () => {
    const samples = await serve(
      (response) => {
        response.end(JSON.stringify(superjson.serialize(success)));
      },
      async (origin) => [
        await measureOperationRead(
          {
            operation,
            input: {
              slots: ["project.budget"],
              id: "synthetic-private-id",
              extra: "synthetic-private-input",
            },
          },
          origin,
          new Headers(),
        ),
      ],
    );
    expect(samples[0]).toMatchObject({
      requestedReads: [
        { operation, shape: { kind: "report", slots: ["project.budget"] } },
      ],
    });
    expect(summarizeOperationReads(samples)).toMatchObject({
      requestedReads: [{ operation, shape: { slots: ["project.budget"] } }],
    });
    expect(JSON.stringify(samples)).not.toContain("synthetic-private");
  });

  it("keeps database medians from successful requests separate from failed attempts", async () => {
    let request = 0;
    const samples = await serve(
      (response) => {
        const ok = request++ === 0;
        response.setHeader("content-type", "application/json");
        response.setHeader(
          "server-timing",
          `db-query;dur=10;desc="n=${ok ? 7 : 0} max=10 conc=1"`,
        );
        response.end(
          JSON.stringify(superjson.serialize(ok ? success : failure)),
        );
      },
      async (origin) => [
        await measureOperationRead(item, origin, new Headers()),
        await measureOperationRead(item, origin, new Headers()),
      ],
    );
    const report = summarizeOperationReads(samples);
    expect(report.requests.databasePerSuccessfulRequest.sqlCount).toEqual({
      observedRequests: 1,
      totalRequests: 1,
      median: 7,
    });
    expect(report.requests.rpcFailures).toBe(1);
  });

  it("preserves server batch rejection codes without calling them malformed stream results", async () => {
    const sample = await serve(
      (response) => {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify(
            superjson.serialize({
              ...failure,
              error: {
                ...failure.error,
                code: "BAD_REQUEST",
                requestId: "synthetic-correlation",
              },
            }),
          ),
        );
      },
      (origin) =>
        measureOperationRead({ batch: [item, item] }, origin, new Headers()),
    );
    expect(sample.failure).toBe("dispatch");
    expect(sample.dispatchErrorCode).toBe("BAD_REQUEST");
    expect(sample.requestId).toBe("synthetic-correlation");
    const report = summarizeOperationReads([sample]);
    expect(report.requests.dispatchFailures).toBe(1);
    expect(report.summary[0]?.unsettledResults).toBe(2);
    expect(JSON.stringify(report)).not.toMatch(
      /BAD_REQUEST|synthetic-correlation/,
    );
    expect(JSON.stringify(sample)).not.toContain("synthetic-private");
  });

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

it("writes public and private CLI artifacts without raw input even on RPC failure", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdir, mkdtemp, writeFile, readFile, rm } =
    await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const root = resolve("../../artifacts/read-performance");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(`${root}/cli-`);
  try {
    await writeFile(
      `${directory}/input.json`,
      JSON.stringify({
        operation,
        input: {
          slots: ["project.budget"],
          id: "synthetic-private-id",
          filters: { "synthetic-private-key": "synthetic-private-value" },
        },
      }),
    );
    await writeFile(
      `${directory}/context.json`,
      JSON.stringify({
        environment: "local",
        population: "synthetic",
        scale: 1000,
        revision: "a".repeat(40),
      }),
    );
    const code = await serve(
      (response) => response.end(JSON.stringify(superjson.serialize(failure))),
      async (origin) => {
        try {
          await promisify(execFile)(
            process.execPath,
            [
              "--import",
              "tsx",
              "tooling/checks/read-performance.ts",
              "--origin",
              origin.href,
              "--mode",
              "operations",
              "--samples",
              "1",
              "--first-invocation",
              "--input",
              `${directory}/input.json`,
              "--context",
              `${directory}/context.json`,
              "--output",
              `${directory}/public.json`,
              "--raw-output",
              `${directory}/private.json`,
            ],
            {
              env: {
                ...process.env,
                CUBBY_READ_AUTHORIZATION: "synthetic-private-credential",
              },
            },
          );
          return 0;
        } catch (error) {
          return (error as { code: number }).code;
        }
      },
    );
    expect(code).toBe(1);
    for (const name of ["public", "private"]) {
      const text = await readFile(`${directory}/${name}.json`, "utf8");
      expect(text).not.toContain("synthetic-private");
      expect(JSON.parse(text)).toMatchObject({
        schema: 5,
        workloadContext: { scale: 1000 },
        requestedReads: [{ operation, shape: { slots: ["project.budget"] } }],
        operationRequests: { rpcFailures: 1 },
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Empty pages must not claim enrichment; populated pages request only server-selected groups.
it.each([false, true])(
  "reports actual progressive phases when rows exist: %s",
  async (hasRows) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { mkdtemp, writeFile, readFile, rm } =
      await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "read-performance-"));
    try {
      await writeFile(
        join(directory, "input.json"),
        JSON.stringify({ filters: {} }),
      );
      await serve(
        (response, request) => {
          const body = request.url?.endsWith("listBase")
            ? {
                data: hasRows ? [{ id: "synthetic-private-id" }] : [],
                groups: [{ id: "derived" }],
              }
            : request.url?.endsWith("listEnrichment")
              ? { groups: [{ state: "ready" }] }
              : {};
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify(body));
        },
        async (origin) => {
          await promisify(execFile)(
            process.execPath,
            [
              "--import",
              "tsx",
              "tooling/checks/read-performance.ts",
              "--origin",
              origin.href,
              "--mode",
              "progressive",
              "--entities",
              "product",
              "--samples",
              "1",
              "--first-invocation",
              "--input",
              join(directory, "input.json"),
              "--output",
              join(directory, "public.json"),
            ],
            {
              env: {
                ...process.env,
                CUBBY_READ_AUTHORIZATION: "synthetic-private-credential",
              },
            },
          );
        },
      );
      const text = await readFile(join(directory, "public.json"), "utf8");
      const artifact = JSON.parse(text);
      expect(text).not.toContain("synthetic-private");
      expect(
        artifact.requestedReads.map(
          (read: {
            entity: string;
            operation: string;
            shape: { projection: string; groups: string[] };
          }) => ({
            entity: read.entity,
            operation: read.operation,
            projection: read.shape.projection,
            groups: read.shape.groups,
          }),
        ),
      ).toEqual([
        {
          entity: "product",
          operation: "listBase",
          projection: "base",
          groups: ["core"],
        },
        ...(hasRows
          ? [
              {
                entity: "product",
                operation: "listEnrichment",
                projection: "enrichment",
                groups: ["derived"],
              },
            ]
          : []),
        {
          entity: "product",
          operation: "listSummary",
          projection: "summary",
          groups: [],
        },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
