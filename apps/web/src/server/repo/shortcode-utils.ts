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
import { and, eq } from "drizzle-orm";
import type { Database, DrizzleTransaction } from "~/server/db";
import { location, product, recipe } from "~/server/db/schema";

import { getDb, notDeleted, unwrapDb } from "./database-helpers";

const MAX_RETRIES = 10;

type ShortcodeExistsChecker = (code: string) => Promise<boolean>;

/**
 * Generic unique shortcode generator with collision retry.
 *
 * @param generateCode - Function that generates a candidate shortcode
 * @param checkExists - Function that checks if the code already exists
 * @param entityName - Name of the entity (for error messages)
 * @returns A unique shortcode that doesn't exist in the database
 * @throws Error if unable to generate unique code after MAX_RETRIES attempts
 */
async function generateUniqueShortcode(
  generateCode: () => string,
  checkExists: ShortcodeExistsChecker,
  entityName: string,
): Promise<string> {
  for (let i = 0; i < MAX_RETRIES; i++) {
    const code = generateCode();
    if (!(await checkExists(code))) {
      return code;
    }
  }
  throw new Error(
    `Failed to generate unique ${entityName} shortcode after ${MAX_RETRIES} retries`,
  );
}

/**
 * Generate a unique product shortcode with collision retry.
 * Retries up to 10 times if collision detected.
 * Excludes soft-deleted products from uniqueness check.
 */
export async function generateUniqueProductShortcode(
  db: Database,
): Promise<string> {
  return generateUniqueShortcode(
    generateProductShortcode,
    async (code) => {
      const existing = await getDb(db).query.product.findFirst({
        where: and(eq(product.shortcode, code), notDeleted(product)),
        columns: { id: true },
      });
      return !!existing;
    },
    "product",
  );
}

/**
 * Generate a unique recipe shortcode with collision retry.
 * Accepts both Database and DrizzleTransaction for use within transactions.
 * Excludes soft-deleted recipes from uniqueness check.
 */
export async function generateUniqueRecipeShortcode(
  db: Database | DrizzleTransaction,
): Promise<string> {
  return generateUniqueShortcode(
    generateRecipeShortcode,
    async (code) => {
      const existing = await unwrapDb(db).query.recipe.findFirst({
        where: and(eq(recipe.shortcode, code), notDeleted(recipe)),
        columns: { id: true },
      });
      return !!existing;
    },
    "recipe",
  );
}

/**
 * Generate a unique location shortcode with collision retry.
 * Retries up to 10 times if collision detected.
 * Excludes soft-deleted locations from uniqueness check.
 */
export async function generateUniqueLocationShortcode(
  db: Database,
): Promise<string> {
  return generateUniqueShortcode(
    generateLocationShortcode,
    async (code) => {
      const existing = await getDb(db).query.location.findFirst({
        where: and(eq(location.shortcode, code), notDeleted(location)),
        columns: { id: true },
      });
      return !!existing;
    },
    "location",
  );
}
