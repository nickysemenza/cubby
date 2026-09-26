import { type ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import type {
  FilterOptionKind,
  FilterOptionsInput,
  FilterOptionsOut,
} from "@cubby/schemas/filter-options";
import { type LocationId, parseEntityId } from "@cubby/schemas/identifiers";
import {
  type AnyColumn,
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  type SQL,
  sql,
} from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  entityAttachment,
  image,
  ingredient,
  inventoryEntry,
  location,
  product,
  project,
  task,
  vendor,
} from "~/server/db/schema";
import {
  formatSearchTerm,
  getDb,
  notDeleted,
} from "~/server/repo/database-helpers";
import { financialAccountTransactionCount } from "~/server/repo/financial-account";
import { displayableImageWhere } from "~/server/repo/image-displayability";
import { stockOnly } from "~/server/repo/inventory/placement";
import { loadLocationAncestors } from "~/server/repo/location/tree";
import { DISPLAY_NAME_COLUMN } from "~/server/repo/shortcode-resolver";
import {
  SHORTCODE_TABLE,
  type ShortcodeTable,
} from "~/server/repo/shortcode-utils";
import { vendorPurchaseCount } from "~/server/repo/vendor";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";

type DbClient = ReturnType<typeof getDb>;

type OptionRow = {
  id: string;
  label: string;
  detail?: string | null;
};

/**
 * What a `decorate` post-pass gets: the option plus the internal row id its
 * spec asked for. Only `locationWithInventory` decorates, so the id is a
 * `LocationId` — the same brand `spec.internalId` (`location.id`) carries.
 */
type DecorableRow = OptionRow & { internalId: LocationId };

type FilterOptionSelection = {
  id: PgColumn;
  label: PgColumn;
  detail?: PgColumn;
  internalId?: PgColumn;
};

/**
 * How one dropdown roster is read. Every kind is the same query — scan a table,
 * project a shortcode/name pair, filter by search or by the already-selected
 * ids, order by name — so a kind only declares what actually differs.
 */
type FilterOptionSpec = {
  /** Scanned table; its soft-delete guard is always applied. */
  from: PgTable & { deletedAt: AnyColumn };
  /** Public shortcode: the option id, and the column `selectedIds` matches. */
  id: PgColumn;
  /** Searched, and the primary ordering column. */
  label: PgColumn;
  detail?: PgColumn;
  /** Set when a join can multiply rows, so the roster stays one row per option. */
  distinct?: boolean;
  joins?: readonly { table: PgTable; on: SQL | undefined }[];
  /** Extra narrowing that needs a query builder (an EXISTS subquery). */
  where?: (dbClient: DbClient) => SQL;
  /** Selected alongside the option purely so `decorate` can key on it. */
  internalId?: PgColumn;
  /** Post-pass for detail that a single query cannot produce. */
  decorate?: (db: Database, rows: DecorableRow[]) => Promise<OptionRow[]>;
};

const FILTER_OPTION_SPECS = {
  product: {
    from: product,
    id: product.shortcode,
    label: product.name,
    detail: product.manufacturer,
  },
  task: { from: task, id: task.shortcode, label: task.name },
  project: { from: project, id: project.shortcode, label: project.name },
  vendor: { from: vendor, id: vendor.shortcode, label: vendor.name },

  ingredientWithProduct: {
    from: ingredient,
    id: ingredient.shortcode,
    label: ingredient.name,
    where: (dbClient) =>
      exists(
        dbClient
          .select({ id: product.id })
          .from(product)
          .where(
            and(eq(product.ingredientId, ingredient.id), notDeleted(product)),
          ),
      ),
  },

  locationIdentityProduct: {
    from: location,
    id: product.shortcode,
    label: product.name,
    distinct: true,
    joins: [
      {
        table: product,
        on: and(eq(product.id, location.productId), notDeleted(product)),
      },
    ],
  },

  locationWithInventory: {
    from: location,
    id: location.shortcode,
    label: location.name,
    distinct: true,
    internalId: location.id,
    joins: [
      {
        table: inventoryEntry,
        on: and(
          eq(inventoryEntry.locationId, location.id),
          notDeleted(inventoryEntry),
          stockOnly(),
        ),
      },
      {
        table: product,
        on: and(eq(product.id, inventoryEntry.productId), notDeleted(product)),
      },
    ],
    decorate: async (db, rows) => {
      const ancestors = await loadLocationAncestors(
        db,
        rows.map((row) => row.internalId),
      );
      return rows.map((row) => ({
        ...row,
        detail:
          ancestors
            .get(row.internalId)
            ?.map((ancestor) => ancestor.name)
            .join(" › ") || undefined,
      }));
    },
  },
} satisfies Record<FilterOptionKind, FilterOptionSpec>;

const optionQueryRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  detail: z.string().nullable().optional(),
  internalId: z.string().optional(),
});
type OptionQueryRow = z.output<typeof optionQueryRowSchema>;

const parseOptionQueryRow = <Row>(row: Row): OptionQueryRow =>
  optionQueryRowSchema.parse(row);

const toOptionRow = (row: OptionQueryRow): OptionRow => ({
  id: row.id,
  label: row.label,
  detail: row.detail ?? null,
});

/**
 * Minimal option rows for high-cardinality list filters. This deliberately
 * bypasses entity mappers: a dropdown never needs images, relation hydration,
 * pricing, counts, or data-quality enrichment.
 */
async function loadRows(
  db: Database,
  input: Extract<FilterOptionsInput, { kind: FilterOptionKind }>,
  selectedOnly: boolean,
): Promise<OptionRow[]> {
  const dbClient = getDb(db);
  const spec: FilterOptionSpec = FILTER_OPTION_SPECS[input.kind];
  const offset = selectedOnly ? 0 : Number(input.cursor ?? "0");
  const limit = selectedOnly ? undefined : input.limit + 1;
  const selected = selectedOnly ? input.selectedIds : [];

  const selection: FilterOptionSelection = {
    id: spec.id,
    label: spec.label,
  };
  if (spec.detail) selection.detail = spec.detail;
  if (spec.internalId) selection.internalId = spec.internalId;

  let query = (
    spec.distinct
      ? dbClient.selectDistinct(selection)
      : dbClient.select(selection)
  )
    .from(spec.from)
    .$dynamic();
  for (const join of spec.joins ?? []) {
    query = query.innerJoin(join.table, join.on);
  }

  // Parse this dynamic projection once at the raw-query seam. `internalId`
  // exists only for the location decorator.
  const rows = await query
    .where(
      and(
        notDeleted(spec.from),
        spec.where?.(dbClient),
        selectedOnly
          ? selected.length > 0
            ? inArray(spec.id, selected)
            : undefined
          : formatSearchTerm(spec.label, input.search),
      ),
    )
    .orderBy(asc(spec.label), asc(spec.id))
    .limit(limit ?? 50)
    .offset(offset);

  const parsedRows = rows.map(parseOptionQueryRow);
  if (!spec.decorate) return parsedRows.map(toOptionRow);
  return spec.decorate(
    db,
    parsedRows.map((row) => {
      if (row.internalId === undefined) {
        throw new Error("Decorated filter option row omitted its internal id");
      }
      return {
        ...toOptionRow(row),
        internalId: parseEntityId("location", row.internalId),
      };
    }),
  );
}

/**
 * Generic public-reference roster. It deliberately reads the same shortcode
 * table and declared display-name column the resolver owns, rather than
 * teaching filters a second per-entity table/name registry.
 */
