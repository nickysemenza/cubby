import { and, eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  databaseForTransaction,
  getDb,
  withTransaction,
} from "~/server/db/helpers";
import { auditLog, expense, runFinding } from "~/server/db/schema";
import { findOpenRunFindings } from "~/server/generic/problems/repo/detectors-import";
import { runDiagnostic } from "~/server/generic/problems/service/problem-diagnostics.service";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { activeFindingSql } from "./finding-expiry";
import { resolveRunFinding } from "./findings";

const now = new Date("2026-09-20T12:00:00.000Z");

// Ordinary reads must not dismiss stored findings. The deadline itself is
// expired, including direct apply without a prior Problems read; refusal must
// leave business/audit rows untouched, while explicit dismiss stays available.
describe("finding expiry", () => {
  const ctx = withTestDb();
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  const owner = () =>
    insertWithShortcode(ctx.db, "ledgerParty", {
      kind: "member",
      userId: ctx.actor.userId,
      name: "Synthetic finding owner",
    });

  it("keeps SQL expiry independent of the session time zone at the deadline", async () => {
    const open = "open";
    const dismissed = "dismissed";
    const rows = await withTransaction(ctx.db, async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      await tx.execute(sql`SET LOCAL TIME ZONE 'America/Los_Angeles'`);
      return (
        await tx.execute(sql`
        SELECT label FROM (VALUES
          (${"past"}, ${open}, (now() AT TIME ZONE 'UTC') - interval '1 minute'),
          (${"deadline"}, ${open}, now() AT TIME ZONE 'UTC'),
          (${"future"}, ${open}, (now() AT TIME ZONE 'UTC') + interval '1 minute'),
          (${"none"}, ${open}, NULL::timestamp),
          (${"resolved"}, ${dismissed}, NULL::timestamp)
        ) finding(label, status, "expiresAt")
        WHERE ${activeFindingSql("finding")} ORDER BY label
      `)
      ).rows;
    });
    expect(rows).toEqual([{ label: "future" }, { label: "none" }]);
  });

  it("reads exact active findings in a read-only transaction without changing history", async () => {
    const party = await owner();
    const target = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic expiry target" }),
      ctx.actor,
    );
    const rows = await getDb(ctx.db)
      .insert(runFinding)
      .values(
        [
          new Date(now.getTime() - 1),
          now,
          new Date(now.getTime() + 60_000),
          null,
        ].map((expiresAt, index) => ({
          ledgerPartyId: party.id,
          entityKind: "product" as const,
          entityId: target.entityId,
          kind: "other" as const,
          summary: "Synthetic retained finding",
          evidenceFingerprint: `synthetic-expiry-${index}`,
          expiresAt,
          createdAt: new Date(now.getTime() - 60_000 + index * 1000),
        })),
      )
      .returning();
    const result = await withTransaction(ctx.db, async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      const db = databaseForTransaction(tx);
      return {
        findings: await findOpenRunFindings(db),
        sample: await runDiagnostic(
          db,
          "import-findings",
          {},
          {
            kind: "sample",
            limit: 1,
          },
        ),
        count: await runDiagnostic(
          db,
          "import-findings",
          {},
          { kind: "count" },
        ),
      };
    });
    expect(result.findings.map((finding) => finding.id)).toEqual(
      rows.slice(2).map((finding) => finding.id),
    );
    expect(result.sample.items).toHaveLength(1);
    expect(result.sample.count).toBe(2);
    expect(result.count.count).toBe(2);
    const stored = await getDb(ctx.db)
      .select()
      .from(runFinding)
      .orderBy(runFinding.createdAt);
    expect(stored).toEqual(rows);
  });

  it("refuses an expired apply without changing the target or audit, and permits dismiss", async () => {
    const party = await owner();
    const target = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic proposed Product" }),
      ctx.actor,
    );
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic finding vendor",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      displayLabel: "Synthetic finding order",
    });
    const line = await insertWithShortcode(ctx.db, "expense", {
      name: "Synthetic unlinked line",
      purchaseId: purchase.id,
      cost: 10,
      date: "2026-09-19",
      lineKind: "principal",
      lineBasis: "item_line",
      economicRole: "vendor",
      costType: "materials",
      trade: "other",
    });
    const [finding] = await getDb(ctx.db)
      .insert(runFinding)
      .values({
        ledgerPartyId: party.id,
        entityKind: "expense",
        entityId: line.id,
        kind: "wrong_product",
        summary: "Synthetic expired Product correction",
        evidenceFingerprint: "synthetic-expired-apply",
        expiresAt: now,
        proposedFix: {
          kind: "relink_product",
          expenseId: line.id,
          productId: target.entityId,
        },
      })
      .returning();
    if (!finding) throw new Error("Missing synthetic finding");
    const audit = () =>
      getDb(ctx.db)
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.entityKind, "expense"),
            eq(auditLog.entityId, line.id),
          ),
        );
    const before = await audit();
    await expect(
      resolveRunFinding(ctx.db, { id: finding.id, action: "apply" }, ctx.actor),
    ).rejects.toThrow("expired");
    expect(await audit()).toEqual(before);
    expect(
      await getDb(ctx.db)
        .select({ productId: expense.productId })
        .from(expense)
        .where(eq(expense.id, line.id)),
    ).toEqual([{ productId: null }]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runFinding)
        .where(eq(runFinding.id, finding.id)),
    ).toEqual([finding]);
    await expect(
      resolveRunFinding(
        ctx.db,
        { id: finding.id, action: "dismiss" },
        ctx.actor,
      ),
    ).resolves.toEqual({ id: finding.id, status: "dismissed" });
  });
});
