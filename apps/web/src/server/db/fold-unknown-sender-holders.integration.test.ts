import { readFileSync } from "node:fs";
import { join } from "node:path";

import { generateShortcode } from "@cubby/shared";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { run as runTable, runFinding, runOperation } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

const MIGRATION = readFileSync(
  join(
    import.meta.dirname,
    "../../../drizzle/0021_fold_unknown_sender_holder_runs.sql",
  ),
  "utf8",
);

// The household's queue once held hundreds of one-finding holder Runs. The
// transform must move each finding to the pass that read the mail and retire
// only those holders: a run that did any work, or holds another kind of
// finding, is untouched.
describe("folding unknown-sender holder runs into their passes", () => {
  const ctx = withTestDb();

  it("moves each held finding to its pass and retires only empty holders", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Fold member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 6, 8, minute));
    const insertRun = async (
      fields: Partial<typeof runTable.$inferInsert> &
        Pick<typeof runTable.$inferInsert, "purpose" | "status">,
    ) => {
      const [row] = await getDb(ctx.db)
        .insert(runTable)
        .values({
          shortcode: generateShortcode("run"),
          ledgerPartyId: party.id,
          actorUserId: ctx.actor.userId,
          actorName: "Fold member",
          actorEmail: "fold@example.test",
          actorLedgerPartyShortcode: party.shortcode,
          actorLedgerPartyName: party.name,
          actorLedgerPartyKind: party.kind,
          trigger: "scheduled",
          ...fields,
        })
        .returning({ id: runTable.id });
      return row!.id;
    };
    const pass = await insertRun({
      purpose: "mail_discovery",
      status: "completed",
      startedAt: at(0),
      endedAt: at(10),
    });
    const holder = await insertRun({
      purpose: "account_sync",
      status: "needs_review",
      startedAt: at(5),
      endedAt: at(5),
    });
    const worked = await insertRun({
      purpose: "account_sync",
      status: "needs_review",
      startedAt: at(6),
      endedAt: at(6),
    });
    await getDb(ctx.db).insert(runOperation).values({
      runId: worked,
      operationId: "fold-worked-1",
      kind: "import_order_evidence",
      inputFingerprint: "fp",
      state: "completed",
    });
    const finding = (runId: string, fingerprint: string) => ({
      runId,
      ledgerPartyId: party.id,
      entityId: runId,
      entityKind: "run" as const,
      kind: "unclassified_vendor",
      summary: "Purchase mail from a synthetic sender does not match a vendor.",
      evidenceFingerprint: fingerprint,
    });
    await getDb(ctx.db)
      .insert(runFinding)
      .values([
        finding(holder, "a".repeat(64)),
        finding(worked, "b".repeat(64)),
      ]);

    // Two holders for the same sender in one pass: only one finding may move.
    const sibling = await insertRun({
      purpose: "account_sync",
      status: "needs_review",
      startedAt: at(7),
      endedAt: at(7),
    });
    await getDb(ctx.db)
      .insert(runFinding)
      .values(finding(sibling, "a".repeat(64)));

    // An order-mail import is a vendor-less account sync as well; it is
    // member work, not a holder, even when it never ran.
    const mailImport = await insertRun({
      purpose: "account_sync",
      status: "needs_review",
      startedAt: at(8),
      endedAt: at(8),
    });
    // Only the discriminator matters to the transform; the full order input
    // would add nothing here.
    await getDb(ctx.db).execute(
      sql`UPDATE "Run" SET input = '{"kind":"order_mail_import"}'::jsonb WHERE id = ${mailImport}`,
    );
    await getDb(ctx.db)
      .insert(runFinding)
      .values(finding(mailImport, "c".repeat(64)));

    // A holder some record still points at (here a Purchase it wrote) is
    // not disposable, whatever its shape.
    const referenced = await insertRun({
      purpose: "account_sync",
      status: "needs_review",
      startedAt: at(9),
      endedAt: at(9),
    });
    const seller = await insertWithShortcode(ctx.db, "vendor", {
      name: "Fold fixture vendor",
    });
    await insertWithShortcode(ctx.db, "purchase", {
      vendorId: seller.id,
      date: "2026-10-06",
      runId: referenced,
    });
    await getDb(ctx.db)
      .insert(runFinding)
      .values(finding(referenced, "d".repeat(64)));

    // Applying it twice is harmless (the runner never should, but a rerun
    // after a partial manual apply must not fail).
    for (const _pass of [1, 2])
      for (const statement of MIGRATION.split("--> statement-breakpoint"))
        await getDb(ctx.db).execute(sql.raw(statement));

    const findings = await getDb(ctx.db)
      .select({
        runId: runFinding.runId,
        entityId: runFinding.entityId,
        fingerprint: runFinding.evidenceFingerprint,
      })
      .from(runFinding)
      .where(eq(runFinding.ledgerPartyId, party.id))
      .orderBy(runFinding.evidenceFingerprint, runFinding.createdAt);
    expect(findings).toEqual([
      { runId: pass, entityId: pass, fingerprint: "a".repeat(64) },
      { runId: sibling, entityId: sibling, fingerprint: "a".repeat(64) },
      { runId: worked, entityId: worked, fingerprint: "b".repeat(64) },
      { runId: mailImport, entityId: mailImport, fingerprint: "c".repeat(64) },
      { runId: referenced, entityId: referenced, fingerprint: "d".repeat(64) },
    ]);
    const deleted = await getDb(ctx.db)
      .select({ id: runTable.id, deletedAt: runTable.deletedAt })
      .from(runTable)
      .where(eq(runTable.ledgerPartyId, party.id));
    expect(
      Object.fromEntries(
        deleted.map((row) => [row.id, row.deletedAt !== null]),
      ),
    ).toEqual({
      [pass]: false,
      [holder]: true,
      [sibling]: false,
      [worked]: false,
      [mailImport]: false,
      [referenced]: false,
    });
  });
});
