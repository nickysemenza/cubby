import { entitySchema } from "@cubby/schemas/entity";
import type { CompiledEntityPresentation } from "@cubby/schemas/entity-definitions/definition";
import { displayItems } from "@cubby/schemas/entity-definitions/label-field";
import type { EntityFieldModel } from "@cubby/schemas/entity-fields";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import {
  entities,
  entityDetailParams,
  isBrowserRoutedEntity,
} from "~/entity/entities";
import { entityMetadata, useEntityMetadata } from "~/entity/metadata";
import { RecordWorkQueue } from "~/entity/work-queue/record-work-queue";
import { formatCount } from "~/lib/number-format";
import { RecordList, RecordRow } from "~/ui/records/record-list";

import { readPathValue } from "../read-path";
import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";
import { DetailSummary, sideHeading } from "./detail-summary";
import { KindExplanation } from "./kind-explanation";
import type { RecordKind } from "./record-header";

type Field = EntityFieldModel["fields"][number];

/** The record's declared `side.needs` items, empty when undeclared or unset. */
export function declaredNeedsOf<E extends GenericDetailEntity>(
  queryClient: QueryClient,
  entity: E,
  record: DetailRecordOf<E>,
) {
  const { detail }: CompiledEntityPresentation = entityMetadata(
    queryClient,
    entity,
  ).summary;
  const field = detail.side?.needs;
  if (field === undefined) return [];
  const fields: readonly Field[] = entityMetadata(queryClient, entity).fields
    .fields;
  const declared = fields.find((candidate) => candidate.key === field);
  const parsed = displayItems.safeParse(
    readPathValue(record, declared?.display.itemsPath ?? field),
  );
  return parsed.success ? (parsed.data ?? []) : [];
}

/** The declared `side.needs` items: what waits on a member, each linked. */
function DeclaredNeeds<E extends GenericDetailEntity>({
  entity,
  record,
}: {
  entity: E;
  record: DetailRecordOf<E>;
}) {
  const items = declaredNeedsOf(useQueryClient(), entity, record);
  if (items.length === 0) return null;
  return (
    <section aria-label="Needs you" data-testid="needs-you">
      <h2 className={sideHeading}>
        Needs you{" "}
        <span className="font-normal text-muted-foreground tabular-nums">
          {formatCount(items.length)}
        </span>
      </h2>
      <RecordList>
        {items.map((item) => {
          const target = entitySchema.safeParse(item.entity);
          return (
            <RecordRow
              key={`${item.entity}:${item.id}:${item.title}`}
              clip={false}
              stacked
              leading={
                <span
                  aria-hidden
                  className="mt-1 block size-2 rounded-[1.5px] bg-needs"
                />
              }
              primary={
                target.success &&
                item.id &&
                isBrowserRoutedEntity(target.data) ? (
                  <Link
                    to={entities[target.data].routes.detail}
                    params={entityDetailParams(item.id)}
                    className="hover:underline"
                  >
                    {item.title}
                  </Link>
                ) : (
                  item.title
                )
              }
              secondary={item.subtitle}
              trailing={item.trailing}
            />
          );
        })}
      </RecordList>
    </section>
  );
}

/**
 * The detail side column: Needs you (only when something waits), the key
 * facts from the declared summary cells, the remaining summary cells, and what
 * the record's kind does.
 */
export function DetailSide<E extends GenericDetailEntity>({
  entity,
  record,
  kind,
}: {
  entity: E;
  record: DetailRecordOf<E>;
  kind: RecordKind | null;
}) {
  const { detail }: CompiledEntityPresentation =
    useEntityMetadata(entity).summary;
  const needs = detail.side?.needs;
  return (
    <div className="grid min-w-0 gap-4 [&>*+*]:border-t [&>*+*]:border-border [&>*+*]:pt-4 [&>:empty]:hidden">
      {needs === undefined ? (
        <RecordWorkQueue id={record.id} variant="needs-you" />
      ) : (
        <DeclaredNeeds entity={entity} record={record} />
      )}
      <DetailSummary entity={entity} record={record} layout="side" />
      {kind?.explanation ? (
        <KindExplanation label={kind.label} explanation={kind.explanation} />
      ) : null}
    </div>
  );
}
