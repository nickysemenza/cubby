import type { DisplayItem } from "@cubby/schemas/entity-definitions/label-field";
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

/** Linked detail rows preserve dated membership order on every client. */
// oxlint-disable-next-line cubby/no-raw-enum-literal-in-sql -- jsonb_build_object keys describe the DisplayItem wire shape, not enum values.
export const accountPartyPeriodItemsSql = (periods: SQL) => sql<DisplayItem[]>`(
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'entity', 'ledgerParty',
    'id', period->>'ledgerPartyId',
    'title', coalesce(party.name, period->>'ledgerPartyId'),
    'subtitle', CASE
      WHEN period->>'validFrom' IS NULL AND period->>'validTo' IS NULL THEN NULL
      ELSE coalesce(period->>'validFrom', '…') || ' → ' || coalesce(period->>'validTo', '…')
    END,
    'trailing', NULL
  ) ORDER BY ordinal), '[]'::jsonb)
  FROM jsonb_array_elements(${periods}) WITH ORDINALITY history(period, ordinal)
  LEFT JOIN "LedgerParty" party ON party.shortcode = period->>'ledgerPartyId' AND party."deletedAt" IS NULL
)`;
