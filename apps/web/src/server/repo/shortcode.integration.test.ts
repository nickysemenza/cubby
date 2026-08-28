/**
 * The shortcode invariants, against a real Postgres.
 *
 * These are DB-level guarantees, not TypeScript ones — the unique index is the
 * authority, and the point of most of these cases is that the index (not the
 * pre-check, which any concurrent writer can invalidate) is what holds the line.
 */

import { entityRefKey } from "@cubby/schemas/entity";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import type {
  ImageShortcode,
  IngredientShortcode,
  ProductId,
  ProductShortcode,
} from "@cubby/schemas/identifiers";
import type * as Shared from "@cubby/shared";
import {
  PUBLIC_SHORTCODE_PREFIXES,
  parseShortcode,
  SHORTCODE_PREFIX,
} from "@cubby/shared";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { location, product } from "~/server/db/schema";

import { getDb } from "./database-helpers";
import { getLocationByShortcode } from "./location";
import { getProductByShortcode } from "./product";
import { getRecipeByShortcode } from "./recipe";
import {
  createLocationFixture as createLocation,
  createProductFixture as createProduct,
  makeLocationInput,
  makeProductInput,
} from "./repo.fixtures";
import {
  lookupShortcodes,
  resolveAllOrThrow,
  resolveAllPresent,
  resolveLiveShortcode,
  resolveLiveShortcodes,
  resolveShortcode,
  resolveShortcodes,
} from "./shortcode-resolver";
import {
  findOrCreateWithShortcode,
  generateUniqueShortcode,
  insertWithShortcode,
  SHORTCODE_TABLE,
} from "./shortcode-utils";

