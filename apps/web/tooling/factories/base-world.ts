import { testEntityId, testShortcode } from "@cubby/schemas/testing";
import type { drizzle } from "drizzle-orm/node-postgres";

import { location, productCategory } from "../../src/server/db/schema";
import { taxonomyRootFixtures } from "../product-category-fixtures";

/**
 * The rows every Cubby database starts with: the one real location-hierarchy
 * root ("Home") and the product-category taxonomy roots. Seeded here for Vitest
 * integration databases, browser E2E workers, the dev corpus, simulator
 * scenarios, and the Mac import lane, so none of them re-inserts its own copy.
 *
 * These rows carry fixed ids and shortcodes on purpose — specs and fixtures
 * address them by code (`taxonomyShortcode("food")`, `LOC-HM3E`), and a
 * kernel `create` would mint a random code. That is why this is a direct
 * insert rather than a kernel command: the exception is the fixed identity,
 * not the data. Everything else goes through `createEntity`.
 */

export const BASE_HOME_ID = testEntityId(
  "location",
  "00000000-0000-4000-8000-000000000001",
);
export const BASE_HOME_SHORTCODE = testShortcode("location", "LOC-HM3E");

/** The slice of a Drizzle client `seedBaseWorld` needs; any node-postgres client fits. */
type InsertClient = Pick<ReturnType<typeof drizzle>, "insert">;

/** Insert Home and the taxonomy roots. Idempotent: a re-seed is a no-op. */
export async function seedBaseWorld(db: InsertClient): Promise<void> {
  await db
    .insert(location)
    .values({
      id: BASE_HOME_ID,
      shortcode: BASE_HOME_SHORTCODE,
      name: "Home",
      aliases: [],
      type: "house",
      parentId: null,
    })
    .onConflictDoNothing();
  await db
    .insert(productCategory)
    .values(taxonomyRootFixtures)
    .onConflictDoNothing();
}