async function loadEntityRows(
  db: Database,
  input: Extract<FilterOptionsInput, { source: "entity" }>,
  selectedOnly: boolean,
): Promise<EntityOptionRow[]> {
  const entity: ShortcodeEntity = input.entity;
  const table: ShortcodeTable = SHORTCODE_TABLE[entity];
  const label = DISPLAY_NAME_COLUMN[entity];
  if (!label)
    throw new Error(`Entity filter options require a label for ${entity}`);
  const count = input.include.includes("count") ? optionCountFor(entity) : null;
  const withLogo = input.include.includes("logo");
  const selected = selectedOnly ? input.selectedIds : [];
  let query = getDb(db)
    .select({
      id: table.shortcode,
      label,
      count: count ?? sql<null>`NULL::int`,
      logoKey: withLogo ? image.key : sql<null>`NULL::text`,
    })
    .from(table)
    .$dynamic();
  if (withLogo)
    query = query
      .leftJoin(
        entityAttachment,
        and(
          eq(entityAttachment.subjectEntityId, table.id),
          eq(entityAttachment.role, "logo"),
          notDeleted(entityAttachment),
        ),
      )
      .leftJoin(
        image,
        and(
          eq(image.id, entityAttachment.imageId),
          notDeleted(image),
          displayableImageWhere,
        ),
      );
  const rows = await query
    .where(
      and(
        notDeleted(table),
        selectedOnly
          ? selected.length > 0
            ? inArray(table.shortcode, selected)
            : undefined
          : formatSearchTerm(label, input.search),
      ),
    )
    .orderBy(...(count ? [desc(count)] : []), asc(label), asc(table.shortcode))
    .limit(selectedOnly ? 50 : input.limit + 1)
    .offset(selectedOnly ? 0 : Number(input.cursor ?? "0"));
  return rows.map((row) => {
    const option: EntityOptionRow = toOptionRow(
      parseOptionQueryRow({ id: row.id, label: row.label }),
    );
    if (count) option.count = Number(row.count);
    if (withLogo)
      option.logo = row.logoKey ? { url: getR2PublicUrl(row.logoKey) } : null;
    return option;
  });
}

type EntityOptionRow = OptionRow &
  Pick<FilterOptionsOut["items"][number], "count" | "logo">;

/**
 * The usage a `count` projection ranks by. An entity absent here refuses the
 * projection rather than reporting a zero it never measured.
 */
const OPTION_COUNTS = new Map<ShortcodeEntity, SQL<number>>([
  ["vendor", vendorPurchaseCount],
  ["financialAccount", financialAccountTransactionCount],
]);

const optionCountFor = (entity: ShortcodeEntity): SQL<number> => {
  const count = OPTION_COUNTS.get(entity);
  if (!count)
    throw new Error(`Filter option counts are not defined for ${entity}`);
  return count;
};

export async function getFilterOptions(
  db: Database,
  input: FilterOptionsInput,
): Promise<FilterOptionsOut> {
  if (input.source === "entity") {
    const [pageRows, selectedRows] = await Promise.all([
      loadEntityRows(db, input, false),
      input.selectedIds.length > 0 ? loadEntityRows(db, input, true) : [],
    ]);
    const hasNextPage = pageRows.length > input.limit;
    const byId = new Map(
      pageRows.slice(0, input.limit).map((row) => [row.id, row]),
    );
    for (const row of selectedRows) byId.set(row.id, row);
    return {
      items: [...byId.values()].map(({ detail: _detail, ...row }) => row),
      nextCursor: hasNextPage
        ? String(Number(input.cursor ?? "0") + input.limit)
        : null,
    };
  }
  const [pageRows, selectedRows] = await Promise.all([
    loadRows(db, input, false),
    input.selectedIds.length > 0 ? loadRows(db, input, true) : [],
  ]);
  const hasNextPage = pageRows.length > input.limit;
  const page = pageRows.slice(0, input.limit);
  const byId = new Map(page.map((row) => [row.id, row]));
  for (const row of selectedRows) byId.set(row.id, row);

  const items = [...byId.values()].map(({ id, label, detail }) => {
    const item: FilterOptionsOut["items"][number] = { id, label };
    if (detail) item.detail = detail;
    return item;
  });
  return {
    items,
    nextCursor: hasNextPage
      ? String(Number(input.cursor ?? "0") + input.limit)
      : null,
  };
}