let nextCode: string | null = null;
vi.mock("@cubby/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof Shared>();
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
    expect(parseShortcode(created.id)).toMatchObject({
      type: "location",
      legacy: false,
    });
  });

  it("covers every shortcode-bearing entity with a table", () => {
    for (const entity of shortcodeEntities) {
      expect(SHORTCODE_TABLE[entity]).toBeDefined();
    }
  });

  it("preserves exact entity brands through generic minting", async () => {
    expectTypeOf(
      await generateUniqueShortcode(ctx.db, "product"),
    ).toEqualTypeOf<ProductShortcode>();
    expectTypeOf(
      await generateUniqueShortcode(ctx.db, "ingredient"),
    ).toEqualTypeOf<IngredientShortcode>();
    expectTypeOf(
      await generateUniqueShortcode(ctx.db, "image"),
    ).toEqualTypeOf<ImageShortcode>();
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
    const retired = created.id;

    await getDb(ctx.db)
      .update(location)
      .set({ deletedAt: new Date() })
      .where(eq(location.id, created.entityId));

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

    await new Promise((r) => setTimeout(r, 100));

    nextCode = contested;
    const loser = insertWithShortcode(ctx.db, "product", {
      name: "Loser",
      manufacturer: "ACME",
    });

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

    nextCode = squatter.id;
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
    expect(row.shortcode).not.toBe(squatter.id);
  });

  it("blames the right index when the conflict is not the shortcode", async () => {
    // Same silent-insert symptom as the case above, different cause: the values
    // violate a unique index the `where` cannot see (here `Location_name_key`,
    // while `where` keys on the type). Retrying is pointless — a fresh code
    // changes nothing — and reporting it as a shortcode collision sends the
    // reader hunting the wrong index, which is exactly what happened to the
    // sub-recipe link ingredient. The minted code is verified before retrying,
    // so this reports the real shape instead.
    await createLocation(
      ctx.db,
      makeLocationInput({ name: "Occupied Bin" }),
      ctx.actor,
    );

    await expect(
      findOrCreateWithShortcode(ctx.db, "location", {
        where: eq(location.type, "freezer"),
        values: () => ({ name: "Occupied Bin", type: "shelf" as const }),
      }),
    ).rejects.toThrow(/unique index that `where` does not cover/);
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
    const canonical = created.id;
    const legacy = `P-${canonical.slice(SHORTCODE_PREFIX.product.length)}`;

    const byCanonical = await resolveShortcode(ctx.db, canonical);
    expect(byCanonical).toEqual({ entity: "product", id: created.entityId });
    if (byCanonical?.entity === "product") {
      expectTypeOf(byCanonical.id).toEqualTypeOf<ProductId>();
    }
    expect(await resolveShortcode(ctx.db, legacy)).toEqual(byCanonical);
    expect(await resolveShortcode(ctx.db, ` ${legacy.toLowerCase()} `)).toEqual(
      byCanonical,
    );
  });

  it("returns null for a malformed or unknown code", async () => {
    expect(await resolveShortcode(ctx.db, "nonsense")).toBeNull();
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
      prod.id,
      loc.id,
      "PRD-2222",
      "garbage",
    ]);
    expect(resolved.get(prod.id)).toEqual({
      entity: "product",
      id: prod.entityId,
    });
    expect(resolved.get(loc.id)).toEqual({
      entity: "location",
      id: loc.entityId,
    });
    expect(resolved.size).toBe(2);
  });

  it("preserves input order and duplicates across canonical and legacy spellings", async () => {
    const prod = await createProduct(
      ctx.db,
      makeProductInput({ name: "Mixed Resolver Product" }),
      ctx.actor,
    );
    const loc = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Mixed Resolver Location" }),
      ctx.actor,
    );
    const productLegacy = `P-${prod.id.slice(SHORTCODE_PREFIX.product.length)}`;
    const locationLegacy = `L-${loc.id.slice(SHORTCODE_PREFIX.location.length)}`;
    const productInputs = [
      ` ${productLegacy.toLowerCase()} `,
      prod.id,
      productLegacy,
      prod.id,
    ];

    const live = await resolveLiveShortcodes(ctx.db, productInputs, "product");
    expect(productInputs.map((code) => live.get(code))).toEqual([
      prod.entityId,
      prod.entityId,
      prod.entityId,
      prod.entityId,
    ]);
    expect(await resolveAllOrThrow(ctx.db, "product", productInputs)).toEqual([
      prod.entityId,
      prod.entityId,
      prod.entityId,
      prod.entityId,
    ]);
    expect(
      await resolveAllPresent(ctx.db, "product", [
        productLegacy,
        "PRD-2222",
        prod.id,
        locationLegacy,
        productLegacy,
      ]),
    ).toEqual([prod.entityId, prod.entityId, prod.entityId]);

    const mixed = await resolveShortcodes(ctx.db, [
      productLegacy,
      ` ${locationLegacy.toLowerCase()} `,
      prod.id,
      loc.id,
    ]);
    expect([...mixed.keys()]).toEqual(
      expect.arrayContaining([prod.id, loc.id]),
    );
    expect(mixed.get(prod.id)).toEqual({
      entity: "product",
      id: prod.entityId,
    });
    expect(mixed.get(loc.id)).toEqual({
      entity: "location",
      id: loc.entityId,
    });
    expect(mixed.size).toBe(2);
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
      { entity: "product", id: prod.entityId },
      { entity: "location", id: loc.entityId },
    ]);
    expect(codes.get(entityRefKey("product", prod.entityId))).toBe(prod.id);
    expect(codes.get(entityRefKey("location", loc.entityId))).toBe(loc.id);
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

    expect(await resolveLiveShortcode(ctx.db, prod.id, "product")).toBe(
      prod.entityId,
    );
    const legacy = `P-${prod.id.slice(SHORTCODE_PREFIX.product.length)}`;
    expect(await resolveLiveShortcode(ctx.db, legacy, "product")).toBe(
      prod.entityId,
    );

    // A real, resolvable code for the WRONG entity must not leak a uuid.
    expect(await resolveLiveShortcode(ctx.db, loc.id, "product")).toBeNull();

    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, prod.entityId));
    expect(await resolveLiveShortcode(ctx.db, prod.id, "product")).toBeNull();
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

    expect(await getProductByShortcode(ctx.db, prod.id)).toMatchObject({
      id: prod.id,
    });
    expect(await getLocationByShortcode(ctx.db, loc.id)).toMatchObject({
      id: loc.id,
    });

    expect(await getProductByShortcode(ctx.db, "PRD-2222")).toBeNull();
    expect(await getProductByShortcode(ctx.db, "not-a-code")).toBeNull();
    expect(await getProductByShortcode(ctx.db, loc.id)).toBeNull();
    expect(await getLocationByShortcode(ctx.db, "LOC-2222")).toBeNull();
    expect(await getRecipeByShortcode(ctx.db, "RCP-2222")).toBeNull();
  });

  it("lookupShortcodes finds a soft-deleted row's code, unlike resolveLiveShortcodes", async () => {
    // Regression test for the load-bearing difference the resolver's comments
    // describe but no test previously asserted: resolveLiveShortcode(s) filter
    // to live rows (a mismatched/deleted code must not leak a uuid), while
    // lookupShortcodes is the uuid -> code reverse lookup used to render
    // already-assembled payloads, and must still find a row deleted after
    // that payload was built.
    const prod = await createProduct(
      ctx.db,
      makeProductInput({ name: "Deleted Product" }),
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, prod.entityId));

    expect(await resolveLiveShortcodes(ctx.db, [prod.id], "product")).toEqual(
      new Map(),
    );

    const codes = await lookupShortcodes(ctx.db, [
      { entity: "product", id: prod.entityId },
    ]);
    expect(codes.get(entityRefKey("product", prod.entityId))).toBe(prod.id);
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
      .where(eq(location.id, created.entityId));

    expect(await resolveShortcode(ctx.db, created.id)).toEqual({
      entity: "location",
      id: created.entityId,
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
    expect(found).toHaveLength(PUBLIC_SHORTCODE_PREFIXES.length);
    expect(found.map((row) => row.indexname)).toContain(
      "LedgerTransfer_shortcode_unique",
    );
    for (const row of found) {
      expect(row.partial, `${row.indexname} must not be partial`).toBe(false);
    }
  });
});
