import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  entitySummaryFields,
  projectEntityResult,
} from "~/contracts/mcp-projections";
import { getEntityFilters } from "~/entity/filter-manifest";
import { buildFiltersFromManifest } from "~/entity/filters";
import {
  entityListBaseOutputSchema,
  listEntities,
} from "~/entity/generated/entity-lists.gen";
import {
  listEnrichmentGroups,
  listReadRowSchema,
} from "~/entity/model/list-read-fields";
import {
  listReadFields,
  selectListReadFields,
} from "~/entity/model/list-read-schema";
import { viewsForEntity } from "~/entity/model/view-manifest";
import { getDb } from "~/server/db/helpers";
import { findOrCreateIngredient } from "~/server/domains/ingredient/repo/crud";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { executeEntity } from "~/server/entity-kernel";
import { ENTITY_KERNEL_BINDINGS } from "~/server/generated/entity-kernel-bindings.gen";
import { ENTITY_LIST_READ_OPERATIONS } from "~/server/generated/entity-list-read-bindings.gen";

import {
  buildKernelContext,
  seedReferenceUniverse,
} from "./reference-universe.fixtures";

describe("standard progressive list composition", () => {
  const ctx = withTestDb();
  it("retains ingredient grouping memberships through the progressive adapter", async () => {
    const ingredient = await findOrCreateIngredient(
      ctx.db,
      "Synthetic grouped progressive ingredient",
    );
    const base = await ENTITY_LIST_READ_OPERATIONS.ingredient.base(
      buildKernelContext(ctx.db),
      {
        filters: { ids: [ingredient.shortcode] },
        groupBy: [{ key: "usuallyOnHand" }],
        pagination: { pageIndex: 0, pageSize: 1 },
      },
    );
    expect(base.data.map((row) => row.id)).toEqual([ingredient.shortcode]);
    expect(base.meta.membershipCount).toBe(1);
    expect(base.meta.memberships).toEqual([
      { id: ingredient.shortcode, path: ["false"] },
    ]);
    expect(base.meta.groups).toEqual([
      expect.objectContaining({ path: ["false"], count: 1 }),
    ]);
  });
  it("acknowledges only selected deferred fields and rejects unknown or core demand before empty reads", async () => {
    await seedReferenceUniverse(ctx.db);
    const context = buildKernelContext(ctx.db);
    const operation = ENTITY_LIST_READ_OPERATIONS.product;
    const full = await executeEntity(context, {
      action: "list",
      entity: "product",
      filters: {},
      pagination: { pageIndex: 0, pageSize: 25 },
    });
    if (full.action !== "list") throw new Error("Wrong list action");
    const result = await operation.enrich(context, {
      ids: full.items.map((row) => String(row.id)),
      fields: ["unitPrice", "unitPrice"],
    });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      id: "derived",
      fields: ["unitPrice"],
      state: "ready",
    });
    const ready = result.groups[0];
    if (ready?.state !== "ready")
      throw new Error("Expected selected enrichment");
    expect(new Map(ready.data.map((row) => [row.id, row]))).toEqual(
      new Map(
        full.items.map((row) => [
          row.id,
          { id: row.id, unitPrice: row.unitPrice },
        ]),
      ),
    );
    await expect(
      operation.enrich(context, { ids: [], fields: ["unknownField"] }),
    ).rejects.toThrow("Unknown list field");
    await expect(
      operation.enrich(context, { ids: [], fields: ["id"] }),
    ).rejects.toThrow("requires a deferred field");
    expect(
      await operation.enrich(context, { ids: [], fields: ["unitPrice"] }),
    ).toMatchObject({
      groups: [{ fields: ["unitPrice"], data: [] }],
      missingIds: [],
    });
  });

  // Core reads must survive an unavailable deferred inheritance dependency.
  it("reads expense core without evaluating deferred inheritance", async () => {
    await seedReferenceUniverse(ctx.db);
    const context = buildKernelContext(ctx.db);
    const operation = ENTITY_LIST_READ_OPERATIONS.expense;
    await getDb(ctx.db).execute(
      sql`ALTER TABLE "Project" RENAME TO "UnavailableProject"`,
    );
    try {
      const base = await operation.base(context, {
        filters: {},
        pagination: { pageIndex: 0, pageSize: 25 },
      });
      expect(base.data.length).toBeGreaterThan(0);
      expect(base.meta.totalCount).toBeGreaterThan(0);
      const enrichment = await operation.enrich(context, {
        ids: base.data.map((row) => String(row.id)),
        fields: listReadFields("expense").derived,
      });
      expect(
        enrichment.groups.find((group) => group.id === "derived")?.state,
      ).toBe("error");
    } finally {
      await getDb(ctx.db).execute(
        sql`ALTER TABLE "UnavailableProject" RENAME TO "Project"`,
      );
    }
  });
  // A failed database-only quality lookup must not fail independent media work.
  it("retains successful groups when one enrichment query fails", async () => {
    await seedReferenceUniverse(ctx.db);
    const context = buildKernelContext(ctx.db);
    const operation = ENTITY_LIST_READ_OPERATIONS.product;
    const base = await operation.base(context, {
      filters: {},
      pagination: { pageIndex: 0, pageSize: 25 },
    });
    await getDb(ctx.db).execute(
      sql`ALTER TABLE "DataException" RENAME TO "UnavailableDataException"`,
    );
    try {
      const result = await operation.enrich(context, {
        ids: base.data.map((row) => String(row.id)),
        fields: [
          ...listReadFields("product").media,
          ...listReadFields("product").quality,
        ],
      });
      expect(result.groups.find((group) => group.id === "quality")?.state).toBe(
        "error",
      );
      expect(result.groups.find((group) => group.id === "media")?.state).toBe(
        "ready",
      );
    } finally {
      await getDb(ctx.db).execute(
        sql`ALTER TABLE "UnavailableDataException" RENAME TO "DataException"`,
      );
    }
  });
  // Regression: the image list hydrated quality inside its core read, so a
  // failed quality lookup failed the whole list. Image quality alone reads
  // ImageSighting (the sighting check); core and media never do.
  it("reads image core and media while image quality is unavailable", async () => {
    await seedReferenceUniverse(ctx.db);
    const context = buildKernelContext(ctx.db);
    const operation = ENTITY_LIST_READ_OPERATIONS.image;
    await getDb(ctx.db).execute(
      sql`ALTER TABLE "ImageSighting" RENAME TO "UnavailableImageSighting"`,
    );
    try {
      const base = await operation.base(context, {
        filters: {},
        pagination: { pageIndex: 0, pageSize: 25 },
      });
      expect(base.data.length).toBeGreaterThan(0);
      const result = await operation.enrich(context, {
        ids: base.data.map((row) => String(row.id)),
        fields: [
          ...listReadFields("image").media,
          ...listReadFields("image").quality,
        ],
      });
      expect(result.groups.find((group) => group.id === "quality")?.state).toBe(
        "error",
      );
      expect(result.groups.find((group) => group.id === "media")?.state).toBe(
        "ready",
      );
    } finally {
      await getDb(ctx.db).execute(
        sql`ALTER TABLE "UnavailableImageSighting" RENAME TO "ImageSighting"`,
      );
    }
  });
  // Regression: view counts compiled filters through the Problem registry,
  // which throws for a saved view that is not Problem-backed (Completed).
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
      const unfiltered = await operation.base(context, {
        filters: {},
        pagination: { pageIndex: 0, pageSize: 1 },
      });
      expect(counts.total).toBe(unfiltered.meta.totalCount);
      for (const view of views) {
        const base = await operation.base(context, {
          filters: view.filters,
          pagination: { pageIndex: 0, pageSize: 1 },
        });
        expect(counts.views.find((count) => count.id === view.id)?.count).toBe(
          base.meta.totalCount,
        );
      }
    }
    const productOperation = ENTITY_LIST_READ_OPERATIONS.product;
    const expected = await productOperation.base(context, { filters: {} });
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
  });
  it("composes core and every advertised group to the complete public contract", async () => {
    await seedReferenceUniverse(ctx.db);
    const context = buildKernelContext(ctx.db);
    for (const entity of listEntities) {
      const input = { filters: {}, pagination: { pageIndex: 0, pageSize: 25 } };
      const full = await executeEntity(context, {
        action: "list",
        entity,
        ...input,
      });
      if (full.action !== "list") throw new Error("Wrong list action");
      const operation = ENTITY_LIST_READ_OPERATIONS[entity];
      const base = await operation.base(context, input);
      expect(base.meta.totalCount).toBe(full.meta.totalCount);
      const repository = ENTITY_KERNEL_BINDINGS[entity].repository;
      if (!repository.listRead)
        throw new Error(`Missing list reader: ${entity}`);
      const counted = await repository.listRead(
        context,
        {},
        [],
        { pageIndex: 0, pageSize: 1 },
        { kind: "base" },
        "count",
      );
      expect(counted.data).toEqual([]);
      expect(counted.count).toBe(base.meta.totalCount);
      expect(base.data.map((row) => row.id)).toEqual(
        full.items.map((row) => row.id),
      );
      const enrichment = await operation.enrich(context, {
        ids: base.data.map((row) => String(row.id)),
        fields: base.groups.flatMap((group) => group.fields),
      });
      const patches = new Map(
        base.data.map((row) => [String(row.id), { ...row }]),
      );
      for (const group of enrichment.groups) {
        expect(group.state).toBe("ready");
        if (group.state === "ready")
          for (const row of group.data)
            Object.assign(patches.get(String(row.id))!, row);
      }
      expect([...patches.values()]).toEqual(full.items);
      const summary = await operation.summary(context, input);
      expect(summary.sums).toEqual(full.meta.sums ?? {});
      // MCP summary detail reads only the fields it publishes.
      expect(
        projectEntityResult(
          { action: "list" },
          await operation.listFields(
            context,
            input,
            entitySummaryFields(entity),
          ),
        ),
      ).toEqual(projectEntityResult({ action: "list" }, full));
      // One coherent selected read must retain values from every owning group,
      // including fields whose defaults could otherwise conceal a missed load.
      const fields = [
        "id",
        ...listEnrichmentGroups.flatMap((group) =>
          listReadFields(entity)[group].slice(0, 1),
        ),
        ...(entity === "product" ? ["unitPrice", "food"] : []),
      ];
      const selected = await operation.listFields(context, input, fields);
      expect(selected.meta.totalCount).toBe(full.meta.totalCount);
      expect(selected.items).toEqual(
        full.items.map((row) =>
          selectListReadFields(listReadRowSchema.parse(row), fields),
        ),
      );
      // Counts and totals use the entire ID-restricted population, across pages.
      const selectedId = base.data[0]?.id;
      if (!selectedId) continue;
      {
        const selected = {
          filters: { ids: [selectedId] },
          pagination: { pageIndex: 0, pageSize: 1 },
        };
        const selectedFull = await executeEntity(context, {
          action: "list",
          entity,
          ...selected,
        });
        if (selectedFull.action !== "list")
          throw new Error("Wrong list action");
        const selectedBase = await operation.base(context, selected);
        expect(selectedBase.data.map((row) => row.id)).toEqual([selectedId]);
        expect(selectedBase.meta.totalCount).toBe(1);
        expect((await operation.summary(context, selected)).sums).toEqual(
          selectedFull.meta.sums ?? {},
        );
        const later = await operation.base(context, {
          ...selected,
          pagination: { pageIndex: 1, pageSize: 1 },
        });
        expect(later.data).toEqual([]);
        expect(later.meta.totalCount).toBe(1);
      }
      const empty = await operation.base(context, {
        filters: { ids: [] },
        pagination: { pageIndex: 0, pageSize: 1 },
      });
      expect(empty.data).toEqual([]);
      expect(empty.meta.totalCount).toBe(0);
    }
  });

  // A read-only entity joins the list roster without a create/update
  // contract; without its own `listRead` the generated Runs index failed.
  it("lists a read-only entity through the generic progressive read", async () => {
    await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    const context = buildKernelContext(ctx.db);

    const base = await ENTITY_LIST_READ_OPERATIONS.run.base(context, {
      filters: {},
      pagination: { pageIndex: 0, pageSize: 25 },
    });

    expect(listEntities).toContain("run");
    expect(base.data).toEqual([
      expect.objectContaining({ purpose: "ai_suggest" }),
    ]);
    // The wire schema the HTTP list route validates; a row missing a core
    // field (e.g. undeclared `displayImages`) fails here, not just on device.
    expect(() => entityListBaseOutputSchema.parse(base)).not.toThrow();
    // The HTTP and native list read the full projection, whose items must
    // carry display images (deferred to the media group in the base read).
    const full = await executeEntity(context, {
      action: "list",
      entity: "run",
      filters: {},
    });
    if (full.action !== "list") throw new Error("expected list");
    expect(full.items).toEqual([
      expect.objectContaining({ displayImages: expect.any(Array) }),
    ]);
    expect(base.meta.totalCount).toBe(1);
  });
});
