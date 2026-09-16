import { describe, expect, it } from "vitest";

import {
  foldPositionalDuplicates,
  integerLiterals,
  openTupleItems,
  type JsonSchema,
} from "../../../scripts/generator/http-api/document-passes";

/**
 * Regression coverage for PR #1024's fold bug: `JSON.stringify(value, keys)`
 * with an array second argument is a property ALLOWLIST applied at every
 * nesting depth, not just the top level, so two structurally different
 * schemas (different nested property types, different anyOf members,
 * different $ref targets) both erased down to `{}` and were folded together.
 * `InventoryListItemOut.valuation` (really nullable number) and
 * `ProductListItemOut.stockTracked` (really nullable boolean) both ended up
 * folded onto a nullable `{type:"string",format:"uri"}` positional in the
 * committed document because of this.
 */

describe("foldPositionalDuplicates", () => {
  it("keeps distinct anyOf members apart even though the replacer-array bug erased them", () => {
    const components = {
      output_schema1: {
        anyOf: [{ type: "number" }, { type: "null" }],
      },
      output_schema2: {
        anyOf: [{ type: "string", format: "uri" }, { type: "null" }],
      },
    } satisfies Record<string, JsonSchema>;
    const result = foldPositionalDuplicates(components);
    expect(Object.keys(result).sort()).toEqual([
      "output_schema1",
      "output_schema2",
    ]);
    expect(result.output_schema1).toEqual(components.output_schema1);
    expect(result.output_schema2).toEqual(components.output_schema2);
  });

  it("keeps object schemas with the same property names but different $ref targets apart", () => {
    const components = {
      A: { type: "object", properties: {} },
      B: { type: "object", properties: {} },
      output_schema1: {
        type: "object",
        properties: { id: { $ref: "#/components/schemas/A" } },
      },
      output_schema2: {
        type: "object",
        properties: { id: { $ref: "#/components/schemas/B" } },
      },
    } satisfies Record<string, JsonSchema>;
    const result = foldPositionalDuplicates(components);
    expect(Object.keys(result).sort()).toEqual([
      "A",
      "B",
      "output_schema1",
      "output_schema2",
    ]);
    expect(result.output_schema1).toEqual(components.output_schema1);
    expect(result.output_schema2).toEqual(components.output_schema2);
  });

  it("still folds two positionals that are identical except for description, rewriting $ref to the survivor", () => {
    const components = {
      output_schema1: { type: "string", description: "first use" },
      output_schema2: { type: "string", description: "second use" },
      Consumer: {
        type: "object",
        properties: { field: { $ref: "#/components/schemas/output_schema2" } },
      },
    } satisfies Record<string, JsonSchema>;
    const result = foldPositionalDuplicates(components);
    expect(Object.keys(result).sort()).toEqual(["Consumer", "output_schema1"]);
    expect(result.Consumer).toEqual({
      type: "object",
      properties: { field: { $ref: "#/components/schemas/output_schema1" } },
    });
  });
});

describe("integerLiterals", () => {
  it("types whole-number literals and enums as integers, leaving fractions alone", () => {
    const components = {
      Doc: {
        type: "object",
        properties: {
          schemaVersion: { type: "number", const: 1 },
          revision: { type: "number", enum: [1, 2] },
          ratio: { type: "number", const: 0.5 },
          count: { type: "number" },
        },
      },
    } satisfies Record<string, JsonSchema>;
    expect(integerLiterals(components).Doc?.properties).toEqual({
      schemaVersion: { type: "integer", const: 1 },
      revision: { type: "integer", enum: [1, 2] },
      ratio: { type: "number", const: 0.5 },
      count: { type: "number" },
    });
  });
});

describe("openTupleItems", () => {
  it("drops the `items: false` a closed tuple carries, which OpenAPIKit rejects", () => {
    const components = {
      Doc: {
        type: "object",
        properties: {
          headers: {
            type: "array",
            items: {
              type: "array",
              prefixItems: [{ type: "string" }, { type: "string" }],
              items: false,
              minItems: 2,
            },
          },
          open: { type: "array", items: { type: "string" } },
        },
      },
    } satisfies Record<string, JsonSchema>;
    expect(openTupleItems(components).Doc?.properties).toEqual({
      headers: {
        type: "array",
        items: {
          type: "array",
          prefixItems: [{ type: "string" }, { type: "string" }],
          minItems: 2,
        },
      },
      open: { type: "array", items: { type: "string" } },
    });
  });
});
