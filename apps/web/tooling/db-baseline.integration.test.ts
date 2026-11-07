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
  named = false,
) {
  const folder = mkdtempSync(join(tmpdir(), "cubby-baseline-"));
  mkdirSync(join(folder, "19700101000003_baseline"));
  mkdirSync(join(folder, "19700101000004_next"));
  writeFileSync(
    join(folder, "19700101000003_baseline/migration.sql"),
    baseline,
  );
  writeFileSync(join(folder, "19700101000004_next/migration.sql"), next);
  writeFileSync(
    join(folder, "baseline.json"),
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
      if (named) {
        await client.query(
          "ALTER TABLE drizzle.__drizzle_migrations ADD COLUMN name text, ADD COLUMN applied_at timestamptz DEFAULT now()",
        );
        await client.query(
          "UPDATE drizzle.__drizzle_migrations SET name = 'synthetic_retired_' || id",
        );
      }
      await run(client, folder);
    });
  } finally {
    rmSync(folder, { recursive: true, force: true, maxRetries: 5 });
  }
}

// Squashing must not replay CREATE/DML on an existing database or skip the
// first post-baseline migration; adoption must be safe to run again.
it.each([false, true])(
  "adopts the complete retired ledger without changing populated rows (named: %s)",
  async (named) => {
    await withBaselineDatabase(
      old,
      async (client, folder) => {
        await expect(
          assertMigrationBookkeeping(
            drizzle({ client: client, paramsInErrors: true }),
            readMigrationFiles({ migrationsFolder: folder }),
          ),
        ).rejects.toThrow(/Refusing to migrate/);
        const run = () =>
          migrateDatabase(drizzle({ client: client, paramsInErrors: true }), {
            migrationsFolder: folder,
          });
        await run();
        await client.query(
          "ALTER TABLE drizzle.__drizzle_migrations DROP COLUMN name, DROP COLUMN applied_at; UPDATE drizzle.__drizzle_migrations SET created_at = created_at + 123",
        );
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
          { hash: hash(baseline), created_at: "3123" },
          { hash: hash(next), created_at: "4123" },
        ]);
      },
      named,
    );
  },
);

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
      migrateDatabase(drizzle({ client: client, paramsInErrors: true }), {
        migrationsFolder: folder,
      }),
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
          "../drizzle/20261029005641_0059_sender_attribution_policies/migration.sql",
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
