import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

/**
 * Turn Cubby's former forest of top-level Locations into one real `Home` root.
 *
 * Run this immediately before deploying the compatible application code
 * (including the `house` Location type), keeping the cutover interval short.
 *
 * Usage:
 *   # Review the exact cutover. This is the default and rolls back.
 *   pnpm --filter @cubby/web db:create-home-location
 *
 *   # Apply the reviewed cutover.
 *   pnpm --filter @cubby/web db:create-home-location -- --write
 *
 * The script deliberately uses SQL rather than the Location repo: it needs to
 * change every root and its persisted rollup atomically. It is idempotent by
 * final state: a completed run sees the one Home root and makes no hierarchy
 * changes, while a second `--write` merely recomputes the same valuations.
 */

const WRITE = process.argv.includes("--write");
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

type Aggregate = {
  stockCount: string;
  stockValue: string;
  installedCount: string;
  installedValue: string;
};

type LocationRow = {
  id: string;
  shortcode: string;
  name: string;
  parentId: string | null;
  productId: string | null;
  type: string | null;
};

const mintShortcode = () =>
  `LOC-${Array.from({ length: 4 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("")}`;

const aggregateSql = `
  SELECT
    count(*) FILTER (WHERE placement = 'stock')::text AS "stockCount",
    COALESCE(sum(valuation) FILTER (WHERE placement = 'stock' AND valuation > 0), 0)::text AS "stockValue",
    count(*) FILTER (WHERE placement = 'installed')::text AS "installedCount",
    COALESCE(sum(valuation) FILTER (WHERE placement = 'installed' AND valuation > 0), 0)::text AS "installedValue"
  FROM "InventoryEntry"
  WHERE "deletedAt" IS NULL
`;

/**
 * Mirrors LocationValuationService's direct + descendant rollup. Keeping the
 * pricing predicates aligned with product/pricing.ts matters: a product-linked
 * vessel contributes its effective price to its parent's container bucket.
 */
const recomputeValuationsSql = `
  WITH RECURSIVE
  live_locations AS (
    SELECT id, "parentId", "productId"
    FROM "Location"
    WHERE "deletedAt" IS NULL
  ),
  product_prices AS (
    SELECT p.id,
      COALESCE(
        p.price,
        (
          SELECT round((sum(e.cost) / NULLIF(sum(abs(e."productQuantity")), 0))::numeric, 2)::double precision
          FROM "Expense" e
          WHERE e."productId" = p.id
            AND e."deletedAt" IS NULL
            AND e.future = false
            AND e."lineKind" = 'principal'
            AND e.cost > 0
            AND e."productQuantity" IS NOT NULL
        )
      ) AS price
    FROM "Product" p
    WHERE p."deletedAt" IS NULL
  ),
  direct_inventory AS (
    SELECT
      ie."locationId" AS id,
      count(*) FILTER (WHERE ie.placement = 'stock')::int AS stock_count,
      COALESCE(sum(ie.valuation) FILTER (WHERE ie.placement = 'stock' AND ie.valuation > 0), 0) AS stock_value,
      count(*) FILTER (WHERE ie.placement = 'stock' AND ie.valuation > 0)::int AS stock_priced,
      count(*) FILTER (WHERE ie.placement = 'stock' AND (ie.valuation IS NULL OR ie.valuation <= 0) AND lower(p.name) LIKE 'misc:%')::int AS stock_misc,
      count(*) FILTER (WHERE ie.placement = 'stock' AND (ie.valuation IS NULL OR ie.valuation <= 0) AND lower(p.name) NOT LIKE 'misc:%')::int AS stock_missing,
      count(*) FILTER (WHERE ie.placement = 'installed')::int AS installed_count,
      COALESCE(sum(ie.valuation) FILTER (WHERE ie.placement = 'installed' AND ie.valuation > 0), 0) AS installed_value
    FROM "InventoryEntry" ie
    JOIN "Product" p ON p.id = ie."productId"
    WHERE ie."deletedAt" IS NULL
    GROUP BY ie."locationId"
  ),
  direct_containers AS (
    SELECT l."parentId" AS id,
      count(*) FILTER (WHERE pp.price IS NOT NULL)::int AS container_count,
      COALESCE(sum(pp.price), 0) AS container_value
    FROM live_locations l
    JOIN product_prices pp ON pp.id = l."productId"
    WHERE l."parentId" IS NOT NULL
    GROUP BY l."parentId"
  ),
  direct AS (
    SELECT l.id,
      COALESCE(i.stock_count, 0)::int AS stock_count,
      COALESCE(i.stock_value, 0)::double precision AS stock_value,
      COALESCE(i.stock_priced, 0)::int AS stock_priced,
      COALESCE(i.stock_missing, 0)::int AS stock_missing,
      COALESCE(i.stock_misc, 0)::int AS stock_misc,
      COALESCE(i.installed_count, 0)::int AS installed_count,
      COALESCE(i.installed_value, 0)::double precision AS installed_value,
      COALESCE(c.container_count, 0)::int AS container_count,
      COALESCE(c.container_value, 0)::double precision AS container_value
    FROM live_locations l
    LEFT JOIN direct_inventory i ON i.id = l.id
    LEFT JOIN direct_containers c ON c.id = l.id
  ),
  ancestors AS (
    SELECT id AS origin_id, id AS ancestor_id, "parentId"
    FROM live_locations
    UNION ALL
    SELECT a.origin_id, parent.id, parent."parentId"
    FROM ancestors a
    JOIN live_locations parent ON parent.id = a."parentId"
  ),
  totals AS (
    SELECT a.ancestor_id AS id,
      sum(d.stock_count)::int AS stock_count,
      sum(d.stock_value)::double precision AS stock_value,
      sum(d.stock_priced)::int AS stock_priced,
      sum(d.stock_missing)::int AS stock_missing,
      sum(d.stock_misc)::int AS stock_misc,
      sum(d.installed_count)::int AS installed_count,
      sum(d.installed_value)::double precision AS installed_value,
      sum(d.container_count)::int AS container_count,
      sum(d.container_value)::double precision AS container_value
    FROM ancestors a
    JOIN direct d ON d.id = a.origin_id
    GROUP BY a.ancestor_id
  )
  UPDATE "Location" l
  SET valuation = jsonb_build_object(
    'directValuation', round(d.stock_value::numeric, 2),
    'totalValuation', round(t.stock_value::numeric, 2),
    'directItemCount', d.stock_count,
    'totalItemCount', t.stock_count,
    'direct', jsonb_build_object('priced', d.stock_priced, 'missingPricing', d.stock_missing, 'miscNoPrice', d.stock_misc),
    'total', jsonb_build_object('priced', t.stock_priced, 'missingPricing', t.stock_missing, 'miscNoPrice', t.stock_misc),
    'installed', jsonb_build_object(
      'directValuation', round(d.installed_value::numeric, 2),
      'totalValuation', round(t.installed_value::numeric, 2),
      'directItemCount', d.installed_count,
      'totalItemCount', t.installed_count
    ),
    'container', jsonb_build_object(
      'directValuation', round(d.container_value::numeric, 2),
      'totalValuation', round(t.container_value::numeric, 2),
      'directItemCount', d.container_count,
      'totalItemCount', t.container_count
    )
  )
  FROM direct d
  JOIN totals t ON t.id = d.id
  WHERE l.id = d.id
`;

