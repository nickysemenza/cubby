import { productFieldEnvelopeSchemas } from "./generated/entity-field-envelopes.product.gen";
import { describe, expect, it } from "vitest";
import {
  productFindOrCreateByCodeInput,
  productQuantitySummaryBatchInput,
} from "./product";
import { scanAtLocationCode } from "./scan";

describe("canonical Product MCP fields", () => {
  it("exposes one typed price result with distinct current intent", () => {
    const schema = productFieldEnvelopeSchemas.mcpOutput;
    expect(Object.keys(schema.shape)).not.toContain("price");
    expect(Object.keys(schema.shape)).not.toContain("fieldResolutions");
    expect(Object.keys(schema.shape)).not.toContain("derived");
    expect(Object.keys(schema.shape.pricing.shape).sort()).toEqual([
      "knownExpenseCount",
      "knownUnitCount",
      "partial",
      "unknownExpenseCount",
    ]);
    const price = {
      current: {
        assignment: { kind: "value", value: 13, ownership: { kind: "record" } },
        controls: {
          kind: "editable",
          canSetNone: false,
          canConfirm: false,
          reset: { kind: "unavailable" },
        },
      },
      result: {
        kind: "live",
        decision: {
          outcome: { kind: "value", value: 13 },
          provenance: { kind: "own", ownership: { kind: "record" } },
        },
      },
      work: { kind: "idle" },
    };
    expect(schema.shape.fields.shape.price.safeParse(price).success).toBe(true);
    expect(
      schema.shape.fields.shape.price.safeParse({
        ...price,
        result: {
          kind: "live",
          decision: {
            outcome: { kind: "value", value: "invalid price" },
            provenance: null,
          },
        },
      }).success,
    ).toBe(false);
  });
});

describe("productQuantitySummaryBatchInput", () => {
  it("accepts a whole-house recount batch larger than the old page-sized cap", () => {
    expect(
      productQuantitySummaryBatchInput.safeParse({
        ids: Array.from({ length: 501 }, () => "PRD-ABCD"),
      }).success,
    ).toBe(true);
  });
});

describe("productFindOrCreateByCodeInput", () => {
  it.each([
    [{ kind: "barcode", value: "012345678905" }, "012345678905"],
    // Only trims: check-digit validation + GTIN-14 normalization happen in
    // `product.findOrCreateByCode`'s "isbn" arm (schemas cannot depend on
    // the WASM boundary that validation needs).
    [{ kind: "isbn", value: "  978-0-306-40615-7  " }, "978-0-306-40615-7"],
    // The raw arm only trims: the server classifies it into one of the others.
    [{ kind: "scan", value: "  P-4K7M " }, "P-4K7M"],
  ])("accepts the %o arm", (input, value) => {
    expect(productFindOrCreateByCodeInput.parse(input)).toEqual({
      kind: input.kind,
      value,
    });
  });

  it("rejects an empty scan", () => {
    expect(
      productFindOrCreateByCodeInput.safeParse({ kind: "scan", value: "  " })
        .success,
    ).toBe(false);
  });

  it("reaches the sweep input as the same arm", () => {
    expect(
      scanAtLocationCode.parse({ kind: "scan", value: "PRD-4K7M" }),
    ).toEqual({ kind: "scan", value: "PRD-4K7M" });
    expect(
      scanAtLocationCode.parse({ kind: "product", value: "PRD-4K7M" }),
    ).toEqual({ kind: "product", value: "PRD-4K7M" });
  });
});
