/** Convert a dollar amount to the integer-cent domain used for comparisons. */
export const cents = (value: number): number => Math.round(value * 100);

/** Convert integer cents back to dollars. */
export const dollars = (value: number): number => value / 100;

/** Round a dollar amount to whole cents, staying in dollars. */
export const round2 = (value: number): number => Math.round(value * 100) / 100;
