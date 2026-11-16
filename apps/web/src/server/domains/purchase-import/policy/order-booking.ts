import { plainDate } from "@cubby/schemas/base-entity";
import { moneyToMinor } from "@cubby/shared";

import { householdLocalDate } from "~/lib/household-date";
import type { sourceOrderObservation } from "~/server/db/retained-tables";
import { importLineWritePolicy } from "~/server/domains/purchase-import/policy/import-plan";

/** Decode source wire amounts once, before the money reconciler runs. */
export function orderBookingInput(
  observation: typeof sourceOrderObservation.$inferSelect,
  context: { purchaseDate: string | null; receivedAt: Date | null },
) {
  const candidate = observation.extraction.candidate;
  const ordered = candidate?.orderedAt;
  const printedDate = ordered
    ? plainDate.safeParse(ordered).success
      ? ordered
      : householdLocalDate(new Date(ordered))
    : null;
  const confirmation =
    (candidate?.sourceEvent ?? "confirmation") === "confirmation";
  const receivedDate =
    confirmation && context.receivedAt
      ? householdLocalDate(context.receivedAt)
      : null;
  const date =
    printedDate ??
    (confirmation ? (context.purchaseDate ?? receivedDate) : null);
  const policy = importLineWritePolicy(
    candidate && !candidate.orderedAt && date
      ? {
          ...observation.extraction,
          candidate: { ...candidate, orderedAt: date },
        }
      : observation.extraction,
  );
  return {
    observation,
    policy,
    refund: candidate?.sourceEvent === "refunded",
    date,
    dateFromReceipt:
      !printedDate && !context.purchaseDate && receivedDate !== null,
    totalMinor:
      candidate?.currency !== "USD" || candidate.printedGrandTotal == null
        ? null
        : moneyToMinor(candidate.printedGrandTotal),
    lines: (candidate?.lines ?? []).map((line, lineIndex) => ({
      ...line,
      lineIndex,
      binding: observation.productBindings.find(
        (binding) => binding.lineIndex === lineIndex,
      ),
      amountMinor:
        policy.valuation === "unknown" || line.amount === null
          ? null
          : moneyToMinor(line.amount),
      productId:
        observation.productBindings.find(
          (binding) => binding.lineIndex === lineIndex,
        )?.productId ?? null,
    })),
  };
}
export type OrderBookingInput = ReturnType<typeof orderBookingInput>;
