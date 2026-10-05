import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import type {
  ReportBlock,
  ReportRecordRow,
} from "@cubby/schemas/entity-report";
import { type ReactNode, Suspense, useState } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { FilterRefLink } from "~/entity/components/ref-link/leaf";
import { entities } from "~/entity/entities";
import { formatInstant } from "~/lib/date-format";
import { cn } from "~/lib/utils";
import { Row, Stack } from "~/ui/layout";
import { Badge } from "~/ui/primitives/badge";
import { Checkbox } from "~/ui/primitives/checkbox";
import { Description } from "~/ui/primitives/description";
import { Eyebrow } from "~/ui/primitives/eyebrow";
import { Image } from "~/ui/primitives/image";
import { Skeleton } from "~/ui/primitives/skeleton";
import { ShortcodeProse } from "~/ui/shortcode-prose";

import { collectionActions } from "./collection-actions";
import {
  type ChoiceAnswerState,
  ChoiceControl,
  ChoiceFormFooter,
  useChoiceAnswers,
} from "./report-choices";
import {
  CommandButton,
  type ReportCommands,
  useReportCommands,
} from "./report-commands";
import { sectionActionsFor } from "./section-actions";

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
    if (row.key !== undefined && row.commands !== undefined) return row.key;
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
  if (row.title === "") return null;
  return (
    <span className="font-medium whitespace-pre-line">
      <ShortcodeProse>{row.title}</ShortcodeProse>
    </span>
  );
}

const TONE_TEXT = {
  positive: "text-positive",
  warning: "text-warning-ink",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
} as const;
const STATUS_VARIANT = {
  positive: "positive",
  warning: "warning",
  destructive: "destructive",
  muted: "outline",
} as const;

/** The toned chips, lines, raw block and commands a row carries beyond its title and subtitle. */
function RowExtras({
  row,
  commands,
}: {
  row: ReportRecordRow;
  commands: ReportCommands;
}) {
  return (
    <>
      {(row.statuses ?? []).length > 0 ? (
        <Row gap="xs" className="flex-wrap">
          {(row.statuses ?? []).map((status) => (
            <Badge
              key={status.label}
              variant={status.tone ? STATUS_VARIANT[status.tone] : "secondary"}
            >
              {status.label}
            </Badge>
          ))}
        </Row>
      ) : null}
      {(row.lines ?? []).map((entry) => (
        <span
          key={`${entry.tone ?? ""}:${entry.text}`}
          className={cn(
            "text-xs break-words whitespace-pre-line",
            entry.tone && TONE_TEXT[entry.tone],
          )}
        >
          <ShortcodeProse>{entry.text}</ShortcodeProse>
        </span>
      ))}
      {row.detail ? (
        <details className="border border-border bg-muted/30 p-2 text-xs">
          <summary className="cursor-pointer font-medium">
            {row.detail.label}
          </summary>
          <pre className="mt-2 max-h-80 overflow-auto font-mono break-words whitespace-pre-wrap">
            {row.detail.text}
          </pre>
        </details>
      ) : null}
      {(row.commands ?? []).length > 0 ? (
        <Row wrap gap="sm">
          {(row.commands ?? []).map((command) => (
            <CommandButton
              key={command.id}
              command={command}
              commands={commands}
            />
          ))}
        </Row>
      ) : null}
    </>
  );
}

/** The decision a row asks for, answered in place; the block's form says what it unlocks. */
function RowChoice({
  row,
  choices,
  locked,
}: {
  row: ReportRecordRow;
  choices: ChoiceAnswerState | null;
  locked: boolean;
}) {
  const { choice } = row;
  if (!choice || !choices) return null;
  return (
    <ChoiceControl
      choice={choice}
      answer={choices.answers[choice.id]}
      disabled={locked}
      onAnswer={(next) => choices.answer(choice.id, next)}
    />
  );
}

