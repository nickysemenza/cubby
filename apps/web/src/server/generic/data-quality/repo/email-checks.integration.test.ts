import { parseEntityId } from "@cubby/schemas/identifiers";
import { workQueueHouseholdInput } from "@cubby/schemas/work-queue";
import { sql } from "drizzle-orm";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb } from "~/server/db/helpers";
import {
  email,
  orderMail,
  orderMailAttachment,
  run as runTable,
} from "~/server/db/schema";
import { listEmailsRead } from "~/server/domains/email/repo/email";
import { resolveMail } from "~/server/domains/purchase-import/operations/mail-tool";
import { listScaffold } from "~/server/generic/list/repo/list";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { readWorkQueue } from "~/server/generic/work-queue/service/work-queue-read";

import { loadDataQualities } from "./hydrate";
import {
  checksOf,
  gapCondition,
  qualityFilterSource,
  qualityFilterContext,
  statusSql,
} from "./sql";

// Email pipeline gaps are Relevance-conditional, and their correlated SQL must
// stay bound to the scored Email: another Email's attachment or completed
// import Run must never satisfy this Email's check.
// A reviewed link to an existing Purchase must not demand another extraction.
// Original-content checks must inspect the selected Email's original, rather
// than decompressing every retained message body to build a hashed SubPlan.
// Settled unrelated history must not enter the filter-only evidence joins.
describe("Email data quality", () => {
  const ctx = withTestDb();

  it("bounds original-content inspection to the scored Emails", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic content member",
      kind: "member",
    });
    const originals = await getDb(ctx.db)
      .insert(orderMail)
      .values(
        Array.from({ length: 300 }, (_, index) => ({
          ledgerPartyId: party.id,
          rawChecksum: "c".repeat(64),
          content: {
            snippet:
              index < 3 || index === 4 ? " " : "Synthetic retained content",
            bodyText:
              index === 1 ? "Synthetic plain text" : index === 2 ? " " : null,
            bodyHtml: index === 2 ? "<p>Synthetic HTML</p>" : null,
          },
        })),
      )
      .returning({ id: orderMail.id });
    const originalAt = (index: number) => {
      const original = originals[index];
      if (!original) throw new Error("Synthetic original missing");
      return original.id;
    };
    await getDb(ctx.db)
      .insert(orderMailAttachment)
      .values({
        orderMailId: originalAt(4),
        providerAttachmentId: "synthetic-retained",
        filename: "synthetic.pdf",
        mimeType: "application/pdf",
        checksum: "d".repeat(64),
        pendingObjectKey: "synthetic/retained.pdf",
      });
    const expectedMissing = new Set<string>();
    for (let index = 0; index < 300; index++) {
      const record = await insertWithShortcode(ctx.db, "email", {
        ledgerPartyId: party.id,
        mailboxId: "synthetic-content-mailbox",
        messageId: `synthetic-content-${index}`,
        checksum: "c".repeat(64),
        classification: index < 120 ? "related" : "unrelated",
        status: "pending",
        orderMailId: index === 3 ? null : originalAt(index),
        contentClearedAt: index === 5 ? new Date() : null,
      });
      if (index === 0 || index === 3 || index === 5)
        expectedMissing.add(record.id);
    }
    await getDb(ctx.db).execute(sql`ANALYZE "Email", "OrderMail"`);
    const qualityQuery = (bulk: boolean) => {
      const context = bulk ? qualityFilterContext("email") : undefined;
      return sql`SELECT "Email".id,
        ${gapCondition("email", "email_original_missing", undefined, context)} AS gap,
        jsonb_build_array(${sql.join(
          checksOf("email").map(
            (check) =>
              sql`${gapCondition("email", check, undefined, context)} IS TRUE`,
          ),
          sql`, `,
        )}) AS checks,
        ${statusSql("email", undefined, context)} AS status
        FROM ${bulk ? qualityFilterSource("email") : sql`"Email"`}`;
    };
    const query = qualityQuery(true);
    const rows = await getDb(ctx.db).execute(query);
    const resultSchema = z.array(
      z.object({
        id: z.string(),
        gap: z.boolean(),
        checks: z.array(z.boolean()),
        status: z.string(),
      }),
    );
    const gaps = resultSchema.parse(rows.rows);
    expect(gaps).toHaveLength(300);
    expect(new Set(gaps.filter((row) => row.gap).map((row) => row.id))).toEqual(
      expectedMissing,
    );
    const scalar = await getDb(ctx.db).execute(qualityQuery(false));
    expect(
      new Map(
        resultSchema
          .parse(scalar.rows)
          .map(({ id, ...quality }) => [id, quality]),
      ),
    ).toEqual(new Map(gaps.map(({ id, ...quality }) => [id, quality])));
    const explained = await getDb(ctx.db).execute(
      sql`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`,
    );
    const node = z.object({
      "Relation Name": z.string().optional(),
      Alias: z.string().optional(),
      Filter: z.string().optional(),
      "Actual Rows": z.number().default(0),
      "Actual Loops": z.number().default(0),
      "Rows Removed by Filter": z.number().default(0),
      Plans: z.array(z.unknown()).optional(),
    });
    const plans = z
      .array(
        z.object({ "QUERY PLAN": z.array(z.object({ Plan: z.unknown() })) }),
      )
      .parse(explained.rows);
    let inspected = 0;
    let qualityCandidates = 0;
    const inspect = (value: unknown) => {
      const current = node.parse(value);
      if (current["Relation Name"] === "Email" && current.Alias === "candidate")
        qualityCandidates += current["Actual Rows"] * current["Actual Loops"];
      if (
        current["Relation Name"] === "OrderMail" &&
        current.Filter?.includes("content")
      )
        inspected +=
          (current["Actual Rows"] + current["Rows Removed by Filter"]) *
          current["Actual Loops"];
      current.Plans?.forEach(inspect);
    };
    inspect(plans[0]!["QUERY PLAN"][0]!.Plan);
    expect(inspected).toBeLessThanOrEqual(120);
    expect(qualityCandidates).toBeGreaterThan(0);
    expect(qualityCandidates).toBeLessThanOrEqual(120);
  });

  it("counts and queues only Emails without a completed import", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic membership member",
      kind: "member",
    });
    const originals = await getDb(ctx.db)
      .insert(orderMail)
      .values(
        Array.from({ length: 4 }, () => ({
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
    for (let index = 0; index < 4; index++)
      await insertWithShortcode(ctx.db, "run", {
        ledgerPartyId: party.id,
        actorUserId: ctx.actor.userId,
        actorName: "Synthetic member",
        actorEmail: "member@example.test",
        actorLedgerPartyShortcode: party.shortcode,
        actorLedgerPartyName: party.name,
        actorLedgerPartyKind: party.kind,
        purpose: index < 2 ? "ai_suggest" : "mail_import",
        trigger: "manual",
        status: "completed",
        input: {
          kind: "mail_research",
          sources: [
            { orderMailId: originalAt(index % 2), checksum: "c".repeat(64) },
          ],
        },
      });
    for (let index = 0; index < 6; index++)
      await insertWithShortcode(ctx.db, "email", {
        ledgerPartyId: party.id,
        mailboxId: "synthetic-membership-mailbox",
        messageId: `synthetic-membership-${index}`,
        orderMailId:
          index % 3 === 0
            ? null
            : originalAt(Math.floor(index / 3) + (index % 3 === 1 ? 2 : 0)),
        checksum: "c".repeat(64),
        classification: "related",
        status: "pending",
      });
    const statement = sql`SELECT "Email".id, ${gapCondition("email", "email_not_imported", undefined, qualityFilterContext("email"))} AS gap FROM ${qualityFilterSource("email")}`;
    const rows = await getDb(ctx.db).execute(statement);
    const gaps = z.array(z.object({ gap: z.boolean() })).parse(rows.rows);
    expect(gaps).toHaveLength(6);
    expect(gaps.filter((row) => row.gap)).toHaveLength(4);
    // Plain count reads need no completed-import membership or hydration.
    const plain = await countTestDbQueries(() =>
      listScaffold("email", email, {
        derived: {
          linkState: sql`0`,
          scopeLinkState: sql`NULL`,
          linked: sql`false`,
          reviewConflict: sql`false`,
          purchaseId: () => undefined,
          vendorId: () => undefined,
          vendorAccountId: () => undefined,
        },
      }).raw(
        ctx.db,
        {
          filters: {},
          sorts: [],
          pagination: { pageIndex: 0, pageSize: 25 },
          readIntent: "count",
        },
        {},
      ),
    );
    expect(plain.result.count).toBe(6);
    expect(plain.queryCount).toBe(1);
    expect(plain.statements.join("\n")).not.toMatch(/\bJOIN\b/i);
    const queue = await readWorkQueue(
      ctx.db,
      null,
      workQueueHouseholdInput.parse({
        check: ["email_not_imported"],
        pageSize: 100,
      }),
      false,
    );
    expect(queue.meta.totalCount).toBe(4);
    expect(queue.items).toHaveLength(4);
    expect(queue.items.every((item) => item.entity === "email")).toBe(true);
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
    expect(gaps(unrelated)).toEqual(["email_display_image"]);
    expect(gaps(related)).toEqual([
      "email_display_image",
      "email_not_imported",
      "email_original_missing",
      "email_preview_missing",
      "email_relevance_unreviewed",
    ]);
    expect(gaps(retained)).toEqual([
      "email_display_image",
      "email_not_imported",
      "email_preview_missing",
      "email_relevance_unreviewed",
    ]);
    expect(gaps(linked)).toEqual(["email_display_image"]);

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
