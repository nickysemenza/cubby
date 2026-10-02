import {
  allEntities,
  entityInspectorMetadata,
  entityManifest,
} from "@cubby/schemas/entity-manifest";

/** Expand-phase aliases keep deployed writers and new writers coherent until cleanup. */
export function entityEmojiAliasTriggerSql(): string {
  return allEntities
    .flatMap((entity) => {
      const presentation = entityInspectorMetadata[entity];
      const table = entityManifest[entity].dbTable;
      const field = presentation.recordEmojiField;
      if (!table || !field) return [];
      return presentation.recordEmojiAliases.map((alias) => {
        const name = `sync_${entity}_${field}_${alias}`;
        return `CREATE OR REPLACE FUNCTION "${name}"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."${field}" IS NOT NULL AND NEW."${alias}" IS NOT NULL AND NEW."${field}" IS DISTINCT FROM NEW."${alias}" THEN
      RAISE EXCEPTION 'Conflicting emoji and legacy icon values';
    END IF;
    NEW."${field}" := COALESCE(NEW."${field}", NEW."${alias}");
    NEW."${alias}" := NEW."${field}";
  ELSIF NEW."${field}" IS DISTINCT FROM OLD."${field}" THEN
    IF NEW."${alias}" IS DISTINCT FROM OLD."${alias}" AND NEW."${alias}" IS DISTINCT FROM NEW."${field}" THEN
      RAISE EXCEPTION 'Conflicting emoji and legacy icon values';
    END IF;
    NEW."${alias}" := NEW."${field}";
  ELSIF NEW."${alias}" IS DISTINCT FROM OLD."${alias}" THEN
    NEW."${field}" := NEW."${alias}";
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "${name}" ON "${table}";
CREATE TRIGGER "${name}" BEFORE INSERT OR UPDATE ON "${table}" FOR EACH ROW EXECUTE FUNCTION "${name}"();`;
      });
    })
    .join("\n\n");
}
