import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";

import type { Env } from "../types";
import { createDb, schema } from "./index";
import { getFreshMisses } from "./misses";

it("reads fresh misses across D1 parameter boundaries and preserves the TTL", async () => {
  const platform = await getPlatformProxy<Env>({
    configPath: fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)),
    persist: false,
    remoteBindings: false,
    envFiles: [],
  });
  try {
    const migrations = new URL("../../drizzle/", import.meta.url);
    for (const filename of (await readdir(migrations))
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      const migration = await readFile(new URL(filename, migrations), "utf8");
      for (const statement of migration.split("--> statement-breakpoint")) {
        await platform.env.DB.prepare(statement).run();
      }
    }
    const db = createDb(platform.env.DB);
    const upcs = Array.from({ length: 250 }, (_, index) =>
      String(index).padStart(12, "0"),
    );
    for (const upc of upcs) await db.insert(schema.upcMisses).values({ upc });

    for (const size of [0, 1, 99, 100, 101, 250]) {
      const requested = upcs.slice(0, size);
      expect(await getFreshMisses(db, requested)).toEqual(new Set(requested));
    }

    const older = "888888888888";
    await db.insert(schema.upcMisses).values({
      upc: older,
      lastCheckedAt: sql`datetime('now', '-10 days')`,
    });
    const requested = [...upcs, older, "999999999999"];
    expect(await getFreshMisses(db, requested, 7)).toEqual(new Set(upcs));
    expect(await getFreshMisses(db, requested)).toEqual(
      new Set([...upcs, older]),
    );
  } finally {
    await platform.dispose();
  }
}, 30_000);
