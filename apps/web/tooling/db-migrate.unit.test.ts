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
// pending predecessor, accepting changed hashes/unknown receipts, or mutating a
// database already beyond the requested boundary. PostgreSQL is the only fake.
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  roots
    .splice(0)
    .forEach((root) =>
      rmSync(root, { recursive: true, force: true, maxRetries: 5 }),
    );
});

function fixture(failure?: { text: string; code: string; times: number }) {
  let failures = failure?.times ?? 0;
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
    tag: [
      "19700101000001_base",
      "19700101000002_expand",
      "19700101000003_contract",
    ][idx],
    when: (idx + 1) * 1000,
    breakpoints: true,
    hash: createHash("sha256").update(text).digest("hex"),
  }));
  const textForEntry = (values: string[], index: number) => {
    const value = values[index];
    if (value === undefined)
      throw new Error("Synthetic migration statement missing");
    return value;
  };
  entries.forEach((entry, index) => {
    if (!entry.tag) throw new Error("Synthetic migration name missing");
    const folder = join(migrationsFolder, entry.tag);
    mkdirSync(folder);
    writeFileSync(
      join(folder, "migration.sql"),
      textForEntry(statements, index),
    );
  });
  const applied = entries.slice(0, 1).map((entry) => ({
    hash: entry.hash,
    created_at: String(entry.when),
    name: entry.tag,
    has_name: true,
  }));
  const writes: string[] = [];
  const executed: string[] = [];
  const client = new Client();
  vi.spyOn(client, "query").mockImplementation(async (...args: unknown[]) => {
    const query = z.object({ text: z.string() }).parse(args[0]);
    const text = query.text.trim();
    if (failure?.text === text && failures > 0) {
      failures -= 1;
      throw Object.assign(new Error("Synthetic failure"), {
        code: failure.code,
      });
    }
    let rows: object[] = [];
    if (text.includes("to_regclass")) rows = [{ exists: applied.length > 0 }];
    else if (text.includes("FROM pg_class")) rows = [{ count: 0 }];
    else if (text.includes("information_schema.tables")) rows = [{ exists: 1 }];
    else if (text.includes("pg_catalog.pg_attribute"))
      rows = ["id", "hash", "created_at", "name", "applied_at"].map(
        (column_name) => ({ column_name }),
      );
    else if (
      text.includes("ORDER BY created_at, id") ||
      text.includes("select id, hash, created_at, name")
    )
      rows = [...applied];
    else if (text.includes("order by created_at desc limit 1"))
      rows = applied.slice(-1);
    else {
      writes.push(text);
      if (statements.includes(text)) executed.push(text);
    }
    return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] };
  });
  return {
    db: drizzle({ client: client, paramsInErrors: true }),
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
    through: "19700101000002_expand",
  });
  expect(state.executed).toEqual([
    "SELECT 'synthetic_base';",
    "SELECT 'synthetic_expand';",
  ]);
});

it.each(["55P03", "40P01"])(
  "rolls back and retries lock contention %s across the pending series",
  async (code) => {
    const failed = "SELECT 'synthetic_contract';";
    const state = fixture({ text: failed, code, times: 1 });
    await migrateDatabase(state.db, {
      migrationsFolder: state.migrationsFolder,
      lockRetryDelayMs: 0,
    });
    expect(state.writes.some((text) => /^rollback/i.test(text))).toBe(true);
    // The whole pending series repeats after the rollback, not just its tail.
    expect(state.executed).toEqual([
      "SELECT 'synthetic_expand';",
      "SELECT 'synthetic_expand';",
      failed,
    ]);
  },
);

it("fails at once on any other migration error, and bounds lock retries", async () => {
  const attempts = async (code: string) => {
    const state = fixture({
      text: "SELECT 'synthetic_expand';",
      code,
      times: Number.POSITIVE_INFINITY,
    });
    await expect(
      migrateDatabase(state.db, {
        migrationsFolder: state.migrationsFolder,
        lockRetryDelayMs: 0,
      }),
    ).rejects.toThrow("Failed query");
    return state.writes.filter((text) => /^rollback/i.test(text)).length;
  };
  expect(await attempts("23505")).toBe(1);
  expect(await attempts("55P03")).toBe(6);
});

it("applies a missing predecessor even when a later migration is already recorded", async () => {
  const state = fixture();
  const last = state.entries.at(-1);
  if (!last) throw new Error("Synthetic migration missing");
  state.applied.push({
    hash: last.hash,
    created_at: String(last.when),
    name: last.tag,
    has_name: true,
  });
  await migrateDatabase(state.db, { migrationsFolder: state.migrationsFolder });
  expect(state.executed).toEqual(["SELECT 'synthetic_expand';"]);
});

it.each([
  { name: "unknown exact tag", through: "unknown", change: "unknown" },
  {
    name: "an already later applied prefix",
    through: "19700101000002_expand",
    change: "beyond",
  },
  {
    name: "an unknown legacy receipt",
    through: "19700101000002_expand",
    change: "prefix",
  },
  {
    name: "an edited applied migration hash",
    through: "19700101000002_expand",
    change: "hash",
  },
  {
    name: "an unnamed v1 receipt",
    through: "19700101000002_expand",
    change: "order",
  },
])("refuses $name before any write", async ({ through, change }) => {
  const state = fixture();
  if (change === "beyond")
    state.applied.push(
      ...state.entries.slice(1).map((entry) => ({
        hash: entry.hash,
        created_at: String(entry.when),
        name: entry.tag,
        has_name: true,
      })),
    );
  const firstApplied = state.applied[0];
  const secondEntry = state.entries[1];
  if (!firstApplied || !secondEntry)
    throw new Error("Synthetic migration fixture incomplete");
  if (change === "prefix") firstApplied.name = "synthetic-missing-migration";
  if (change === "hash") firstApplied.hash = "synthetic-edited-hash";
  if (change === "order") firstApplied.name = undefined;
  await expect(
    migrateDatabase(state.db, {
      migrationsFolder: state.migrationsFolder,
      through,
    }),
  ).rejects.toThrow(/Refusing to migrate/);
  expect(state.writes).toEqual([]);
});
