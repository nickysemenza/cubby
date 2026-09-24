import { testUserId } from "@cubby/schemas/testing";
import { fromAny } from "@total-typescript/shoehorn";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import type { ObservedResult } from "~/server/observed-request";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";
import type { AppSpan } from "~/server/tracing";

import {
  createStartOperationRunner,
  normalizeStartOperationError,
  type StartOperationRuntime,
} from "./start-operation.server";

const database = new Database(() => {
  throw new Error("The Start operation unit test must not resolve a database");
});
const cachedDatabase = new Database(() => {
  throw new Error("The cached Start database must not resolve during tests");
});
const context = {
  ...requireActor(
    createTestRequestContext(database, {
      auth: { userId: testUserId("start-operation-user") },
      readDb: cachedDatabase,
    }),
  ),
  readConsistency: {
    consistency: "bounded-stale" as const,
    reason: "cached-policy" as const,
  },
};

const setAttribute = vi.fn<AppSpan["setAttribute"]>();
const setAttributes = vi.fn<AppSpan["setAttributes"]>();
const span: AppSpan = {
  isRecording: true,
  setAttribute,
  setAttributes,
  setError: () => undefined,
  recordException: () => undefined,
};
const authenticate = vi.fn<StartOperationRuntime["authenticate"]>();
const markCalendarDirty = vi.fn<StartOperationRuntime["markCalendarDirty"]>();
const recordDatabaseWrite = vi.fn(async () => undefined);
const observedOperations: string[] = [];
const inspections: ObservedResult[] = [];
const runtime: StartOperationRuntime = {
  authenticate,
  markCalendarDirty,
  recordDatabaseWrite,
  observe: async (definition, observation, run) => {
    observedOperations.push(definition.id);
    const result = await run(span);
    const inspection = observation.inspectResult?.(result);
    if (inspection) inspections.push(inspection);
    return result;
  },
};
const runStartOperation = createStartOperationRunner(runtime);

const request = (signal = new AbortController().signal) => ({
  headers: new Headers(),
  signal,
});

