import { scoredEntities } from "@cubby/schemas/data-quality";
import { mailboxClassification } from "@cubby/schemas/mailbox-research";
import {
  purchaseFiltersSchema,
  purchaseReconciliation,
} from "@cubby/schemas/purchase";
import { workQueueHouseholdInput } from "@cubby/schemas/work-queue";
import { sql } from "drizzle-orm";
import { seedPerformanceCorpus } from "tooling/scenarios/performance";
import { seedEmailLinkDecision } from "tooling/shared-assessment-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb } from "~/server/db/helpers";
import {
  entityExternalId,
  expense,
  externalSource,
  financialTransaction,
  financialTransactionAllocation,
  importSourceClaim,
  importSourceOrder,
  orderMailEvent,
  purchase,
} from "~/server/db/schema";
import { syntheticRetainedMail } from "~/server/domains/purchase-import/service/gmail/retained-mail.fixtures";
import { buildPurchaseWhereClause } from "~/server/domains/purchase/repo/purchase";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  readRecordWorkQueue,
  readWorkQueue,
} from "~/server/generic/work-queue/service/work-queue-read";

import { liveQualityRow } from "./registry";
import {
  checksOf,
  entryFor,
  gapCondition,
  qualityFilterContext,
  qualityFilterSource,
  statusSql,
} from "./sql";

// Failure modes: a bulk `filterRead` column drifts from the correlated check it
// replaces (liveness, incurred-only rule, settlement kinds, refund predicate,
// a missing or deleted account, COALESCE defaults), so list filters, sorts and
// Work queue branches disagree with hydrated record quality for the same row.
const rowSchema = z.array(
  z.object({
    id: z.string(),
    checks: z.array(z.boolean()),
    status: z.string(),
  }),
);

