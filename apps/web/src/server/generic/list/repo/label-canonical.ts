import { type SQLWrapper, sql } from "drizzle-orm";

/** Text retrieval key for reviewing duplicate Vendor names; never identity authority. */
export const canonicalLabelKey = (value: SQLWrapper) => sql`
  regexp_replace(
    regexp_replace(
      regexp_replace(lower(btrim(${value})), '^the\\s+', ''),
      '(\\.com|,?\\s+(inc|llc|co)\\.?)$', ''),
    '[^a-z0-9]', '', 'g')`;
