import type { SQL } from "drizzle-orm";
import {
  Many,
  createTableRelationsHelpers,
  extractTablesRelationalConfig,
  getTableColumns,
} from "drizzle-orm";
import { describe, expect, it } from "vitest";

import * as schema from "~/server/db/schema";

import { relations } from "./relations";

/**
 * Guards the soft-delete rule stated at the top of `relations.ts`: a to-many
 * relation over a soft-deletable table must carry `where: notDeleted(table)`, or
 * it silently serves deleted rows.
 *
 * Not hypothetical. A missing filter on `ingredient.full.product` shipped (fixed
 * in #1008) and turned every ingredient update into a 500, because
 * `enrichProductRowsWithDataQuality` only holds entries for live products.
 * The `cubby/require-soft-delete-filter` oxlint rule cannot catch this
 * class — it scans EXISTS subqueries and is blind to Drizzle `with: {}`
 * configs — so the guard lives here, beside the presets it constrains.
 */

/**
 * Preset key -> the `schema` table it is spread onto in a `db.query.<x>` call.
 * `satisfies` keeps this exhaustive: adding an entity to `relations` without a
 * root table here is a compile error, not a silently unchecked preset.
 */
const ROOT_TABLE = {
  ingredient: "ingredient",
  product: "product",
  recipe: "recipe",
  location: "location",
  inventory: "inventoryEntry",
  task: "task",
  expense: "expense",
  meal: "meal",
} as const satisfies Record<keyof typeof relations, string>;

/**
 * Audited exceptions, keyed `<preset>.<relation path>`. The value is the reason
 * and is required — an allowlist entry without one is just a mute button.
 */
const ALLOWLIST: Record<string, string> = {};

/** The two fields of a Drizzle RQB config node this guard reads. */
type PresetNode = true | { readonly where?: SQL; readonly with?: PresetBlock };
type PresetBlock = Readonly<Record<string, PresetNode>>;

// SAFETY: every preset in `relations` is a Drizzle RQB config, so it already
// satisfies this view — which keeps only the `where`/`with` pair the guard reads
// and ignores `columns`/`orderBy`/`extras`. Widening the entity key to `string`
// is what needs the assertion; the node shape is structurally compatible.
const presets = relations as Readonly<
  Record<string, Readonly<Record<string, PresetNode>>>
>;

const config = extractTablesRelationalConfig(
  schema,
  createTableRelationsHelpers,
);

/**
 * dbName -> tsName. Built from `config.tables` rather than reusing
 * `config.tableNamesMap`, whose keys are schema-qualified ("public.Product"): a
 * bare-name lookup there returns undefined, which would silently skip the whole
 * nested walk and leave this guard vacuous.
 */
const tsNameByDbName = new Map(
  Object.values(config.tables).map((table) => [table.dbName, table.tsName]),
);

const withBlockOf = (node: PresetNode): PresetBlock | undefined =>
  node === true ? undefined : node.with;

const carriesWhere = (node: PresetNode): boolean =>
  node !== true && node.where !== undefined;

/** Records every to-many soft-deletable relation reached that carries no `where`. */
const findUnfiltered = (
  tableTsName: string,
  block: PresetBlock,
  path: string,
  violations: string[],
  unresolved: string[],
) => {
  const table = config.tables[tableTsName];
  if (!table) {
    unresolved.push(`${path} (no relational config for "${tableTsName}")`);
    return;
  }
  for (const [name, node] of Object.entries(block)) {
    const here = `${path}.${name}`;
    const relation = table.relations[name];
    if (!relation) {
      unresolved.push(`${here} (no such relation on "${tableTsName}")`);
      continue;
    }
    const target = tsNameByDbName.get(relation.referencedTableName);
    // To-one relations are skipped: Drizzle cannot put a `where` on them at all
    // (see the header comment in relations.ts). Liveness for those is filtered in
    // the transform layer instead — `mapRelation` in ./transform.ts.
    const softDeletable =
      getTableColumns(relation.referencedTable).deletedAt !== undefined;
    if (
      relation instanceof Many &&
      softDeletable &&
      !carriesWhere(node) &&
      ALLOWLIST[here] === undefined
    ) {
      // Name the table the fix needs, so the failure is directly actionable —
      // `images` alone is ambiguous across product/location/recipe image tables.
      violations.push(
        `${here} -> where: notDeleted(${target ?? relation.referencedTableName})`,
      );
    }
    const nested = withBlockOf(node);
    if (!nested) continue;
    // Never skip quietly on a failed lookup — that is how this guard would go
    // vacuous without anyone noticing.
    if (target) {
      findUnfiltered(target, nested, here, violations, unresolved);
    } else {
      unresolved.push(
        `${here} (cannot resolve target table "${relation.referencedTableName}")`,
      );
    }
  }
};

describe("relation presets", () => {
  const violations: string[] = [];
  const unresolved: string[] = [];
  for (const [entity, rootTable] of Object.entries(ROOT_TABLE)) {
    const entityPresets = presets[entity];
    if (!entityPresets) {
      unresolved.push(`${entity} (no presets found)`);
      continue;
    }
    for (const [presetName, preset] of Object.entries(entityPresets)) {
      const block = withBlockOf(preset);
      if (block) {
        findUnfiltered(
          rootTable,
          block,
          `${entity}.${presetName}`,
          violations,
          unresolved,
        );
      }
    }
  }

  it("filters soft-deleted rows on every to-many relation", () => {
    expect(violations).toEqual([]);
  });

  it("walks every relation the presets name", () => {
    expect(unresolved).toEqual([]);
  });

  it("keeps the allowlist free of entries that are no longer unfiltered", () => {
    // A stale entry hides the fact that the hole was already closed.
    expect(
      Object.keys(ALLOWLIST).filter(
        (key) => !violations.some((entry) => entry.startsWith(`${key} ->`)),
      ),
    ).toEqual([]);
  });
});
