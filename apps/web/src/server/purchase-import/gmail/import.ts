import type { ActorContext } from "@cubby/schemas/context";
import { runEntityId } from "@cubby/schemas/identifiers";
import {
  orderMailImportInput,
  orderMailImportOut,
  orderMailImportSelectedInput,
  type OrderMailImportInput,
  type OrderMailImportSelectedInput,
} from "@cubby/schemas/order-mail-review";
import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  ledgerParty,
  orderMail,
  orderMailEvent,
  run,
} from "~/server/db/schema";
import type { PurchaseAgentQueueProducer } from "~/server/purchase-agent-queue-types";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

import { startMailResearch } from "../research-run";

type ResearchPorts = { research?: typeof startMailResearch };

/** Selection authorizes original sources, rather than a inferred order or Vendor. */
async function startSelectedSources(
  db: Database,
  orders: readonly OrderMailImportInput[],
  actor: ActorContext,
  queue: PurchaseAgentQueueProducer,
  ports: ResearchPorts,
) {
  if (new Set(orders.map((source) => source.eventId)).size !== orders.length)
    throw new Error("An order email was selected more than once.");
  const rows = await getDb(db)
    .select({
      eventId: orderMailEvent.id,
      supersededAt: orderMailEvent.supersededAt,
      mail: orderMail,
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
    .where(
      inArray(
        orderMailEvent.id,
        orders.map((source) => source.eventId),
      ),
    );
  if (rows.length !== orders.length)
    throw new Error("Order email was not found for this member.");
  for (const source of orders) {
    const row = rows.find((candidate) => candidate.eventId === source.eventId);
    if (
      !row ||
      row.supersededAt ||
      row.mail.rawChecksum !== source.evidenceChecksum
    )
      throw new Error(
        "Order email evidence changed; refresh before researching.",
      );
  }
  const [head] = rows;
  if (!head) throw new Error("Select at least one order email.");
  if (rows.some((row) => row.mail.ledgerPartyId !== head.mail.ledgerPartyId))
    throw new Error("Select email from one member.");
  const research = ports.research ?? startMailResearch;
  const results = await research(
    db,
    {
      ledgerPartyId: head.mail.ledgerPartyId,
      userId: actor.userId,
      messageIds: [...new Set(rows.map((row) => row.mail.id))],
      expectedChecksums: rows.map(({ mail }) => ({
        orderMailId: mail.id,
        checksum: mail.rawChecksum,
      })),
    },
    queue,
  );
  const launched = results.length
    ? await getDb(db)
        .select({ id: run.id, shortcode: run.shortcode })
        .from(run)
        .where(
          inArray(
            run.id,
            results.map((result) => runEntityId.parse(result.runId)),
          ),
        )
    : [];
  if (launched.length !== new Set(results.map((result) => result.runId)).size)
    throw new Error("Mail research Run was not persisted.");
  return orderMailImportOut.parse({
    runIds: results.map(
      (result) => launched.find((row) => row.id === result.runId)?.shortcode,
    ),
  });
}

export async function startOrderMailImport(
  db: Database,
  rawInput: OrderMailImportInput,
  actor: ActorContext,
  queue: PurchaseAgentQueueProducer,
  _trigger: "manual" | "discovery" = "manual",
  ports: ResearchPorts = {},
) {
  return startSelectedSources(
    db,
    [orderMailImportInput.parse(rawInput)],
    actor,
    queue,
    ports,
  );
}
export async function startSelectedOrderMailImport(
  db: Database,
  rawInput: OrderMailImportSelectedInput,
  actor: ActorContext,
  queue: PurchaseAgentQueueProducer,
  ports: ResearchPorts = {},
) {
  const input = orderMailImportSelectedInput.parse(rawInput);
  return startSelectedSources(db, input.orders, actor, queue, ports);
}