function RecordRow({
  row,
  record,
  large,
  selectable,
  checked,
  onCheckedChange,
  commands,
  choices,
  choicesLocked,
}: {
  commands: ReportCommands;
  /** The answers to the block's choices, when the block has a form. */
  choices: ChoiceAnswerState | null;
  choicesLocked: boolean;
  row: ReportRecordRow;
  record: object | undefined;
  large: boolean;
  /** Whether a selection verb is offered, so rows carry a checkbox. */
  selectable: boolean;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const listEntity = routedEntity(row.listLink?.entity ?? null);
  return (
    <li className="flex items-start justify-between gap-3 py-2">
      <Row gap="sm" className="min-w-0 flex-1 items-start">
        {selectable && row.key !== undefined ? (
          <Checkbox
            aria-label={`Select ${row.title}`}
            checked={checked}
            disabled={row.disabledReason != null}
            onCheckedChange={(next) => onCheckedChange(next === true)}
          />
        ) : null}
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
        <Stack gap="xs" className="min-w-0 flex-1">
          <RowTitle row={row} />
          {row.subtitle ? (
            <span className="text-xs whitespace-pre-line text-muted-foreground">
              <ShortcodeProse>{row.subtitle}</ShortcodeProse>
            </span>
          ) : null}
          <RowExtras row={row} commands={commands} />
          <RowChoice row={row} choices={choices} locked={choicesLocked} />
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
  entity,
  list,
}: {
  block: RecordsBlock;
  record?: object;
  /** The record's entity, for the finance verbs the block offers (`block.verbs`). */
  entity?: string;
  /** Replaces the generic rows and footer (a sortable table, thumbnails). */
  list?: ReactNode;
}) {
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const commands = useReportCommands();
  const choices = useChoiceAnswers();
  const { form } = block;
  const choicesLocked = commands.pending || commands.committed;
  const keys = rowKeys(block.rows);
  const verbs = block.verbs ?? [];
  const available =
    entity === undefined || record === undefined
      ? {}
      : sectionActionsFor(entity);
  const selectable = verbs.some((verb) => verb.scope === "selection");
  const clearSelection = () => setSelection(new Set());
  // SAFETY: the verb registry is keyed by this entity, so it takes this entity's record.
  const erasedRecord = record as never;
  return (
    <Stack as="section" aria-label={block.title} gap="sm" className="w-full">
      {block.title && block.rows.length > 0 ? (
        <Eyebrow>{block.title}</Eyebrow>
      ) : null}
      {list ??
        (block.rows.length === 0 ? (
          block.empty ? (
            <Description>{block.empty}</Description>
          ) : null
        ) : (
          <ul className="w-full divide-y divide-border">
            {block.rows.map((row, index) => (
              <RecordRow
                key={keys[index]}
                commands={commands}
                choices={form ? choices : null}
                choicesLocked={choicesLocked}
                row={row}
                record={record}
                large={block.thumbnail === "large"}
                selectable={selectable}
                checked={row.key !== undefined && selection.has(row.key)}
                onCheckedChange={(checked) =>
                  setSelection((current) => {
                    const next = new Set(current);
                    if (row.key === undefined) return next;
                    if (checked) next.add(row.key);
                    else next.delete(row.key);
                    return next;
                  })
                }
              />
            ))}
          </ul>
        ))}
      {block.footer && list === undefined ? (
        <p className="border-t border-border pt-2 text-sm text-muted-foreground">
          {block.footer}
        </p>
      ) : null}
      {form ? (
        <ChoiceFormFooter
          form={form}
          rowChoices={block.rows.flatMap((row) =>
            row.choice ? [row.choice] : [],
          )}
          state={choices}
          pending={commands.pending}
          done={commands.committed}
          onRun={() =>
            commands.commit(
              form.command.request,
              choices.answers,
              choices.operationId,
            )
          }
        />
      ) : null}
      {(block.commands ?? []).length > 0 ? (
        <Row wrap gap="sm">
          {(block.commands ?? []).map((command) => (
            <CommandButton
              key={command.id}
              command={command}
              commands={commands}
            />
          ))}
        </Row>
      ) : null}
      {verbs.length > 0 ? (
        <Row gap="sm" wrap align="center" aria-live="polite">
          {verbs.map((verb) => {
            const Verb = available[verb.id];
            return Verb ? (
              <Suspense
                key={verb.id}
                fallback={<Skeleton className="h-8 w-24" />}
              >
                <Verb
                  record={erasedRecord}
                  action={verb}
                  selection={[...selection]}
                  clearSelection={clearSelection}
                />
              </Suspense>
            ) : null;
          })}
        </Row>
      ) : null}
      {verbs.map((verb) =>
        verb.disabledReason ? (
          <Description key={verb.id} size="xs">
            {verb.label}: {verb.disabledReason}
          </Description>
        ) : null,
      )}
    </Stack>
  );
}
