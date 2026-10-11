import type {
  ReportCommand,
  ReportRecordRow,
} from "@cubby/schemas/entity-report";
import { type ReactNode, useState } from "react";

import { formatInstant } from "~/lib/date-format";
import { cn } from "~/lib/utils";
import { Badge } from "~/ui/primitives/badge";
import { Button, buttonVariants } from "~/ui/primitives/button";
import { ShortcodeProse } from "~/ui/shortcode-prose";

import {
  rowKeys,
  RowTitle,
  STATUS_VARIANT,
  TONE_TEXT,
} from "./records-row-parts";
import { CommandButton, type ReportCommands } from "./report-commands";

type Tone = keyof typeof TONE_TEXT;

const DOT = {
  positive: "bg-positive",
  warning: "bg-warning",
  destructive: "bg-destructive",
  muted: "border border-dashed border-muted-foreground/60",
} as const satisfies Record<Tone, string>;

/** Whether a block can draw as a ledger: read-mostly rows, no row decision, photo or verb. */
const isLedger = (block: {
  presentation?: "filmstrip" | "ledger" | undefined;
  form?: unknown;
  rows: readonly ReportRecordRow[];
}) =>
  block.presentation === "ledger" &&
  !block.form &&
  block.rows.every(
    (row) => !row.choice && !row.imageUrl && !row.actions?.length,
  );

/**
 * How a block lays out as a ledger: the day its timed rows share, and whether the block's
 * commands sit in its header (unless the detail bar already carries them).
 */
export function ledgerLayout(
  block: Parameters<typeof isLedger>[0],
  commandsInDetailBar: boolean,
) {
  const ledger = isLedger(block);
  return {
    ledger,
    day: ledger ? ledgerDay(block.rows) : null,
    headerCommands: ledger && !commandsInDetailBar,
  };
}

/** The household day every timed row shares, so rows print only their time; null when they differ. */
function ledgerDay(rows: readonly ReportRecordRow[]) {
  const days = new Set(
    rows.flatMap((row) => (row.at ? [formatInstant(row.at, "dateShort")] : [])),
  );
  return days.size === 1 ? [...days][0]! : null;
}

/** A row's state is its first status: a toned dot whose label stays readable to assistive tech. */
function StateDot({ status }: { status: ReportRecordRow["statuses"] }) {
  const state = status?.[0];
  if (!state) return <span aria-hidden />;
  return (
    <span className="flex h-5 items-center" title={state.label}>
      <span
        aria-hidden
        className={cn(
          "size-2 rounded-full",
          state.tone ? DOT[state.tone] : "bg-foreground/50",
        )}
      />
      <span className="sr-only">{state.label}</span>
    </span>
  );
}

/** Failures and warnings wrap in full: a raw diagnostic is never clipped behind a tooltip. */
const isLoud = (row: ReportRecordRow) =>
  [row.statuses?.[0]?.tone, ...(row.lines ?? []).map((line) => line.tone)].some(
    (tone) => tone === "destructive" || tone === "warning",
  );

/** The subtitle's first line is the result; its other lines and the toned lines are evidence. */
const textParts = (row: ReportRecordRow) => {
  const [result, ...evidence] = (row.subtitle ?? "")
    .split("\n")
    .filter((line) => line !== "");
  return [
    ...(result ? [{ text: result, className: "text-foreground" }] : []),
    ...evidence.map((text) => ({ text, className: "text-muted-foreground" })),
    ...(row.lines ?? []).map((line) => ({
      text: line.text,
      className: line.tone ? TONE_TEXT[line.tone] : "text-muted-foreground",
    })),
  ].map((part, position) => ({ ...part, key: `${position}:${part.text}` }));
};

/** The row's text on one line, clipped with the whole text as its tooltip unless it is loud. */
function RowText({
  row,
  parts,
}: {
  row: ReportRecordRow;
  parts: ReturnType<typeof textParts>;
}) {
  const loud = isLoud(row);
  return (
    <span
      className={cn(
        "block min-w-0 text-xs/5 break-words",
        loud ? "whitespace-pre-line" : "sm:truncate",
      )}
      title={loud ? undefined : parts.map((part) => part.text).join(" · ")}
    >
      {parts.map((part, index) => (
        <span key={part.key} className={part.className}>
          {index > 0 ? (
            <span className="text-muted-foreground"> · </span>
          ) : null}
          <ShortcodeProse>{part.text}</ShortcodeProse>
        </span>
      ))}
    </span>
  );
}

