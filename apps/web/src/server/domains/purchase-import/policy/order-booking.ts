import { plainDate } from "@cubby/schemas/base-entity";
import { moneyToMinor } from "@cubby/shared";

import { householdLocalDate } from "~/lib/household-date";
import type { sourceOrderObservation } from "~/server/db/retained-tables";
import { importLineWritePolicy } from "~/server/domains/purchase-import/policy/import-plan";

/** Decode source wire amounts once, before the money reconciler runs. */
export function orderBookingInput(
  observation: typeof sourceOrderObservation.$inferSelect,
) {
  const candidate = observation.extraction.candidate;
  const policy = importLineWritePolicy(observation.extraction);
  const ordered = candidate?.orderedAt;
  return {
    observation,
    policy,
    refund: candidate?.sourceEvent === "refunded",
    date: ordered
      ? plainDate.safeParse(ordered).success
        ? ordered
        : householdLocalDate(new Date(ordered))
      : null,
    totalMinor:
      candidate?.printedGrandTotal == null
        ? null
        : moneyToMinor(candidate.printedGrandTotal),
    lines: (candidate?.lines ?? []).map((line, lineIndex) => ({
      ...line,
      lineIndex,
      binding: observation.productBindings.find((binding) => binding.lineIndex === lineIndex),
      amountMinor: line.amount === null ? null : moneyToMinor(line.amount),
      productId:
        observation.productBindings.find(
          (binding) => binding.lineIndex === lineIndex,
        )?.productId ?? null,
    })),
  };
}
export type OrderBookingInput = ReturnType<typeof orderBookingInput>;
