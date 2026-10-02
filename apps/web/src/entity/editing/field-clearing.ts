import type { Entity } from "@cubby/schemas/entity";
import {
  canClearExpenseDate,
  EXPENSE_DATE_REQUIRED_MESSAGE,
} from "@cubby/schemas/expense-fields";
import { z } from "zod";

const expenseCostSchema = z.number().nullish();

/** Storage nullability permits clearing; domain rules can narrow it. */
export function fieldClearing(
  entity: Entity,
  key: string,
  nullable: boolean,
  cost?: unknown,
) {
  const expenseDate = entity === "expense" && key === "date";
  const parsedCost = expenseCostSchema.safeParse(cost).data;
  const clearable =
    nullable && (!expenseDate || canClearExpenseDate(parsedCost));
  return {
    clearable,
    clearLabel: expenseDate ? "Date unknown" : "Clear",
    clearDisabledReason:
      expenseDate && !clearable ? EXPENSE_DATE_REQUIRED_MESSAGE : undefined,
  };
}

const expenseCostProjection = z.object({ cost: expenseCostSchema });

export function recordFieldClearing(
  entity: Entity,
  key: string,
  nullable: boolean,
  record: unknown,
) {
  const cost = expenseCostProjection.safeParse(record).data?.cost;
  return fieldClearing(entity, key, nullable, cost);
}