function LedgerRow({
  row,
  day,
  commands,
}: {
  row: ReportRecordRow;
  day: string | null;
  commands: ReportCommands;
}) {
  // A command that needs input opens beneath its row instead of standing open on every row.
  const [open, setOpen] = useState<string | null>(null);
  const opened = (row.commands ?? []).find((command) => command.id === open);
  const extraStatuses = (row.statuses ?? []).slice(1);
  const parts = textParts(row);
  return (
    <li className="col-span-full grid grid-cols-subgrid items-start gap-y-1 border-t border-border py-1 first:border-t-0">
      <StateDot status={row.statuses} />
      {/* A row with no text (a log line) lets its title use the text column too. */}
      <span
        className={cn(
          "flex min-w-0 flex-wrap items-center gap-1 text-sm/5",
          parts.length === 0 && "sm:col-span-2",
        )}
      >
        <RowTitle row={row} />
        {extraStatuses.map((status) => (
          <Badge
            key={status.label}
            variant={status.tone ? STATUS_VARIANT[status.tone] : "secondary"}
          >
            {status.label}
          </Badge>
        ))}
        {(row.badges ?? []).map((badge) => (
          <Badge key={badge} variant="warning">
            {badge}
          </Badge>
        ))}
      </span>
      {parts.length > 0 ? (
        <span className="col-start-2 col-end-[-1] row-start-2 min-w-0 sm:col-start-auto sm:col-end-auto sm:row-start-auto">
          <RowText row={row} parts={parts} />
        </span>
      ) : null}
      <span className="col-start-3 row-start-1 text-right text-xs/5 whitespace-nowrap text-muted-foreground tabular-nums sm:col-start-auto sm:row-start-auto">
        {row.trailing ? <span>{row.trailing} </span> : null}
        {row.at ? (
          <time dateTime={row.at}>
            {formatInstant(row.at, day ? "time" : "monthDayTime")}
          </time>
        ) : null}
      </span>
      <LedgerCommands
        row={row}
        commands={commands}
        open={open}
        onOpen={setOpen}
      />
      {opened ? (
        <div className="col-start-2 col-end-[-1] flex items-center gap-2">
          <CommandButton command={opened} commands={commands} compact />
          <Button variant="ghost" size="sm" onClick={() => setOpen(null)}>
            Cancel
          </Button>
        </div>
      ) : null}
      {row.detail ? (
        <details className="col-start-2 col-end-[-1] text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            {row.detail.label}
          </summary>
          <pre className="mt-1 max-h-80 overflow-auto bg-muted/30 p-2 font-mono break-words whitespace-pre-wrap">
            {row.detail.text}
          </pre>
        </details>
      ) : null}
    </li>
  );
}

function LedgerCommands({
  row,
  commands,
  open,
  onOpen,
}: {
  row: ReportRecordRow;
  commands: ReportCommands;
  open: string | null;
  onOpen: (id: string | null) => void;
}) {
  const items: ReactNode[] = (row.commands ?? []).map(
    (command: ReportCommand) =>
      command.inputs?.length ? (
        <Button
          key={command.id}
          variant="outline"
          size="sm"
          aria-expanded={open === command.id}
          onClick={() => onOpen(open === command.id ? null : command.id)}
        >
          {command.label}…
        </Button>
      ) : (
        <CommandButton key={command.id} command={command} commands={commands} />
      ),
  );
  if (row.externalLink)
    items.push(
      <a
        key="external"
        href={row.externalLink.url}
        target="_blank"
        rel="noreferrer"
        className={buttonVariants({ variant: "outline", size: "sm" })}
      >
        {row.externalLink.label}
      </a>,
    );
  if (items.length === 0) return null;
  return (
    <span className="col-start-2 col-end-[-1] flex flex-wrap gap-1 sm:col-start-auto sm:col-end-auto sm:justify-end">
      {items}
    </span>
  );
}

/**
 * A `records` block as a ledger: one aligned line per row (state, title, text, time, commands),
 * each column as narrow as its content. Phone rows keep state, title and time on the first line
 * and drop the text and commands beneath.
 */
export function RecordLedger({
  rows,
  day,
  commands,
}: {
  rows: readonly ReportRecordRow[];
  day: string | null;
  commands: ReportCommands;
}) {
  const keys = rowKeys(rows);
  return (
    <ul className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 sm:grid-cols-[auto_fit-content(16rem)_minmax(0,1fr)_auto_auto]">
      {rows.map((row, index) => (
        <LedgerRow key={keys[index]} row={row} day={day} commands={commands} />
      ))}
    </ul>
  );
}
