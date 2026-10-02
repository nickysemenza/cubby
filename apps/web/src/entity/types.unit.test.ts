import { describe, expect, it } from "vitest";

import { defineMergeableConfig, type MergeDisplayRow } from "./types";

interface ProductMergeRow extends MergeDisplayRow {
  gtins: string[];
  name: string;
  sources: string[];
}

const isString = (value: unknown): value is string => typeof value === "string";

const isProductMergeRow = (row: MergeDisplayRow): row is ProductMergeRow =>
  "name" in row &&
  typeof row.name === "string" &&
  "gtins" in row &&
  Array.isArray(row.gtins) &&
  row.gtins.every(isString) &&
  "sources" in row &&
  Array.isArray(row.sources) &&
  row.sources.every(isString);

describe("defineMergeableConfig", () => {
  it("refuses a different entity row before its owner callbacks run", () => {
    const config = defineMergeableConfig<ProductMergeRow>({
      keeperMode: "ranked",
      isRow: isProductMergeRow,
      rowLabel: (row) => row.name,
      rowStat: (row) => row.gtins.join(", "),
      copy: { title: "Merge products?" },
    });

    const product: ProductMergeRow = {
      id: "product-1",
      gtins: [],
      name: "Kettle",
      sources: [],
    };
    expect(() => config.rowLabel({ id: "vendor-1" })).toThrow("another entity");
    expect(config.rowLabel(product)).toBe("Kettle");
  });
});
