import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { reset, snapshot } from "~/lib/perf/perf-store";
import { StartOperationError } from "~/lib/start-operation-error";
import type { StartOperationResult } from "~/server/operation-runtime/start-operation.contract";

import {
  overrideStartDispatch,
  startOperation,
  unwrapStartOperationResult,
} from "./start-transport";

let restore = () => {};
beforeEach(reset);
afterEach(() => restore());

const ok = <T>(data: T): StartOperationResult<T> => ({ ok: true, data });

describe("Start operation binding", () => {
  it("dispatches through the shared seam and observes the bound entity", async () => {
    const dispatch = vi.fn(async () => ok({ items: ["one"] }));
    restore = overrideStartDispatch(dispatch);
    const operation = startOperation<{ entity: string }, { items: string[] }>({
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
    restore = overrideStartDispatch(() => Promise.reject(new Error("broken")));
    const operation = startOperation<Record<string, never>, never>({
      operation: "entity.filterOptions",
      parse: z.never().parse,
    });

    await expect(operation.call({})).rejects.toThrow("broken");
    expect(snapshot().queries["start:entity.filterOptions"]).toMatchObject({
      operation: "entity.filterOptions",
      errors: 1,
    });
  });

  it("records registered mutations through the mutation channel", async () => {
    restore = overrideStartDispatch(() => Promise.resolve(ok(null)));
    const operation = startOperation<null, null>({
      operation: "image.delete",
      kind: "mutation",
      parse: () => null,
    });

    await operation.call(null);

    expect(snapshot().mutations[0]).toMatchObject({
      operation: "image.delete",
      transport: "start",
      outcome: "success",
    });
  });

  it("derives query metadata from the same declaration the call observes", () => {
    const operation = startOperation<null, null>({
      operation: "cookbook.list",
      parse: () => null,
    });

    expect(operation.meta).toEqual({
      transport: "start",
      operation: "cookbook.list",
      observedByTransport: true,
    });
    expect(() => operation.forEntity("cookbook")).toThrow(
      "cookbook is not registered for cookbook.list",
    );
  });

  it("raises the bound error type for a refused operation", async () => {
    class DetailError extends StartOperationError {}
    restore = overrideStartDispatch(async () => ({
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "Product not found",
        requestId: "ray-operation-test",
      },
    }));
    const operation = startOperation<null, null>({
      operation: "entity.detail",
      parse: () => null,
      createError: (error) => new DetailError(error),
    });

    await expect(operation.call(null)).rejects.toMatchObject({
      name: "StartOperationError",
      requestId: "ray-operation-test",
    });
  });

  it("keeps request ids on their own out-of-order failures", async () => {
    const requestSchema = z.object({ id: z.string(), delay: z.number() });
    restore = overrideStartDispatch((_operation, input) => {
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
    const operation = startOperation<{ id: string; delay: number }, null>({
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
      unwrapStartOperationResult("entity.detail", {
        ok: true,
        data: undefined,
      }),
    ).toThrowError(StartOperationError);
    expect(
      unwrapStartOperationResult("entity.detail", { ok: true, data: null }),
    ).toBeNull();
  });
});
