import type { LocationShortcode } from "@cubby/schemas/identifiers";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { count, eq } from "drizzle-orm";
import {
  TEST_HOME_ID,
  TEST_HOME_SHORTCODE,
  withTestDb,
} from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { location } from "~/server/db/schema";
import { executeEntity } from "~/server/entity-kernel";
import type { EntityMutationCommand } from "~/server/entity-kernel/contracts";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

import { getDb } from "./database-helpers";
import { createInventoryEntry, deleteInventoryEntries } from "./inventory";
import {
  bulkReparentLocations,
  createLocation,
  deleteLocations,
  findOrCreateLocationByName,
  getLocationById,
} from "./location";
import { createProduct } from "./product";
import { makeLocationInput, makeProductInput } from "./repo.fixtures";
import { resolveLiveShortcode } from "./shortcode-resolver";

describe("findOrCreateLocationByName", () => {
  const ctx = withTestDb();

  it("recovers from a concurrent create race instead of 500ing", async () => {
    // Cross-request race, deterministically forced (the findOrCreate primitive's
    // conflict branch): a "winner" txn inserts the same-named location and holds
    // its lock open while our call runs. Our SELECT misses (winner uncommitted),
    // the INSERT ... ON CONFLICT DO NOTHING blocks on the lock; once the winner
    // commits, DO NOTHING returns no row and the re-SELECT finds the winner —
    // no unique-violation 500, no duplicate.
    const name = "Garage";

    let releaseWinner!: () => void;
    const winnerCommitted = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });

    let winnerId = "";
    const winner = getDb(ctx.db).transaction(async (tx) => {
      const [row] = await tx
        .insert(location)
        .values({
          name,
          type: "room",
          shortcode: parseShortcodeFor("location", "LOC-RACE"),
          parentId: TEST_HOME_ID,
        })
        .returning();
      winnerId = row!.id;
      await winnerCommitted; // hold the txn (and its lock) open
    });

    await new Promise((r) => setTimeout(r, 100));

    const loser = findOrCreateLocationByName(ctx.db, name, null, "room");

    await new Promise((r) => setTimeout(r, 100));
    releaseWinner();

    const [, result] = await Promise.all([winner, loser]);

    expect(result.created).toBe(false);
    expect(result.locationId).toEqual(winnerId);

    const [countRow] = await getDb(ctx.db)
      .select({ count: count() })
      .from(location)
      .where(eq(location.name, name));
    expect(countRow!.count).toEqual(1);
  });
});

