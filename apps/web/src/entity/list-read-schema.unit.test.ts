import { describe, expect, it } from "vitest";
import { z } from "zod";

import { compileListReadSchema } from "~/entity/list-read-fields";

import { entityListEnrichmentOutputSchema } from "./generated/entity-lists.gen";

describe("list field ownership", () => {
  const schema = z.object({
    id: z.string(),
    name: z.string(),
    price: z.number().nullable(),
    image: z.string().nullable(),
  });
  it("preserves explicit null and zero without inventing pending values", () => {
    const read = compileListReadSchema(schema, {
      derived: ["price"],
      media: ["image"],
    });
    expect(
      read.project(
        { id: "example", name: "Example", price: 0, image: null },
        "core",
      ),
    ).toEqual({ id: "example", name: "Example" });
    expect(read.project({ id: "example", price: 0 }, "derived")).toEqual({
      id: "example",
      price: 0,
    });
    expect(read.project({ id: "example", image: null }, "media")).toEqual({
      id: "example",
      image: null,
    });
  });
  it("rejects unowned schema fields, overlapping owners, and dependency cycles", () => {
    expect(() =>
      compileListReadSchema(schema, { derived: ["missing"] }),
    ).toThrow("Unknown list field");
    expect(() =>
      compileListReadSchema(schema, { media: ["price"], derived: ["price"] }),
    ).toThrow("multiple owners");
    expect(() =>
      compileListReadSchema(
        schema,
        { media: ["image"], derived: ["price"] },
        { media: ["derived"], derived: ["media"] },
      ),
    ).toThrow("cycle");
  });
});

// Partial full-row schemas must not default core fields into unrelated patches.
it("enrichment wire parsing keeps group ownership and explicit nullable values", () => {
  const input = {
    entity: "financialTransaction",
    missingIds: [],
    groups: [
      { id: "media", state: "ready", data: [{ id: "FTX-4K7M" }] },
      {
        id: "relations",
        state: "ready",
        data: [{ id: "FTX-4K7M", ledgerTransferId: null }],
      },
      {
        id: "derived",
        state: "ready",
        data: [{ id: "FTX-4K7M", itemization: "bare" }],
      },
    ],
  };
  const parsed = entityListEnrichmentOutputSchema.parse(input);
  for (const group of parsed.groups) {
    if (group.state !== "ready") throw new Error("Expected ready enrichment");
    expect(group.data[0]).not.toHaveProperty("spendingCategoryId");
    expect(group.data[0]).not.toHaveProperty("evidenceExpectation");
  }
  expect(parsed.groups[1]).toMatchObject({
    id: "relations",
    state: "ready",
    data: [{ id: "FTX-4K7M", ledgerTransferId: null }],
  });
  expect(
    entityListEnrichmentOutputSchema.safeParse({
      ...input,
      groups: [
        {
          id: "relations",
          state: "ready",
          data: [{ id: "FTX-4K7M", ledgerTransferId: 7 }],
        },
      ],
    }).success,
  ).toBe(false);
});
