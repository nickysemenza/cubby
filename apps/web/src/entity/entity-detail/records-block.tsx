import { COLLECTION_ACTION_SCOPES } from "@cubby/schemas/entity-definitions/collection-actions";
import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import type {
  ReportBlock,
  ReportRecordRow,
} from "@cubby/schemas/entity-report";
import { Suspense } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { entities } from "~/entity/entities";
import { formatInstant } from "~/lib/date-format";
import { Row, Stack } from "~/ui/layout";
import { Badge } from "~/ui/primitives/badge";
import { Description } from "~/ui/primitives/description";
import { Image } from "~/ui/primitives/image";

import { collectionActions } from "./collection-actions";

export type RecordsBlock = Extract<ReportBlock, { kind: "records" }>;
type Action = NonNullable<RecordsBlock["actions"]>[number];

/** A row's declared entity, when the browser has a detail route for it. */
const routedEntity = (entity: string | null): BrowserRoutedEntity | null => {
  if (entity === null || !Object.hasOwn(entities, entity)) return null;
  // SAFETY: `entities` is keyed by exactly the browser-routed entities.
  return entity as BrowserRoutedEntity;
};

/** Stable keys for rows that may repeat (a recipe appears once per section it uses). */
const rowKeys = (rows: readonly ReportRecordRow[]) => {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const base = `${row.entity ?? ""}:${row.id ?? ""}:${row.title}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return `${base}#${occurrence}`;
  });
};

/**
 * One declared verb. The action registry is erased to `never` because each verb reads its own
 * entity's record; the slot only hands a verb the record of the entity whose slot declared it.
 */
function ActionSlot({
  action,
  record,
  row,
}: {
  action: Action;
  record: object;
  row: ReportRecordRow | null;
}) {
  const Verb = collectionActions[action];
  // SAFETY: a report builder offers a verb only on the slot of the entity its plan names, and
  // `record` is that entity's loaded detail record.
  const typed = record as never;
  return (
    <Suspense fallback={null}>
      <Verb record={typed} item={row} />
    </Suspense>
  );
}

function RowTitle({ row }: { row: ReportRecordRow }) {
  const entity = routedEntity(row.entity);
  if (entity !== null && row.id !== null)
    return (
      <EntityRefLink
        variant="chip"
        entity={entity}
        id={row.id}
        name={row.title}
        displayImage={null}
      />
    );
  return <span className="whitespace-pre-line">{row.title}</span>;
}

function RecordRow({
  row,
  rowActions,
  record,
  extraBadges,
}: {
  row: ReportRecordRow;
  rowActions: readonly Action[];
  record: object;
  extraBadges: readonly string[];
}) {
  const badges = [...(row.badges ?? []), ...extraBadges];
  return (
    <li className="flex items-start justify-between gap-3 py-2">
      <Row gap="sm" className="min-w-0 items-start">
        {row.imageUrl ? (
          <a
            href={row.imageUrl}
            target="_blank"
            rel="noreferrer"
            className="shrink-0"
          >
            <Image
              src={row.imageUrl}
              alt={row.title}
              displayWidth={96}
              className="size-12 rounded-md border border-border object-contain"
            />
          </a>
        ) : null}
        <Stack gap="xs" className="min-w-0">
          <RowTitle row={row} />
          {row.subtitle ? (
            <span className="text-xs whitespace-pre-line text-muted-foreground">
              {row.subtitle}
            </span>
          ) : null}
          {badges.length > 0 ? (
            <Row gap="xs" className="flex-wrap">
              {badges.map((badge) => (
                <Badge key={badge} variant="warning">
                  {badge}
                </Badge>
              ))}
            </Row>
          ) : null}
        </Stack>
      </Row>
      <Stack gap="xs" className="shrink-0 items-end text-right text-xs">
        {row.trailing ? <span>{row.trailing}</span> : null}
        {row.at ? (
          <span className="text-muted-foreground">
            {formatInstant(row.at, "dateTime")}
          </span>
        ) : null}
        {rowActions.map((action) => (
          <ActionSlot key={action} action={action} record={record} row={row} />
        ))}
      </Stack>
    </li>
  );
}

/**
 * The `records` report block: the server's rows, each opening the record it names, and the verbs
 * the slot declares. `record` is the loaded detail record the verbs act on; `rowBadges` are
 * web-only badges the browser computes per row (a re-parse that would change a recipe line).
 */
export function RecordsBlockView({
  block,
  record,
  rowBadges,
}: {
  block: RecordsBlock;
  record?: object;
  rowBadges?: (rows: readonly ReportRecordRow[]) => (string | null)[];
}) {
  const actions = record === undefined ? [] : (block.actions ?? []);
  const sectionActions = actions.filter(
    (action) => COLLECTION_ACTION_SCOPES[action] === "section",
  );
  const rowActions = actions.filter(
    (action) => COLLECTION_ACTION_SCOPES[action] === "row",
  );
  const extra = rowBadges?.(block.rows) ?? [];
  const keys = rowKeys(block.rows);
  return (
    <Stack gap="sm" className="items-start">
      {record !== undefined
        ? sectionActions.map((action) => (
            <ActionSlot
              key={action}
              action={action}
              record={record}
              row={null}
            />
          ))
        : null}
      {block.rows.length === 0 ? (
        <Description>{block.empty}</Description>
      ) : (
        <ul className="w-full divide-y divide-border">
          {block.rows.map((row, index) => (
            <RecordRow
              key={keys[index]}
              row={row}
              rowActions={rowActions}
              record={record ?? {}}
              extraBadges={extra[index] ? [extra[index]] : []}
            />
          ))}
        </ul>
      )}
    </Stack>
  );
}
