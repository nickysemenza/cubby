import { entityRefKey } from "@cubby/schemas/entity";
import { type ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import type {
  FilterOptionKind,
  FilterOptionsInput,
  FilterOptionsOut,
} from "@cubby/schemas/filter-options";
import { type LocationId, parseEntityId } from "@cubby/schemas/identifiers";
import { ledgerPartyKind } from "@cubby/schemas/ledger-party";
import {
  getTableColumns,
  type AnyColumn,
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";

import { formatCalendarDay } from "~/lib/date-format";
import type { Database } from "~/server/db";
import { stockOnly } from "~/server/db/computed/inventory-placement";
import { productBrandNameSql } from "~/server/db/computed/product-brand-sql";
import { formatSearchTerm, getDb, notDeleted } from "~/server/db/helpers";
import {
  ingredient,
  inventoryEntry,
  location,
  product,
  purchase,
  vendor,
} from "~/server/db/schema";
import { loadLocationAncestors } from "~/server/domains/location/repo/tree";
import { getProductTagOptions } from "~/server/domains/product/repo/analytics";
import { projectNameOptions } from "~/server/domains/project/repo/lookup";
import { getAllTags as getAllRecipeTags } from "~/server/domains/recipe/repo/queries";
import { resolveEntityDisplayImages } from "~/server/entity-kernel/repo/entity-display-image";
import type { kernelScaffold as kernelScaffoldType } from "~/server/entity-kernel/scaffolds";
import { resolveLiveShortcode } from "~/server/generic/shortcode/repo/shortcode-resolver";
import {
  SHORTCODE_TABLE,
  type ShortcodeTable,
} from "~/server/generic/shortcode/repo/shortcode-utils";

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
  label: SQL;
  detail?: PgColumn | SQL;
  internalId?: PgColumn;
};

/**
 * How one dropdown roster is read. Every kind is the same query — scan a table,
 * project a shortcode/name pair, filter by search or by the already-selected
 * ids, order by name — so a kind only declares what actually differs.
 */
type FilterOptionSpec = {
  /** Scanned table; its soft-delete guard is always applied. */
  from: PgTable & { deletedAt?: AnyColumn };
  /** Public shortcode: the option id, and the column `selectedIds` matches. */
  id: PgColumn;
  /** Searched, and the primary ordering column. */
  label: SQL;
  detail?: PgColumn | SQL;
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

const optionSpec = (
  kind: FilterOptionKind,
  kernelScaffold: typeof kernelScaffoldType,
): FilterOptionSpec => {
  const entity =
    kind === "ingredientWithProduct"
      ? "ingredient"
      : kind === "locationIdentityProduct"
        ? "product"
        : kind === "locationWithInventory"
          ? "location"
          : kind;
  const table: ShortcodeTable = SHORTCODE_TABLE[entity];
  const label = kernelScaffold(entity)?.title() ?? sql`${table.shortcode}`;
  const base = { from: table, id: table.shortcode, label };
  if (kind === "product")
    return { ...base, detail: productBrandNameSql(product.brandId) };
  if (kind === "ingredientWithProduct")
    return {
      ...base,
      where: (dbClient) =>
        exists(
          dbClient
            .select({ id: product.id })
            .from(product)
            .where(
              and(eq(product.ingredientId, ingredient.id), notDeleted(product)),
            ),
        ),
    };
  if (kind === "locationIdentityProduct")
    return {
      ...base,
      from: location,
      distinct: true,
      joins: [
        {
          table: product,
          on: and(eq(product.id, location.productId), notDeleted(product)),
        },
      ],
    };
  if (kind === "locationWithInventory")
    return {
      ...base,
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
          on: and(
            eq(product.id, inventoryEntry.productId),
            notDeleted(product),
          ),
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
    };
  return base;
};

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
/** A pasted shortcode finds its record even when the label never contains it. */
const matchesLabelOrCode = (
  label: AnyColumn | SQL,
  code: AnyColumn,
  search: string,
): SQL | undefined => {
  const byLabel = formatSearchTerm(label, search);
  return byLabel && or(byLabel, formatSearchTerm(code, search.trim()));
};

async function loadRows(
  db: Database,
  input: Extract<FilterOptionsInput, { kind: FilterOptionKind }>,
  selectedOnly: boolean,
): Promise<OptionRow[]> {
  const dbClient = getDb(db);
  const { kernelScaffold } = await import("~/server/entity-kernel/scaffolds");
  const spec = optionSpec(input.kind, kernelScaffold);
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
          : matchesLabelOrCode(spec.label, spec.id, input.search),
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

async function loadEntityRows(
  db: Database,
  input: Extract<FilterOptionsInput, { source: "entity" }>,
  selectedOnly: boolean,
): Promise<EntityOptionRow[]> {
  const entity: ShortcodeEntity = input.entity;
  const { kernelScaffold } = await import("~/server/entity-kernel/scaffolds");
  const table: ShortcodeTable = SHORTCODE_TABLE[entity];
  const scaffold = kernelScaffold(entity);
  const labelColumn = scaffold?.title() ?? sql`${table.shortcode}`;
  // Purchase identity is computed from receipt facts, rather than a name column.
  const label =
    entity === "purchase"
      ? sql<string>`concat_ws(' ', ${purchase.displayLabel}, ${purchase.orderId}, ${vendor.name}, ${purchase.date})`
      : sql<string>`coalesce(${labelColumn}, ${table.shortcode})`;
  const count = input.include.includes("count")
    ? scaffold?.optionCount()
    : undefined;
  if (input.include.includes("count") && !count)
    throw new Error(`Filter option counts are not defined for ${entity}`);
  const withLogo = input.include.includes("logo");
  const kindColumn = input.include.includes("kind")
    ? scaffold?.optionKind
    : undefined;
  if (input.include.includes("kind") && !kindColumn)
    throw new Error(`Filter option kind is not defined for ${entity}`);
  const emojiColumn = getTableColumns(table).emoji;
  const withDates = input.include.includes("dates");
  if (withDates && entity !== "project")
    throw new Error(`Filter option dates are not defined for ${entity}`);
  const selected = selectedOnly ? input.selectedIds : [];
  let query = getDb(db)
    .select({
      entityId: table.id,
      id: table.shortcode,
      label: sql`coalesce(${labelColumn}, ${table.shortcode})`,
      vendorName: entity === "purchase" ? vendor.name : sql<null>`NULL::text`,
      purchaseDate:
        entity === "purchase" ? purchase.date : sql<null>`NULL::text`,
      count: count ?? sql<null>`NULL::int`,
      kind: kindColumn ?? sql<null>`NULL::text`,
      emoji: emojiColumn ?? sql<null>`NULL::text`,
    })
    .from(table)
    .$dynamic();
  if (entity === "purchase")
    query = query.leftJoin(
      vendor,
      and(eq(vendor.id, purchase.vendorId), notDeleted(vendor)),
    );
  const rows = await query
    .where(
      and(
        notDeleted(table),
        selectedOnly
          ? selected.length > 0
            ? inArray(table.shortcode, selected)
            : undefined
          : matchesLabelOrCode(label, table.shortcode, input.search),
      ),
    )
    .orderBy(...(count ? [desc(count)] : []), asc(label), asc(table.shortcode))
    .limit(selectedOnly ? 50 : input.limit + 1)
    .offset(selectedOnly ? 0 : Number(input.cursor ?? "0"));
  const imageRows = rows.map((row) => ({
    ...row,
    entityId: z.string().parse(row.entityId),
  }));
  const images = withLogo
    ? await resolveEntityDisplayImages(
        db,
        imageRows.map((row) => ({
          entityKind: entity,
          entityId: row.entityId,
        })),
      )
    : new Map();
  return imageRows.map((row) => {
    const option: EntityOptionRow = toOptionRow(
      parseOptionQueryRow({ id: row.id, label: row.label }),
    );
    if (entity === "purchase") {
      option.detail = [
        row.vendorName,
        row.purchaseDate
          ? formatCalendarDay(row.purchaseDate, "dateShort")
          : null,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    if (count) option.count = Number(row.count);
    if (withLogo)
      option.logo = images.get(entityRefKey(entity, row.entityId)) ?? null;
    if (kindColumn) option.kind = ledgerPartyKind.parse(row.kind);
    if (emojiColumn) option.emoji = z.string().nullable().parse(row.emoji);
    return option;
  });
}

type EntityOptionRow = OptionRow &
  Pick<
    FilterOptionsOut["items"][number],
    "count" | "logo" | "kind" | "emoji" | "dateWindow"
  >;

/**
 * Merges `project`'s effective content-date window onto rows already read by
 * `loadEntityRows`. Reuses `projectNameOptions` (and, through it,
 * `projectContentDates`/`aggregateSubtreeDates`) rather than re-deriving the
 * fold here, so the picker's window can never drift from the expense→project
 * suggestion ranking that depends on the same computation.
 */
async function withProjectDates(
  db: Database,
  input: Extract<FilterOptionsInput, { source: "entity" }>,
  rows: EntityOptionRow[],
): Promise<EntityOptionRow[]> {
  const excludeExpenseId = input.excludeExpenseId
    ? await resolveLiveShortcode(db, input.excludeExpenseId, "expense")
    : null;
  const windows = await projectNameOptions(db, excludeExpenseId ?? undefined);
  const byShortcode = new Map(
    windows.map((row) => [
      String(row.id),
      { effectiveStart: row.effectiveStart, effectiveEnd: row.effectiveEnd },
    ]),
  );
  return rows.map((row) => ({
    ...row,
    dateWindow: byShortcode.get(row.id) ?? {
      effectiveStart: null,
      effectiveEnd: null,
    },
  }));
}

/**
 * Recipe/product tag rosters share no table or shortcode with the `entity`
 * source: they're a distinct list folded from a free-text array column, not
 * a scanned reference table. Loaded whole (both are small, personal-household
 * vocabularies — see `getAllTags`/`getProductTagOptions`) and paginated/
 * filtered in memory, same cursor contract as every other source.
 */
type TagOptionRow = OptionRow & { count?: number };

async function loadTagRows(
  db: Database,
  input: Extract<FilterOptionsInput, { source: "tags" }>,
): Promise<TagOptionRow[]> {
  if (input.entity === "recipe") {
    const tags = await getAllRecipeTags(db);
    return tags.map((tag) => ({ id: tag, label: tag }));
  }
  const tags = await getProductTagOptions(db);
  return tags.map(({ tag, count }) => ({ id: tag, label: tag, count }));
}

async function getTagFilterOptions(
  db: Database,
  input: Extract<FilterOptionsInput, { source: "tags" }>,
): Promise<FilterOptionsOut> {
  const allRows = await loadTagRows(db, input);
  const search = input.search.trim().toLowerCase();
  const matching = search
    ? allRows.filter((row) => row.label.toLowerCase().includes(search))
    : allRows;
  const offset = Number(input.cursor ?? "0");
  const page = matching.slice(offset, offset + input.limit);
  const hasNextPage = matching.length > offset + input.limit;
  const byId = new Map(page.map((row) => [row.id, row]));
  for (const id of input.selectedIds) {
    if (byId.has(id)) continue;
    const selected = allRows.find((row) => row.id === id);
    if (selected) byId.set(id, selected);
  }
  return {
    items: [...byId.values()].map((row) => {
      const item: FilterOptionsOut["items"][number] = {
        id: row.id,
        label: row.label,
      };
      if (row.count !== undefined) item.count = row.count;
      return item;
    }),
    nextCursor: hasNextPage ? String(offset + input.limit) : null,
  };
}

export async function getFilterOptions(
  db: Database,
  input: FilterOptionsInput,
): Promise<FilterOptionsOut> {
  if (input.source === "tags") return getTagFilterOptions(db, input);
  if (input.source === "entity") {
    const withDates = input.include.includes("dates");
    const [pageRowsRaw, selectedRowsRaw] = await Promise.all([
      loadEntityRows(db, input, false),
      input.selectedIds.length > 0 ? loadEntityRows(db, input, true) : [],
    ]);
    const datedRows = withDates
      ? await withProjectDates(db, input, [...pageRowsRaw, ...selectedRowsRaw])
      : null;
    const pageRows = datedRows
      ? datedRows.slice(0, pageRowsRaw.length)
      : pageRowsRaw;
    const selectedRows = datedRows
      ? datedRows.slice(pageRowsRaw.length)
      : selectedRowsRaw;
    const hasNextPage = pageRows.length > input.limit;
    const byId = new Map(
      pageRows.slice(0, input.limit).map((row) => [row.id, row]),
    );
    for (const row of selectedRows) byId.set(row.id, row);
    return {
      items: [...byId.values()].map(({ detail, ...row }) =>
        detail ? { ...row, detail } : row,
      ),
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
