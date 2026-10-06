import type { ActorContext } from "@cubby/schemas/context";
import {
  runEntityId,
  type LedgerPartyId,
  type VendorId,
} from "@cubby/schemas/identifiers";
import {
  coordinatorModelFor,
  importRunAgentIdentity,
} from "@cubby/schemas/import-run-agent";
import {
  orderMailImportInput,
  orderMailImportOut,
  orderMailImportSelectedInput,
  type OrderMailImportInput,
  type OrderMailImportSelectedInput,
} from "@cubby/schemas/order-mail-review";
import {
  orderMailImportRunInput,
  orderMailImportRunOrders,
} from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { householdLocalDate } from "~/lib/household-date";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  importSourceClaim,
  ledgerParty,
  orderMail,
  orderMailEvent,
  purchase,
  run as runTable,
  runOrderCandidate,
  user,
  vendor,
} from "~/server/db/schema";
import type { PurchaseAgentQueueProducer } from "~/server/purchase-agent-queue-types";
import {
  databaseForTransaction,
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { dispatchRunEvent } from "../dispatch";

/**
 * Lock one saved message and require it to be an active, itemizable order
 * confirmation owned by this member. Shipping events never confer authority
 * to import a placement's itemization.
 */
async function lockPlacementEvent(
  tx: DrizzleTransaction,
  actor: ActorContext,
  input: OrderMailImportInput,
) {
  const [row] = await tx
    .select({
      mail: orderMail,
      event: orderMailEvent,
      actorName: user.name,
      actorEmail: user.email,
      partyShortcode: ledgerParty.shortcode,
      partyName: ledgerParty.name,
      partyKind: ledgerParty.kind,
    })
    .from(orderMailEvent)
    .innerJoin(orderMail, eq(orderMail.id, orderMailEvent.orderMailId))
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, orderMail.ledgerPartyId),
        eq(ledgerParty.userId, actor.userId),
        notDeleted(ledgerParty),
      ),
    )
    .innerJoin(user, eq(user.id, ledgerParty.userId))
    .where(eq(orderMailEvent.id, input.eventId))
    .limit(1)
    .for("update", { of: orderMail });
  if (!row) throw new Error("Order email was not found for this member.");
  if (
    row.event.event !== "placed" ||
    row.event.supersededAt ||
    !row.event.orderId
  )
    throw new Error(
      "Import requires an active order confirmation with an explicit order id.",
    );
  if (row.mail.rawChecksum !== input.evidenceChecksum)
    throw new Error("Order email evidence changed; refresh before importing.");
  if (!row.mail.vendorId)
    throw new Error("Classify the email vendor before importing.");
  if (!row.mail.content.bodyText && !row.mail.content.bodyHtml)
    throw new Error("Order confirmation has no saved body to extract.");
  return { ...row, orderId: row.event.orderId, vendorId: row.mail.vendorId };
}

type PlacementRow = Awaited<ReturnType<typeof lockPlacementEvent>>;

/**
 * The run that already owns each of these confirmations. A finished run
 * (completed or failed) and one a restart superseded no longer block a new
 * import; every other status, including needs_review, keeps its orders so the
 * same evidence never gets a second run.
 */
export async function ownersOf(
  tx: DrizzleTransaction,
  scope: { ledgerPartyId: LedgerPartyId; vendorId: VendorId },
  eventIds: readonly string[],
) {
  const owners = new Map<string, string>();
  const runs = await tx
    .select({
      id: runTable.id,
      shortcode: runTable.shortcode,
      status: runTable.status,
      input: runTable.input,
    })
    .from(runTable)
    .where(
      and(
        eq(runTable.ledgerPartyId, scope.ledgerPartyId),
        eq(runTable.vendorId, scope.vendorId),
        sql`${runTable.input}->>'kind' = 'order_mail_import'`,
        sql`${runTable.status} NOT IN ('completed', 'failed')`,
      ),
    );
  if (runs.length === 0) return owners;
  const restarted = new Set(
    (
      await tx
        .select({ predecessor: runTable.predecessorRunId })
        .from(runTable)
        .where(
          inArray(
            runTable.predecessorRunId,
            runs.map((run) => run.id),
          ),
        )
    ).map((successor) => successor.predecessor),
  );
  const wanted = new Set(eventIds);
  for (const run of runs) {
    if (restarted.has(run.id)) continue;
    const parsed = orderMailImportRunInput.safeParse(run.input);
    if (!parsed.success) continue;
    for (const order of orderMailImportRunOrders(parsed.data))
      if (wanted.has(order.eventId) && !owners.has(order.eventId))
        owners.set(order.eventId, `${run.shortcode} (${run.status})`);
  }
  return owners;
}

