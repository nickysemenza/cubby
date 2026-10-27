import { productListItemOut } from "@cubby/schemas/product";
import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import { fieldValueFixture } from "~/entity/fields/field-envelope.fixtures";

import { entities } from "./entities";
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

it("accepts compact Product suggestion identities and canonical barcode envelopes without relaxing ownership", () => {
  const config = entities.product.mergeable;
  const identity = {
    id: testShortcode("product", "PRD-4K7M"),
    name: "Synthetic kettle",
  };
  expect(config.rowLabel(identity)).toMatchObject({
    props: { children: identity.name },
  });
  expect(() => config.rowStat?.(identity)).not.toThrow();
  const canonical = {
    ...identity,
    fields: {
      primaryGtin: fieldValueFixture(
        productListItemOut.shape.fields.shape.primaryGtin,
        "00012345678905",
      ),
    },
  };
  expect(() => config.rowStat?.(canonical)).not.toThrow();
  const vendor = {
    id: testShortcode("vendor", "VND-4K7M"),
    name: "Synthetic vendor",
  };
  expect(() => config.rowLabel(vendor)).toThrow("another entity");
  const malformed = { ...identity, fields: { primaryGtin: "00012345678905" } };
  expect(() => config.rowStat?.(malformed)).toThrow("another entity");
});
