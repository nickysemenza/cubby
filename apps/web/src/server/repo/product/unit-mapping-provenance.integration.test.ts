import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { parseShortcode } from "@cubby/shared";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { productRouter } from "~/server/api/routers/product";
import { createTestCaller } from "~/server/api/trpc";
import { createProductFixture, makeProductInput } from "../repo.fixtures";

/**
 * A unit mapping's `sourceMetadata.productId` is the id the CLIENT looks the
 * product up by — `LazyProductPillLink` in `units/unitmappingstable.tsx` feeds
 * it straight into `product.getByID`, which is keyed on the shortcode. A uuid
 * there doesn't merely render oddly: every row on the page fires a request that
 * fails input validation, and the row degrades to a `product <uuid8>` stub.
 *
 * The uuid is real one layer down — `productUnitMappings.productId` is a FK and
 * `getProductUnitMappingsByProductIds` is keyed on uuids — so what's pinned here
 * is the translation, which only real SQL exercises: rows have to exist, be
 * joined, and come back through the mapper the router actually uses.
 */
describe("unit-mapping provenance is the public shortcode", () => {
  const ctx = withTestDb();

  const caller = () => createTestCaller(productRouter, ctx.db);

  const seed = () =>
    createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Provenance Probe",
        unitMappings: [
          {
            a: { value: 1, unit: "cup" },
            b: { value: 120, unit: "g" },
            source: null,
          },
          {
            a: { value: 8, unit: "oz" },
            b: { value: 10, unit: "dollar" },
            source: "manual",
          },
        ],
      }),
      ctx.actor,
    );

  const provenanceIds = (mappings: readonly UnitMapping[]) =>
    mappings.map((m) =>
      m.sourceMetadata.type === "product" ? m.sourceMetadata.productId : null,
    );

  it("stamps the shortcode on every stored mapping the detail read returns", async () => {
    const product = await seed();

    const ids = provenanceIds(
      (await caller().getByID({ id: product.id })).unitMappings,
    );

    expect(ids).toEqual([product.id, product.id]);
    // Not only "equals the fixture's id" — pin the shape too, so a future id
    // scheme that happened to match the fixture can't pass vacuously.
    for (const id of ids) {
      expect(parseShortcode(id ?? "")?.type).toBe("product");
    }
  });

  it("stamps the shortcode on the summaries read, which is keyed on uuids underneath", async () => {
    const product = await seed();

    const summaries = await caller().summaries({
      ids: [product.id],
      include: ["unitMappings"],
    });

    expect(provenanceIds(summaries.unitMappings?.[product.id] ?? [])).toEqual([
      product.id,
      product.id,
    ]);
  });
});
