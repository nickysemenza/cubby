import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { assertMigrationBookkeeping, migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const baseline = 'CREATE TABLE "SyntheticPreserved" (value text NOT NULL);';
const next = 'ALTER TABLE "SyntheticPreserved" ADD COLUMN extra text;';
const old = [
  { hash: hash("synthetic-old-schema"), created_at: "1000" },
  { hash: hash("synthetic-old-transform"), created_at: "2000" },
];

async function withBaselineDatabase(
  applied: typeof old,
  run: (
    client: Parameters<Parameters<typeof withMigrationDatabase>[0]>[0],
    folder: string,
  ) => Promise<void>,
) {
  const folder = mkdtempSync(join(tmpdir(), "cubby-baseline-"));
  mkdirSync(join(folder, "meta"));
  writeFileSync(join(folder, "0000_baseline.sql"), baseline);
  writeFileSync(join(folder, "0001_next.sql"), next);
  writeFileSync(
    join(folder, "meta/_journal.json"),
    JSON.stringify({
      entries: [
        { idx: 0, tag: "0000_baseline", when: 3000, breakpoints: true },
        { idx: 1, tag: "0001_next", when: 4000, breakpoints: true },
      ],
    }),
  );
  writeFileSync(
    join(folder, "meta/_baseline.json"),
    JSON.stringify({
      baselineHash: hash(baseline),
      retiredCount: old.length,
      retiredDigest: hash(
        old.map((row) => `${row.created_at}:${row.hash}\n`).join(""),
      ),
    }),
  );
  try {
    await withMigrationDatabase(async (client) => {
      await client.query(`CREATE TABLE "SyntheticPreserved" (value text NOT NULL);
        INSERT INTO "SyntheticPreserved" VALUES ('Synthetic retained content');
        CREATE SCHEMA drizzle;
        CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);`);
      for (const row of applied)
        await client.query(
          "INSERT INTO drizzle.__drizzle_migrations (hash,created_at) VALUES ($1,$2)",
          [row.hash, row.created_at],
        );
      await run(client, folder);
    });
  } finally {
    rmSync(folder, { recursive: true, force: true, maxRetries: 5 });
  }
}

// Squashing must not replay CREATE/DML on an existing database or skip the
// first post-baseline migration; adoption must be safe to run again.
it("adopts the complete retired ledger without changing populated rows", async () => {
  await withBaselineDatabase(old, async (client, folder) => {
    await expect(
      assertMigrationBookkeeping(
        drizzle(client),
        readMigrationFiles({ migrationsFolder: folder }),
      ),
    ).rejects.toThrow(/Refusing to migrate/);
    const run = () =>
      migrateDatabase(drizzle(client), { migrationsFolder: folder });
    await run();
    await run();
    expect(
      (await client.query('SELECT * FROM "SyntheticPreserved"')).rows,
    ).toEqual([{ value: "Synthetic retained content", extra: null }]);
    expect(
      (
        await client.query(
          "SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at",
        )
      ).rows,
    ).toEqual([
      { hash: hash(baseline), created_at: "3000" },
      { hash: hash(next), created_at: "4000" },
    ]);
  });
});

// Missing or edited retired migrations must fail without changing any history or data.
it.each([
  { name: "partial", applied: old.slice(0, 1) },
  {
    name: "edited",
    applied: old.map((row) => ({ ...row, hash: "synthetic-edited-hash" })),
  },
  {
    name: "extra",
    applied: [...old, { hash: hash("synthetic-extra"), created_at: "2500" }],
  },
])("refuses a $name retired ledger before mutation", async ({ applied }) => {
  await withBaselineDatabase(applied, async (client, folder) => {
    const before = (
      await client.query(
        "SELECT * FROM drizzle.__drizzle_migrations ORDER BY id",
      )
    ).rows;
    await expect(
      migrateDatabase(drizzle(client), { migrationsFolder: folder }),
    ).rejects.toThrow(/Refusing to migrate/);
    expect(
      (
        await client.query(
          "SELECT * FROM drizzle.__drizzle_migrations ORDER BY id",
        )
      ).rows,
    ).toEqual(before);
    expect(
      (await client.query('SELECT * FROM "SyntheticPreserved"')).rows,
    ).toEqual([{ value: "Synthetic retained content" }]);
  });
});

// The additive policy metadata must not reinterpret or erase a legacy sender list.
it("adds sender decision metadata while preserving populated Vendor identities", async () => {
  await withMigrationDatabase(async (client) => {
    await client.query(`CREATE TABLE "Vendor" (name text NOT NULL, "orderEmailSenders" text[] NOT NULL, notes text);
      INSERT INTO "Vendor" VALUES ('Synthetic seller', ARRAY['store+100001@t.shopifyemail.com', 'orders@seller.example.test'], 'Synthetic retained research');`);
    const before = (await client.query('SELECT * FROM "Vendor"')).rows;
    await client.query(
      readFileSync(
        new URL(
          "../drizzle/0059_sender_attribution_policies.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(
      (
        await client.query(
          'SELECT name, "orderEmailSenders", notes FROM "Vendor"',
        )
      ).rows,
    ).toEqual(before);
    expect(
      (await client.query('SELECT "orderEmailSenderPolicies" FROM "Vendor"'))
        .rows,
    ).toEqual([{ orderEmailSenderPolicies: {} }]);
  });
});
