import { entityIdentityTriggerSql } from "./entity-identity-schema";

/**
 * DDL derived from the application model that drizzle-kit cannot express:
 * today the entity identity functions and triggers (ADR 0006). Every statement
 * is idempotent (`CREATE OR REPLACE`), so `pnpm db:generate` can emit the whole
 * script as a custom migration whenever it changes and the result replays
 * cleanly over any earlier version. `drizzle/derived.lock` records the hash of
 * the rendering the committed migrations already contain.
 */
export function renderDerivedDdl(): string {
  return `${entityIdentityTriggerSql()}\n`;
}
