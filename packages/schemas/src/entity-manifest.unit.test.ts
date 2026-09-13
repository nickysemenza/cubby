import { LEGACY_SHORTCODE_PREFIX, SHORTCODE_PREFIX } from "@cubby/shared";
import { describe, expect, it } from "vitest";
import { auditEntitySchema } from "./audit";
import { type Entity, entityImage, entitySchema } from "./entity";
import {
  allEntities,
  auditableEntities,
  browserRoutedEntities,
  countableEntities,
  entityDescriptor,
  entityInspectorMetadata,
  type EntityDescriptor,
  entityManifest,
  entityReferences,
  imageEntities,
  searchableEntities,
  shortcodeEntities,
} from "./entity-manifest";

const sorted = (xs: readonly string[]) => [...xs].sort();

const descriptor = (entity: Entity): EntityDescriptor =>
  entityDescriptor.parse(entityManifest[entity]);

const IMAGE_KEY = {
  product: "PRODUCT",
  recipe: "RECIPE",
  cookbook: "COOKBOOK",
  location: "LOCATION",
  project: "PROJECT",
  purchase: "PURCHASE",
  gardenEntry: "GARDENENTRY",
} satisfies Partial<Record<Entity, string>>;

describe("entity manifest", () => {
  it("covers every entity exactly once, each a valid descriptor", () => {
    expect(sorted(allEntities)).toEqual(sorted(entitySchema.options));
    for (const entity of allEntities) {
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

  it("derives browser-routed entities, now including the ledger pair", () => {
    // `ledgerParty`/`ledgerTransfer` were the last route-less entities; every
    // entity in the manifest now carries a browser route.
    expect(browserRoutedEntities).toContain("ledgerParty");
    expect(browserRoutedEntities).toContain("ledgerTransfer");
    expect(browserRoutedEntities.length).toBe(allEntities.length);
    for (const entity of browserRoutedEntities) {
      expect(descriptor(entity).browserRoutes).not.toBe(false);
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
    for (const entity of allEntities) {
      if (entityManifest[entity].lifecycle.delete?.mode === "soft") {
        // oxlint-disable-next-line vitest/no-conditional-expect -- The data-dependent branch determines whether this optional case is applicable.
        expect(entityManifest[entity].softDelete).toBe(true);
      }
    }
  });

  it("every gallery-bearing entity references `image`", () => {
    for (const entity of allEntities) {
      if (entityManifest[entity].hasImages) {
        // oxlint-disable-next-line vitest/no-conditional-expect -- The data-dependent branch determines whether this optional case is applicable.
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
      "ledgerParty",
      "ledgerTransfer",
      "project",
      "task",
      "vendor",
      "purchase",
      "financialAccount",
      "financialTransaction",
      "wish",
      "expense",
      "planting",
      "gardenEntry",
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
      "planting",
      "gardenEntry",
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
      "gardenEntry",
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

  it("publishes client-safe inspector identity and reference metadata", () => {
    expect(Object.keys(entityInspectorMetadata).sort()).toEqual(
      [...allEntities].sort(),
    );
    for (const entity of allEntities) {
      const metadata = entityInspectorMetadata[entity];
      expect(metadata.shortcodePrefix).toBe(
        descriptor(entity).shortcodePrefix ?? null,
      );
      expect(metadata.references).toEqual(entityReferences(entity));
    }
    expect(entityInspectorMetadata.purchase.titleField).toBe("displayLabel");
    expect(entityInspectorMetadata.inventory.titleField).toBe("name");
    expect(entityInspectorMetadata.product).toMatchObject({
      auditable: true,
      hasImages: true,
      countable: true,
      kernelActions: [
        "get",
        "list",
        "search",
        "create",
        "update",
        "bulkUpdate",
        "delete",
        "merge",
      ],
      mcpOperations: [
        "get",
        "list",
        "search",
        "create",
        "update",
        "delete",
        "bulkUpdate",
        "merge",
      ],
      mcpOwner: "kernel",
      operationOwners: { delete: "kernel", merge: "kernel" },
      lifecycle: {
        softDelete: true,
        delete: { mode: "soft", bulk: true },
        merge: true,
      },
      sourceRefs: {
        output: "@cubby/schemas/product#productTopLevelOut",
        detail: "@cubby/schemas/product#productWithFoodOut",
      },
    });
    expect(entityInspectorMetadata.product.filterUrlKeys).toContain(
      "related-vendor",
    );
  });
});
