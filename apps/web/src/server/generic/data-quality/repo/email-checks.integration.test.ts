import { parseEntityId } from "@cubby/schemas/identifiers";
import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb } from "~/server/db/helpers";
import {
  orderMail,
  orderMailAttachment,
  run as runTable,
} from "~/server/db/schema";
import { listEmailsRead } from "~/server/domains/email/repo/email";
import { resolveMail } from "~/server/domains/purchase-import/mail-tool";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { loadDataQualities } from "./hydrate";
import { gapCondition, qualityFilterSource, qualityFilterContext } from "./sql";

// Email pipeline gaps are Relevance-conditional, and their correlated SQL must
// stay bound to the scored Email: another Email's attachment or completed
// import Run must never satisfy this Email's check.
// A reviewed link to an existing Purchase must not demand another extraction.
describe("Email data quality", () => {
  const ctx = withTestDb();

  // Scalar checks must stay bounded with both unrelated history and enough
  // completed imports to exceed a hashed SubPlan's default memory estimate.
  it("bounds completed-import membership work independently of Email volume", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic membership member",
      kind: "member",
    });
    const originals = await getDb(ctx.db)
      .insert(orderMail)
      .values(
        Array.from({ length: 80 }, () => ({
          ledgerPartyId: party.id,
          rawChecksum: "c".repeat(64),
        })),
      )
      .returning();
    const originalAt = (index: number) => {
      const original = originals[index];
      if (!original) throw new Error("Synthetic original was not created");
      return original.id;
    };
    for (let index = 0; index < 2900; index++)
      await insertWithShortcode(ctx.db, "run", {
        ledgerPartyId: party.id,
        actorUserId: ctx.actor.userId,
        actorName: "Synthetic member",
        actorEmail: "member@example.test",
        actorLedgerPartyShortcode: party.shortcode,
        actorLedgerPartyName: party.name,
        actorLedgerPartyKind: party.kind,
        purpose: index < 400 ? "ai_suggest" : "mail_import",
        trigger: "manual",
        status: "completed",
        input: {
          kind: "mail_research",
          sources: [
            { orderMailId: originalAt(index % 40), checksum: "c".repeat(64) },
          ],
        },
      });
    for (let index = 0; index < 120; index++)
      await insertWithShortcode(ctx.db, "email", {
        ledgerPartyId: party.id,
        mailboxId: "synthetic-membership-mailbox",
        messageId: `synthetic-membership-${index}`,
        orderMailId:
          index % 3 === 0
            ? null
            : originalAt(Math.floor(index / 3) + (index % 3 === 1 ? 40 : 0)),
        checksum: "c".repeat(64),
        classification: "related",
        status: "pending",
      });
    await getDb(ctx.db).execute(sql`ANALYZE "Email", "Run"`);
    const statement = sql`SELECT "Email".id, ${gapCondition("email", "email_not_imported", undefined, qualityFilterContext("email"))} AS gap FROM ${qualityFilterSource("email")}`;
    const rows = await getDb(ctx.db).execute(statement);
    const gaps = z.array(z.object({ gap: z.boolean() })).parse(rows.rows);
    expect(gaps).toHaveLength(120);
    expect(gaps.filter((row) => row.gap)).toHaveLength(80);
    const result = await getDb(ctx.db).execute(
      sql`EXPLAIN (ANALYZE, FORMAT JSON) ${statement}`,
    );
    const planRows = z
      .array(
        z.object({ "QUERY PLAN": z.array(z.object({ Plan: z.unknown() })) }),
      )
      .parse(result.rows);
    const planNode = z.object({
      "Node Type": z.string(),
      "Relation Name": z.string().optional(),
      "Actual Rows": z.number().default(0),
      "Actual Loops": z.number().default(0),
      "Rows Removed by Filter": z.number().default(0),
      Plans: z.array(z.unknown()).optional(),
    });
    let membershipRowsVisited = 0;
    const visit = (value: unknown) => {
      const node = planNode.parse(value);
      if (
        node["Relation Name"] === "Run" ||
        node["Node Type"] === "Materialize" ||
        node["Node Type"] === "Function Scan"
      )
        membershipRowsVisited +=
          (node["Actual Rows"] + node["Rows Removed by Filter"]) *
          node["Actual Loops"];
      node.Plans?.forEach(visit);
    };
    for (const row of planRows)
      row["QUERY PLAN"].forEach(({ Plan }) => visit(Plan));
    // Allow one complete history/source scan, reject a scan per Email.
    expect(membershipRowsVisited).toBeLessThan(10000);
  });

  it("rejects completed Mail import Runs without an owner", async () => {
    await expect(
      insertWithShortcode(ctx.db, "run", {
        ledgerPartyId: null,
        actorUserId: ctx.actor.userId,
        actorName: "Synthetic member",
        actorEmail: "member@example.test",
        purpose: "mail_import",
        trigger: "manual",
        status: "completed",
      }),
    ).rejects.toMatchObject({
      cause: { code: "23514", constraint: "Run_import_party_check" },
    });
  });

  // The historical JSON containment contract includes explicit JSON null,
  // ignores missing keys/scalars, and fences by live completed Run ownership.
  it("preserves source containment and completed-import fences", async () => {
    for (const scenario of [
      "exact",
      "extra-fields",
      "other-member",
      "failed",
      "deleted",
      "other-purpose",
      "scalar-sources",
      "missing-key",
      "explicit-null",
    ] as const) {
      const party = await insertWithShortcode(ctx.db, "ledgerParty", {
        name: `Synthetic ${scenario} member`,
        kind: "member",
      });
      const [original] = await getDb(ctx.db)
        .insert(orderMail)
        .values({ ledgerPartyId: party.id, rawChecksum: "c".repeat(64) })
        .returning();
      if (!original) throw new Error("Synthetic original was not created");
      const message = await insertWithShortcode(ctx.db, "email", {
        ledgerPartyId: party.id,
        mailboxId: "synthetic-containment-mailbox",
        messageId: scenario,
        checksum: "c".repeat(64),
        classification: "related",
        status: "pending",
        orderMailId:
          scenario === "explicit-null" || scenario === "missing-key"
            ? null
            : original.id,
      });
      const importParty =
        scenario === "other-member"
          ? await insertWithShortcode(ctx.db, "ledgerParty", {
              name: "Synthetic other importer",
              kind: "member",
            })
          : party;
      const run = await insertWithShortcode(ctx.db, "run", {
        ledgerPartyId: importParty.id,
        actorUserId: ctx.actor.userId,
        actorName: "Synthetic member",
        actorEmail: "member@example.test",
        actorLedgerPartyShortcode: importParty.shortcode,
        actorLedgerPartyName: importParty.name,
        actorLedgerPartyKind: importParty.kind,
        purpose: scenario === "other-purpose" ? "ai_suggest" : "mail_import",
        trigger: "manual",
        status: scenario === "failed" ? "failed" : "completed",
        deletedAt: scenario === "deleted" ? new Date() : null,
      });
      const source =
        scenario === "explicit-null"
          ? { orderMailId: null }
          : scenario === "missing-key"
            ? {}
            : {
                orderMailId: original.id,
                ...(scenario === "extra-fields"
                  ? { checksum: "synthetic-checksum" }
                  : {}),
              };
      // Malformed historical inputs bypass the current write schema on purpose.
      const input = {
        sources: scenario === "scalar-sources" ? source : [source],
      };
      await getDb(ctx.db).execute(
        sql`UPDATE ${runTable} SET input = ${JSON.stringify(input)}::jsonb WHERE id = ${run.id}`,
      );
      const result = await getDb(ctx.db).execute(
        sql`SELECT ${gapCondition("email", "email_not_imported")} AS gap FROM "Email" WHERE id = ${message.id}`,
      );
      const bulk = await getDb(ctx.db).execute(
        sql`SELECT ${gapCondition("email", "email_not_imported", undefined, qualityFilterContext("email"))} AS gap FROM ${qualityFilterSource("email")} WHERE "Email".id = ${message.id}`,
      );
      expect(bulk.rows).toEqual(result.rows);
      const expected = !["exact", "extra-fields", "explicit-null"].includes(
        scenario,
      );
      expect(
        z.array(z.object({ gap: z.boolean() })).parse(result.rows),
      ).toEqual([{ gap: expected }]);
    }
  });

  it("settles automated negatives and keeps related checks bound to their own original and import", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic quality member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const shell = async (bodyText: string | null) =>
      (
        await getDb(ctx.db)
          .insert(orderMail)
          .values({
            ledgerPartyId: party.id,
            rawChecksum: "c".repeat(64),
            content: { snippet: null, bodyText, bodyHtml: null },
          })
          .returning()
      )[0]!;
    const email = (
      messageId: string,
      fields: Partial<
        Parameters<typeof insertWithShortcode<"email">>[2] & object
      >,
    ) =>
      insertWithShortcode(ctx.db, "email", {
        ledgerPartyId: party.id,
        provider: "gmail",
        mailboxId: "synthetic-quality-mailbox",
        messageId,
        checksum: "c".repeat(64),
        classification: "related",
        classificationStage: "decision",
        status: "pending",
        ...fields,
      });
    const other = await shell(null);
    await getDb(ctx.db)
      .insert(orderMailAttachment)
      .values({
        orderMailId: other.id,
        providerAttachmentId: "synthetic-other-attachment",
        filename: "other.pdf",
        mimeType: "application/pdf",
        checksum: "d".repeat(64),
        pendingObjectKey: "synthetic/other.pdf",
      });
    await insertWithShortcode(ctx.db, "run", {
      ledgerPartyId: party.id,
      actorUserId: ctx.actor.userId,
      actorName: "Synthetic member",
      actorEmail: "member@example.test",
      actorLedgerPartyShortcode: party.shortcode,
      actorLedgerPartyName: party.name,
      actorLedgerPartyKind: party.kind,
      purpose: "mail_import",
      trigger: "manual",
      status: "completed",
      input: {
        kind: "mail_research",
        sources: [{ orderMailId: other.id, checksum: "c".repeat(64) }],
      },
    });
    const unrelated = await email("synthetic-unrelated", {
      classification: "unrelated",
      status: "completed",
    });
    const emptyShell = await shell(null);
    const related = await email("synthetic-related", {
      orderMailId: emptyShell.id,
    });
    const retained = await email("synthetic-retained", {
      orderMailId: (await shell("Synthetic order body")).id,
    });
    const linked = await email("synthetic-linked", {
      orderMailId: (await shell("Synthetic existing-order confirmation")).id,
      classificationStage: "resolution",
      status: "completed",
    });
    const seller = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic existing-order vendor",
    });
    const order = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: seller.id,
      orderId: "synthetic-existing-order",
    });
    await resolveMail(
      ctx.db,
      {
        mailboxId: linked.mailboxId,
        messageId: linked.messageId,
        checksum: linked.checksum,
        disposition: {
          kind: "linked",
          event: "confirmation",
          purchaseIds: [order.shortcode],
        },
      },
      ctx.actor,
    );

    const id = (row: { id: string }) => parseEntityId("email", row.id);
    const qualities = await loadDataQualities(ctx.db, "email", [
      id(unrelated),
      id(related),
      id(retained),
      id(linked),
    ]);
    const gaps = (row: { id: string }) =>
      qualities
        .get(id(row))
        ?.gaps.map((gap) => gap.check)
        .sort();
    expect(gaps(unrelated)).toEqual([]);
    expect(gaps(related)).toEqual([
      "email_not_imported",
      "email_original_missing",
      "email_preview_missing",
      "email_relevance_unreviewed",
    ]);
    expect(gaps(retained)).toEqual([
      "email_not_imported",
      "email_preview_missing",
      "email_relevance_unreviewed",
    ]);
    expect(gaps(linked)).toEqual([]);

    const reviewQueue = await listEmailsRead(
      ctx.db,
      { dataGap: ["email_relevance_unreviewed"] },
      [],
      { pageIndex: 0, pageSize: 10 },
    );
    expect(reviewQueue.data.map((row) => row.id)).not.toContain(
      unrelated.shortcode,
    );

    const missingOriginal = await listEmailsRead(
      ctx.db,
      { dataGap: ["email_original_missing"] },
      [],
      { pageIndex: 0, pageSize: 10 },
    );
    expect(missingOriginal.data.map((row) => row.id)).toEqual([
      related.shortcode,
    ]);
  });
});
