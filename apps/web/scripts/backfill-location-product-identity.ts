import "dotenv/config";
import { Client } from "pg";

/**
 * Give every vessel Location the Product it IS.
 *
 * Locations had no way to say what they are, so the fact was smuggled in as an
 * inventory entry pointing at the container itself — `LOC-PRWD "3 drawer
 * packout"` held one `PRD-3JHA "packout 3 drawer"`. This backfill replaces that
 * cycle with `location.productId`.
 *
 * Usage:
 *   pnpm --filter @cubby/web db:backfill-location-identity
 *   pnpm --filter @cubby/web db:backfill-location-identity -- --write
 *
 * ## Ordering — this script is the EXPAND half only
 *
 * It deliberately does NOT null out `location.type` on the rows it links. The
 * currently deployed worker parses `type` through a non-nullable zod enum, so
 * nulling it before the new code ships breaks every location read in
 * production. Type-nulling and the enum narrowing (16 values -> 9) are the
 * CONTRACT half and belong in a second pass, after deploy.
 *
 * Everything here is backward compatible: a new nullable column the old code
 * ignores, new Product rows, new Location rows, and inventory deletions the old
 * code already handles.
 *
 * ## Three deliberate choices
 *
 * 1. **Raw SQL, not the repo layer.** Same reason as
 *    `backfill-stock-tracked.ts`: `Product.updatedAt` is a data-quality
 *    fingerprint and any Drizzle write bumps it via `$onUpdate`, silently
 *    re-opening cleared exceptions. A plain UPDATE does not.
 * 2. **Idempotent by predicate, not by bookkeeping.** Every statement is
 *    guarded so a re-run is a no-op — products are matched on
 *    `(name, manufacturer)`, links are only written where `productId IS NULL`,
 *    and the ryobi boxes are created only if absent.
 * 3. **Everything in one transaction.** A half-linked tree is worse than an
 *    unlinked one: the union count would read as a partial inventory.
 */

const DRY_RUN = !process.argv.includes("--write");
/**
 * The CONTRACT half: null `type` on every linked location, so the SKU is the
 * only place its form factor lives.
 *
 * Gated behind its own flag because it is only safe once the deployed worker
 * tolerates a null type. Running it early breaks every location read in
 * production — the old code parses `type` through a non-nullable zod enum.
 */
const CONTRACT = process.argv.includes("--contract");

/** Crockford-ish alphabet the repo's shortcodes use — no I/L/O/0/1. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const mintShortcode = (prefix: string) => {
  let out = "";
  for (let i = 0; i < 4; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return `${prefix}-${out}`;
};

/**
 * The four vessel SKUs with no Product row. None carries an Expense: the crates
 * predate the ledger and the milk crates were never a tracked purchase. A
 * Product without spend is legitimate, and the resulting mismatch (33 crate
 * locations against ~2 recorded crate purchases) is a real provenance gap worth
 * surfacing rather than a number to fudge.
 */
const NEW_PRODUCTS = [
  {
    key: "sidio-full",
    name: "SIDIO Crate (Full Size)",
    manufacturer: "SIDIO",
    category: "storage",
    price: 42,
    notes:
      "Full-size SIDIO crate. Decomposed from the SIDIO Crate Basic Pack (2 full + 1 half); the pack keeps the purchase record, this row carries the per-unit identity that locations link to.",
  },
  {
    key: "sidio-half",
    name: "SIDIO Crate (Half Size)",
    manufacturer: "SIDIO",
    category: "storage",
    price: 28,
    notes:
      "Half-size SIDIO crate. Decomposed from the SIDIO Crate Basic Pack (2 full + 1 half).",
  },
  {
    key: "sidio-quarter",
    name: "SIDIO Crate (Quarter Size)",
    manufacturer: "SIDIO",
    category: "storage",
    price: 18,
    notes: "Quarter-size SIDIO crate.",
  },
  {
    key: "milk-crate",
    name: "Milk Crate",
    manufacturer: "generic",
    category: "storage",
    price: 8,
    notes:
      "Generic stackable milk crate. No acquisition Expense identified — these predate the ledger.",
  },
] as const;

