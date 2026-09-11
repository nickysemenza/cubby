import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ENTITY_SCHEMA_BINDINGS } from "~/server/generated/entity-bindings.gen";

/**
 * Every generated filter field must reach the canonical filter schema as the
 * SAME instance: a hand-written key with the same name would silently shadow
 * the declaration and reintroduce the drift the descriptors exist to remove.
 */
const generatedModules = import.meta.glob<object>(
  "../../../../packages/schemas/src/generated/entity-field-schemas.*.gen.ts",
  { eager: true },
);
const filterFieldMap = z.record(z.string(), z.instanceof(z.ZodType));

const cases = Object.entries(generatedModules).flatMap(([path, module]) => {
  const entity = /entity-field-schemas\.([^.]+)\.gen\.ts$/u.exec(path)?.[1];
  const exported = Object.entries(module).find(([name]) =>
    name.endsWith("FilterFields"),
  );
  if (!entity || !exported) return [];
  const fields = filterFieldMap.safeParse(exported[1]);
  return fields.success
    ? [{ entity, exportName: exported[0], fields: fields.data }]
    : [];
});

describe("generated filter fields", () => {
  it("covers the entities that declare derived filters", () => {
    expect(cases.length).toBeGreaterThan(10);
  });

  it.each(cases)(
    "$entity: canonical filters reuse every generated field by identity",
    ({ entity, fields }) => {
      const binding = Object.entries(ENTITY_SCHEMA_BINDINGS).find(
        ([key]) => key === entity,
      )?.[1];
      if (!binding) throw new Error(`${entity} has no schema binding`);
      const canonical = binding.filters;
      expect(canonical).toBeInstanceOf(z.ZodObject);
      if (!(canonical instanceof z.ZodObject)) return;
      const canonicalFields: Partial<Record<string, z.ZodType>> =
        canonical.shape;
      for (const [key, schema] of Object.entries(fields)) {
        expect(canonicalFields[key], `${entity}.${key} is shadowed`).toBe(
          schema,
        );
      }
    },
  );
});
