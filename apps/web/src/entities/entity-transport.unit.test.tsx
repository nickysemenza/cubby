import { afterEach, describe, expect, it, vi } from "vitest";
import { observedEntityCall } from "./entity-transport";

vi.mock("~/lib/flags", () => ({ getFlag: () => true }));

afterEach(() => vi.restoreAllMocks());

describe("Start entity query logging", () => {
  it("logs semantic request and result events", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await observedEntityCall(
      "entity.list",
      { entity: "product", filters: {} },
      async () => ({ items: [], meta: { totalCount: 0 } }),
    );

    expect(result).toMatchObject({ items: [] });
    expect(log.mock.calls[0]?.[0]).toMatch(/>> \d+ entity\.list/u);
    expect(log.mock.calls[1]?.[0]).toMatch(/<< \d+ entity\.list/u);
  });

  it("always logs errors", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      observedEntityCall("entity.filterOptions", {}, async () => {
        throw new Error("broken");
      }),
    ).rejects.toThrow("broken");
    expect(error.mock.calls[0]?.[0]).toMatch(/entity\.filterOptions/u);
  });
});
