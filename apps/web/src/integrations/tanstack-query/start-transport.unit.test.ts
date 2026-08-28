import { beforeEach, describe, expect, it, vi } from "vitest";
import { type JSONType, z } from "zod";

import { reset, snapshot } from "~/lib/perf/perf-store";
import type { StartOperationResult } from "~/server/start-operation.contract";

import {
  StartOperationError,
  startOperation,
  type StartTransportRuntime,
  unwrapStartOperationResult,
} from "./start-transport";

beforeEach(reset);

const ok = <T>(data: T): StartOperationResult<T> => ({ ok: true, data });

describe("Start operation binding", () => {
  it("uses the lazy shared dispatcher when no explicit transport is supplied", async () => {
    const dispatch = vi.fn(async () => ok({ items: ["one"] }));
    const runtime = { dispatch } satisfies StartTransportRuntime;
    const operation = startOperation<{ entity: string }, { items: string[] }>(
      {
        operation: "entity.list",
        parse: (result) =>
          z.object({ items: z.array(z.string()) }).parse(result),
      },
      runtime,
    );

    await expect(operation.call({ entity: "product" })).resolves.toEqual({
      items: ["one"],
    });
    expect(dispatch).toHaveBeenCalledWith(
      "entity.list",
      { entity: "product" },
      expect.objectContaining({ headers: expect.anything() }),
    );
  });

  it("keeps an explicit transport independent from the shared dispatcher", async () => {
    const transport = vi.fn(() => Promise.resolve(ok("local")));
    const operation = startOperation<null, string>({
      operation: "cookbook.list",
      transport,
      parse: (result) => z.string().parse(result),
    });

    await expect(operation.call(null)).resolves.toBe("local");
    expect(transport).toHaveBeenCalledOnce();
  });

  it("keeps the entity in observability without sending operation headers", async () => {
    const operation = startOperation<{ entity: string }, { items: JSONType[] }>(
      {
        operation: "entity.list",
        transport: (_input, { headers }) => {
          expect(new Headers(headers).get("x-cubby-operation-id")).toBeNull();
          return Promise.resolve(ok({ items: [], meta: { totalCount: 0 } }));
        },
        parse: (result) =>
          z
            .object({ items: z.array(z.json()) })
            .passthrough()
            .parse(result),
      },
    );

    const result = await operation
      .forEntity("product")
      .call({ entity: "product" });

    expect(result).toMatchObject({ items: [] });
    expect(snapshot().queries["start:entity.list"]).toMatchObject({
      operation: "entity.list",
      transport: "start",
      fetches: 1,
    });
  });

  it("records transport errors", async () => {
    const operation = startOperation<Record<string, never>, never>({
      operation: "entity.filterOptions",
      transport: () => Promise.reject(new Error("broken")),
      parse: z.never().parse,
    });

    await expect(operation.call({})).rejects.toThrow("broken");
    expect(snapshot().queries["start:entity.filterOptions"]).toMatchObject({
      operation: "entity.filterOptions",
      errors: 1,
    });
  });

  it("records registered mutations through the mutation channel", async () => {
    const operation = startOperation<null, null>({
      operation: "image.delete",
      kind: "mutation",
      transport: () => Promise.resolve(ok(null)),
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
      transport: () => Promise.resolve(ok(null)),
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
    const operation = startOperation<null, null>({
      operation: "entity.detail",
      transport: () =>
        Promise.resolve({
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: "Product not found",
            requestId: "ray-operation-test",
          },
        }),
      parse: () => null,
      createError: (error) => new DetailError(error),
    });

    await expect(operation.call(null)).rejects.toMatchObject({
      name: "StartOperationError",
      requestId: "ray-operation-test",
    });
  });

  it("keeps request ids on their own out-of-order failures", async () => {
    const operation = startOperation<{ id: string; delay: number }, null>({
      operation: "entity.detail",
      transport: ({ id, delay }) =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                ok: false,
                error: {
                  code: "NOT_FOUND",
                  message: "Missing",
                  requestId: id,
                },
              }),
            delay,
          ),
        ),
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
