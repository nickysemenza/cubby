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
import {
  PUBLIC_SHORTCODE_PREFIXES,
  generateShortcode,
  parseShortcodeFor,
  SHORTCODE_PREFIX,
} from "@cubby/shared";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, expectTypeOf, it } from "vitest";

import { location, product } from "~/server/db/schema";

import { getDb } from "./database-helpers";
import {
  createLocationFixture as createLocation,
  createProductFixture as createProduct,
  makeLocationInput,
  makeProductInput,
} from "./repo.fixtures";
import {
  lookupShortcodes,
  resolveLiveShortcode,
  resolveShortcode,
  resolveShortcodes,
} from "./shortcode-resolver";
import {
  generateUniqueShortcode,
  insertWithShortcode,
  type ShortcodeGeneratorPort,
  SHORTCODE_TABLE,
} from "./shortcode-utils";

interface PinnedShortcodeGenerator {
  readonly port: ShortcodeGeneratorPort;
  readonly pin: (shortcode: string) => void;
}

function createPinnedShortcodeGenerator(): PinnedShortcodeGenerator {
  let pinned: string | undefined;
  return {
    port: {
      generate(entity) {
        const shortcode = pinned;
        pinned = undefined;
        return shortcode === undefined
          ? generateShortcode(entity)
          : parseShortcodeFor(entity, shortcode);
      },
    },
    pin(shortcode) {
      pinned = shortcode;
    },
  };
}

describe("shortcode minting", () => {
  const ctx = withTestDb();

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
    const generator = createPinnedShortcodeGenerator();
    generator.pin(retired);
    expect(
      await generateUniqueShortcode(ctx.db, "location", generator.port),
    ).not.toBe(retired);

    // And the index must reject it even if something bypassed the pre-check.
    // This is the case the old partial `WHERE deletedAt IS NULL` index allowed,
    // and how 269 production codes ended up owned by two rows.
    await expect(
      getDb(ctx.db)
        .insert(location)
        .values({ name: "New Shelf", type: "shelf", shortcode: retired }),
      // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    ).rejects.toThrow();
  });
});

describe("insertWithShortcode", () => {
  const ctx = withTestDb();

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

      const generator = createPinnedShortcodeGenerator();
      generator.pin(contested);
      const created = await insertWithShortcode(
        tx,
        "product",
        {
          name: "Retried",
          manufacturer: "ACME",
        },
        generator.port,
      );
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
    // One per payload table plus the identity table, which alone still holds
    // a hard-deleted payload's code.
    expect(found).toHaveLength(PUBLIC_SHORTCODE_PREFIXES.length + 1);
    expect(found.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        "LedgerTransfer_shortcode_unique",
        "Entity_shortcode_unique",
      ]),
    );
    for (const row of found) {
      expect(row.partial, `${row.indexname} must not be partial`).toBe(false);
    }
  });
});
