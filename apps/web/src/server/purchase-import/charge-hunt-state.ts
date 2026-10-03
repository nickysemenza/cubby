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

/**
 * True when an unfinished charge-search run (other than `exceptRunId`) holds
 * this hunt. A run a restart superseded owns nothing; its successor carries
 * the same ids and is checked on its own.
 */
export const unfinishedChargeRunOwns = (exceptRunId?: string) => sql`EXISTS (
  SELECT 1 FROM "Run" r
  WHERE r."deletedAt" IS NULL
    AND r."input"->>'kind' = 'charge_hunts'
    AND r."status" NOT IN ('completed', 'failed')
    AND r."input"->'huntIds' @> to_jsonb(${importHunt.id}::text)
    AND (${exceptRunId ?? null}::uuid IS NULL OR r."id" <> ${exceptRunId ?? null}::uuid)
    AND NOT EXISTS (SELECT 1 FROM "Run" s WHERE s."deletedAt" IS NULL AND s."predecessorRunId" = r."id")
)`;

export const notOwnedByUnfinishedChargeRun = sql`NOT ${unfinishedChargeRunOwns()}`;
