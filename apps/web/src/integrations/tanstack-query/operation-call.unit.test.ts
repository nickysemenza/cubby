import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { OperationError } from "~/lib/operation-error";
import { reset, snapshot } from "~/lib/perf/perf-store";
import type { OperationResult } from "~/server/operation-runtime/operation.contract";

import {
  overrideOperationDispatch,
  operationCall,
  unwrapOperationResult,
} from "./operation-call";

let restore = () => {};
beforeEach(reset);
afterEach(() => restore());

const ok = <T>(data: T): OperationResult<T> => ({ ok: true, data });

describe("operation call", () => {
  it("dispatches through the shared seam and observes the bound entity", async () => {
    const dispatch = vi.fn(async () => ok({ items: ["one"] }));
    restore = overrideOperationDispatch(dispatch);
    const operation = operationCall<{ entity: string }, { items: string[] }>({
      operation: "entity.list",
      parse: (result) => z.object({ items: z.array(z.string()) }).parse(result),
    });

    await expect(
      operation.forEntity("product").call({ entity: "product" }),
    ).resolves.toEqual({ items: ["one"] });
    expect(dispatch).toHaveBeenCalledWith(
      "entity.list",
      { entity: "product" },
      expect.objectContaining({ headers: expect.anything() }),
    );
    expect(snapshot().queries["start:entity.list"]).toMatchObject({
      operation: "entity.list",
      transport: "start",
      fetches: 1,
    });
  });

  it("records transport errors", async () => {
    restore = overrideOperationDispatch(() =>
      Promise.reject(new Error("broken")),
    );
    const operation = operationCall<Record<string, never>, never>({
      operation: "entity.filterOptions",
      parse: z.never().parse,
    });

    await expect(operation.call({})).rejects.toThrow("broken");
    expect(snapshot().queries["start:entity.filterOptions"]).toMatchObject({
      operation: "entity.filterOptions",
      errors: 1,
    });
  });

  it("raises the bound error type for a refused operation", async () => {
    class DetailError extends OperationError {}
    restore = overrideOperationDispatch(async () => ({
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "Product not found",
        requestId: "ray-operation-test",
      },
    }));
    const operation = operationCall<null, null>({
      operation: "entity.detail",
      parse: () => null,
      createError: (error) => new DetailError(error),
    });

    await expect(operation.call(null)).rejects.toMatchObject({
      name: "OperationError",
      requestId: "ray-operation-test",
    });
  });

  it("keeps request ids on their own out-of-order failures", async () => {
    const requestSchema = z.object({ id: z.string(), delay: z.number() });
    restore = overrideOperationDispatch((_operation, input) => {
      const { id, delay } = requestSchema.parse(input);
      return new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              ok: false,
              error: { code: "NOT_FOUND", message: "Missing", requestId: id },
            }),
          delay,
        ),
      );
    });
    const operation = operationCall<{ id: string; delay: number }, null>({
      operation: "entity.detail",
      parse: () => null,
    });

    const [slow, fast] = await Promise.allSettled([
      operation.call({ id: "request-slow", delay: 10 }),
      operation.call({ id: "request-fast", delay: 0 }),
    ]);

    expect(slow).toMatchObject({
      status: "rejected",
      reason: { requestId: "request-slow" },
    });
    expect(fast).toMatchObject({
      status: "rejected",
      reason: { requestId: "request-fast" },
    });
  });

  it("rejects undefined before TanStack Query receives it", () => {
    expect(() =>
      unwrapOperationResult("entity.detail", {
        ok: true,
        data: undefined,
      }),
    ).toThrowError(OperationError);
    expect(
      unwrapOperationResult("entity.detail", { ok: true, data: null }),
    ).toBeNull();
  });
});
