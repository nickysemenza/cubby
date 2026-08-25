import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StartOperationResult } from "~/server/start-operation.contract";
import {
  StartOperationError,
  startOperation,
  unwrapStartOperationResult,
} from "./start-transport";

vi.mock("~/lib/flags", () => ({ getFlag: () => true }));

beforeEach(() => vi.stubGlobal("window", {}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ok = <T>(data: T): StartOperationResult<T> => ({ ok: true, data });

describe("Start operation binding", () => {
  it("logs semantic request and result events and carries the operation id", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const operation = startOperation<{ entity: string }, { items: unknown[] }>({
      operation: "entity.list",
      transport: (_input, { headers }) => {
        expect(headers).toMatchObject({
          "x-cubby-operation-id": expect.stringMatching(/^op-/u),
        });
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

  it("derives query metadata from the same declaration the call observes", () => {
    const operation = startOperation<null, null>({
      operation: "cookbook.list",
      entity: "cookbook",
      transport: () => Promise.resolve(ok(null)),
      parse: () => null,
    });

    expect(operation.meta).toEqual({
      transport: "start",
      operation: "cookbook.list",
      entity: "cookbook",
      observedByTransport: true,
    });
    expect(operation.forEntity("recipe").meta).toMatchObject({
      operation: "cookbook.list",
      entity: "recipe",
    });
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
          error: { code: "NOT_FOUND", message: "Product not found" },
        }),
      parse: () => null,
      createError: (error) => new DetailError(error),
    });

    await expect(operation.call(null)).rejects.toBeInstanceOf(DetailError);
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
