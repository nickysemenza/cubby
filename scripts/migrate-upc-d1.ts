/**
 * One-off: copy the retired `upc-lookup` Worker's hand-entered products and
 * checked misses from its production D1 into Postgres `UpcLookupCache`.
 *
 *   node scripts/migrate-upc-d1.ts                 # dry run: counts + sample
 *   DATABASE_URL=... node scripts/migrate-upc-d1.ts --apply
 *   ... --apply --copy-images                      # also copy R2 `upc-images`
 *
 * D1 is only ever read (SELECT through `wrangler d1 execute --remote`).
 * Postgres is written only with `--apply`, as idempotent upserts: a re-run
 * refreshes the same rows and never touches rows from other sources.
 * `--copy-images` copies referenced objects from R2 `upc-images` into the main
 * bucket under `<prefix>/upc-images/<key>` (a production R2 write) and points
 * the row's `imageUrl` at the public URL. Without it `imageUrl` stays null and
 * the referenced keys are only listed.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const webRoot = fileURLToPath(new URL("../apps/web/", import.meta.url));
// `pg` is an apps/web dependency; resolve it from there.
// SAFETY: only `Client` is used, and it matches the minimal PgClient shape.
const { Client } = createRequire(path.join(webRoot, "package.json"))("pg") as {
  Client: new (config: { connectionString: string }) => PgClient;
};

interface PgClient {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<{ rowCount: number | null }>;
  end(): Promise<void>;
}

const D1_DATABASE_NAME = "upc-lookup-db";
const D1_DATABASE_ID = "6c1f2074-2017-48d1-ae37-bc7002d47c64";
const SOURCE_R2_BUCKET = "upc-images";
const MAIN_R2_BUCKET = "foo";
const MAIN_R2_PREFIX = "cubby";
const MAIN_R2_PUBLIC_URL = "https://media.nickysemenza.com";
const PAGE_SIZE = 500;

const { values: flags } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    "copy-images": { type: "boolean", default: false },
  },
});
const apply = flags.apply === true;
const copyImages = flags["copy-images"] === true;
if (copyImages && !apply) {
  throw new Error("--copy-images requires --apply");
}

interface D1Product {
  upc: string;
  source: string | null;
  name: string;
  manufacturer: string | null;
  brand: string | null;
  category: string | null;
  description: string | null;
  price_dollars: number | null;
  image_key: string | null;
  updated_at: string | null;
}
interface MissRow {
  upc: string;
  last_checked_at: string | null;
}

const configDir = mkdtempSync(path.join(tmpdir(), "upc-d1-"));
const configPath = path.join(configDir, "wrangler.json");
writeFileSync(
  configPath,
  JSON.stringify({
    name: "upc-d1-export",
    compatibility_date: "2026-09-19",
    d1_databases: [
      {
        binding: "DB",
        database_name: D1_DATABASE_NAME,
        database_id: D1_DATABASE_ID,
      },
    ],
  }),
);

const wrangler = (args: string[]): string => {
  const result = spawnSync(
    "pnpm",
    ["--dir", webRoot, "exec", "wrangler", ...args],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`wrangler ${args[0]} failed: ${result.stderr}`);
  }
  return result.stdout;
};

/** Read-only by construction: refuses anything but a single SELECT. */
const d1Select = <T>(sql: string): T[] => {
  if (!/^\s*select\b/i.test(sql) || sql.includes(";")) {
    throw new Error(`Refusing non-SELECT D1 statement: ${sql}`);
  }
  const out = wrangler([
    "d1",
    "execute",
    D1_DATABASE_NAME,
    "--remote",
    "--json",
    "--config",
    configPath,
    "--command",
    sql,
  ]);
  // SAFETY: `wrangler d1 execute --json` prints [{ results: row[], ... }]; the
  // caller names the row type for the columns it SELECTs.
  const parsed = JSON.parse(out.slice(out.indexOf("["))) as {
    results: T[];
  }[];
  return parsed.flatMap((entry) => entry.results);
};

