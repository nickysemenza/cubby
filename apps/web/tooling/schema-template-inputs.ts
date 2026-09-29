import { createHash } from "node:crypto";
import { globSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Every file whose contents decide the physical test-database schema. The
 * IntegreSQL template (and the E2E template) is keyed by a hash of these, so a
 * file missing here means a stale template is reused after a schema change.
 *
 * Templates are built only by `migrateDatabase`, so the committed migrations
 * and the runner decide the schema; a `schema.ts` edit reaches a template only
 * through a generated migration (`pnpm db:check` fails until it exists).
 * Paths resolve from `apps/web` (the hasher joins them onto `process.cwd()`),
 * which is where both Vitest and Playwright run.
 */
export const schemaTemplateInputs = [
  "./drizzle/**/*",
  "./tooling/db-migrate.ts",
  "./tooling/db-extensions.ts",
];

/**
 * Hash the template inputs in sorted path order. IntegreSQL's own
 * `hashFiles` concatenates file hashes in fast-glob traversal order, which is
 * not stable across processes once a pattern spans subdirectories
 * (`drizzle/meta`): the global setup and a test worker
 * then disagree on the template hash and every release 404s.
 */
export function hashSchemaTemplateInputs(
  patterns: readonly string[] = schemaTemplateInputs,
): string {
  const files = [
    ...new Set(patterns.flatMap((pattern) => globSync(pattern))),
  ].sort();
  const hash = createHash("sha1");
  for (const file of files) {
    const path = join(process.cwd(), file);
    if (!statSync(path).isFile()) continue;
    hash.update(file).update("\0").update(readFileSync(path)).update("\0");
  }
  return hash.digest("hex");
}
