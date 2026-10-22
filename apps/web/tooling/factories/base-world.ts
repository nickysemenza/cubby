import { testEntityId, testShortcode } from "@cubby/schemas/testing";
import type { drizzle } from "drizzle-orm/node-postgres";

import {
  automaticRule,
  entityIdentity,
  location,
  productCategory,
  user,
} from "../../src/server/db/schema";
import { taxonomyRootFixtures } from "../product-category-fixtures";

/**
 * The rows every Cubby database starts with: the reserved system user that
 * routine Runs act as, the one real location-hierarchy root ("Home"), the
 * product-category taxonomy roots and the Automatic rule switches as
 * migration 0091 seeds them. Seeded here for Vitest
 * integration databases, browser E2E workers, the dev corpus, simulator
 * scenarios, and the Mac import lane, so none of them re-inserts its own copy.
 *
 * These rows carry fixed ids and shortcodes on purpose — specs and fixtures
 * address them by code (`taxonomyShortcode("food")`, `LOC-HM3E`), and a
 * kernel `create` would mint a random code. That is why this is a direct
 * insert rather than a kernel command: the exception is the fixed identity,
 * not the data. Other base-world entities go through `createEntity`.
 */

export const BASE_HOME_ID = testEntityId(
  "location",
  "00000000-0000-4000-8000-000000000001",
);
export const BASE_HOME_SHORTCODE = testShortcode("location", "LOC-HM3E");

/** The slice of a Drizzle client `seedBaseWorld` needs; any node-postgres client fits. */
type InsertClient = Pick<ReturnType<typeof drizzle>, "transaction">;

/** Insert the starting rows. Idempotent: a re-seed is a no-op. */
/**
 * The current rule revisions the synthetic world seeds. Literal because the global test
 * setup loads this file before the test environment exists, so it cannot
 * import the rule declarations; `automatic-rules.unit.test.ts` keeps them equal.
 */
export const SEEDED_RULE_REVISIONS = {
  "field.addition": "2026-10-20.1",
  "statement_transaction.attach": "2026-10-21.1/2026-10-21.1",
} as const;

export async function seedBaseWorld(db: InsertClient): Promise<void> {
  await db.transaction(async (tx) => {
    const createdAt = new Date();
    // `systemActor()`'s user; production has it, and a background drain
    // creates routine Runs as it before any fixture runs.
    await tx
      .insert(user)
      .values({
        id: "cubby-system",
        name: "System",
        email: "system@example.test",
        emailVerified: true,
        createdAt,
        updatedAt: createdAt,
      })
      .onConflictDoNothing();
    // Fixed fixture identities are idempotent, and precede payload FK checks.
    await tx
      .insert(entityIdentity)
      .values([
        {
          id: BASE_HOME_ID,
          kind: "location",
          shortcode: BASE_HOME_SHORTCODE,
          createdAt,
        },
        ...taxonomyRootFixtures.map((row) => ({
          id: row.id,
          kind: "productCategory" as const,
          shortcode: row.shortcode,
          createdAt,
        })),
      ])
      .onConflictDoNothing({ target: entityIdentity.id });
    await tx
      .insert(location)
      .values({
        id: BASE_HOME_ID,
        shortcode: BASE_HOME_SHORTCODE,
        name: "Home",
        aliases: [],
        type: "house",
        parentId: null,
        createdAt,
      })
      .onConflictDoNothing();
    await tx
      .insert(productCategory)
      .values(taxonomyRootFixtures.map((row) => ({ ...row, createdAt })))
      .onConflictDoNothing();
    await tx
      .insert(automaticRule)
      .values([
        {
          family: "field",
          ruleKey: "field.addition",
          revision: SEEDED_RULE_REVISIONS["field.addition"],
          enabled: true,
          enabledAt: new Date(),
          enabledReason: "Synthetic base world: as migrated",
        },
        {
          family: "statement_transaction",
          ruleKey: "statement_transaction.attach",
          revision: SEEDED_RULE_REVISIONS["statement_transaction.attach"],
          enabled: false,
          disabledAt: new Date(),
          disabledReason: "Synthetic base world: as migrated",
        },
      ])
      .onConflictDoNothing();
  });
}
