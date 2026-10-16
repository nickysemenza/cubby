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

/** One server-owned detail line per dated party, preserving membership order. */
export const accountPartyPeriodsLabelSql = (periods: SQL) => sql<
  string | null
>`(
  SELECT string_agg(
    coalesce(party.name, period->>'ledgerPartyId') || CASE
      WHEN period->>'validFrom' IS NULL AND period->>'validTo' IS NULL THEN ''
      ELSE ' · ' || coalesce(period->>'validFrom', '…') || ' → ' || coalesce(period->>'validTo', '…')
    END, E'\n' ORDER BY ordinal
  )
  FROM jsonb_array_elements(${periods}) WITH ORDINALITY history(period, ordinal)
  LEFT JOIN "LedgerParty" party ON party.shortcode = period->>'ledgerPartyId' AND party."deletedAt" IS NULL
)`;
