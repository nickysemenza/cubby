import type { CompiledEntityPresentation } from "@cubby/schemas/entity-definitions/definition";
import { generatedEntityEditIntents } from "@cubby/schemas/entity-edit-intents";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import {
  entityInspectorMetadata,
  entityManifest,
  type BrowserRoutedEntity,
} from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { Link } from "@tanstack/react-router";
import { flexRender, type RowData } from "@tanstack/react-table";
import { ArrowUpRight, Plus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { ErrorDisplay } from "~/components/feedback/error-display";
import { Button } from "~/components/ui/button";
import { EntityEditDialog } from "~/entities/editing/entity-edit-dialog";
import type { EditableEntity } from "~/entities/editing/types";
import {
  defaultSortDirectionFor,
  defaultSortFor,
  entities,
} from "~/entities/entities";
import { createEntityDisplayColumns } from "~/entities/entity-display";
import { entityList, entityListFor } from "~/entities/entity-list.functions";
import {
  listEntities,
  type ListEntity,
} from "~/entities/generated/entity-lists.gen";

import { useSectionCount, useSectionVisible } from "../data-table/detail-page";
import { ListWorkbench } from "../data-table/ListWorkbench";
import {
  createCubbyColumnHelper,
  type CubbyTable,
} from "../data-table/table-features";
import { type BaseListRow, useEntityList } from "../hooks/useEntityList";
import type { ListQueryOptionsFn } from "../hooks/usePaginatedTableCore";

type RelationSection = Extract<
  CompiledEntityPresentation["detail"]["sections"][number],
  { kind: "relation" }
>;

/** What a relation section resolves to once the manifest is consulted. */
export interface RelationSectionPlan {
  target: ListEntity;
  /** The descriptor's column id — the filter control the scoped table hides. */
  descriptorId: string;
  /** The list filter key (`field ?? columnId`) that scopes the target's list. */
  filterKey: string;
  /** The URL key the target's list route reads for the same filter. */
  urlKey: string;
  /** The create-intent field the section's create button prefills, if any. */
  seed: { intent: string; field: string } | null;
  /** Whether the seeded field is an id array (`idMulti`/many reference). */
  seedMultiple: boolean;
  columns: readonly string[] | null;
  sort: { field: string; direction: "asc" | "desc" };
  limit: number | null;
  /** Skip the whole section, on both platforms, when its first page is empty. */
  hideWhenEmpty: boolean;
}

const isListEntity = (value: string): value is ListEntity =>
  listEntities.some((entity) => entity === value);

interface DeclaredEditIntents {
  fields: Readonly<Partial<Record<string, readonly string[]>>>;
  create: readonly string[];
}

/** The create intents a list entity declares, or none for one without editing. */
const editIntentsFor = (entity: ListEntity): DeclaredEditIntents | undefined =>
  // SAFETY: `generatedEntityEditIntents` is `satisfies Partial<Record<Entity,
  // …>>`; indexing by a list entity is either its roster or absent.
  (
    generatedEntityEditIntents as Partial<
      Record<ListEntity, DeclaredEditIntents>
    >
  )[entity];

/** The first declared create intent of `target` that can be seeded through `field`. */
function createSeedThrough(
  target: ListEntity,
  field: string,
): { intent: string; field: string; multiple: boolean } | null {
  const intents = editIntentsFor(target);
  const intent = intents?.create.find((candidate) =>
    intents.fields[candidate]?.includes(field),
  );
  const modelField = entityFieldModels[target].fields.find(
    (candidate) => candidate.key === field,
  );
  return intent === undefined
    ? null
    : { intent, field, multiple: modelField?.reference?.multiple === true };
}

/**
 * Resolve a declared relation section against the manifest: the relation's
 * target, the target's descriptor (checked by the entity compiler to be an
 * id filter pointing back at the source), and the create seed. Pure so the
 * table's test can assert the resolved filter and links without rendering.
 */
export function planRelationSection(
  entity: BrowserRoutedEntity,
  section: Pick<
    RelationSection,
    | "relation"
    | "filter"
    | "prefill"
    | "columns"
    | "sort"
    | "limit"
    | "hideWhenEmpty"
  >,
): RelationSectionPlan {
  const relation = entityManifest[entity].relationships.find(
    (candidate) => candidate.key === section.relation,
  );
  if (relation === undefined)
    throw new Error(`${entity} declares no relation ${section.relation}`);
  const target = relation.target;
  if (!isListEntity(target))
    throw new Error(
      `${entity}.${section.relation} targets ${target}, which has no list`,
    );
  const descriptor = entityInspectorMetadata[target].filterDescriptors.find(
    (candidate) => candidate.columnId === section.filter.descriptor,
  );
  if (descriptor === undefined)
    throw new Error(
      `${target} declares no filter descriptor ${section.filter.descriptor}`,
    );
  const filterKey = descriptor.field ?? descriptor.columnId;
  // A create intent can only be prefilled through a real field key, which
  // is what a `<key>Filter` list-filter alias names once the suffix goes.
  const seedField = filterKey.replace(/Filter$/u, "");
  const explicitField = section.prefill?.field;
  let seed = createSeedThrough(target, explicitField ?? seedField);
  // The descriptor's own key names no create field — a derived/urlOnly
  // descriptor like `journalPlantingId` reads a computed column, not a
  // storage field. Fall back to the target's own reference field pointing at
  // the same entity the descriptor scopes by, so its create button still
  // seeds a real, writable field. Explicit `prefill` is required when that
  // fallback would be ambiguous or needs a multiple reference.
  if (
    (section.prefill === null || section.prefill === undefined) &&
    seed === null &&
    descriptor.brandRef !== null
  ) {
    const referenceField = entityFieldModels[target].fields.find(
      (field) => field.reference?.entity === descriptor.brandRef?.entity,
    );
    if (referenceField !== undefined)
      seed = createSeedThrough(target, referenceField.key);
  }
  return {
    target,
    descriptorId: descriptor.columnId,
    filterKey,
    urlKey: descriptor.urlKey,
    seed: seed ? { intent: seed.intent, field: seed.field } : null,
    seedMultiple: seed?.multiple === true,
    columns: section.columns,
    sort: section.sort ?? {
      field: defaultSortFor(target),
      direction: defaultSortDirectionFor(target),
    },
    limit: section.limit,
    hideWhenEmpty: section.hideWhenEmpty,
  };
}

const DEFAULT_RELATION_PAGE_SIZE = 50;

export interface EntityRelationTableOperations {
  list: typeof entityList.list;
}

const productionOperations: EntityRelationTableOperations = {
  list: entityList.list,
};

/**
 * Shared create-dialog state for a relation section's "+ Add"/"New <thing>"
 * triggers — the header action and the empty state each mount their own
 * instance (only one is ever visible at a time), so neither has to reach
 * into the other's state.
 */
function useRelationCreateDialog(plan: RelationSectionPlan, recordId: string) {
  const [creating, setCreating] = useState(false);
  const dialog =
    plan.seed !== null ? (
      <EntityEditDialog
        open={creating}
        onOpenChange={setCreating}
        // SAFETY: `seed.intent` is the target's own first create intent and
        // `seed.field` one of that intent's declared fields; the generic
        // dialog resolves both at runtime through the registry.
        request={
          {
            entity: plan.target as EditableEntity,
            operation: "create",
            intent: plan.seed.intent,
            seed: {
              [plan.seed.field]: plan.seedMultiple ? [recordId] : recordId,
            },
          } as never
        }
      />
    ) : null;
  return { creating, setCreating, dialog };
}

/**
 * A relation section's header-row actions: "+ Add" (or a declared
 * `createLabel`, e.g. the journal's "Log entry") plus "Open all", rendered as
 * the `SectionCard`'s `headerAction` — physically in the header row, not the
 * body, so both persist even while the section is collapsed... except they
 * don't: `SectionCard` hides `headerAction` while collapsed-and-closed.
 */
export function RelationSectionActions({
  plan,
  recordId,
  title,
  createLabel,
}: {
  plan: RelationSectionPlan;
  recordId: string;
  title: string;
  createLabel?: string;
}) {
  const { singular } = entitySummary[plan.target];
  const { setCreating, dialog } = useRelationCreateDialog(plan, recordId);

  return (
    <div className="flex items-center gap-1">
      {plan.seed !== null ? (
        <Button
          variant="ghost"
          size="sm"
          aria-label={createLabel ?? `New ${singular.toLocaleLowerCase()}`}
          onClick={() => setCreating(true)}
        >
          <Plus />
          {createLabel ?? "Add"}
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        nativeButton={false}
        render={
          <Link
            to={entities[plan.target].routes.list}
            search={{ [plan.urlKey]: recordId }}
            aria-label={`Open all ${title.toLocaleLowerCase()}`}
          />
        }
      >
        Open all
        <ArrowUpRight />
      </Button>
      {dialog}
    </div>
  );
}

/** No data yet, no error: the SectionStates empty vocabulary — a sentence of
 * state, a sentence of consequence, one action. The journal variant keeps its
 * own single-line `emptyLabel` instead (it already leads with "Log entry"). */
function RelationEmptyState({
  plan,
  recordId,
  pluralLabel,
  singular,
  emptyLabel,
}: {
  plan: RelationSectionPlan;
  recordId: string;
  pluralLabel: string;
  singular: string;
  emptyLabel: string | undefined;
}) {
  const { setCreating, dialog } = useRelationCreateDialog(plan, recordId);
  if (emptyLabel) {
    return <p className="text-xs text-muted-foreground">{emptyLabel}</p>;
  }
  const lowerPlural = pluralLabel.toLocaleLowerCase();
  return (
    <div className="flex flex-col items-start gap-1.5 py-2">
      <p className="text-sm text-foreground">No {lowerPlural} yet.</p>
      <p className="max-w-[40ch] text-xs text-muted-foreground">
        Add one and it appears here and on the {lowerPlural} list.
      </p>
      {plan.seed !== null ? (
        <Button
          variant="outline"
          size="sm"
          className="mt-1"
          onClick={() => setCreating(true)}
        >
          <Plus />
          New {singular.toLocaleLowerCase()}
        </Button>
      ) : null}
      {dialog}
    </div>
  );
}

/**
 * The declaration renders its header and columns immediately; only cells are
 * skeletons, sized like the data they'll hold, no shimmer — `RTable`'s own
 * `isLoading` state replaces the whole table with a spinner, which loses the
 * header, so this reuses the real (data-independent) header row instead.
 */
function RelationLoadingSkeleton<TItem extends RowData>({
  table,
  rows,
}: {
  table: CubbyTable<TItem>;
  rows: number;
}) {
  const headerGroups = table.getHeaderGroups();
  const leafHeaders = headerGroups[headerGroups.length - 1]?.headers ?? [];
  return (
    <table
      className="w-full border-collapse text-xs"
      aria-busy
      aria-label="Loading"
    >
      <thead>
        {headerGroups.map((headerGroup) => (
          <tr key={headerGroup.id}>
            {headerGroup.headers.map((header) => (
              <th
                key={header.id}
                className="h-8 border-b border-border px-2 text-left font-mono text-2xs font-medium tracking-wider text-muted-foreground uppercase"
              >
                {header.isPlaceholder
                  ? null
                  : flexRender(
                      header.column.columnDef.header,
                      header.getContext(),
                    )}
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {Array.from({ length: rows }, (_, rowIndex) => (
          <tr key={rowIndex} className="h-7 border-b border-border/60">
            {leafHeaders.map((header, cellIndex) => (
              <td key={header.id} className="px-2">
                {cellIndex === 0 && rowIndex === 0 ? (
                  <span className="sr-only">Loading</span>
                ) : null}
                <div
                  aria-hidden
                  className="h-3 rounded-sm bg-muted"
                  style={{
                    width: `${40 + ((cellIndex * 17 + rowIndex * 11) % 40)}%`,
                  }}
                />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type RelationRow = BaseListRow;
/** One descriptor key → the record's shortcode; the target's schema parses it. */
type RelationFilters = Partial<Record<string, string>>;

const EMBEDDED_TABLE_STATE = {
  urlSync: false,
  readUrlState: false,
  syncPaginationToUrl: false,
} as const;

/**
 * A relation section's body: the target entity's own list, scoped to this
 * record through the declared descriptor, over the shared list workbench so
 * the rows carry the target's registered row actions. No checkbox column or
 * toolbar (`selectable: false`, `toolbarMode="none"`) — a scoped ledger row
 * still gets its own `…` menu.
 */
export function EntityRelationTable({
  plan,
  recordId,
  title,
  emptyLabel,
  operations = productionOperations,
}: {
  plan: RelationSectionPlan;
  recordId: string;
  title: string;
  /** The journal variant's single-line empty copy, in place of the generic
   * "No <plural> yet" sentence. */
  emptyLabel?: string;
  /** Injectable transport seam for tests; production keeps the real one. */
  operations?: EntityRelationTableOperations;
}) {
  const { target } = plan;
  const listQueryOptions: ListQueryOptionsFn<RelationFilters, RelationRow> =
    useCallback(
      (params) =>
        // SAFETY: the filter object carries the descriptor key the entity
        // compiler checked against this target; the wire input is parsed by
        // the target's own list schema before it executes.
        entityListFor(target, operations.list).listQueryPlan(params as never),
      [operations.list, target],
    );
  const helper = useMemo(() => createCubbyColumnHelper<RelationRow>(), []);
  const scope = useMemo<RelationFilters>(
    () => ({ [plan.filterKey]: recordId }),
    [plan.filterKey, recordId],
  );
  const columns = useMemo(
    () =>
      createEntityDisplayColumns<RelationRow>(target, helper, undefined, {
        only: plan.columns ?? undefined,
      }),
    [helper, plan.columns, target],
  );
  const tableStateOptions = useMemo(
    () => ({
      ...EMBEDDED_TABLE_STATE,
      initialSort: plan.sort.field,
      initialSortDesc: plan.sort.direction === "desc",
      initialPagination: {
        pageIndex: 0,
        pageSize: plan.limit ?? DEFAULT_RELATION_PAGE_SIZE,
      },
    }),
    [plan.limit, plan.sort.direction, plan.sort.field],
  );
  const list = useEntityList<RelationRow, RelationFilters>({
    entity: target,
    queryOptions: listQueryOptions,
    scopeFilters: scope,
    columns,
    tableStateOptions,
    hiddenFilterColumns: [plan.descriptorId],
    // H2: never `includeCatalogActions: false` here — that would empty the
    // row `…` menu too. This only drops the checkbox column and bulk bar.
    selectable: false,
  });
  useSectionCount(list.totalCount);
  // `list.totalCount` stays `undefined` until the first response lands (see
  // `useEntityList`), so this only fires once the read genuinely resolves
  // empty — never mid-fetch, and never on an error (which leaves it
  // `undefined` too since the query never completes with data).
  useSectionVisible(
    !(plan.hideWhenEmpty && !list.workbench.error && list.totalCount === 0),
  );
  const { singular } = entitySummary[target];
  const { pluralLabel } = entities[target];

  if (list.workbench.error) {
    return (
      <ErrorDisplay
        title={title.toLocaleLowerCase()}
        error={list.workbench.error}
        onRetry={() => void list.workbench.refreshControls.onRefresh()}
      />
    );
  }

  if (list.workbench.isLoading) {
    return (
      <RelationLoadingSkeleton
        table={list.workbench.table}
        rows={plan.limit != null ? Math.min(plan.limit, 3) : 3}
      />
    );
  }

  if (list.totalCount === 0) {
    return (
      <RelationEmptyState
        plan={plan}
        recordId={recordId}
        pluralLabel={pluralLabel}
        singular={singular}
        emptyLabel={emptyLabel}
      />
    );
  }

  const truncated =
    plan.limit != null &&
    list.totalCount !== undefined &&
    list.totalCount > plan.limit;

  return (
    <div className="space-y-2">
      <ListWorkbench
        model={list.workbench}
        mode="embedded"
        toolbarMode="none"
        ariaLabel={title}
      />
      {truncated ? (
        <p className="text-xs text-muted-foreground">
          Showing {plan.limit} of {list.totalCount} ·{" "}
          <Link
            to={entities[target].routes.list}
            search={{ [plan.urlKey]: recordId }}
          >
            Open all
          </Link>
        </p>
      ) : null}
    </div>
  );
}
