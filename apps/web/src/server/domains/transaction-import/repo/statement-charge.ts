import { sql } from "drizzle-orm";

import { notDeleted } from "~/server/db/helpers/predicates";
import {
  sourceObservationIdentities,
  sourceOccurrenceStates,
} from "~/server/domains/transaction-import/repo/source-observation-state";

/**
 * Explicit source-record identity. Historical reference strings remain links;
 * equal descriptions and amounts alone do not establish charge equivalence.
 */
export const chargeKeyOf = (alias: string) => sql.raw(`${alias}."chargeKey"`);

export const CHARGE_STATE = sql`(
  SELECT state.* FROM ${sourceOccurrenceStates} state
  WHERE EXISTS (SELECT 1 FROM ${sourceObservationIdentities} r
    WHERE r.source = state.source AND r."chargeKey" = state."chargeKey"
      AND ${notDeleted("r")})
)`;
