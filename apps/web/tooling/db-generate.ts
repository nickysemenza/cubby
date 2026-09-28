import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderDerivedDdl } from "../src/server/db/derived-ddl";
import {
  DERIVED_LOCK,
  derivedDdlHash,
  readDerivedLock,
} from "./db-derived-ddl";
import { MIGRATIONS_FOLDER } from "./db-migrate";

/**
 * `pnpm db:generate [--name <tag>]`: drizzle-kit generate for `schema.ts`,
 * then the derived DDL drizzle cannot model. When the rendered derived DDL no
 * longer matches `drizzle/derived.lock`, emit a custom migration holding the
 * whole (idempotent) script and move the lock. Committed migrations are
 * immutable; this only ever adds files.
 */
const webRoot = fileURLToPath(new URL("..", import.meta.url));
const DERIVED_OUTPUT = join(
  webRoot,
  "src/server/db/generated/derived-ddl.gen.sql",
);

function drizzleKit(args: string[]): void {
  const result = spawnSync("pnpm", ["exec", "drizzle-kit", ...args], {
    cwd: webRoot,
    stdio: "inherit",
  });
  if (result.status !== 0)
    throw new Error(`drizzle-kit ${args.join(" ")} exited ${result.status}`);
}

function latestMigrationTag(): string {
  const journal: { entries: { tag: string }[] } = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8"),
  );
  const tag = journal.entries.at(-1)?.tag;
  if (!tag) throw new Error("drizzle journal has no entries");
  return tag;
}

function main(): void {
  drizzleKit(["generate", ...process.argv.slice(2)]);

  const ddl = renderDerivedDdl();
  mkdirSync(dirname(DERIVED_OUTPUT), { recursive: true });
  writeFileSync(DERIVED_OUTPUT, ddl);
  const hash = derivedDdlHash(ddl);
  if (hash === readDerivedLock()) return;

  drizzleKit(["generate", "--custom", "--name", "derived_ddl"]);
  const tag = latestMigrationTag();
  writeFileSync(join(MIGRATIONS_FOLDER, `${tag}.sql`), ddl);
  writeFileSync(DERIVED_LOCK, `${hash}\n`);
  console.log(`[db:generate] derived DDL changed; wrote drizzle/${tag}.sql`);
}

main();
