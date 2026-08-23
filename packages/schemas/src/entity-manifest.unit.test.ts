import { LEGACY_SHORTCODE_PREFIX, SHORTCODE_PREFIX } from "@cubby/shared";
import { describe, expect, it } from "vitest";
import { auditEntitySchema } from "./audit";
import { type Entity, entityImage, entitySchema } from "./entity";
import { previewMergeEntitySchema } from "./entity-integrity";
import {
  allEntities,
  auditableEntities,
  countableEntities,
  entityDescriptor,
  type EntityDescriptor,
  entityManifest,
  entityReferences,
  imageEntities,
  searchableEntities,
  shortcodeEntities,
} from "./entity-manifest";

const sorted = (xs: readonly string[]) => [...xs].sort();

/**
 * Widen an `as const` manifest entry to the full descriptor. Each literal entry
 * narrows to exactly the keys it declares, so an OPTIONAL key (shortcodePrefix,
 * legacyShortcodePrefix) doesn't exist on the type of an entry that omits it —
 * which is precisely what these assertions need to look at.
 */
const descriptor = (entity: Entity): EntityDescriptor =>
  entityManifest[entity] as EntityDescriptor;

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

  it("every gallery-bearing entity references `image`", () => {
    // `hasImages` drives the polymorphic Image.entityType gallery enum. A
    // relationship to one specific Image (such as Vendor.logoImageId) belongs
    // in the reference graph without making the entity a gallery owner.
    for (const entity of allEntities) {
      if (entityManifest[entity].hasImages) {
        expect(entityReferences(entity)).toContain("image");
      }
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
      "financialAccount",
      "financialTransaction",
      "wish",
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
      "financialAccount",
      "financialTransaction",
      "wish",
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
      "vendor",
      "purchase",
      "financialAccount",
      "financialTransaction",
      "wish",
      "expense",
    ]);
  });

  it("countable entities have a db table; non-countable usda-food does not", () => {
    for (const entity of countableEntities) {
      expect(entityManifest[entity].dbTable).not.toBeNull();
    }
    expect(entityManifest["usda-food"].dbTable).toBeNull();
  });

  it("derives the shortcode contract from the shared prefix registry", () => {
    // The manifest and `@cubby/shared`'s registry are two hand-kept lists of the
    // same roster — one drives the resolvers and MCP ids, the other drives the
    // parser and generators. Adding an entity to one and not the other would
    // otherwise fail late and confusingly.
    expect(sorted(shortcodeEntities)).toEqual(
      sorted(Object.keys(SHORTCODE_PREFIX)),
    );
    for (const entity of shortcodeEntities) {
      expect(entityManifest[entity].shortcodePrefix).toBe(
        SHORTCODE_PREFIX[entity],
      );
    }
  });

  it("gives every entity with a table a shortcode, with no exceptions", () => {
    const withTable = allEntities.filter(
      (entity) => entityManifest[entity].dbTable !== null,
    );
    // No carve-out any more. `image` used to opt out — "no MCP surface, no
    // name, only ever reached through the entity that owns it" — but being the
    // one entity addressed by raw uuid made it a permanent special case in
    // every shape that can name an entity, so it was given `IMG-` instead.
    expect(sorted(withTable)).toEqual(sorted(shortcodeEntities));
    // `usda-food` is the only entity without one, and it has no local table:
    // its identity is USDA's own `fdc_id`.
    expect(descriptor("usda-food").shortcodePrefix).toBeUndefined();
    expect(descriptor("usda-food").dbTable).toBeNull();
  });

  it("declares a legacy prefix exactly where one was ever minted", () => {
    const declared = allEntities.filter(
      (entity) => descriptor(entity).legacyShortcodePrefix !== undefined,
    );
    expect(sorted(declared)).toEqual(
      sorted(Object.values(LEGACY_SHORTCODE_PREFIX)),
    );
    for (const [legacy, entity] of Object.entries(LEGACY_SHORTCODE_PREFIX)) {
      expect(descriptor(entity).legacyShortcodePrefix).toBe(legacy);
    }
  });

  it("previewMergeEntitySchema matches entityManifest lifecycle.merge", () => {
    // `previewMergeEntitySchema` (entity-integrity.ts) is hand-kept rather than
    // derived from `entityManifest` at the value level: entity-manifest.ts
    // itself imports value-level schemas FROM entity-integrity.ts
    // (`entityLifecycleSchema`, `entityRelationshipSchema`), so the reverse
    // import would be circular — whichever module evaluates first would read
    // the other's not-yet-initialized export. This test is what keeps the
    // hand-kept list honest instead.
    const claimedByManifest = (entity: Entity) =>
      entityManifest[entity].lifecycle.merge;
    const inSchema = new Set<string>(previewMergeEntitySchema.options);
    const drift = allEntities
      .filter((entity) => inSchema.has(entity) !== claimedByManifest(entity))
      .map(
        (entity) =>
          `${entity}: previewMergeEntitySchema ${inSchema.has(entity) ? "has" : "lacks"} it, manifest lifecycle.merge is ${claimedByManifest(entity)}`,
      );
    expect(drift).toEqual([]);
  });
});
