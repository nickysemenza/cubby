/**
 * The shortcode invariants, against a real Postgres.
 *
 * These are DB-level guarantees, not TypeScript ones — the unique index is the
 * authority, and the point of most of these cases is that the index (not the
 * pre-check, which any concurrent writer can invalidate) is what holds the line.
 */

import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { parseShortcode, SHORTCODE_PREFIX } from "@cubby/shared";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";
import { location, product } from "~/server/db/schema";

import { getDb } from "./database-helpers";
import { createLocation, getLocationByShortcode } from "./location";
import { createProduct, getProductByShortcode } from "./product";
import { getRecipeByShortcode } from "./recipe";
import { makeLocationInput, makeProductInput } from "./repo.fixtures";
import {
  lookupShortcodes,
  refKey,
  resolveLiveShortcode,
  resolveShortcode,
  resolveShortcodes,
} from "./shortcode-resolver";
import {
  findOrCreateWithShortcode,
  generateUniqueShortcode,
  insertWithShortcode,
  SHORTCODE_TABLE,
} from "./shortcode-utils";

/**
 * Lets one test pin the next generated code so a collision can be forced on
 * demand. Everything else falls through to the real generator.
 */
let nextCode: string | null = null;
vi.mock("@cubby/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cubby/shared")>();
  return {
    ...actual,
    generateShortcode: (
      entity: Parameters<typeof actual.generateShortcode>[0],
    ) => {
      if (nextCode !== null) {
        const pinned = nextCode;
        nextCode = null;
        return pinned;
      }
      return actual.generateShortcode(entity);
    },
  };
});

afterEach(() => {
  nextCode = null;
});

describe("shortcode minting", () => {
  const ctx = withTestDb();

  it("stamps a canonical code on every created entity", async () => {
    const created = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Pantry" }),
      ctx.actor,
    );
    expect(parseShortcode(created.shortcode)).toMatchObject({
      type: "location",
      legacy: false,
    });
  });

  it("covers every shortcode-bearing entity with a table", () => {
    // Catches "added an entity to the manifest, forgot the table mapping" —
    // which would otherwise surface as a runtime undefined deep in a resolver.
    for (const entity of shortcodeEntities) {
      expect(SHORTCODE_TABLE[entity]).toBeDefined();
    }
  });
});

describe("uniqueness spans soft-deleted rows", () => {
  const ctx = withTestDb();

  it("refuses to reissue a soft-deleted row's code", async () => {
    const created = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Old Shelf" }),
      ctx.actor,
    );
    const retired = created.shortcode;

    await getDb(ctx.db)
      .update(location)
      .set({ deletedAt: new Date() })
      .where(eq(location.id, created.id));

    // The pre-check must see the tombstone. (Pinning the generator makes this
    // exact rather than probabilistic: it hands out the retired code, and
    // generateUniqueShortcode has to reject it and try again.)
    nextCode = retired;
    expect(await generateUniqueShortcode(ctx.db, "location")).not.toBe(retired);

    // And the index must reject it even if something bypassed the pre-check.
    // This is the case the old partial `WHERE deletedAt IS NULL` index allowed,
    // and how 269 production codes ended up owned by two rows.
    await expect(
      getDb(ctx.db)
        .insert(location)
        .values({ name: "New Shelf", type: "shelf", shortcode: retired }),
    ).rejects.toThrow();
  });
});