function aggregateEquals(a: Aggregate, b: Aggregate): boolean {
  const cents = (value: string) => Math.round(Number(value) * 100);

  return (
    a.stockCount === b.stockCount &&
    cents(a.stockValue) === cents(b.stockValue) &&
    a.installedCount === b.installedCount &&
    cents(a.installedValue) === cents(b.installedValue)
  );
}

async function assertValidExistingTree(client: Client): Promise<void> {
  const { rows: dangling } = await client.query<{ id: string }>(`
    SELECT child.id
    FROM "Location" child
    LEFT JOIN "Location" parent
      ON parent.id = child."parentId" AND parent."deletedAt" IS NULL
    WHERE child."deletedAt" IS NULL
      AND child."parentId" IS NOT NULL
      AND parent.id IS NULL
    LIMIT 1
  `);
  if (dangling.length > 0)
    throw new Error(
      "Refusing to run: a live Location has a missing/deleted parent.",
    );

  const { rows: cycles } = await client.query<{ id: string }>(`
    WITH RECURSIVE walk AS (
      SELECT id, "parentId", ARRAY[id] AS path, false AS cycle
      FROM "Location" WHERE "deletedAt" IS NULL
      UNION ALL
      SELECT walk.id, parent."parentId", walk.path || parent.id,
             parent.id = ANY(walk.path)
      FROM walk
      JOIN "Location" parent ON parent.id = walk."parentId" AND parent."deletedAt" IS NULL
      WHERE NOT walk.cycle
    )
    SELECT id FROM walk WHERE cycle LIMIT 1
  `);
  if (cycles.length > 0)
    throw new Error(
      "Refusing to run: the live Location hierarchy already has a cycle.",
    );
}

