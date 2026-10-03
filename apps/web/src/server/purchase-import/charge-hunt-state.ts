import { CHARGE_HUNT_STATE } from "@cubby/schemas/run-fields";
import { sql } from "drizzle-orm";

import { importHunt } from "~/server/db/schema";

/**
 * Hunt states from which order mail may still point a hunt at its order: a
 * fresh hunt, and a charge a selected-charges run left deferred or not found.
 */
export const MAIL_MATCHABLE_HUNT_STATES = [
  "pending_mail",
  CHARGE_HUNT_STATE.deferred,
  CHARGE_HUNT_STATE.notFound,
] as const;

/** Run statuses in which a charge run is working, or about to work, its hunts. */
const HOLDING = sql.raw(
  `'running', 'paused_auth', 'paused_offline', 'paused_approval', 'dispatch_failed'`,
);
const UNFINISHED = sql.raw(
  `'running', 'paused_auth', 'paused_offline', 'paused_approval', 'dispatch_failed', 'needs_review'`,
);

/**
 * True when a charge-search run (other than `exceptRunId`) holds this hunt.
 * By default only a run that is working or awaiting dispatch holds it, so a
 * run waiting in `needs_review` does not stop order mail from re-matching its
 * deferred charges; `includeReview` also counts it, for fences that must not
 * hand the same hunt to a second run. A run a restart superseded owns nothing;
 * its successor carries the ids and is checked on its own.
 */
export const unfinishedChargeRunOwns = (
  options: { exceptRunId?: string; includeReview?: boolean } = {},
) => {
  const except = options.exceptRunId ?? null;
  return sql`EXISTS (
  SELECT 1 FROM "Run" r
  WHERE r."deletedAt" IS NULL
    AND r."input"->>'kind' = 'charge_hunts'
    AND r."status" IN (${options.includeReview ? UNFINISHED : HOLDING})
    AND r."input"->'huntIds' @> to_jsonb(${importHunt.id}::text)
    AND (${except}::uuid IS NULL OR r."id" <> ${except}::uuid)
    AND NOT EXISTS (SELECT 1 FROM "Run" s WHERE s."deletedAt" IS NULL AND s."predecessorRunId" = r."id")
)`;
};

/** No working charge run holds the hunt (a review-parked one does not). */
export const notHeldByChargeRun = sql`NOT ${unfinishedChargeRunOwns()}`;

/** No unfinished charge run, including one parked in review, owns the hunt. */
export const notOwnedByUnfinishedChargeRun = sql`NOT ${unfinishedChargeRunOwns({ includeReview: true })}`;
