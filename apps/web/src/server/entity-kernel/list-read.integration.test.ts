import { type LedgerPartyShortcode } from "@cubby/schemas/identifiers";
import { sql } from "drizzle-orm";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { entitySummaryFields } from "~/contracts/mcp-projections";
import { getEntityFilters } from "~/entity/filter-manifest";
import { buildFiltersFromManifest } from "~/entity/filters";
import { listEntities } from "~/entity/generated/entity-lists.gen";
import { listReadRowSchema } from "~/entity/model/list-read-fields";
import { selectListReadRows } from "~/entity/model/list-read-schema";
import { viewsForEntity } from "~/entity/model/view-manifest";
import { getDb } from "~/server/db/helpers";
import { createInventoryEntry } from "~/server/domains/inventory/repo/crud";
import { setInventoryOwnership } from "~/server/domains/inventory/repo/ownership-mutations";
import { createLedgerParty } from "~/server/domains/ledger-party/repo/ledger-party";
import { executeEntity } from "~/server/entity-kernel";
import { ENTITY_LIST_READ_OPERATIONS } from "~/server/generated/entity-list-read-bindings.gen";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import {
  createLocationFixture,
  createProductIdentityFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import {
  buildKernelContext,
  seedReferenceUniverse,
} from "./reference-universe.fixtures";

describe("complete list composition", () => {
  const ctx = withTestDb();
  it("counts every declared saved view as its applied list reads it", async () => {
    await seedReferenceUniverse(ctx.db);
    const context = buildKernelContext(ctx.db);
    for (const entity of listEntities) {
      if (entity !== "task" && entity !== "product") continue;
      const operation = ENTITY_LIST_READ_OPERATIONS[entity];
      const specs = getEntityFilters(entity);
      const views = viewsForEntity(entity).map((view) => {
        const values = new Map(
          view.filters.map(({ id, value }) => [id, value]),
        );
        return {
          id: view.id,
          filters: buildFiltersFromManifest(specs, (id) => values.get(id)),
        };
      });
      expect(views.length).toBeGreaterThan(1);
      const counts = await operation.viewCounts(context, { views });
      const unfiltered = await executeEntity(context, {
        action: "list",
        entity,
        filters: {},
        pagination: { pageIndex: 0, pageSize: 1 },
      });
      expect(counts.total).toBe(unfiltered.meta.totalCount);
      for (const view of views) {
        const base = await executeEntity(context, {
          action: "list",
          entity,
          filters: view.filters,
          pagination: { pageIndex: 0, pageSize: 1 },
        });
        expect(counts.views.find((count) => count.id === view.id)?.count).toBe(
          base.meta.totalCount,
        );
      }
    }
    const productOperation = ENTITY_LIST_READ_OPERATIONS.product;
    const expected = await executeEntity(context, {
      action: "list",
      entity: "product",
      filters: {},
    });
    // A count must not select row columns and discard them afterward.
    await getDb(ctx.db).execute(
      sql`ALTER TABLE "Product" RENAME COLUMN name TO "UnavailableName"`,
    );
    try {
      const countOnly = await productOperation.viewCounts(context, {
        views: [],
      });
      expect(countOnly.total).toBe(expected.meta.totalCount);
    } finally {
      await getDb(ctx.db).execute(
        sql`ALTER TABLE "Product" RENAME COLUMN "UnavailableName" TO name`,
      );
    }
  }, 60_000);
  it("counts distinct ownership views independently and reloads after a write", async () => {
    const first = await createLedgerParty(
      ctx.db,
      { name: "Synthetic first owner", kind: "member", notes: null },
      TEST_ACTOR,
    );
    const second = await createLedgerParty(
      ctx.db,
      { name: "Synthetic second owner", kind: "guest", notes: null },
      TEST_ACTOR,
    );
    const location = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic owner count shelf" }),
      TEST_ACTOR,
    );
    const stocked = async (
      name: string,
      owner: LedgerPartyShortcode | null | undefined,
      price: number | null = null,
    ) => {
      const product = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name, price }),
        TEST_ACTOR,
      );
      const entry = await createInventoryEntry(
        ctx.db,
        {
          productId: product.entityId,
          locationId: location.entityId,
          amount: { value: 1, unit: "each" },
        },
        TEST_ACTOR,
      );
      const id = await resolveOrThrow(ctx.db, "inventory", entry.id);
      if (owner !== undefined)
        await setInventoryOwnership(
          ctx.db,
          id,
          { mode: "explicit", ownerId: owner },
          undefined,
          TEST_ACTOR,
        );
      return id;
    };
    await stocked("Synthetic first priced", first.output.id, 10);
    await stocked("Synthetic first ordinary", first.output.id);
    await stocked("Synthetic second ordinary", second.output.id);
    const household = await stocked("Synthetic household ordinary", null);
    await stocked("Synthetic unresolved ordinary", undefined);
    await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic unstocked ordinary" }),
      TEST_ACTOR,
    );
    const views = [
      { id: "first", filters: { ownerLedgerPartyId: [first.output.id] } },
      { id: "second", filters: { ownerLedgerPartyId: [second.output.id] } },
      { id: "household", filters: { ownerLedgerPartyId: ["@household"] } },
      { id: "unknown", filters: { ownerLedgerPartyId: ["@unknown"] } },
      { id: "has", filters: { ownerPresenceFilter: "has" } },
      { id: "none", filters: { ownerPresenceFilter: "none" } },
      {
        id: "secondary",
        filters: {
          ownerLedgerPartyId: [first.output.id],
          pricePresenceFilter: "has",
        },
      },
    ];
    const operation = ENTITY_LIST_READ_OPERATIONS.product;
    const context = buildKernelContext(ctx.db);
    const counts = await operation.viewCounts(context, { views });
    expect(counts.total).toBe(6);
    expect(counts.views.map((view) => view.count)).toEqual([
      2, 1, 1, 1, 5, 1, 1,
    ]);
    await setInventoryOwnership(
      ctx.db,
      household,
      { mode: "explicit", ownerId: second.output.id },
      undefined,
      TEST_ACTOR,
    );
    const refreshed = await operation.viewCounts(context, { views });
    expect(refreshed.views.map((view) => view.count)).toEqual([
      2, 2, 0, 1, 5, 1, 1,
    ]);
  });
  it("returns complete rows, totals and derived metadata in one list read", async () => {
    await seedReferenceUniverse(ctx.db);
    const context = buildKernelContext(ctx.db);
    for (const entity of listEntities) {
      const full = await executeEntity(context, {
        action: "list",
        entity,
        filters: {},
        pagination: { pageIndex: 0, pageSize: 2 },
      });
      expect(full.action).toBe("list");
      if (full.action !== "list") throw new Error("Wrong list action");
      expect(full.meta.totalCount).toBeGreaterThanOrEqual(full.items.length);
      expect(full.items.length).toBeLessThanOrEqual(2);
      expect(full.meta.derived ?? {}).toEqual(expect.any(Object));
      for (const id of Object.keys(full.meta.derived ?? {}))
        expect(full.items.some((row) => row.id === id)).toBe(true);
      const fields = entitySummaryFields(entity);
      const selected = await ENTITY_LIST_READ_OPERATIONS[entity].listFields(
        context,
        { filters: {}, pagination: { pageIndex: 0, pageSize: 2 } },
        fields,
      );
      expect(selected.meta.totalCount).toBe(full.meta.totalCount);
      expect(selected.items).toEqual(
        selectListReadRows(
          entity,
          full.items.map((row) => listReadRowSchema.parse(row)),
          fields,
        ),
      );
    }
  }, 60_000);
  it("keys stored derived state by public page identity", async () => {
    await seedReferenceUniverse(ctx.db);
    const result = await executeEntity(buildKernelContext(ctx.db), {
      action: "list",
      entity: "product",
      filters: {},
      pagination: { pageIndex: 0, pageSize: 2 },
    });
    expect(result.action).toBe("list");
    if (result.action !== "list") throw new Error("Wrong list action");
    expect(result.items.length).toBeGreaterThan(0);
    for (const row of result.items)
      expect(result.meta.derived?.[row.id]).toMatchObject({
        quantityVariance: { state: expect.any(String) },
      });
  }, 60_000);
});
