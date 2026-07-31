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
  purchase: "PURCHASE",
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

  it("relates only to valid entities", () => {
    for (const entity of allEntities) {
      for (const rel of entityManifest[entity].relationships) {
        expect(entitySchema.options).toContain(rel.target);
      }
    }
  });

  it("gives each of an entity's relationships a unique key", () => {
    // Two relationships can share a target (project's `parent` and
    // `blocked-by` both reach project), so the key — not the target — is what
    // identifies one. A duplicate key would silently collapse them everywhere
    // downstream.
    for (const entity of allEntities) {
      const keys = entityManifest[entity].relationships.map((r) => r.key);
      expect(sorted(keys)).toEqual(sorted([...new Set(keys)]));
    }
  });

  it("only claims a delete lifecycle for entities with a table", () => {
    for (const entity of allEntities) {
      const { dbTable, lifecycle } = entityManifest[entity];
      expect(lifecycle.delete === null).toBe(dbTable === null);
    }
  });

  it("hard-deletes exactly `image`", () => {
    // `softDelete` (does the table carry a `deletedAt` column?) and
    // `lifecycle.delete.mode` (what does the delete OPERATION do?) are
    // independent, and `image` is where they disagree: the Image table has a
    // `deletedAt`, but `deleteImages` removes the row and the R2 object
    // outright, because a tombstoned image whose bytes are gone is worse than
    // no row at all. Asserting the hard set by value keeps that deliberate
    // mismatch from being "corrected" into agreement later.
    const hard = allEntities.filter(
      (e) => entityManifest[e].lifecycle.delete?.mode === "hard",
    );
    expect(hard).toEqual(["image"]);
    // A soft delete still requires the column that makes it possible.
    for (const entity of allEntities) {
      if (entityManifest[entity].lifecycle.delete?.mode === "soft") {
        expect(entityManifest[entity].softDelete).toBe(true);
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
      "vendor",
      "purchase",
      "expense",
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
      "vendor",
      "purchase",
      "expense",
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
      "purchase",
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
      "expense",
    ]);
  });

  it("countable entities have a db table; non-countable usda-food does not", () => {
    for (const entity of countableEntities) {
      expect(entityManifest[entity].dbTable).not.toBeNull();
    }
    expect(entityManifest["usda-food"].dbTable).toBeNull();
  });
});
