import type { VendorId, VendorShortcode } from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, eq, isNull, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { trimTextSql } from "~/server/db/computed/text-whitespace";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { vendor } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

export const GENERIC_BRAND_SYSTEM_KEY = "generic-unbranded";

/**
 * The one reading of an external brand claim: blank and "(unspecified)" name
 * no brand; the generic spellings name the generic system Vendor.
 */
export const parseBrandClaim = (raw: string | null | undefined) => {
  const name = raw?.trim();
  if (!name || name.toLowerCase() === "(unspecified)") return null;
  const generic = ["generic", "unbranded", "generic / unbranded"].includes(
    name.toLowerCase(),
  );
  return { name, generic };
};

/** A live Vendor's trimmed name or any alias equals `name`, case-insensitively. */
export const vendorNamedSql = (name: string) =>
  sql`(lower(${trimTextSql(vendor.name)}) = lower(${name}) OR EXISTS (SELECT 1 FROM unnest(${vendor.aliases}) alias WHERE lower(${trimTextSql(sql`alias`)}) = lower(${name})))`;

/** External evidence names a marketed brand; ordinary domain writes use its reference. */
export async function resolveProductBrandName(
  db: Database,
  raw: string | null | undefined,
): Promise<VendorShortcode | null> {
  const claim = parseBrandClaim(raw);
  if (!claim) return null;
  const { name, generic } = claim;
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
            : and(isNull(vendor.systemKey), vendorNamedSql(name)),
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
  db: DrizzleTransaction,
  code: VendorShortcode | null | undefined,
): Promise<VendorId | null> => {
  if (!code) return null;
  // Hold the selected live identity through the Product write, so a concurrent
  // Vendor merge/delete cannot leave the new reference on a tombstone.
  const [row] = await db
    .select({ id: vendor.id })
    .from(vendor)
    .where(and(eq(vendor.shortcode, code), notDeleted(vendor)))
    .for("share");
  return row?.id ?? resolveOrThrow(db, "vendor", code);
};
