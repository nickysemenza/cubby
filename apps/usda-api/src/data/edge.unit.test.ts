import { describe, expect, it, vi } from "vitest";
import { createEdgeUsdaDataSource } from "./edge";
import type { EdgeBindings } from "./cloudflare-types";

function makeEnv(bindCounts: number[]): EdgeBindings {
  const db = {
    prepare(query: string) {
      let boundValues: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          boundValues = values;
          if (query.includes(" IN ")) {
            bindCounts.push(values.length);
          }
          return statement;
        },
        async first<T>() {
          if (query.includes("usda_edge_meta")) {
            return { value: "vtest" } as T;
          }
          return null;
        },
        async all<T>() {
          expect(boundValues.length).toBeLessThanOrEqual(100);
          return { success: true, results: [] as T[] };
        },
      };
      return statement;
    },
  };

  return {
    DB: db as unknown as EdgeBindings["DB"],
    USDA_BUNDLES: { get: vi.fn() } as unknown as EdgeBindings["USDA_BUNDLES"],
  };
}

describe("createEdgeUsdaDataSource", () => {
  it("chunks batch lookup D1 IN queries to the D1 bound parameter limit", async () => {
    const bindCounts: number[] = [];
    const dataSource = createEdgeUsdaDataSource(makeEnv(bindCounts));
    const lookups = Array.from({ length: 150 }, (_, index) => ({
      kind: "upc" as const,
      gtin_upc: String(index).padStart(12, "0"),
    }));

    await expect(
      dataSource.findFoodsByLookupBatch(lookups),
    ).resolves.toHaveLength(150);

    expect(bindCounts).toEqual([100, 50]);
  });
});
