import { sql, type SQL } from "drizzle-orm";

/**
 * A `timestamp` (UTC wall time) as ISO text with `Z`. Raw statements return
 * driver strings without a zone, which `new Date` would read as local time.
 */
export const isoText = (expression: SQL): SQL =>
  sql`to_char(${expression}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export const fromIso = (value: string | null | undefined): Date | null =>
  value ? new Date(value) : null;
