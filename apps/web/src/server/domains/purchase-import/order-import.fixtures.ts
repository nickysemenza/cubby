import type { ActorContext } from "@cubby/schemas/context";
import type { ExpenseLineKind } from "@cubby/schemas/expense-line-kind";
import { parseEntityId, vendorAccountId } from "@cubby/schemas/identifiers";
import {
  commitPurchaseImportInput,
  importExtractionOutcome,
  type PreparePurchaseImportInput,
  type preparedProductResolution,
} from "@cubby/schemas/purchase-import";
import type { Trade } from "@cubby/schemas/task-fields";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, notDeleted, withTransaction } from "~/server/db/helpers";
import {
  expense,
  orderMail,
  product,
  purchase,
  sourceOrderObservation,
  type vendor,
} from "~/server/db/schema";
import {
  readRetainedMail,
  type RetainedMail,
} from "~/server/domains/mail/repo/retained-mail";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { commitPurchaseImport, preparePurchaseImport } from "./import-orders";
import { startImportRunFixture } from "./import-run.fixtures";
import { recordSourceOrderObservation } from "./reconciliation-observations";

/**
 * The live member LedgerParty bound to `actor.userId` that a member's import
 * runs as, and the Vendor its orders name. Vendor fields are passed through
 * because merchant-name, sender and domain matching read them.
 */
export async function memberImportWorld(
  db: Database,
  actor: ActorContext,
  input: {
    memberName?: string;
    vendor?: Partial<Omit<typeof vendor.$inferInsert, "shortcode">>;
  } = {},
) {
  const party = await insertWithShortcode(db, "ledgerParty", {
    name: input.memberName ?? "Synthetic import member",
    kind: "member",
    userId: actor.userId,
  });
  const seller = await insertWithShortcode(db, "vendor", {
    name: "Synthetic service merchant",
    ...input.vendor,
  });
  return { party, vendor: seller };
}

type HistoryLine = {
  title: string;
  amount: number;
  lineKind?: ExpenseLineKind;
};

/**
 * Drives one order-history capture through the real prepare/commit boundary
 * the browser agent uses. Each principal line resolves to a fresh Product so
 * the commit neither waits on review nor depends on product matching.
 */
export async function importOrderHistory(
  db: Database,
  actor: ActorContext,
  input: {
    ledgerPartyId: string;
    vendorAccountId: string;
    orderId: string;
    orderedAt: string;
    lines: readonly HistoryLine[];
    /** One hex digit; a new digit is a source refresh of the same order. */
    revision: string;
  },
) {
  const run = await startImportRunFixture(db, {
    ledgerPartyId: parseEntityId("ledgerParty", input.ledgerPartyId),
    vendorAccountId: vendorAccountId.parse(input.vendorAccountId),
    trigger: "manual",
  });
  const stableOrderId = `${input.orderId}-${input.revision}`.toLowerCase();
  const lineIds = input.lines.map(
    (_, index) => `${stableOrderId}:line-${index + 1}`,
  );
  const prepareOperationId = `prepare:${stableOrderId}`;
  await preparePurchaseImport(
    db,
    {
      _runExecution: {
        runId: run.id,
        operationId: prepareOperationId,
        itemOperationIds: [`item:${stableOrderId}`],
      },
      orders: [
        {
          stableOrderId,
          itemOperationId: `item:${stableOrderId}`,
          source: {
            kind: "vendor_export",
            externalKey: `history:order:${input.orderId}`,
            checksum: input.revision.repeat(64),
          },
          evidenceChecksum: input.revision.repeat(64),
          extractionRevision: "history@fixture-1",
          extraction: {
            status: "ready",
            candidate: {
              orderId: input.orderId,
              orderedAt: input.orderedAt,
              merchant: "ForgeWear",
              currency: "USD",
              printedGrandTotal:
                input.lines.reduce(
                  (total, line) => total + Math.round(line.amount * 100),
                  0,
                ) / 100,
              lines: input.lines.map((line) => ({
                title: line.title,
                amount: line.amount,
                lineKind: line.lineKind ?? "principal",
              })),
              payments: [],
              allShipmentsDelivered: false,
            },
          },
          lineIds,
          primaryDocumentImageId: null,
          screenshotImageId: null,
        },
      ],
    },
    actor,
  );
  const resolutions = [];
  for (const [index, line] of input.lines.entries()) {
    if ((line.lineKind ?? "principal") !== "principal") continue;
    const created = await createProductFixture(
      db,
      makeProductInput({ name: `${line.title} ${stableOrderId}` }),
      actor,
    );
    const [row] = await getDb(db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, created.entityId));
    if (!row) throw new Error("test setup: product fixture not created");
    resolutions.push({
      stableOrderId,
      stableLineId: lineIds[index],
      resolution: { kind: "existing", productId: row.shortcode },
    });
  }
  const result = await commitPurchaseImport(
    db,
    commitPurchaseImportInput.parse({
      _runExecution: { runId: run.id, operationId: `commit:${stableOrderId}` },
      prepareOperationId,
      defaultTrade: "other",
      resolutions,
    }),
    actor,
  );
  return result.items[0];
}

