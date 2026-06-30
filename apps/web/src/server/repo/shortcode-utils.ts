/**
 * Unique shortcode generation utilities for database entities.
 *
 * Provides retry-based unique shortcode generation to handle collisions.
 * Each entity type has its own generator that checks for existing codes
 * in the database before returning.
 */

import {
  generateLocationShortcode,
  generateProductShortcode,
  generateRecipeShortcode,
} from "@cubby/shared";
import { type AnyColumn, and, eq, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Database, DrizzleTransaction } from "~/server/db";
import { location, product, recipe } from "~/server/db/schema";

import { notDeleted, unwrapDb } from "./database-helpers";

const MAX_RETRIES = 10;

/** A soft-deletable table with a unique shortcode column. */
type ShortcodeTable = PgTable & {
  shortcode: AnyColumn;
  deletedAt: AnyColumn;
};

/** Whether a (non-deleted) row with this shortcode already exists. */
const shortcodeExists = async (
  db: Database | DrizzleTransaction,
  table: ShortcodeTable,
  code: string,
): Promise<boolean> => {
  const existing = await unwrapDb(db)
    .select({ one: sql<number>`1` })
    .from(table)
    .where(and(eq(table.shortcode, code), notDeleted(table)))
    .limit(1);
  return existing.length > 0;
};

/**
 * Generate a unique shortcode for `table` with collision retry, excluding
 * soft-deleted rows from the uniqueness check. Accepts a transaction so callers
 * inside `withTransaction` (e.g. recipe import) stay atomic.
 *
 * @throws if no unique code is found after MAX_RETRIES attempts.
 */
async function generateUniqueShortcode(
  db: Database | DrizzleTransaction,
  table: ShortcodeTable,
  generateCode: () => string,
  entityName: string,
): Promise<string> {
  for (let i = 0; i < MAX_RETRIES; i++) {
    const code = generateCode();
    if (!(await shortcodeExists(db, table, code))) {
      return code;
    }
  }
  throw new Error(
    `Failed to generate unique ${entityName} shortcode after ${MAX_RETRIES} retries`,
  );
}

export const generateUniqueProductShortcode = (db: Database): Promise<string> =>
  generateUniqueShortcode(db, product, generateProductShortcode, "product");

export const generateUniqueRecipeShortcode = (
  db: Database | DrizzleTransaction,
): Promise<string> =>
  generateUniqueShortcode(db, recipe, generateRecipeShortcode, "recipe");

export const generateUniqueLocationShortcode = (
  db: Database,
): Promise<string> =>
  generateUniqueShortcode(db, location, generateLocationShortcode, "location");