describe("insertWithShortcode", () => {
  const ctx = withTestDb();

  it("retries onto a fresh code when it loses the insert race", async () => {
    // The real race, deterministically forced: a "winner" transaction inserts
    // the code we are about to be handed and holds its lock open. Our pre-check
    // can't see the uncommitted row, so it approves the code; the INSERT then
    // blocks on the index and fails 23505 once the winner commits. The retry is
    // the only thing standing between that and a 500.
    const contested = `${SHORTCODE_PREFIX.product}ZZZZ`;

    let releaseWinner!: () => void;
    const winnerCommitted = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });

    const winner = getDb(ctx.db).transaction(async (tx) => {
      await tx.insert(product).values({
        name: "Winner",
        manufacturer: "ACME",
        shortcode: contested,
      });
      await winnerCommitted; // hold the txn (and its index lock) open
    });

    // Let the winner reach (and hold) its uncommitted INSERT.
    await new Promise((r) => setTimeout(r, 100));

    nextCode = contested;
    const loser = insertWithShortcode(ctx.db, "product", {
      name: "Loser",
      manufacturer: "ACME",
    });

    // Give our insert time to reach its blocked state, then commit the winner.
    await new Promise((r) => setTimeout(r, 100));
    releaseWinner();

    const [, created] = await Promise.all([winner, loser]);

    expect(created.shortcode).not.toBe(contested);
    expect(parseShortcode(created.shortcode)).toMatchObject({
      type: "product",
    });
  });

  it("findOrCreateWithShortcode retries a collision instead of failing the find", async () => {
    // `findOrCreate`'s insert uses a BARE `onConflictDoNothing()`, which isn't
    // scoped to the `where` predicate's index. So a shortcode collision — on a
    // row entirely unrelated to the name being deduped on — silently inserts
    // nothing, and the follow-up re-SELECT finds no winner. Without the retry
    // that surfaces as "insert conflicted but no matching row was found".
    const squatter = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Squatter Bin" }),
      ctx.actor,
    );

    nextCode = squatter.shortcode;
    const { row, created } = await findOrCreateWithShortcode(
      ctx.db,
      "location",
      {
        where: eq(location.name, "Brand New Bin"),
        values: () => ({ name: "Brand New Bin", type: "shelf" as const }),
      },
    );

    expect(created).toBe(true);
    expect(row.name).toBe("Brand New Bin");
    expect(row.shortcode).not.toBe(squatter.shortcode);
  });

  it("survives a collision inside an open transaction via its savepoint", async () => {
    // Without the SAVEPOINT the 23505 aborts the CALLER's transaction, and every
    // later statement in it fails with "current transaction is aborted" — the
    // retry would be strictly worse than no retry at all. So: force a collision
    // inside a transaction, then keep using that same transaction.
    const contested = `${SHORTCODE_PREFIX.product}YYYY`;

    await getDb(ctx.db).transaction(async (tx) => {
      await tx.insert(product).values({
        name: "Squatter",
        manufacturer: "ACME",
        shortcode: contested,
      });

      nextCode = contested;
      const created = await insertWithShortcode(tx, "product", {
        name: "Retried",
        manufacturer: "ACME",
      });
      expect(created.shortcode).not.toBe(contested);

      // The caller's transaction is still alive — this is the assertion that
      // fails loudly if the savepoint is ever removed.
      const rows = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(product);
      expect(rows[0]?.n).toBeGreaterThanOrEqual(2);
    });
  });
});

