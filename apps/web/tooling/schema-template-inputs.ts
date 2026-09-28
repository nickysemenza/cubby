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