describe("bulk quality relations", () => {
  const ctx = withTestDb();

  it("evaluate every check exactly like the correlated record SQL", async () => {
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      kind: "member",
      name: "Synthetic parity member",
      userId: ctx.actor.userId,
    });
    await seedPerformanceCorpus(ctx.db, ctx.actor.userId, { bundles: 10 });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic parity vendor",
    });
    await getDb(ctx.db).insert(externalSource).values({
      slug: "synthetic-parity",
      label: "Synthetic parity statements",
      vendorId: null,
    });
    const card = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Synthetic parity card",
      identity: { kind: "credit_card", issuer: null, network: null },
      ledgerPartyId: member.id,
    });
    const retired = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Synthetic retired card",
      identity: { kind: "credit_card", issuer: null, network: null },
      ledgerPartyId: member.id,
      deletedAt: new Date("2026-01-01T00:00:00Z"),
    });
    // Each Purchase isolates one settlement input the correlated helpers read.
    const cases = [
      {
        label: "refund adjusted",
        lines: [20],
        charges: [
          { kind: "refund", status: "posted", amount: -10, account: card.id },
        ],
      },
      {
        label: "void only",
        lines: [25],
        charges: [
          { kind: "purchase", status: "void", amount: 25, account: card.id },
        ],
      },
      {
        label: "expected outstanding",
        lines: [30],
        charges: [
          {
            kind: "purchase",
            status: "expected",
            amount: 31,
            account: card.id,
          },
        ],
      },
      {
        label: "retired account",
        lines: [15],
        charges: [
          {
            kind: "purchase",
            status: "posted",
            amount: 15,
            account: retired.id,
            reference: true,
          },
        ],
      },
      {
        label: "referenced card",
        lines: [18],
        charges: [
          {
            kind: "purchase",
            status: "posted",
            amount: 18,
            account: card.id,
            reference: true,
          },
        ],
      },
      {
        label: "unreferenced card",
        lines: [18],
        charges: [
          { kind: "purchase", status: "posted", amount: 18, account: card.id },
        ],
      },
      {
        label: "deleted allocation",
        lines: [12],
        charges: [
          {
            kind: "purchase",
            status: "posted",
            amount: 12,
            account: card.id,
            deleted: true,
          },
        ],
      },
      { label: "unpriced future", lines: [null, 8], future: true, charges: [] },
      { label: "lineless", lines: [], charges: [] },
      { label: "unpriced incurred", lines: [null, 5], charges: [] },
      {
        label: "reimbursement",
        lines: [20],
        role: "reimbursement",
        charges: [
          { kind: "purchase", status: "posted", amount: 20, account: card.id },
        ],
      },
    ] as const;
    for (const entry of cases) {
      const order = await insertWithShortcode(ctx.db, "purchase", {
        vendorId: vendor.id,
        date: "2026-02-01",
        statedTotal: 30,
        displayLabel: `Synthetic parity ${entry.label}`,
      });
      for (const [index, cost] of entry.lines.entries())
        await insertWithShortcode(ctx.db, "expense", {
          name: `Synthetic parity ${entry.label} ${index}`,
          purchaseId: order.id,
          cost,
          date: "2026-02-01",
          future: "future" in entry && index === 0,
          trade: "other",
          costType: "materials",
          lineKind: "principal",
          ...("role" in entry ? { economicRole: entry.role } : {}),
        } as typeof expense.$inferInsert);
      for (const charge of entry.charges) {
        const transaction = await insertWithShortcode(
          ctx.db,
          "financialTransaction",
          {
            accountId: charge.account,
            kind: charge.kind,
            status: charge.status,
            amount: charge.amount,
            transactionDate: "2026-02-02",
            postedDate: charge.status === "posted" ? "2026-02-03" : null,
          } as typeof financialTransaction.$inferInsert,
        );
        await getDb(ctx.db)
          .insert(financialTransactionAllocation)
          .values({
            transactionId: transaction.id,
            purchaseId: order.id,
            amount: charge.amount,
            deletedAt:
              "deleted" in charge ? new Date("2026-02-04T00:00:00Z") : null,
          });
        if ("reference" in charge)
          await getDb(ctx.db)
            .insert(entityExternalId)
            .values({
              entityId: transaction.id,
              entityKind: "financialTransaction",
              source: "synthetic-parity",
              kind: "settlement_ref",
              externalId: `synthetic-parity-${transaction.id}`,
            } as typeof entityExternalId.$inferInsert);
      }
    }

    // Itemization variants on orders that require it: listed and linked, a
    // productless line whose category requires a Product, an unresolved line
    // role, and a lump with no item lines.
    const productRequired = await insertWithShortcode(
      ctx.db,
      "spendingCategory",
      {
        name: `Synthetic parity hardware ${crypto.randomUUID()}`,
        productExpectation: "required",
      },
    );
    const itemized = await insertWithShortcode(ctx.db, "product", {
      name: "Synthetic parity widget",
      brandId: await findOrCreateVendor(ctx.db, "Synthetic maker"),
    });
    for (const itemization of [
      "listed",
      "unlinked",
      "unclassified",
      "lump",
    ] as const) {
      const order = await insertWithShortcode(ctx.db, "purchase", {
        vendorId: vendor.id,
        date: "2026-02-01",
        displayLabel: `Synthetic parity ${itemization} itemization`,
        itemizationExpectation: "required",
      });
      const line = (values: Partial<typeof expense.$inferInsert>) =>
        insertWithShortcode(ctx.db, "expense", {
          name: `Synthetic parity ${itemization} line`,
          cost: 4,
          date: "2026-02-01",
          lineKind: "principal",
          costType: "materials",
          future: false,
          purchaseId: order.id,
          ...values,
        });
      if (itemization === "lump") await line({ lineBasis: "allocation" });
      else await line({ productId: itemized.id });
      if (itemization === "unlinked")
        await line({ spendingCategoryId: productRequired.id });
      if (itemization === "unclassified")
        await line({ lineKind: "unclassified" });
    }

    // Both Email link kinds: accepted source evidence and a reviewed link.
    const linkRun = await insertWithShortcode(ctx.db, "run", {
      purpose: "mail_import",
      ledgerPartyId: member.id,
      trigger: "manual",
      status: "completed",
      actorUserId: ctx.actor.userId,
      actorName: member.name,
      actorEmail: "member@example.test",
      actorLedgerPartyShortcode: member.shortcode,
      actorLedgerPartyName: member.name,
      actorLedgerPartyKind: member.kind,
    });
    const linkedEmails: string[] = [];
    for (const kind of ["accepted", "reviewed"] as const) {
      const order = await insertWithShortcode(ctx.db, "purchase", {
        vendorId: vendor.id,
        date: "2026-02-01",
        displayLabel: `Synthetic parity ${kind} order`,
      });
      const checksum = (kind === "accepted" ? "d" : "f").repeat(64);
      const source = await syntheticRetainedMail(ctx.db, {
        ledgerPartyId: member.id,
        mailboxId: "synthetic-parity-mailbox",
        messageId: `synthetic-parity-${kind}`,
        sender: null,
        subject: `Synthetic parity ${kind} receipt`,
        receivedAt: new Date("2026-02-01T12:00:00Z"),
        vendorId: vendor.id,
        rawChecksum: checksum,
        content: {
          snippet: "Synthetic receipt",
          bodyText: null,
          bodyHtml: null,
        },
      });
      const [message] = (
        await getDb(ctx.db)
          .execute(sql`UPDATE "Email" SET classification = ${mailboxClassification.enum.related}
          WHERE "orderMailId" = ${source.id}
          RETURNING id::text AS id, provider, "mailboxId", "messageId"`)
      ).rows as {
        id: string;
        provider: string;
        mailboxId: string;
        messageId: string;
      }[];
      if (!message) throw new Error("Synthetic parity Email missing");
      linkedEmails.push(message.id);
      if (kind === "accepted") {
        const [claim] = await getDb(ctx.db)
          .insert(importSourceClaim)
          .values({
            ledgerPartyId: member.id,
            kind: "mail_message",
            externalKey: `${message.provider}:${message.mailboxId}:${message.messageId}`,
            checksum,
            firstRunId: linkRun.id,
            lastRunId: linkRun.id,
          })
          .returning();
        if (!claim) throw new Error("Synthetic parity claim missing");
        await getDb(ctx.db).insert(importSourceOrder).values({
          sourceClaimId: claim.id,
          orderKey: "synthetic-parity/order/accepted",
          purchaseId: order.id,
          checksum,
          outputFingerprint: "synthetic-parity-accepted",
        });
      } else {
        const [event] = await getDb(ctx.db)
          .insert(orderMailEvent)
          .values({
            orderMailId: source.id,
            event: "placed",
            orderId: "SYNTHETIC-PARITY-REVIEWED",
            sourceKey: "synthetic-parity-reviewed",
          })
          .returning();
        if (!event) throw new Error("Synthetic parity event missing");
        await seedEmailLinkDecision(ctx.db, {
          eventId: event.id,
          purchaseId: order.id,
          decision: "linked",
          evidenceChecksum: checksum,
          decidedByUserId: ctx.actor.userId,
          proposedBy: "member",
        });
      }
    }
    const linked = await getDb(ctx.db)
      .execute(sql`SELECT "Email".id::text AS id, dq_filter.linked
      FROM ${qualityFilterSource("email")}
      WHERE "Email".id::text IN (${sql.join(
        linkedEmails.map((id) => sql`${id}`),
        sql`, `,
      )}) ORDER BY 1`);
    expect(linked.rows.map((row) => row.linked)).toEqual([true, true]);

    const bulkEntities = scoredEntities.filter(
      (entity) => entryFor(entity).filterRead,
    );
    expect(bulkEntities).toEqual(expect.arrayContaining(["email", "purchase"]));
    const results = new Map<string, z.infer<typeof rowSchema>>();
    for (const entity of bulkEntities) {
      const { table } = entryFor(entity);
      const read = async (bulk: boolean) => {
        const context = bulk ? qualityFilterContext(entity) : undefined;
        const result = await getDb(ctx.db)
          .execute(sql`SELECT ${table.id}::text AS id,
          jsonb_build_array(${sql.join(
            checksOf(entity).map(
              (check) =>
                sql`${gapCondition(entity, check, undefined, context)} IS TRUE`,
            ),
            sql`, `,
          )}) AS checks,
          ${statusSql(entity, undefined, context)} AS status
          FROM ${bulk ? qualityFilterSource(entity) : table}
          WHERE ${liveQualityRow(table)}
          ORDER BY 1`);
        return rowSchema.parse(result.rows);
      };
      const canonical = await read(false);
      expect({ entity, rows: await read(true) }).toEqual({
        entity,
        rows: canonical,
      });
      results.set(entity, canonical);
    }

    // The fixture exercises each Purchase bulk-read check both ways.
    const purchases = results.get("purchase") ?? [];
    const coverage = Object.fromEntries(
      (
        [
          "empty_expenses",
          "unpriced_expense",
          "paperwork_mismatch",
          "settlement_reference",
          "settlement_mismatch",
          "purchase_itemization",
        ] as const
      ).map((check) => {
        const index = checksOf("purchase").indexOf(check);
        return [
          check,
          [...new Set(purchases.map((row) => row.checks[index]))].sort(),
        ];
      }),
    );
    expect(Object.values(coverage)).toEqual(
      Object.values(coverage).map(() => [false, true]),
    );

    // Read-aware derived filters (Purchase reconciliation verdicts) match too.
    const derivedFilters = [
      ...purchaseReconciliation.options.map((value) => ({
        reconciliation: [value],
      })),
      { financialReconciliation: ["mismatch"] },
    ];
    for (const raw of derivedFilters) {
      const filters = purchaseFiltersSchema.parse(raw);
      expect(filters).toMatchObject(raw);
      const ids = async (bulk: boolean) =>
        (
          await getDb(ctx.db).execute(sql`SELECT ${purchase.id}::text AS id
            FROM ${bulk ? qualityFilterSource("purchase") : purchase}
            WHERE ${buildPurchaseWhereClause(filters, bulk ? qualityFilterContext("purchase") : undefined) ?? sql`true`}
            ORDER BY 1`)
        ).rows;
      const canonical = await ids(false);
      expect({ raw, matched: canonical.length > 0 }).toEqual({
        raw,
        matched: true,
      });
      expect({ raw, rows: await ids(true) }).toEqual({ raw, rows: canonical });
    }

    // A record-scoped read keeps record-level predicates and returns exactly
    // the household rows for that record.
    const records = await getDb(ctx.db)
      .execute(sql`SELECT shortcode FROM "Purchase"
      WHERE "deletedAt" IS NULL ORDER BY shortcode LIMIT 6`);
    for (const { shortcode } of records.rows as { shortcode: string }[]) {
      const household = await readWorkQueue(
        ctx.db,
        null,
        workQueueHouseholdInput.parse({ pageSize: 100, query: shortcode }),
        false,
      );
      const scoped = await readRecordWorkQueue(ctx.db, null, shortcode, false);
      expect({
        shortcode,
        keys: scoped.items.map((item) => item.key).sort(),
      }).toEqual({
        shortcode,
        keys: household.items
          .filter((item) => item.id === shortcode)
          .map((item) => item.key)
          .sort(),
      });
    }
  }, 120_000);
});
