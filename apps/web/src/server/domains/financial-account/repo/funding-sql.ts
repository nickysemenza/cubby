import type { DisplayItem } from "@cubby/schemas/entity-definitions/label-field";
import { sql, type SQL } from "drizzle-orm";

/**
 * The party whose funding period covers every day from `from` through `to`.
 * Nonempty history replaces the undated fallback; a gap remains unknown.
 */
const fundingPartyCoveringSql = (account: SQL, from: SQL, to: SQL) => sql`(
  CASE WHEN jsonb_array_length(${account}."fundingPeriods") = 0 THEN ${account}."ledgerPartyId"
  ELSE (SELECT party.id FROM jsonb_array_elements(${account}."fundingPeriods") period
    JOIN "LedgerParty" party ON party.shortcode = period->>'ledgerPartyId' AND party."deletedAt" IS NULL
    WHERE ${from} IS NOT NULL AND ${to} IS NOT NULL
      AND (period->>'validFrom' IS NULL OR (period->>'validFrom')::date <= ${from})
      AND (period->>'validTo' IS NULL OR ${to} <= (period->>'validTo')::date)
  ) END
)`;

/**
 * Statement imports store only `postedDate`, which can trail the charge by days
 * and cross a period boundary. A posting date therefore resolves a party only
 * when one period also covers this many preceding days; otherwise it stays unknown.
 */
const POSTING_LAG_DAYS = 14;

/** Funding party for a settlement row, by charge date, else a boundary-safe posting date. */
export const paymentFundingPartySql = (account: SQL, payment: SQL) => sql`(
  CASE WHEN ${payment}."transactionDate" IS NOT NULL
    THEN ${fundingPartyCoveringSql(
      account,
      sql`${payment}."transactionDate"`,
      sql`${payment}."transactionDate"`,
    )}
    ELSE ${fundingPartyCoveringSql(
      account,
      sql`${payment}."postedDate" - ${sql.raw(String(POSTING_LAG_DAYS))}`,
      sql`${payment}."postedDate"`,
    )}
  END
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
