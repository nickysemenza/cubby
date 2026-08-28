import { testEntityId } from "@cubby/schemas/testing";
import { TEST_ACTOR } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type { Database } from "~/server/db/database";

import { bulkMoveInventoryEntries } from "./bulk";

/**
 * The same-source-and-target guard is the first statement of
 * `bulkMoveInventoryEntries`, and its payload is already resolved to uuids by
 * the router, so the comparison is two strings.
 *
 * The integration test this replaces resolved every code before the guard, so
 * it seeded records only to reach a check that never touches the database.
 */
const explodingDb = new Proxy(
  {},
  {
    get(_target, prop) {
      throw new Error(
        `bulkMoveInventoryEntries touched the database (property "${String(prop)}") before rejecting a same-location move`,
      );
    },
  },
) as Database;

const LOCATION_A = testEntityId(
  "location",
  "11111111-1111-4111-8111-111111111111",
);
const LOCATION_B = testEntityId(
  "location",
  "22222222-2222-4222-8222-222222222222",
);
const ENTRY = testEntityId("inventory", "33333333-3333-4333-8333-333333333333");

const payload = (
  sourceLocationId: typeof LOCATION_A,
  targetLocationId: typeof LOCATION_A,
) => ({
  sourceLocationId,
  targetLocationId,
  items: [
    {
      inventoryEntryId: ENTRY,
      quantity: { value: 5, unit: "units" as const },
    },
  ],
});

describe("bulkMoveInventoryEntries same-location guard", () => {
  it("rejects a move whose source and target are the same, without touching the database", async () => {
    await expect(
      bulkMoveInventoryEntries(
        explodingDb,
        payload(LOCATION_A, LOCATION_A),
        TEST_ACTOR,
      ),
    ).rejects.toThrow("Source and target locations must be different");
  });

  // Guards the guard: a genuine move must get past the check and reach the
  // database, so neither the proxy nor the comparison can quietly stop working.
  it("lets a real move through to the database", async () => {
    await expect(
      bulkMoveInventoryEntries(
        explodingDb,
        payload(LOCATION_A, LOCATION_B),
        TEST_ACTOR,
      ),
    ).rejects.toThrow(/touched the database/i);
  });
});