async function dispatchAdmitted(
  db: Database,
  queue: PurchaseAgentQueueProducer,
  admitted: { run: typeof runTable.$inferSelect; dispatch: boolean },
) {
  if (admitted.dispatch) {
    if (!admitted.run.dispatchEventId)
      throw new Error("Order email import has no dispatch generation.");
    await dispatchRunEvent(db, queue, {
      version: 1,
      runId: admitted.run.id,
      eventId: admitted.run.dispatchEventId,
      type: "start_or_resume",
    });
  }
  return orderMailImportOut.parse({ runId: admitted.run.shortcode });
}

const needsDispatch = (run: typeof runTable.$inferSelect) =>
  run.status === "dispatch_failed" ||
  (run.status === "running" && run.dispatchAttempts === 0);

type ImportTrigger = "manual" | "discovery";

function runIdentity(
  row: PlacementRow,
  actor: ActorContext,
  trigger: ImportTrigger,
) {
  return {
    ledgerPartyId: row.mail.ledgerPartyId,
    vendorId: row.vendorId,
    vendorAccountId: null,
    purpose: "account_sync" as const,
    trigger,
    actorUserId: actor.userId,
    actorName: row.actorName,
    actorEmail: row.actorEmail,
    actorLedgerPartyShortcode: row.partyShortcode,
    actorLedgerPartyName: row.partyName,
    actorLedgerPartyKind: row.partyKind,
    coordinatorModel: coordinatorModelFor("account_sync"),
    dispatchEventId: crypto.randomUUID(),
  };
}

export async function startOrderMailImport(
  db: Database,
  rawInput: OrderMailImportInput,
  actor: ActorContext,
  queue: PurchaseAgentQueueProducer,
  /** `discovery` when a scheduled Gmail pass started it without a click. */
  trigger: ImportTrigger = "manual",
) {
  const input = orderMailImportInput.parse(rawInput);
  const admitted = await withTransaction(db, async (tx) => {
    // Lock the saved message so concurrent clicks reuse one source/run.
    const row = await lockPlacementEvent(tx, actor, input);
    const [existing] = await tx
      .select()
      .from(runTable)
      .where(
        and(
          eq(runTable.ledgerPartyId, row.mail.ledgerPartyId),
          eq(runTable.vendorId, row.vendorId),
          sql`${runTable.input}->>'kind' = 'order_mail_import'`,
          sql`${runTable.input}->>'eventId' = ${input.eventId}`,
          sql`${runTable.input}->>'evidenceChecksum' = ${input.evidenceChecksum}`,
        ),
      )
      .orderBy(desc(runTable.startedAt))
      .limit(1);
    if (existing) return { run: existing, dispatch: needsDispatch(existing) };
    // A selected-orders run may already own this confirmation.
    const owner = (
      await ownersOf(
        tx,
        { ledgerPartyId: row.mail.ledgerPartyId, vendorId: row.vendorId },
        [input.eventId],
      )
    ).get(input.eventId);
    if (owner)
      throw new Error(
        `Order ${row.orderId} is already on run ${owner}; use that run.`,
      );
    const id = runEntityId.parse(crypto.randomUUID());
    const run = await insertWithShortcode(tx, "run", {
      ...runIdentity(row, actor, trigger),
      id,
      agentSessionId: importRunAgentIdentity(id, "account_sync"),
      clientKey: `order-mail:${input.eventId}:${input.evidenceChecksum}`,
      input: orderMailImportRunInput.parse({
        kind: "order_mail_import",
        ...input,
        orderId: row.orderId,
      }),
    });
    return { run, dispatch: true };
  });
  return dispatchAdmitted(db, queue, admitted);
}

/**
 * One run over several selected order confirmations of one member and Vendor.
 * Each order is a `RunOrderCandidate`, so its terminal outcome (imported, or
 * skipped after `defer_order_for_review`) is recorded and finishing waits for
 * every pending one. A confirmation already imported or already on a live run
 * refuses the whole selection with the reason.
 */
