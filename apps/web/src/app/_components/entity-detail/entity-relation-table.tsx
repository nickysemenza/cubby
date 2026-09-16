import type { CompiledEntityPresentation } from "@cubby/schemas/entity-definitions/definition";
import { generatedEntityEditIntents } from "@cubby/schemas/entity-edit-intents";
import {
  entityInspectorMetadata,
  entityManifest,
  type BrowserRoutedEntity,
} from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Plus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { NoneValue } from "~/components/ui/none-value";
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

import { ListWorkbench } from "../data-table/ListWorkbench";
import { createCubbyColumnHelper } from "../data-table/table-features";
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
  columns: readonly string[] | null;
  sort: { field: string; direction: "asc" | "desc" };
  limit: number | null;
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
    "relation" | "filter" | "columns" | "sort" | "limit"
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
  const intents = editIntentsFor(target);
  const intent = intents?.create.find((candidate) =>
    intents.fields[candidate]?.includes(seedField),
  );
  const seed = intent === undefined ? null : { intent, field: seedField };
  return {
    target,
    descriptorId: descriptor.columnId,
    filterKey,
    urlKey: descriptor.urlKey,
    seed,
    columns: section.columns,
    sort: section.sort ?? {
      field: defaultSortFor(target),
      direction: defaultSortDirectionFor(target),
    },
    limit: section.limit,
  };
}

const DEFAULT_RELATION_PAGE_SIZE = 50;

/**
 * A relation section's body: the target entity's own list, scoped to this
 * record through the declared descriptor, over the shared list workbench so
 * the rows carry the target's registered row actions. Headed by "+ create"
 * (the target's create dialog prefilled from the filter) and "Open all" (the
 * target's list route with the same filter in the URL).
 */
export interface EntityRelationTableOperations {
  list: typeof entityList.list;
}

const productionOperations: EntityRelationTableOperations = {
  list: entityList.list,
};

export function EntityRelationTable({
  entity,
  section,
  recordId,
  createLabel,
  emptyLabel,
  operations = productionOperations,
}: {
  entity: BrowserRoutedEntity;
  section: RelationSection;
  recordId: string;
  /** Overrides "New <singular>" (the journal variant says "Log entry"). */
  createLabel?: string;
  emptyLabel?: string;
  /** Injectable transport seam for tests; production keeps the real one. */
  operations?: EntityRelationTableOperations;
}) {
  const plan = useMemo(
    () => planRelationSection(entity, section),
    [entity, section],
  );
  return (
    <RelationList
      plan={plan}
      recordId={recordId}
      title={section.title}
      createLabel={createLabel}
      emptyLabel={emptyLabel}
      operations={operations}
    />
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

function RelationList({
  plan,
  recordId,
  title,
  createLabel,
  emptyLabel,
  operations,
}: {
  plan: RelationSectionPlan;
  recordId: string;
  title: string;
  createLabel: string | undefined;
  emptyLabel: string | undefined;
  operations: EntityRelationTableOperations;
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
  });
  const [creating, setCreating] = useState(false);
  const { singular } = entitySummary[target];

  return (
    <div className="space-y-2">
      <Row gap="sm" justify="end" wrap>
        {plan.seed !== null ? (
          <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
            <Plus />
            {createLabel ?? `New ${singular.toLocaleLowerCase()}`}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          nativeButton={false}
          render={
            <Link
              to={entities[target].routes.list}
              search={{ [plan.urlKey]: recordId }}
              aria-label={`Open all ${title.toLocaleLowerCase()}`}
            />
          }
        >
          Open all
          <ArrowUpRight />
        </Button>
      </Row>
      <ListWorkbench
        model={list.workbench}
        mode="embedded"
        ariaLabel={title}
        emptyState={
          emptyLabel ? (
            <p className="text-xs text-muted-foreground">{emptyLabel}</p>
          ) : (
            <NoneValue />
          )
        }
      />
      {plan.seed !== null ? (
        <EntityEditDialog
          open={creating}
          onOpenChange={setCreating}
          // SAFETY: `seed.intent` is the target's own first create intent
          // and `seed.field` one of that intent's declared fields; the
          // generic dialog resolves both at runtime through the registry.
          request={
            {
              entity: target as EditableEntity,
              operation: "create",
              intent: plan.seed.intent,
              seed: { [plan.seed.field]: recordId },
            } as never
          }
        />
      ) : null}
    </div>
  );
}
