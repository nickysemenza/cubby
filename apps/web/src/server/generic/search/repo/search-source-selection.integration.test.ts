import { sql } from "drizzle-orm";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { normalizeSearchText } from "~/lib/search-normalization";
import { TEXT_WHITESPACE } from "~/lib/text-whitespace";
import { normalizeSearchTextSql } from "~/server/db/computed/search-normalization";
import {
  fanoutTarget,
  isFanoutInput,
  storedDerived,
} from "~/server/db/derived-declarations";
import { unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { getSemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import { captureBackgroundQueue } from "~/server/testing/background-queue";
import {
  createProductIdentityFixture,
  makeProductInput,
  createLocationFixture,
  makeLocationInput,
} from "~/server/testing/repo.fixtures";

import {
  prepareSearchDocuments,
  publishPreparedSearchDocuments,
  refreshSearchDocument,
  searchCoverageIncomplete,
} from "./search-document";

// A requested source must not compile unrelated entity branches into its SQL.
// Stable source columns and recursive location paths must survive narrowing.
describe("search source selection", () => {
  const ctx = withTestDb();

  // #3327: coverage is unconfirmed per candidate kind, not while any search
  // work anywhere is pending.
  it("confirms coverage for a kind unless that kind's search documents are pending", async () => {
    const config = getSemanticEmbeddingConfig();
    const mark = (target: string) =>
      unwrapDb(ctx.db).execute(sql`
        INSERT INTO "WorkItem" (target, ref) VALUES (${target}, ${crypto.randomUUID()}::uuid)`);
    await unwrapDb(ctx.db).execute(sql`DELETE FROM "WorkItem"`);
    await mark("expense.searchDocument");
    expect(await searchCoverageIncomplete(ctx.db, config, ["product"])).toBe(
      false,
    );
    const product = storedDerived("product", "searchDocument")!;
    const fanout = product.inputs.findIndex(isFanoutInput);
    await mark(fanoutTarget(product.target, fanout));
    expect(await searchCoverageIncomplete(ctx.db, config, ["product"])).toBe(
      true,
    );
    await unwrapDb(ctx.db).execute(
      sql`DELETE FROM "WorkItem" WHERE target <> 'expense.searchDocument'`,
    );
    await mark(product.target);
    expect(await searchCoverageIncomplete(ctx.db, config, ["product"])).toBe(
      true,
    );
  });

  it("indexes a document whose body exceeds the full-text size limit", async () => {
    // Distinct synthetic tokens: a tsvector over this whole body is ~2 MB.
    const notes = Array.from(
      { length: 180_000 },
      (_, index) => `token${index.toString(36)}`,
    ).join(" ");
    const item = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic oversized notes", notes }),
      ctx.actor,
    );
    const result = await refreshSearchDocument(
      ctx.db,
      "product",
      item.entityId,
    );
    expect(result.status).not.toBe("missing");
    const stored = await unwrapDb(ctx.db).execute<{ length: number }>(sql`
      SELECT length(body) AS length FROM "SearchDocument"
       WHERE "entityId" = ${item.entityId}::uuid`);
    expect(Number(stored.rows[0]?.length)).toBeGreaterThan(1_000_000);
  });

  it("normalizes document text and query input with the same recipe", async () => {
    for (const text of [
      "",
      TEXT_WHITESPACE,
      `${TEXT_WHITESPACE}Blue\t\nTARP${TEXT_WHITESPACE}`,
      "CAFÉ\u00a0KIT",
      "a\u200bb",
    ]) {
      const result = await unwrapDb(ctx.db).execute<{ normalized: string }>(sql`
        SELECT ${normalizeSearchTextSql(sql`${text}::text`)} AS normalized
      `);
      expect(result.rows[0]?.normalized).toBe(normalizeSearchText(text));
    }
  });

  let queue: ReturnType<typeof captureBackgroundQueue>;
  beforeEach(() => {
    queue = captureBackgroundQueue();
  });
  afterEach(() => queue.restore());

  it("prepares a Product without reading unrelated garden journal sources", async () => {
    const subject = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic source gauge" }),
      ctx.actor,
    );
    const measured = await countTestDbQueries(() =>
      prepareSearchDocuments(ctx.db, [
        { entityKind: "product", entityId: subject.entityId },
      ]),
    );
    expect(
      measured.result.entries.map((entry) => ({
        id: entry.source.entityId,
        title: entry.source.title,
      })),
    ).toEqual([{ id: subject.entityId, title: "Synthetic source gauge" }]);
    expect(measured.result.missing).toEqual([]);
    expect(measured.tables).not.toContain("GardenEntry");
  });

  it("publishes a search page without one database write per document", async () => {
    const refs: Parameters<typeof prepareSearchDocuments>[1][number][] = [];
    for (let index = 0; index < 8; index++) {
      const item = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: `Synthetic publication ${index}` }),
        ctx.actor,
      );
      refs.push({ entityKind: "product", entityId: item.entityId });
    }
    const prepared = await prepareSearchDocuments(ctx.db, refs);
    const single = await countTestDbQueries(() =>
      publishPreparedSearchDocuments(ctx.db, {
        entries: prepared.entries.slice(0, 1),
        missing: [],
      }),
    );
    const page = await countTestDbQueries(() =>
      publishPreparedSearchDocuments(ctx.db, prepared),
    );
    expect(page.result).toHaveLength(8);
    expect(page.result.every((row) => row.status === "upserted")).toBe(true);
    expect(page.queryCount).toBe(single.queryCount);
    const stored = await unwrapDb(ctx.db).execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM "SearchDocument"
       WHERE "entityId" = ANY(${uuidArrayParam(refs.map((ref) => ref.entityId))})
         AND "deletedAt" IS NULL`);
    expect(stored.rows[0]?.count).toBe(8);
    const ordered = [...prepared.entries].sort((a, b) =>
      a.source.entityId.localeCompare(b.source.entityId),
    );
    const missing = ordered
      .filter((_, index) => index % 2 === 0)
      .map((entry) => entry.source);
    const retained = ordered.filter((_, index) => index % 2 !== 0);
    const mixed = await countTestDbQueries(() =>
      publishPreparedSearchDocuments(ctx.db, {
        entries: retained,
        missing,
      }),
    );
    expect(mixed.result.filter((row) => row.status === "missing")).toHaveLength(
      4,
    );
    expect(
      mixed.result.filter((row) => row.status === "upserted"),
    ).toHaveLength(4);
    expect(mixed.queryCount).toBeLessThanOrEqual(single.queryCount + 4);
    const removed = await unwrapDb(ctx.db).execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM "SearchDocument"
       WHERE "entityId" = ANY(${uuidArrayParam(missing.map((ref) => ref.entityId))})
         AND "deletedAt" IS NOT NULL`);
    expect(removed.rows[0]?.count).toBe(4);
    await publishPreparedSearchDocuments(ctx.db, { entries: [], missing });
    const history = await unwrapDb(ctx.db).execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM "SearchDocument"
      WHERE "entityId" = ANY(${uuidArrayParam(refs.map((ref) => ref.entityId))})`);
    expect(history.rows[0]?.count).toBe(8);
    await publishPreparedSearchDocuments(ctx.db, prepared);
    // Opposing live/missing sets must still acquire publication locks in the
    // same order, including when one publisher starts with reversed input.
    const competing = await Promise.all([
      publishPreparedSearchDocuments(ctx.db, { entries: retained, missing }),
      publishPreparedSearchDocuments(ctx.db, {
        entries: ordered.filter((_, index) => index % 2 === 0).reverse(),
        missing: retained.map((entry) => entry.source).reverse(),
      }),
    ]);
    expect(competing.map((results) => results.length)).toEqual([8, 8]);
  });

  it("retains source columns and deduplicates mixed requested records", async () => {
    const subject = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic source gauge" }),
      ctx.actor,
    );
    const place = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic source bay" }),
      ctx.actor,
    );
    const refs: Parameters<typeof prepareSearchDocuments>[1] = [
      { entityKind: "product", entityId: subject.entityId },
      { entityKind: "location", entityId: place.entityId },
      { entityKind: "product", entityId: subject.entityId },
    ];
    const prepared = await prepareSearchDocuments(ctx.db, refs);
    expect(
      prepared.entries.map((entry) => ({
        kind: entry.source.entityKind,
        title: entry.source.title,
      })),
    ).toEqual([
      { kind: "product", title: "Synthetic source gauge" },
      { kind: "location", title: "Synthetic source bay" },
    ]);
    expect(prepared.missing).toEqual([]);
  });
});
