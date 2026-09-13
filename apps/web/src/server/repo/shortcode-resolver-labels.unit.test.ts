import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import type { ShortcodeType as ShortcodeEntity } from "@cubby/shared";
import { describe, expect, it } from "vitest";

import { loadEntityDeclarations } from "../../../../../scripts/entity-generator/declarations";
import {
  DISPLAY_NAME_COLUMN,
  LABEL_COLUMN_OVERRIDES,
} from "./shortcode-resolver";

/**
 * `DISPLAY_NAME_COLUMN` names the Drizzle column `lookupEntityLabels` selects
 * as a row's human label. For most entities that is the storage column
 * behind `presentation.titleField` (`packages/schemas/src/entity-
 * definitions/*.entity.ts`); `LABEL_COLUMN_OVERRIDES` is the exhaustive list
 * of deliberate exceptions. This pins every shortcode entity to one of those
 * two states so a future titleField change (or a new override) can't drift
 * from `DISPLAY_NAME_COLUMN` unnoticed.
 *
 * Compiles the real `.entity.ts` declarations with the same compiler that
 * produces `entity-inspector.gen.ts` / `entity-field-model.gen.ts`, rather
 * than reading those generated files directly — a generated artifact can lag
 * a source edit until `pnpm entity:generate` runs (as it does for WS4's
 * titleField fixes at the time this test was written), and compiling from
 * source keeps this check accurate regardless. When a field has no storage
 * entry at all (a computed/read-only value — every `usda-food` field is one),
 * there is no derivable storage column name; those entities fall back to
 * comparing `titleField` directly against the Drizzle column's own `.name`,
 * which is weaker (it can't catch a rename on the storage side) but is noted
 * here rather than silently skipped.
 */
describe("DISPLAY_NAME_COLUMN matches titleField or a declared override", () => {
  const compiledEntities = loadEntityDeclarations();

  it.each(shortcodeEntities)("%s", async (entity) => {
    const byKey = new Map((await compiledEntities).map((e) => [e.key, e]));
    const compiledEntity = byKey.get(entity);
    if (!compiledEntity) throw new Error(`${entity} did not compile`);

    // SAFETY: the map is `satisfies Partial<Record<ShortcodeEntity, …>>`, so
    // indexing by any shortcode entity yields an override or `undefined`.
    const override = (
      LABEL_COLUMN_OVERRIDES as Partial<
        Record<
          ShortcodeEntity,
          (typeof LABEL_COLUMN_OVERRIDES)[keyof typeof LABEL_COLUMN_OVERRIDES]
        >
      >
    )[entity];
    const titleField = compiledEntity.inspector.titleField;
    const field = compiledEntity.fieldModel.fields.find(
      (f) => f.readKey === titleField,
    );
    const storageEntry = field
      ? compiledEntity.fieldModel.storage.find((s) => s.key === field.key)
      : undefined;
    // Falls back to the titleField string itself when the field model has
    // no storage entry for it (see file doc comment above).
    const derivedColumnName = storageEntry?.column ?? titleField;

    const actual = DISPLAY_NAME_COLUMN[entity];
    const expected = override
      ? { source: `override: ${override.reason}`, column: override.column }
      : { source: "titleField", column: actual, columnName: derivedColumnName };
    expect({
      source: expected.source,
      column: actual,
      columnName: override ? undefined : actual?.name,
    }).toEqual({
      source: expected.source,
      column: expected.column,
      columnName: override ? undefined : derivedColumnName,
    });
  });
});
