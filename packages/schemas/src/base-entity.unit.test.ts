import { describe, expect, it } from "vitest";
import { z } from "zod";
import { entityFieldSchemaMaps } from "./generated/entity-field-schema-maps.gen";

// Destructive-default regression: an update field carrying a create-time
// `.default([])` (e.g. product `unitMappings`/`externalIds`/`aliases`/`tags`)
// turns an omitted key into `[]` and wipes the existing rows. Every canonical
// `xUpdateData` is `z.object(generated<Entity>FieldSchemas.update)`, so the
// declared update map itself must leave an omitted key undefined.
describe("generated update field maps", () => {
  it("never supply a value for an omitted key", () => {
    const defaulted = Object.entries(entityFieldSchemaMaps).flatMap(
      ([entity, maps]) =>
        Object.entries(maps.update).flatMap(([key, schema]) => {
          const parsed = z.safeParse(schema, undefined);
          return parsed.success && parsed.data !== undefined
            ? [`${entity}.${key}`]
            : [];
        }),
    );
    expect(defaulted).toEqual([]);
  });
});
