import { count, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { location } from "~/server/db/schema";
import { getDb } from "./database-helpers";
import {
  createLocation,
  findOrCreateLocationByName,
  locationList,
} from "./location";

describe("findOrCreateLocationByName", () => {
  const ctx = withTestDb();

  it("returns the existing location on a repeat call (no duplicate)", async () => {
    const first = await findOrCreateLocationByName(
      ctx.db,
      "Pantry",
      null,
      "room",
    );
    expect(first.created).toBe(true);

    const second = await findOrCreateLocationByName(
      ctx.db,
      "Pantry",
      null,
      "room",
    );
    expect(second.created).toBe(false);
    expect(second.locationId).toEqual(first.locationId);

    const [result] = await getDb(ctx.db)
      .select({ count: count() })
      .from(location);
    expect(result!.count).toEqual(1);
  });

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
        .values({ name, type: "room", shortcode: "LRACE1" })
        .returning();
      winnerId = row!.id;
      await winnerCommitted; // hold the txn (and its lock) open
    });

    // Let the winner reach (and hold) its uncommitted INSERT.
    await new Promise((r) => setTimeout(r, 100));

    const loser = findOrCreateLocationByName(ctx.db, name, null, "room");

    // Give the call time to reach its blocked INSERT, then commit the winner.
    await new Promise((r) => setTimeout(r, 100));
    releaseWinner();

    const [, result] = await Promise.all([winner, loser]);

    // Recovered onto the winner's row — no throw, no duplicate.
    expect(result.created).toBe(false);
    expect(result.locationId).toEqual(winnerId);

    const [countRow] = await getDb(ctx.db)
      .select({ count: count() })
      .from(location)
      .where(eq(location.name, name));
    expect(countRow!.count).toEqual(1);
  });
});

describe("locationList parentPresenceFilter", () => {
  const ctx = withTestDb();

  it("filters to root locations with 'none' and to children with 'has'", async () => {
    const root = await createLocation(
      ctx.db,
      { name: "Kitchen", aliases: [], type: "room", parentId: null },
      ctx.actor,
    );
    const child = await createLocation(
      ctx.db,
      { name: "Pantry Shelf", aliases: [], type: "shelf", parentId: root.id },
      ctx.actor,
    );

    const rootsOnly = await locationList(
      ctx.db,
      { parentPresenceFilter: "none" },
      [],
      { pageIndex: 0, pageSize: 10 },
    );
    expect(rootsOnly.data.map((l) => l.id)).toEqual([root.id]);

    const childrenOnly = await locationList(
      ctx.db,
      { parentPresenceFilter: "has" },
      [],
      { pageIndex: 0, pageSize: 10 },
    );
    expect(childrenOnly.data.map((l) => l.id)).toEqual([child.id]);
  });
});