async function createHome(client: Client): Promise<LocationRow> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const shortcode = mintShortcode();
    try {
      const { rows } = await client.query<LocationRow>(
        `INSERT INTO "Location" (id, shortcode, name, type, "parentId")
         VALUES ($1, $2, 'Home', 'house', NULL)
         RETURNING id, shortcode, name, "parentId", "productId", type`,
        [randomUUID(), shortcode],
      );
      const home = rows[0];
      if (!home) throw new Error("Home insert returned no row.");
      return home;
    } catch (error: unknown) {
      // A shortcode collision is harmless to retry. This is an attended,
      // one-time household cutover, not a concurrent provisioning API.
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new Error(
    "Could not mint a unique Home location shortcode after 20 attempts.",
  );
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set.");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await client.query("BEGIN");
    await assertValidExistingTree(client);

    const { rows: namedHomes } = await client.query<LocationRow>(`
      SELECT id, shortcode, name, "parentId", "productId", type
      FROM "Location"
      WHERE "deletedAt" IS NULL AND lower(name) = 'home'
      FOR UPDATE
    `);
    if (namedHomes.length > 1)
      throw new Error(
        "Refusing to run: more than one live Location is named Home.",
      );

    let home = namedHomes[0] ?? null;
    if (home && home.parentId !== null)
      throw new Error("Refusing to run: the existing Home is not a root.");
    if (home?.productId)
      throw new Error(
        "Refusing to run: the existing Home is linked to a Product.",
      );
    if (!home) {
      home = await createHome(client);
      console.log(`Created ${home.shortcode} Home root.`);
    } else {
      await client.query(
        `UPDATE "Location" SET type = 'house' WHERE id = $1 AND type IS DISTINCT FROM 'house'`,
        [home.id],
      );
      console.log(`Adopting ${home.shortcode} as the Home root.`);
    }

    const { rows: homeInventory } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "InventoryEntry" WHERE "deletedAt" IS NULL AND "locationId" = $1`,
      [home.id],
    );
    if ((homeInventory[0]?.n ?? "0") !== "0")
      throw new Error("Refusing to run: Home has direct live inventory.");

    const before = (await client.query<Aggregate>(aggregateSql)).rows[0];
    if (!before)
      throw new Error("Could not read pre-cutover inventory aggregate.");

    const { rows: roots } = await client.query<LocationRow>(
      `SELECT id, shortcode, name, "parentId", "productId", type
       FROM "Location"
       WHERE "deletedAt" IS NULL AND "parentId" IS NULL AND id <> $1
       FOR UPDATE`,
      [home.id],
    );
    const unknownRoots = roots.filter(
      (row) => row.name.toLowerCase() === "unknown",
    );
    console.log(
      `Reparenting ${roots.length} former root(s) under ${home.shortcode}` +
        (unknownRoots.length > 0
          ? `, including ${unknownRoots.map((row) => row.shortcode).join(", ")}.`
          : "."),
    );
    if (roots.length > 0) {
      await client.query(
        `UPDATE "Location" SET "parentId" = $1
         WHERE "deletedAt" IS NULL AND "parentId" IS NULL AND id <> $1`,
        [home.id],
      );
    }

    const recomputed = await client.query(recomputeValuationsSql);
    console.log(
      `Recomputed valuations for ${recomputed.rowCount ?? 0} live location(s).`,
    );

    const { rows: finalRoots } = await client.query<LocationRow>(`
      SELECT id, shortcode, name, "parentId", "productId", type
      FROM "Location" WHERE "deletedAt" IS NULL AND "parentId" IS NULL
    `);
    if (finalRoots.length !== 1 || finalRoots[0]?.id !== home.id)
      throw new Error("Verification failed: Home is not the sole live root.");

    const after = (await client.query<Aggregate>(aggregateSql)).rows[0];
    if (!after || !aggregateEquals(before, after))
      throw new Error(
        "Verification failed: the inventory aggregate changed during the cutover.",
      );

    const { rows: homeValuation } = await client.query<{
      stockCount: string;
      stockValue: string;
      installedCount: string;
      installedValue: string;
    }>(
      `SELECT
         (valuation->>'totalItemCount')::text AS "stockCount",
         (valuation->>'totalValuation')::text AS "stockValue",
         (valuation->'installed'->>'totalItemCount')::text AS "installedCount",
         (valuation->'installed'->>'totalValuation')::text AS "installedValue"
       FROM "Location" WHERE id = $1`,
      [home.id],
    );
    const rolledUp = homeValuation[0];
    if (!rolledUp || !aggregateEquals(before, rolledUp))
      throw new Error(
        "Verification failed: Home's valuation does not equal the inventory aggregate.",
      );

    console.table({ before, after, homeRollup: rolledUp });
    if (WRITE) {
      await client.query("COMMIT");
      console.log("COMMITTED. Home is the sole Location root.");
    } else {
      await client.query("ROLLBACK");
      console.log("DRY RUN — rolled back. Re-run with --write to apply.");
    }
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