describe("location storage integrity", () => {
  const ctx = withTestDb();

  it("enforces the parent foreign key while keeping Home parentless", async () => {
    const home = await getDb(ctx.db).query.location.findFirst({
      where: eq(location.id, TEST_HOME_ID),
      columns: { parentId: true },
    });
    expect(home?.parentId).toBeNull();

    await expect(
      getDb(ctx.db)
        .insert(location)
        .values({
          name: "Orphaned raw location",
          shortcode: parseShortcodeFor("location", "LOC-2345"),
          parentId: parseEntityId(
            "location",
            "00000000-0000-4000-8000-000000000099",
          ),
        }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("backstops product/type exclusivity with a database CHECK", async () => {
    const identity = await createProduct(
      ctx.db,
      makeProductInput({ name: "Raw location identity product" }),
      ctx.actor,
    );
    const productBacked = await createLocation(
      ctx.db,
      makeLocationInput({
        name: "Raw product-backed location",
        productId: identity.id,
      }),
      ctx.actor,
    );
    const id = parseEntityId(
      "location",
      (await resolveLiveShortcode(ctx.db, productBacked.id, "location"))!,
    );

    await expect(
      getDb(ctx.db)
        .update(location)
        .set({ type: "box" })
        .where(eq(location.id, id)),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });
});

// A duplicate-name error has to name the location that is blocking, not just
// report that something is. Without the shortcode the only way to find the
// blocker is a follow-up list_locations scan — which is exactly what the
// generic Postgres translation forced, and it could not even name the column:
// `Key (lower(name))=(ppe)` defeats its `Key (...)=` extraction.

describe("bulkReparentLocations", () => {
  const ctx = withTestDb();

  // Regression: `inArray` collapses duplicate ids in the UPDATE, so the
  // `updated.length !== ids.length` guard used to trip a spurious
  // LOCATION_NOT_FOUND whenever `ids` contained a repeat. Only the router
  // caller deduped before this fix — the repo function itself now dedupes,
  // so the invariant travels with the exported function regardless of caller.

  it("maps a null parent to Home and refuses to move Home", async () => {
    const parent = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Temporary Parent" }),
      ctx.actor,
    );
    const child = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Back Home", parentId: parent.id }),
      ctx.actor,
    );
    const childId = parseEntityId(
      "location",
      (await resolveLiveShortcode(ctx.db, child.id, "location"))!,
    );

    await bulkReparentLocations(ctx.db, [childId], null, ctx.actor);
    expect((await getLocationById(ctx.db, childId)).parent?.id).toBe(
      TEST_HOME_SHORTCODE,
    );

    await expect(
      bulkReparentLocations(ctx.db, [TEST_HOME_ID], childId, ctx.actor),
    ).rejects.toThrow("Home cannot be reparented");
  });
});

describe("location kernel — bulkUpdate (the guards, through the kernel)", () => {
  const ctx = withTestDb();
  const kernelContext = () =>
    requireActor(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
  const bulkUpdate = async (
    ids: LocationShortcode[],
    parentId: LocationShortcode | null,
  ) => {
    const command = {
      action: "bulkUpdate",
      entity: "location",
      ids,
      data: { parentId },
    } satisfies EntityMutationCommand;
    const result = await executeEntity(kernelContext(), command);
    if (result.action !== "bulkUpdate") throw new Error("unreachable");
    return result;
  };

  it("refuses a parent that is a descendant of the selection (cycle)", async () => {
    const room = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Kernel Cycle Room" }),
      ctx.actor,
    );
    const shelf = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Kernel Cycle Shelf", parentId: room.id }),
      ctx.actor,
    );

    await expect(bulkUpdate([room.id], shelf.id)).rejects.toMatchObject({
      cause: { reason: "LOCATION_CYCLE_DETECTED" },
    });
  });
});

describe("deleteLocations hierarchy", () => {
  const ctx = withTestDb();

  /** LOCATION_HAS_INVENTORY: live inventory blocks delete. */
  it("rejects a location with live inventory, succeeds once the inventory is removed", async () => {
    const stocked = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Inventory-Blocked Location" }),
      ctx.actor,
    );
    const stockedId = parseEntityId(
      "location",
      (await resolveLiveShortcode(ctx.db, stocked.id, "location"))!,
    );
    const product = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Location Inventory Blocker",
        upc: "800000000904",
      }),
      ctx.actor,
    );
    const productId = parseEntityId(
      "product",
      (await resolveLiveShortcode(ctx.db, product.id, "product"))!,
    );
    const entry = await createInventoryEntry(
      ctx.db,
      {
        productId,
        locationId: stockedId,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );
    const entryId = parseEntityId(
      "inventory",
      (await resolveLiveShortcode(ctx.db, entry.id, "inventory"))!,
    );

    await expect(
      deleteLocations(ctx.db, [stockedId], ctx.actor),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      cause: { reason: "LOCATION_HAS_INVENTORY" },
    });

    await deleteInventoryEntries(ctx.db, [entryId], ctx.actor);

    await expect(
      deleteLocations(ctx.db, [stockedId], ctx.actor),
    ).resolves.toMatchObject({ detachedImageKeys: [] });
  });
});

/**
 * The location list's `inventoryEntries` cell, its sort, and its count filters
 * must agree on whether an installed fixture counts. Per the rule in
 * `inventory/placement.ts` — "Counting, auditing, browsing → EXCLUDE" — none of
 * them do. The cell used to, so "wire spools" rendered 49 chips while sorting
 * as 25.
 *
 * The PRODUCT direction is asserted here too, and asserts the OPPOSITE. The
 * product list's Locations cell deliberately includes installed placements, so
 * a fix applied to both directions would turn one bug into another. This hero
 * stat has broken both ways; the pair of assertions is the guard.
 */

/**
 * The photo pass and the scan landing attach a new photo as the location's
 * COVER while keeping the old ones. `updateLocation` applies `imageOrder`
 * before `associatePendingImages`, so a pending id cannot be ordered in the
 * same call — the client sends a second, order-only update once the join row
 * exists (see `useLocationPhotoCapture`). These assert that sequence really
 * lands the new photo first.
 */
