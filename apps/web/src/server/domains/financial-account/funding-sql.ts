import { sql, type SQL } from "drizzle-orm";

/** Nonempty history replaces the undated fallback; a gap remains unknown. */
export const accountFundingPartySql = (account: SQL, date: SQL) => sql`(
  CASE WHEN jsonb_array_length(${account}."fundingPeriods") = 0 THEN ${account}."ledgerPartyId"
  ELSE (SELECT party.id FROM jsonb_array_elements(${account}."fundingPeriods") period
    JOIN "LedgerParty" party ON party.shortcode = period->>'ledgerPartyId' AND party."deletedAt" IS NULL
    WHERE ${date} IS NOT NULL
      AND (period->>'validFrom' IS NULL OR (period->>'validFrom')::date <= ${date})
      AND (period->>'validTo' IS NULL OR ${date} <= (period->>'validTo')::date)
  ) END
)`;
