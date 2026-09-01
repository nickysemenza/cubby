import { parseEntityId } from "@cubby/schemas/identifiers";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { parseShortcode } from "@cubby/shared";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { requireActor } from "~/server/request-context";
import { getProductWithFood } from "~/server/services/product.service";
import { createTestRequestContext } from "~/server/testing/request-context";
import { getProductSummariesWorkflow } from "~/server/workflows/product.server";

import { createProductFixture, makeProductInput } from "../repo.fixtures";

/**
 * A unit mapping's `sourceMetadata.productId` is the id the CLIENT looks the
 * product up by — `LazyProductPillLink` in `units/unitmappingstable.tsx` feeds
 * it straight into the Product detail query, which is keyed on the shortcode. A uuid
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

  const workflowContext = () =>
    requireActor(
      createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
    );

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

  it("stamps the shortcode on detail and summary mapping reads", async () => {
    const product = await seed();
    const uuid = await resolveLiveShortcode(ctx.db, product.id, "product");
    expect(uuid).not.toBeNull();
    const detail = await getProductWithFood(
      ctx.db,
      createTestRequestContext(ctx.db).usdaClient,
      parseEntityId("product", uuid!),
    );
    const ids = provenanceIds(detail.unitMappings);

    expect(ids).toEqual([product.id, product.id]);
    // Not only "equals the fixture's id" — pin the shape too, so a future id
    // scheme that happened to match the fixture can't pass vacuously.
    for (const id of ids) {
      expect(parseShortcode(id ?? "")?.type).toBe("product");
    }

    const summaries = await getProductSummariesWorkflow(workflowContext(), {
      ids: [product.id],
      include: ["unitMappings"],
    });

    expect(provenanceIds(summaries.unitMappings?.[product.id] ?? [])).toEqual([
      product.id,
      product.id,
    ]);
  });
});
