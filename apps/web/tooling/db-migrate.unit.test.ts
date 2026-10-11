import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";

import { migrateDatabase } from "./db-migrate";

// Runner failures: applying the contract past an expand boundary, skipping a
// pending predecessor, accepting changed hashes/non-prefix rows, or mutating a
// database already beyond the requested boundary. PostgreSQL is the only fake.
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function fixture() {
  const migrationsFolder = mkdtempSync(
    join(tmpdir(), "cubby-migration-boundary-"),
  );
  roots.push(migrationsFolder);
  const statements = [
    "SELECT 'synthetic_base';",
    "SELECT 'synthetic_expand';",
    "SELECT 'synthetic_contract';",
  ];
  const entries = statements.map((text, idx) => ({
    idx,
    tag: ["0000_base", "0001_expand", "0002_contract"][idx],
    when: (idx + 1) * 1000,
    breakpoints: true,
    hash: createHash("sha256").update(text).digest("hex"),
  }));
  mkdirSync(join(migrationsFolder, "meta"));
  writeFileSync(
    join(migrationsFolder, "meta/_journal.json"),
    JSON.stringify({ entries }),
  );
  const textForEntry = (values: string[], index: number) => {
    const value = values[index];
    if (value === undefined)
      throw new Error("Synthetic migration statement missing");
    return value;
  };
  entries.forEach((entry, index) =>
    writeFileSync(
      join(migrationsFolder, `${entry.tag}.sql`),
      textForEntry(statements, index),
    ),
  );
  const applied = entries
    .slice(0, 1)
    .map((entry) => ({ hash: entry.hash, created_at: String(entry.when) }));
  const writes: string[] = [];
  const executed: string[] = [];
  const client = new Client();
  vi.spyOn(client, "query").mockImplementation(async (...args: unknown[]) => {
    const query = z.object({ text: z.string() }).parse(args[0]);
    const text = query.text.trim();
    let rows: object[] = [];
    if (text.includes("to_regclass")) rows = [{ exists: applied.length > 0 }];
    else if (text.includes("FROM pg_class")) rows = [{ count: 0 }];
    else if (text.includes("ORDER BY created_at, id")) rows = [...applied];
    else if (text.includes("order by created_at desc limit 1"))
      rows = applied.slice(-1);
    else {
      writes.push(text);
      if (statements.includes(text)) executed.push(text);
    }
    return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] };
  });
  return {
    db: drizzle(client),
    migrationsFolder,
    entries,
    applied,
    writes,
    executed,
  };
}

it("applies every pending predecessor through the exact boundary without executing the contract", async () => {
  const state = fixture();
  state.applied.length = 0;
  await migrateDatabase(state.db, {
    migrationsFolder: state.migrationsFolder,
    through: "0001_expand",
  });
  expect(state.executed).toEqual([
    "SELECT 'synthetic_base';",
    "SELECT 'synthetic_expand';",
  ]);
});

it("keeps the unbounded runner applying all pending migrations after the applied prefix", async () => {
  const state = fixture();
  await migrateDatabase(state.db, { migrationsFolder: state.migrationsFolder });
  expect(state.executed).toEqual([
    "SELECT 'synthetic_expand';",
    "SELECT 'synthetic_contract';",
  ]);
});

it.each([
  { name: "unknown exact tag", through: "0001", change: "unknown" },
  {
    name: "an already later applied prefix",
    through: "0001_expand",
    change: "beyond",
  },
  {
    name: "a skipped predecessor in bookkeeping",
    through: "0001_expand",
    change: "prefix",
  },
  {
    name: "an edited applied migration hash",
    through: "0001_expand",
    change: "hash",
  },
  {
    name: "an out-of-order journal entry",
    through: "0001_expand",
    change: "order",
  },
])("refuses $name before any write", async ({ through, change }) => {
  const state = fixture();
  if (change === "beyond")
    state.applied.push(
      ...state.entries
        .slice(1)
        .map((entry) => ({ hash: entry.hash, created_at: String(entry.when) })),
    );
  const firstApplied = state.applied[0];
  const secondEntry = state.entries[1];
  if (!firstApplied || !secondEntry)
    throw new Error("Synthetic migration fixture incomplete");
  if (change === "prefix") firstApplied.created_at = "2000";
  if (change === "hash") firstApplied.hash = "synthetic-edited-hash";
  if (change === "order") {
    secondEntry.when = 500;
    writeFileSync(
      join(state.migrationsFolder, "meta/_journal.json"),
      JSON.stringify({ entries: state.entries }),
    );
  }
  await expect(
    migrateDatabase(state.db, {
      migrationsFolder: state.migrationsFolder,
      through,
    }),
  ).rejects.toThrow(/Refusing to migrate/);
  expect(state.writes).toEqual([]);
});
