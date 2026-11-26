import { sql, type SQL } from "drizzle-orm";

/**
 * A `timestamp` (UTC wall time) as ISO text with `Z`. Raw statements return
 * driver strings without a zone, which `new Date` would read as local time.
 */
export const isoText = (expression: SQL): SQL =>
  sql`to_char(${expression}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export const fromIso = (value: string | null | undefined): Date | null =>
  value ? new Date(value) : null;

/** Attempt `n`'s backoff: 30 s doubling to an hour. */
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 60 * 60_000;
export const backoffMs = (attempts: number): number =>
  Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));

/** Recover the final lapse at expiry; a replacement claim owes normal backoff. */
export const passRecoveryAt = (p: SQL): SQL =>
  sql`${p}."claimDeadline" + CASE WHEN ${p}.attempts + 1 >= ${p}."maxAttempts"
    THEN interval '0 seconds'
    ELSE make_interval(secs => least(${BACKOFF_MAX_MS / 1000},
      ${BACKOFF_BASE_MS / 1000} * power(2::double precision, least(7, ${p}.attempts)))) END`;

export const passFreeAt = (p: SQL): SQL =>
  sql`CASE WHEN ${p}."claimToken" IS NULL THEN ${p}."availableAt"
    WHEN ${p}."claimDeadline" IS NOT NULL THEN greatest(${p}."availableAt", ${passRecoveryAt(p)}) END`;
