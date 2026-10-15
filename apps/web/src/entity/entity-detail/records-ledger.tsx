import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import type {
  ReportCommand,
  ReportRecordRow,
} from "@cubby/schemas/entity-report";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { type ReactNode, Suspense, useState } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { FilterRefLink } from "~/entity/components/ref-link/leaf";
import { entities } from "~/entity/entities";
import { ShortcodeProse } from "~/entity/prose/shortcode-prose";
import { householdLocalDate } from "~/lib/household-date";
import { cn } from "~/lib/utils";
import { DateDisplay } from "~/ui/common/date-display";
import {
  RecordDetail,
  RecordDot,
  RecordHeading,
  RecordList,
  RecordRow,
} from "~/ui/common/record-list";
import { CloudflareIcon } from "~/ui/icons/cloudflare";
import { Badge } from "~/ui/primitives/badge";
import { Button, buttonVariants } from "~/ui/primitives/button";
import { Image } from "~/ui/primitives/image";

import { collectionActionFor } from "./collection-actions";
import { DetailAction } from "./detail-action-bar";
import { type ChoiceAnswerState, ChoiceControl } from "./report-choices";
import { CommandButton, type ReportCommands } from "./report-commands";

type Action = NonNullable<ReportRecordRow["actions"]>[number];

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
  const Verb = collectionActionFor(action);
  // SAFETY: a report builder offers a verb only on the slot of the entity its plan names, and
  // `record` is that entity's loaded detail record.
  const typed = record as never;
  return (
    <Suspense fallback={null}>
      <Verb record={typed} item={row} />
    </Suspense>
  );
}

/** A row's declared entity, when the browser has a detail route for it. */
const routedEntity = (entity: string | null): BrowserRoutedEntity | null => {
  if (entity === null || !Object.hasOwn(entities, entity)) return null;
  // SAFETY: `entities` is keyed by exactly the browser-routed entities.
  return entity as BrowserRoutedEntity;
};

const TONE_TEXT = {
  positive: "text-positive",
  warning: "text-warning-ink",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
} as const;
const BADGE_VARIANT = {
  positive: "positive",
  warning: "warning",
  destructive: "destructive",
  muted: "outline",
} as const;

const STATE_VARIANT = {
  done: "positive",
  running: "secondary",
  warning: "warning",
  failed: "destructive",
  skipped: "outline",
  not_reached: "outline",
} as const;

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

/** A shared household day for the records heading; null when rows span days. */
export function ledgerDay(rows: readonly ReportRecordRow[]) {
  const days = new Set(
    rows.flatMap((row) =>
      row.at && !Number.isNaN(new Date(row.at).getTime())
        ? [householdLocalDate(new Date(row.at))]
        : [],
    ),
  );
  return days.size === 1 ? [...days][0]! : null;
}

/** Failures and warnings wrap in full: a raw diagnostic is never clipped behind a tooltip. */
const isLoud = (row: ReportRecordRow) =>
  row.state?.kind === "failed" ||
  row.state?.kind === "warning" ||
  [
    ...(row.badges ?? []).map((badge) => badge.tone),
    ...(row.lines ?? []).map((line) => line.tone),
  ].some((tone) => tone === "destructive" || tone === "warning");

/** A whole line that is a machine code (`source_too_large`) reads as one, in mono. */
const isCode = (text: string) => /^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(text);

/**
 * The row's lines, one under another: an untoned line is its result, the rest evidence. On a wide
 * row each quiet line clips with its whole text as its tooltip; failures and warnings wrap in full.
 */
