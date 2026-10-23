import { sql } from "drizzle-orm";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { normalizeSearchText } from "~/lib/search-normalization";
import { TEXT_WHITESPACE } from "~/lib/text-whitespace";
import { normalizeSearchTextSql } from "~/server/db/computed/search-normalization";
import { unwrapDb } from "~/server/db/helpers";
import { captureBackgroundQueue } from "~/server/testing/background-queue";
import {
  createProductIdentityFixture,
  makeProductInput,
  createLocationFixture,
  makeLocationInput,
} from "~/server/testing/repo.fixtures";

import { prepareSearchDocuments } from "./search-document";

// A requested source must not compile unrelated entity branches into its SQL.
// Stable source columns and recursive location paths must survive narrowing.
describe("search source selection", () => {
  const ctx = withTestDb();

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