/** Live Expense costs on a Purchase, in cents, sorted — the SUM(Expense.cost) view. */
export async function liveExpenseCents(db: Database, purchaseId: string) {
  const rows = await getDb(db)
    .select({ cost: expense.cost })
    .from(expense)
    .where(
      and(
        eq(expense.purchaseId, parseEntityId("purchase", purchaseId)),
        notDeleted(expense),
      ),
    );
  return rows
    .map((row) => Math.round((row.cost ?? 0) * 100))
    .sort((a, b) => a - b);
}

export async function purchasesForOrder(db: Database, orderId: string) {
  return getDb(db)
    .select({ id: purchase.id, shortcode: purchase.shortcode })
    .from(purchase)
    .where(and(eq(purchase.orderId, orderId), notDeleted(purchase)));
}

/** A member's retained, related Email awaiting import. */
export async function retainedMailFixture(
  db: Database,
  input: Pick<RetainedMail, "ledgerPartyId" | "messageId"> & {
    checksum: string;
    bodyText?: string;
    mailboxId?: string;
    vendorId?: RetainedMail["vendorId"];
    content?: RetainedMail["content"];
    sender?: RetainedMail["sender"];
    subject?: RetainedMail["subject"];
    receivedAt?: RetainedMail["receivedAt"];
    threadId?: RetainedMail["threadId"];
    historyId?: RetainedMail["historyId"];
    classificationVersion?: string;
  },
) {
  const [mail] = await getDb(db)
    .insert(orderMail)
    .values({
      ledgerPartyId: input.ledgerPartyId,
      vendorId: input.vendorId,
      rawChecksum: input.checksum,
      content: input.content ?? {
        snippet: null,
        bodyText: input.bodyText ?? `Synthetic ${input.messageId}`,
        bodyHtml: null,
      },
    })
    .returning();
  if (!mail) throw new Error("Synthetic mail fixture did not persist");
  await insertWithShortcode(db, "email", {
    ledgerPartyId: input.ledgerPartyId,
    mailboxId: input.mailboxId ?? "synthetic-mailbox",
    messageId: input.messageId,
    sender: input.sender === undefined ? "orders@shop.example" : input.sender,
    subject:
      input.subject === undefined
        ? `Synthetic ${input.messageId}`
        : input.subject,
    receivedAt:
      input.receivedAt === undefined
        ? new Date("2026-09-20T18:00:00Z")
        : input.receivedAt,
    threadId: input.threadId,
    historyId: input.historyId,
    checksum: mail.rawChecksum,
    classification: "related",
    classificationVersion: input.classificationVersion ?? "synthetic-v1",
    status: "pending",
    orderMailId: mail.id,
  });
  const [retained] = await readRetainedMail(db, {
    ledgerPartyIds: [input.ledgerPartyId],
    orderMailIds: [mail.id],
  });
  if (!retained) throw new Error("Synthetic retained Email did not persist");
  return retained;
}

