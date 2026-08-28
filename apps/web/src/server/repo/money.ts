/** Convert a dollar amount to the integer-cent domain used for comparisons. */
export const cents = (value: number): number => Math.round(value * 100);
