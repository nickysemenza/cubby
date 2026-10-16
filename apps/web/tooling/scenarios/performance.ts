import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import pMap from "p-map";
import type { UserId } from "@cubby/schemas/identifiers";
import { mailResearchRunInput } from "@cubby/schemas/run-fields";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { ledgerParty, orderMail } from "~/server/db/schema";
import { attachProductComponents } from "~/server/domains/product/repo/product-components";
import { writeOutcomeReceipts } from "~/server/domains/purchase-import/service/run-outcome.fixtures";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { createEntity } from "../factories/create";
import { buildKernelContext } from "./context";

const optionsSchema = z.object({
  bundles: z.number().int().min(1).max(1000).default(1000),
});

/** Optional local pack: one household's repeated purchase/research history.
 * Call only through the guarded dev pack runner or an isolated test lease.
 * This never dispatches providers and never copies production records.
 */
export async function seedPerformanceCorpus(
  db: Database,
  userId: UserId,
  options: z.input<typeof optionsSchema> = {},
) {
  const { bundles } = optionsSchema.parse(options);
  const context = buildKernelContext(db, userId);
  const [member] = await getDb(db)
    .select()
    .from(ledgerParty)
    .where(eq(ledgerParty.userId, userId))
    .limit(1);
  if (!member) throw new Error("Seed the synthetic household member first");
  const vendor = await createEntity(context, "vendor", {
    name: "Synthetic performance supplier",
  });
  const vendorId = await resolveOrThrow(db, "vendor", vendor.id);
  const shelf = await createEntity(context, "location", {
    name: "Synthetic performance shelf",
  });
  let completed = 0;
  await pMap(
    Array.from({ length: bundles }, (_, index) => index),
    async (bundle) => {
      const label = `Synthetic performance ${String(bundle + 1).padStart(4, "0")}`;
      const products = [];
      for (const [index, role] of [
        "kit",
        "inner kit",
        "part",
        "priced sibling",
        "sold item",
        "unpriced stock",
      ].entries()) {
        const product = await createEntity(context, "product", {
          name: `${label} ${role}`,
          manufacturer: "Synthetic Works",
          price: index === 3 ? 5 : null,
          expectedQuantity: null,
          model: null,
        });
        products.push({
          ...product,
          entityId: await resolveOrThrow(db, "product", product.id),
        });
      }
      const [kit, inner, part, sibling, sold, unpriced] = products;
      if (!kit || !inner || !part || !sibling || !sold || !unpriced)
        throw new Error("Incomplete performance kit");
      await attachProductComponents(
        db,
        kit.entityId,
        [
          { productId: inner.entityId, quantity: 2 },
          { productId: sibling.entityId, quantity: 1 },
        ],
        context.actorContext,
      );
      await attachProductComponents(
        db,
        inner.entityId,
        [{ productId: part.entityId, quantity: 4 }],
        context.actorContext,
      );
      for (const product of [part, unpriced])
        await createEntity(context, "inventory", {
          productId: product.id,
          locationId: shelf.id,
          amount: { value: 1, unit: "each" },
        });
      const purchase = await createEntity(context, "purchase", {
        vendorId: vendor.id,
        orderId: `SYNTHETIC-PERF-${bundle + 1}`,
        date: "2026-01-15",
        statedTotal: 120,
      });
      // Nested inherited price, signed exits, refunds, and future work all take
      // different ledger branches; the unpriced stocked SKU has no acquisition.
      for (let line = 0; line < 12; line++) {
        await createEntity(context, "expense", {
          name: `${label} line ${line + 1}`,
          purchaseId: purchase.id,
          productId:
            line === 0
              ? kit.id
              : line === 1 || line === 2
                ? sold.id
                : sibling.id,
          productQuantity: line === 2 ? -3 : 1,
          cost: line === 2 ? -10 : 10,
          date: "2026-01-15",
          future: line === 11,
          trade: "other",
          costType: "materials",
        });
      }
      for (let message = 0; message < 8; message++) {
        const bodyText = `${label} invented receipt ${message + 1}. Order SYNTHETIC-PERF-${bundle + 1}. Total 120 USD.`;
        const checksum = createHash("sha256").update(bodyText).digest("hex");
        const [mail] = await getDb(db)
          .insert(orderMail)
          .values({
            ledgerPartyId: member.id,
            vendorId,
            rawChecksum: checksum,
            content: { bodyText, bodyHtml: null, snippet: bodyText },
          })
          .returning();
        if (!mail) throw new Error("Synthetic retained Email was not saved");
        const historical = message < 5;
        const run = historical
          ? await insertWithShortcode(db, "run", {
              purpose: "mail_import",
              trigger: "manual",
              status: "completed",
              ledgerPartyId: member.id,
              actorUserId: userId,
              actorName: member.name,
              actorEmail: "member@example.test",
              actorLedgerPartyShortcode: member.shortcode,
              actorLedgerPartyName: member.name,
              actorLedgerPartyKind: "member",
              input: mailResearchRunInput.parse({
                kind: "mail_research",
                sources: [{ orderMailId: mail.id, checksum }],
              }),
              startedAt: new Date("2026-01-15T12:00:00Z"),
              endedAt: new Date("2026-01-15T12:01:00Z"),
            })
          : null;
        const email = await insertWithShortcode(db, "email", {
          ledgerPartyId: member.id,
          orderMailId: mail.id,
          runId: run?.id ?? null,
          mailboxId: "synthetic-performance-mailbox",
          messageId: `synthetic-performance-${bundle}-${message}`,
          sender: "Synthetic supplier <orders@example.test>",
          subject: `${label} receipt ${message + 1}`,
          receivedAt: new Date("2026-01-15T12:00:00Z"),
          checksum,
          classification: historical ? "related" : "uncertain",
          classificationStage: "rule",
          classificationVersion: "synthetic-performance/v1",
          status: historical ? "completed" : "blocked",
        });
        if (run)
          await writeOutcomeReceipts(db, [
            {
              runId: run.id,
              entityKind: "email",
              entityId: email.id,
              workKey: "synthetic-mail-research",
              targetFingerprint: checksum,
              state: "completed",
              outcome: "completed",
              completedAt: new Date("2026-01-15T12:01:00Z"),
              diff: {},
            },
          ]);
      }
      completed++;
      if (completed % 100 === 0)
        console.log(`[dev-db] Performance history ${completed}/${bundles}`);
    },
    { concurrency: 8, stopOnError: false },
  );
}