function RowText({ row }: { row: ReportRecordRow }) {
  const clip = !isLoud(row);
  return (
    <span className="block min-w-0 text-xs/5 break-words">
      {(row.lines ?? []).map((line) => (
        <span
          key={`${line.tone ?? ""}:${line.text}`}
          className={cn(
            "block",
            line.tone ? TONE_TEXT[line.tone] : "text-foreground",
            clip ? "@min-[32rem]/ledger:truncate" : "whitespace-pre-line",
          )}
          title={clip ? line.text : undefined}
        >
          {isCode(line.text) ? (
            <code className="font-mono text-2xs">{line.text}</code>
          ) : (
            <ShortcodeProse>{line.text}</ShortcodeProse>
          )}
        </span>
      ))}
    </span>
  );
}

/** A row's title, as the chip of the record it opens when it opens one. */
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

/** The row's figure (linked to the list it summarises) and time, on one right edge. */
function RowTrailing({
  row,
  sharedDay,
}: {
  row: ReportRecordRow;
  sharedDay: boolean;
}) {
  const listEntity = routedEntity(row.listLink?.entity ?? null);
  if (!row.trailing && !row.at) return null;
  return (
    <>
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
        <span className="text-foreground">{row.trailing}</span>
      ) : null}
      {row.trailing && row.at ? " " : null}
      {row.at ? (
        <DateDisplay timestamp={row.at} clock={sharedDay ? "time" : "day"} />
      ) : null}
    </>
  );
}

/** A row's link out and the commands that need no input: quiet, inside the row's height. */
export function RowLinks({
  row,
  commands,
  open,
  onOpen,
}: {
  row: ReportRecordRow;
  commands: ReportCommands;
  open?: string | null;
  onOpen?: (id: string | null) => void;
}) {
  const items: ReactNode[] = (row.commands ?? []).map(
    (command: ReportCommand) =>
      command.inputs?.length && onOpen ? (
        <Button
          key={command.id}
          variant="ghost"
          size="sm"
          className="h-6"
          aria-expanded={open === command.id}
          onClick={() => onOpen(open === command.id ? null : command.id)}
        >
          {command.label}…
        </Button>
      ) : (
        <CommandButton
          key={command.id}
          command={command}
          commands={commands}
          quiet
        />
      ),
  );
  if (row.externalLink)
    items.push(
      <a
        key="external"
        href={row.externalLink.url}
        title={row.externalLink.hint}
        target="_blank"
        rel="noreferrer"
        className={buttonVariants({
          variant: "ghost",
          size: "sm",
          className: "h-6",
        })}
      >
        {row.externalLink.label === "Open in Cloudflare" ? (
          <CloudflareIcon />
        ) : null}
        {row.externalLink.label}
        <ArrowSquareOutIcon aria-hidden data-icon="inline-end" />
      </a>,
    );
  return items.length > 0 ? <>{items}</> : null;
}

/** What every row of one block shares: how it leads, and what its verbs and choices act on. */
export interface LedgerContext {
  commands: ReportCommands;
  /** The block's day when every timed row shares it; such rows print only their time. */
  day: string | null;
  /** Some row has a state, so every row keeps the mark column. */
  marks: boolean;
  large: boolean;
  choices: ChoiceAnswerState | null;
  choicesLocked: boolean;
  /** The loaded record the row verbs act on. */
  record: object | undefined;
  /** Rows whose commands the detail page's action bar carries instead. */
  detailRows: readonly string[] | undefined;
}

