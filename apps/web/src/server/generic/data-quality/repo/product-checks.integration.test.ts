import { entitySummary } from "@cubby/schemas/entity-summary";
import { productFiltersSchema } from "@cubby/schemas/product";
import { workQueueHouseholdInput } from "@cubby/schemas/work-queue";
import { eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { compileProblemFilters } from "~/entity/problems/problem-filter-semantics";
import { unwrapDb } from "~/server/db/helpers";
import { entityQuality, job } from "~/server/db/schema";
import {
  createExpense,
  updateExpense,
} from "~/server/domains/expense/repo/crud";
import {
  attachExistingImageToEntity,
  updateImageIntegrity,
} from "~/server/domains/image/repo/image";
import { productList, updateProduct } from "~/server/domains/product/repo/crud";
import {
  attachProductComponents,
  detachProductComponents,
} from "~/server/domains/product/repo/product-components";
import { advanceJob } from "~/server/generic/jobs/service/jobs";
import {
  readRecordWorkQueue,
  readWorkQueue,
} from "~/server/generic/work-queue/service/work-queue-read";
import {
  createImageFixture,
  createInventoryFixture,
  createLocationFixture,
  createProductIdentityFixture,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { refreshFamilyHandler } from "~/server/workflows/background-tasks/refresh-families";

import { productChecks, PRODUCT_QUALITY_RULES_VERSION } from "./checks/product";
import { clearDataException, setDataException } from "./exceptions";
import { loadDataQualities, loadQualityBreakdown } from "./hydrate";

// Failure modes: reads repair missing/stale publications; related writes miss
// quality enrollment; queue research reconstructs kit prices before paging.
describe("stored Product quality", () => {
  const ctx = withTestDb();
  const refresh = async () => {
    for (let page = 0; page < 8; page++) {
      const [intent] = await unwrapDb(ctx.db)
        .select()
        .from(job)
        .where(eq(job.key, "refresh:quality"));
      if (!intent) throw new Error("Expected quality intent from source write");
      expect(
        await advanceJob(ctx.db, intent.id, {
          "refresh.family": refreshFamilyHandler,
        }),
      ).toBe("succeeded");
      const [current] = await unwrapDb(ctx.db)
        .select()
        .from(job)
        .where(eq(job.id, intent.id));
      if (current?.state === "completed") return;
    }
    throw new Error("Synthetic Product quality pass exceeded page budget");
  };
  const generation = async () => {
    const [intent] = await unwrapDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.key, "refresh:quality"));
    if (!intent) throw new Error("Missing quality Job");
    return intent.generation;
  };
  const seed = async () => {
    const item = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic quality component",
        commodity: true,
      }),
      ctx.actor,
    );
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic quality shelf" }),
      ctx.actor,
    );
    await createInventoryFixture(
      ctx.db,
      {
        productId: item.id,
        locationId: shelf.id,
        amount: { value: 1, unit: "each" },
        placement: "stock",
      },
      ctx.actor,
    );
    const kit = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic quality kit" }),
      ctx.actor,
    );
    await attachProductComponents(
      ctx.db,
      kit.entityId,
      [{ productId: item.entityId, quantity: 2 }],
      ctx.actor,
    );
    return { item, kit };
  };

  it("uses two bounded reads for a batch and never repairs publications on a read", async () => {
    const { item, kit } = await seed();
    const measured = await countTestDbQueries(() =>
      productChecks.evaluate(ctx.db, [item.entityId, kit.entityId]),
    );
    expect(measured.queryCount).toBe(2);
    expect(measured.result).toHaveLength(2);
    expect(
      (await countTestDbQueries(() => productChecks.evaluate(ctx.db, [])))
        .queryCount,
    ).toBe(0);
    expect(
      (await loadDataQualities(ctx.db, "product", [item.entityId])).get(
        item.entityId,
      )?.status,
    ).toBe("not_assessed");
    expect(
      (await loadQualityBreakdown(ctx.db, "product", item.id)).checks
        .filter((check) => check.state === "gap")
        .map((check) => check.check),
    ).toContain("product_price");
    await readRecordWorkQueue(ctx.db, null, item.id, false);
    expect(await unwrapDb(ctx.db).select().from(entityQuality)).toEqual([]);
    await refresh();
    const [published] = await unwrapDb(ctx.db)
      .select()
      .from(entityQuality)
      .where(eq(entityQuality.entityId, item.entityId));
    expect(published?.rulesVersion).toBe(PRODUCT_QUALITY_RULES_VERSION);
    const priceGap = async () =>
      (await loadDataQualities(ctx.db, "product", [item.entityId]))
        .get(item.entityId)
        ?.gaps.some((gap) => gap.check === "product_price");
    expect(await priceGap()).toBe(true);
    await updateProduct(ctx.db, item.entityId, { price: 0 }, ctx.actor);
    expect(await priceGap()).toBe(true);
    expect(
      (await loadQualityBreakdown(ctx.db, "product", item.id)).checks
        .filter((check) => check.state === "gap")
        .map((check) => check.check),
    ).not.toContain("product_price");
    await refresh();
    expect(await priceGap()).toBe(false);
  });

  it("enrolls Expense, kit, attachment and image-integrity inputs and converges through the family", async () => {
    const { item, kit } = await seed();
    const gaps = async () =>
      (await loadDataQualities(ctx.db, "product", [item.entityId]))
        .get(item.entityId)!
        .gaps.map((gap) => gap.check);
    const assertEnrolled = async <T>(write: () => Promise<T>) => {
      const before = await generation();
      await write();
      expect(await generation()).toBeGreaterThan(before);
      await refresh();
    };
    await refresh();
    const line = await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Synthetic kit acquisition",
        productId: kit.id,
        cost: 12,
        productQuantity: 1,
      }),
      ctx.actor,
    );
    await refresh();
    expect(await gaps()).not.toContain("product_price");
    await assertEnrolled(() =>
      updateExpense(ctx.db, line.output.id, { cost: 0 }, ctx.actor),
    );
    expect(await gaps()).toContain("product_price");
    await assertEnrolled(() =>
      updateExpense(ctx.db, line.output.id, { cost: 12 }, ctx.actor),
    );
    expect(await gaps()).not.toContain("product_price");
    await assertEnrolled(() =>
      detachProductComponents(ctx.db, kit.entityId, [item.entityId], ctx.actor),
    );
    expect(await gaps()).toContain("product_price");
    await assertEnrolled(() =>
      attachProductComponents(
        ctx.db,
        kit.entityId,
        [{ productId: item.entityId, quantity: 2 }],
        ctx.actor,
      ),
    );
    expect(await gaps()).not.toContain("product_price");
    const photo = await createImageFixture(
      ctx.db,
      "synthetic-stored-quality-cover",
    );
    expect(await gaps()).toContain("product_image");
    await assertEnrolled(() =>
      attachExistingImageToEntity(
        ctx.db,
        { targetId: item.id, imageId: photo.shortcode },
        ctx.actor,
      ),
    );
    expect(await gaps()).not.toContain("product_image");
    await assertEnrolled(() =>
      updateImageIntegrity(ctx.db, photo.id, {
        width: 10,
        height: 10,
        detectedContentType: "image/png",
        sha256: null,
        renderStatus: "failed",
        storageStatus: "available",
        verifiedAt: new Date(),
      }),
    );
    expect(await gaps()).toContain("product_image");
    expect(await gaps()).toContain("product_display_image");
  });

  it("keeps durable waivers across input changes, Research saved views, and queue reads without price work", async () => {
    const { item, kit } = await seed();
    const queue = () =>
      readWorkQueue(
        ctx.db,
        null,
        workQueueHouseholdInput.parse({ entity: "product", pageSize: 100 }),
        false,
      );
    const view = entitySummary.product.list.savedViews.find(
      (view) => view.id === "research-queue",
    )!;
    const filters = productFiltersSchema.parse(
      compileProblemFilters("product", view.filters),
    );
    const saved = () =>
      productList(ctx.db, filters, [], { pageIndex: 0, pageSize: 100 });
    await refresh();
    expect((await saved()).data.map((row) => row.id)).toContain(item.id);
    const research = () =>
      readWorkQueue(
        ctx.db,
        null,
        workQueueHouseholdInput.parse({
          entity: "product",
          source: "research",
          pageSize: 100,
        }),
        false,
      );
    const record = () => readRecordWorkQueue(ctx.db, null, item.id, false);
    const compiled = vi.spyOn(PgDialect.prototype, "sqlToQuery");
    try {
      const measured = await countTestDbQueries(research);
      // Counter excerpts are shortened; inspect complete SQL so later price work
      // cannot evade the Product research query budget.
      const statements = compiled.mock.results.flatMap((result) =>
        result.type === "return" ? [result.value.sql] : [],
      );
      expect(statements.length).toBeGreaterThan(0);
      expect(statements.join("\n")).not.toMatch(
        /work_product_price|\bkpe\.|"knownCost"|"knownUnitCount"/,
      );
      expect(measured.tables).toContain("EntityQualityCheck");
      expect(
        measured.result.items.some(
          (row) => row.source === "research" && row.id === item.id,
        ),
      ).toBe(true);
      compiled.mockClear();
      await record();
      const population = compiled.mock.results.flatMap((result) =>
        result.type === "return" &&
        result.value.sql.includes("work_connection_prediction")
          ? [result.value.sql]
          : [],
      );
      expect(population).toHaveLength(1);
      // Optional misc-bucket valuation diagnostics keep their live price filter;
      // the shared population no longer registers the quality price relation.
      expect(population[0]).not.toContain("work_product_price");
    } finally {
      compiled.mockRestore();
    }
    await setDataException(
      ctx.db,
      {
        entityId: item.id,
        check: "product_price",
        reason: "unavailable",
        note: "Synthetic unknown historical value",
      },
      ctx.actor,
    );
    await refresh();
    expect(
      (await queue()).items.some(
        (row) => row.key === `productsMissingPrice:${item.id}`,
      ),
    ).toBe(false);
    await detachProductComponents(
      ctx.db,
      kit.entityId,
      [item.entityId],
      ctx.actor,
    );
    await refresh();
    const quality = (
      await loadDataQualities(ctx.db, "product", [item.entityId])
    ).get(item.entityId)!;
    expect(quality.exceptions).toContainEqual(
      expect.objectContaining({ check: "product_price", state: "active" }),
    );
    expect(quality.gaps.map((gap) => gap.check)).not.toContain("product_price");
    await clearDataException(
      ctx.db,
      { entityId: item.id, check: "product_price" },
      ctx.actor,
    );
    await refresh();
    expect(
      (await queue()).items.some(
        (row) => row.key === `productsMissingPrice:${item.id}`,
      ),
    ).toBe(true);
  });
});
