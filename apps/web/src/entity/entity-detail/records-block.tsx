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
import { CloudflareIcon } from "~/ui/icons/cloudflare";
import { Row, Stack } from "~/ui/layout";
import { Badge } from "~/ui/primitives/badge";
import { Button, buttonVariants } from "~/ui/primitives/button";
import { Description } from "~/ui/primitives/description";
import { Eyebrow } from "~/ui/primitives/eyebrow";
import { Image } from "~/ui/primitives/image";
import { Skeleton } from "~/ui/primitives/skeleton";
import { ShortcodeProse } from "~/ui/shortcode-prose";

import { collectionActions } from "./collection-actions";
import {
  DetailAction,
  type ReportDetailActionPlacement,
} from "./detail-action-bar";
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
  inDetailBar = false,
}: {
  inDetailBar?: boolean;
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
      <RowActionPlacement inDetailBar={inDetailBar}>
        {row.originalMediaUrl ? (
          <a
            href={row.originalMediaUrl}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: "outline" })}
          >
            Open original
          </a>
        ) : null}
        {row.externalLink ? (
          <a
            href={row.externalLink.url}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: "outline" })}
          >
            {row.externalLink.label === "Open in Cloudflare" ? (
              <CloudflareIcon />
            ) : null}
            {row.externalLink.label}
          </a>
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
      </RowActionPlacement>
    </>
  );
}