function LedgerRow({
  row,
  context,
}: {
  row: ReportRecordRow;
  context: LedgerContext;
}) {
  // A command that needs input opens beneath its row instead of standing open on every row.
  const [open, setOpen] = useState<string | null>(null);
  const opened = (row.commands ?? []).find((command) => command.id === open);
  const { choice } = row;
  const inDetailBar =
    row.key !== undefined && (context.detailRows?.includes(row.key) ?? false);
  const links = (
    <RowLinks
      row={row}
      commands={context.commands}
      open={open}
      onOpen={setOpen}
    />
  );
  const { record } = context;
  const verbs =
    record === undefined
      ? []
      : (row.actions ?? []).map((action) => (
          <ReportVerb key={action} action={action} record={record} row={row} />
        ));
  const hasLinks = Boolean(row.commands?.length || row.externalLink);
  return (
    <RecordRow
      leading={
        row.imageUrl ? (
          <a href={row.imageUrl} target="_blank" rel="noreferrer">
            <Image
              src={row.imageUrl}
              alt={row.title}
              displayWidth={context.large ? 240 : 96}
              className={cn(
                "rounded-md border border-border object-contain",
                context.large ? "h-40 w-32" : "size-12",
              )}
            />
          </a>
        ) : context.marks ? (
          <RecordDot
            state={row.state?.kind}
            label={row.state?.label}
            spoken={row.state?.kind === "done"}
          />
        ) : undefined
      }
      primary={
        // min-w-0 lets a long record chip shrink to the row instead of pushing past it.
        <span className="flex min-w-0 flex-wrap items-center gap-1">
          <RowTitle row={row} />
          {/* A done mark needs no word; any other state also says what it is. */}
          {row.state && row.state.kind !== "done" ? (
            <Badge variant={STATE_VARIANT[row.state.kind]}>
              {row.state.label}
            </Badge>
          ) : null}
          {(row.badges ?? []).map((badge) => (
            <Badge
              key={badge.label}
              variant={badge.tone ? BADGE_VARIANT[badge.tone] : "secondary"}
            >
              {badge.label}
            </Badge>
          ))}
        </span>
      }
      clip={false}
      secondary={row.lines?.length ? <RowText row={row} /> : null}
      trailing={<RowTrailing row={row} sharedDay={context.day !== null} />}
      actions={
        hasLinks || verbs.length > 0 ? (
          // Phone rows put commands under the text, aligned with it; wide rows end the line.
          <span className="-ml-2 flex flex-wrap justify-start gap-0.5 @min-[32rem]/ledger:ml-0 @min-[32rem]/ledger:justify-end">
            {inDetailBar ? <DetailAction>{links}</DetailAction> : links}
            {verbs}
          </span>
        ) : null
      }
      detail={
        opened || row.detail || (choice && context.choices) ? (
          <>
            {opened ? (
              <div className="flex flex-wrap items-center gap-2">
                <CommandButton
                  command={opened}
                  commands={context.commands}
                  compact
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={() => setOpen(null)}
                >
                  Cancel
                </Button>
              </div>
            ) : null}
            {choice && context.choices ? (
              <ChoiceControl
                choice={choice}
                answer={context.choices.answers[choice.id]}
                disabled={context.choicesLocked}
                onAnswer={(next) => context.choices?.answer(choice.id, next)}
              />
            ) : null}
            {row.detail ? (
              <RecordDetail summary={row.detail.label}>
                <pre className="max-h-80 overflow-auto bg-muted/30 p-2 font-mono break-words whitespace-pre-wrap">
                  {row.detail.text}
                </pre>
              </RecordDetail>
            ) : null}
          </>
        ) : null
      }
    />
  );
}

/**
 * Every `records` block's rows: one aligned line per row (mark or thumbnail, title and badges,
 * text, figure and time, commands), each column as narrow as its content. A `timeline` block draws
 * a rail through its ordered stages. Rows that share `day` print only their time; an untitled
 * block prints that day as its first line (a titled block prints it in its heading). Phone rows
 * keep identity and time on the first line and drop the text and commands beneath.
 */
export function RecordLedger({
  rows,
  context,
  timeline = false,
  dayHeading = false,
}: {
  rows: readonly ReportRecordRow[];
  context: LedgerContext;
  timeline?: boolean;
  dayHeading?: boolean;
}) {
  const keys = rowKeys(rows);
  return (
    <RecordList variant={timeline ? "timeline" : "plain"}>
      {context.day && dayHeading ? (
        <RecordHeading label={<DateDisplay start={context.day} />} />
      ) : null}
      {rows.map((row, index) => (
        <LedgerRow key={keys[index]} row={row} context={context} />
      ))}
    </RecordList>
  );
}
