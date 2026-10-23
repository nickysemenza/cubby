import type { VendorId, VendorShortcode } from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, eq, isNull, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { trimBrandNameSql } from "~/server/db/computed/brand-name-sql";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { vendor } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

const GENERIC_BRAND_SYSTEM_KEY = "generic-unbranded";

/** External evidence names a marketed brand; ordinary domain writes use its reference. */
export async function resolveProductBrandName(
  db: Database,
  raw: string | null | undefined,
): Promise<VendorShortcode | null> {
  const name = raw?.trim();
  if (!name || name.toLowerCase() === "(unspecified)") return null;
  const generic = ["generic", "unbranded", "generic / unbranded"].includes(
    name.toLowerCase(),
  );
  return withTransactionDatabase(db, async (tx) => {
    const database = getDb(tx);
    // Serialize name resolution so concurrent imports cannot mint the same new brand twice.
    await database.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${name.toLowerCase()}, 0))`,
    );
    const matches = await database
      .select({ id: vendor.id, shortcode: vendor.shortcode })
      .from(vendor)
      .where(
        and(
          notDeleted(vendor),
          generic
            ? eq(vendor.systemKey, GENERIC_BRAND_SYSTEM_KEY)
            : and(
                isNull(vendor.systemKey),
                sql`(lower(${trimBrandNameSql(vendor.name)}) = lower(${name}) OR EXISTS (SELECT 1 FROM unnest(${vendor.aliases}) alias WHERE lower(${trimBrandNameSql(sql`alias`)}) = lower(${name})))`,
              ),
        ),
      );
    if (matches.length > 1)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `Brand name "${name}" is ambiguous; select the intended Vendor reference.`,
      );
    if (matches[0]) return parseShortcodeFor("vendor", matches[0].shortcode);
    if (generic)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "The system Generic / Unbranded brand is missing.",
      );
    const created = await insertWithShortcode(tx, "vendor", { name });
    return parseShortcodeFor("vendor", created.shortcode);
  });
}

export const resolveProductBrand = async (
  db: Database | DrizzleTransaction,
  code: VendorShortcode | null | undefined,
): Promise<VendorId | null> =>
  code ? resolveOrThrow(db, "vendor", code) : null;
