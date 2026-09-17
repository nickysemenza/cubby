import { randomUUID } from "node:crypto";

import type { SearchableEntity } from "@cubby/schemas/search";
import type { TestDbContext } from "tooling/test-setup";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { searchDocument } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { selectRecentlySoftDeletedSearchRefs } from "~/server/repo/entity-embedding-cleanup";

const DAY_MS = 24 * 60 * 60 * 1000;
const ENTITY_TYPE: SearchableEntity = "product";

/** Minimal, fabricated `SearchDocument` row — no real entity backs `entityId`,
 * matching the existing `embeddingProbes.seedEmbedding` fixture style: the
 * table has no FK to the entity it describes. */
const insertSearchDocumentRow = (
  ctx: TestDbContext,
  entityId: string,
  deletedAt: Date | null,
) =>
  getDb(ctx.db)
    .insert(searchDocument)
    .values({
      entityType: ENTITY_TYPE,
      entityId,
      shortcode: `TST-${randomUUID().slice(0, 8)}`,
      title: "Reconcile fixture",
      body: "body",
      semanticText: "semantic text",
      normalizedText: "semantic text",
      searchVector: "",
      sourceHash: `hash-${randomUUID()}`,
      deletedAt,
    });

describe("selectRecentlySoftDeletedSearchRefs", () => {
  const ctx = withTestDb();

  it("returns refs soft-deleted within the window, collapsed to one per entity, excluding any with a live twin", async () => {
    const now = Date.now();
    const since = new Date(now - 7 * DAY_MS);
    const withinWindow = new Date(now - 1 * DAY_MS);
    const outsideWindow = new Date(now - 10 * DAY_MS);

    // Table of seed cases: each row describes one entity's SearchDocument
    // history and whether the reconcile query should return it.
    const cases: Array<{
      name: string;
      entityId: string;
      rows: Array<{ deletedAt: Date | null }>;
      expectReturned: boolean;
    }> = [
      {
        name: "soft-deleted within window",
        entityId: randomUUID(),
        rows: [{ deletedAt: withinWindow }],
        expectReturned: true,
      },
      {
        name: "soft-deleted outside window",
        entityId: randomUUID(),
        rows: [{ deletedAt: outsideWindow }],
        expectReturned: false,
      },
      {
        name: "live only",
        entityId: randomUUID(),
        rows: [{ deletedAt: null }],
        expectReturned: false,
      },
      {
        // The row this test earns its place on: `markSearchDocumentMissing`
        // followed by a later successful refresh leaves the old row
        // soft-deleted and inserts a second, live row for the same entity
        // (the unique index is partial on `deletedAt IS NULL`). Deleting
        // this entity's vector because of the stale soft-deleted row would
        // remove a live entity's search result.
        name: "soft-deleted row with a live twin",
        entityId: randomUUID(),
        rows: [{ deletedAt: withinWindow }, { deletedAt: null }],
        expectReturned: false,
      },
      {
        name: "two soft-deleted rows for the same entity",
        entityId: randomUUID(),
        rows: [{ deletedAt: withinWindow }, { deletedAt: outsideWindow }],
        expectReturned: true,
      },
    ];

    for (const testCase of cases) {
      for (const row of testCase.rows) {
        await insertSearchDocumentRow(ctx, testCase.entityId, row.deletedAt);
      }
    }

    const result = await selectRecentlySoftDeletedSearchRefs(ctx.db, {
      since,
    });

    const expectedIds = cases
      .filter((testCase) => testCase.expectReturned)
      .map((testCase) => testCase.entityId);
    const returnedIds = result.refs.map((ref) => ref.entityId);

    // Exact multiset equality: catches both a missed ref and a duplicate
    // (the "two soft-deleted rows" case must appear exactly once).
    expect(returnedIds.sort()).toEqual(expectedIds.sort());
    expect(result.refs.every((ref) => ref.entityType === ENTITY_TYPE)).toBe(
      true,
    );
    expect(result.nextCursor).toBeNull();
  });
});
