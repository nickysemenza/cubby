import {
  orderMailImportRunInput,
  orderMailImportRunOrders,
  type OrderMailImportOrder,
} from "@cubby/schemas/run-fields";
import { and, asc, eq, inArray } from "drizzle-orm";

import type { DrizzleClient, DrizzleTransaction } from "~/server/db";
import {
  orderMail,
  orderMailEvent,
  run,
  runOrderCandidate,
} from "~/server/db/schema";

/** Only this saved predecessor shape changes purpose during conversion. */
export function isHistoricalMailRun(
  scope: Pick<typeof run.$inferSelect, "purpose" | "input">,
) {
  return (
    scope.purpose === "account_sync" &&
    orderMailImportRunInput.safeParse(scope.input).success
  );
}

/** Validate all saved orders before excluding settled candidates or deduplicating sources. */
export async function historicalMailSources(
  client: DrizzleClient | DrizzleTransaction,
  scope: typeof run.$inferSelect,
  lockSources = false,
) {
  const parsed = orderMailImportRunInput.safeParse(scope.input);
  if (!isHistoricalMailRun(scope) || !parsed.success || !scope.ledgerPartyId)
    throw new Error("Historical mail selection is unavailable.");
  const orders = orderMailImportRunOrders(parsed.data);
  if (
    new Set(orders.map((order) => order.eventId)).size !== orders.length ||
    new Set(orders.map((order) => order.orderId)).size !== orders.length
  )
    throw new Error(
      "Historical mail selection contains conflicting order identities.",
    );
  const eventQuery = client
    .select()
    .from(orderMailEvent)
    .where(
      inArray(
        orderMailEvent.id,
        orders.map((order) => order.eventId),
      ),
    );
  const events = await eventQuery;
  if (events.length !== orders.length)
    throw new Error("Historical mail event roster is incomplete.");
  const sourceQuery = client
    .select()
    .from(orderMail)
    .where(
      and(
        eq(orderMail.ledgerPartyId, scope.ledgerPartyId),
        inArray(orderMail.id, [
          ...new Set(events.map((event) => event.orderMailId)),
        ]),
      ),
    )
    .orderBy(asc(orderMail.id));
  const sources = await (lockSources ? sourceQuery.for("update") : sourceQuery);
  // Original-row locks precede the immutable Run and candidate locks. Event
  // supersession must not race the last proof check and source transfer.
  const currentEvents = lockSources ? await eventQuery.for("share") : events;
  const candidateQuery = client
    .select()
    .from(runOrderCandidate)
    .where(eq(runOrderCandidate.runId, scope.id));
  const candidates = await (lockSources
    ? candidateQuery.for("share")
    : candidateQuery);
  assertHistoricalCandidates(orders, candidates, "orders" in parsed.data);
  const selectedIds = new Set<string>();
  for (const order of orders) {
    const source = historicalOrderSource(scope, order, currentEvents, sources);
    const outcome = candidates.find(
      (candidate) => candidate.orderId === order.orderId,
    )?.state;
    if (outcome !== "imported" && outcome !== "covered")
      selectedIds.add(source.id);
  }
  return {
    sources,
    selected: sources.filter((source) => selectedIds.has(source.id)),
  };
}

function assertHistoricalCandidates(
  orders: OrderMailImportOrder[],
  candidates: (typeof runOrderCandidate.$inferSelect)[],
  selectedBatch: boolean,
) {
  if (
    (selectedBatch || candidates.length > 0) &&
    (candidates.length !== orders.length ||
      new Set(candidates.map((candidate) => candidate.orderId)).size !==
        orders.length ||
      candidates.some(
        (candidate) =>
          !orders.some((order) => order.orderId === candidate.orderId),
      ))
  )
    throw new Error(
      "Historical mail candidate roster is incomplete or changed.",
    );
}

function historicalOrderSource(
  scope: typeof run.$inferSelect,
  order: OrderMailImportOrder,
  events: (typeof orderMailEvent.$inferSelect)[],
  sources: (typeof orderMail.$inferSelect)[],
) {
  const event = events.find((event) => event.id === order.eventId);
  const source = sources.find((source) => source.id === event?.orderMailId);
  if (
    !event ||
    !source ||
    event.supersededAt ||
    event.orderId !== order.orderId ||
    source.rawChecksum !== order.evidenceChecksum ||
    (scope.vendorId !== null && source.vendorId !== scope.vendorId)
  )
    throw new Error(
      "Historical mail event, order or retained checksum changed.",
    );
  return source;
}
