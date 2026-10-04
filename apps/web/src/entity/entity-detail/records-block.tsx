import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import type {
  ReportBlock,
  ReportRecordRow,
} from "@cubby/schemas/entity-report";
import { Suspense } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { FilterRefLink } from "~/entity/components/ref-link/leaf";
import { entities } from "~/entity/entities";
import { formatInstant } from "~/lib/date-format";
import { Row, Stack } from "~/ui/layout";
import { Badge } from "~/ui/primitives/badge";
import { Description } from "~/ui/primitives/description";
import { Image } from "~/ui/primitives/image";

import { collectionActions } from "./collection-actions";

export type RecordsBlock = Extract<ReportBlock, { kind: "records" }>;
type Action = NonNullable<ReportRecordRow["actions"]>[number];

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
export function ReportVerb({
  action,
  record,
  row = null,
}: {
  action: Action;
  record: object;
  row?: ReportRecordRow | null;
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
  record,
  large,
}: {
  row: ReportRecordRow;
  record: object | undefined;
  large: boolean;
}) {
  const listEntity = routedEntity(row.listLink?.entity ?? null);
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
              displayWidth={large ? 240 : 96}
              className={
                large
                  ? "h-40 w-32 rounded-md border border-border object-contain"
                  : "size-12 rounded-md border border-border object-contain"
              }
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
          {(row.badges ?? []).length > 0 ? (
            <Row gap="xs" className="flex-wrap">
              {(row.badges ?? []).map((badge) => (
                <Badge key={badge} variant="warning">
                  {badge}
                </Badge>
              ))}
            </Row>
          ) : null}
          {record !== undefined
            ? (row.actions ?? []).map((action) => (
                <ReportVerb
                  key={action}
                  action={action}
                  record={record}
                  row={row}
                />
              ))
            : null}
        </Stack>
      </Row>
      <Stack gap="xs" className="shrink-0 items-end text-right text-xs">
        {row.trailing && row.listLink && listEntity ? (
          <FilterRefLink
            variant="filter"
            display="value"
            to={entities[listEntity].routes.list}
            // SAFETY: the server names the list's own URL keys.
            search={row.listLink.filters as never}
            label={`Show all ${row.trailing} from ${row.title}`}
          >
            {row.trailing}
          </FilterRefLink>
        ) : row.trailing ? (
          <span>{row.trailing}</span>
        ) : null}
        {row.at ? (
          <span className="text-muted-foreground">
            {formatInstant(row.at, "dateTime")}
          </span>
        ) : null}
      </Stack>
    </li>
  );
}

/**
 * The `records` report block: the server's rows, each opening the record it names, with the
 * row verbs the server offered. `record` is the loaded detail record those verbs act on; the
 * slot's own verbs are shown by `EntityReportSlot`, so they survive a loading or failed report.
 */
export function RecordsBlockView({
  block,
  record,
}: {
  block: RecordsBlock;
  record?: object;
}) {
  const keys = rowKeys(block.rows);
  return block.rows.length === 0 ? (
    <Description>{block.empty}</Description>
  ) : (
    <ul className="w-full divide-y divide-border">
      {block.rows.map((row, index) => (
        <RecordRow
          key={keys[index]}
          row={row}
          record={record}
          large={block.thumbnail === "large"}
        />
      ))}
    </ul>
  );
}
