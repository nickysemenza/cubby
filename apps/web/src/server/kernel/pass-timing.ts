import { sql, type SQL } from "drizzle-orm";

/** Attempt `n`'s backoff: 30 s doubling to an hour. */
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 60 * 60_000;
export const backoffMs = (attempts: number): number =>
  Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));

/** The same backoff for an attempt number computed in the database. */
export const backoffInterval = (attempts: SQL): SQL =>
  sql`make_interval(secs => least(${BACKOFF_MAX_MS / 1000},
    ${BACKOFF_BASE_MS / 1000} * power(2::double precision,
      least(${Math.ceil(Math.log2(BACKOFF_MAX_MS / BACKOFF_BASE_MS))}, greatest(0, (${attempts}) - 1)))))`;

/** Recover the final lapse at expiry; a replacement claim owes normal backoff. */
export const passRecoveryAt = (p: SQL): SQL =>
  sql`${p}."claimDeadline" + CASE WHEN ${p}.attempts + 1 >= ${p}."maxAttempts"
    THEN interval '0 seconds'
    ELSE ${backoffInterval(sql`${p}.attempts + 1`)} END`;

export const passFreeAt = (p: SQL): SQL =>
  sql`nullif(CASE WHEN ${p}."claimToken" IS NULL THEN ${p}."availableAt"
    WHEN ${p}."claimDeadline" IS NOT NULL THEN greatest(${p}."availableAt", ${passRecoveryAt(p)}) END, 'infinity'::timestamp)`;
