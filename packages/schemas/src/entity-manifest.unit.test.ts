import { describe, expect, it } from "vitest";
import { auditEntitySchema } from "./audit";
import { entityImage, entitySchema } from "./entity";
import {
  allEntities,
  auditableEntities,
  countableEntities,
  entityDescriptor,
  entityManifest,
  entityReferences,
  imageEntities,
} from "./entity-manifest";

const sorted = (xs: readonly string[]) => [...xs].sort();

/** The image storage enum is UPPERCASE; map manifest entity names to it. */
const IMAGE_KEY: Record<string, string> = {
  product: "PRODUCT",
  recipe: "RECIPE",
  cookbook: "COOKBOOK",
  location: "LOCATION",
};

describe("entity manifest", () => {
  it("covers every entity exactly once, each a valid descriptor", () => {
    expect(sorted(allEntities)).toEqual(sorted(entitySchema.options));
    for (const entity of allEntities) {
      // Each entry validates against the zod descriptor and is self-consistent.
      const entry = entityManifest[entity];
      expect(() => entityDescriptor.parse(entry)).not.toThrow();
      expect(entry.name).toBe(entity);
    }
  });

  it("references only name valid entities", () => {
    for (const entity of allEntities) {
      for (const ref of entityManifest[entity].references) {
        expect(entitySchema.options).toContain(ref);
      }
    }
  });

  it("an entity references `image` iff it is image-bearing", () => {
    // Guards the reference graph against missing image edges (product/recipe/
    // location reach image through join tables, not a direct FK column).
    for (const entity of allEntities) {
      expect(entityReferences(entity).includes("image")).toBe(
        entityManifest[entity].hasImages,
      );
    }
  });

  // --- Drift guards: each projection must match the descriptor flags. If you
  // add an entity or flip a flag, the matching projection (and any consumer like
  // auditEntitySchema / entityImage) must be updated or these fail. ---

  it("auditableEntities matches `auditable` flags and the audit union", () => {
    const fromFlags = allEntities.filter((e) => entityManifest[e].auditable);
    expect(sorted(auditableEntities)).toEqual(sorted(fromFlags));
    expect(sorted(auditEntitySchema.options)).toEqual(
      sorted(auditableEntities),
    );
  });

  it("countableEntities matches `countable` flags", () => {
    const fromFlags = allEntities.filter((e) => entityManifest[e].countable);
    expect(sorted(countableEntities)).toEqual(sorted(fromFlags));
  });

  it("imageEntities matches `hasImages` flags and the image enum", () => {
    const fromFlags = allEntities.filter((e) => entityManifest[e].hasImages);
    expect(sorted(imageEntities)).toEqual(sorted(fromFlags));
    expect(sorted(imageEntities.map((e) => IMAGE_KEY[e] ?? e))).toEqual(
      sorted(entityImage.options),
    );
  });

  it("countable entities have a db table; non-countable usda-food does not", () => {
    for (const entity of countableEntities) {
      expect(entityManifest[entity].dbTable).not.toBeNull();
    }
    expect(entityManifest["usda-food"].dbTable).toBeNull();
  });
});