function RowActionPlacement({
  inDetailBar,
  children,
}: {
  inDetailBar: boolean;
  children: ReactNode;
}) {
  return inDetailBar ? <DetailAction>{children}</DetailAction> : children;
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
  inDetailBar,
  record,
  large,
  commands,
  choices,
  choicesLocked,
}: {
  inDetailBar: boolean;
  commands: ReportCommands;
  /** The answers to the block's choices, when the block has a form. */
  choices: ChoiceAnswerState | null;
  choicesLocked: boolean;
  row: ReportRecordRow;
  record: object | undefined;
  large: boolean;
}) {
  const listEntity = routedEntity(row.listLink?.entity ?? null);
  return (
    <li className="flex items-start justify-between gap-3 py-2">
      <Row gap="sm" className="min-w-0 flex-1 items-start">
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
          <RowExtras row={row} commands={commands} inDetailBar={inDetailBar} />
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

function RecordFilmstrip({
  block,
  commands,
}: {
  block: RecordsBlock;
  commands: ReportCommands;
}) {
  const [selectedKey, setSelectedKey] = useState<string>();
  const [offset, setOffset] = useState(0);
  const selected =
    block.rows.find((row) => row.key === selectedKey) ?? block.rows[0];
  const start = Math.min(
    offset,
    Math.max(0, Math.floor((block.rows.length - 1) / 8) * 8),
  );
  if (!selected) return null;
  return (
    <Stack gap="sm" className="min-w-0">
      <Row gap="sm" className="flex-wrap">
        {block.rows.slice(start, start + 8).map((row) => (
          <Button
            key={row.key ?? row.title}
            variant={row === selected ? "secondary" : "outline"}
            aria-label={`View ${row.title}`}
            aria-pressed={row === selected}
            onClick={() => setSelectedKey(row.key)}
          >
            {row.imageUrl ? (
              <Image
                src={row.imageUrl}
                alt=""
                displayWidth={64}
                className="size-12 object-contain"
              />
            ) : null}
            {row.title}
          </Button>
        ))}
      </Row>
      <Row gap="sm">
        <Button
          variant="outline"
          disabled={start === 0}
          onClick={() => setOffset(start - 8)}
        >
          Previous captures
        </Button>
        <span className="text-sm text-muted-foreground">
          {start + 1}–{Math.min(start + 8, block.rows.length)} of{" "}
          {block.rows.length}
        </span>
        <Button
          variant="outline"
          disabled={start + 8 >= block.rows.length}
          onClick={() => setOffset(start + 8)}
        >
          Next captures
        </Button>
      </Row>
      <section
        aria-label="Selected record"
        className="grid min-w-0 gap-4 md:grid-cols-2"
      >
        {selected.imageUrl ? (
          <a
            href={selected.imageUrl}
            target="_blank"
            rel="noreferrer"
            className="min-w-0"
          >
            <Image
              src={selected.imageUrl}
              alt={selected.title}
              displayWidth={800}
              className="max-h-[32rem] w-full rounded-md border border-border object-contain"
            />
          </a>
        ) : null}
        <ul className="min-w-0">
          <RecordRow
            row={{ ...selected, imageUrl: undefined }}
            commands={commands}
            choices={null}
            choicesLocked={false}
            inDetailBar={false}
            record={undefined}
            large={false}
          />
        </ul>
      </section>
    </Stack>
  );
}

/**
 * The `records` report block: the server's rows, each opening the record it names, with the
 * row verbs the server offered. `record` is the loaded detail record those verbs act on; the
 * slot's own verbs are shown by `EntityReportSlot`, so they survive a loading or failed report.
 */
export function RecordsBlockView({
  block,
  detailActions,
  record,
  entity,
  list,
}: {
  detailActions?: ReportDetailActionPlacement;
  block: RecordsBlock;
  record?: object;
  /** The record's entity, for the finance verbs the block offers (`block.verbs`). */
  entity?: string;
  /** Replaces the generic rows and footer (a sortable table, thumbnails). */
  list?: ReactNode;
}) {
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
  // SAFETY: the verb registry is keyed by this entity, so it takes this entity's record.
  const erasedRecord = record as never;
  return (
    <Stack as="section" aria-label={block.title} gap="sm" className="w-full">
      {block.title && block.rows.length > 0 ? (
        <Eyebrow>{block.title}</Eyebrow>
      ) : null}
      {list ??
        (block.presentation === "filmstrip" ? (
          <RecordFilmstrip block={block} commands={commands} />
        ) : block.rows.length === 0 ? (
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
                inDetailBar={
                  row.key !== undefined &&
                  (detailActions?.rows?.includes(row.key) ?? false)
                }
                record={record}
                large={block.thumbnail === "large"}
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
      <RowActionPlacement inDetailBar={detailActions?.commands ?? false}>
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
      </RowActionPlacement>
      {verbs.length > 0 ? (
        <Row gap="sm" wrap align="center" aria-live="polite">
          {verbs.map((verb) => {
            const Verb = available[verb.id];
            return Verb ? (
              <Suspense
                key={verb.id}
                fallback={<Skeleton className="h-8 w-24" />}
              >
                <RowActionPlacement inDetailBar={detailActions?.verbs ?? false}>
                  <Verb record={erasedRecord} action={verb} />
                </RowActionPlacement>
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

export function RecordsDetailActions({
  block,
  detailActions,
  entity,
  record,
}: {
  block: RecordsBlock;
  detailActions?: ReportDetailActionPlacement;
  entity?: string;
  record?: object;
}) {
  const commands = useReportCommands();
  const available = entity === undefined ? {} : sectionActionsFor(entity);
  // SAFETY: the action registry correlates this entity with its loaded record.
  const erasedRecord = record as never;
  return (
    <>
      {block.rows
        .filter(
          (row) =>
            row.key !== undefined && detailActions?.rows?.includes(row.key),
        )
        .map((row) => (
          <RowExtras
            key={row.key}
            row={{ ...row, statuses: [], lines: [], detail: undefined }}
            commands={commands}
          />
        ))}
      {detailActions?.verbs && record
        ? (block.verbs ?? []).map((verb) => {
            const Verb = available[verb.id];
            return Verb ? (
              <Suspense key={verb.id} fallback={null}>
                <span title={verb.disabledReason ?? undefined}>
                  <Verb record={erasedRecord} action={verb} />
                </span>
              </Suspense>
            ) : null;
          })
        : null}
      {detailActions?.commands
        ? (block.commands ?? []).map((command) => (
            <CommandButton
              key={command.id}
              command={command}
              commands={commands}
            />
          ))
        : null}
    </>
  );
}
