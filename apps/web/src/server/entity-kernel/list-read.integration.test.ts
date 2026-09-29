import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { listEntities } from "~/entities/generated/entity-lists.gen";
import { executeEntity } from "~/server/entity-kernel";
import { ENTITY_LIST_READ_OPERATIONS } from "~/server/generated/entity-kernel-bindings.gen";
import { getDb } from "~/server/repo/database-helpers";

import {
  buildKernelContext,
  seedReferenceUniverse,
} from "./reference-universe.fixtures";

describe("standard progressive list composition", () => {
  const ctx = withTestDb();
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
        groups: ["media", "quality"],
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
      expect(base.data.map((row) => row.id)).toEqual(
        full.items.map((row) => row.id),
      );
      const enrichment = await operation.enrich(context, {
        ids: base.data.map((row) => String(row.id)),
        groups: base.groups.map((group) => group.id),
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
});