const d1SelectAll = <T>(table: string, columns: string, where = ""): T[] => {
  const rows: T[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = d1Select<T>(
      `SELECT ${columns} FROM ${table} ${where} ORDER BY upc LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
    );
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
};

const products = d1SelectAll<D1Product>(
  "products",
  // Every cached product, not only hand-entered ones: migration 0006 empties
  // the Postgres cache, and the free upstream tier is ~100 lookups a day.
  "upc, source, name, manufacturer, brand, category, description, price_dollars, image_key, updated_at",
  "",
);
const productUpcs = new Set(products.map((p) => p.upc));
const misses = d1SelectAll<MissRow>(
  "upc_misses",
  "upc, last_checked_at",
).filter((m) => !productUpcs.has(m.upc));
const imageKeys = [
  ...new Set(products.flatMap((p) => (p.image_key ? [p.image_key] : []))),
];

// D1 timestamps are UTC "YYYY-MM-DD HH:MM:SS".
const toDate = (value: string | null): Date =>
  value ? new Date(`${value.replace(" ", "T")}Z`) : new Date();
const publicImageUrl = (key: string) =>
  `${MAIN_R2_PUBLIC_URL}/${MAIN_R2_PREFIX}/upc-images/${key}`;

console.log(
  `D1 ${D1_DATABASE_NAME}: ${products.length} products, ${misses.length} miss rows, ${imageKeys.length} referenced R2 images`,
);
console.log("Sample product:", products[0] ?? "(none)");
console.log("Sample miss:", misses[0] ?? "(none)");
console.log(`R2 ${SOURCE_R2_BUCKET} keys referenced by these rows:`);
for (const key of imageKeys) console.log(`  ${key}`);

if (copyImages) {
  const scratch = path.join(configDir, "images");
  mkdirSync(scratch, { recursive: true });
  for (const [index, key] of imageKeys.entries()) {
    const file = path.join(scratch, String(index));
    wrangler([
      "r2",
      "object",
      "get",
      `${SOURCE_R2_BUCKET}/${key}`,
      "--remote",
      "--file",
      file,
    ]);
    wrangler([
      "r2",
      "object",
      "put",
      `${MAIN_R2_BUCKET}/${MAIN_R2_PREFIX}/upc-images/${key}`,
      "--remote",
      "--file",
      file,
    ]);
    console.log(`  copied ${key}`);
  }
}

if (!apply) {
  console.log("\nDry run: nothing written. Re-run with --apply to upsert.");
  process.exit(0);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("--apply requires DATABASE_URL");
const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  await client.query("BEGIN");
  for (const p of products) {
    await client.query(
      `INSERT INTO "UpcLookupCache"
         (upc, name, manufacturer, brand, category, description, "priceDollars", "imageUrl", source, status, "fetchedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $10, 'ready', $9)
       ON CONFLICT (upc) DO UPDATE SET
         name = EXCLUDED.name, manufacturer = EXCLUDED.manufacturer, brand = EXCLUDED.brand,
         category = EXCLUDED.category, description = EXCLUDED.description,
         "priceDollars" = EXCLUDED."priceDollars", "imageUrl" = EXCLUDED."imageUrl",
         source = EXCLUDED.source, status = 'ready', "fetchedAt" = EXCLUDED."fetchedAt"
       WHERE "UpcLookupCache".source <> 'manual' OR EXCLUDED.source = 'manual'`,
      [
        p.upc,
        p.name,
        p.manufacturer,
        p.brand,
        p.category,
        p.description,
        p.price_dollars,
        copyImages && p.image_key ? publicImageUrl(p.image_key) : null,
        toDate(p.updated_at),
        p.source ?? "upcitemdb",
      ],
    );
  }
  for (const m of misses) {
    // A miss never replaces a hit or a hand-entered row already in Postgres.
    await client.query(
      `INSERT INTO "UpcLookupCache" (upc, source, status, "fetchedAt")
       VALUES ($1, 'upcitemdb', 'ready', $2)
       ON CONFLICT (upc) DO NOTHING`,
      [m.upc, toDate(m.last_checked_at)],
    );
  }
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
console.log(
  `\nUpserted ${products.length} products and up to ${misses.length} miss rows.`,
);
