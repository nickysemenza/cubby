import { entityEmojiAliasTriggerSql } from "./entity-emoji-schema";
import { entityIdentityTriggerSql } from "./entity-identity-schema";
import { entityLinkLivenessTriggerSql } from "./entity-link-schema";

/**
 * DDL derived from the application model that drizzle-kit cannot express:
 * the entity identity functions and triggers (ADR 0006) and the EntityLink
 * live-endpoint trigger (ADR 0007). Every statement is idempotent
 * (`CREATE OR REPLACE`, or drop-and-create where Postgres has no replace), so
 * `pnpm db:generate` can emit the whole script as a custom migration whenever
 * it changes and the result replays cleanly over any earlier version.
 * `drizzle/derived.lock` records the hash of the rendering the committed
 * migrations already contain.
 */
export function renderDerivedDdl(): string {
  return `${entityIdentityTriggerSql()}\n\n${entityLinkLivenessTriggerSql()}\n\n${entityEmojiAliasTriggerSql()}\n`;
}
