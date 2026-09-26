import { LEGACY_SHORTCODE_PREFIX, SHORTCODE_PREFIX } from "@cubby/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type Entity, entitySchema } from "./entity";
import { entityFieldModels } from "./entity-fields";
import {
  allEntities,
  countableEntities,
  embeddableEntities,
  entityDescriptor,
  entityInspectorMetadata,
  type EntityDescriptor,
  entityManifest,
  entityReferences,
  imageIngressRouteById,
  type ImageIngressRoute,
  searchableEntities,
  shortcodeEntities,
} from "./entity-manifest";
import { entitySummary } from "./generated/entity-summary.gen";

const sorted = (xs: readonly string[]) => [...xs].sort();

const descriptor = (entity: Entity): EntityDescriptor =>
  entityDescriptor.parse(entityManifest[entity]);

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
    // `importRun` is the one stored entity that is immutable history:
    // it has a table and deliberately no delete lifecycle.
    for (const entity of allEntities) {
      const { dbTable, lifecycle } = entityManifest[entity];
      expect(lifecycle.delete === null).toBe(
        dbTable === null || entity === "importRun",
      );
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

  it("never proxies a photo route through a natural image owner", () => {
    const ingressRoutes: readonly ImageIngressRoute[] = Object.values(
      imageIngressRouteById,
    );
    expect(
      ingressRoutes.some(
        (route) =>
          route.sourceEntity === "project" && route.targetEntity === "task",
      ),
    ).toBe(false);
  });

  it("embeds only searchable entities", () => {
    for (const entity of embeddableEntities) {
      expect(searchableEntities).toContain(entity);
    }
  });

  it("countable entities have a db table", () => {
    for (const entity of countableEntities) {
      expect(entityManifest[entity].dbTable).not.toBeNull();
    }
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
    // No carve-out for `image`: being the one entity addressed by raw uuid
    // makes it a permanent special case in every shape that can name an
    // entity, so it is given `IMG-` like everything else.
    expect(sorted(withTable)).toEqual(sorted(shortcodeEntities));
  });

  it("keeps legacy aliases out of the manifest and pointed at real prefixes", () => {
    // The parser's alias table is inbound-only: every target entity mints a
    // canonical prefix, and no descriptor advertises the legacy form.
    for (const entity of Object.values(LEGACY_SHORTCODE_PREFIX)) {
      expect(descriptor(entity).shortcodePrefix).toBe(SHORTCODE_PREFIX[entity]);
    }
    for (const entity of allEntities) {
      expect(descriptor(entity)).not.toHaveProperty("legacyShortcodePrefix");
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
  });

  // `inventory` is the one documented exception: `displayName` is on the
  // entity for the titleField compiler check, but deliberately absent from
  // the bare entity's generated `output` roster — the join it needs
  // (product/location names) isn't loaded there. Its real, non-null schema
  // lives on the list/detail projections in `./inventory` instead (see
  // `inventoryDisplayName` and the comment on the `displayName` field in
  // `05-inventory.entity.ts`). Asserting in its own function (rather than
  // inline in an `if` branch) keeps every `expect` call unconditional from
  // the linter's point of view.
  async function expectInventoryTitleSchemaRejectsNull(titleField: string) {
    const { inventoryWithLocationAndProductOut } = await import("./inventory");
    // SAFETY: `titleField` is dynamic per entity (looped from
    // `entitySummary` across every entity), so it can't be a literal key of
    // this one entity's own shape type; index a `Record`-typed view instead.
    const inventoryReadSchemas: Record<string, z.ZodTypeAny> =
      inventoryWithLocationAndProductOut.shape;
    const titleSchema = inventoryReadSchemas[titleField];
    expect(titleSchema).toBeDefined();
    expect(titleSchema!.safeParse(null).success).toBe(false);
  }

  it("no entity has a nullable title: every titleField resolves to a non-null text field", async () => {
    for (const entity of allEntities) {
      const titleField = entitySummary[entity].titleField;
      const field = entityFieldModels[entity].fields.find(
        (f) => f.readKey === titleField,
      );
      expect(
        field,
        `${entity}'s titleField "${titleField}" has no matching field in entityFieldModels`,
      ).toBeDefined();
      expect(
        field!.kind,
        `${entity}'s titleField "${titleField}" is kind "${field!.kind}", not "text"`,
      ).toBe("text");

      if (entity === "inventory") {
        await expectInventoryTitleSchemaRejectsNull(titleField);
        continue;
      }

      // Every entity has a `generated/entity-field-schemas.<entity>.gen.ts`
      // exporting exactly one `generated*FieldSchemas` map, whose `.read` is
      // keyed by readKey (external field name) — see `readFieldSchemas` in
      // `entity-definitions/definition.ts`.
      const genModuleNamespace: unknown = await import(
        /* @vite-ignore */ `./generated/entity-field-schemas.${entity}.gen`
      );
      // SAFETY: the dynamically imported namespace's shape is unknown ahead
      // of time; it is only enumerated via `Object.keys` below, never
      // trusted as any concrete shape.
      // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- dynamic import target is computed, so its namespace shape is unknown ahead of time; only enumerated via Object.keys below, never trusted as any concrete shape.
      const genModule = genModuleNamespace as Record<string, unknown>;
      const [fieldSchemasExportName] = Object.keys(genModule).filter((key) =>
        /^generated.*FieldSchemas$/.test(key),
      );
      expect(
        fieldSchemasExportName,
        `entity "${entity}" -> no generated*FieldSchemas export found in entity-field-schemas.${entity}.gen.ts`,
      ).toBeDefined();
      // SAFETY: `fieldSchemasExportName` was just asserted defined above,
      // and every `generated*FieldSchemas` export follows this `{ read:
      // Record<string, ZodTypeAny> }` shape by construction (see the
      // generator referenced above).
      const generatedFieldSchemas = genModule[fieldSchemasExportName!] as {
        read: Record<string, z.ZodTypeAny>;
      };
      const titleSchema = generatedFieldSchemas.read[titleField];
      expect(
        titleSchema,
        `entity "${entity}" -> no read schema for titleField "${titleField}"`,
      ).toBeDefined();
      expect(titleSchema!.safeParse(null).success).toBe(false);
    }
  });
});