export async function startSelectedOrderMailImport(
  db: Database,
  rawInput: OrderMailImportSelectedInput,
  actor: ActorContext,
  queue: PurchaseAgentQueueProducer,
) {
  const { orders } = orderMailImportSelectedInput.parse(rawInput);
  if (new Set(orders.map((order) => order.eventId)).size !== orders.length)
    throw new Error("An order email was selected more than once.");
  const admitted = await withTransaction(db, async (tx) => {
    // Lock in a fixed order so overlapping selections cannot deadlock.
    const rows: PlacementRow[] = [];
    for (const order of [...orders].sort((a, b) =>
      a.eventId.localeCompare(b.eventId),
    ))
      rows.push(await lockPlacementEvent(tx, actor, order));
    const [head] = rows;
    if (!head) throw new Error("Select at least one order email.");
    if (
      rows.some(
        (row) =>
          row.mail.ledgerPartyId !== head.mail.ledgerPartyId ||
          row.vendorId !== head.vendorId,
      )
    )
      throw new Error(
        "Selected order emails must belong to the same Vendor and member.",
      );
    if (new Set(rows.map((row) => row.orderId)).size !== rows.length)
      throw new Error("An order was selected more than once.");
    // Claim order: oldest confirmation first.
    const dated = rows
      .map((row) => ({
        row,
        at: row.event.occurredAt ?? row.mail.receivedAt,
      }))
      .sort(
        (a, b) =>
          a.at.getTime() - b.at.getTime() ||
          a.row.orderId.localeCompare(b.row.orderId),
      );
    const clientKey = `order-mails:${await sha256Hex(
      dated
        .map(({ row }) => `${row.event.id}:${row.mail.rawChecksum}`)
        .join("|"),
    )}`;
    const [existing] = await tx
      .select()
      .from(runTable)
      .where(eq(runTable.clientKey, clientKey))
      .limit(1);
    if (existing) return { run: existing, dispatch: needsDispatch(existing) };
    const txDatabase = databaseForTransaction(tx);
    for (const { row } of dated) {
      const imported = await orderMailImportedPurchase(txDatabase, {
        mail: row.mail,
        source: {
          kind: "mail_message",
          externalKey: `gmail:${row.mail.messageId}:order:${row.orderId}`,
          checksum: row.mail.rawChecksum,
        },
      });
      if (imported)
        throw new Error(
          `Order ${row.orderId} is already imported as ${imported}.`,
        );
    }
    const owners = await ownersOf(
      tx,
      { ledgerPartyId: head.mail.ledgerPartyId, vendorId: head.vendorId },
      rows.map((row) => row.event.id),
    );
    for (const { row } of dated) {
      const owner = owners.get(row.event.id);
      if (owner)
        throw new Error(
          `Order ${row.orderId} is already on run ${owner}; use that run.`,
        );
    }
    const id = runEntityId.parse(crypto.randomUUID());
    const run = await insertWithShortcode(tx, "run", {
      ...runIdentity(head, actor, "manual"),
      id,
      agentSessionId: importRunAgentIdentity(id, "account_sync"),
      clientKey,
      input: orderMailImportRunInput.parse({
        kind: "order_mail_import",
        orders: dated.map(({ row }) => ({
          eventId: row.event.id,
          evidenceChecksum: row.mail.rawChecksum,
          orderId: row.orderId,
        })),
      }),
    });
    await tx.insert(runOrderCandidate).values(
      dated.map(({ row, at }) => ({
        runId: id,
        orderId: row.orderId,
        orderUrl: null,
        orderedAt: householdLocalDate(at),
        state: "pending" as const,
      })),
    );
    return { run, dispatch: true };
  });
  return dispatchAdmitted(db, queue, admitted);
}

/**
 * The confirmation a mail import run is working now. A single-form run has
 * exactly one. A selected-orders run works its first pending candidate in
 * input order, so preparation stays restricted to that one order until it is
 * imported or deferred. With nothing pending this throws, unless the caller
 * accepts a finished worklist (`allowComplete`) and gets null.
 */
