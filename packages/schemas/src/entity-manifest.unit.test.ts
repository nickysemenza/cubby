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
  searchableEntities,
} from "./entity-manifest";

const sorted = (xs: readonly string[]) => [...xs].sort();

/** The image storage enum is UPPERCASE; map manifest entity names to it. */
const IMAGE_KEY: Record<string, string> = {
  product: "PRODUCT",
  recipe: "RECIPE",
  cookbook: "COOKBOOK",
  location: "LOCATION",
  project: "PROJECT",
};

describe("entity manifest", () => {
  it("covers every entity exactly once, each a valid descriptor", () => {
    expect(sorted(allEntities)).toEqual(sorted(entitySchema.options));
    for (const entity of allEntities) {
      // Each entry validates against the zod descriptor.
      const entry = entityManifest[entity];
      expect(() => entityDescriptor.parse(entry)).not.toThrow();
    }
  });

  it("references only valid entities", () => {
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

  it("derives the auditable contract and audit union", () => {
    expect(auditableEntities).toEqual([
      "product",
      "recipe",
      "ingredient",
      "cookbook",
      "location",
      "inventory",
      "meal",
      "project",
      "task",
      "purchase",
    ]);
    expect(sorted(auditEntitySchema.options)).toEqual(
      sorted(auditableEntities),
    );
  });

  it("derives the countable contract", () => {
    expect(countableEntities).toEqual([
      "product",
      "recipe",
      "ingredient",
      "cookbook",
      "location",
      "inventory",
      "meal",
      "project",
      "task",
      "purchase",
      "image",
    ]);
  });

  it("derives the image-bearing contract and storage enum", () => {
    expect(imageEntities).toEqual([
      "product",
      "recipe",
      "cookbook",
      "location",
      "project",
    ]);
    expect(sorted(imageEntities.map((e) => IMAGE_KEY[e] ?? e))).toEqual(
      sorted(entityImage.options),
    );
  });

  it("derives the searchable contract", () => {
    expect(searchableEntities).toEqual([
      "product",
      "recipe",
      "ingredient",
      "cookbook",
      "location",
      "inventory",
      "meal",
      "project",
      "task",
      "purchase",
    ]);
  });

  it("countable entities have a db table; non-countable usda-food does not", () => {
    for (const entity of countableEntities) {
      expect(entityManifest[entity].dbTable).not.toBeNull();
    }
    expect(entityManifest["usda-food"].dbTable).toBeNull();
  });
});
