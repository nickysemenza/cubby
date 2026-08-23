import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";
import type { USDAClient } from "~/server/clients/usda";
import { productConversionCoverage } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  findCoverageProblems,
  rebuildProductConversionCoverageProjection,
} from "~/server/services/problems.service";
import { updateIngredient } from "../ingredient";
import {
  attachProductComponents,
  detachProductComponents,
} from "../product-components";
import {
  createIngredientFixture as createIngredient,
  createProductFixture as createProduct,
  makeProductInput,
} from "../repo.fixtures";
import {
  getProductConversionCoverageFreshness,
  writeProductConversionCoverageProjection,
} from "./conversion-coverage";
import { productList, updateProduct } from "./crud";
import { mergeProducts } from "./merge";

describe("ProductConversionCoverage projection", () => {
  const ctx = withTestDb();
  const list = (filters: Record<string, unknown>) =>
    productList(ctx.db, filters, [{ orderBy: "name", direction: "asc" }], {
      pageIndex: 0,
      pageSize: 50,
    });

  it("reads a healthy coverage lane without invoking the USDA rebuild path", async () => {
    const client = {
      findFoodsBatch: async () => {
        throw new Error("healthy projection should not rebuild");
      },
    } as unknown as USDAClient;

    const result = await findCoverageProblems(ctx.db, client);
    expect(result.freshness).toMatchObject({
      state: "fresh",
      readyCount: 0,
      staleCount: 0,
      missingCount: 0,
    });
    expect(result.ingredientsWithPartialCoverage).toEqual([]);
    expect(result.productsWithIslandedMappings).toEqual([]);
  });

  it("serves the persisted stale projection when USDA rebuild fails", async () => {
    const ingredient = await createIngredient(
      ctx.db,
      { name: "Projection Rebuild Ingredient", aliases: [] },
      ctx.actor,
    );
    const product = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Projection Rebuild Outage",
        fdc_id: 999_991,
        ingredientId: ingredient.id,
      }),
      ctx.actor,
    );
    await writeProductConversionCoverageProjection(ctx.db, [
      {
        productId: product.entityId,
        coverageTier: "partial",
        coveredKinds: ["weight"],
        applicableKinds: ["weight", "volume"],
        islandCount: 1,
        status: "ready",
      },
    ]);
    await updateProduct(ctx.db, product.entityId, { price: 4 }, ctx.actor);

    const client = {
      findFoodsBatch: async () => {
        throw new Error("USDA temporarily unavailable");
      },
    } as unknown as USDAClient;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await findCoverageProblems(ctx.db, client);

    expect(result.freshness.state).toBe("stale");
    expect(result.freshness.staleCount).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("conversion projection rebuild failed"),
    );
    expect(
      await getDb(ctx.db).query.productConversionCoverage.findFirst({
        where: eq(productConversionCoverage.productId, product.entityId),
      }),
    ).toMatchObject({ status: "stale", coverageTier: "partial" });
  });

  it("drives exact product filters and fails closed for stale or old-engine rows", async () => {
    const partial = await createProduct(
      ctx.db,
      makeProductInput({ name: "Projection Partial" }),
      ctx.actor,
    );
    const islanded = await createProduct(
      ctx.db,
      makeProductInput({ name: "Projection Islanded" }),
      ctx.actor,
    );
    const oldEngine = await createProduct(
      ctx.db,
      makeProductInput({ name: "Projection Old Engine" }),
      ctx.actor,
    );
    const expired = await createProduct(
      ctx.db,
      makeProductInput({ name: "Projection Expired USDA Input" }),
      ctx.actor,
    );

    await writeProductConversionCoverageProjection(ctx.db, [
      {
        productId: partial.entityId,
        coverageTier: "partial",
        coveredKinds: ["weight"],
        applicableKinds: ["weight", "volume"],
        islandCount: 1,
        status: "ready",
      },
      {
        productId: islanded.entityId,
        coverageTier: "complete",
        coveredKinds: ["weight", "volume"],
        applicableKinds: ["weight", "volume"],
        islandCount: 2,
        status: "ready",
      },
      {
        productId: expired.entityId,
        coverageTier: "partial",
        coveredKinds: ["weight"],
        applicableKinds: ["weight", "volume"],
        islandCount: 1,
        status: "ready",
      },
    ]);
    await getDb(ctx.db).insert(productConversionCoverage).values({
      productId: oldEngine.entityId,
      coverageTier: "partial",
      coveredKinds: [],
      applicableKinds: [],
      islandCount: 0,
      status: "ready",
      engineVersion: "obsolete-engine",
      computedAt: new Date(),
    });
    await getDb(ctx.db)
      .update(productConversionCoverage)
      .set({ computedAt: new Date("2020-01-01T00:00:00.000Z") })
      .where(eq(productConversionCoverage.productId, expired.entityId));

    expect(
      (await list({ conversionCoverage: "partial" })).data.map((p) => p.id),
    ).toContain(partial.id);
    expect(
      (await list({ conversionCoverage: "partial" })).data.map((p) => p.id),
    ).not.toContain(oldEngine.id);
    expect(
      (await list({ conversionCoverage: "partial" })).data.map((p) => p.id),
    ).not.toContain(expired.id);
    expect(
      (await list({ conversionTopology: "islanded" })).data.map((p) => p.id),
    ).toContain(islanded.id);

    await updateProduct(ctx.db, partial.entityId, { price: 3 }, ctx.actor);
    const stale = await getDb(ctx.db).query.productConversionCoverage.findFirst(
      {
        where: eq(productConversionCoverage.productId, partial.entityId),
      },
    );
    expect(stale?.status).toBe("stale");
    expect(
      (await list({ conversionCoverage: "partial" })).data.map((p) => p.id),
    ).not.toContain(partial.id);
    const freshness = await getProductConversionCoverageFreshness(ctx.db);
    expect(freshness).toMatchObject({
      state: "stale",
      readyCount: 1,
      staleCount: 3,
      unavailableCount: 0,
      missingCount: 0,
      expectedEngineVersion: "conversion-coverage-v1",
    });
    expect(freshness.computedAt).toBeInstanceOf(Date);
  });

  it("invalidates the parent projection when kit components attach or detach", async () => {
    const kit = await createProduct(
      ctx.db,
      makeProductInput({ name: "Projection Kit" }),
      ctx.actor,
    );
    const part = await createProduct(
      ctx.db,
      makeProductInput({ name: "Projection Part" }),
      ctx.actor,
    );
    const ready = () =>
      writeProductConversionCoverageProjection(ctx.db, [
        {
          productId: kit.entityId,
          coverageTier: "complete",
          coveredKinds: [],
          applicableKinds: [],
          islandCount: 1,
          status: "ready",
        },
      ]);

    await ready();
    await attachProductComponents(
      ctx.db,
      kit.entityId,
      [{ productId: part.entityId, quantity: 1 }],
      ctx.actor,
    );
    expect(
      (
        await getDb(ctx.db).query.productConversionCoverage.findFirst({
          where: eq(productConversionCoverage.productId, kit.entityId),
        })
      )?.status,
    ).toBe("stale");

    await ready();
    await detachProductComponents(
      ctx.db,
      kit.entityId,
      [part.entityId],
      ctx.actor,
    );
    expect(
      (
        await getDb(ctx.db).query.productConversionCoverage.findFirst({
          where: eq(productConversionCoverage.productId, kit.entityId),
        })
      )?.status,
    ).toBe("stale");
  });

  it("invalidates linked products and containing kits when ingredient NA kinds change", async () => {
    const ingredient = await createIngredient(
      ctx.db,
      { name: "Projection NA Ingredient", aliases: [] },
      ctx.actor,
    );
    const component = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Projection NA Component",
        ingredientId: ingredient.id,
      }),
      ctx.actor,
    );
    const kit = await createProduct(
      ctx.db,
      makeProductInput({ name: "Projection NA Kit" }),
      ctx.actor,
    );
    await attachProductComponents(
      ctx.db,
      kit.entityId,
      [{ productId: component.entityId, quantity: 1 }],
      ctx.actor,
    );
    await writeProductConversionCoverageProjection(ctx.db, [
      {
        productId: component.entityId,
        coverageTier: "complete",
        coveredKinds: [],
        applicableKinds: [],
        islandCount: 1,
        status: "ready",
      },
      {
        productId: kit.entityId,
        coverageTier: "complete",
        coveredKinds: [],
        applicableKinds: [],
        islandCount: 1,
        status: "ready",
      },
    ]);

    await updateIngredient(
      ctx.db,
      ingredient.entityId,
      { naKinds: ["volume"] },
      ctx.actor,
    );

    const rows = await getDb(ctx.db).query.productConversionCoverage.findMany();
    expect(
      rows
        .filter((row) =>
          [component.entityId, kit.entityId].includes(row.productId),
        )
        .map((row) => row.status),
    ).toEqual(["stale", "stale"]);
  });

  it("invalidates the survivor projection after a merge", async () => {
    const keep = await createProduct(
      ctx.db,
      makeProductInput({ name: "Projection Merge Keep" }),
      ctx.actor,
    );
    const loser = await createProduct(
      ctx.db,
      makeProductInput({ name: "Projection Merge Loser" }),
      ctx.actor,
    );
    await writeProductConversionCoverageProjection(ctx.db, [
      {
        productId: keep.entityId,
        coverageTier: "complete",
        coveredKinds: [],
        applicableKinds: [],
        islandCount: 1,
        status: "ready",
      },
    ]);

    await mergeProducts(
      ctx.db,
      { keepId: keep.id, mergeIds: [loser.id] },
      ctx.actor,
    );
    expect(
      (
        await getDb(ctx.db).query.productConversionCoverage.findFirst({
          where: eq(productConversionCoverage.productId, keep.entityId),
        })
      )?.status,
    ).toBe("stale");
  });

  it("invalidates every containing kit when a component input changes", async () => {
    const top = await createProduct(
      ctx.db,
      makeProductInput({ name: "Projection Top Kit" }),
      ctx.actor,
    );
    const middle = await createProduct(
      ctx.db,
      makeProductInput({ name: "Projection Middle Kit" }),
      ctx.actor,
    );
    const part = await createProduct(
      ctx.db,
      makeProductInput({ name: "Projection Nested Part" }),
      ctx.actor,
    );
    await attachProductComponents(
      ctx.db,
      middle.entityId,
      [{ productId: part.entityId, quantity: 1 }],
      ctx.actor,
    );
    await attachProductComponents(
      ctx.db,
      top.entityId,
      [{ productId: middle.entityId, quantity: 1 }],
      ctx.actor,
    );
    await writeProductConversionCoverageProjection(ctx.db, [
      ...[top, middle, part].map((row) => ({
        productId: row.entityId,
        coverageTier: "complete",
        coveredKinds: [],
        applicableKinds: [],
        islandCount: 1,
        status: "ready" as const,
      })),
    ]);

    await updateProduct(ctx.db, part.entityId, { price: 7 }, ctx.actor);
    const statuses = await getDb(ctx.db)
      .select({
        id: productConversionCoverage.productId,
        status: productConversionCoverage.status,
      })
      .from(productConversionCoverage);
    const affected = statuses.filter((row) =>
      [top.entityId, middle.entityId, part.entityId].includes(row.id),
    );
    expect(affected).toHaveLength(3);
    expect(affected.every((row) => row.status === "stale")).toBe(true);
  });

  it("rebuilds rows through the shared coverage detector before persisting", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Projection Rebuild" }),
      ctx.actor,
    );
    const rows = await rebuildProductConversionCoverageProjection(ctx.db, {
      findFoodsBatch: async (lookups: unknown[]) => lookups.map(() => null),
    } as unknown as USDAClient);

    expect(rows.some((row) => row.productId === product.entityId)).toBe(true);
    expect(
      await getDb(ctx.db).query.productConversionCoverage.findFirst({
        where: eq(productConversionCoverage.productId, product.entityId),
      }),
    ).toMatchObject({
      status: "ready",
      engineVersion: "conversion-coverage-v1",
    });
  });
});
