import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  observedStartCall,
  StartOperationError,
  unwrapStartOperationResult,
} from "./start-transport";

vi.mock("~/lib/flags", () => ({ getFlag: () => true }));

beforeEach(() => vi.stubGlobal("window", {}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Start operation logging", () => {
  it("logs semantic request and result events", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await observedStartCall({
      operation: "entity.list",
      entity: "product",
      input: { entity: "product", filters: {} },
      call: async (headers) => {
        expect(headers).toMatchObject({
          "x-cubby-operation-id": expect.stringMatching(/^op-/u),
        });
        return { items: [], meta: { totalCount: 0 } };
      },
    });

    expect(result).toMatchObject({ items: [] });
    expect(log.mock.calls[0]?.[0]).toMatch(/>> op-\d+ entity\.list/u);
    expect(log.mock.calls[1]?.[0]).toMatch(/<< op-\d+ entity\.list/u);
  });

  it("always logs errors", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      observedStartCall({
        operation: "entity.filterOptions",
        input: {},
        call: async () => {
          throw new Error("broken");
        },
      }),
    ).rejects.toThrow("broken");
    expect(error.mock.calls[0]?.[0]).toMatch(/entity\.filterOptions/u);
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
