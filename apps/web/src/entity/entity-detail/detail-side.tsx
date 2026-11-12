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
import { entityMetadata } from "~/entity/metadata";
import {
  RecordWorkQueueRow,
  useRecordWorkQueue,
} from "~/entity/work-queue/record-work-queue";
import { formatCount } from "~/lib/number-format";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { RecordList, RecordRow } from "~/ui/records/record-list";

import { readPathValue } from "../read-path";
import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";
import { DetailSummary, sideHeading } from "./detail-summary";
import { KindExplanation } from "./kind-explanation";
import type { RecordKind } from "./record-header";
import { QualityIssueLink, useQualityAttention } from "./record-quality";

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

const needsMark = (failed: boolean) => (
  <span
    aria-hidden
    className={
      failed
        ? "mt-1 block size-2 rounded-[1.5px] bg-destructive"
        : "mt-1 block size-2 rounded-[1.5px] bg-needs"
    }
  />
);

/**
 * Needs you: the declared `side.needs` items (else the record's Work queue
 * rows), then the open quality checks no queue row already names, each linked
 * to its field or result. Nothing draws when nothing waits.
 */
function NeedsYou<E extends GenericDetailEntity>({
  entity,
  record,
}: {
  entity: E;
  record: DetailRecordOf<E>;
}) {
  const queryClient = useQueryClient();
  const { detail }: CompiledEntityPresentation = entityMetadata(
    queryClient,
    entity,
  ).summary;
  const declared = detail.side?.needs;
  const items = declaredNeedsOf(queryClient, entity, record);
  const queue = useRecordWorkQueue(record.id, declared === undefined);
  const rows = declared === undefined ? queue.rows : [];
  const named = new Set(
    rows.flatMap((row) => row.gaps.map((gap): string => gap.check)),
  );
  const quality = useQualityAttention().filter(
    ({ check }) => !named.has(check.check),
  );
  const count = items.length + rows.length + quality.length;
  if (queue.error && declared === undefined)
    return <ErrorDisplay error={queue.error} title="Needs you" />;
  if (count === 0) return null;
  return (
    <section aria-label="Needs you" data-testid="needs-you">
      <h2 className={sideHeading}>
        Needs you{" "}
        <span className="font-normal text-muted-foreground tabular-nums">
          {formatCount(count)}
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
              leading={needsMark(false)}
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
        {rows.map((row) => (
          <RecordRow
            key={row.key}
            clip={false}
            stacked
            leading={needsMark(false)}
            primary={<RecordWorkQueueRow row={row} />}
          />
        ))}
        {quality.map(({ check, anchor }) => (
          <RecordRow
            key={check.check}
            clip={false}
            stacked
            leading={needsMark(check.kind === "defect")}
            primary={
              <QualityIssueLink
                check={check}
                anchor={anchor}
                className="hover:underline"
              />
            }
            secondary={check.stateLabel}
          />
        ))}
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
  return (
    <div className="grid min-w-0 gap-4 [&>*+*]:border-t [&>*+*]:border-border [&>*+*]:pt-4 [&>:empty]:hidden">
      <NeedsYou entity={entity} record={record} />
      <DetailSummary entity={entity} record={record} layout="side" />
      {kind?.explanation ? (
        <KindExplanation
          label={kind.label}
          description={kind.description}
          explanation={kind.explanation}
        />
      ) : null}
    </div>
  );
}
