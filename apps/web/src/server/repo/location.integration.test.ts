import { count, eq } from "drizzle-orm";
import { buildTestDB } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "~/server/db";
import { location } from "~/server/db/schema";
import { getDb } from "./database-helpers";
import { findOrCreateLocationByName } from "./location";

describe("findOrCreateLocationByName", () => {
  let db: Database;
  let teardown: () => Promise<void>;

  beforeEach(async () => {
    ({ db, teardown } = await buildTestDB());
    return teardown;
  });

  it("returns the existing location on a repeat call (no duplicate)", async () => {
    const first = await findOrCreateLocationByName(db, "Pantry", null, "room");
    expect(first.created).toBe(true);

    const second = await findOrCreateLocationByName(db, "Pantry", null, "room");
    expect(second.created).toBe(false);
    expect(second.locationId).toEqual(first.locationId);

    const [result] = await getDb(db).select({ count: count() }).from(location);
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
    const winner = getDb(db).transaction(async (tx) => {
      const [row] = await tx
        .insert(location)
        .values({ name, type: "room", shortcode: "LRACE1" })
        .returning();
      winnerId = row!.id;
      await winnerCommitted; // hold the txn (and its lock) open
    });

    // Let the winner reach (and hold) its uncommitted INSERT.
    await new Promise((r) => setTimeout(r, 100));

    const loser = findOrCreateLocationByName(db, name, null, "room");

    // Give the call time to reach its blocked INSERT, then commit the winner.
    await new Promise((r) => setTimeout(r, 100));
    releaseWinner();

    const [, result] = await Promise.all([winner, loser]);

    // Recovered onto the winner's row — no throw, no duplicate.
    expect(result.created).toBe(false);
    expect(result.locationId).toEqual(winnerId);

    const [countRow] = await getDb(db)
      .select({ count: count() })
      .from(location)
      .where(eq(location.name, name));
    expect(countRow!.count).toEqual(1);
  });
});
