import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAppError } from "~/server/errors/app-error";
import { runStartOperation } from "./start-operation.server";

const mocks = vi.hoisted(() => ({
  createRequestContext: vi.fn(),
  requireActor: vi.fn((context: unknown) => context),
  observeRequest: vi.fn(),
  setAttributes: vi.fn(),
}));

vi.mock("~/server/request-context", () => ({
  createRequestContext: mocks.createRequestContext,
  requireActor: mocks.requireActor,
}));

vi.mock("~/server/observed-request", () => ({
  observeRequest: mocks.observeRequest,
}));

const database = {};
const context = {
  db: database,
  readDb: database,
  auth: { userId: "user-1", sessionId: "session-1" },
  actorContext: { userId: "user-1" },
  requestOrigin: "ui",
  readConsistency: { consistency: "bounded-stale", reason: "cached-policy" },
};

const request = (signal = new AbortController().signal) => ({
  headers: new Headers({ "x-cubby-operation-id": "op-42" }),
  signal,
});

describe("runStartOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createRequestContext.mockResolvedValue(context);
    mocks.observeRequest.mockImplementation(
      async (options: {
        run: (span: { setAttributes: typeof mocks.setAttributes }) => Promise<{
          result: unknown;
          observedError?: unknown;
        }>;
        inspectResult?: (result: {
          result: unknown;
          observedError?: unknown;
        }) => unknown;
      }) => {
        const result = await options.run({
          setAttributes: mocks.setAttributes,
        });
        options.inspectResult?.(result);
        return result;
      },
    );
  });

  it("authenticates and parses both sides of the operation", async () => {
    const run = vi.fn(async (_context, input: { count: number }) => ({
      doubled: input.count * 2,
    }));

    await expect(
      runStartOperation({
        operation: "example.read",
        type: "query",
        input: { count: "3" },
        inputSchema: z.object({ count: z.coerce.number().int() }),
        outputSchema: z.object({ doubled: z.number().int() }),
        request: request(),
        run,
      }),
    ).resolves.toEqual({ ok: true, data: { doubled: 6 } });

    expect(mocks.createRequestContext).toHaveBeenCalledOnce();
    expect(mocks.requireActor).toHaveBeenCalledWith(context);
    expect(run).toHaveBeenCalledWith(context, { count: 3 });
    expect(mocks.observeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "example.read",
        operationId: "op-42",
        system: "start",
      }),
    );
  });

  it("returns normalized validation issues without running the operation", async () => {
    const run = vi.fn();
    const result = await runStartOperation({
      operation: "example.read",
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
  });

  it("selects dependent output schemas only after input validation", async () => {
    const outputSchema = vi.fn((input: { kind: "count" }) => {
      expect(input).toEqual({ kind: "count" });
      return z.object({ count: z.number().int() });
    });

    await expect(
      runStartOperation({
        operation: "example.read",
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
        operation: "example.read",
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
      operation: "example.write",
      type: "mutation",
      input: {},
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      request: request(),
      run: async () => {
        throw createAppError("PRODUCT_NOT_FOUND", "Product not found");
      },
    });
    expect(appResult).toEqual({
      ok: false,
      error: {
        code: "NOT_FOUND",
        reason: "PRODUCT_NOT_FOUND",
        message: "Product not found",
      },
    });

    const databaseResult = await runStartOperation({
      operation: "example.write",
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
    expect(databaseResult).toEqual({
      ok: false,
      error: {
        code: "CONFLICT",
        reason: "DUPLICATE_RECORD",
        message: "A product with that name already exists.",
      },
    });
  });

  it("does not expose unknown or invalid-output details", async () => {
    const codedInfrastructureError = Object.assign(
      new Error("secret implementation detail"),
      { code: "ECONNRESET" },
    );
    const unknown = await runStartOperation({
      operation: "example.read",
      type: "query",
      input: {},
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      request: request(),
      run: async () => {
        throw codedInfrastructureError;
      },
    });
    expect(unknown).toEqual({
      ok: false,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        reason: "UNKNOWN_ERROR",
        message: "The operation could not be completed",
      },
    });

    const invalidOutput = await runStartOperation({
      operation: "example.read",
      type: "query",
      input: {},
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      request: request(),
      run: async () => ({ ok: "not-a-boolean" }),
    });
    expect(invalidOutput).toEqual({
      ok: false,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        reason: "INVALID_OUTPUT",
        message: "The operation could not be completed",
      },
    });
  });

  it("throws cancellation before and after execution", async () => {
    const before = new AbortController();
    before.abort(new DOMException("cancelled", "AbortError"));
    await expect(
      runStartOperation({
        operation: "example.read",
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
        operation: "example.read",
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