/** `location.type` -> the SKU every location of that type is an instance of. */
const BY_TYPE: Record<string, { key?: string; shortcode?: string }> = {
  crate: { key: "sidio-full" },
  "half-crate": { key: "sidio-half" },
  "quarter-crate": { key: "sidio-quarter" },
  "milk-crate": { key: "milk-crate" },
  // The HDX tote line, one SKU per size. 27gal has three candidate SKUs owned
  // (Tough Tote x10, Taxi x3, Project Source x3); the Tough Tote is the
  // standard and the dominant count, so it takes the cohort. The residual shows
  // up as a count gap, which is the honest signal.
  "tote-27gal": { shortcode: "PRD-8WBJ" },
  "tote-14gal": { shortcode: "PRD-87FX" },
  "tote-7gal": { shortcode: "PRD-Y7TZ" },
};

/**
 * The named vessels, matched one at a time because their identity is in the
 * name rather than the type. Locations absent here keep `productId` null —
 * "Spice tub", "document box" and "glass jars" are real containers nobody
 * bought as a catalogued SKU.
 */
const BY_LOCATION: Array<[location: string, product: string, why: string]> = [
  // Packout stack 1
  ["LOC-PKZP", "PRD-R39X", "the stack IS the packout dolly"],
  ["LOC-A7N7", "PRD-6CEV", "4 drawer packout"],
  ["LOC-PRWD", "PRD-3JHA", "3 drawer packout"],
  ["LOC-QHVS", "PRD-MT54", "'uneven' is the multi-depth 3-drawer"],
  ["LOC-2Q4Q", "PRD-6ZTS", "hex bits live in the compact tool box"],
  ["LOC-557V", "PRD-RZWK", "15 in. structured tote"],
  ["LOC-CXBD", "PRD-9CBB", "packout toolbag"],
  // Packout stack 2
  ["LOC-UHKV", "PRD-R39X", "second stack, second dolly"],
  ["LOC-5BD4", "PRD-6CEV", "4 drawer packout"],
  ["LOC-B25P", "PRD-3JHA", "3 drawer packout"],
  ["LOC-4E48", "PRD-JMPY", "2 drawer packout"],
  ["LOC-YJMG", "PRD-JMPY", "2 drawer packout"],
  ["LOC-BKZJ", "PRD-M8HX", "large toolbox packout"],
  // Ryobi stack — the boxes themselves are created below
  ["LOC-G4MG", "PRD-Z7AG", "the stack IS the LINK modular dolly"],
  ["LOC-567F", "PRD-3G6P", "the 11th child is the LINK medium tool box"],
  // Crate dollies
  ["LOC-CYU7", "PRD-GR9G", "SidioSkate rolling tray"],
  ["LOC-RK3Q", "PRD-GR9G", "SidioSkate rolling tray"],
  ["LOC-T245", "PRD-GR9G", "SidioSkate rolling tray"],
  // Carts, benches, racks
  ["LOC-KJ9J", "PRD-V7VQ", "Husky 27 in. 5-drawer rolling cabinet"],
  ["LOC-NGZE", "PRD-VSY6", "Husky 46 in. 9-drawer mobile workbench"],
  ["LOC-N6PB", "PRD-HNAE", "100 lb. capacity welding cart"],
  ["LOC-JU9P", "PRD-NXMT", "modular welding table"],
  ["LOC-647D", "PRD-N33J", "Seville 5-tier wire rack"],
  ["LOC-C8XW", "PRD-HSDX", "Sandusky 4-shelf wire rack"],
  ["LOC-89Z7", "PRD-BX95", "NavePoint 9U server rack"],
];

/**
 * The Ryobi stack is the one case that needs new Locations, not just links.
 * Its 11 children were flat under the cart: 10 content-named drawers that
 * actually live two-per-box across five LINK boxes, plus the toolbox. Pairs
 * confirmed against the physical stack.
 */
const RYOBI_BOXES: Array<{ name: string; drawers: [string, string] }> = [
  { name: "ryobi box — shims & heat guns", drawers: ["LOC-G24D", "LOC-2ACX"] },
  { name: "ryobi box — fittings", drawers: ["LOC-BNGY", "LOC-42FQ"] },
  { name: "ryobi box — abrasives", drawers: ["LOC-Y7JK", "LOC-NT6P"] },
  { name: "ryobi box — welding clamps", drawers: ["LOC-JWV4", "LOC-AYZA"] },
  { name: "ryobi box — clamps", drawers: ["LOC-UA6R", "LOC-8M7A"] },
];

/**
 * Entries whose product became a location in its own right during this
 * backfill, so the predicate sweep below cannot see them — the entry sits on
 * the PARENT, not on the location that now carries the identity.
 *
 * `INV-4V6B` is five LINK boxes recorded as one row at the ryobi stack; the
 * five box Locations replace it. `INV-NS7G` is the medium tool box, now
 * `LOC-567F`. `INV-GWCF` is the structured tote, now `LOC-557V`.
 *
 * The distinction that matters: `INV-PQP7` is a SidioSkate sitting loose in
 * the garage — a genuine spare, not a container in service — so it stays. An
 * entry only leaves when the unit it describes became a Location.
 */
