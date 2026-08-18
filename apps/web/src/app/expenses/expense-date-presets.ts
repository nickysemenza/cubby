/** Shared URL vocabulary for bounded Expense date presets. */
export const expenseDateRangeValues = ["30d", "90d", "ytd", "1y"] as const;
export type ExpenseDateRangePreset = (typeof expenseDateRangeValues)[number];

const expenseDateRangeSet = new Set<string>(expenseDateRangeValues);

export const isExpenseDateRangePreset = (
  value: string | undefined,
): value is ExpenseDateRangePreset =>
  value !== undefined && expenseDateRangeSet.has(value);
