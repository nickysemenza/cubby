import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StartOperationResult } from "~/server/start-operation.contract";

import {
  StartOperationError,
  startOperation,
  unwrapStartOperationResult,
} from "./start-transport";

vi.mock("~/lib/flags", () => ({ getFlag: () => true }));

const mocks = vi.hoisted(() => ({ dispatch: vi.fn() }));

vi.mock("~/server-functions/start-operation-dispatch.functions", () => ({
  dispatchStartOperationTransport: mocks.dispatch,
}));

beforeEach(() => {
  vi.stubGlobal("window", {});
  mocks.dispatch.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ok = <T>(data: T): StartOperationResult<T> => ({ ok: true, data });

describe("Start operation binding", () => {
  it("uses the lazy shared dispatcher when no explicit transport is supplied", async () => {
    mocks.dispatch.mockResolvedValue(ok({ items: ["one"] }));
    const operation = startOperation<{ entity: string }, { items: string[] }>({
      operation: "entity.list",
      parse: (result) => result as { items: string[] },
    });

    await expect(operation.call({ entity: "product" })).resolves.toEqual({
      items: ["one"],
    });
    expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { operation: "entity.list", input: { entity: "product" } },
      }),
    );
  });

  it("keeps an explicit transport independent from the shared dispatcher", async () => {
    const transport = vi.fn(() => Promise.resolve(ok("local")));
    const operation = startOperation<null, string>({
      operation: "cookbook.list",
      transport,
      parse: (result) => result as string,
    });

    await expect(operation.call(null)).resolves.toBe("local");
    expect(transport).toHaveBeenCalledOnce();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("keeps the operation id in browser observability without sending it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const operation = startOperation<{ entity: string }, { items: unknown[] }>({
      operation: "entity.list",
      transport: (_input, { headers }) => {
        expect(new Headers(headers).get("x-cubby-operation-id")).toBeNull();
        return Promise.resolve(ok({ items: [], meta: { totalCount: 0 } }));
      },
      parse: (result) => result as { items: unknown[] },
    });

    const result = await operation
      .forEntity("product")
      .call({ entity: "product" });

    expect(result).toMatchObject({ items: [] });
    expect(log.mock.calls[0]?.[0]).toMatch(/>> op-\d+ entity\.list/u);
    expect(log.mock.calls[0]?.[1]).toMatchObject({ entity: "product" });
    expect(log.mock.calls[1]?.[0]).toMatch(/<< op-\d+ entity\.list/u);
  });

  it("always logs errors", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const operation = startOperation<Record<string, never>, never>({
      operation: "entity.filterOptions",
      transport: () => Promise.reject(new Error("broken")),
      parse: (result) => result as never,
    });

    await expect(operation.call({})).rejects.toThrow("broken");
    expect(error.mock.calls[0]?.[0]).toMatch(/entity\.filterOptions/u);
  });

  it("marks strong follow-up reads after every registered mutation", async () => {
    const documentStub = { cookie: "" };
    vi.stubGlobal("document", documentStub);
    const operation = startOperation<null, null>({
      operation: "image.delete",
      kind: "mutation",
      transport: () => Promise.resolve(ok(null)),
      parse: () => null,
    });

    await operation.call(null);

    expect(documentStub.cookie).toContain("cubby-fresh-reads=1");
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
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
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
    vi.spyOn(console, "error").mockImplementation(() => {});
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