const RELOCATED_ENTRIES = ["INV-4V6B", "INV-NS7G", "INV-GWCF"];

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const log: string[] = [];

  const idFor = async (shortcode: string, table: string) => {
    const res = await client.query(
      `SELECT id FROM "${table}" WHERE shortcode=$1 AND "deletedAt" IS NULL`,
      [shortcode],
    );
    if (!res.rows[0]) throw new Error(`${table} not found: ${shortcode}`);
    return res.rows[0].id as string;
  };

  try {
    await client.query("BEGIN");

    // ---- schema (idempotent; the deployed code ignores the new column) -----
    await client.query(
      `ALTER TABLE "Location" ADD COLUMN IF NOT EXISTS "productId" uuid REFERENCES "Product"("id")`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS "Location_productId_idx" ON "Location"("productId")`,
    );
    await client.query(
      `ALTER TABLE "Location" ALTER COLUMN "type" DROP NOT NULL`,
    );
    log.push("schema: productId column + index, type nullable");

    // ---- the four missing vessel SKUs -------------------------------------
    const productIdByKey = new Map<string, string>();
    for (const p of NEW_PRODUCTS) {
      const existing = await client.query(
        `SELECT id FROM "Product" WHERE name=$1 AND manufacturer=$2 AND "deletedAt" IS NULL`,
        [p.name, p.manufacturer],
      );
      if (existing.rows[0]) {
        productIdByKey.set(p.key, existing.rows[0].id);
        log.push(`product exists: ${p.name}`);
        continue;
      }
      let inserted: { id: string; shortcode: string } | undefined;
      for (let attempt = 0; attempt < 8 && !inserted; attempt++) {
        try {
          const res = await client.query(
            `INSERT INTO "Product" (id, shortcode, name, manufacturer, category, price, notes, aliases, tags, "dataExceptions")
             VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, '{}', '{}', '[]'::jsonb)
             RETURNING id, shortcode`,
            [
              mintShortcode("PRD"),
              p.name,
              p.manufacturer,
              p.category,
              p.price,
              p.notes,
            ],
          );
          inserted = res.rows[0];
        } catch (err) {
          if ((err as { code?: string }).code !== "23505") throw err;
        }
      }
      if (!inserted) throw new Error(`could not mint shortcode for ${p.name}`);
      productIdByKey.set(p.key, inserted.id);
      log.push(`product created: ${inserted.shortcode} ${p.name}`);
    }

    // ---- the ryobi restructure: 5 boxes between cart and drawers ----------
    const ryobiStackId = await idFor("LOC-G4MG", "Location");
    const linkBoxId = await idFor("PRD-7TJ8", "Product");
    for (const box of RYOBI_BOXES) {
      const existing = await client.query(
        `SELECT id FROM "Location" WHERE lower(name)=lower($1) AND "deletedAt" IS NULL`,
        [box.name],
      );
      let boxId: string | undefined = existing.rows[0]?.id;
      if (!boxId) {
        for (let attempt = 0; attempt < 8 && !boxId; attempt++) {
          try {
            const res = await client.query(
              `INSERT INTO "Location" (id, shortcode, name, type, "parentId", "productId", aliases)
               VALUES (gen_random_uuid(), $1, $2, NULL, $3, $4, '{}')
               RETURNING id`,
              [mintShortcode("LOC"), box.name, ryobiStackId, linkBoxId],
            );
            boxId = res.rows[0].id;
          } catch (err) {
            if ((err as { code?: string }).code !== "23505") throw err;
          }
        }
        if (!boxId) throw new Error(`could not create ${box.name}`);
        log.push(`ryobi box created: ${box.name}`);
      }
      const moved = await client.query(
        `UPDATE "Location" SET "parentId"=$1
          WHERE shortcode = ANY($2) AND "deletedAt" IS NULL AND "parentId" IS DISTINCT FROM $1`,
        [boxId, box.drawers],
      );
      if (moved.rowCount) {
        log.push(`  reparented ${moved.rowCount} drawer(s) under ${box.name}`);
      }
    }

    // ---- link the vessels --------------------------------------------------
    // BY NAME FIRST. `LOC-567F "nailers"` is typed `crate` but is really the
    // LINK medium tool box; if the type sweep ran first it would claim the row
    // (both writes are guarded on `productId IS NULL`) and the specific
    // identity would lose to the generic one.
    let linkedByName = 0;
    for (const [locCode, prodCode, why] of BY_LOCATION) {
      const productId = await idFor(prodCode, "Product");
      const res = await client.query(
        `UPDATE "Location" SET "productId"=$1
          WHERE shortcode=$2 AND "deletedAt" IS NULL AND "productId" IS NULL`,
        [productId, locCode],
      );
      linkedByName += res.rowCount ?? 0;
      if (res.rowCount) log.push(`linked ${locCode} -> ${prodCode} (${why})`);
    }

    let linkedByType = 0;
    for (const [type, target] of Object.entries(BY_TYPE)) {
      const productId = target.key
        ? productIdByKey.get(target.key)
        : await idFor(target.shortcode as string, "Product");
      const res = await client.query(
        `UPDATE "Location" SET "productId"=$1
          WHERE type=$2 AND "deletedAt" IS NULL AND "productId" IS NULL`,
        [productId, type],
      );
      linkedByType += res.rowCount ?? 0;
      log.push(`linked ${res.rowCount} ${type}`);
    }

    // ---- fix the typo the audit turned up ---------------------------------
    const renamed = await client.query(
      `UPDATE "Location" SET name='welding table'
        WHERE shortcode='LOC-JU9P' AND name='welding tabe' AND "deletedAt" IS NULL`,
    );
    if (renamed.rowCount) log.push("renamed LOC-JU9P -> 'welding table'");

    // ---- break the containment cycles --------------------------------------
    // By predicate, not by list. A hand-written set missed 12 of these on the
    // first pass, all the same shape. `qty = 1` is the guard that keeps a
    // genuinely nested spare (two crates stored inside a crate) out of the
    // sweep — anything larger is reported instead of deleted.
    const now = new Date();
    const doomed = await client.query(
      `SELECT ie.id, ie.shortcode, (ie.amount->>'value')::numeric AS qty,
              l.name AS loc_name, p.name AS prod_name
         FROM "InventoryEntry" ie
         JOIN "Location" l ON l.id = ie."locationId" AND l."deletedAt" IS NULL
         JOIN "Product" p ON p.id = ie."productId"
        WHERE ie."deletedAt" IS NULL
          AND l."productId" = ie."productId"
          AND (ie.amount->>'value')::numeric = 1`,
    );
    const relocated = await client.query(
      `SELECT id, shortcode FROM "InventoryEntry"
        WHERE shortcode = ANY($1) AND "deletedAt" IS NULL`,
      [RELOCATED_ENTRIES],
    );
    const ids = [
      ...doomed.rows.map((r) => r.id),
      ...relocated.rows.map((r) => r.id),
    ];
    for (const r of doomed.rows) {
      log.push(
        `  cycle: ${r.shortcode} "${r.prod_name}" inside "${r.loc_name}"`,
      );
    }
    if (ids.length > 0) {
      await client.query(
        `UPDATE "InventoryEntry" SET "deletedAt"=$1 WHERE id = ANY($2)`,
        [now, ids],
      );
    }
    log.push(
      `soft-deleted ${doomed.rowCount} self-referential + ${relocated.rowCount} relocated entries`,
    );
    // Their search/embedding artifacts go in the same transaction — the
    // removal-path invariant in CLAUDE.md.
    if (ids.length > 0) {
      await client.query(
        `UPDATE "SearchDocument" SET "deletedAt"=$1
          WHERE "entityType"='inventory' AND "entityId" = ANY($2) AND "deletedAt" IS NULL`,
        [now, ids],
      );
      await client.query(
        `DELETE FROM "EntityEmbedding" WHERE "entityType"='inventory' AND "entityId" = ANY($1)`,
        [ids],
      );
      log.push("cascaded search documents + embeddings");
    }

    // ---- contract: the SKU becomes the only source of form factor ----------
    if (CONTRACT) {
      const cleared = await client.query(
        `UPDATE "Location" SET type = NULL
          WHERE "deletedAt" IS NULL AND "productId" IS NOT NULL AND type IS NOT NULL`,
      );
      log.push(
        `contract: cleared type on ${cleared.rowCount} linked locations`,
      );
      const orphaned = await client.query(
        `SELECT count(*)::int AS n FROM "Location"
          WHERE "deletedAt" IS NULL AND type IS NULL AND "productId" IS NULL`,
      );
      if (orphaned.rows[0].n > 0) {
        throw new Error(
          `${orphaned.rows[0].n} locations would have neither a type nor a product — refusing`,
        );
      }
      const stragglers = await client.query(
        `SELECT DISTINCT type FROM "Location"
          WHERE "deletedAt" IS NULL AND type IN
            ('crate','half-crate','quarter-crate','milk-crate','tote-27gal','tote-14gal','tote-7gal')`,
      );
      log.push(
        stragglers.rowCount === 0
          ? "contract: no retiring type values remain — safe to narrow locationTypeValues"
          : `contract: STILL PRESENT ${stragglers.rows.map((r) => r.type).join(", ")} — do NOT narrow the enum yet`,
      );
    }

    // ---- verification ------------------------------------------------------
    const summary = await client.query(
      `SELECT count(*) FILTER (WHERE "productId" IS NOT NULL)::int AS linked,
              count(*) FILTER (WHERE "productId" IS NULL)::int AS unlinked,
              count(*)::int AS total
         FROM "Location" WHERE "deletedAt" IS NULL`,
    );
    const cyclesLeft = await client.query(
      `SELECT ie.shortcode AS entry, l.shortcode AS loc, l.name AS loc_name,
              p.shortcode AS prod, p.name AS prod_name, ie.amount->>'value' AS qty
         FROM "InventoryEntry" ie
         JOIN "Location" l ON l.id = ie."locationId"
         JOIN "Product" p ON p.id = ie."productId"
        WHERE ie."deletedAt" IS NULL AND l."deletedAt" IS NULL
          AND l."productId" = ie."productId"
        ORDER BY l.name`,
    );
    console.log("\nREMAINING CYCLES:");
    for (const r of cyclesLeft.rows) {
      console.log(
        `  ${r.entry} qty=${r.qty} ${r.prod} "${r.prod_name}" inside ${r.loc} "${r.loc_name}"`,
      );
    }

    // The real check: does the UNION (stock + locations) now exceed what the
    // ledger says was ever acquired? An overshoot means a container was left
    // as inventory somewhere while also serving as a location.
    const overcount = await client.query(
      `WITH linked AS (
         SELECT "productId" AS pid, count(*)::int AS locs
           FROM "Location" WHERE "deletedAt" IS NULL AND "productId" IS NOT NULL
          GROUP BY 1),
       stock AS (
         SELECT "productId" AS pid,
                COALESCE(sum((amount->>'value')::numeric),0) AS units
           FROM "InventoryEntry" WHERE "deletedAt" IS NULL GROUP BY 1),
       ledger AS (
         SELECT "productId" AS pid,
                COALESCE(sum(CASE WHEN "productQuantity" IS NULL THEN 0
                                  WHEN cost < 0 THEN -abs("productQuantity")
                                  ELSE abs("productQuantity") END),0) AS acquired
           FROM "Expense" WHERE "deletedAt" IS NULL AND future=false GROUP BY 1)
       SELECT p.shortcode, p.name, l.locs,
              COALESCE(s.units,0)::int AS stock_units,
              COALESCE(g.acquired,0)::int AS acquired
         FROM linked l
         JOIN "Product" p ON p.id = l.pid
         LEFT JOIN stock s ON s.pid = l.pid
         LEFT JOIN ledger g ON g.pid = l.pid
        WHERE l.locs + COALESCE(s.units,0) > COALESCE(g.acquired,0)
        ORDER BY (l.locs + COALESCE(s.units,0)) - COALESCE(g.acquired,0) DESC`,
    );
    console.log("\nUNION vs LEDGER (locations + stock > acquired):");
    for (const r of overcount.rows) {
      console.log(
        `  ${r.shortcode} ${String(r.name).slice(0, 46)} — ${r.locs} loc + ${r.stock_units} stock vs ${r.acquired} acquired`,
      );
    }

    console.log(log.map((l) => `  ${l}`).join("\n"));
    console.log("\nlocations:", summary.rows[0]);
    console.log("remaining self-referential entries:", cyclesLeft.rowCount);
    console.log(`linked ${linkedByType} by type, ${linkedByName} by name`);

    if (DRY_RUN) {
      await client.query("ROLLBACK");
      console.log("\nDRY RUN — rolled back. Re-run with --write to apply.");
    } else {
      await client.query("COMMIT");
      console.log("\nCOMMITTED.");
      console.log(
        CONTRACT
          ? "Contract applied. locationTypeValues can now be narrowed 16 -> 9."
          : "Next, AFTER deploying the new code: re-run with --write --contract, then narrow locationTypeValues 16 -> 9.",
      );
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