describe("runStartOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    observedOperations.length = 0;
    inspections.length = 0;
    authenticate.mockResolvedValue(context);
  });

  it("uses a trusted API context once and fails closed without freshness", async () => {
    const result = await runStartOperation({
      operation: "dashboard.counts",
      type: "query",
      input: undefined,
      inputSchema: z.undefined(),
      outputSchema: z.literal(true),
      request: {
        ...request(),
        apiContext: { ...context, requestOrigin: "api" },
      },
      readPolicy: "context",
      run: async (actor) => {
        expect(actor.auth.userId).toBe(context.auth.userId);
        expect(actor.readDb).toBe(database);
        return true as const;
      },
    });
    expect(result).toEqual({ ok: true, data: true });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("resolves server policy for HTTP list reads", async () => {
    const run = vi.fn(async () => true as const);
    await runStartOperation({
      operation: "entity.list",
      type: "query",
      input: {},
      inputSchema: z.object({}),
      outputSchema: z.literal(true),
      request: {
        ...request(),
        apiContext: { ...context, requestOrigin: "api" },
      },
      run,
    });

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ db: database, readDb: database }),
      {},
    );
  });

  it("propagates a request id only through the structured failure", () => {
    expect(
      normalizeStartOperationError(
        new Error("broken"),
        "run",
        "ray-operation-test",
      ).publicError,
    ).toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      requestId: "ray-operation-test",
    });
  });

  it("authenticates and parses both sides of the operation", async () => {
    const run = vi.fn(async (_context, input: { count: number }) => ({
      doubled: input.count * 2,
    }));

    await expect(
      runStartOperation({
        operation: "entity.detail",
        type: "query",
        input: { count: "3" },
        inputSchema: z.object({ count: z.coerce.number().int() }),
        outputSchema: z.object({ doubled: z.number().int() }),
        request: request(),
        run,
      }),
    ).resolves.toEqual({ ok: true, data: { doubled: 6 } });

    expect(authenticate).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ db: database, readDb: database }),
      { count: 3 },
    );
    expect(observedOperations).toEqual(["entity.detail"]);
    expect(inspections).toMatchObject([{ workload: "ui" }]);
  });

  it("hides the cached adapter from an explicitly strong query", async () => {
    const run = vi.fn(async () => ({ ok: true }));

    await runStartOperation({
      operation: "entity.detail",
      type: "query",
      input: {},
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      request: request(),
      readPolicy: "strong",
      run,
    });

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ db: database, readDb: database }),
      {},
    );
  });

  it("makes the whole mutation workflow authoritative", async () => {
    const run = vi.fn(async () => ({ ok: true }));

    await runStartOperation({
      operation: "entity.mutate",
      type: "mutation",
      input: {},
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      request: request(),
      run,
    });

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ db: database, readDb: database }),
      {},
    );
    expect(markCalendarDirty).toHaveBeenCalledWith(
      expect.objectContaining({ db: database }),
      expect.any(Headers),
      "entity.mutate",
    );
    expect(recordDatabaseWrite).toHaveBeenCalledWith("entity.mutate");
  });

  it("records freshness when a mutation handler fails after partial work", async () => {
    await expect(
      runStartOperation({
        operation: "entity.mutate",
        type: "mutation",
        input: {},
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.boolean() }),
        request: request(),
        run: async () => {
          throw new Error("write committed before follow-up failed");
        },
      }),
    ).resolves.toMatchObject({ ok: false });

    expect(recordDatabaseWrite).toHaveBeenCalledOnce();
    expect(recordDatabaseWrite).toHaveBeenCalledWith("entity.mutate");
  });

  it("records freshness when mutation output validation fails", async () => {
    await expect(
      runStartOperation({
        operation: "entity.mutate",
        type: "mutation",
        input: {},
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.boolean() }),
        request: request(),
        run: async () =>
          fromAny<{ ok: boolean }, { ok: string }>({ ok: "bad" }),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { reason: "INVALID_OUTPUT" },
    });

    expect(recordDatabaseWrite).toHaveBeenCalledOnce();
  });

  it("does not mark a catch-up claim as a household data write", async () => {
    await runStartOperation({
      operation: "maintenance.requestCatchUp",
      type: "mutation",
      input: undefined,
      inputSchema: z.undefined(),
      outputSchema: z.object({ status: z.literal("recent") }),
      request: request(),
      run: async () => ({ status: "recent" as const }),
    });

    expect(recordDatabaseWrite).not.toHaveBeenCalled();
    expect(markCalendarDirty).not.toHaveBeenCalled();
  });

  it("does not record freshness for a pure read", async () => {
    await expect(
      runStartOperation({
        operation: "entity.detail",
        type: "query",
        input: {},
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.boolean() }),
        request: request(),
        run: async () => ({ ok: true }),
      }),
    ).resolves.toEqual({ ok: true, data: { ok: true } });

    expect(recordDatabaseWrite).not.toHaveBeenCalled();
  });

  it("keeps a default query strong when request context carries the fresh marker decision", async () => {
    authenticate.mockResolvedValue({
      ...context,
      readDb: database,
      readConsistency: {
        consistency: "strong",
        reason: "fresh-after-write",
      },
    });
    const run = vi.fn(async () => ({ ok: true }));

    await runStartOperation({
      operation: "entity.detail",
      type: "query",
      input: {},
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      request: request(),
      run,
    });

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ db: database, readDb: database }),
      {},
    );
  });

  it("uses the parsed input entity rather than an inbound header on the inner span", async () => {
    const entityRequest = {
      ...request(),
      headers: new Headers({
        "x-cubby-operation": "entity.detail",
        "x-cubby-operation-kind": "query",
        "x-cubby-operation-entity": "wish",
      }),
    };

    await runStartOperation({
      operation: "entity.detail",
      type: "query",
      input: { entity: "product" },
      inputSchema: z.object({ entity: z.literal("product") }),
      outputSchema: z.object({ ok: z.boolean() }),
      request: entityRequest,
      run: async () => ({ ok: true }),
    });

    expect(setAttribute).toHaveBeenCalledWith("cubby.entity", "product");
  });

  it("returns normalized validation issues without running the operation", async () => {
    const run = vi.fn();
    const result = await runStartOperation({
      operation: "entity.detail",
      type: "query",
      input: { count: "nope" },
      inputSchema: z.object({ count: z.number().int() }),
      outputSchema: z.object({ doubled: z.number().int() }),
      request: request(),
      run,
    });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "BAD_REQUEST",
        reason: "INVALID_INPUT",
        validationIssues: [
          expect.objectContaining({ path: ["count"], code: "invalid_type" }),
        ],
      }),
    });
    expect(run).not.toHaveBeenCalled();
    expect(inspections).toMatchObject([
      {
        error: expect.objectContaining({
          code: "BAD_REQUEST",
          reason: "INVALID_INPUT",
        }),
        workload: "ui",
      },
    ]);
  });

  it("selects dependent output schemas only after input validation", async () => {
    const outputSchema = vi.fn((input: { kind: "count" }) => {
      expect(input).toEqual({ kind: "count" });
      return z.object({ count: z.number().int() });
    });

    await expect(
      runStartOperation({
        operation: "entity.detail",
        type: "query",
        input: null,
        inputSchema: z.object({ kind: z.literal("count") }),
        outputSchema,
        request: request(),
        run: async () => ({ count: 1 }),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "BAD_REQUEST", reason: "INVALID_INPUT" },
    });
    expect(outputSchema).not.toHaveBeenCalled();

    await expect(
      runStartOperation({
        operation: "entity.detail",
        type: "query",
        input: { kind: "count" },
        inputSchema: z.object({ kind: z.literal("count") }),
        outputSchema,
        request: request(),
        run: async () => ({ count: 1 }),
      }),
    ).resolves.toEqual({ ok: true, data: { count: 1 } });
    expect(outputSchema).toHaveBeenCalledOnce();
  });

  it("normalizes application and database errors", async () => {
    const appResult = await runStartOperation({
      operation: "entity.mutate",
      type: "mutation",
      input: {},
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      request: request(),
      run: async () => {
        const refusal = createAppError(
          "PRODUCT_NOT_FOUND",
          "Product not found",
        );
        throw new Error("Product lookup failed", {
          cause: {
            originalError: new Error("Repository lookup", { cause: refusal }),
          },
        });
      },
    });
    expect(appResult).toMatchObject({
      ok: false,
      error: {
        code: "NOT_FOUND",
        reason: "PRODUCT_NOT_FOUND",
        message: "Product not found",
      },
    });

    const databaseResult = await runStartOperation({
      operation: "entity.mutate",
      type: "mutation",
      input: {},
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      request: request(),
      run: async () => {
        throw new Error("Failed query", {
          cause: {
            code: "23505",
            table: "Product",
            detail: "Key (name)=(duplicate) already exists.",
          },
        });
      },
    });
    expect(databaseResult).toMatchObject({
      ok: false,
      error: {
        code: "CONFLICT",
        reason: "DUPLICATE_RECORD",
        message: "A product with that name already exists.",
      },
    });
    expect(inspections).toHaveLength(2);
    expect(inspections.every(({ error }) => error instanceof Error)).toBe(true);
    expect(markCalendarDirty).not.toHaveBeenCalled();
  });

  it("exposes authenticated causes without returning server stacks", async () => {
    const codedInfrastructureError = Object.assign(
      new Error("Connection reset by upstream"),
      { code: "ECONNRESET" },
    );
    const unknown = await runStartOperation({
      operation: "entity.detail",
      type: "query",
      input: {},
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      request: request(),
      run: async () => {
        throw codedInfrastructureError;
      },
    });
    expect(unknown).toMatchObject({
      ok: false,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        reason: "UNKNOWN_ERROR",
        message: "Connection reset by upstream",
        diagnostics: {
          stage: "run",
          causes: [
            { code: "ECONNRESET", message: "Connection reset by upstream" },
          ],
        },
      },
    });

    const invalidOutput = await runStartOperation({
      operation: "entity.detail",
      type: "query",
      input: {},
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      request: request(),
      run: async () =>
        fromAny<{ ok: boolean }, { ok: string }>({ ok: "not-a-boolean" }),
    });
    expect(invalidOutput).toMatchObject({
      ok: false,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        reason: "INVALID_OUTPUT",
        message: "The operation could not be completed",
      },
    });
    expect(inspections).toHaveLength(2);
    expect(inspections.every(({ error }) => error instanceof Error)).toBe(true);
    expect(JSON.stringify(unknown)).not.toContain('"stack"');
  });

  it("keeps authentication-provider failures private", async () => {
    authenticate.mockRejectedValueOnce(
      new Error("Authentication backend password=fixture-secret"),
    );
    const result = await runStartOperation({
      operation: "entity.detail",
      type: "query",
      input: {},
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      request: request(),
      run: async () => ({}),
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        message: "The operation could not be completed",
        diagnostics: { causes: [], stage: "context" },
      },
    });
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
  });

  it("throws cancellation before and after execution", async () => {
    const before = new AbortController();
    before.abort(new DOMException("cancelled", "AbortError"));
    await expect(
      runStartOperation({
        operation: "entity.detail",
        type: "query",
        input: {},
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.boolean() }),
        request: request(before.signal),
        run: async () => ({ ok: true }),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    const after = new AbortController();
    await expect(
      runStartOperation({
        operation: "entity.detail",
        type: "query",
        input: {},
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.boolean() }),
        request: request(after.signal),
        run: async () => {
          after.abort(new DOMException("cancelled", "AbortError"));
          return { ok: true };
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
