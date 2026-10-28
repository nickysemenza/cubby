import {
  entityManifest,
  shortcodeEntities,
} from "@cubby/schemas/entity-manifest";

/**
 * Desired-state cleanup, safe to repeat after historical migrations create
 * identity triggers. Historical migration SQL remains immutable; new writes
 * create identity before payloads and maintain lifecycle in their transaction.
 */
export const entityIdentityDropTriggerSql = (): string => {
  const drops = [...shortcodeEntities].sort().flatMap((kind) => {
    const table = entityManifest[kind].dbTable;
    if (!table) throw new Error(`Shortcode entity ${kind} has no dbTable.`);
    return ["insert", "soft_delete", "delete"].map(
      (event) =>
        `DROP TRIGGER IF EXISTS "Entity_identity_${event}" ON "${table}";`,
    );
  });
  return [
    ...drops,
    'DROP FUNCTION IF EXISTS "entity_identity_on_insert"();',
    'DROP FUNCTION IF EXISTS "entity_identity_on_soft_delete"();',
    'DROP FUNCTION IF EXISTS "entity_identity_on_delete"();',
  ].join("\n");
};