describe("resolution", () => {
  const ctx = withTestDb();

  it("resolves a canonical code, and its legacy spelling, to the same row", async () => {
    const created = await createProduct(
      ctx.db,
      makeProductInput({ name: "Canned Beans" }),
      ctx.actor,
    );
    const canonical = created.shortcode;
    const legacy = `P-${canonical.slice(SHORTCODE_PREFIX.product.length)}`;

    const byCanonical = await resolveShortcode(ctx.db, canonical);
    expect(byCanonical).toEqual({ entity: "product", id: created.id });
    // The promise the cutover makes to labels already stuck to things.
    expect(await resolveShortcode(ctx.db, legacy)).toEqual(byCanonical);
    expect(await resolveShortcode(ctx.db, ` ${legacy.toLowerCase()} `)).toEqual(
      byCanonical,
    );
  });

  it("returns null for a malformed or unknown code", async () => {
    expect(await resolveShortcode(ctx.db, "nonsense")).toBeNull();
    // 0/O/I/L are outside the alphabet, so this is malformed, not just unknown.
    expect(await resolveShortcode(ctx.db, "PRD-0OIL")).toBeNull();
    expect(await resolveShortcode(ctx.db, "PRD-2222")).toBeNull();
  });

  it("batches a mixed-entity lookup and drops unresolvable codes", async () => {
    const prod = await createProduct(
      ctx.db,
      makeProductInput({ name: "Rice" }),
      ctx.actor,
    );
    const loc = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Bin" }),
      ctx.actor,
    );

    const resolved = await resolveShortcodes(ctx.db, [
      prod.shortcode,
      loc.shortcode,
      "PRD-2222",
      "garbage",
    ]);
    expect(resolved.get(prod.shortcode)).toEqual({
      entity: "product",
      id: prod.id,
    });
    expect(resolved.get(loc.shortcode)).toEqual({
      entity: "location",
      id: loc.id,
    });
    expect(resolved.size).toBe(2);
  });

  it("looks codes back up from ids, keyed per entity", async () => {
    const prod = await createProduct(
      ctx.db,
      makeProductInput({ name: "Flour" }),
      ctx.actor,
    );
    const loc = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Shelf" }),
      ctx.actor,
    );

    const codes = await lookupShortcodes(ctx.db, [
      { entity: "product", id: prod.id },
      { entity: "location", id: loc.id },
    ]);
    expect(codes.get(refKey("product", prod.id))).toBe(prod.shortcode);
    expect(codes.get(refKey("location", loc.id))).toBe(loc.shortcode);
  });

  it("resolveLiveShortcode pins the entity and excludes deleted rows", async () => {
    const prod = await createProduct(
      ctx.db,
      makeProductInput({ name: "Lentils" }),
      ctx.actor,
    );
    const loc = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Crate" }),
      ctx.actor,
    );

    expect(await resolveLiveShortcode(ctx.db, prod.shortcode, "product")).toBe(
      prod.id,
    );
    // Legacy spelling resolves the same way here too.
    const legacy = `P-${prod.shortcode.slice(SHORTCODE_PREFIX.product.length)}`;
    expect(await resolveLiveShortcode(ctx.db, legacy, "product")).toBe(prod.id);

    // A real, resolvable code for the WRONG entity must not leak a uuid.
    expect(
      await resolveLiveShortcode(ctx.db, loc.shortcode, "product"),
    ).toBeNull();

    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, prod.id));
    expect(
      await resolveLiveShortcode(ctx.db, prod.shortcode, "product"),
    ).toBeNull();
  });

  it("the public getXByShortcode wrappers return null, never throw", async () => {
    // The repo wrappers each entity's detail route enters through. Their null
    // branch is the one a user hits by typing a URL, so it must return rather
    // than throw the NOT_FOUND AppError `getByID` raises.
    const prod = await createProduct(
      ctx.db,
      makeProductInput({ name: "Barley" }),
      ctx.actor,
    );
    const loc = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Cupboard" }),
      ctx.actor,
    );

    expect(await getProductByShortcode(ctx.db, prod.shortcode)).toMatchObject({
      id: prod.id,
    });
    expect(await getLocationByShortcode(ctx.db, loc.shortcode)).toMatchObject({
      id: loc.id,
    });

    // Unknown, malformed, and wrong-entity codes all resolve to null.
    expect(await getProductByShortcode(ctx.db, "PRD-2222")).toBeNull();
    expect(await getProductByShortcode(ctx.db, "not-a-code")).toBeNull();
    expect(await getProductByShortcode(ctx.db, loc.shortcode)).toBeNull();
    expect(await getLocationByShortcode(ctx.db, "LOC-2222")).toBeNull();
    expect(await getRecipeByShortcode(ctx.db, "RCP-2222")).toBeNull();
  });

  it("still resolves a soft-deleted row, so a scan can say what was deleted", async () => {
    const created = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Retired Bin" }),
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(location)
      .set({ deletedAt: new Date() })
      .where(eq(location.id, created.id));

    // Deliberate: resolution answers "what does this code name", which stays
    // true after a delete. The 404 comes from the subsequent live-row fetch.
    expect(await resolveShortcode(ctx.db, created.shortcode)).toEqual({
      entity: "location",
      id: created.id,
    });
  });
});

describe("schema-level invariants", () => {
  const ctx = withTestDb();

  it("has a non-partial unique index for every shortcode table", async () => {
    // A partial index would silently restore the pre-cutover hole: codes
    // becoming available again once their owner is soft-deleted.
    const { rows: found } = await getDb(ctx.db).execute<{
      indexname: string;
      partial: boolean;
    }>(sql`
      SELECT indexname, indexdef LIKE '%WHERE%' AS partial
      FROM pg_indexes
      WHERE schemaname = 'public' AND indexname LIKE '%\\_shortcode\\_unique'
    `);
    expect(found).toHaveLength(shortcodeEntities.length);
    for (const row of found) {
      expect(row.partial, `${row.indexname} must not be partial`).toBe(false);
    }
  });
});
