import { randomUUID } from "node:crypto";
import type { AuditEntityType } from "@cubby/schemas/audit";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { auditLog } from "~/server/db/schema";
import { getAuditLog } from "~/server/repo/audit-log";
import { insertAndReturn } from "./database-helpers";

/**
 * `getAuditLog` (PR 6, Phase 6) gained `source` and a `createdAtFrom`/
 * `createdAtTo` window on top of the existing entityType/entityId/cursor
 * filters. Rows are inserted directly against the `auditLog` table (rather
 * than through `logAuditEntry`) so each test can pin an exact `createdAt` —
 * `logAuditEntry` always stamps `defaultNow()`.
 */
describe("getAuditLog — source + time window", () => {
  const ctx = withTestDb();

  const makeEntry = (overrides: {
    createdAt: Date;
    source?: string;
    entityType?: AuditEntityType;
  }) =>
    insertAndReturn(ctx.db, auditLog, {
      entityType: overrides.entityType ?? "product",
      entityId: randomUUID(),
      action: "update",
      userId: ctx.actor.userId,
      source: overrides.source ?? "ui",
      createdAt: overrides.createdAt,
    });

  const day1 = new Date("2026-07-01T00:00:00.000Z");
  const day2 = new Date("2026-07-15T00:00:00.000Z");
  const day3 = new Date("2026-07-30T00:00:00.000Z");

  it("includes rows on both window boundaries and excludes rows outside it", async () => {
    await makeEntry({ createdAt: day1 });
    await makeEntry({ createdAt: day2 });
    await makeEntry({ createdAt: day3 });

    const { entries } = await getAuditLog(ctx.db, {
      limit: 50,
      createdAtFrom: day1.toISOString(),
      createdAtTo: day2.toISOString(),
    });

    expect(entries).toHaveLength(2);
    const returnedTimes = entries.map((e) => e.createdAt.toISOString()).sort();
    expect(returnedTimes).toEqual([day1.toISOString(), day2.toISOString()]);
  });

  it("filters by a single source", async () => {
    await makeEntry({ createdAt: day1, source: "ui" });
    await makeEntry({ createdAt: day2, source: "api" });
    await makeEntry({
      createdAt: day3,
      source: "script:home-depot-export-2026-07-28",
    });

    const { entries } = await getAuditLog(ctx.db, {
      limit: 50,
      source: "api",
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe("api");
  });

  it("filters by an array of sources, including the open-ended script: family", async () => {
    await makeEntry({ createdAt: day1, source: "ui" });
    await makeEntry({ createdAt: day2, source: "api" });
    await makeEntry({
      createdAt: day3,
      source: "script:home-depot-export-2026-07-28",
    });

    const { entries } = await getAuditLog(ctx.db, {
      limit: 50,
      source: ["api", "script:home-depot-export-2026-07-28"],
    });

    expect(entries.map((e) => e.source).sort()).toEqual(
      ["api", "script:home-depot-export-2026-07-28"].sort(),
    );
  });

  it("combines a source filter with cursor-based pagination (both AND together)", async () => {
    // Three "api"-sourced rows, oldest to newest, plus a "ui" row that must
    // never surface once the source filter is applied.
    await makeEntry({ createdAt: day1, source: "api" });
    await makeEntry({ createdAt: day2, source: "api" });
    await makeEntry({ createdAt: day3, source: "api" });
    await makeEntry({ createdAt: day3, source: "ui" });

    // Cursor set to day3: only entries strictly older than it should return,
    // narrowed further by source="api" — the "ui" row at day3 is excluded by
    // source anyway, so this also confirms the two conditions AND rather than
    // OR (an OR would let the "ui" row back in via the cursor having no
    // effect on it).
    const { entries } = await getAuditLog(ctx.db, {
      limit: 50,
      source: "api",
      cursor: day3.toISOString(),
    });

    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.source === "api")).toBe(true);
    expect(entries.every((e) => e.createdAt.getTime() < day3.getTime())).toBe(
      true,
    );
  });

  it("paginates identical timestamps without repeating or skipping entries", async () => {
    const timestamp = new Date("2026-07-20T12:00:00.000Z");
    const source = "script:audit-cursor-boundary";
    await Promise.all(
      Array.from({ length: 7 }, () =>
        makeEntry({ createdAt: timestamp, source }),
      ),
    );

    const entryKeys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await getAuditLog(ctx.db, {
        limit: 2,
        source,
        cursor,
      });
      entryKeys.push(...page.entries.map((entry) => entry.entryKey));
      cursor = page.nextCursor;
    } while (cursor);

    expect(entryKeys).toHaveLength(7);
    expect(new Set(entryKeys).size).toBe(7);
  });
});
