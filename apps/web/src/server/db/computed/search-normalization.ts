import { sql, type SQL } from "drizzle-orm";

import {
  applySearchTextNormalization,
  searchWhitespacePattern,
} from "~/lib/search-normalization";
import { trimTextSql } from "~/server/db/computed/text-whitespace";

export const normalizeSearchTextSql = (text: SQL): SQL =>
  applySearchTextNormalization(text, {
    trim: trimTextSql,
    collapseWhitespace: (value) =>
      sql`regexp_replace(${value}, ${searchWhitespacePattern}, ' ', 'g')`,
    lowercase: (value) => sql`lower(${value})`,
  });