export async function loadOrderMailImportEvidence(
  db: Database,
  runId: string,
  options: { allowComplete?: boolean } = {},
) {
  const [run] = await getDb(db)
    .select()
    .from(runTable)
    .where(eq(runTable.id, runEntityId.parse(runId)))
    .limit(1);
  if (
    !run ||
    !run.input ||
    !("kind" in run.input) ||
    run.input.kind !== "order_mail_import"
  )
    return null;
  const parsed = orderMailImportRunInput.parse(run.input);
  const selected = "orders" in parsed;
  const assigned = orderMailImportRunOrders(parsed);
  let input = assigned[0];
  if (selected) {
    const pending = new Set(
      (
        await getDb(db)
          .select({ orderId: runOrderCandidate.orderId })
          .from(runOrderCandidate)
          .where(
            and(
              eq(runOrderCandidate.runId, run.id),
              eq(runOrderCandidate.state, "pending"),
            ),
          )
      ).map((candidate) => candidate.orderId),
    );
    input = assigned.find((order) => pending.has(order.orderId));
    if (!input) {
      if (options.allowComplete) return null;
      throw new Error(
        "Every selected order confirmation on this run is already imported or deferred.",
      );
    }
  }
  if (!input) throw new Error("Order email import has no assigned order.");
  if (!run.ledgerPartyId || !run.vendorId || !run.actorUserId)
    throw new Error("Order email import ownership is unavailable.");
  const [row] = await getDb(db)
    .select({ mail: orderMail, event: orderMailEvent })
    .from(orderMailEvent)
    .innerJoin(
      orderMail,
      and(
        eq(orderMail.id, orderMailEvent.orderMailId),
        eq(orderMail.ledgerPartyId, run.ledgerPartyId),
        eq(orderMail.vendorId, run.vendorId),
      ),
    )
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, orderMail.ledgerPartyId),
        eq(ledgerParty.userId, run.actorUserId),
        notDeleted(ledgerParty),
      ),
    )
    .where(
      and(
        eq(orderMailEvent.id, input.eventId),
        isNull(orderMailEvent.supersededAt),
      ),
    )
    .limit(1)
    .for("share", { of: orderMail });
  if (
    !row ||
    row.mail.rawChecksum !== input.evidenceChecksum ||
    row.event.event !== "placed" ||
    row.event.orderId !== input.orderId
  )
    throw new Error(
      "Assigned order confirmation evidence changed or is no longer available to this member.",
    );
  const [owner] = await getDb(db)
    .select({ website: vendor.website, browserDomains: vendor.browserDomains })
    .from(vendor)
    .where(eq(vendor.id, run.vendorId))
    .limit(1);
  return {
    eventId: input.eventId,
    orderId: input.orderId,
    evidenceChecksum: input.evidenceChecksum,
    /** Where this Vendor's own product pages live. */
    productHosts: vendorHosts(owner),
    selected,
    source: {
      kind: "mail_message" as const,
      externalKey: `gmail:${row.mail.messageId}:order:${input.orderId}`,
      checksum: input.evidenceChecksum,
    },
    mail: row.mail,
  };
}

export async function orderMailImportedPurchase(
  db: Database,
  evidence: {
    mail: { ledgerPartyId: LedgerPartyId };
    source: { kind: "mail_message"; externalKey: string; checksum: string };
  },
) {
  const [claim] = await getDb(db)
    .select({ purchaseId: purchase.shortcode })
    .from(importSourceClaim)
    .innerJoin(
      purchase,
      and(eq(purchase.id, importSourceClaim.purchaseId), notDeleted(purchase)),
    )
    .where(
      and(
        eq(importSourceClaim.ledgerPartyId, evidence.mail.ledgerPartyId),
        eq(importSourceClaim.kind, evidence.source.kind),
        eq(importSourceClaim.externalKey, evidence.source.externalKey),
        eq(importSourceClaim.checksum, evidence.source.checksum),
      ),
    )
    .limit(1);
  return claim?.purchaseId ?? null;
}

/** Record that a selected-orders run's candidate for this order is imported. */
export async function markOrderMailCandidateImported(
  db: Database,
  runId: string,
  orderId: string,
) {
  await getDb(db)
    .update(runOrderCandidate)
    .set({ state: "imported", updatedAt: new Date() })
    .where(
      and(
        eq(runOrderCandidate.runId, runEntityId.parse(runId)),
        eq(runOrderCandidate.orderId, orderId),
        eq(runOrderCandidate.state, "pending"),
      ),
    );
}

function vendorHosts(
  owner: { website: string | null; browserDomains: string[] } | undefined,
) {
  const hosts = new Set(owner?.browserDomains ?? []);
  if (owner?.website) {
    try {
      hosts.add(new URL(owner.website).hostname);
    } catch {
      // SILENT: a malformed website adds no host; browser domains still apply.
    }
  }
  return [...hosts];
}
