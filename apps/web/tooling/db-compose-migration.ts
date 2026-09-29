import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { generateDrizzleJson } from "drizzle-kit/api";

import * as schema from "../src/server/db/schema";
import { MIGRATIONS_FOLDER } from "./db-migrate";

/**
 * `pnpm --dir apps/web db:compose <tag>` (regenerates entity artifacts first, since
 * `schema.ts` reads them)
 *
 * Compose an unmerged custom migration (created with `drizzle-kit generate
 * --custom --name <name>`) from hand-written fragments in
 * `drizzle/transform/NN-<slice>.sql`, concatenated in file-name order (`00-`
 * is the guard), then point that entry's snapshot at the current `schema.ts`
 * so the next `drizzle-kit generate` diffs from the transformed model. Rerun
 * after any fragment or model edit; `pnpm db:check` then proves the composed
 * SQL builds exactly `schema.ts`.
 *
 * Only the journal's newest entry may be recomposed: merged migrations are
 * immutable, and a local database that applied an earlier composition is
 * refused by the runner (hash mismatch) until it is rebuilt.
 */
const TRANSFORM_FOLDER = join(MIGRATIONS_FOLDER, "transform");

function main(): void {
  const { values } = parseArgs({ options: { tag: { type: "string" } } });
  const journal: { entries: { idx: number; tag: string }[] } = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8"),
  );
  const last = journal.entries.at(-1);
  if (!values.tag || last?.tag !== values.tag)
    throw new Error(
      `--tag must name the newest journal entry (${last?.tag ?? "none"})`,
    );

  const fragments = readdirSync(TRANSFORM_FOLDER)
    .filter((name) => /^\d{2}-[a-z0-9-]+\.sql$/u.test(name))
    .sort();
  if (fragments.length === 0)
    throw new Error(`no NN-<slice>.sql fragments in ${TRANSFORM_FOLDER}`);
  const body = fragments
    .map(
      (name) =>
        `-- transform/${name}\n${readFileSync(join(TRANSFORM_FOLDER, name), "utf8").trim()}`,
    )
    .join("\n--> statement-breakpoint\n");
  writeFileSync(
    join(MIGRATIONS_FOLDER, `${last.tag}.sql`),
    `-- Composed by tooling/db-compose-migration.ts from drizzle/transform/.\n${body}\n`,
  );

  const snapshotPath = join(
    MIGRATIONS_FOLDER,
    `meta/${String(last.idx).padStart(4, "0")}_snapshot.json`,
  );
  const { id, prevId } = JSON.parse(readFileSync(snapshotPath, "utf8"));
  const current = generateDrizzleJson(schema, prevId, ["public"]);
  writeFileSync(
    snapshotPath,
    `${JSON.stringify({ ...current, id, prevId }, null, 2)}\n`,
  );
  console.log(
    `[db-compose] ${last.tag}.sql from ${fragments.length} fragment(s); snapshot = schema.ts`,
  );
}

main();