/** A real immutable capture for an already imported Purchase in integrity fixtures. */
export async function sourceOrderObservationFixture(
  db: Database,
  input: Pick<
    typeof sourceOrderObservation.$inferInsert,
    "sourceClaimId" | "orderKey" | "purchaseId" | "vendorId"
  > &
    Partial<
      Pick<
        typeof sourceOrderObservation.$inferInsert,
        "runId" | "primaryDocumentImageId" | "screenshotImageId"
      >
    >,
) {
  return withTransaction(db, (tx) =>
    recordSourceOrderObservation(
      tx,
      {
        sourceClaimId: input.sourceClaimId,
        orderKey: input.orderKey,
        purchaseId: input.purchaseId,
      },
      {
        vendorId: input.vendorId,
        runId: input.runId ?? null,
        source: {
          kind: "vendor_export",
          externalKey: "synthetic:integrity-observation",
          checksum: "a".repeat(64),
        },
        extraction: importExtractionOutcome.parse({
          status: "ready",
          candidate: {
            orderId: input.orderKey,
            orderedAt: "2026-09-01T18:00:00Z",
            merchant: "Synthetic integrity vendor",
            currency: "USD",
            printedGrandTotal: null,
            lines: [],
            payments: [],
            allShipmentsDelivered: false,
          },
        }),
        primaryDocumentImageId: input.primaryDocumentImageId ?? null,
        screenshotImageId: input.screenshotImageId ?? null,
      },
    ),
  );
}

export const mailSource = (mail: RetainedMail) => ({
  kind: "mail_message" as const,
  externalKey: `gmail:${mail.mailboxId}:${mail.messageId}`,
  checksum: mail.rawChecksum,
});

type PreparedOrder = PreparePurchaseImportInput["orders"][number];

/**
 * One order of a member import. Each principal line defaults to
 * `expense_only`; `resolutions[i]` overrides line i.
 */
export type MemberImportOrder = Pick<
  PreparedOrder,
  "stableOrderId" | "vendorId" | "vendor" | "targetPurchaseId" | "source"
> &
  Partial<Pick<PreparedOrder, "primaryDocumentImageId">> & {
    extraction: PreparedOrder["extraction"];
    resolutions?: ReadonlyArray<
      z.infer<typeof preparedProductResolution> | undefined
    >;
  };

/**
 * A member's own `purchase_import.prepare` (which opens its file_import Run)
 * and the matching commit input; `commit()` runs that commit.
 */
export async function prepareMemberImport(
  db: Database,
  actor: ActorContext,
  input: {
    key: string;
    orders: readonly MemberImportOrder[];
    defaultTrade?: Trade;
  },
) {
  const lineIds = (order: MemberImportOrder) =>
    (order.extraction.candidate?.lines ?? []).map(
      (_, index) => `${order.stableOrderId}:line-${index + 1}`,
    );
  const prepareOperationId = `prepare:${input.key}`;
  const prepared = await preparePurchaseImport(
    db,
    {
      _runExecution: { operationId: prepareOperationId },
      orders: input.orders.map((order) => ({
        stableOrderId: order.stableOrderId,
        itemOperationId: `item:${order.stableOrderId}`,
        vendorId: order.vendorId,
        vendor: order.vendor,
        targetPurchaseId: order.targetPurchaseId,
        source: order.source,
        evidenceChecksum: order.source.checksum,
        extractionRevision: "synthetic@1",
        extraction: order.extraction,
        lineIds: lineIds(order),
        primaryDocumentImageId: order.primaryDocumentImageId ?? null,
        screenshotImageId: null,
      })),
    },
    actor,
  );
  const commitInput = commitPurchaseImportInput.parse({
    _runExecution: { run: prepared.runId, operationId: `commit:${input.key}` },
    prepareOperationId,
    defaultTrade: input.defaultTrade,
    resolutions: input.orders.flatMap((order) =>
      (order.extraction.candidate?.lines ?? []).flatMap((line, index) => {
        const resolution =
          order.resolutions?.[index] ??
          (line.lineKind === "principal"
            ? { kind: "expense_only" as const }
            : undefined);
        return resolution
          ? [
              {
                stableOrderId: order.stableOrderId,
                stableLineId: lineIds(order)[index],
                resolution,
              },
            ]
          : [];
      }),
    ),
  });
  return {
    prepared,
    commitInput,
    commit: () => commitPurchaseImport(db, commitInput, actor),
  };
}

/** Seed a live member LedgerParty with actor.userId before this real member prepare/commit boundary. */
export async function memberImport(
  db: Database,
  actor: ActorContext,
  input: Parameters<typeof prepareMemberImport>[2],
) {
  const preparation = await prepareMemberImport(db, actor, input);
  return { ...preparation, committed: await preparation.commit() };
}
