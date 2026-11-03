import { sql } from "drizzle-orm";

import { trimTextSql } from "~/server/db/computed/text-whitespace";
import { vendor } from "~/server/db/retained-tables";
import {
  nameMatchesAnySql,
  textArraySomeSql,
} from "~/server/lib/name-alias-match";

/** A live Vendor's trimmed name or any alias equals `name`, case-insensitively. */
export const vendorNamedSql = (name: string) =>
  sql`(${nameMatchesAnySql(trimTextSql(vendor.name), [name])} OR ${textArraySomeSql(vendor.aliases, (value) => nameMatchesAnySql(trimTextSql(value), [name]))})`;
